/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Uri } from 'vscode';
import type { Credentials, CredentialsProvider } from './api/git';

/**
 * Web replacement for the askpass bridge: there is no git process to prompt for credentials, so this
 * only keeps registered credentials providers for the isomorphic-git authentication callback.
 */
export class Askpass implements Disposable {

	private readonly providers = new Set<CredentialsProvider>();

	registerCredentialsProvider(provider: CredentialsProvider): Disposable {
		this.providers.add(provider);
		return new Disposable(() => this.providers.delete(provider));
	}

	async getCredentials(url: string): Promise<Credentials | undefined> {
		const uri = Uri.parse(url);
		for (const provider of this.providers) {
			const credentials = await provider.getCredentials(uri);
			if (credentials) {
				return credentials;
			}
		}
		return undefined;
	}

	dispose(): void {
		this.providers.clear();
	}
}
