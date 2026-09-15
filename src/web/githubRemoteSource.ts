/*---------------------------------------------------------------------------------------------
 *  GitHub repositories as a remote source for the built-in Clone picker (git-base API).
 *--------------------------------------------------------------------------------------------*/

import type { RemoteSource, RemoteSourceProvider } from '../typings/git-base';

interface GitHubRepository {
	readonly full_name: string;
	readonly clone_url: string;
	readonly description: string | null;
	readonly private: boolean;
	readonly fork: boolean;
}

const pageSize = 100;
const maxPages = 10;

/**
 * Lists the repositories the signed-in user owns or can access (collaborator, organization member).
 * The picker filters them locally as the user types.
 */
export function createGitHubRemoteSourceProvider(accessToken: () => Promise<string | undefined>): RemoteSourceProvider {
	let cache: { token: string; sources: Promise<RemoteSource[]> } | undefined;

	return {
		name: 'GitHub',
		icon: 'github',
		placeholder: 'Search your GitHub repositories',
		async getRemoteSources(): Promise<RemoteSource[]> {
			const token = await accessToken();
			if (!token) {
				return [];
			}
			if (cache?.token !== token) {
				cache = { token, sources: listAccessibleRepositories(token) };
				cache.sources.catch(() => (cache = undefined));
			}
			return cache.sources;
		},
	};
}

async function listAccessibleRepositories(accessToken: string): Promise<RemoteSource[]> {
	const sources: RemoteSource[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const response = await fetch(
			`https://api.github.com/user/repos?sort=updated&per_page=${pageSize}&page=${page}&affiliation=owner,collaborator,organization_member`,
			{ headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}` } }
		);
		if (!response.ok) {
			throw new Error(`Could not load your GitHub repositories: HTTP ${response.status}`);
		}
		const repositories = (await response.json()) as GitHubRepository[];
		sources.push(...repositories.map(repository => ({
			name: `$(${repository.private ? 'lock' : repository.fork ? 'repo-forked' : 'repo'}) ${repository.full_name}`,
			detail: repository.description ?? undefined,
			url: repository.clone_url,
		})));
		if (repositories.length < pageSize) {
			break;
		}
	}
	return sources;
}
