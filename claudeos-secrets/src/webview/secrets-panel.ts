// ============================================================
// ClaudeOS Secrets Extension - Secrets Panel (WebviewPanel manager)
// ============================================================
// Manages the secrets editor webview panel. Singleton pattern:
// createOrShow reveals existing panel or creates new.
// List+detail layout: left panel lists secrets, right panel
// shows form for add/edit with masked values and CRUD operations.
// All HTML/CSS/JS embedded as template literals.
// ============================================================

import * as vscode from "vscode";
import type { SupervisorClient } from "../supervisor/client.js";
import type { SecretsTreeProvider } from "../sidebar/secrets-tree.js";

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class SecretsPanel {
  static currentPanel: SecretsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SupervisorClient;
  private readonly treeProvider: SecretsTreeProvider;
  private readonly onSecretChange?: () => Promise<void>;
  private disposables: vscode.Disposable[] = [];

  /**
   * Create or reveal the secrets panel. Singleton -- only one panel at a time.
   * If secretName is provided, posts selectSecret message to webview after creation.
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    client: SupervisorClient,
    treeProvider: SecretsTreeProvider,
    onSecretChange?: () => Promise<void>,
    secretName?: string,
  ): void {
    if (SecretsPanel.currentPanel) {
      SecretsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      if (secretName) {
        SecretsPanel.currentPanel.panel.webview.postMessage({
          command: "selectSecret",
          name: secretName,
        });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeos.secrets.editor",
      "Secrets Editor",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview"),
        ],
      },
    );

    SecretsPanel.currentPanel = new SecretsPanel(
      panel,
      client,
      treeProvider,
      onSecretChange,
    );

    if (secretName) {
      panel.webview.postMessage({
        command: "selectSecret",
        name: secretName,
      });
    }
  }

  /**
   * Post a newSecret message to the webview to open a blank create form.
   */
  static postNewSecret(): void {
    if (SecretsPanel.currentPanel) {
      SecretsPanel.currentPanel.panel.webview.postMessage({
        command: "newSecret",
      });
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    client: SupervisorClient,
    treeProvider: SecretsTreeProvider,
    onSecretChange?: () => Promise<void>,
  ) {
    this.panel = panel;
    this.client = client;
    this.treeProvider = treeProvider;
    this.onSecretChange = onSecretChange;

    // Set webview HTML content
    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);

    // Handle messages from the webview
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        async (message: {
          command: string;
          name?: string;
          value?: string;
          category?: string;
          tags?: string[];
          isNew?: boolean;
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
    name?: string;
    value?: string;
    category?: string;
    tags?: string[];
    isNew?: boolean;
  }): Promise<void> {
    switch (message.command) {
      case "getSecrets": {
        const secrets = await this.client.listSecrets();
        await this.panel.webview.postMessage({
          command: "secretsList",
          data: secrets,
        });
        break;
      }

      case "getSecretValue": {
        if (!message.name) break;
        const value = await this.client.getSecretValue(message.name);
        await this.panel.webview.postMessage({
          command: "secretValue",
          data: { name: message.name, value },
        });
        break;
      }

      case "saveSecret": {
        if (!message.name || !message.value) break;
        if (message.isNew) {
          await this.client.createSecret(
            message.name,
            message.value,
            message.category,
            message.tags,
          );
        } else {
          await this.client.updateSecret(
            message.name,
            message.value,
            message.category,
            message.tags,
          );
        }

        // Inject ANTHROPIC_API_KEY into tmux env
        if (message.name === "ANTHROPIC_API_KEY") {
          await this.client.setEnv("ANTHROPIC_API_KEY", message.value);
        }

        // Refresh tree
        const secretsAfterSave = await this.client.listSecrets();
        this.treeProvider.update(secretsAfterSave);

        await this.panel.webview.postMessage({ command: "secretSaved" });

        if (this.onSecretChange) {
          await this.onSecretChange();
        }
        break;
      }

      case "confirmDelete": {
        if (!message.name) break;
        const answer = await vscode.window.showWarningMessage(
          `Delete secret "${message.name}"? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (answer === "Delete") {
          await this.client.deleteSecret(message.name);

          const secretsAfterDelete = await this.client.listSecrets();
          this.treeProvider.update(secretsAfterDelete);

          await this.panel.webview.postMessage({ command: "secretDeleted" });

          if (this.onSecretChange) {
            await this.onSecretChange();
          }
        }
        break;
      }

      case "copySecret": {
        if (!message.name) break;
        const copyValue = await this.client.getSecretValue(message.name);
        await vscode.env.clipboard.writeText(copyValue);
        await this.panel.webview.postMessage({ command: "copied" });
        break;
      }
    }
  }

  /**
   * Generate the full HTML for the secrets webview with CSP nonce.
   * List+detail layout: left panel with secret list, right panel with form.
   */
  _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      height: 100vh;
      overflow: hidden;
    }

    .container {
      display: flex;
      flex-direction: row;
      height: 100vh;
    }

    /* --- Left Panel: Secrets List --- */

    .secrets-list {
      width: 300px;
      min-width: 300px;
      border-right: 1px solid var(--vscode-panel-border);
      overflow-y: auto;
      background: var(--vscode-sideBar-background);
    }

    .secrets-list .header {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .secrets-list .header h3 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }

    .secrets-list .add-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vscode-foreground);
      font-size: 16px;
      padding: 4px 8px;
      border-radius: 4px;
    }

    .secrets-list .add-btn:hover {
      color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }

    .secret-item {
      padding: 10px 16px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.15s;
    }

    .secret-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .secret-item.active {
      border-left-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
    }

    .secret-item .name {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .secret-item .category {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .list-empty {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
    }

    /* --- Right Panel: Secret Detail / Form --- */

    .secret-detail {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .form-group {
      margin-bottom: 16px;
    }

    .form-group label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
    }

    .form-group input,
    .form-group textarea {
      width: 100%;
      padding: 6px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
    }

    .form-group input:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .form-group input[readonly] {
      opacity: 0.7;
    }

    .value-row {
      display: flex;
      flex-direction: row;
      gap: 8px;
      align-items: center;
    }

    .value-row input {
      flex: 1;
    }

    .value-row .toggle-btn,
    .value-row .copy-btn {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      cursor: pointer;
      color: var(--vscode-foreground);
      font-size: 14px;
    }

    .value-row .toggle-btn:hover,
    .value-row .copy-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .actions {
      display: flex;
      flex-direction: row;
      gap: 8px;
      margin-top: 24px;
    }

    .btn-save {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }

    .btn-save:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-delete {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 8px 20px;
      border-radius: 4px;
      cursor: pointer;
    }

    .btn-delete:hover {
      opacity: 0.9;
    }

    .btn-cancel {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-input-border);
      padding: 8px 20px;
      border-radius: 4px;
      cursor: pointer;
    }

    .btn-cancel:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--vscode-notificationsBackground);
      color: var(--vscode-notificationsForeground);
      border: 1px solid var(--vscode-panel-border);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }

    .toast.visible {
      opacity: 1;
    }

    /* --- Mobile / narrow viewport --- */
    /* Below 700px the fixed 300px list column leaves almost no room for
       the detail form, so stack list-over-detail instead of side-by-side. */
    @media (max-width: 700px) {
      body {
        height: auto;
        min-height: 100vh;
        overflow-y: auto;
      }

      .container {
        flex-direction: column;
        height: auto;
        min-height: 100vh;
      }

      .secrets-list {
        width: 100%;
        min-width: 0;
        max-height: 35vh;
        border-right: none;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .secret-detail {
        padding: 16px;
      }

      .empty-state {
        height: auto;
        padding: 32px 0;
      }

      .value-row .toggle-btn,
      .value-row .copy-btn {
        width: 40px;
        height: 40px;
        font-size: 16px;
      }

      .form-group input,
      .form-group textarea {
        padding: 10px;
      }

      .actions {
        flex-wrap: wrap;
      }

      .actions button {
        flex: 1 1 auto;
        min-width: 90px;
        padding: 10px 16px;
      }

      .toast {
        left: 16px;
        right: 16px;
        bottom: 16px;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="secrets-list">
      <div class="header">
        <h3>Secrets</h3>
        <button class="add-btn" id="btn-add" title="Add Secret">+</button>
      </div>
      <div id="secrets-list-items">
        <div class="list-empty">Loading...</div>
      </div>
    </div>

    <div class="secret-detail" id="detail-panel">
      <div class="empty-state" id="empty-state">Select a secret or create new one</div>
      <div id="secret-form" style="display: none;"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // --- State ---
      let selectedSecret = null;
      let isNewMode = false;
      let secrets = [];
      let revealedSecrets = new Set();

      // Restore state
      const prevState = vscode.getState();
      if (prevState && prevState.selectedSecret) {
        selectedSecret = prevState.selectedSecret;
      }

      // Request initial data
      vscode.postMessage({ command: 'getSecrets' });

      // --- Add button ---
      document.getElementById('btn-add').addEventListener('click', function() {
        isNewMode = true;
        selectedSecret = null;
        renderNewForm();
        updateListSelection();
        vscode.setState({ selectedSecret: null });
      });

      // --- Message handler ---
      window.addEventListener('message', function(event) {
        var message = event.data;
        switch (message.command) {
          case 'secretsList':
            secrets = message.data || [];
            renderList(secrets);
            if (selectedSecret) {
              vscode.postMessage({ command: 'getSecretValue', name: selectedSecret });
            }
            break;
          case 'secretValue':
            if (message.data) {
              renderDetail(message.data.name, message.data.value);
            }
            break;
          case 'secretSaved':
            showToast('Secret saved');
            vscode.postMessage({ command: 'getSecrets' });
            break;
          case 'secretDeleted':
            selectedSecret = null;
            isNewMode = false;
            renderEmptyDetail();
            vscode.postMessage({ command: 'getSecrets' });
            vscode.setState({ selectedSecret: null });
            break;
          case 'selectSecret':
            selectedSecret = message.name;
            isNewMode = false;
            vscode.postMessage({ command: 'getSecrets' });
            vscode.postMessage({ command: 'getSecretValue', name: message.name });
            vscode.setState({ selectedSecret: message.name });
            break;
          case 'newSecret':
            isNewMode = true;
            selectedSecret = null;
            renderNewForm();
            updateListSelection();
            vscode.setState({ selectedSecret: null });
            break;
          case 'copied':
            showToast('Copied!');
            break;
        }
      });

      // --- Rendering ---

      function renderList(items) {
        var container = document.getElementById('secrets-list-items');
        if (!items || items.length === 0) {
          container.innerHTML = '<div class="list-empty">No secrets yet</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
          var s = items[i];
          var isActive = s.name === selectedSecret ? ' active' : '';
          html += '<div class="secret-item' + isActive + '" data-name="' + escapeAttr(s.name) + '">';
          html += '<div class="name">' + escapeHtml(s.name) + '</div>';
          if (s.category) {
            html += '<div class="category">' + escapeHtml(s.category) + '</div>';
          }
          html += '</div>';
        }
        container.innerHTML = html;

        // Click handlers
        var items2 = container.querySelectorAll('.secret-item');
        for (var j = 0; j < items2.length; j++) {
          items2[j].addEventListener('click', function() {
            var name = this.getAttribute('data-name');
            selectedSecret = name;
            isNewMode = false;
            updateListSelection();
            vscode.postMessage({ command: 'getSecretValue', name: name });
            vscode.setState({ selectedSecret: name });
          });
        }
      }

      function updateListSelection() {
        var items = document.querySelectorAll('.secret-item');
        for (var i = 0; i < items.length; i++) {
          var name = items[i].getAttribute('data-name');
          if (name === selectedSecret) {
            items[i].classList.add('active');
          } else {
            items[i].classList.remove('active');
          }
        }
      }

      function renderDetail(name, value) {
        isNewMode = false;
        selectedSecret = name;
        updateListSelection();

        var secret = null;
        for (var i = 0; i < secrets.length; i++) {
          if (secrets[i].name === name) {
            secret = secrets[i];
            break;
          }
        }

        var categories = [];
        for (var k = 0; k < secrets.length; k++) {
          if (secrets[k].category && categories.indexOf(secrets[k].category) === -1) {
            categories.push(secrets[k].category);
          }
        }

        var revealed = revealedSecrets.has(name);
        var form = document.getElementById('secret-form');
        var empty = document.getElementById('empty-state');
        empty.style.display = 'none';
        form.style.display = 'block';

        form.innerHTML = ''
          + '<div class="form-group">'
          + '  <label>Name</label>'
          + '  <input type="text" id="field-name" value="' + escapeAttr(name) + '" readonly />'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Value</label>'
          + '  <div class="value-row">'
          + '    <input type="' + (revealed ? 'text' : 'password') + '" id="field-value" value="' + escapeAttr(value) + '" />'
          + '    <button class="toggle-btn" id="btn-toggle" title="' + (revealed ? 'Hide' : 'Reveal') + '">' + (revealed ? '&#x1F441;' : '&#x25CF;') + '</button>'
          + '    <button class="copy-btn" id="btn-copy" title="Copy">&#x1F4CB;</button>'
          + '  </div>'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Category</label>'
          + '  <input type="text" id="field-category" value="' + escapeAttr(secret && secret.category ? secret.category : '') + '" list="categories-list" />'
          + '  <datalist id="categories-list">' + categories.map(function(c) { return '<option value="' + escapeAttr(c) + '">'; }).join('') + '</datalist>'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Tags</label>'
          + '  <input type="text" id="field-tags" value="' + escapeAttr(secret && secret.tags ? secret.tags.join(', ') : '') + '" placeholder="comma-separated" />'
          + '</div>'
          + '<div class="actions">'
          + '  <button class="btn-save" id="btn-save">Save</button>'
          + '  <button class="btn-delete" id="btn-delete">Delete</button>'
          + '  <button class="btn-cancel" id="btn-cancel">Cancel</button>'
          + '</div>';

        // Toggle eye
        document.getElementById('btn-toggle').addEventListener('click', function() {
          var input = document.getElementById('field-value');
          if (input.type === 'password') {
            input.type = 'text';
            revealedSecrets.add(name);
            this.innerHTML = '&#x1F441;';
            this.title = 'Hide';
          } else {
            input.type = 'password';
            revealedSecrets.delete(name);
            this.innerHTML = '&#x25CF;';
            this.title = 'Reveal';
          }
        });

        // Copy
        document.getElementById('btn-copy').addEventListener('click', function() {
          vscode.postMessage({ command: 'copySecret', name: name });
        });

        // Save
        document.getElementById('btn-save').addEventListener('click', function() {
          handleSave(false);
        });

        // Delete
        document.getElementById('btn-delete').addEventListener('click', function() {
          vscode.postMessage({ command: 'confirmDelete', name: name });
        });

        // Cancel
        document.getElementById('btn-cancel').addEventListener('click', function() {
          selectedSecret = null;
          isNewMode = false;
          renderEmptyDetail();
          updateListSelection();
          vscode.setState({ selectedSecret: null });
        });
      }

      function renderNewForm() {
        var categories = [];
        for (var k = 0; k < secrets.length; k++) {
          if (secrets[k].category && categories.indexOf(secrets[k].category) === -1) {
            categories.push(secrets[k].category);
          }
        }

        var form = document.getElementById('secret-form');
        var empty = document.getElementById('empty-state');
        empty.style.display = 'none';
        form.style.display = 'block';

        form.innerHTML = ''
          + '<div class="form-group">'
          + '  <label>Name</label>'
          + '  <input type="text" id="field-name" value="" placeholder="SECRET_NAME" />'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Value</label>'
          + '  <div class="value-row">'
          + '    <input type="password" id="field-value" value="" placeholder="Secret value" />'
          + '    <button class="toggle-btn" id="btn-toggle" title="Reveal">&#x25CF;</button>'
          + '  </div>'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Category</label>'
          + '  <input type="text" id="field-category" value="" list="categories-list" placeholder="e.g. api, database" />'
          + '  <datalist id="categories-list">' + categories.map(function(c) { return '<option value="' + escapeAttr(c) + '">'; }).join('') + '</datalist>'
          + '</div>'
          + '<div class="form-group">'
          + '  <label>Tags</label>'
          + '  <input type="text" id="field-tags" value="" placeholder="comma-separated" />'
          + '</div>'
          + '<div class="actions">'
          + '  <button class="btn-save" id="btn-save">Save</button>'
          + '  <button class="btn-cancel" id="btn-cancel">Cancel</button>'
          + '</div>';

        // Toggle eye
        document.getElementById('btn-toggle').addEventListener('click', function() {
          var input = document.getElementById('field-value');
          if (input.type === 'password') {
            input.type = 'text';
            this.innerHTML = '&#x1F441;';
            this.title = 'Hide';
          } else {
            input.type = 'password';
            this.innerHTML = '&#x25CF;';
            this.title = 'Reveal';
          }
        });

        // Save
        document.getElementById('btn-save').addEventListener('click', function() {
          handleSave(true);
        });

        // Cancel
        document.getElementById('btn-cancel').addEventListener('click', function() {
          isNewMode = false;
          renderEmptyDetail();
          vscode.setState({ selectedSecret: null });
        });
      }

      function renderEmptyDetail() {
        var form = document.getElementById('secret-form');
        var empty = document.getElementById('empty-state');
        form.style.display = 'none';
        empty.style.display = 'flex';
      }

      function handleSave(isNew) {
        var name = document.getElementById('field-name').value.trim();
        var value = document.getElementById('field-value').value;
        var category = document.getElementById('field-category').value.trim() || undefined;
        var tagsStr = document.getElementById('field-tags').value.trim();
        var tags = tagsStr ? tagsStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : undefined;

        if (!name) {
          return;
        }

        vscode.postMessage({
          command: 'saveSecret',
          name: name,
          value: value,
          category: category,
          tags: tags,
          isNew: isNew,
        });
      }

      function showToast(text) {
        var toast = document.getElementById('toast');
        toast.textContent = text;
        toast.classList.add('visible');
        setTimeout(function() {
          toast.classList.remove('visible');
        }, 2000);
      }

      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function escapeAttr(text) {
        if (!text) return '';
        return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    SecretsPanel.currentPanel = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
