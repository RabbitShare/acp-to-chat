import type * as VSCode from "vscode";
import type { EditorApi } from "./extension";
import type { SessionRecord, Sessions } from "./sessions";

const SCHEME = "opencode-command";
// Global commands accepted ahead of prompt customizations by the 1.140.0
// parser. Session-type-restricted builtins do not collide with opencode.
const NATIVE_COMMANDS = new Set(["clear", "models", "debug", "fork", "vscode-pet"]);

export function registerSessionCommands(vscode: EditorApi, backend: Sessions,
  resolve: (resource: VSCode.Uri) => Promise<SessionRecord | undefined>) {
  const changed = new vscode.EventEmitter<void>();
  const fileChanges = new vscode.EventEmitter<VSCode.FileChangeEvent[]>();
  const files = new Map<string, { record: SessionRecord; snapshot: SessionRecord["availableCommands"]; content: Uint8Array }>();
  const published = new Map<SessionRecord, VSCode.ChatSessionCustomizationItem[]>();
  let serial = 0;
  let disposed = false;

  function forget(record: SessionRecord) {
    for (const item of published.get(record) ?? []) files.delete(item.uri.toString());
    published.delete(record);
  }

  function content(uri: VSCode.Uri): Uint8Array {
    const file = files.get(uri.toString());
    if (disposed || !file || file.record.availableCommands !== file.snapshot ||
        file.record.connection !== backend.client || backend.client?.failure || file.record.loading) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return file.content;
  }

  const denied = () => { throw vscode.FileSystemError.NoPermissions("OpenCode command files are read-only"); };
  const fileSystem: VSCode.FileSystemProvider = {
    onDidChangeFile: fileChanges.event,
    watch: () => ({ dispose() {} }),
    stat: (uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: content(uri).byteLength }),
    readFile: (uri) => content(uri).slice(),
    readDirectory: () => [],
    writeFile: denied, delete: denied, rename: denied, createDirectory: denied,
  };

  const provider: VSCode.ChatSessionCustomizationProvider = {
    onDidChange: changed.event,
    async provideChatSessionCustomizations(resource, token) {
      if (disposed || token.isCancellationRequested || resource.scheme !== "opencode") return [];
      const record = await resolve(resource);
      if (!record || disposed || token.isCancellationRequested || record.connection !== backend.client || backend.client?.failure) return [];
      const previous = published.get(record);
      if (previous) return previous;
      const items: VSCode.ChatSessionCustomizationItem[] = [];
      for (const command of record.availableCommands) {
        if (NATIVE_COMMANDS.has(command.name)) {
          backend.options.onLog(`[OpenCode commands] Native editor intercepts ${JSON.stringify(command.name)}; no ACP completion\n`);
          continue;
        }
        // Native 1.140.0 replaces ':' with spaces and cannot insert other token
        // characters losslessly. Keep those ACP names usable through manual text.
        if (!/^[\p{L}0-9_.-]+$/u.test(command.name)) {
          backend.options.onLog(`[OpenCode commands] No lossless native completion for ${JSON.stringify(command.name)}\n`);
          continue;
        }
        const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++serial}.prompt.md` });
        // Metadata only: VS Code can resolve/preview the file without importing
        // OpenCode instructions, tool lists, or model/agent selection.
        files.set(uri.toString(), { record, snapshot: record.availableCommands,
          content: new TextEncoder().encode(`---\nname: ${JSON.stringify(command.name)}\n---\n`) });
        items.push({ uri, type: vscode.ChatSessionCustomizationType.Prompt, name: command.name,
          description: command.input?.hint ? `${command.description} — ${command.input.hint}` : command.description,
          source: "extension", extensionId: "RabbitShare.opencode-native-chat", userInvocable: true });
      }
      published.set(record, items);
      return items;
    },
  };
  const listener = (record: SessionRecord) => { forget(record); changed.fire(); };
  const registrations = [
    vscode.workspace.registerFileSystemProvider(SCHEME, fileSystem, { isReadonly: true }),
    vscode.chat.registerChatSessionCustomizationProvider("opencode", {
      label: "OpenCode commands", supportedTypes: [vscode.ChatSessionCustomizationType.Prompt],
    }, provider),
  ];
  backend.on("commands", listener);
  return {
    validateReferences(references: readonly VSCode.ChatPromptReference[], record: SessionRecord) {
      for (const reference of references) {
        const uri = reference.value;
        if (!(uri instanceof vscode.Uri) || files.get(uri.toString())?.record !== record) {
          throw new Error("[OpenCode commands] Unsupported or foreign prompt reference; only current OpenCode command metadata is accepted");
        }
        try { content(uri); }
        catch { throw new Error("[OpenCode commands] Stale prompt reference; select the command again"); }
      }
    },
    dispose() {
      disposed = true;
      backend.off("commands", listener);
      registrations.forEach((registration) => registration.dispose());
      files.clear();
      published.clear();
      changed.dispose();
      fileChanges.dispose();
    },
  };
}
