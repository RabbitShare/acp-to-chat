"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
require("./template-files.cjs").isolateTemplateFiles();
const { expandCommandTemplate } = require("../dist/extension");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, ".command-templates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project", "package");
  const global = path.join(root, "global");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(global);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const options = { environment: { OPENCODE_CONFIG_DIR: global } };
  const expand = (text) => {
    assert.equal(typeof expandCommandTemplate, "function", "Local command expansion is not implemented");
    return expandCommandTemplate(cwd, text, options);
  };
  return { root, cwd, global, options, write, expand };
}

test("local templates strip frontmatter and expand raw arguments without interpreting instructions", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "command", "aw-just-answer.md"), "---\ndescription: Answer immediately and briefly\n---\nRespond briefly.\n\nUser request:\n$ARGUMENTS\n");
  assert.equal(await w.expand('/aw-just-answer how  to build a television?\n$1 $ARGUMENTS $&'), 'Respond briefly.\n\nUser request:\nhow  to build a television?\n$1 $ARGUMENTS $&');
});

test("local templates use quoted positions and last-position remainder", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "commands", "compare.md"), "Compare $1 with $2. Full: $ARGUMENTS");
  assert.equal(await w.expand('/compare "api client" stable branch'), 'Compare api client with stable branch. Full: "api client" stable branch');
  assert.equal(await w.expand('/compare only'), 'Compare only with . Full: only');
});

test("local templates append arguments only when no placeholders exist", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "commands", "plain.md"), "Explain briefly.");
  assert.equal(await w.expand('/plain src/cache.ts'), 'Explain briefly.\n\nsrc/cache.ts');
  assert.equal(await w.expand('/plain'), 'Explain briefly.');
});

test("local templates follow global, explicit, ancestor-direct, project-directory and inline precedence", async (t) => {
  const w = workspace(t);
  const json = (template) => JSON.stringify({ commands: { review: { template } } });
  w.write(path.join(w.global, "opencode.json"), json("global JSON"));
  w.write(path.join(w.global, "command", "review.md"), "global singular");
  w.write(path.join(w.global, "commands", "review.md"), "global plural");
  assert.equal(await w.expand('/review'), 'global plural');
  const explicit = path.join(w.root, "elsewhere.jsonc");
  w.write(explicit, json("explicit"));
  w.options.environment.OPENCODE_CONFIG = explicit;
  assert.equal(await w.expand('/review'), 'explicit');
  w.write(path.join(w.root, "project", "opencode.json"), json("ancestor direct"));
  w.write(path.join(w.cwd, "opencode.jsonc"), '// comment\n{"commands":{"review":{"template":"near direct",},},}');
  assert.equal(await w.expand('/review'), 'near direct');
  w.write(path.join(w.root, "project", ".opencode", "commands", "review.md"), "ancestor directory");
  assert.equal(await w.expand('/review'), 'ancestor directory');
  w.write(path.join(w.cwd, ".opencode", "opencode.jsonc"), json("near directory JSON"));
  assert.equal(await w.expand('/review'), 'near directory JSON');
  w.write(path.join(w.cwd, ".opencode", "command", "review.md"), "near directory Markdown");
  assert.equal(await w.expand('/review'), 'near directory Markdown');
  w.options.environment.OPENCODE_CONFIG_CONTENT = json("inline");
  assert.equal(await w.expand('/review'), 'inline');
});

test("local templates read XDG roots, legacy JSON commands and reread changed files", async (t) => {
  const w = workspace(t);
  delete w.options.environment.OPENCODE_CONFIG_DIR;
  w.options.environment.XDG_CONFIG_HOME = path.join(w.root, "xdg");
  const file = path.join(w.root, "xdg", "opencode", "opencode.jsonc");
  w.write(file, '{"command":{"review":{"template":"legacy $ARGUMENTS"}}}');
  assert.equal(await w.expand('/review one'), 'legacy one');
  w.write(file, '{"commands":{"review":{"template":"changed $ARGUMENTS"}}}');
  assert.equal(await w.expand('/review two'), 'changed two');
  fs.unlinkSync(file);
  await assert.rejects(w.expand('/review'), /No local template/);
});

