import type { RequestPermissionRequest, PermissionOption, SessionNotification, SessionUpdate, ContentBlock, Annotations, Role, ToolCallContent, ToolCallUpdate, ToolKind, ToolCallStatus } from "@agentclientprotocol/sdk";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return isObject(error) && typeof error.message === "string" ? error.message : String(error);
}

export function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isObject(value) && value.type === "text" && typeof value.text === "string";
}

export function readOptionalString(value: unknown, key: string): string | null | undefined {
  if (!isObject(value)) return;
  const field = value[key];
  return typeof field === "string" || field === null ? field : undefined;
}

function readToolKind(value: unknown): ToolKind | undefined {
  switch (value) {
    case "read": case "edit": case "delete": case "move": case "search":
    case "execute": case "think": case "fetch": case "switch_mode": case "other": return value;
  }
}

function readToolStatus(value: unknown): ToolCallStatus | undefined {
  switch (value) {
    case "pending": case "in_progress": case "completed": case "failed": return value;
  }
}

function readMetadata(value: Record<string, unknown>): Pick<Annotations, "_meta"> {
  const metadata = value._meta;
  return metadata === null || isObject(metadata) ? { _meta: metadata } : {};
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | null | undefined {
  const field = value[key];
  return field === null || (typeof field === "number" && Number.isFinite(field)) ? field : undefined;
}

function readAnnotations(value: unknown): Annotations | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return;
  const annotations: Annotations = readMetadata(value);
  const audience = value.audience;
  if (audience === null || (Array.isArray(audience) && audience.every((role): role is Role => role === "assistant" || role === "user"))) annotations.audience = audience;
  const lastModified = readOptionalString(value, "lastModified");
  if (lastModified !== undefined) annotations.lastModified = lastModified;
  const priority = readOptionalNumber(value, "priority");
  if (priority !== undefined) annotations.priority = priority;
  return annotations;
}

function readContentBlock(value: unknown): ContentBlock | undefined {
  if (!isObject(value)) return;
  const annotations = readAnnotations(value.annotations);
  const metadata = { ...readMetadata(value), ...(annotations !== undefined ? { annotations } : {}) };
  if (isTextContent(value)) return { type: "text", text: value.text, ...metadata };
  if ((value.type === "image" || value.type === "audio") && typeof value.data === "string" && typeof value.mimeType === "string") {
    const uri = readOptionalString(value, "uri");
    return { type: value.type, data: value.data, mimeType: value.mimeType, ...metadata,
      ...(value.type === "image" && uri !== undefined ? { uri } : {}) };
  }
  if (value.type === "resource_link" && typeof value.uri === "string" && typeof value.name === "string") {
    const link: ContentBlock = { type: "resource_link", uri: value.uri, name: value.name, ...metadata };
    for (const key of ["title", "description", "mimeType"] as const) {
      const field = readOptionalString(value, key);
      if (field !== undefined) link[key] = field;
    }
    const size = readOptionalNumber(value, "size");
    if (size === null || (size !== undefined && Number.isInteger(size))) link.size = size;
    return link;
  }
  if (value.type === "resource" && isObject(value.resource)) {
    const resource = value.resource;
    if (typeof resource.uri !== "string") return;
    const mimeType = readOptionalString(resource, "mimeType");
    const resourceMetadata = { ...readMetadata(resource), ...(mimeType !== undefined ? { mimeType } : {}) };
    if (typeof resource.text === "string") return { type: "resource", resource: { uri: resource.uri, text: resource.text, ...resourceMetadata }, ...metadata };
    if (typeof resource.blob === "string") return { type: "resource", resource: { uri: resource.uri, blob: resource.blob, ...resourceMetadata }, ...metadata };
  }
}

