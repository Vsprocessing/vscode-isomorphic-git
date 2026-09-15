/*---------------------------------------------------------------------------------------------
 *  Web runtime for the isomorphic-git backend: shared file system and network hooks.
 *--------------------------------------------------------------------------------------------*/

import type { AuthCallback, AuthFailureCallback, HttpClient } from 'isomorphic-git';
import { ExtensionContext, Uri } from 'vscode';
import { FileSystem } from './fs';

export const gitFs = new FileSystem();

/** Root of the virtual file system (`vfs:/`, provided by the vscode-virtualfs extension). */
export const VIRTUAL_ROOT = Uri.from({ scheme: 'vfs', path: '/' });

/** Where clones used to be stored before the virtual file system existed. */
export const LEGACY_CLONE_ROOT = Uri.from({ scheme: 'vscode-userdata', path: '/isomorphic-git' });

export interface NetworkHooks {
	readonly http: HttpClient;
	readonly onAuth: AuthCallback;
	readonly onAuthFailure: AuthFailureCallback;
	/** Identity used for commits when the repository has no user.name / user.email configured. */
	defaultAuthor(): Promise<{ name: string; email: string } | undefined>;
	log(message: string): void;
}

let hooks: NetworkHooks | undefined;

export function setNetworkHooks(value: NetworkHooks): void {
	hooks = value;
}

export function networkHooks(): NetworkHooks {
	if (!hooks) {
		throw new Error('Git network hooks are not initialized.');
	}
	return hooks;
}

/** Workspace URI for an absolute path: replaces `Uri.file` so resources keep the workspace's scheme on the web. */
export function fileUri(path: string): Uri {
	return gitFs.uriForPath(path);
}

/** Whether a URI belongs to a file system the git backend can read (anything but virtual git/document schemes). */
export function isWorkspaceFileUri(uri: Uri): boolean {
	return uri.scheme === 'file' || uri.scheme === 'vfs' || uri.scheme === 'vscode-userdata' || uri.scheme === 'tmp' || uri.scheme === 'vscode-vfs' || uri.scheme === 'memfs';
}

let extensionContext: ExtensionContext | undefined;

export function setExtensionContext(context: ExtensionContext): void {
	extensionContext = context;
}

export function getExtensionContext(): ExtensionContext {
	if (!extensionContext) {
		throw new Error('Extension context is not initialized.');
	}
	return extensionContext;
}
