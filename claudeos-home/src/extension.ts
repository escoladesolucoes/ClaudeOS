// ============================================================
// ClaudeOS Home Extension - Entry Point
// ============================================================
// Opens the branded home page on every startup, wires up
// SupervisorClient, ShortcutStore, and HomePanel. Checks API
// key status via claudeos-secrets extension exports.
// ============================================================

import * as vscode from "vscode";
import { SupervisorClient } from "./supervisor/client.js";
import { ShortcutStore } from "./shortcuts/shortcut-store.js";
import { HomePanel } from "./webview/home-panel.js";

// --- Output Channel for debugging ---
let outputChannel: vscode.OutputChannel;

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// --- Activate ---

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("ClaudeOS Home");
  context.subscriptions.push(outputChannel);

  log("Activating ClaudeOS Home extension");

  // --- Core services ---
  const client = new SupervisorClient();
  const shortcutStore = new ShortcutStore(context);

  // --- Open home page on startup (configurable; defaults to on) ---
  const openOnStartup = vscode.workspace
    .getConfiguration("claudeos.home")
    .get<boolean>("openOnStartup", true);
  if (openOnStartup) {
    HomePanel.createOrShow(context, client, shortcutStore);
  }

  // --- Register command to re-open home ---
  const openCmd = vscode.commands.registerCommand(
    "claudeos.home.open",
    () => {
      HomePanel.createOrShow(context, client, shortcutStore);
    },
  );
  context.subscriptions.push(openCmd);

  log("ClaudeOS Home extension activated");
}

// --- Deactivate ---

export function deactivate(): void {
  // No-op: VS Code handles disposal via context.subscriptions
}

// API key status is now handled by the webview via checkApiKeyStatus message.
// See HomePanel._handleMessage for the implementation.
