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
			Binds: [`${volumeName(teamId)}:${WORKSPACE_DIR}`],
			// Make host.docker.internal resolve on plain Linux too (Docker Desktop
			// provides it anyway) — CLI executors use it to reach a host-side Ollama.
			ExtraHosts: ['host.docker.internal:host-gateway']
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
	opts?: {
		cwd?: string;
		timeoutMs?: number;
		maxOutputBytes?: number;
		/**
		 * Environment for THIS exec only (KEY=VALUE). The container itself always
		 * keeps an empty Env — this is how CLI executors receive credentials
		 * without them ever landing in the container config (issue #12).
		 */
		env?: string[];
		/** Called for every complete stdout line as it arrives — lets CLI
		 *  executors stream JSONL progress into work logs during long runs. */
		onStdoutLine?: (line: string) => void;
	}
): Promise<ExecResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
	const maxBytes = opts?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const started = Date.now();

	const container = client().getContainer(handle.containerId);
	const exec = await container.exec({
		Cmd: ['timeout', '-k', '5', String(Math.ceil(timeoutMs / 1000)), ...cmd],
		WorkingDir: opts?.cwd ?? handle.repoDir,
		Env: opts?.env,
		AttachStdout: true,
		AttachStderr: true
	});

	const stream = await exec.start({ hijack: true });

	const out = new CappedBuffer(maxBytes);
	const err = new CappedBuffer(maxBytes);
	const lines = opts?.onStdoutLine ? new LineSplitter(opts.onStdoutLine) : null;
	const outSink = sink(out, lines);
	const errSink = sink(err);
	container.modem.demuxStream(stream, outSink, errSink);

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

	lines?.flush();

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

/**
 * Write a file inside the workspace, creating parent directories. Uses the
 * Docker archive API (a minimal in-memory tar) rather than exec-with-stdin —
 * EOF over a hijacked exec stream is unreliable, the archive API is not.
 */
export async function writeFileInWorkspace(
	handle: WorkspaceHandle,
	path: string,
	content: string
): Promise<void> {
	const lastSlash = path.lastIndexOf('/');
	const dir = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
	const name = path.slice(lastSlash + 1);
	if (!name) throw new Error(`Invalid file path: ${path}`);

	const mkdir = await execInWorkspace(handle, ['mkdir', '-p', dir], { timeoutMs: 30_000 });
	if (mkdir.exitCode !== 0)
		throw new Error(`Failed to create ${dir}: ${mkdir.stderr || `exit ${mkdir.exitCode}`}`);

	await client()
		.getContainer(handle.containerId)
		.putArchive(singleFileTar(name, Buffer.from(content, 'utf8')), { path: dir });
}

/** Build a tar archive holding one file — enough for putArchive. */
function singleFileTar(name: string, content: Buffer): Buffer {
	if (Buffer.byteLength(name) > 100) throw new Error(`File name too long for tar: ${name}`);
	const header = Buffer.alloc(512);
	header.write(name, 0, 'utf8');
	header.write('0000644\0', 100); // mode
	header.write('0000000\0', 108); // uid
	header.write('0000000\0', 116); // gid
	header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
	header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
	header.write('        ', 148); // checksum placeholder (spaces while summing)
	header.write('0', 156); // typeflag: regular file
	header.write('ustar\0', 257);
	header.write('00', 263);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);

	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
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

/** Re-assembles complete text lines from arbitrary stream chunks. */
class LineSplitter {
	private pending = '';

	constructor(private readonly onLine: (line: string) => void) {}

	push(chunk: Buffer) {
		this.pending += chunk.toString('utf8');
		let idx: number;
		while ((idx = this.pending.indexOf('\n')) >= 0) {
			const line = this.pending.slice(0, idx).replace(/\r$/, '');
			this.pending = this.pending.slice(idx + 1);
			if (line.trim()) this.emit(line);
		}
		// A pathological line with no newline in sight must not grow unboundedly.
		if (this.pending.length > 1024 * 1024) {
			this.emit(this.pending);
			this.pending = '';
		}
	}

	flush() {
		if (this.pending.trim()) this.emit(this.pending);
		this.pending = '';
	}

	private emit(line: string) {
		try {
			this.onLine(line);
		} catch {
			// A log-callback failure must never kill the exec stream.
		}
	}
}

/** Minimal writable-stream shim feeding a CappedBuffer (for demuxStream). */
function sink(buffer: CappedBuffer, lines?: LineSplitter | null) {
	return {
		write(chunk: Buffer) {
			const copy = Buffer.from(chunk);
			buffer.push(copy);
			lines?.push(copy);
			return true;
		}
	} as NodeJS.WritableStream;
}
