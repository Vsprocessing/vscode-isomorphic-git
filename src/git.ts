/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Web backend for the Git extension: implements the surface of the upstream CLI-based `git.ts`
// (Git / Repository) on top of isomorphic-git. Operations isomorphic-git cannot perform throw an
// "unsupported" GitError; their commands are hidden in package.json.

import * as isogit from 'isomorphic-git';
import * as path from 'path';
import { CancellationError, CancellationToken, LogOutputChannel, Progress, Uri } from 'vscode';
import type { Commit as ApiCommit, Ref, Branch, Remote, LogOptions, Change, CommitOptions, RefQuery as ApiRefQuery, InitOptions, DiffChange, Worktree as ApiWorktree } from './api/git';
import { RefType, ForcePushMode, GitErrorCodes, Status } from './api/git.constants';
import { fileUri, gitFs as fs, networkHooks } from './web/runtime';

export interface IGit {
	path: string;
	version: string;
}

export interface IDotGit {
	readonly path: string;
	readonly commonPath?: string;
	readonly superProjectPath?: string;
	readonly isBare: boolean;
}

export interface IFileStatus {
	x: string;
	y: string;
	path: string;
	rename?: string;
}

export interface Stash {
	readonly hash: string;
	readonly parents: string[];
	readonly index: number;
	readonly description: string;
	readonly branchName?: string;
	readonly authorDate?: Date;
	readonly commitDate?: Date;
}

export interface LogFileOptions {
	readonly follow?: boolean;
	readonly maxEntries?: number | string;
	readonly hash?: string;
	readonly reverse?: boolean;
	readonly sortByAuthorDate?: boolean;
	readonly shortStats?: boolean;
}

export interface IExecutionResult<T extends string | Uint8Array> {
	exitCode: number;
	stdout: T;
	stderr: string;
}

export interface SpawnOptions {
	input?: string;
	log?: boolean;
	cancellationToken?: CancellationToken;
	env?: { [key: string]: string };
	[key: string]: unknown;
}

export interface IGitErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;
	gitArgs?: string[];
}

export class GitError extends Error {

	error?: Error;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;
	gitArgs?: string[];

	constructor(data: IGitErrorData) {
		super(data.error?.message || data.message || 'Git error');

		this.error = data.error;
		this.stdout = data.stdout;
		this.stderr = data.stderr ?? data.message;
		this.exitCode = data.exitCode;
		this.gitErrorCode = data.gitErrorCode;
		this.gitCommand = data.gitCommand;
		this.gitArgs = data.gitArgs;
	}

	override toString(): string {
		return this.message + ' ' + JSON.stringify({ exitCode: this.exitCode, gitErrorCode: this.gitErrorCode, gitCommand: this.gitCommand }, null, 2);
	}
}

export interface IGitOptions {
	gitPath: string;
	userAgent: string;
	version: string;
	env?: { [key: string]: string };
}

export interface ICloneOptions {
	readonly parentPath: string;
	readonly targetName?: string;
	readonly progress: Progress<{ increment: number }>;
	readonly recursive?: boolean;
	readonly ref?: string;
}

export interface CommitShortStat {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

export interface CoAuthor {
	readonly name: string;
	readonly email: string;
}

export interface Commit {
	hash: string;
	message: string;
	parents: string[];
	authorDate?: Date;
	authorName?: string;
	authorEmail?: string;
	commitDate?: Date;
	refNames: string[];
	shortStat?: CommitShortStat;
	coAuthors?: CoAuthor[];
}

export interface RefQuery extends ApiRefQuery {
	readonly includeCommitDetails?: boolean;
}

export interface Submodule {
	name: string;
	path: string;
	url: string;
}

export interface LsTreeElement {
	mode: string;
	type: string;
	object: string;
	size: string;
	file: string;
}

interface LsFilesElement {
	mode: string;
	object: string;
	stage: string;
	file: string;
}

export interface BlameInformation {
	readonly hash: string;
	readonly subject?: string;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly authorDate?: number;
	readonly ranges: {
		readonly startLineNumber: number;
		readonly endLineNumber: number;
	}[];
}

export interface PullOptions {
	readonly unshallow?: boolean;
	readonly tags?: boolean;
	readonly autoStash?: boolean;
	readonly cancellationToken?: CancellationToken;
}

export interface Worktree extends ApiWorktree {
	readonly commitDetails?: ApiCommit;
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BACKEND_VERSION = '2.45.0';
const HISTORY_DEPTH = 5000;

const coAuthorRegex = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;

export function parseCoAuthors(message: string): CoAuthor[] {
	const coAuthors: CoAuthor[] = [];
	let match;
	while ((match = coAuthorRegex.exec(message)) !== null) {
		const [, name, email] = match;
		coAuthors.push({ name: name, email: email });
	}
	return coAuthors;
}

function unsupported(operation: string): never {
	throw new GitError({ message: `${operation} is not supported in the browser.`, gitCommand: operation });
}

function throwIfCancelled(token?: CancellationToken): void {
	if (token?.isCancellationRequested) {
		throw new CancellationError();
	}
}

/** Translates isomorphic-git errors into GitErrors carrying the codes the extension understands. */
function toGitError(error: unknown, gitCommand: string): GitError {
	if (error instanceof GitError || error instanceof CancellationError) {
		return error as GitError;
	}
	const err = error as { code?: string; message?: string; data?: { statusCode?: number } };
	const message = err?.message ?? String(error);
	let gitErrorCode: string | undefined;
	switch (err?.code) {
		case 'HttpError':
			gitErrorCode = err.data?.statusCode === 401 || err.data?.statusCode === 403 ? GitErrorCodes.AuthenticationFailed : GitErrorCodes.RemoteConnectionError;
			break;
		case 'UserCanceledError':
			gitErrorCode = GitErrorCodes.AuthenticationFailed;
			break;
		case 'PushRejectedError':
			gitErrorCode = GitErrorCodes.PushRejected;
			break;
		case 'CheckoutConflictError':
			gitErrorCode = GitErrorCodes.DirtyWorkTree;
			break;
		case 'MergeConflictError':
		case 'MergeNotSupportedError':
			gitErrorCode = GitErrorCodes.Conflict;
			break;
		case 'AlreadyExistsError':
			gitErrorCode = GitErrorCodes.BranchAlreadyExists;
			break;
		case 'MissingNameError':
			gitErrorCode = GitErrorCodes.NoUserNameConfigured;
			break;
		case 'NoRefspecError':
			gitErrorCode = GitErrorCodes.NoUpstreamBranch;
			break;
	}
	return new GitError({ error: error instanceof Error ? error : undefined, message, stderr: message, gitErrorCode, gitCommand, exitCode: 1 });
}

async function wrap<T>(gitCommand: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw toGitError(error, gitCommand);
	}
}

class OutputEmitter {
	private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
	addListener(event: string, listener: (...args: any[]) => void): this {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(listener);
		return this;
	}
	on(event: string, listener: (...args: any[]) => void): this {
		return this.addListener(event, listener);
	}
	removeListener(event: string, listener: (...args: any[]) => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}
	emit(event: string, ...args: any[]): boolean {
		this.listeners.get(event)?.forEach(listener => listener(...args));
		return true;
	}
}

export async function findGit(_hints: string[], _onValidate: (path: string) => boolean, _logger: LogOutputChannel): Promise<IGit> {
	return { path: 'isomorphic-git', version: BACKEND_VERSION };
}

export class Git {

	readonly path: string;
	readonly userAgent: string;
	readonly version: string;
	readonly env: { [key: string]: string };

	private _onOutput = new OutputEmitter();
	get onOutput(): OutputEmitter { return this._onOutput; }

	constructor(options: IGitOptions) {
		this.path = options.gitPath;
		this.version = options.version;
		this.userAgent = options.userAgent;
		this.env = options.env || {};
	}

	compareGitVersionTo(version: string): -1 | 0 | 1 {
		const a = this.version.split('.').map(Number);
		const b = version.split('.').map(Number);
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const diff = (a[i] ?? 0) - (b[i] ?? 0);
			if (diff !== 0) {
				return diff < 0 ? -1 : 1;
			}
		}
		return 0;
	}

	open(repositoryRoot: string, repositoryRootRealPath: string | undefined, dotGit: IDotGit, logger: LogOutputChannel): Repository {
		return new Repository(this, repositoryRoot, repositoryRootRealPath, dotGit, logger);
	}

