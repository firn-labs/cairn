import Docker from 'dockerode';
import { and, eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, sprints, workRuns, workItemRuns } from '../db';

/**
 * All Docker access goes through this module — nothing else in the app may
 * talk to the Docker daemon. Containers and volumes carry `cairn.*` labels;
 * the labels (not the DB) are the source of truth for what exists, which is
 * what makes startup reconciliation possible after a crash.
 */

const MANAGED_LABEL = 'cairn.managed';
const TEAM_LABEL = 'cairn.team';
const SPRINT_LABEL = 'cairn.sprint';

/** Where the per-team volume is mounted inside the workspace container. */
const WORKSPACE_DIR = '/workspace';
export const REPO_DIR = '/workspace/repo';

const DEFAULT_IMAGE = 'node:24-bookworm'; // full image: ships git, unlike -slim
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface WorkspaceHandle {
	containerId: string;
	teamId: string;
	sprintId: string;
	repoDir: string;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

// dockerode picks the right default endpoint per platform (named pipe on
// Windows, /var/run/docker.sock elsewhere) and honors DOCKER_HOST itself.
let docker: Docker | null = null;
function client(): Docker {
	if (!docker) docker = new Docker();
	return docker;
}

let availabilityCache: { at: number; available: boolean } | null = null;

/** Ping the daemon, with a short timeout; result cached for 10 s. */
export async function isDockerAvailable(): Promise<boolean> {
	if (availabilityCache && Date.now() - availabilityCache.at < 10_000)
		return availabilityCache.available;
	const available = await Promise.race([
		client()
			.ping()
			.then(() => true)
			.catch(() => false),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800))
	]);
	availabilityCache = { at: Date.now(), available };
	return available;
}

function volumeName(teamId: string): string {
	return `cairn-team-${teamId}`;
}

async function ensureImage(image: string, log?: (msg: string) => void): Promise<void> {
	try {
		await client().getImage(image).inspect();
		return;
	} catch {
		// not present locally — pull
	}
	log?.(`Pulling workspace image ${image} — this can take a few minutes on first run…`);
	const stream = await client().pull(image);
	await new Promise<void>((resolve, reject) => {
		client().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
	});
	log?.(`Workspace image ${image} ready.`);
}

/** Find the workspace container for a sprint (running or stopped), by label. */
export async function findWorkspace(sprintId: string): Promise<WorkspaceHandle | null> {
	const containers = await client().listContainers({
		all: true,
		filters: { label: [`${SPRINT_LABEL}=${sprintId}`] }
	});
	const info = containers[0];
	if (!info) return null;
	if (info.State !== 'running') await client().getContainer(info.Id).start();
	return {
		containerId: info.Id,
		teamId: info.Labels[TEAM_LABEL] ?? '',
		sprintId,
		repoDir: REPO_DIR
	};
}

/**
 * Start a fresh workspace container for a sprint. The per-team volume is
 * created on first use and survives sprints, so the git repo persists.
 * The container gets NO environment from the app — API keys and app config
 * must never leak into workspaces.
 */
export async function startWorkspace(
	teamId: string,
	sprintId: string,
	log?: (msg: string) => void
): Promise<WorkspaceHandle> {
	const image = env.WORKSPACE_IMAGE || DEFAULT_IMAGE;
	await ensureImage(image, log);

	await client().createVolume({
		Name: volumeName(teamId),
		Labels: { [MANAGED_LABEL]: 'true', [TEAM_LABEL]: teamId }
	});

	const container = await client().createContainer({
		name: `cairn-ws-${sprintId.slice(0, 8)}`,
		Image: image,
		Cmd: ['sleep', 'infinity'],
		WorkingDir: WORKSPACE_DIR,
		Env: [],
		Labels: {
			[MANAGED_LABEL]: 'true',
			[TEAM_LABEL]: teamId,
			[SPRINT_LABEL]: sprintId
		},
		HostConfig: {
			Init: true,
			Memory: 2 * 1024 * 1024 * 1024,
			NanoCpus: 2_000_000_000,
			PidsLimit: 256,
			NetworkMode: env.WORKSPACE_NETWORK === 'none' ? 'none' : 'bridge',
			Binds: [`${volumeName(teamId)}:${WORKSPACE_DIR}`]
		}
	});
	await container.start();
	log?.('Workspace container started.');
	return { containerId: container.id, teamId, sprintId, repoDir: REPO_DIR };
}

/**
 * Run a command in the workspace and capture its output. Timeouts are enforced
 * twice: coreutils `timeout` inside the container (the only way to actually
 * kill the process — dockerode cannot kill an exec) plus a client-side race
 * that abandons the stream. Output is capped, keeping head and tail.
 */