function readToolContent(value: unknown): ToolCallContent[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return;
  const content: ToolCallContent[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (item.type === "content") {
      const block = readContentBlock(item.content);
      if (block) content.push({ type: "content", content: block, ...readMetadata(item) });
    } else if (item.type === "diff" && typeof item.path === "string" && typeof item.newText === "string" &&
        (item.oldText == null || typeof item.oldText === "string")) {
      content.push({ type: "diff", path: item.path, newText: item.newText, ...(item.oldText !== undefined ? { oldText: item.oldText } : {}), ...readMetadata(item) });
    } else if (item.type === "terminal" && typeof item.terminalId === "string") {
      content.push({ type: "terminal", terminalId: item.terminalId, ...readMetadata(item) });
    }
  }
  return content;
}

export function readSessionNotification(params: unknown): SessionNotification | undefined {
  if (!isObject(params) || typeof params.sessionId !== "string" || !isObject(params.update)) return;
  const value = params.update;
  // Check original optional fields before SDK default-on-error normalization.
  if (!["messageId", "toolCallId", "name", "kind", "title", "status"]
    .every((key) => value[key] == null || typeof value[key] === "string")) return;
  const messageId = "messageId" in value ? { messageId: readOptionalString(value, "messageId") } : {};
  let update: SessionUpdate;
  switch (value.sessionUpdate) {
    case "user_message_chunk": case "agent_message_chunk": case "agent_thought_chunk":
      if (!isTextContent(value.content)) return;
      update = { sessionUpdate: value.sessionUpdate, content: { type: "text", text: value.content.text }, ...messageId };
      break;
    case "tool_call": case "tool_call_update": {
      if (typeof value.toolCallId !== "string" || (value.sessionUpdate === "tool_call" && typeof value.title !== "string")) return;
      const kind = readToolKind(value.kind);
      const status = readToolStatus(value.status);
      if ((value.kind != null && !kind) || (value.status != null && !status)) return;
      const tool = {
        toolCallId: value.toolCallId,
        ...("title" in value ? { title: readOptionalString(value, "title") } : {}),
        ...("name" in value ? { name: readOptionalString(value, "name") } : {}),
        ...(kind ? { kind } : {}), ...(status ? { status } : {}),
        ...("rawInput" in value ? { rawInput: value.rawInput } : {}),
        ...("rawOutput" in value ? { rawOutput: value.rawOutput } : {}),
        ...("content" in value ? { content: readToolContent(value.content) } : {}),
      } satisfies ToolCallUpdate;
      update = value.sessionUpdate === "tool_call" && typeof value.title === "string"
        ? { ...tool, sessionUpdate: "tool_call", title: value.title, content: tool.content ?? undefined, ...messageId }
        : { ...tool, sessionUpdate: "tool_call_update", ...messageId };
      break;
    }
    case "session_info_update":
      update = { sessionUpdate: "session_info_update", ...("title" in value ? { title: readOptionalString(value, "title") } : {}),
        ...("updatedAt" in value ? { updatedAt: readOptionalString(value, "updatedAt") } : {}), ...messageId };
      break;
    default: return; // Unsupported variants do not mutate history or reach render callbacks.
  }
  return { sessionId: params.sessionId, update };
}

export function readPermissionParams(value: unknown): RequestPermissionRequest | undefined {
  if (!isObject(value) || typeof value.sessionId !== "string" || !isObject(value.toolCall)) return;
  const tool = value.toolCall;
  if (typeof tool.toolCallId !== "string" || (tool.title != null && typeof tool.title !== "string") || !Array.isArray(value.options)) return;
  const options: PermissionOption[] = [];
  for (const option of value.options) {
    if (!isObject(option) || typeof option.optionId !== "string" || typeof option.name !== "string" ||
        (option.kind !== "allow_once" && option.kind !== "allow_always" && option.kind !== "reject_once" && option.kind !== "reject_always")) return;
    options.push({ optionId: option.optionId, name: option.name, kind: option.kind });
  }
  // Validate raw title before optional-field salvage. Project only the fields
  // consumed by permission UI; do not claim unvalidated extras are SDK types.
  return {
    sessionId: value.sessionId,
    toolCall: { toolCallId: tool.toolCallId, title: tool.title, rawInput: tool.rawInput },
    options,
  };
}
