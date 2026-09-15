import * as vscode from "vscode";
import type { GitHubAuthenticationProvider } from "./githubAuth";

export const ACCOUNT_VIEW_ID = "isomorphic-git.account";

type AccountMessage = { readonly type: "signIn" } | { readonly type: "signOut" };

/**
 * GitHub account pane at the top of Source Control: a sign-in prompt when signed out,
 * otherwise the user's avatar, name and a Log Out button.
 */
export class GitHubAccountView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly auth: GitHubAuthenticationProvider) {}

  static register(auth: GitHubAuthenticationProvider): vscode.Disposable {
    const provider = new GitHubAccountView(auth);
    return vscode.Disposable.from(
      vscode.window.registerWebviewViewProvider(ACCOUNT_VIEW_ID, provider),
      auth.onDidChangeSessions(() => void provider.render())
    );
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: AccountMessage) => {
      const command = message.type === "signIn" ? "isomorphic-git.githubSignIn" : "isomorphic-git.githubSignOut";
      void vscode.commands.executeCommand(command);
    });
    webviewView.onDidDispose(() => (this.view = undefined));
    await this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }
    const [session] = await this.auth.getSessions(undefined);
    const account = session
      ? { name: session.account.label, avatarUrl: this.auth.avatarUrl(session.id) }
      : undefined;
    this.view.webview.html = renderHtml(this.view.webview, account);
  }
}

function renderHtml(
  webview: vscode.Webview,
  account: { name: string; avatarUrl?: string } | undefined
): string {
  const nonce = randomNonce();
  const csp = [
    "default-src 'none'",
    "img-src https://avatars.githubusercontent.com",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const body = account
    ? `<div class="account">
        ${account.avatarUrl ? `<img class="avatar" src="${escapeHtml(account.avatarUrl)}" alt="">` : `<div class="avatar placeholder"></div>`}
        <span class="name" title="${escapeHtml(account.name)}">${escapeHtml(account.name)}</span>
      </div>
      <button class="secondary" data-action="signOut">Log Out</button>`
    : `<p class="prompt">Sign in to GitHub to use Git.</p>
      <button data-action="signIn">${githubMark}Sign in with GitHub</button>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    body { padding: 12px 12px 14px; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    .prompt { margin: 0 0 10px; color: var(--vscode-descriptionForeground); }
    .account { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; min-width: 0; }
    .avatar { width: 36px; height: 36px; border-radius: 6px; flex: none; }
    .placeholder { background: var(--vscode-badge-background); }
    .name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; font: inherit; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    svg { width: 16px; height: 16px; fill: currentColor; }
  </style>
</head>
<body>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action }));
    }
  </script>
</body>
</html>`;
}

const githubMark = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
