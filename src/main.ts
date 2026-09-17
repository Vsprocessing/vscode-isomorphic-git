/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env, ExtensionContext, workspace, window, Disposable, commands, Uri, version as vscodeVersion, LogOutputChannel, l10n, LogLevel, extensions, FileType } from 'vscode';
import { findGit, Git } from './git';
import { Model } from './model';
import { CommandCenter } from './commands';
import { GitFileSystemProvider } from './fileSystemProvider';
import { GitDecorations } from './decorationProvider';
import { Askpass } from './askpass';
import { toDisposable } from './util';
import type { GitExtension } from './api/git';
import type { GitBaseExtension } from './typings/git-base';
import { GitExtensionImpl } from './api/extension';
import { registerAPICommands } from './api/api1';
import { GitPostCommitCommandsProvider } from './postCommitCommands';
import { GitCommitInputBoxCodeActionsProvider, GitCommitInputBoxDiagnosticsManager } from './diagnostics';
import { CloneManager } from './cloneManager';
import { TelemetryReporter } from './web/telemetry';
import { gitFs, LEGACY_CLONE_ROOT, setExtensionContext, setNetworkHooks, VIRTUAL_ROOT } from './web/runtime';
import { http } from './web/http';
import { GitHubAuthenticationProvider, GITHUB_SCOPES } from './web/githubAuth';
import { GitHubAccountView } from './web/githubAccountView';
import { createGitHubRemoteSourceProvider } from './web/githubRemoteSource';
import type { AuthCallback, AuthFailureCallback, GitAuth } from 'isomorphic-git';

const SIGNED_IN_CONTEXT_KEY = 'isomorphic-git.githubSignedIn';
const CLONED_REPOSITORIES_KEY = 'isomorphic-git.clonedRepositories';


export async function deactivate(): Promise<void> { }

function isGitHubUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === 'github.com' || host.endsWith('.github.com');
	} catch {
		return false;
	}
}

async function promptForCredentials(url: string): Promise<GitAuth> {
	const host = new URL(url).host;
	const username = await window.showInputBox({ title: l10n.t('Git: {0}', host), prompt: l10n.t('Username'), ignoreFocusOut: true });
	if (username === undefined) {
		return { cancel: true };
	}
	const password = await window.showInputBox({ title: l10n.t('Git: {0}', host), prompt: l10n.t('Password or personal access token'), password: true, ignoreFocusOut: true });
	return password === undefined ? { cancel: true } : { username, password };
}

function createNetworkHooks(auth: GitHubAuthenticationProvider, askpass: Askpass, logger: LogOutputChannel) {
	const token = async () => (await auth.getSessions(GITHUB_SCOPES))[0]?.accessToken;

	const onAuth: AuthCallback = async url => {
		const provided = await askpass.getCredentials(url);
		if (provided) {
			return { username: provided.username, password: provided.password };
		}
		if (isGitHubUrl(url)) {
			const accessToken = await token();
			return accessToken ? { username: accessToken, password: 'x-oauth-basic' } : { cancel: true };
		}
		return promptForCredentials(url);
	};

	const onAuthFailure: AuthFailureCallback = async url => {
		if (isGitHubUrl(url)) {
			window.showErrorMessage(l10n.t('GitHub rejected the request for {0}. Make sure your account has access to this repository.', url));
			return { cancel: true };
		}
		return promptForCredentials(url);
	};

	setNetworkHooks({
		http,
		onAuth,
		onAuthFailure,
		async defaultAuthor() {
			const [session] = await auth.getSessions(undefined);
			return session ? { name: session.account.label, email: `${session.account.id}+${session.account.label}@users.noreply.github.com` } : undefined;
		},
		log: message => logger.appendLine(message),
	});

	return { token };
}