export async function execInWorkspace(
	handle: WorkspaceHandle,
	cmd: string[],
	opts?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; stdin?: string }
): Promise<ExecResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
	const maxBytes = opts?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const started = Date.now();

	const container = client().getContainer(handle.containerId);
	const exec = await container.exec({
		Cmd: ['timeout', '-k', '5', String(Math.ceil(timeoutMs / 1000)), ...cmd],
		WorkingDir: opts?.cwd ?? handle.repoDir,
		AttachStdout: true,
		AttachStderr: true,
		AttachStdin: opts?.stdin !== undefined
	});

	const stream = await exec.start({ hijack: true, stdin: opts?.stdin !== undefined });

	const out = new CappedBuffer(maxBytes);
	const err = new CappedBuffer(maxBytes);
	const outSink = sink(out);
	const errSink = sink(err);
	container.modem.demuxStream(stream, outSink, errSink);

	if (opts?.stdin !== undefined) {
		stream.write(opts.stdin);
		// Half-close so the process sees EOF on stdin.
		(stream as unknown as { end: () => void }).end();
	}

	let timedOut = false;
	await Promise.race([
		new Promise<void>((resolve) => {
			stream.on('end', resolve);
			stream.on('close', resolve);
			stream.on('error', resolve);
		}),
		new Promise<void>((resolve) =>
			setTimeout(() => {
				timedOut = true;
				stream.destroy();
				resolve();
			}, timeoutMs + 10_000)
		)
	]);

	let exitCode = 124;
	if (!timedOut) {
		const inspect = await exec.inspect();
		exitCode = inspect.ExitCode ?? 124;
	}

	return {
		exitCode,
		stdout: out.toString(),
		stderr: err.toString(),
		truncated: out.truncated || err.truncated,
		durationMs: Date.now() - started
	};
}

/** Write a file inside the workspace, creating parent directories. Content is
 *  piped via stdin, so no shell-escaping of the content is needed. */
export async function writeFileInWorkspace(
	handle: WorkspaceHandle,
	path: string,
	content: string
): Promise<void> {
	const result = await execInWorkspace(
		handle,
		['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', '_', path],
		{ stdin: content, timeoutMs: 30_000 }
	);
	if (result.exitCode !== 0)
		throw new Error(`Failed to write ${path}: ${result.stderr || `exit ${result.exitCode}`}`);
}

/** Stop and remove the workspace container for a sprint (best-effort). */
export async function destroyWorkspace(sprintId: string): Promise<void> {
	try {
		const containers = await client().listContainers({
			all: true,
			filters: { label: [`${SPRINT_LABEL}=${sprintId}`] }
		});
		for (const info of containers) {
			const container = client().getContainer(info.Id);
			await container.stop({ t: 5 }).catch(() => {});
			await container.remove({ force: true }).catch(() => {});
		}
	} catch {
		// Docker unavailable — nothing to clean up right now.
	}
}

/**
 * Startup sweep. Background jobs are bare promises and die with the process,
 * so after a restart: (1) any `running` work run in the DB is a lie — mark it
 * failed; (2) any managed container whose sprint is no longer active is an
 * orphan — remove it. Containers of still-active sprints are kept, so a new
 * "start work" click reuses them.
 */
export async function reconcileWorkspaces(): Promise<void> {
	const interrupted = db.select().from(workRuns).where(eq(workRuns.status, 'running')).all();
	for (const run of interrupted) {
		db.update(workRuns)
			.set({ status: 'failed', error: 'Interrupted by app restart', finishedAt: new Date() })
			.where(eq(workRuns.id, run.id))
			.run();
		db.update(workItemRuns)
			.set({ status: 'failed', error: 'Interrupted by app restart', finishedAt: new Date() })
			.where(and(eq(workItemRuns.workRunId, run.id), eq(workItemRuns.status, 'running')))
			.run();
		db.update(workItemRuns)
			.set({ status: 'skipped', finishedAt: new Date() })
			.where(and(eq(workItemRuns.workRunId, run.id), eq(workItemRuns.status, 'pending')))
			.run();
	}

	if (!(await isDockerAvailable())) return;
	try {
		const containers = await client().listContainers({
			all: true,
			filters: { label: [`${MANAGED_LABEL}=true`] }
		});
		for (const info of containers) {
			const sprintId = info.Labels[SPRINT_LABEL];
			const sprint = sprintId
				? db.select().from(sprints).where(eq(sprints.id, sprintId)).get()
				: undefined;
			if (!sprint || sprint.status !== 'active') {
				const container = client().getContainer(info.Id);
				await container.stop({ t: 5 }).catch(() => {});
				await container.remove({ force: true }).catch(() => {});
			}
		}
	} catch (err) {
		console.error('Workspace reconciliation failed:', err);
	}
}

class CappedBuffer {
	private head: Buffer[] = [];
	private headBytes = 0;
	private tail: Buffer[] = [];
	private tailBytes = 0;
	truncated = false;

	constructor(private readonly maxBytes: number) {}

	private get headLimit() {
		return Math.floor(this.maxBytes * 0.75);
	}
	private get tailLimit() {
		return this.maxBytes - this.headLimit;
	}

	push(chunk: Buffer) {
		if (this.headBytes < this.headLimit) {
			this.head.push(chunk);
			this.headBytes += chunk.length;
			return;
		}
		this.truncated = true;
		this.tail.push(chunk);
		this.tailBytes += chunk.length;
		while (this.tailBytes > this.tailLimit && this.tail.length > 1) {
			const dropped = this.tail.shift()!;
			this.tailBytes -= dropped.length;
		}
	}

	toString(): string {
		const head = Buffer.concat(this.head).toString('utf8');
		if (!this.truncated) return head;
		const tail = Buffer.concat(this.tail).toString('utf8');
		return `${head}\n…[output truncated]…\n${tail}`;
	}
}

/** Minimal writable-stream shim feeding a CappedBuffer (for demuxStream). */
function sink(buffer: CappedBuffer) {
	return {
		write(chunk: Buffer) {
			buffer.push(Buffer.from(chunk));
			return true;
		}
	} as NodeJS.WritableStream;
}
