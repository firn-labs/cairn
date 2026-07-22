import { eq } from 'drizzle-orm';
import { db, projects } from './db';
import type { Project, Team } from './db/schema';
import { decryptSecret } from './secrets';

/**
 * Git hosting integration (GitHub, GitLab, Codeberg/Gitea — self-hosted
 * instances work too, the host is taken from the repo URL). Two concerns live
 * here: HTTP auth material for git itself (used by workspace/git.ts, injected
 * per-invocation and never stored anywhere agents can read), and the hosting
 * REST APIs (repo validation, pull requests).
 */

export type HostingProvider = Project['provider'];

export const PROVIDER_LABELS: Record<HostingProvider, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	codeberg: 'Codeberg / Gitea'
};

export interface RepoRef {
	host: string;
	/** May contain slashes (GitLab subgroups). */
	owner: string;
	repo: string;
}

/** A project plus its decrypted token — everything git/API calls need. */
export interface HostingRemote {
	project: Project;
	token: string;
}

/** The team's connected project with a ready-to-use token, or null. */
export function remoteForTeam(team: Team): HostingRemote | null {
	if (!team.projectId) return null;
	const project = db.select().from(projects).where(eq(projects.id, team.projectId)).get();
	if (!project) return null;
	return { project, token: decryptSecret(project.tokenCiphertext) };
}

export function parseRepoUrl(repoUrl: string): RepoRef {
	let url: URL;
	try {
		url = new URL(repoUrl.trim());
	} catch {
		throw new Error(`"${repoUrl}" is not a valid URL.`);
	}
	if (url.protocol !== 'https:')
		throw new Error('Only https:// repository URLs are supported (SSH remotes are not).');
	const segments = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
	if (segments.length < 2)
		throw new Error('The repository URL must look like https://host/owner/repo.');
	return {
		host: url.host,
		owner: segments.slice(0, -1).join('/'),
		repo: segments[segments.length - 1]
	};
}

export function cloneUrl(project: Project): string {
	const ref = parseRepoUrl(project.repoUrl);
	return `https://${ref.host}/${ref.owner}/${ref.repo}.git`;
}

/**
 * Value for git's `http.extraHeader` config: basic auth in the form each
 * hoster documents for token access over HTTPS.
 */
export function gitAuthHeader(remote: HostingRemote): string {
	const { provider } = remote.project;
	const credentials =
		provider === 'github'
			? `x-access-token:${remote.token}`
			: provider === 'gitlab'
				? `oauth2:${remote.token}`
				: `${remote.token}:`; // Gitea/Forgejo: token as username
	return `Authorization: Basic ${Buffer.from(credentials).toString('base64')}`;
}

function apiBase(provider: HostingProvider, host: string): string {
	if (provider === 'github')
		return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
	if (provider === 'gitlab') return `https://${host}/api/v4`;
	return `https://${host}/api/v1`;
}

function apiHeaders(provider: HostingProvider, token: string): Record<string, string> {
	if (provider === 'github')
		return {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		};
	if (provider === 'gitlab') return { 'PRIVATE-TOKEN': token };
	return { Authorization: `token ${token}` };
}

async function api(
	provider: HostingProvider,
	token: string,
	method: 'GET' | 'POST',
	url: string,
	body?: unknown
): Promise<{ status: number; json: Record<string, unknown> | Array<Record<string, unknown>> }> {
	const response = await fetch(url, {
		method,
		headers: {
			...apiHeaders(provider, token),
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: response.status, json };
}

function apiError(action: string, status: number, json: unknown): Error {
	const detail =
		json && typeof json === 'object'
			? String(
					(json as Record<string, unknown>).message ??
						(json as Record<string, unknown>).error ??
						''
				)
			: '';
	const hint =
		status === 401 || status === 403
			? ' — check the access token and its scopes'
			: status === 404
				? ' — repository not found, or the token cannot see it'
				: '';
	return new Error(`${action} failed (HTTP ${status}${hint}). ${detail}`.trim());
}

/**
 * Validate that the token can see the repository and detect its default
 * branch. Used when a project is created or its token is replaced.
 */
export async function inspectRepo(
	provider: HostingProvider,
	repoUrl: string,
	token: string
): Promise<{ defaultBranch: string }> {
	const ref = parseRepoUrl(repoUrl);
	const base = apiBase(provider, ref.host);
	const url =
		provider === 'gitlab'
			? `${base}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`
			: `${base}/repos/${ref.owner}/${ref.repo}`;

	const { status, json } = await api(provider, token, 'GET', url);
	if (status !== 200) throw apiError('Repository check', status, json);
	const defaultBranch = (json as Record<string, unknown>).default_branch;
	return { defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : 'main' };
}

/**
 * Open a pull request from `head` into the project's default branch, or
 * return the already-open PR for that branch pair. The PO reviews and merges
 * on the hosting site — Cairn never merges toward the default branch itself.
 */
export async function createPullRequest(
	remote: HostingRemote,
	opts: { head: string; title: string; body: string }
): Promise<{ url: string }> {
	const { project, token } = remote;
	const ref = parseRepoUrl(project.repoUrl);
	const base = apiBase(project.provider, ref.host);
	const target = project.defaultBranch;

	if (project.provider === 'gitlab') {
		const projectApi = `${base}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`;
		const created = await api(project.provider, token, 'POST', `${projectApi}/merge_requests`, {
			source_branch: opts.head,
			target_branch: target,
			title: opts.title,
			description: opts.body
		});
		if (created.status === 201)
			return { url: String((created.json as Record<string, unknown>).web_url) };
		if (created.status === 409) {
			const existing = await api(
				project.provider,
				token,
				'GET',
				`${projectApi}/merge_requests?state=opened&source_branch=${encodeURIComponent(opts.head)}`
			);
			const first = Array.isArray(existing.json) ? existing.json[0] : undefined;
			if (first?.web_url) return { url: String(first.web_url) };
		}
		throw apiError('Opening the merge request', created.status, created.json);
	}

	const repoApi = `${base}/repos/${ref.owner}/${ref.repo}`;
	const created = await api(project.provider, token, 'POST', `${repoApi}/pulls`, {
		head: opts.head,
		base: target,
		title: opts.title,
		body: opts.body
	});
	if (created.status === 201)
		return { url: String((created.json as Record<string, unknown>).html_url) };

	// GitHub answers 422, Gitea 409, when a PR for this branch pair exists.
	if (created.status === 422 || created.status === 409) {
		const listUrl =
			project.provider === 'github'
				? `${repoApi}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${opts.head}`)}`
				: `${repoApi}/pulls?state=open`;
		const existing = await api(project.provider, token, 'GET', listUrl);
		if (Array.isArray(existing.json)) {
			const match = existing.json.find((pr) => {
				const head = pr.head as Record<string, unknown> | undefined;
				return project.provider === 'github' || head?.ref === opts.head;
			});
			if (match?.html_url) return { url: String(match.html_url) };
		}
	}
	throw apiError('Opening the pull request', created.status, created.json);
}
