/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env, ExtensionContext, workspace, window, Disposable, commands, Uri, version as vscodeVersion, LogOutputChannel, l10n, LogLevel, extensions } from 'vscode';
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
import { gitFs, setExtensionContext, setNetworkHooks, WEB_CLONE_ROOT } from './web/runtime';
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

	// Remember clones so they can be re-added to the (temporary) web workspace after a reload.
	model.onDidOpenRepository(repository => {
		if (repository.root.startsWith(`${WEB_CLONE_ROOT}/`)) {
			const known = context.globalState.get<string[]>(CLONED_REPOSITORIES_KEY, []);
			if (!known.includes(repository.root)) {
				context.globalState.update(CLONED_REPOSITORIES_KEY, [...known, repository.root]);
			}
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

async function restoreClonedRepositories(context: ExtensionContext): Promise<void> {
	const folders = workspace.workspaceFolders ?? [];
	const existing: string[] = [];
	const missing: Uri[] = [];
	for (const root of context.globalState.get<string[]>(CLONED_REPOSITORIES_KEY, [])) {
		if (!(await gitFs.exists(`${root}/.git/config`))) {
			continue;
		}
		existing.push(root);
		const uri = gitFs.uriForPath(root);
		if (!folders.some(folder => folder.uri.toString() === uri.toString())) {
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

	gitFs.addRoot(Uri.from({ scheme: 'vscode-userdata', path: WEB_CLONE_ROOT }));
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

	// Git is only available while signed in to GitHub; signing out tears the model down.
	const sync = async () => {
		const signedIn = (await auth.getSessions(undefined)).length > 0;
		await commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
		if (signedIn && !current) {
			const { model, cloneManager, disposable } = createModel(context, logger, askpass, telemetryReporter);
			current = { model, disposable };
			result.cloneManager = cloneManager;
			result.model = model;
			await restoreClonedRepositories(context);
		} else if (!signedIn && current) {
			result.model = undefined;
			result.cloneManager = undefined;
			current.disposable.dispose();
			current = undefined;
			commands.executeCommand('setContext', 'gitOpenRepositoryCount', '0');
		}
	};
	disposables.push(auth.onDidChangeSessions(() => void sync()), toDisposable(() => current?.disposable.dispose()));
	await sync();

	// GitHub repositories in the built-in Clone picker.
	const gitBase = extensions.getExtension<GitBaseExtension>('vscode.git-base');
	gitBase?.activate().then(exports => {
		disposables.push(exports.getAPI(1).registerRemoteSourceProvider(createGitHubRemoteSourceProvider(token)));
	}, err => logger.warn(`[main] git-base unavailable: ${err}`));

	// The GitHub sign-in owns this extension's URI handler, so the vscode://.../clone protocol handler is not registered.

	context.subscriptions.push(registerAPICommands(result));
	return result;
}
