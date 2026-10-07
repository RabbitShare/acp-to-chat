import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseJson, type ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import { isObject } from "./protocol";

const LIMIT = 256 * 1024;
interface TemplateOptions {
  environment?: NodeJS.ProcessEnv;
  directories?: readonly string[];
  processCwd?: string;
}

// Read only the requested definition, never scan the filesystem or execute a template.
async function read(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > LIMIT) throw new Error("limit");
    const buffer = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > LIMIT) throw new Error("limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    if (isObject(error) && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return undefined;
    // Parser/IO errors can include source content. Never expose their messages.
    throw new Error("[OpenCode commands] Invalid or unreadable template source (256 KiB limit)");
  } finally { await handle?.close(); }
}

function jsonCommand(text: string, name: string): unknown {
  if (Buffer.byteLength(text) > LIMIT) throw new Error("[OpenCode commands] Configuration exceeds 256 KiB limit");
  const errors: ParseError[] = [];
  const config: unknown = parseJson(text, errors, { allowTrailingComma: true });
  if (errors.length || !isObject(config)) throw new Error("[OpenCode commands] Invalid JSON/JSONC configuration");
  // V2 normalizes legacy `command`; canonical `commands` wins for the same name.
  let result: unknown;
  for (const key of ["command", "commands"]) {
    if (config[key] === undefined) continue;
    if (!isObject(config[key])) throw new Error("[OpenCode commands] Invalid command configuration");
    if (Object.hasOwn(config[key], name)) result = config[key][name];
  }
  return result;
}

function markdownCommand(text: string): unknown {
  let metadata: unknown = {};
  let body = text.replace(/^\uFEFF/, "");
  if (/^---\r?\n/.test(body)) {
    const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(body);
    if (!match) throw new Error("[OpenCode commands] Invalid Markdown frontmatter");
    try {
      const document = parseDocument(match[1] ?? "", { schema: "core", uniqueKeys: true });
      if (document.errors.length || document.warnings.length) throw new Error("invalid YAML");
      metadata = document.toJS({ maxAliasCount: 0 }) ?? {};
    } catch { throw new Error("[OpenCode commands] Invalid YAML frontmatter"); }
    body = body.slice(match[0].length);
  }
  if (!isObject(metadata)) throw new Error("[OpenCode commands] Invalid command metadata");
  if (Object.hasOwn(metadata, "template")) throw new Error("[OpenCode commands] Unsupported template metadata");
  return { ...metadata, template: body.trim() };
}

