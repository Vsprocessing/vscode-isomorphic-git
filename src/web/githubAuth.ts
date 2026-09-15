import * as vscode from "vscode";
import { proxiedFetch } from "./http";

export const GITHUB_AUTH_PROVIDER_ID = "isomorphic-git.github";
export const GITHUB_SCOPES = ["repo"];

// Previously persisted tokens; deleted on startup since sessions now only live in memory.
const persistedSecrets = ["github.sessions", "github.token"];
const callbackPath = "/github-auth";
const authPath = "/auth";

// Injected at build time (webpack DefinePlugin); GitHub requires it even with PKCE.
declare const __GITHUB_CLIENT_SECRET__: string;
const signInTimeoutMs = 10 * 60 * 1000;

interface StoredSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  avatarUrl?: string;
  scopes: string[];
}

interface PendingSignIn {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

/**
 * GitHub sign-in through the OAuth authorization-code flow with PKCE, entirely in the browser.
 * GitHub redirects to the static /auth page, which forwards the code to the VS Code callback page.
 * The token is kept in memory only, so it is gone when the page closes.
 */
export class GitHubAuthenticationProvider
  implements vscode.AuthenticationProvider, vscode.UriHandler, vscode.Disposable
{
  private readonly onDidChangeSessionsEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.onDidChangeSessionsEmitter.event;

  private readonly pending = new Map<string, PendingSignIn>();
  private readonly disposables: vscode.Disposable[] = [];
  private sessions: StoredSession[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    for (const key of persistedSecrets) {
      void context.secrets.delete(key);
    }
    this.disposables.push(
      this.onDidChangeSessionsEmitter,
      vscode.authentication.registerAuthenticationProvider(
        GITHUB_AUTH_PROVIDER_ID,
        "GitHub",
        this,
        { supportsMultipleAccounts: false }
      ),
      vscode.window.registerUriHandler(this)
    );
  }

  dispose(): void {
    for (const { reject } of this.pending.values()) {
      reject(new vscode.CancellationError());
    }
    this.pending.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  async getSessions(
    scopes: readonly string[] | undefined
  ): Promise<vscode.AuthenticationSession[]> {
    return this.sessions.filter((session) =>
      (scopes || []).every((scope) => session.scopes.includes(scope))
    );
  }

  async createSession(
    scopes: readonly string[]
  ): Promise<vscode.AuthenticationSession> {
    const requested = Array.from(new Set([...GITHUB_SCOPES, ...scopes]));
    const accessToken = await this.signIn(requested);
    const { avatarUrl, ...account } = await fetchAccount(accessToken);
    const session: StoredSession = {
      id: account.id,
      accessToken,
      account,
      avatarUrl,
      scopes: requested,
    };

    const previous = this.sessions;
    this.sessions = [session];
    this.onDidChangeSessionsEmitter.fire({
      added: [session],
      removed: previous,
      changed: [],
    });
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const removed = this.sessions.filter((session) => session.id === sessionId);
    if (!removed.length) {
      return;
    }
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    this.onDidChangeSessionsEmitter.fire({ added: [], removed, changed: [] });
  }

  avatarUrl(sessionId: string): string | undefined {
    return this.sessions.find((session) => session.id === sessionId)?.avatarUrl;
  }

  async removeAllSessions(): Promise<void> {
    const sessions = this.sessions;
    this.sessions = [];
    if (sessions.length) {
      this.onDidChangeSessionsEmitter.fire({
        added: [],
        removed: sessions,
        changed: [],
      });
    }
  }

  handleUri(uri: vscode.Uri): void {
    if (uri.path !== callbackPath) {
      return;
    }
    const query = new URLSearchParams(uri.query);
    const nonce = decodeState(query.get("state") || "")?.n;
    const pending = nonce && this.pending.get(nonce);
    if (!pending) {
      return;
    }
    this.pending.delete(nonce);

    const code = query.get("code");
    if (code) {
      pending.resolve(code);
    } else {
      const error = query.get("error_description") || query.get("error");
      pending.reject(
        error === "access_denied" || !error
          ? new vscode.CancellationError()
          : new Error(`GitHub sign-in failed: ${error}`)
      );
    }
  }

  private async signIn(scopes: string[]): Promise<string> {
    const clientId = vscode.workspace
      .getConfiguration("isomorphic-git")
      .get<string>("githubOAuthClientId");
    if (!clientId || !__GITHUB_CLIENT_SECRET__) {
      throw new Error("GitHub sign-in is not configured for this build.");
    }
    if (!crypto.subtle) {
      throw new Error("GitHub sign-in requires a secure context (HTTPS or localhost).");
    }

    const nonce = randomToken(24);
    const codeVerifier = randomToken(32);
    const callbackUri = await vscode.env.asExternalUri(
      vscode.Uri.parse(
        `${vscode.env.uriScheme}://${this.context.extension.id}${callbackPath}`
      )
    );
    const redirectUri = `${callbackUri.scheme}://${callbackUri.authority}${authPath}`;
    const state = encodeState({ n: nonce, r: callbackUri.toString(true) });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scopes.join(" "));
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", await codeChallenge(codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("allow_signup", "true");

    const code = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Signing in to GitHub...",
        cancellable: true,
      },
      async (progress, cancellation) => {
        progress.report({
          message: "Complete the sign-in in the GitHub browser window.",
        });
        const received = this.waitForCode(nonce, cancellation);
        const opened = await vscode.env.openExternal(
          vscode.Uri.parse(authorizeUrl.toString(), true)
        );
        if (!opened) {
          const pending = this.pending.get(nonce);
          this.pending.delete(nonce);
          pending?.reject(new vscode.CancellationError());
        }
        return received;
      }
    );

    return exchangeCode(clientId, code, codeVerifier, redirectUri);
  }

  private waitForCode(
    nonce: string,
    cancellation: vscode.CancellationToken
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(nonce);
        this.pending.delete(nonce);
        pending?.reject(error);
      };
      const timeout = setTimeout(
        () => fail(new Error("GitHub sign-in timed out.")),
        signInTimeoutMs
      );
      const cancelListener = cancellation.onCancellationRequested(() =>
        fail(new vscode.CancellationError())
      );
      const settle = () => {
        clearTimeout(timeout);
        cancelListener.dispose();
      };
      this.pending.set(nonce, {
        resolve: (code) => {
          settle();
          resolve(code);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
    });
  }
}

async function exchangeCode(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<string> {
  // github.com/login/oauth/access_token has no CORS headers, so go through the libcurl proxy.
  const response = await proxiedFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: __GITHUB_CLIENT_SECRET__,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const result = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !result.access_token) {
    throw new Error(
      `GitHub sign-in failed: ${result.error_description || result.error || `HTTP ${response.status}`}`
    );
  }
  return result.access_token;
}

async function fetchAccount(
  accessToken: string
): Promise<{ id: string; label: string; avatarUrl?: string }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the token: HTTP ${response.status}`);
  }
  const user = (await response.json()) as { id: number; login: string; avatar_url?: string };
  return { id: String(user.id), label: user.login, avatarUrl: user.avatar_url };
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeState(state: { n: string; r: string }): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(state)));
}

function decodeState(state: string): { n?: string; r?: string } | undefined {
  try {
    const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