	async init(repository: string, options: InitOptions = {}): Promise<void> {
		await wrap('init', () => isogit.init({ fs, dir: repository, defaultBranch: options.defaultBranch || 'main' }));
	}

	async clone(url: string, options: ICloneOptions, cancellationToken?: CancellationToken): Promise<string> {
		const baseFolderName = options.targetName || decodeURI(url).replace(/[\/]+$/, '').replace(/^.*[\/\\]/, '').replace(/\.git$/, '') || 'repository';
		let folderName = baseFolderName;
		let folderPath = path.posix.join(options.parentPath, folderName);
		let count = 1;

		if (!options.targetName) {
			while (count < 20 && await fs.exists(folderPath)) {
				folderName = `${baseFolderName}-${count++}`;
				folderPath = path.posix.join(options.parentPath, folderName);
			}
		}

		const hooks = networkHooks();
		hooks.log(`> git clone ${url} ${folderPath}`);
		let previousProgress = 0;
		await wrap('clone', async () => {
			await fs.promises.mkdir(folderPath).catch(() => undefined);
			await isogit.clone({
				fs,
				http: hooks.http,
				dir: folderPath,
				url,
				ref: options.ref,
				onAuth: hooks.onAuth,
				onAuthFailure: hooks.onAuthFailure,
				onMessage: message => hooks.log(message.trimEnd()),
				onProgress: event => {
					throwIfCancelled(cancellationToken);
					const phaseWeight: Record<string, [number, number]> = {
						'Counting objects': [0, 10],
						'Compressing objects': [10, 10],
						'Receiving objects': [20, 40],
						'Resolving deltas': [60, 30],
						'Analyzing workdir': [90, 5],
						'Updating workdir': [95, 5],
					};
					const [base, span] = phaseWeight[event.phase] ?? [0, 0];
					const progress = base + (event.total ? Math.floor((event.loaded / event.total) * span) : 0);
					if (progress > previousProgress) {
						options.progress.report({ increment: progress - previousProgress });
						previousProgress = progress;
					}
				},
			});
		});
		hooks.log(`Cloned into ${folderPath}`);

		return folderPath;
	}

	async getRepositoryRoot(pathInsidePossibleRepository: string): Promise<string> {
		return wrap('rev-parse', () => isogit.findRoot({ fs, filepath: pathInsidePossibleRepository }));
	}

	async getRepositoryDotGit(repositoryPath: string): Promise<IDotGit> {
		return { isBare: false, path: path.posix.join(repositoryPath, '.git') };
	}

	async exec(_cwd: string, args: string[], _options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return unsupported(`git ${args[0]}`);
	}

	async exec2(args: string[], _options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return unsupported(`git ${args[0]}`);
	}

	stream(_cwd: string, args: string[], _options: SpawnOptions = {}): never {
		return unsupported(`git ${args[0]}`);
	}

	spawn(args: string[], _options: SpawnOptions = {}): never {
		return unsupported(`git ${args[0]}`);
	}

	async mergeFile(_options: { input1Path: string; input2Path: string; basePath: string; diff3?: boolean }): Promise<string> {
		return unsupported('Merge file');
	}

	async addSafeDirectory(_repositoryPath: string): Promise<void> {
		// Not applicable in the browser.
	}
}

interface StatusRow {
	readonly filepath: string;
	readonly head: number;
	readonly workdir: number;
	readonly stage: number;
}

export class Repository {

	constructor(
		private _git: Git,
		private repositoryRoot: string,
		private repositoryRootRealPath: string | undefined,
		readonly dotGit: IDotGit,
		private logger: LogOutputChannel
	) {
		fs.addRoot(fileUri(repositoryRoot));
	}

	get kind(): 'repository' | 'submodule' | 'worktree' {
		return 'repository';
	}

	get git(): Git {
		return this._git;
	}

	get root(): string {
		return this.repositoryRoot;
	}

	get rootRealPath(): string | undefined {
		return this.repositoryRootRealPath;
	}

	private get dir(): string {
		return this.repositoryRoot;
	}

	async exec(args: string[], _options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return unsupported(`git ${args[0]}`);
	}

	stream(args: string[], _options: SpawnOptions = {}): never {
		return unsupported(`git ${args[0]}`);
	}

	spawn(args: string[], _options: SpawnOptions = {}): never {
		return unsupported(`git ${args[0]}`);
	}

	// #region Paths & objects

	private relative(filePath: string): string {
		const normalized = filePath.replace(/\\/g, '/');
		return normalized.startsWith('/') ? path.posix.relative(this.dir, normalized) : normalized.replace(/^\.\//, '');
	}

	private absolute(relativePath: string): string {
		return path.posix.join(this.dir, relativePath);
	}

	private async resolve(ref: string): Promise<string> {
		if (/^[0-9a-f]{40}$/i.test(ref)) {
			return ref;
		}
		const parent = /^(.+?)(\^|~)(\d*)$/.exec(ref);
		if (parent) {
			const [, base, , count] = parent;
			let oid = await this.resolve(base);
			for (let i = 0; i < (Number(count) || 1); i++) {
				const { commit } = await isogit.readCommit({ fs, dir: this.dir, oid });
				if (!commit.parent.length) {
					throw new GitError({ message: `${ref} has no parent`, gitCommand: 'rev-parse' });
				}
				oid = commit.parent[0];
			}
			return oid;
		}
		if (/^[0-9a-f]{4,39}$/i.test(ref)) {
			return isogit.expandOid({ fs, dir: this.dir, oid: ref });
		}
		return isogit.resolveRef({ fs, dir: this.dir, ref });
	}

	private async readIndexEntry(filepath: string): Promise<{ oid: string; mode: number } | undefined> {
		const [entry] = await isogit.walk({
			fs,
			dir: this.dir,
			trees: [isogit.STAGE()],
			map: async (candidate, [stage]) => {
				if (candidate === '.') {
					return undefined;
				}
				if (candidate !== filepath) {
					return filepath.startsWith(`${candidate}/`) ? undefined : null;
				}
				return stage ? { oid: await stage.oid(), mode: await stage.mode() } : undefined;
			},
		}) as ({ oid: string; mode: number } | undefined)[];
		return entry;
	}

	private async readBlobAt(ref: string, relativePath: string): Promise<Uint8Array> {
		if (ref === '' || ref === ':0') {
			const entry = await this.readIndexEntry(relativePath);
			if (!entry) {
				throw new GitError({ message: 'Could not show object.', exitCode: 128, gitCommand: 'show' });
			}
			return (await isogit.readBlob({ fs, dir: this.dir, oid: entry.oid })).blob;
		}
		if (/^:[123]$/.test(ref)) {
			return unsupported('Merge conflict stages');
		}
		const oid = await this.resolve(ref);
		return (await isogit.readBlob({ fs, dir: this.dir, oid, filepath: relativePath })).blob;
	}

	async buffer(ref: string, filePath: string): Promise<Uint8Array> {
		return wrap('show', () => this.readBlobAt(ref, this.relative(filePath)));
	}

	async getObjectDetails(treeish: string, filePath: string): Promise<{ mode: string; object: string; size: number }> {
		const relativePath = this.relative(filePath);
		if (!treeish || /^:[0123]$/.test(treeish)) {
			const entry = await this.readIndexEntry(relativePath);
			if (!entry) {
				throw new GitError({ message: 'Path not known by git', gitErrorCode: GitErrorCodes.UnknownPath });
			}
			const { blob } = await isogit.readBlob({ fs, dir: this.dir, oid: entry.oid });
			return { mode: entry.mode.toString(8), object: entry.oid, size: blob.length };
		}
		const [element] = await this.lstree(treeish, relativePath);
		if (!element) {
			throw new GitError({ message: 'Path not known by git', gitErrorCode: GitErrorCodes.UnknownPath });
		}
		return { mode: element.mode, object: element.object, size: parseInt(element.size) || 0 };
	}

	async lstree(treeish: string, filePath?: string, options?: { recursive?: boolean }): Promise<LsTreeElement[]> {
		const oid = await wrap('ls-tree', () => this.resolve(treeish));
		const target = filePath ? this.relative(filePath) : undefined;
		const results = await isogit.walk({
			fs,
			dir: this.dir,
			trees: [isogit.TREE({ ref: oid })],
			map: async (candidate, [entry]) => {
				if (candidate === '.' || !entry) {
					return undefined;
				}
				const type = await entry.type();
				const depth = candidate.split('/').length;
				if (target) {
					if (candidate === target) {
						// matched
					} else if (target.startsWith(`${candidate}/`)) {
						return undefined;
					} else {
						return null;
					}
				} else if (!options?.recursive && depth > 1) {
					return null;
				}
				if (type === 'tree' && (options?.recursive || !target) && candidate !== target) {
					return options?.recursive ? undefined : { mode: (await entry.mode()).toString(8).padStart(6, '0'), type, object: await entry.oid(), size: '-', file: candidate };
				}
				const size = type === 'blob' ? String((await entry.content())?.length ?? 0) : '-';
				return { mode: (await entry.mode()).toString(8).padStart(6, '0'), type, object: await entry.oid(), size, file: candidate };
			},
		});
		return (results as (LsTreeElement | undefined)[]).filter((element): element is LsTreeElement => !!element);
	}

	async lsfiles(filePath: string): Promise<LsFilesElement[]> {
		const relativePath = this.relative(filePath);
		const entry = await this.readIndexEntry(relativePath);
		return entry ? [{ mode: entry.mode.toString(8), object: entry.oid, stage: '0', file: relativePath }] : [];
	}

	async getGitFilePath(_ref: string, filePath: string): Promise<string> {
		return this.relative(filePath);
	}

	async detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string }> {
		const { blob } = await wrap('cat-file', () => isogit.readBlob({ fs, dir: this.dir, oid: object }));
		const sample = blob.subarray(0, 8000);
		return sample.includes(0) ? { mimetype: 'application/octet-stream' } : { mimetype: 'text/plain' };
	}

