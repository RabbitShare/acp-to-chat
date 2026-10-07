"use strict";

const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.main, "./dist/main.js");
assert.ok(manifest.enabledApiProposals.includes("chatSessionsProvider"));
assert.ok(manifest.contributes.chatSessions.some((session) => session.type === "opencode"));
assert.equal(manifest.contributes.chatSessions.find((session) => session.type === "opencode").requiresCustomModels, true,
  "[check] sessionType=opencode must use its registered model bridge, not the general model pool");
assert.equal(manifest.contributes.chatSessions.find((session) => session.type === "opencode").supportsAutoModel, false,
  "[check] synthetic Auto cannot satisfy VS Code 1.140.0 request conversion");
assert.deepEqual(manifest.contributes.chatSessions.find((session) => session.type === "opencode").capabilities, { supportsPromptAttachments: true },
  "[check] only prompt capability enables dynamic slash suggestions; checkpoints and other attachments stay disabled");
assert.ok(manifest.enabledApiProposals.includes("chatSessionCustomizationProvider"));
assert.ok(manifest.enabledApiProposals.includes("chatProvider"), "[check] session-targeted model metadata requires chatProvider");
assert.ok(manifest.contributes.languageModelChatProviders.some((provider) => provider.vendor === "opencode"));
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
JSON.parse(readFileSync(path.join(root, ".vscode/launch.json"), "utf8"));
JSON.parse(readFileSync(path.join(root, ".vscode/tasks.json"), "utf8"));

for (const file of [
  "dist/main.js", "dist/extension.js", "dist/sessions.js", "dist/acp.js",
  "test/acp.test.js", "test/sessions.test.js", "test/extension.test.js",
  "test/fixtures/agent.cjs", "test/editor-smoke.cjs", "scripts/check.cjs",
]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("JavaScript syntax and basic manifest/launch/tasks validation passed");
