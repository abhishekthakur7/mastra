import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_GRACE_MS = 500;
const DEFAULT_FORCE_KILL_MS = 1_000;
const DEFAULT_CLOSER_TIMEOUT_MS = 2_000;

export type CleanupEvidence = {
  processes: Array<{ pid: number; exited: boolean; escalated: boolean }>;
  remainingPaths: string[];
  closeErrors: string[];
};

export class BoundedResourceCleanupError extends Error {
  readonly evidence: CleanupEvidence;

  constructor(evidence: CleanupEvidence) {
    super(`fixture cleanup incomplete: ${JSON.stringify(evidence)}`);
    this.name = 'BoundedResourceCleanupError';
    this.evidence = evidence;
  }
}

/**
 * Owns only resources created through this scope. In particular, there is no
 * public "track arbitrary path/pid" escape hatch: cleanup can only signal a
 * ChildProcess returned by spawn() and remove a directory returned by
 * createTempDirectory(). On POSIX, spawned children are detached leaders of
 * scope-owned process groups, so cleanup is bounded to those groups. A
 * descendant that deliberately calls setsid() (or otherwise escapes its
 * process group) is outside this fixture contract and is prohibited fixture
 * behavior; it is not cleaned up by a raw PID fallback.
 */
export class BoundedResourceScope {
  private readonly processes = new Map<number, TrackedProcess>();
  private readonly paths = new Set<string>();
  private readonly closers = new Set<() => Promise<void> | void>();
  private readonly graceMs: number;
  private readonly forceKillMs: number;
  private readonly closerTimeoutMs: number;
  private state: 'open' | 'cleaning' | 'sealed' = 'open';
  private cleanupPromise?: Promise<CleanupEvidence>;

  constructor(options: { graceMs?: number; forceKillMs?: number; closerTimeoutMs?: number } = {}) {
    this.graceMs = boundedTimeout(options.graceMs, DEFAULT_GRACE_MS);
    this.forceKillMs = boundedTimeout(options.forceKillMs, DEFAULT_FORCE_KILL_MS);
    this.closerTimeoutMs = boundedTimeout(options.closerTimeoutMs, DEFAULT_CLOSER_TIMEOUT_MS);
  }

  async createTempDirectory(prefix = 'mastra-subscription-runtime-'): Promise<string> {
    this.assertOpen();
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.paths.add(path);
    return path;
  }

  spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    this.assertOpen();
    const child = spawn(command, args, {
      ...options,
      // On POSIX, a detached child is the leader of a process group owned by
      // this scope. Cleanup can therefore terminate descendants without ever
      // deriving a group from a caller-supplied pid. Windows uses the direct
      // child fallback below because negative process-group ids are unsupported.
      detached: process.platform !== 'win32',
      stdio: options.stdio ?? 'ignore',
    });
    if (child.pid !== undefined) {
      this.processes.set(child.pid, {
        child,
        processGroupId: process.platform === 'win32' ? undefined : child.pid,
      });
    }
    return child;
  }

  trackCloser(close: () => Promise<void> | void): void {
    this.assertOpen();
    this.closers.add(close);
  }

  cleanup(): Promise<CleanupEvidence> {
    if (!this.cleanupPromise) {
      this.state = 'cleaning';
      this.cleanupPromise = this.performCleanup().finally(() => {
        this.state = 'sealed';
      });
    }
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<CleanupEvidence> {
    const closeErrors: string[] = [];

    // Close in reverse registration order so a later-created server can stop
    // accepting work before an earlier dependency is disposed.
    for (const close of [...this.closers].reverse()) {
      try {
        await withTimeout(Promise.resolve(close()), this.closerTimeoutMs, 'resource closer timed out');
      } catch (error) {
        closeErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const processEvidence: CleanupEvidence['processes'] = [];
    for (const [pid, tracked] of this.processes) {
      let escalated = false;
      try {
        if (isTrackedProcessRunning(tracked)) {
          signalTrackedProcess(tracked, 'SIGTERM');
          await waitForTermination(tracked, this.graceMs);
        }
        if (isTrackedProcessRunning(tracked)) {
          escalated = true;
          signalTrackedProcess(tracked, 'SIGKILL');
          await waitForTermination(tracked, this.forceKillMs);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') closeErrors.push(error instanceof Error ? error.message : String(error));
      }
      processEvidence.push({ pid, exited: !isTrackedProcessRunning(tracked), escalated });
    }

    for (const path of this.paths) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        closeErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const remainingPaths: string[] = [];
    for (const path of this.paths) {
      try {
        await access(path);
        remainingPaths.push(path);
      } catch {
        // The scope-owned path was removed.
      }
    }

    const evidence = { processes: processEvidence, remainingPaths, closeErrors };
    if (processEvidence.some(process => !process.exited) || remainingPaths.length > 0 || closeErrors.length > 0) {
      throw new BoundedResourceCleanupError(evidence);
    }
    return evidence;
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new Error('resource scope is sealed');
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 30_000) {
    throw new Error('resource timeout must be an integer between 1 and 30000');
  }
  return value;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

type TrackedProcess = {
  readonly child: ChildProcess;
  readonly processGroupId?: number;
};

function isTrackedProcessRunning(tracked: TrackedProcess): boolean {
  if (tracked.processGroupId !== undefined) return isProcessGroupRunning(tracked.processGroupId);
  return isRunning(tracked.child);
}

function signalTrackedProcess(tracked: TrackedProcess, signal: NodeJS.Signals): void {
  if (tracked.processGroupId !== undefined) {
    if (!isProcessGroupRunning(tracked.processGroupId)) return;
    try {
      process.kill(-tracked.processGroupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }

  if (!isRunning(tracked.child)) return;
  if (!tracked.child.kill(signal) && isRunning(tracked.child)) {
    throw new Error(`unable to signal child process ${tracked.child.pid ?? 'unknown'}`);
  }
}

async function waitForTermination(tracked: TrackedProcess, timeoutMs: number): Promise<void> {
  if (!isTrackedProcessRunning(tracked)) return;
  if (tracked.processGroupId === undefined) {
    await waitForExit(tracked.child, timeoutMs);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (isTrackedProcessRunning(tracked) && Date.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return;
  await new Promise<void>(resolve => {
    // This timer is the awaited safety deadline; it must keep the process
    // alive when a test double has no other event-loop handles.
    const timeout = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function isProcessGroupRunning(processGroupId: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    // Process-group polling is part of awaited bounded cleanup, so this
    // deadline intentionally remains referenced.
    setTimeout(resolve, timeoutMs);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        // A closer may never settle; keep the bounded fallback alive until it
        // rejects the cleanup race.
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