	async hashObject(data: string): Promise<string> {
		const { oid } = await isogit.hashBlob({ object: data });
		return oid;
	}

	// #endregion

	// #region Config

	async config(command: string, scope: string, key: string, value: any = null, _options: SpawnOptions = {}): Promise<string> {
		try {
			if (scope === 'global' || scope === 'system') {
				return '';
			}
			switch (command) {
				case 'get':
					return String(await isogit.getConfig({ fs, dir: this.dir, path: key }) ?? '');
				case 'add':
				case 'replace-all':
					await isogit.setConfig({ fs, dir: this.dir, path: key, value: String(value), append: command === 'add' });
					return '';
				case 'unset':
				case 'unset-all':
					await isogit.setConfig({ fs, dir: this.dir, path: key, value: undefined });
					return '';
				default:
					return '';
			}
		} catch (err) {
			this.logger.warn(`[Git][config] git config failed: ${err.message}`);
			return '';
		}
	}

	async getConfigs(scope: string): Promise<{ key: string; value: string }[]> {
		if (scope === 'global' || scope === 'system') {
			return [];
		}
		const raw = await fs.promises.readFile(path.posix.join(this.dir, '.git', 'config'), { encoding: 'utf8' }).catch(() => '') as string;
		const entries: { key: string; value: string }[] = [];
		let section = '';
		for (const line of raw.split(/\r?\n/)) {
			const header = /^\s*\[([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
			if (header) {
				section = header[2] !== undefined ? `${header[1]}.${header[2]}` : header[1];
				continue;
			}
			const property = /^\s*([A-Za-z0-9-]+)\s*(?:=\s*(.*))?$/.exec(line);
			if (property && section) {
				entries.push({ key: `${section}.${property[1]}`.toLowerCase(), value: (property[2] ?? 'true').replace(/^"(.*)"$/, '$1') });
			}
		}
		return entries;
	}

	private async author(): Promise<{ name: string; email: string }> {
		const name = await isogit.getConfig({ fs, dir: this.dir, path: 'user.name' }).catch(() => undefined);
		const email = await isogit.getConfig({ fs, dir: this.dir, path: 'user.email' }).catch(() => undefined);
		if (name && email) {
			return { name, email };
		}
		const fallback = await networkHooks().defaultAuthor();
		if (!fallback) {
			throw new GitError({ message: 'Sign in to GitHub or configure user.name and user.email to commit.', gitErrorCode: GitErrorCodes.NoUserNameConfigured });
		}
		return { name: name || fallback.name, email: email || fallback.email };
	}

	// #endregion

	// #region History

	/** Decoration names per commit, formatted like `git log --decorate=full` (`HEAD -> refs/heads/main`, `tag: refs/tags/v1`). */
	private async decorations(): Promise<Map<string, string[]>> {
		const decorations = new Map<string, string[]>();
		const add = (oid: string | undefined, name: string) => {
			if (oid) {
				decorations.set(oid, [...(decorations.get(oid) ?? []), name]);
			}
		};
		const current = await isogit.currentBranch({ fs, dir: this.dir, fullname: false }).catch(() => undefined);
		for (const branch of await isogit.listBranches({ fs, dir: this.dir }).catch(() => [] as string[])) {
			add(await this.resolve(`refs/heads/${branch}`).catch(() => undefined), branch === current ? `HEAD -> refs/heads/${branch}` : `refs/heads/${branch}`);
		}
		if (!current) {
			add(await this.resolve('HEAD').catch(() => undefined), 'HEAD');
		}
		for (const { remote } of await isogit.listRemotes({ fs, dir: this.dir }).catch(() => [] as { remote: string }[])) {
			for (const branch of await isogit.listBranches({ fs, dir: this.dir, remote }).catch(() => [] as string[])) {
				if (branch === 'HEAD') {
					continue;
				}
				add(await this.resolve(`refs/remotes/${remote}/${branch}`).catch(() => undefined), `refs/remotes/${remote}/${branch}`);
			}
		}
		for (const tag of await isogit.listTags({ fs, dir: this.dir }).catch(() => [] as string[])) {
			let oid = await this.resolve(`refs/tags/${tag}`).catch(() => undefined);
			if (oid) {
				oid = await isogit.readTag({ fs, dir: this.dir, oid }).then(t => t.tag.object).catch(() => oid);
			}
			add(oid, `tag: refs/tags/${tag}`);
		}
		return decorations;
	}

	private toCommit(result: isogit.ReadCommitResult, decorations?: Map<string, string[]>): Commit {
		const { commit, oid } = result;
		const message = commit.message.replace(/\n$/, '');
		return {
			hash: oid,
			message,
			parents: commit.parent,
			authorDate: new Date(commit.author.timestamp * 1000),
			authorName: commit.author.name,
			authorEmail: commit.author.email,
			commitDate: new Date(commit.committer.timestamp * 1000),
			refNames: decorations?.get(oid) ?? [],
			coAuthors: parseCoAuthors(message),
		};
	}

	private async commitsFrom(ref: string, depth = HISTORY_DEPTH): Promise<isogit.ReadCommitResult[]> {
		const oid = await this.resolve(ref).catch(() => undefined);
		if (!oid) {
			return [];
		}
		return isogit.log({ fs, dir: this.dir, ref: oid, depth }).catch(() => []);
	}

	private async ancestorSet(ref: string): Promise<Set<string>> {
		return new Set((await this.commitsFrom(ref)).map(c => c.oid));
	}

	async log(options?: LogOptions, cancellationToken?: CancellationToken): Promise<Commit[]> {
		throwIfCancelled(cancellationToken);
		const decorations = await this.decorations();

		let commits: isogit.ReadCommitResult[];
		if (options?.range) {
			const [from, to] = options.range.split(/\.\.\.?/);
			const excluded = from ? await this.ancestorSet(from) : new Set<string>();
			commits = (await this.commitsFrom(to || 'HEAD')).filter(c => !excluded.has(c.oid));
		} else {
			const refs = options?.refNames?.length ? options.refNames : ['HEAD'];
			const seen = new Map<string, isogit.ReadCommitResult>();
			for (const ref of refs) {
				for (const commit of await this.commitsFrom(ref)) {
					seen.set(commit.oid, commit);
				}
			}
			commits = [...seen.values()].sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp);
		}

		throwIfCancelled(cancellationToken);

		if (typeof options?.maxParents === 'number') {
			commits = commits.filter(c => c.commit.parent.length <= options.maxParents!);
		}
		if (options?.author) {
			const author = new RegExp(options.author, 'i');
			commits = commits.filter(c => author.test(`${c.commit.author.name} <${c.commit.author.email}>`));
		}
		if (options?.grep) {
			const grep = new RegExp(options.grep, 'i');
			commits = commits.filter(c => grep.test(c.commit.message));
		}
		if (options?.path) {
			const relativePath = this.relative(options.path);
			commits = await this.filterByPath(commits, relativePath);
		}
		if (options?.reverse) {
			commits = commits.reverse();
		}
		if (typeof options?.skip === 'number') {
			commits = commits.slice(options.skip);
		}
		if (!options?.range) {
			commits = commits.slice(0, options?.maxEntries ?? 32);
		}

		return commits.map(c => this.toCommit(c, decorations));
	}

	private async blobOidAt(commitOid: string, relativePath: string): Promise<string | undefined> {
		return isogit.readBlob({ fs, dir: this.dir, oid: commitOid, filepath: relativePath }).then(r => r.oid).catch(() => undefined);
	}

	private async filterByPath(commits: isogit.ReadCommitResult[], relativePath: string): Promise<isogit.ReadCommitResult[]> {
		const result: isogit.ReadCommitResult[] = [];
		for (const commit of commits) {
			const current = await this.blobOidAt(commit.oid, relativePath);
			const parent = commit.commit.parent[0] ? await this.blobOidAt(commit.commit.parent[0], relativePath) : undefined;
			if (current !== parent) {
				result.push(commit);
			}
		}
		return result;
	}

	async logFile(uri: Uri, options?: LogFileOptions, cancellationToken?: CancellationToken): Promise<Commit[]> {
		const maxEntries = typeof options?.maxEntries === 'string' ? parseInt(options.maxEntries) : options?.maxEntries;
		return this.log({ path: uri.path, maxEntries: maxEntries ?? 32, reverse: options?.reverse }, cancellationToken);
	}

	async reflog(_ref: string, _pattern: string): Promise<string[]> {
		return [];
	}

	async getCommit(ref: string): Promise<Commit> {
		return wrap('show', async () => {
			const oid = await this.resolve(ref);
			const result = await isogit.readCommit({ fs, dir: this.dir, oid });
			return this.toCommit(result, await this.decorations());
		});
	}

	async revList(ref1: string, ref2: string): Promise<string[]> {
		const excluded = await this.ancestorSet(ref1);
		return (await this.commitsFrom(ref2)).filter(c => !excluded.has(c.oid)).map(c => c.oid);
	}

	async revParse(ref: string): Promise<string | undefined> {
		return this.resolve(ref).catch(() => undefined);
	}

	async getMergeBase(ref1: string, ref2: string, ...refs: string[]): Promise<string | undefined> {
		try {
			const oids = await Promise.all([ref1, ref2, ...refs].map(ref => this.resolve(ref)));
			const [base] = await isogit.findMergeBase({ fs, dir: this.dir, oids });
			return base;
		} catch {
			return undefined;
		}
	}

	// #endregion

	// #region Diffs

	private toChange(relativePath: string, status: Status): Change {
		const uri = fileUri(this.absolute(relativePath));
		return { status, uri, originalUri: uri, renameUri: uri };
	}

	/** Changed blobs between two trees (undefined = working tree / index handled by callers). */
	private async treeChanges(fromOid: string | undefined, toOid: string): Promise<DiffChange[]> {
		const trees = fromOid && fromOid !== EMPTY_TREE ? [isogit.TREE({ ref: fromOid }), isogit.TREE({ ref: toOid })] : [isogit.TREE({ ref: toOid })];
		const changes = await isogit.walk({
			fs,
			dir: this.dir,
			trees,
			map: async (filepath, entries) => {
				if (filepath === '.') {
					return undefined;
				}
				const [before, after] = trees.length === 2 ? entries : [null, entries[0]];
				const [beforeOid, afterOid] = await Promise.all([before?.oid(), after?.oid()]);
				if (beforeOid === afterOid) {
					return null;
				}
				const type = (await after?.type()) ?? (await before?.type());
				if (type === 'tree') {
					return undefined;
				}
				const status = !before ? Status.INDEX_ADDED : !after ? Status.DELETED : Status.MODIFIED;
				return { ...this.toChange(filepath, status), insertions: 0, deletions: 0 };
			},
		});
		return (changes as (DiffChange | undefined)[]).filter((c): c is DiffChange => !!c);
	}

	private async statusRows(): Promise<StatusRow[]> {
		const matrix = await isogit.statusMatrix({ fs, dir: this.dir });
		return matrix.map(([filepath, head, workdir, stage]) => ({ filepath, head, workdir, stage }));
	}

	async diffWithHEAD(filePath?: string | undefined): Promise<any> {
		if (filePath) {
			return '';
		}
		return (await this.statusRows())
			.filter(r => r.head === 1 && (r.workdir === 0 || r.workdir === 2))
			.map(r => this.toChange(r.filepath, r.workdir === 0 ? Status.DELETED : Status.MODIFIED));
	}

	async diffWithHEADShortStats(_path?: string): Promise<CommitShortStat> {
		const changes = await this.diffWithHEAD() as Change[];
		return { files: changes.length, insertions: 0, deletions: 0 };
	}

	async diffWith(ref: string, filePath?: string): Promise<any> {
		if (filePath) {
			return '';
		}
		const oid = await this.resolve(ref);
		const head = await this.resolve('HEAD').catch(() => undefined);
		return oid === head ? this.diffWithHEAD() : this.treeChanges(oid, head ?? oid);
	}

	async diffIndexWithHEAD(filePath?: string): Promise<any> {
		if (filePath) {
			return '';
		}
		return (await this.statusRows())
			.filter(r => (r.head === 0 && r.stage !== 0) || (r.head === 1 && r.stage !== 1))
			.map(r => this.toChange(r.filepath, r.head === 0 ? Status.INDEX_ADDED : r.stage === 0 ? Status.INDEX_DELETED : Status.INDEX_MODIFIED));
	}

	async diffIndexWithHEADShortStats(_path?: string): Promise<CommitShortStat> {
		const changes = await this.diffIndexWithHEAD() as Change[];
		return { files: changes.length, insertions: 0, deletions: 0 };
	}

	async diffIndexWith(ref: string, filePath?: string): Promise<any> {
		return this.diffWith(ref, filePath);
	}

	async diffBlobs(_object1: string, _object2: string): Promise<string> {
		return '';
	}

	async diffBetween(ref1: string, ref2: string, filePath?: string): Promise<any> {
		if (filePath) {
			return '';
		}
		const base = await this.getMergeBase(ref1, ref2) ?? await this.resolve(ref1);
		return this.treeChanges(base, await this.resolve(ref2));
	}

	async diffBetweenPatch(_ref: string, _options: { path?: string }): Promise<string> {
		return '';
	}

	async diffBetweenWithStats(ref: string, options: { path?: string; similarityThreshold?: number }): Promise<DiffChange[]> {
		return wrap('diff', async () => {
			const [from, to] = ref.split(/\.\.\.?/);
			const toOid = await this.resolve(to || 'HEAD');
			const base = ref.includes('...') ? await this.getMergeBase(from, to || 'HEAD') ?? await this.resolve(from) : await this.resolve(from);
			const changes = await this.treeChanges(base, toOid);
			return options.path ? changes.filter(c => c.uri.path === this.absolute(this.relative(options.path!))) : changes;
		}).catch(() => []);
	}

	async diffTrees(treeish1: string, treeish2?: string, _options?: { similarityThreshold?: number }): Promise<DiffChange[]> {
		return wrap('diff-tree', async () => {
			if (!treeish2) {
				const commit = await isogit.readCommit({ fs, dir: this.dir, oid: await this.resolve(treeish1) });
				return this.treeChanges(commit.commit.parent[0], commit.oid);
			}
			return this.treeChanges(treeish1 === EMPTY_TREE ? undefined : await this.resolve(treeish1), await this.resolve(treeish2));
		}).catch(() => []);
	}

	async diff(_cached = false): Promise<string> {
		return '';
	}

	async showChanges(_ref: string): Promise<string> {
		return '';
	}

	async showChangesBetween(_ref1: string, _ref2: string, _path?: string): Promise<string> {
		return '';
	}

	async apply(_patch: string, _options?: { reverse?: boolean; threeWay?: boolean; allowEmpty?: boolean }): Promise<void> {
		unsupported('Apply patch');
	}

	// #endregion

	// #region Index & working tree

	async add(paths: string[], opts?: { update?: boolean }): Promise<void> {
		await wrap('add', async () => {
			const rows = await this.statusRows();
			const targets = paths.length === 0
				? rows.filter(r => !opts?.update || r.head === 1 || r.stage !== 0).map(r => r.filepath)
				: paths.map(p => this.relative(p));
			const wanted = new Set(targets);
			const matchesTarget = (filepath: string) => wanted.has(filepath) || targets.some(t => t === '' || t === '.' || filepath.startsWith(`${t.replace(/\/$/, '')}/`));
			for (const row of rows.filter(r => matchesTarget(r.filepath))) {
				if (row.workdir === 0) {
					if (row.stage !== 0) {
						await isogit.remove({ fs, dir: this.dir, filepath: row.filepath });
					}
				} else if (row.workdir !== row.stage || row.stage === 3) {
					await isogit.add({ fs, dir: this.dir, filepath: row.filepath });
				}
			}
		});
	}

	async rm(paths: string[]): Promise<void> {
		await wrap('rm', async () => {
			for (const filePath of paths) {
				const filepath = this.relative(filePath);
				await isogit.remove({ fs, dir: this.dir, filepath });
				await fs.promises.unlink(this.absolute(filepath)).catch(() => undefined);
			}
		});
	}

	async stage(filePath: string, data: Uint8Array): Promise<void> {
		await wrap('update-index', async () => {
			const filepath = this.relative(filePath);
			const oid = await isogit.writeBlob({ fs, dir: this.dir, blob: data });
			const exists = !!(await this.readIndexEntry(filepath));
			await isogit.updateIndex({ fs, dir: this.dir, filepath, oid, add: !exists });
		});
	}

	private async restoreFromIndex(relativePaths: string[]): Promise<void> {
		for (const filepath of relativePaths) {
			const entry = await this.readIndexEntry(filepath);
			if (entry) {
				const { blob } = await isogit.readBlob({ fs, dir: this.dir, oid: entry.oid });
				await fs.promises.writeFile(this.absolute(filepath), blob);
			}
		}
	}

	async checkout(treeish: string, paths: string[], opts: { track?: boolean; detached?: boolean } = Object.create(null)): Promise<void> {
		await wrap('checkout', async () => {
			if (paths.length > 0) {
				const relativePaths = paths.map(p => this.relative(p));
				if (!treeish) {
					await this.restoreFromIndex(relativePaths);
					return;
				}
				await isogit.checkout({ fs, dir: this.dir, ref: await this.resolve(treeish), filepaths: relativePaths, force: true, noUpdateHead: true });
				return;
			}

			const remoteBranch = /^([^/]+)\/(.+)$/.exec(treeish);
			const remotes = (await isogit.listRemotes({ fs, dir: this.dir })).map(r => r.remote);
			if (opts.track && remoteBranch && remotes.includes(remoteBranch[1])) {
				const [, remote, name] = remoteBranch;
				const oid = await this.resolve(`refs/remotes/${remote}/${name}`);
				await isogit.branch({ fs, dir: this.dir, ref: name, object: oid });
				await this.setBranchUpstream(name, `${remote}/${name}`);
				await isogit.checkout({ fs, dir: this.dir, ref: name });
				return;
			}
			if (opts.detached) {
				await isogit.checkout({ fs, dir: this.dir, ref: await this.resolve(treeish) });
				return;
			}
			const local = await isogit.listBranches({ fs, dir: this.dir });
			await isogit.checkout({ fs, dir: this.dir, ref: local.includes(treeish) ? treeish : await this.resolve(treeish) });
		});
	}

	async commit(message: string | undefined, opts: CommitOptions = Object.create(null)): Promise<void> {
		await wrap('commit', async () => {
			if (opts.all) {
				await this.add([], { update: opts.all === 'tracked' });
			}
			const head = await this.resolve('HEAD').catch(() => undefined);
			if (!opts.empty && !opts.amend && head) {
				const staged = (await this.statusRows()).some(r => (r.head === 0 && r.stage !== 0) || (r.head === 1 && r.stage !== 1));
				if (!staged) {
					throw new GitError({ message: 'nothing to commit, working tree clean', stdout: 'nothing to commit', exitCode: 1, gitCommand: 'commit' });
				}
			}
			const author = await this.author();
			let finalMessage = message ?? '';
			if (opts.signoff) {
				finalMessage = `${finalMessage.trimEnd()}\n\nSigned-off-by: ${author.name} <${author.email}>`;
			}
			await isogit.commit({ fs, dir: this.dir, message: finalMessage, author, amend: !!opts.amend && !!head });
		});
	}

	async clean(paths: string[]): Promise<void> {
		await wrap('clean', async () => {
			for (const filePath of paths) {
				await fs.promises.unlink(this.absolute(this.relative(filePath))).catch(() => undefined);
			}
		});
	}

	async undo(): Promise<void> {
		await wrap('checkout', async () => {
			for (const row of await this.statusRows()) {
				if (row.head === 0 && row.stage === 0) {
					await fs.promises.unlink(this.absolute(row.filepath)).catch(() => undefined);
				}
			}
			await this.restoreFromIndex((await this.statusRows()).filter(r => r.stage !== 0).map(r => r.filepath));
		});
	}

	async reset(treeish: string, hard: boolean = false): Promise<void> {
		await wrap('reset', async () => {
			const oid = await this.resolve(treeish);
			const branch = await isogit.currentBranch({ fs, dir: this.dir, fullname: true });
			await isogit.writeRef({ fs, dir: this.dir, ref: branch ?? 'HEAD', value: oid, force: true });
			const rows = await this.statusRows();
			for (const row of rows) {
				await isogit.resetIndex({ fs, dir: this.dir, filepath: row.filepath, ref: oid });
			}
			if (hard) {
				await isogit.checkout({ fs, dir: this.dir, ref: branch ? branch.replace(/^refs\/heads\//, '') : oid, force: true });
			}
		});
	}

	/** `git reset <treeish> -- <paths>`: unstage paths back to `treeish`. */
	async revert(treeish: string, paths: string[]): Promise<void> {
		await wrap('reset', async () => {
			const head = await this.resolve(treeish || 'HEAD').catch(() => undefined);
			// No paths means every staged path, like `git reset <treeish>`.
			const filepaths = paths.length > 0
				? paths.map(p => this.relative(p))
				: (await this.statusRows()).filter(r => (r.head === 0 && r.stage !== 0) || (r.head === 1 && r.stage !== 1)).map(r => r.filepath);
			for (const filepath of filepaths) {
				await isogit.resetIndex({ fs, dir: this.dir, filepath, ref: head });
			}
		});
	}

	async restore(paths: string[], options?: { staged?: boolean; ref?: string }): Promise<void> {
		if (options?.staged) {
			return this.revert(options.ref ?? 'HEAD', paths);
		}
		return this.checkout(options?.ref ?? '', paths);
	}

	// #endregion

	// #region Branches, tags, remotes

	async branch(name: string, checkout: boolean, ref?: string): Promise<void> {
		await wrap('branch', async () => {
			const object = ref ? await this.resolve(ref) : undefined;
			await isogit.branch({ fs, dir: this.dir, ref: name, object });
			if (checkout) {
				await isogit.checkout({ fs, dir: this.dir, ref: name });
			}
		});
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		await wrap('branch', async () => {
			if (!force) {
				const oid = await this.resolve(`refs/heads/${name}`);
				const head = await this.resolve('HEAD').catch(() => undefined);
				const merged = !head || oid === head || await isogit.isDescendent({ fs, dir: this.dir, oid: head, ancestor: oid, depth: -1 }).catch(() => false);
				if (!merged) {
					throw new GitError({ message: `The branch '${name}' is not fully merged.`, gitErrorCode: GitErrorCodes.BranchNotFullyMerged });
				}
			}
			await isogit.deleteBranch({ fs, dir: this.dir, ref: name });
		});
	}

	async renameBranch(name: string): Promise<void> {
		await wrap('branch', async () => {
			const current = await isogit.currentBranch({ fs, dir: this.dir, fullname: false });
			if (!current) {
				throw new GitError({ message: 'Not on a branch.' });
			}
			await isogit.renameBranch({ fs, dir: this.dir, oldref: current, ref: name, checkout: true });
		});
	}

	async move(from: string, to: string): Promise<void> {
		await wrap('mv', async () => {
			const source = this.relative(from);
			const target = this.relative(to);
			await fs.promises.rename(this.absolute(source), this.absolute(target));
			await isogit.remove({ fs, dir: this.dir, filepath: source });
			await isogit.add({ fs, dir: this.dir, filepath: target });
		});
	}

	async setBranchUpstream(name: string, upstream: string): Promise<void> {
		const match = /^(?:refs\/remotes\/)?([^/]+)\/(.+)$/.exec(upstream);
		if (!match) {
			throw new GitError({ message: `Invalid upstream '${upstream}'.` });
		}
		const [, remote, branch] = match;
		await isogit.setConfig({ fs, dir: this.dir, path: `branch.${name}.remote`, value: remote });
		await isogit.setConfig({ fs, dir: this.dir, path: `branch.${name}.merge`, value: `refs/heads/${branch}` });
	}

	async deleteRef(ref: string): Promise<void> {
		await wrap('update-ref', () => isogit.deleteRef({ fs, dir: this.dir, ref }));
	}

	async merge(ref: string): Promise<void> {
		await wrap('merge', async () => {
			const ours = await isogit.currentBranch({ fs, dir: this.dir, fullname: false });
			if (!ours) {
				throw new GitError({ message: 'Check out a branch before merging.' });
			}
			const author = await this.author();
			const result = await isogit.merge({ fs, dir: this.dir, ours, theirs: await this.resolve(ref), author, abortOnConflict: true });
			if (!result.alreadyMerged) {
				await isogit.checkout({ fs, dir: this.dir, ref: ours, force: true });
			}
		});
	}

	async mergeAbort(): Promise<void> {
		unsupported('Abort merge');
	}

	async tag(options: { name: string; message?: string; ref?: string }): Promise<void> {
		await wrap('tag', async () => {
			const object = await this.resolve(options.ref || 'HEAD');
			if (options.message) {
				await isogit.annotatedTag({ fs, dir: this.dir, ref: options.name, message: options.message, object, tagger: await this.author() });
			} else {
				await isogit.tag({ fs, dir: this.dir, ref: options.name, object });
			}
		});
	}

	async deleteTag(name: string): Promise<void> {
		await wrap('tag', () => isogit.deleteTag({ fs, dir: this.dir, ref: name }));
	}

	async addRemote(name: string, url: string): Promise<void> {
		await wrap('remote', () => isogit.addRemote({ fs, dir: this.dir, remote: name, url }));
	}

	async removeRemote(name: string): Promise<void> {
		await wrap('remote', () => isogit.deleteRemote({ fs, dir: this.dir, remote: name }));
	}

	async renameRemote(name: string, newName: string): Promise<void> {
		await wrap('remote', async () => {
			const url = await isogit.getConfig({ fs, dir: this.dir, path: `remote.${name}.url` });
			await isogit.addRemote({ fs, dir: this.dir, remote: newName, url });
			await isogit.deleteRemote({ fs, dir: this.dir, remote: name });
			for (const branch of await isogit.listBranches({ fs, dir: this.dir })) {
				if (await isogit.getConfig({ fs, dir: this.dir, path: `branch.${branch}.remote` }) === name) {
					await isogit.setConfig({ fs, dir: this.dir, path: `branch.${branch}.remote`, value: newName });
				}
			}
		});
	}

	// #endregion

	// #region Network

	private async remoteUrl(remote: string): Promise<string> {
		const url = await isogit.getConfig({ fs, dir: this.dir, path: `remote.${remote}.url` });
		if (!url) {
			throw new GitError({ message: `No remote named '${remote}'.`, gitErrorCode: GitErrorCodes.NoRemoteRepositorySpecified });
		}
		return url;
	}

	private networkOptions(action: string, cancellationToken?: CancellationToken) {
		const hooks = networkHooks();
		return {
			http: hooks.http,
			onAuth: hooks.onAuth,
			onAuthFailure: hooks.onAuthFailure,
			onMessage: (message: string) => hooks.log(message.trimEnd()),
			onProgress: (event: isogit.GitProgressEvent) => {
				throwIfCancelled(cancellationToken);
				if (event.total) {
					hooks.log(`${action}: ${event.phase} ${Math.round((event.loaded / event.total) * 100)}% (${event.loaded}/${event.total})`);
				}
			},
		};
	}

	async fetch(options: { remote?: string; ref?: string; all?: boolean; prune?: boolean; depth?: number; silent?: boolean; readonly cancellationToken?: CancellationToken } = {}): Promise<void> {
		await wrap('fetch', async () => {
			const remotes = options.all || !options.remote
				? (await isogit.listRemotes({ fs, dir: this.dir })).map(r => r.remote)
				: [options.remote];
			for (const remote of remotes) {
				const hooks = networkHooks();
				if (!options.silent) {
					hooks.log(`> git fetch ${remote}${options.ref ? ` ${options.ref}` : ''}`);
				}
				const network = this.networkOptions('fetch', options.cancellationToken);
				await isogit.fetch({
					fs,
					dir: this.dir,
					remote,
					ref: options.ref,
					singleBranch: !!options.ref,
					prune: options.prune,
					depth: options.depth,
					tags: false,
					...network,
					onMessage: options.silent ? undefined : network.onMessage,
					onProgress: options.silent ? undefined : network.onProgress,
				});
			}
		});
	}

	async fetchTags(options: { remote: string; tags: string[]; force?: boolean }): Promise<void> {
		await wrap('fetch', () => isogit.fetch({ fs, dir: this.dir, remote: options.remote, tags: true, ...this.networkOptions('fetch') }).then(() => undefined));
	}

	async pull(rebase?: boolean, remote?: string, branch?: string, options: PullOptions = {}): Promise<boolean> {
		if (rebase) {
			unsupported('Pull (rebase)');
		}
		return wrap('pull', async () => {
			const current = await isogit.currentBranch({ fs, dir: this.dir, fullname: false });
			if (!current) {
				throw new GitError({ message: 'Check out a branch before pulling.' });
			}
			const upstreamRemote = remote ?? await isogit.getConfig({ fs, dir: this.dir, path: `branch.${current}.remote` });
			const upstreamBranch = branch ?? (await isogit.getConfig({ fs, dir: this.dir, path: `branch.${current}.merge` }))?.replace(/^refs\/heads\//, '');
			if (!upstreamRemote || !upstreamBranch) {
				throw new GitError({ message: `There is no tracking information for the branch '${current}'.`, gitErrorCode: GitErrorCodes.NoUpstreamBranch });
			}
			const hooks = networkHooks();
			hooks.log(`> git pull ${upstreamRemote} ${upstreamBranch}`);
			const before = await this.resolve('HEAD').catch(() => undefined);
			await isogit.fetch({ fs, dir: this.dir, remote: upstreamRemote, ref: upstreamBranch, singleBranch: true, tags: !!options.tags, ...this.networkOptions('pull', options.cancellationToken) });
			const theirs = await this.resolve(`refs/remotes/${upstreamRemote}/${upstreamBranch}`);
			if (before) {
				const result = await isogit.merge({ fs, dir: this.dir, ours: current, theirs, author: await this.author(), abortOnConflict: true });
				if (result.alreadyMerged) {
					hooks.log('Already up to date.');
					return false;
				}
			} else {
				await isogit.writeRef({ fs, dir: this.dir, ref: `refs/heads/${current}`, value: theirs, force: true });
			}
			await isogit.checkout({ fs, dir: this.dir, ref: current });
			hooks.log(`Updated ${current} to ${(await this.resolve('HEAD')).slice(0, 7)}.`);
			return true;
		});
	}

	async rebase(_branch: string, _options: PullOptions = {}): Promise<void> {
		unsupported('Rebase');
	}

	async rebaseAbort(): Promise<void> {
		unsupported('Rebase');
	}

	async rebaseContinue(): Promise<void> {
		unsupported('Rebase');
	}

	async push(remote?: string, name?: string, setUpstream: boolean = false, _followTags = false, forcePushMode?: ForcePushMode, tags = false): Promise<void> {
		await wrap('push', async () => {
			if (tags) {
				unsupported('Push tags');
			}
			const current = await isogit.currentBranch({ fs, dir: this.dir, fullname: false });
			const targetRemote = remote ?? (current ? await isogit.getConfig({ fs, dir: this.dir, path: `branch.${current}.remote` }) : undefined) ?? 'origin';
			const [localRef, remoteRef] = (name ?? current ?? '').split(':');
			if (!localRef) {
				throw new GitError({ message: 'Check out a branch before pushing.', gitErrorCode: GitErrorCodes.NoUpstreamBranch });
			}
			const hooks = networkHooks();
			const force = forcePushMode !== undefined;
			hooks.log(`> git push${force ? ' --force' : ''}${setUpstream ? ' -u' : ''} ${targetRemote} ${name ?? localRef}`);
			const result = await isogit.push({
				fs,
				dir: this.dir,
				remote: targetRemote,
				ref: localRef,
				remoteRef: remoteRef || undefined,
				force,
				...this.networkOptions('push'),
			});
			for (const [ref, status] of Object.entries(result.refs ?? {})) {
				hooks.log(status.ok ? `  ${ref}: pushed` : `  ${ref}: rejected (${status.error})`);
			}
			if (!result.ok) {
				const refError = Object.values(result.refs ?? {}).find(r => !r.ok)?.error;
				throw new GitError({ message: `Failed to push: ${result.error || refError || 'the remote rejected the push'}`, stderr: result.error || refError, gitErrorCode: GitErrorCodes.PushRejected, gitCommand: 'push' });
			}
			const branchName = localRef.replace(/^refs\/heads\//, '');
			const remoteBranch = (remoteRef || localRef).replace(/^refs\/heads\//, '');
			if (!localRef.startsWith('refs/tags/')) {
				const oid = await this.resolve(localRef);
				await isogit.writeRef({ fs, dir: this.dir, ref: `refs/remotes/${targetRemote}/${remoteBranch}`, value: oid, force: true });
				if (setUpstream) {
					await this.setBranchUpstream(branchName, `${targetRemote}/${remoteBranch}`);
				}
			}
			hooks.log(`Pushed ${branchName} to ${targetRemote}/${remoteBranch}.`);
		});
	}

	async deleteRemoteRef(remoteName: string, refName: string, options?: { force?: boolean }): Promise<void> {
		await wrap('push', async () => {
			const result = await isogit.push({ fs, dir: this.dir, remote: remoteName, ref: refName, delete: true, force: options?.force, ...this.networkOptions('push') });
			if (!result.ok) {
				throw new GitError({ message: result.error ?? 'Failed to delete remote branch', gitErrorCode: GitErrorCodes.PushRejected });
			}
			await isogit.deleteRef({ fs, dir: this.dir, ref: `refs/remotes/${remoteName}/${refName.replace(/^refs\/heads\//, '')}` }).catch(() => undefined);
		});
	}

	async getRemoteRefs(remote: string, opts?: { heads?: boolean; tags?: boolean; cancellationToken?: CancellationToken }): Promise<Ref[]> {
		return wrap('ls-remote', async () => {
			const hooks = networkHooks();
			const refs = await isogit.listServerRefs({ http: hooks.http, url: await this.remoteUrl(remote), onAuth: hooks.onAuth, onAuthFailure: hooks.onAuthFailure, protocolVersion: 2 });
			return refs.flatMap<Ref>(({ ref, oid }) => {
				if (ref.startsWith('refs/heads/') && opts?.heads !== false) {
					return [{ name: ref.substring(11), commit: oid, type: RefType.Head }];
				}
				if (ref.startsWith('refs/tags/') && opts?.tags) {
					return [{ name: ref.substring(10).replace(/\^\{\}$/, ''), commit: oid, type: RefType.Tag }];
				}
				return [];
			});
		});
	}

	// #endregion

	// #region Unsupported features

	async cherryPick(_commitHash: string): Promise<void> {
		unsupported('Cherry pick');
	}

	async cherryPickAbort(): Promise<void> {
		unsupported('Cherry pick');
	}

	async blame(_path: string): Promise<string> {
		return unsupported('Blame');
	}

	async blame2(_path: string, _ref?: string, _ignoreWhitespace?: boolean): Promise<BlameInformation[] | undefined> {
		return undefined;
	}

	async createStash(_message?: string, _includeUntracked?: boolean, _staged?: boolean): Promise<void> {
		unsupported('Stash');
	}

	async popStash(_index?: number, _options?: { reinstateStagedChanges?: boolean }): Promise<void> {
		unsupported('Stash');
	}

	async applyStash(_index?: number, _options?: { reinstateStagedChanges?: boolean }): Promise<void> {
		unsupported('Stash');
	}

	async dropStash(_index?: number): Promise<void> {
		unsupported('Stash');
	}

	async showStash(_index: number): Promise<Change[] | undefined> {
		return undefined;
	}

	async addWorktree(_options: { path: string; commitish: string; branch?: string; noTrack?: boolean }): Promise<void> {
		unsupported('Worktrees');
	}

	async deleteWorktree(_path: string, _options?: { force?: boolean }): Promise<void> {
		unsupported('Worktrees');
	}

	async updateSubmodules(_paths: string[]): Promise<void> {
		// Submodules are not supported in the browser.
	}

	// #endregion

	// #region Status & refs

	async getStatus(opts?: { limit?: number; ignoreSubmodules?: boolean; similarityThreshold?: number; untrackedChanges?: 'mixed' | 'separate' | 'hidden'; cancellationToken?: CancellationToken }): Promise<{ status: IFileStatus[]; statusLength: number; didHitLimit: boolean }> {
		throwIfCancelled(opts?.cancellationToken);
		const rows = await wrap('status', () => this.statusRows());
		throwIfCancelled(opts?.cancellationToken);

		const status: IFileStatus[] = [];
		for (const { filepath, head, workdir, stage } of rows) {
			if (head === 0 && stage === 0) {
				if (workdir === 2 && opts?.untrackedChanges !== 'hidden') {
					status.push({ x: '?', y: '?', path: filepath });
				}
				continue;
			}
			// X: index compared to HEAD
			const x = head === 0 ? 'A' : stage === 0 ? 'D' : stage === 1 ? ' ' : 'M';
			// Y: working tree compared to index
			let y: string;
			if (workdir === 0) {
				y = stage === 0 ? ' ' : 'D';
			} else if (stage === 0) {
				y = ' ';
			} else if (workdir === 1) {
				y = stage === 1 ? ' ' : 'M';
			} else {
				y = stage === 2 ? ' ' : 'M';
			}
			if (x !== ' ' || y !== ' ') {
				status.push({ x, y, path: filepath });
			}
			if (head === 1 && stage === 0 && workdir !== 0 && opts?.untrackedChanges !== 'hidden') {
				status.push({ x: '?', y: '?', path: filepath });
			}
		}

		const limit = opts?.limit ?? 10000;
		const didHitLimit = limit !== 0 && status.length > limit;
		return { status: didHitLimit ? status.slice(0, limit) : status, statusLength: status.length, didHitLimit };
	}

	async getHEAD(): Promise<Ref> {
		const name = await isogit.currentBranch({ fs, dir: this.dir, fullname: false, test: false }).catch(() => undefined);
		if (name) {
			return { name, commit: undefined, type: RefType.Head };
		}
		const commit = await this.resolve('HEAD').catch(() => undefined);
		if (!commit) {
			throw new Error('Error parsing HEAD');
		}
		return { name: undefined, commit, type: RefType.Head };
	}

	async getHEADFS(): Promise<Ref> {
		return this.getHEAD();
	}

	async getHEADRef(): Promise<Branch | undefined> {
		let HEAD: Branch | undefined;
		try {
			HEAD = await this.getHEAD();
			if (HEAD.name) {
				HEAD = await this.getBranch(HEAD.name);
				if (HEAD && HEAD.upstream) {
					const commit = await this.revParse(`refs/remotes/${HEAD.upstream.remote}/${HEAD.upstream.name}`);
					HEAD = { ...HEAD, upstream: { ...HEAD.upstream, commit } };
				}
			} else if (HEAD.commit) {
				const tags = await this.getRefs({ pattern: 'refs/tags' });
				const tag = tags.find(tag => tag.commit === HEAD!.commit);
				if (tag) {
					HEAD = { ...HEAD, name: tag.name, type: RefType.Tag };
				}
			}
		} catch {
			// noop
		}
		return HEAD;
	}

	private async upstreamOf(branch: string): Promise<{ remote: string; name: string } | undefined> {
		const remote = await isogit.getConfig({ fs, dir: this.dir, path: `branch.${branch}.remote` }).catch(() => undefined);
		const merge = await isogit.getConfig({ fs, dir: this.dir, path: `branch.${branch}.merge` }).catch(() => undefined);
		if (!remote || !merge) {
			return undefined;
		}
		const name = String(merge).replace(/^refs\/heads\//, '');
		const exists = await this.resolve(`refs/remotes/${remote}/${name}`).then(() => true, () => false);
		return exists ? { remote, name } : undefined;
	}

	private async aheadBehind(localOid: string, upstreamOid: string): Promise<{ ahead: number; behind: number }> {
		if (localOid === upstreamOid) {
			return { ahead: 0, behind: 0 };
		}
		const [local, upstream] = await Promise.all([this.ancestorSet(localOid), this.ancestorSet(upstreamOid)]);
		let ahead = 0;
		let behind = 0;
		local.forEach(oid => { if (!upstream.has(oid)) { ahead++; } });
		upstream.forEach(oid => { if (!local.has(oid)) { behind++; } });
		return { ahead, behind };
	}

	async getBranch(name: string): Promise<Branch> {
		if (name === 'HEAD') {
			return this.getHEAD();
		}
		const remoteMatch = /^(?:refs\/remotes\/)?([^/]+)\/(.+)$/.exec(name);
		const localName = name.replace(/^refs\/heads\//, '');
		const localOid = await this.resolve(`refs/heads/${localName}`).catch(() => undefined);
		if (localOid) {
			const upstream = await this.upstreamOf(localName);
			const counts = upstream
				? await this.aheadBehind(localOid, await this.resolve(`refs/remotes/${upstream.remote}/${upstream.name}`))
				: { ahead: 0, behind: 0 };
			return { type: RefType.Head, name: localName, upstream, commit: localOid, ahead: counts.ahead, behind: counts.behind };
		}
		if (remoteMatch) {
			const [, remote, branch] = remoteMatch;
			const oid = await this.resolve(`refs/remotes/${remote}/${branch}`).catch(() => undefined);
			if (oid) {
				return { type: RefType.RemoteHead, name: branch, remote, commit: oid };
			}
		}
		this.logger.warn(`[Git][getBranch] No such branch: ${name}`);
		throw new Error(`No such branch: ${name}.`);
	}

	async getRefs(query: RefQuery, cancellationToken?: CancellationToken): Promise<(Ref | Branch)[]> {
		throwIfCancelled(cancellationToken);
		const refs: { full: string; ref: Ref | Branch }[] = [];

		for (const branch of await isogit.listBranches({ fs, dir: this.dir }).catch(() => [] as string[])) {
			const commit = await this.resolve(`refs/heads/${branch}`).catch(() => undefined);
			if (commit) {
				refs.push({ full: `refs/heads/${branch}`, ref: { name: branch, commit, type: RefType.Head } });
			}
		}
		for (const { remote } of await isogit.listRemotes({ fs, dir: this.dir }).catch(() => [] as { remote: string }[])) {
			for (const branch of await isogit.listBranches({ fs, dir: this.dir, remote }).catch(() => [] as string[])) {
				if (branch === 'HEAD') {
					continue;
				}
				const commit = await this.resolve(`refs/remotes/${remote}/${branch}`).catch(() => undefined);
				if (commit) {
					refs.push({ full: `refs/remotes/${remote}/${branch}`, ref: { name: `${remote}/${branch}`, remote, commit, type: RefType.RemoteHead } });
				}
			}
		}
		for (const tag of await isogit.listTags({ fs, dir: this.dir }).catch(() => [] as string[])) {
			let commit = await this.resolve(`refs/tags/${tag}`).catch(() => undefined);
			if (commit) {
				commit = await isogit.readTag({ fs, dir: this.dir, oid: commit }).then(t => t.tag.object).catch(() => commit);
				refs.push({ full: `refs/tags/${tag}`, ref: { name: tag, commit, type: RefType.Tag } });
			}
		}

		let result = refs;
		if (query.pattern) {
			const patterns = (Array.isArray(query.pattern) ? query.pattern : [query.pattern]).map(p => p.startsWith('refs/') ? p : `refs/${p}`);
			result = result.filter(({ full }) => patterns.some(pattern => {
				const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}(/.*)?$`);
				return regex.test(full);
			}));
		}

		const details = new Map<string, isogit.ReadCommitResult>();
		const needsCommits = query.includeCommitDetails || (query.sort && query.sort !== 'alphabetically');
		if (needsCommits) {
			for (const { ref } of result) {
				if (ref.commit && !details.has(ref.commit)) {
					const commit = await isogit.readCommit({ fs, dir: this.dir, oid: ref.commit }).catch(() => undefined);
					if (commit) {
						details.set(ref.commit, commit);
					}
				}
			}
		}
		if (query.sort && query.sort !== 'alphabetically') {
			result = [...result].sort((a, b) => (details.get(b.ref.commit!)?.commit.committer.timestamp ?? 0) - (details.get(a.ref.commit!)?.commit.committer.timestamp ?? 0));
		}
		if (query.count) {
			result = result.slice(0, query.count);
		}

		const withAheadBehind: (Ref | Branch)[] = [];
		for (const { ref } of result) {
			let item: Ref | Branch = ref;
			if (query.includeCommitDetails && ref.commit) {
				const commit = details.get(ref.commit);
				if (commit) {
					item = { ...item, commitDetails: { hash: commit.oid, message: commit.commit.message.split('\n')[0], parents: commit.commit.parent, authorName: commit.commit.author.name, commitDate: new Date(commit.commit.committer.timestamp * 1000) } };
				}
				if (ref.type === RefType.Head && ref.name) {
					const upstream = await this.upstreamOf(ref.name);
					if (upstream) {
						const counts = await this.aheadBehind(ref.commit, await this.resolve(`refs/remotes/${upstream.remote}/${upstream.name}`));
						item = { ...item, ahead: counts.ahead, behind: counts.behind } as Branch;
					}
				}
			}
			withAheadBehind.push(item);
		}
		return withAheadBehind;
	}

	async findTrackingBranches(upstreamBranch: string): Promise<Branch[]> {
		const result: Branch[] = [];
		for (const branch of await isogit.listBranches({ fs, dir: this.dir })) {
			const upstream = await this.upstreamOf(branch);
			if (upstream && `${upstream.remote}/${upstream.name}` === upstreamBranch) {
				result.push({ name: branch, type: RefType.Head });
			}
		}
		return result;
	}

	async checkIgnore(filePaths: string[]): Promise<Set<string>> {
		const ignored = new Set<string>();
		for (const filePath of filePaths) {
			const filepath = this.relative(filePath);
			if (filepath && !filepath.startsWith('..') && await isogit.isIgnored({ fs, dir: this.dir, filepath }).catch(() => false)) {
				ignored.add(filePath);
			}
		}
		return ignored;
	}

	async getStashes(): Promise<Stash[]> {
		return [];
	}

	async getWorktrees(): Promise<Worktree[]> {
		return [];
	}

	async getRemotes(): Promise<Remote[]> {
		const remotes = await isogit.listRemotes({ fs, dir: this.dir }).catch(() => [] as { remote: string; url: string }[]);
		return remotes.map(({ remote, url }) => ({ name: remote, fetchUrl: url, pushUrl: url, isReadOnly: false }));
	}

	async getDefaultBranch(remoteName: string): Promise<Branch> {
		const target = await isogit.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/${remoteName}/HEAD`, depth: 2 }).catch(() => undefined);
		if (!target || !target.startsWith('refs/remotes/')) {
			throw new Error('No default branch');
		}
		return this.getBranch(target.substring('refs/remotes/'.length));
	}

	stripCommitMessageComments(message: string): string {
		let normalizedMessage = message.replace(/\r\n/g, '\n');
		normalizedMessage = normalizedMessage.split('\n').filter(line => !line.startsWith('#')).join('\n');
		return normalizedMessage.replace(/^\s+|\s+$/g, '');
	}

	async getSquashMessage(): Promise<string | undefined> {
		return undefined;
	}

	async getMergeMessage(): Promise<string | undefined> {
		return undefined;
	}

	async getCommitTemplate(): Promise<string> {
		return '';
	}

	async getSubmodules(): Promise<Submodule[]> {
		return [];
	}

	// #endregion
}
