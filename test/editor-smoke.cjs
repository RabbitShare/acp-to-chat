"use strict";

const assert = require("node:assert/strict");
function waitForWorkspaceTrust(vscode, timeout = 180000) {
  if (vscode.workspace.isTrusted) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`[waitForWorkspaceTrust] Trust was not granted within ${timeout}ms`));
    }, timeout);

    // CLI extension tests use in-memory storage and do not inherit saved folder trust.
    vscode.window.showInformationMessage("Smoke test is waiting for trust: Workspaces: Manage Workspace Trust. Trust only the current opencode-vscode folder, not its parent.");
    console.log("Smoke test waiting for Workspace Trust in this test window; no agent process started");
  });
}

async function run(vscode = require("vscode")) {
  await waitForWorkspaceTrust(vscode);
  const extension = vscode.extensions.getExtension("local.opencode-native-chat");
  assert.ok(extension, "Development extension was not discovered");
  const controller = await extension.activate();
  assert.equal(controller.id, "opencode");
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("workbench.action.chat.openNewChatSessionInPlace.opencode"), "Native OpenCode session command was not registered");
  await vscode.commands.executeCommand("opencode.newSession");
  // VS Code 1.140.0 exposes only Local sessions through activeChatPanelSessionResource.
  // Confirm external-session rendering separately in the renderer log, not via that getter.
  console.log("OpenCode native API activation and open command passed (verify renderer session separately; no model prompt or ACP process started)");
}

module.exports = { run, waitForWorkspaceTrust };
