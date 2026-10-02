// Temporary ACP subset used by this client; the agent owns the full protocol.
export interface SessionUpdate {
  sessionUpdate: string;
  messageId?: string | null;
  content?: unknown;
  toolCallId?: string | null;
  name?: string | null;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string | null; rawInput?: unknown };
  options: { optionId: string; name: string; kind: string }[];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return isObject(error) && typeof error.message === "string" ? error.message : String(error);
}

export function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isObject(value) && value.type === "text" && typeof value.text === "string";
}

export function isSessionUpdate(value: unknown): value is SessionUpdate {
  return isObject(value) && typeof value.sessionUpdate === "string" &&
    ["messageId", "toolCallId", "name", "kind", "title", "status"]
      .every((key) => value[key] == null || typeof value[key] === "string");
}

export function isPermissionParams(value: unknown): value is PermissionParams {
  if (!isObject(value) || typeof value.sessionId !== "string" || !isObject(value.toolCall)) return false;
  const tool = value.toolCall;
  return typeof tool.toolCallId === "string" && (tool.title == null || typeof tool.title === "string") &&
    Array.isArray(value.options) && value.options.every((option: unknown) =>
      isObject(option) && typeof option.optionId === "string" &&
      typeof option.name === "string" && typeof option.kind === "string");
}