function createModel(context: ExtensionContext, logger: LogOutputChannel, askpass: Askpass, telemetryReporter: TelemetryReporter): { model: Model; cloneManager: CloneManager; disposable: Disposable } {
	const disposables: Disposable[] = [];
	const info = { path: 'isomorphic-git', version: '2.45.0' };

	logger.info(l10n.t('[main] Using git "{0}" from "{1}"', info.version, info.path));

	const git = new Git({
		gitPath: info.path,
		userAgent: `git/${info.version} (isomorphic-git) vscode/${vscodeVersion} (${env.appName})`,
		version: info.version,
	});
	const model = new Model(git, askpass, context.globalState, context.workspaceState, logger, telemetryReporter);
	disposables.push(model);
	const cloneManager = new CloneManager(model, telemetryReporter, model.repositoryCache);

	const onRepository = () => commands.executeCommand('setContext', 'gitOpenRepositoryCount', `${model.repositories.length}`);
	model.onDidOpenRepository(onRepository, null, disposables);
	model.onDidCloseRepository(onRepository, null, disposables);
	onRepository();

	// Remember repositories opened from virtual or local folders so they can be re-added to the
	// (temporary) web workspace after a reload. Stored as URIs because the scheme matters.
	model.onDidOpenRepository(repository => {
		const uri = gitFs.uriForPath(repository.root).toString();
		const known = context.globalState.get<string[]>(CLONED_REPOSITORIES_KEY, []);
		if (!known.includes(uri)) {
			context.globalState.update(CLONED_REPOSITORIES_KEY, [...known, uri]);
		}
	}, null, disposables);

	const onOutput = (str: string) => logger.appendLine(str.replace(/\s+$/, ''));
	git.onOutput.addListener('log', onOutput);
	disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

	const cc = new CommandCenter(git, model, context.globalState, logger, telemetryReporter, cloneManager);
	disposables.push(
		cc,
		new GitFileSystemProvider(model, logger),
		new GitDecorations(model),
	);

	const postCommitCommandsProvider = new GitPostCommitCommandsProvider(model);
	model.registerPostCommitCommandsProvider(postCommitCommandsProvider);

	const diagnosticsManager = new GitCommitInputBoxDiagnosticsManager(model);
	disposables.push(diagnosticsManager, new GitCommitInputBoxCodeActionsProvider(diagnosticsManager));

	commands.executeCommand('setContext', 'gitVersion2.35', true);

	return { model, cloneManager, disposable: Disposable.from(...disposables) };
}

/** Moves clones from the old `vscode-userdata:/isomorphic-git` location into the virtual file system (once). */
async function migrateLegacyClones(context: ExtensionContext, logger: LogOutputChannel): Promise<void> {
	const entries = await workspace.fs.readDirectory(LEGACY_CLONE_ROOT).then(e => e, () => undefined);
	if (!entries) {
		return;
	}
	const moved = new Map<string, string>();
	for (const [name, type] of entries) {
		if ((type & FileType.Directory) === 0) {
			continue;
		}
		const source = Uri.joinPath(LEGACY_CLONE_ROOT, name);
		let target = Uri.joinPath(VIRTUAL_ROOT, name);
		for (let i = 1; await workspace.fs.stat(target).then(() => true, () => false); i++) {
			target = Uri.joinPath(VIRTUAL_ROOT, `${name}-${i}`);
		}
		try {
			await workspace.fs.copy(source, target, { overwrite: false });
			await workspace.fs.delete(source, { recursive: true, useTrash: false });
			moved.set(source.toString(), target.toString());
			logger.info(`[main] Moved ${source.toString()} to ${target.toString()}`);
		} catch (err) {
			logger.warn(`[main] Failed to move ${source.toString()} to the virtual file system: ${err}`);
		}
	}
	await workspace.fs.delete(LEGACY_CLONE_ROOT, { recursive: true, useTrash: false }).then(undefined, () => undefined);

	const folders = workspace.workspaceFolders ?? [];
	const stale = folders.filter(folder => folder.uri.scheme === LEGACY_CLONE_ROOT.scheme && folder.uri.path.startsWith(`${LEGACY_CLONE_ROOT.path}/`));
	for (const folder of [...stale].reverse()) {
		workspace.updateWorkspaceFolders(folder.index, 1);
	}
	const known = context.globalState.get<string[]>(CLONED_REPOSITORIES_KEY, []).map(value => {
		const legacyPath = value.startsWith('/') ? Uri.from({ scheme: LEGACY_CLONE_ROOT.scheme, path: value }).toString() : value;
		return moved.get(legacyPath) ?? value;
	});
	await context.globalState.update(CLONED_REPOSITORIES_KEY, [...new Set([...known, ...moved.values()])]);
}

