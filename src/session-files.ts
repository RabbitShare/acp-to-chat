import type * as VSCode from "vscode";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { EditorApi } from "./extension";

const IMPLICIT_IDS = new Set(["vscode.implicit.file", "vscode.implicit.selection", "vscode.implicit.viewport"]);
const FILE_SCHEMES = new Set(["file", "vscode-remote", "untitled"]);
const MAX_FILES = 32;
const MAX_BYTES = 1024 * 1024;

export function fileReference(vscode: EditorApi, reference: VSCode.ChatPromptReference): { uri: VSCode.Uri; range?: VSCode.Range } | undefined {
  const value = reference.value;
  const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
  const range = value instanceof vscode.Location ? value.range : undefined;
  if (!(uri instanceof vscode.Uri) || !FILE_SCHEMES.has(uri.scheme) || typeof reference.id !== "string") return undefined;
  if (value instanceof vscode.Location && !(range instanceof vscode.Range)) return undefined;
  const explicit = reference.id === uri.toString() || (range && reference.id.startsWith(`${uri.toString()}[`));
  if (!IMPLICIT_IDS.has(reference.id) && !explicit) return undefined;
  if (range && (!(range instanceof vscode.Range) || [range.start.line, range.start.character, range.end.line, range.end.character]
    .some((position) => !Number.isSafeInteger(position) || position < 0) ||
    range.start.line > range.end.line || (range.start.line === range.end.line && range.start.character > range.end.character))) return undefined;
  return { uri, range };
}

export async function prepareFileContext(vscode: EditorApi, references: readonly VSCode.ChatPromptReference[],
  embeddedContext: boolean | undefined, signal: AbortSignal): Promise<ContentBlock[]> {
  const files = references.flatMap((reference) => {
    const file = fileReference(vscode, reference);
    return file ? [file] : [];
  });
  if (!files.length) return [];
  if (embeddedContext !== true) throw new Error("[OpenCode files] Agent does not support embedded text context");
  if (files.length > MAX_FILES) throw new Error("[OpenCode files] More than 32 file references");
  const context: ContentBlock[] = [];
  let bytes = 0;
  for (const { uri, range } of files) {
    if (signal.aborted) return [];
    let document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    if (!document) {
      let size: number;
      try { size = (await vscode.workspace.fs.stat(uri)).size; }
      catch { throw new Error("[OpenCode files] Cannot access the attached text document"); }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new Error("[OpenCode files] File exceeds the 1 MiB context limit");
      if (signal.aborted) return [];
      try { document = await vscode.workspace.openTextDocument(uri); }
      catch { throw new Error("[OpenCode files] Cannot open the attachment as a text document"); }
    }
    if (signal.aborted) return [];
    if (range && !document.validateRange(range).isEqual(range)) throw new Error("[OpenCode files] Attached range is outside the document");
    const text = document.getText(range);
    if (text.includes("\0")) throw new Error("[OpenCode files] Binary attachments are not supported");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_BYTES) throw new Error("[OpenCode files] Combined text context exceeds 1 MiB");
    context.push({ type: "resource", resource: { uri: range ? uri.with({ fragment: `L${range.start.line + 1}-L${range.end.line + 1}` }).toString() : uri.toString(),
      mimeType: "text/plain", text } });
  }
  return context;
}