test("local templates support explicit extra directories relative to the session cwd", async (t) => {
  const w = workspace(t);
  w.options.directories = ["team-prompts"];
  w.write(path.join(w.cwd, "team-prompts", "review.md"), "Team review $ARGUMENTS");
  assert.equal(await w.expand('/review api'), 'Team review api');
  w.options.directories.push("other-prompts");
  w.write(path.join(w.cwd, "other-prompts", "review.md"), "Different review");
  await assert.rejects(w.expand('/review api'), /Ambiguous/);
});

test("local templates keep current-session source isolation instead of using the active workspace", async (t) => {
  const w = workspace(t);
  const other = path.join(w.root, "other");
  w.write(path.join(w.cwd, ".opencode", "commands", "review.md"), "Review A $ARGUMENTS");
  w.write(path.join(other, ".opencode", "commands", "review.md"), "Review B $ARGUMENTS");
  assert.equal(await w.expand('/review file'), 'Review A file');
  assert.equal(await expandCommandTemplate(other, '/review file', w.options), 'Review B file');
});

for (const [kind, body] of [
  ["shell", 'Review !`echo private`'], ["agent", '---\nagent: plan\n---\nReview'],
  ["model", '---\nmodel: provider/model\n---\nReview'], ["subagent", '---\nsubagent: false\n---\nReview'],
  ["unknown metadata", '---\npermissions: allow\n---\nReview'], ["malformed YAML", '---\ndescription: [\n---\nReview'],
  ["aliases", '---\ndescription: &x private\nother: *x\n---\nReview'], ["recursive slash", '/review $ARGUMENTS'],
  ["config interpolation", 'Read {file:secret}'], ["empty", '---\ndescription: Empty\n---\n'],
]) test(`local templates reject ${kind} instead of silently changing command semantics`, async (t) => {
  const w = workspace(t);
  w.write(path.join(w.cwd, ".opencode", "commands", "review.md"), body);
  await assert.rejects(w.expand('/review api'), /Unsupported|Invalid|Empty/);
});

test("local templates reject malformed or unsupported winning JSON instead of falling back", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "commands", "review.md"), "Lower-priority review");
  const file = path.join(w.cwd, "opencode.jsonc");
  w.write(file, '{"commands":{"review":{"template":"Review", "agent":"plan"}}}');
  await assert.rejects(w.expand('/review'), /Unsupported/);
  w.write(file, '{"commands":{"review":{"template":"PRIVATE-SECRET"}}');
  await assert.rejects(w.expand('/review'), (error) => /Invalid/.test(error.message) && !error.message.includes('PRIVATE-SECRET'));
});

test("local templates leave ordinary non-command text unchanged", async (t) => {
  const w = workspace(t);
  assert.equal(await w.expand('ordinary /review text'), 'ordinary /review text');
});

test("local templates reject traversal in command names", async (t) => {
  const w = workspace(t);
  await assert.rejects(w.expand('/../outside'), /Invalid command name/);
});

test("local templates reject missing command definitions", async (t) => {
  const w = workspace(t);
  await assert.rejects(w.expand('/missing'), /No local template/);
});

test("local templates reject oversized sources", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "commands", "review.md"), "🌍".repeat(70 * 1024));
  await assert.rejects(w.expand('/review'), /limit/);
});

test("local templates expand whitespace-prefixed slash instead of leaking into backend command execution", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, "commands", "review.md"), "Review $ARGUMENTS");
  assert.equal(await w.expand(' \n/review keep  literal'), 'Review keep  literal');
});