export async function expandCommandTemplate(cwd: string, text: string, options: TemplateOptions = {}): Promise<string> {
  const invocation = /^\/([^\s]+)(?:\s([\s\S]*))?$/.exec(text.trimStart());
  if (!invocation) return text;
  const [, name, input = ""] = invocation;
  if (name.split("/").some((part) => !/^[\p{L}0-9_.-]+$/u.test(part) || part === "." || part === "..")) {
    throw new Error("[OpenCode commands] Invalid command name");
  }
  if (Buffer.byteLength(input) > LIMIT) throw new Error("[OpenCode commands] Arguments exceed 256 KiB limit");
  const environment = options.environment ?? process.env;
  const global = environment.OPENCODE_CONFIG_DIR || join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const ancestors: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (dir === dirname(dir)) break;
  }
  let definition: unknown;
  const fromJson = async (file: string) => {
    const content = await read(file);
    if (content !== undefined) {
      const value = jsonCommand(content, name);
      if (value !== undefined) definition = value;
    }
  };
  const fromDirectory = async (directory: string) => {
    for (const file of ["opencode.json", "opencode.jsonc"]) await fromJson(join(directory, file));
    for (const subdir of ["command", "commands"]) {
      const content = await read(join(directory, subdir, `${name}.md`));
      if (content !== undefined) definition = markdownCommand(content);
    }
  };
  // Mirrors OpenCode V2's local configuration entry order. No remote/plugin definitions.
  // https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config.ts
  // https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config/discovery.ts
  await fromDirectory(global);
  if (environment.OPENCODE_CONFIG) await fromJson(resolve(options.processCwd ?? process.cwd(), environment.OPENCODE_CONFIG));
  if (resolve(cwd) !== resolve(global)) {
    for (const dir of ancestors) {
      if (resolve(dir) === resolve(global)) continue;
      for (const file of ["opencode.json", "opencode.jsonc"]) await fromJson(join(dir, file));
    }
    for (const dir of ancestors) {
      const project = join(dir, ".opencode");
      if (resolve(project) !== resolve(global)) await fromDirectory(project);
    }
  }
  if (environment.OPENCODE_CONFIG_CONTENT) {
    const value = jsonCommand(environment.OPENCODE_CONFIG_CONTENT, name);
    if (value !== undefined) definition = value;
  }
  // ponytail: extra directories are fallback-only; ambiguity is an error, not guessed priority.
  if (definition === undefined) {
    const matches = [];
    if (options.directories !== undefined && !Array.isArray(options.directories)) throw new Error("[OpenCode commands] Invalid template directories");
    for (const directory of new Set(options.directories ?? [])) {
      if (typeof directory !== "string" || !directory) throw new Error("[OpenCode commands] Invalid template directory");
      const content = await read(join(isAbsolute(directory) ? directory : resolve(cwd, directory), `${name}.md`));
      if (content !== undefined) matches.push(content);
    }
    if (matches.length > 1) throw new Error("[OpenCode commands] Ambiguous local template sources");
    if (matches.length) definition = markdownCommand(matches[0]);
  }
  if (definition === undefined) throw new Error(`[OpenCode commands] No local template for /${name}; plugin, MCP and remote commands cannot be expanded`);
  if (!isObject(definition) || typeof definition.template !== "string" ||
      (definition.description !== undefined && typeof definition.description !== "string")) {
    throw new Error("[OpenCode commands] Invalid command definition");
  }
  if (Object.keys(definition).some((key) => !["template", "description"].includes(key))) {
    throw new Error("[OpenCode commands] Unsupported command metadata; only description and a text template are supported");
  }
  const template = definition.template.trim();
  if (!template) throw new Error("[OpenCode commands] Empty command template");
  if (/!`|\{(?:env|file):/.test(template)) throw new Error("[OpenCode commands] Unsupported shell/config interpolation");
  // Quoting and last-position remainder follow this version-pinned command evaluator:
  // https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config/plugin/command.ts
  const args = (input.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []).map((arg) => arg.replace(/^["']|["']$/g, ""));
  let last = 0;
  for (const match of template.matchAll(/\$(\d+)/g)) {
    const position = Number(match[1]);
    if (!Number.isSafeInteger(position) || position < 1) throw new Error("[OpenCode commands] Unsupported numbered placeholder");
    last = Math.max(last, position);
  }
  // Bound output before joining it; cache the last-position remainder instead of
  // copying all arguments for every occurrence. Inserted data is never reparsed.
  const replacements = new Map<number, string>();
  const parts: string[] = [];
  let size = 0;
  const append = (part: string) => {
    size += Buffer.byteLength(part);
    if (size > LIMIT) throw new Error("[OpenCode commands] Expanded template exceeds 256 KiB limit");
    parts.push(part);
  };
  let offset = 0;
  for (const match of template.matchAll(/\$ARGUMENTS|\$(\d+)/g)) {
    append(template.slice(offset, match.index));
    if (match[0] === "$ARGUMENTS") append(input);
    else {
      const position = Number(match[1]);
      if (!replacements.has(position)) replacements.set(position, position === last ? args.slice(position - 1).join(" ") : args[position - 1] ?? "");
      append(replacements.get(position)!);
    }
    offset = match.index + match[0].length;
  }
  append(template.slice(offset));
  if (!last && !template.includes("$ARGUMENTS") && input.trim()) append(`\n\n${input}`);
  const expanded = parts.join("").trim();
  if (!expanded) throw new Error("[OpenCode commands] Empty expanded template");
  if (expanded.startsWith("/")) throw new Error("[OpenCode commands] Unsupported template beginning with slash; it could execute another command");
  return expanded;
}
