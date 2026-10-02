import * as vscode from "vscode";
import { activateWithApi } from "./extension";

export function activate(context: vscode.ExtensionContext) {
  return activateWithApi(vscode, context);
}