test("local templates reject invalid numbered placeholders and bound large placeholder counts", async (t) => {
  const w = workspace(t);
  const file = path.join(w.global, "commands", "review.md");
  w.write(file, "Review $0");
  await assert.rejects(w.expand('/review one'), /Unsupported/);
  w.write(file, "Review $9007199254740993");
  await assert.rejects(w.expand('/review one'), /Unsupported/);
  const placeholderCount = 100000;
  const argument = 'x';
  w.write(file, "Review " + '$1'.repeat(placeholderCount));
  assert.equal(await w.expand('/review ' + argument), 'Review ' + argument.repeat(placeholderCount));
});

test("local templates resolve explicit relative config paths against the ACP process cwd", async (t) => {
  const w = workspace(t);
  w.options.processCwd = w.root;
  w.options.environment.OPENCODE_CONFIG = 'explicit.jsonc';
  w.write(path.join(w.root, 'explicit.jsonc'), '{"commands":{"review":{"template":"Explicit $ARGUMENTS"}}}');
  assert.equal(await w.expand('/review one'), 'Explicit one');
});

test("local templates reject oversized arguments before tokenization", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, 'commands/review.md'), 'Review $ARGUMENTS');
  await assert.rejects(w.expand('/review ' + '🌍'.repeat(70 * 1024)), /Arguments exceed.*limit/);
});

test("local templates reject output amplification within a bounded child heap and deadline", { timeout: 10000 }, (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, 'commands/review.md'), 'Review ' + '$1'.repeat(100000));
  // Isolate the pre-fix amplification: a failing regression must not OOM the test runner.
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
    require(${JSON.stringify(path.join(__dirname, 'template-files.cjs'))}).isolateTemplateFiles();
    const { expandCommandTemplate } = require(${JSON.stringify(path.join(__dirname, '../dist/extension'))});
    expandCommandTemplate(${JSON.stringify(w.cwd)}, '/review ' + Array(32768).fill('x').join(' '), ${JSON.stringify(w.options)})
      .then(() => process.exit(2), (error) => process.exit(/Expanded template exceeds.*limit/.test(error.message) ? 0 : 3));
  `], { timeout: 5000, stdio: 'pipe' });
  assert.equal(child.error, undefined, 'Expansion must reject before the child deadline');
  assert.equal(child.status, 0, 'Expansion must reject the limit, not crash, OOM or produce an oversized string');
});

for (const newline of ['\n', '\r\n']) test(`local templates accept empty frontmatter (${JSON.stringify(newline)})`, async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, 'commands/review.md'), ['---', '---', 'Review $ARGUMENTS'].join(newline));
  assert.equal(await w.expand('/review one'), 'Review one');
});

test("local templates reject unclosed frontmatter", async (t) => {
  const w = workspace(t);
  w.write(path.join(w.global, 'commands/review.md'), '---\ndescription: Missing closing delimiter\nReview $ARGUMENTS');
  await assert.rejects(w.expand('/review one'), /Invalid Markdown/);
});

test("local templates accept exactly the UTF-8 output limit", async (t) => {
  const w = workspace(t);
  const limit = 256 * 1024;
  const prefix = 'Review ';
  const argument = '🌍'.repeat((limit - Buffer.byteLength(prefix) - 1) / 4) + 'x';
  w.write(path.join(w.global, 'commands/review.md'), prefix + '$ARGUMENTS');
  const expanded = await w.expand('/review ' + argument);
  assert.equal(Buffer.byteLength(expanded), limit);
  assert.equal(expanded, prefix + argument);
});

test("local templates reject UTF-8 output one byte above the limit", async (t) => {
  const w = workspace(t);
  const limit = 256 * 1024;
  const prefix = 'Review ';
  const argument = '🌍'.repeat((limit - Buffer.byteLength(prefix) - 1) / 4) + 'xx';
  w.write(path.join(w.global, 'commands/review.md'), prefix + '$ARGUMENTS');
  await assert.rejects(w.expand('/review ' + argument), /Expanded template exceeds.*limit/);
});