async function restoreClonedRepositories(context: ExtensionContext): Promise<void> {
	const folders = workspace.workspaceFolders ?? [];
	const existing: string[] = [];
	const missing: Uri[] = [];
	for (const value of context.globalState.get<string[]>(CLONED_REPOSITORIES_KEY, [])) {
		if (value.startsWith('/')) {
			continue; // legacy path entry, handled by migration
		}
		const uri = Uri.parse(value);
		if (!(await workspace.fs.stat(Uri.joinPath(uri, '.git', 'config')).then(() => true, () => false))) {
			continue;
		}
		gitFs.addRoot(uri);
		existing.push(value);
		if (!folders.some(folder => folder.uri.toString() === value)) {
			missing.push(uri);
		}
	}
	await context.globalState.update(CLONED_REPOSITORIES_KEY, existing);
	if (missing.length) {
		workspace.updateWorkspaceFolders(folders.length, 0, ...missing.map(uri => ({ uri })));
	}
}

export async function activate(context: ExtensionContext): Promise<GitExtension> {
	setExtensionContext(context);
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	const logger = window.createOutputChannel('Git', { log: true });
	disposables.push(logger);
	const onDidChangeLogLevel = (logLevel: LogLevel) => logger.appendLine(l10n.t('[main] Log level: {0}', LogLevel[logLevel]));
	disposables.push(logger.onDidChangeLogLevel(onDidChangeLogLevel));
	onDidChangeLogLevel(logger.logLevel);

	gitFs.addRoot(VIRTUAL_ROOT);
	await findGit([], () => true, logger);

	const telemetryReporter = new TelemetryReporter();
	const askpass = new Askpass();
	const auth = new GitHubAuthenticationProvider(context);
	disposables.push(askpass, auth, GitHubAccountView.register(auth));
	const { token } = createNetworkHooks(auth, askpass, logger);

	const result = new GitExtensionImpl();
	let current: { model: Model; disposable: Disposable } | undefined;

	const signIn = async () => {
		const session = await auth.createSession(GITHUB_SCOPES);
		window.showInformationMessage(l10n.t('Signed in to GitHub as {0}.', session.account.label));
	};
	disposables.push(
		commands.registerCommand('isomorphic-git.githubSignIn', () => signIn().catch(err => {
			if (!/cancel/i.test(String(err?.message ?? err))) {
				window.showErrorMessage(String(err?.message ?? err));
			}
		})),
		commands.registerCommand('isomorphic-git.githubSignOut', () => auth.removeAllSessions()),
	);

	// Local git works signed out; a GitHub session is only needed to reach the network.
	const { model, cloneManager, disposable: modelDisposable } = createModel(context, logger, askpass, telemetryReporter);
	current = { model, disposable: modelDisposable };
	result.cloneManager = cloneManager;
	result.model = model;
	await migrateLegacyClones(context, logger);
	await restoreClonedRepositories(context);

	const syncSignedInContext = async () => {
		const signedIn = (await auth.getSessions(undefined)).length > 0;
		await commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
	};
	disposables.push(auth.onDidChangeSessions(() => void syncSignedInContext()), toDisposable(() => current?.disposable.dispose()));
	await syncSignedInContext();

	// GitHub repositories in the built-in Clone picker.
	const gitBase = extensions.getExtension<GitBaseExtension>('vscode.git-base');
	gitBase?.activate().then(exports => {
		disposables.push(exports.getAPI(1).registerRemoteSourceProvider(createGitHubRemoteSourceProvider(token)));
	}, err => logger.warn(`[main] git-base unavailable: ${err}`));

	// The GitHub sign-in owns this extension's URI handler, so the vscode://.../clone protocol handler is not registered.

	context.subscriptions.push(registerAPICommands(result));
	return result;
}
