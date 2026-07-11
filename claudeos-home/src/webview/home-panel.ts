// ============================================================
// ClaudeOS Home Extension - Home Panel (WebviewPanel manager)
// ============================================================
// Manages the branded ClaudeOS Home webview panel. Singleton
// pattern: createOrShow reveals existing panel or creates new.
// All HTML/CSS/JS embedded as template literals (no separate files).
// ============================================================

import * as vscode from "vscode";
import type { SupervisorClient } from "../supervisor/client.js";
import type { ShortcutStore } from "../shortcuts/shortcut-store.js";
import type { Session } from "../types.js";

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class HomePanel {
  static currentPanel: HomePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SupervisorClient;
  private readonly shortcutStore: ShortcutStore;
  private disposables: vscode.Disposable[] = [];
  private recentSessions: Session[] = [];

  /**
   * Create or reveal the home panel. Singleton -- only one panel at a time.
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    client: SupervisorClient,
    shortcutStore: ShortcutStore,
  ): void {
    if (HomePanel.currentPanel) {
      HomePanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeos.home",
      "ClaudeOS Home",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview"),
        ],
      },
    );

    HomePanel.currentPanel = new HomePanel(panel, client, shortcutStore);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    client: SupervisorClient,
    shortcutStore: ShortcutStore,
  ) {
    this.panel = panel;
    this.client = client;
    this.shortcutStore = shortcutStore;

    // Set webview HTML content
    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);

    // Handle messages from the webview
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        async (message: {
          command: string;
          sessionId?: string;
          commandId?: string;
          args?: unknown[];
          shortcut?: unknown;
          id?: string;
          ids?: string[];
        }) => {
          await this._handleMessage(message);
        },
      ),
    );

    // Clean up on dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async _handleMessage(message: {
    command: string;
    sessionId?: string;
    commandId?: string;
    args?: unknown[];
    shortcut?: unknown;
    id?: string;
    ids?: string[];
  }): Promise<void> {
    switch (message.command) {
      case "createSession":
        await vscode.commands.executeCommand("claudeos.sessions.create");
        break;

      case "openSession":
        if (message.sessionId) {
          const session = this.recentSessions.find(s => s.id === message.sessionId);
          if (session) {
            await vscode.commands.executeCommand(
              "claudeos.sessions.openTerminal",
              session,
            );
          } else {
            vscode.window.showWarningMessage(`Session ${message.sessionId} not found in recent sessions.`);
          }
        }
        break;

      case "getRecentSessions":
        try {
          const sessions = await this.client.listSessions();
          const recent = sessions
            .filter((s: Session) => s.status !== "archived")
            .sort(
              (a: Session, b: Session) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 8);
          this.recentSessions = recent;
          await this.panel.webview.postMessage({
            command: "recentSessions",
            data: recent,
          });
        } catch {
          await this.panel.webview.postMessage({
            command: "recentSessions",
            data: [],
          });
        }
        break;

      case "getShortcuts":
        await this.panel.webview.postMessage({
          command: "shortcuts",
          data: this.shortcutStore.getShortcuts(),
        });
        break;

      case "addShortcut":
        if (message.shortcut) {
          this.shortcutStore.addShortcut(message.shortcut as any);
          await this.panel.webview.postMessage({
            command: "shortcuts",
            data: this.shortcutStore.getShortcuts(),
          });
        }
        break;

      case "removeShortcut":
        if (message.id) {
          this.shortcutStore.removeShortcut(message.id);
          await this.panel.webview.postMessage({
            command: "shortcuts",
            data: this.shortcutStore.getShortcuts(),
          });
        }
        break;

      case "reorderShortcuts":
        if (message.ids) {
          this.shortcutStore.reorderShortcuts(message.ids);
          await this.panel.webview.postMessage({
            command: "shortcuts",
            data: this.shortcutStore.getShortcuts(),
          });
        }
        break;

      case "executeShortcut":
        if (message.commandId) {
          await vscode.commands.executeCommand(
            message.commandId,
            ...(message.args ?? []),
          );
        }
        break;

      case "checkApiKeyStatus": {
        try {
          const secretsExt = vscode.extensions.getExtension("claudeos.claudeos-secrets");
          if (secretsExt) {
            const api = secretsExt.isActive ? secretsExt.exports : await secretsExt.activate();
            const hasKey = await api?.hasSecret?.("ANTHROPIC_API_KEY");
            await this.panel.webview.postMessage({
              command: "anthropicKeyStatus",
              data: !!hasKey,
            });
          } else {
            await this.panel.webview.postMessage({
              command: "anthropicKeyStatus",
              data: false,
            });
          }
        } catch {
          await this.panel.webview.postMessage({
            command: "anthropicKeyStatus",
            data: false,
          });
        }
        break;
      }

      case "openSecrets":
        await vscode.commands.executeCommand(
          "claudeos.secrets.openEditor",
          "ANTHROPIC_API_KEY",
        );
        break;

      case "openTerminal":
        await vscode.commands.executeCommand("workbench.action.terminal.new");
        break;

      case "browseExtensions":
        await vscode.commands.executeCommand("workbench.extensions.action.showInstalledExtensions");
        break;
    }
  }

  /**
   * Generate the full HTML for the home webview with CSP nonce.
   * All HTML, CSS, and JS are embedded as template literals.
   */
  _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 0;
      overflow-y: auto;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.025'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 0;
    }

    body::after {
      content: "";
      position: fixed;
      top: 30%;
      left: 50%;
      width: 800px;
      height: 600px;
      transform: translate(-50%, -50%);
      background: radial-gradient(ellipse at center, rgba(212, 160, 84, 0.04) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .hero {
      position: relative;
      z-index: 1;
      background: var(--vscode-sideBar-background);
      padding: 48px 32px;
      text-align: center;
      border-radius: 0 0 16px 16px;
    }

    .hero-wordmark {
      font-size: 28px;
      font-weight: 600;
      color: var(--vscode-sideBarTitle-foreground);
      letter-spacing: 2px;
      margin-bottom: 8px;
      line-height: 1.1;
    }

    .hero-tagline {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin-bottom: 24px;
      line-height: 1.5;
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 24px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .banner {
      position: relative;
      z-index: 1;
      display: none;
      margin: 16px 32px 0;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 13px;
    }

    .banner.warning {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      color: var(--vscode-foreground);
    }

    .banner.warning a {
      color: var(--vscode-focusBorder);
      cursor: pointer;
      text-decoration: underline;
    }

    .section {
      position: relative;
      z-index: 1;
      padding: 24px 32px;
    }

    .section h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--vscode-foreground);
    }

    .quick-actions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px;
    }

    .quick-action-card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .quick-action-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .quick-action-label {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }

    .quick-action-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .getting-started-tip {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .sessions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 8px;
    }

    .session-card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .session-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .session-card .name {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
    }

    .session-card .meta {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-badge {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-active { background: #22c55e; }
    .status-idle { background: #facc15; }
    .status-waiting { background: #3b82f6; }
    .status-stopped { background: #6b7280; }
    .status-zombie { background: #ef4444; }

    .session-card .workdir {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .shortcuts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }

    .shortcut-card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .shortcut-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .shortcut-card .icon {
      font-size: 24px;
      margin-bottom: 8px;
      color: var(--vscode-focusBorder);
    }

    .shortcut-card .label {
      font-size: 12px;
      font-weight: 500;
    }

    .empty-state {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 16px 0;
    }

    @media (max-width: 480px) {
      .hero {
        padding: 28px 20px;
        border-radius: 0 0 12px 12px;
      }

      .hero-wordmark {
        font-size: 22px;
        letter-spacing: 1px;
      }

      .hero-tagline {
        font-size: 12px;
        margin-bottom: 20px;
      }

      .btn-primary {
        width: 100%;
        padding: 12px 24px;
      }

      .banner {
        margin: 16px 20px 0;
      }

      .section {
        padding: 16px 20px;
      }

      .quick-actions-grid,
      .sessions-grid,
      .shortcuts-grid {
        grid-template-columns: 1fr;
      }

      .quick-action-card,
      .session-card,
      .shortcut-card {
        padding: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1 class="hero-wordmark">ClaudeOS</h1>
    <p class="hero-tagline">Your AI-Powered Development Environment</p>
    <button class="btn-primary" id="btn-new-session">New Session</button>
  </div>

  <div class="banner warning" id="api-key-banner">
    Set up your <a id="setup-api-key">Anthropic API key</a> to enable Claude Code sessions.
  </div>

  <div class="section" id="get-started-section">
    <h2>Get Started</h2>
    <div class="quick-actions-grid" id="quick-actions-grid">
      <div class="quick-action-card" data-action="createSession">
        <div class="quick-action-label">New Session</div>
        <div class="quick-action-desc">Start a new Claude Code conversation</div>
      </div>
      <div class="quick-action-card" data-action="openSecrets">
        <div class="quick-action-label">Manage Secrets</div>
        <div class="quick-action-desc">Configure API keys and environment variables</div>
      </div>
      <div class="quick-action-card" data-action="openTerminal">
        <div class="quick-action-label">Open Terminal</div>
        <div class="quick-action-desc">Launch a terminal in your workspace</div>
      </div>
      <div class="quick-action-card" data-action="browseExtensions">
        <div class="quick-action-label">Browse Extensions</div>
        <div class="quick-action-desc">Manage installed extensions</div>
      </div>
    </div>
    <p class="getting-started-tip" id="getting-started-tip"></p>
  </div>

  <div class="section">
    <h2>Recent Sessions</h2>
    <div class="sessions-grid" id="sessions-grid">
      <p class="empty-state">Loading sessions...</p>
    </div>
  </div>

  <div class="section">
    <h2>Shortcuts</h2>
    <div class="shortcuts-grid" id="shortcuts-grid">
      <p class="empty-state">Loading shortcuts...</p>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();

      // Restore scroll position
      var prevState = vscode.getState();
      if (prevState && prevState.scrollTop) {
        window.scrollTo(0, prevState.scrollTop);
      }

      // Save scroll position on scroll
      window.addEventListener('scroll', function() {
        vscode.setState({ scrollTop: window.scrollY });
      });

      // Request initial data
      document.addEventListener('DOMContentLoaded', function() {
        vscode.postMessage({ command: 'getRecentSessions' });
        vscode.postMessage({ command: 'getShortcuts' });
        vscode.postMessage({ command: 'checkApiKeyStatus' });
      });

      // Also fire immediately (DOMContentLoaded may have already fired)
      vscode.postMessage({ command: 'getRecentSessions' });
      vscode.postMessage({ command: 'getShortcuts' });
      vscode.postMessage({ command: 'checkApiKeyStatus' });

      // New session button
      document.getElementById('btn-new-session').addEventListener('click', function() {
        vscode.postMessage({ command: 'createSession' });
      });

      // API key banner link
      document.getElementById('setup-api-key').addEventListener('click', function() {
        vscode.postMessage({ command: 'openSecrets' });
      });

      // Quick action card click handlers
      document.querySelectorAll('.quick-action-card').forEach(function(card) {
        card.addEventListener('click', function() {
          var action = this.getAttribute('data-action');
          vscode.postMessage({ command: action });
        });
      });

      // Handle messages from extension
      window.addEventListener('message', function(event) {
        var message = event.data;
        switch (message.command) {
          case 'recentSessions':
            renderSessions(message.data);
            break;
          case 'shortcuts':
            renderShortcuts(message.data);
            break;
          case 'anthropicKeyStatus':
            var banner = document.getElementById('api-key-banner');
            banner.style.display = message.data ? 'none' : 'block';
            var tip = document.getElementById('getting-started-tip');
            if (message.data) {
              tip.textContent = 'Create a new session to start working with Claude Code.';
            } else {
              tip.textContent = 'Add your Anthropic API key in Secrets to start using Claude Code.';
            }
            break;
        }
      });

      function renderSessions(sessions) {
        var grid = document.getElementById('sessions-grid');
        if (!sessions || sessions.length === 0) {
          grid.innerHTML = '<p class="empty-state">No recent sessions. Click New Session to get started.</p>';
          return;
        }
        grid.innerHTML = sessions.map(function(s) {
          var time = timeAgo(s.createdAt);
          var workdirSnippet = s.workdir ? s.workdir.split('/').slice(-2).join('/') : '';
          return '<div class="session-card" data-id="' + s.id + '">'
            + '<div class="name">' + escapeHtml(s.name) + '</div>'
            + '<div class="meta">'
            + '<span class="status-badge status-' + s.status + '"></span>'
            + '<span>' + s.status + '</span>'
            + '<span>' + time + '</span>'
            + '</div>'
            + (workdirSnippet ? '<div class="workdir">' + escapeHtml(workdirSnippet) + '</div>' : '')
            + '</div>';
        }).join('');

        grid.querySelectorAll('.session-card').forEach(function(card) {
          card.addEventListener('click', function() {
            vscode.postMessage({ command: 'openSession', sessionId: card.dataset.id });
          });
        });
      }

      function renderShortcuts(shortcuts) {
        var grid = document.getElementById('shortcuts-grid');
        if (!shortcuts || shortcuts.length === 0) {
          grid.innerHTML = '<p class="empty-state">No shortcuts configured.</p>';
          return;
        }
        grid.innerHTML = shortcuts.map(function(s) {
          return '<div class="shortcut-card" data-command="' + s.command + '">'
            + '<div class="icon">$(' + s.icon + ')</div>'
            + '<div class="label">' + escapeHtml(s.label) + '</div>'
            + '</div>';
        }).join('');

        grid.querySelectorAll('.shortcut-card').forEach(function(card) {
          card.addEventListener('click', function() {
            vscode.postMessage({
              command: 'executeShortcut',
              commandId: card.dataset.command,
            });
          });
        });
      }

      function timeAgo(dateStr) {
        var now = Date.now();
        var then = new Date(dateStr).getTime();
        var diff = Math.floor((now - then) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
      }

      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Dispose the panel and clear the singleton reference.
   */
  dispose(): void {
    HomePanel.currentPanel = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
