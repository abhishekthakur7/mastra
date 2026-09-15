import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import {
  type ClaudeAuthEvidence,
  type ClaudeLaunchProfile,
  validateClaudeLaunchProfileEnvironment,
  validateClaudeLaunchProfilePaths,
  type ClaudeVersionEvidence,
  sanitizeClaudeAuthStatus,
  sanitizeClaudeVersionStatus,
} from './claude-launch-profile';

export const CLAUDE_PROBE_COMMANDS = {
  version: ['--version'],
  // The installed Claude release supports --json (and currently defaults to
  // it). Keep it explicit so a human-readable format can never be mistaken for
  // status evidence if the vendor changes the default.
  'auth-status': ['auth', 'status', '--json'],
} as const;

export type ClaudeProbeCommand = keyof typeof CLAUDE_PROBE_COMMANDS;

export type ClaudeProbeFailure =
  | 'aborted'
  | 'timeout'
  | 'stdout-too-large'
  | 'stderr-too-large'
  | 'malformed-output'
  | 'nonzero-exit'
  | 'spawn-failed';

export type ClaudeProbeChild = Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'once' | 'removeListener' | 'kill'> & {
  /** PID of the detached, scope-owned process-group leader on POSIX. */
  readonly pid?: number;
  readonly processGroupId?: number;
};

export type ClaudeChildRunnerOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
};

/** Injectable only so tests can use a harmless local fixture executable. */
export type ClaudeChildRunner = (
  executable: string,
  args: readonly string[],
  options: ClaudeChildRunnerOptions,
) => ClaudeProbeChild;

type ClaudeExecutableEvidenceBase = {
  executable: string;
  realpath: string;
  basename: string;
  uid: number;
  dev: number;
  ino: number;
  mode: number;
};

/** Caller-pinned evidence for the real Claude executable. */
export type ClaudeExecutableEvidence = ClaudeExecutableEvidenceBase & {
  kind: 'claude';
};

/** Explicitly test-only evidence for an injected harmless fixture runner. */
export type ClaudeFixtureExecutableEvidence = ClaudeExecutableEvidenceBase & {
  kind: 'fixture';
};

export type ClaudePinnedExecutableEvidence = ClaudeExecutableEvidence | ClaudeFixtureExecutableEvidence;

export type ClaudeMetadataProbeRequest = {
  profile: ClaudeLaunchProfile;
  command: ClaudeProbeCommand;
  executable?: string;
  executableEvidence?: ClaudePinnedExecutableEvidence;
  runner?: ClaudeChildRunner;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Require and verify the exact config produced by materialization. */
  allowMaterializedConfig?: boolean;
};

export type ClaudeMetadataProbeResult = {
  command: ClaudeProbeCommand;
  ok: boolean;
  exitCode: number | null;
  failure?: ClaudeProbeFailure;
  timedOut: boolean;
  aborted: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  versionEvidence?: ClaudeVersionEvidence;
  authEvidence?: ClaudeAuthEvidence;
};

export class ClaudeProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeProbeError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CHILD_KILL_GRACE_MS = 100;
const PINNED_EVIDENCE_KEYS = new Set(['kind', 'executable', 'realpath', 'basename', 'uid', 'dev', 'ino', 'mode']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ClaudeProbeError(`${label} must be a non-empty string`);
  }
}

function boundedOption(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ClaudeProbeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertSafeLocalPath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!isAbsolute(value)) throw new ClaudeProbeError(`${label} must be an absolute caller-owned path`);
  if (value.split(/[\\/]/).some(segment => segment === '..')) {
    throw new ClaudeProbeError(`${label} must not contain traversal segments`);
  }
}

async function validateProfile(profile: ClaudeLaunchProfile, allowMaterializedConfig: boolean): Promise<Record<string, string>> {
  if (!isRecord(profile)) throw new ClaudeProbeError('profile is required');
  assertSafeLocalPath(profile.cwd, 'profile.cwd');
  try {
    await validateClaudeLaunchProfilePaths(profile, { allowMaterializedConfig });
    return validateClaudeLaunchProfileEnvironment(profile.env, { cwd: profile.cwd, tmpDir: profile.tmpDir });
  } catch (error) {
    if (error instanceof ClaudeProbeError) throw error;
    throw new ClaudeProbeError(error instanceof Error ? error.message : 'profile validation failed');
  }
}

function validateExecutable(value: unknown): string {
  assertNonEmptyString(value, 'executable');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) throw new ClaudeProbeError('executable must be local');
  if (!isAbsolute(value)) throw new ClaudeProbeError('executable must be an absolute canonical path');
  if (value.split(/[\\/]/).some(segment => segment === '..')) {
    throw new ClaudeProbeError('executable must not contain traversal segments');
  }
  if (resolve(value) !== value) throw new ClaudeProbeError('executable must be an absolute canonical path');
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isExpectedClaudeBasename(value: string): boolean {
  const normalized = process.platform === 'win32' ? value.toLowerCase() : value;
  return normalized === 'claude' || normalized === 'claude.exe';
}

function assertSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ClaudeProbeError(`${label} must be a safe integer`);
  return value as number;
}

function parseExecutableEvidence(value: unknown, executable: string): ClaudePinnedExecutableEvidence {
  if (!isRecord(value)) throw new ClaudeProbeError('executableEvidence is required');
  for (const key of Object.keys(value)) {
    if (!PINNED_EVIDENCE_KEYS.has(key)) throw new ClaudeProbeError(`executableEvidence contains an unknown key: ${key}`);
  }

  const kind = value.kind;
  if (kind !== 'claude' && kind !== 'fixture') throw new ClaudeProbeError('executableEvidence kind is invalid');
  if (value.executable !== executable) throw new ClaudeProbeError('executableEvidence is not pinned to executable');
  assertSafeLocalPath(value.executable, 'executableEvidence.executable');
  assertSafeLocalPath(value.realpath, 'executableEvidence.realpath');
  if (!samePath(value.executable, value.realpath)) throw new ClaudeProbeError('executableEvidence must use a canonical executable path');
  assertNonEmptyString(value.basename, 'executableEvidence.basename');
  if (value.basename !== basename(value.realpath)) throw new ClaudeProbeError('executableEvidence basename does not match its path');
  if (kind === 'claude' && !isExpectedClaudeBasename(value.basename)) {
    throw new ClaudeProbeError('executable must identify the Claude executable');
  }

  const uid = assertSafeInteger(value.uid, 'executableEvidence.uid');
  const callerUid = process.getuid?.();
  if (callerUid === undefined || !Number.isSafeInteger(callerUid) || uid !== callerUid) {
    throw new ClaudeProbeError('executable must be owned by the caller');
  }
  return {
    kind,
    executable: value.executable,
    realpath: value.realpath,
    basename: value.basename,
    uid,
    dev: assertSafeInteger(value.dev, 'executableEvidence.dev'),
    ino: assertSafeInteger(value.ino, 'executableEvidence.ino'),
    mode: assertSafeInteger(value.mode, 'executableEvidence.mode'),
  };
}

type ExecutableSnapshot = Omit<ClaudeExecutableEvidenceBase, 'executable' | 'realpath' | 'basename'> & {
  realpath: string;
  basename: string;
};

async function inspectExecutable(executable: string, kind: ClaudePinnedExecutableEvidence['kind']): Promise<ExecutableSnapshot> {
  let canonicalPath: string;
  let executableStat: Awaited<ReturnType<typeof lstat>>;
  try {
    const requestedStat = await lstat(executable);
    if (requestedStat.isSymbolicLink()) throw new ClaudeProbeError('executable must not be a symlink');
    canonicalPath = resolve(await realpath(executable));
    if (!samePath(canonicalPath, executable)) throw new ClaudeProbeError('executable must be an absolute canonical path');
    executableStat = await lstat(canonicalPath);
  } catch (error) {
    if (error instanceof ClaudeProbeError) throw error;
    throw new ClaudeProbeError('executable could not be canonicalized or stat-ed safely');
  }

  if (executableStat.isSymbolicLink()) throw new ClaudeProbeError('executable must not be a symlink');
  if (!executableStat.isFile()) throw new ClaudeProbeError('executable must be a regular file');
  const mode = executableStat.mode;
  if (process.platform !== 'win32' && (mode & 0o111) === 0) throw new ClaudeProbeError('executable must be executable');
  if (process.platform !== 'win32' && (mode & 0o022) !== 0) throw new ClaudeProbeError('executable must not be group/world-writable');

  const uid = executableStat.uid;
  const callerUid = process.getuid?.();
  if (callerUid === undefined || !Number.isSafeInteger(callerUid) || !Number.isSafeInteger(uid)) {
    throw new ClaudeProbeError('executable ownership UID evidence is unavailable');
  }
  if (uid !== callerUid) {
    throw new ClaudeProbeError('executable must be owned by the caller');
  }
  const dev = executableStat.dev;
  const ino = executableStat.ino;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new ClaudeProbeError('executable device and inode identity is unavailable');
  }

  const executableBasename = basename(canonicalPath);
  if (kind === 'claude' && !isExpectedClaudeBasename(executableBasename)) {
    throw new ClaudeProbeError('executable must identify the Claude executable');
  }
  return { realpath: canonicalPath, basename: executableBasename, uid, dev, ino, mode };
}

function sameExecutableIdentity(left: ClaudePinnedExecutableEvidence, right: ExecutableSnapshot): boolean {
  return (
    samePath(left.realpath, right.realpath) &&
    left.basename === right.basename &&
    left.uid === right.uid &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

async function validateExecutableEvidence(
  executable: string,
  evidence: unknown,
  expectedKind: ClaudePinnedExecutableEvidence['kind'],
): Promise<string> {
  const pinned = parseExecutableEvidence(evidence, executable);
  if (pinned.kind !== expectedKind) throw new ClaudeProbeError(`executableEvidence kind must be ${expectedKind}`);
  const current = await inspectExecutable(executable, expectedKind);
  if (!sameExecutableIdentity(pinned, current)) {
    throw new ClaudeProbeError('executable identity changed since it was pinned');
  }
  return current.realpath;
}

export async function captureClaudeExecutableEvidence(executable: string): Promise<ClaudeExecutableEvidence> {
  const validated = validateExecutable(executable);
  const snapshot = await inspectExecutable(validated, 'claude');
  return { kind: 'claude', executable: validated, ...snapshot };
}

export async function captureClaudeFixtureExecutableEvidence(executable: string): Promise<ClaudeFixtureExecutableEvidence> {
  const validated = validateExecutable(executable);
  const snapshot = await inspectExecutable(validated, 'fixture');
  return { kind: 'fixture', executable: validated, ...snapshot };
}

function validateCommand(value: unknown): asserts value is ClaudeProbeCommand {
  if (value !== 'version' && value !== 'auth-status') throw new ClaudeProbeError('command is not allowlisted');
}

function defaultChildRunner(executable: string, args: readonly string[], options: ClaudeChildRunnerOptions): ClaudeProbeChild {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    signal: options.signal,
  });
  return Object.assign(child, { processGroupId: process.platform === 'win32' ? undefined : child.pid });
}

type CollectedChild = {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  failure?: Extract<ClaudeProbeFailure, 'aborted' | 'timeout' | 'stdout-too-large' | 'stderr-too-large' | 'spawn-failed'>;
};

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

function isOwnedChildRunning(child: ClaudeProbeChild): boolean {
  const processGroupId = child.processGroupId;
  if (process.platform !== 'win32' && processGroupId !== undefined) {
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
  const candidate = child as ChildProcess;
  return candidate.exitCode === null && candidate.signalCode === null;
}

function signalOwnedChild(child: ClaudeProbeChild, signal: NodeJS.Signals): boolean {
  const processGroupId = child.processGroupId;
  if (process.platform !== 'win32' && processGroupId !== undefined) {
    if (!isOwnedChildRunning(child)) return false;
    let delivered = false;
    // Notify the leader through the injected handle as well as the owned
    // group. The handle keeps test/diagnostic runners observable; the group
    // signal is the security boundary that reaches every descendant.
    try {
      delivered = child.kill(signal);
    } catch {
      // The leader may have exited while descendants are still alive.
    }
    try {
      process.kill(-processGroupId, signal);
      delivered = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return delivered;
      throw error;
    }
    return delivered;
  }
  try {
    return child.kill(signal);
  } catch {
    // The child may already have exited. There is no PID fallback.
    return false;
  }
}

function waitForOwnedChildTermination(child: ClaudeProbeChild, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = (): void => {
      if (!isOwnedChildRunning(child) || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, Math.min(10, Math.max(1, deadline - Date.now())));
    };
    check();
  });
}

function collectChild(
  child: ClaudeProbeChild,
  controller: AbortController,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Promise<CollectedChild> {
  return new Promise(resolve => {
    let settled = false;
    let forcedFailure: CollectedChild['failure'];
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, failure = forcedFailure): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
      // `stdout` and `stderr` are deliberately local-only and are cleared after this handoff.
      const collected = { stdout, stderr, stdoutBytes, stderrBytes, exitCode, ...(failure ? { failure } : {}) };
      stdout = '';
      stderr = '';
      resolve(collected);
    };

    const stop = (failure: NonNullable<CollectedChild['failure']>): void => {
      if (settled || forcedFailure) return;
      forcedFailure = failure;
      controller.abort();
      signalOwnedChild(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (settled) return;
        signalOwnedChild(child, 'SIGKILL');
        forceKillTimer = setTimeout(() => {
          void waitForOwnedChildTermination(child, CHILD_KILL_GRACE_MS).then(() => finish(null, forcedFailure));
        }, CHILD_KILL_GRACE_MS);
      }, CHILD_KILL_GRACE_MS);
    };

    const onCallerAbort = (): void => stop('aborted');
    const onError = (): void => {
      if (forcedFailure) return;
      finish(null, 'spawn-failed');
    };
    const onClose = (code: number | null): void => {
      if (forcedFailure) {
        // A process-group leader can close while descendants remain alive.
        // Defer result handoff until the bounded group cleanup has run.
        if (!isOwnedChildRunning(child)) finish(code, forcedFailure);
        return;
      }
      // A successful leader exit does not imply that a detached descendant
      // exited.  Reap the entire scope-owned process group before handing
      // metadata back to the caller, just as we do for timeout/abort paths.
      // This avoids leaving a successful `--version`/`auth status` probe's
      // descendants behind.
      if (isOwnedChildRunning(child)) {
        signalOwnedChild(child, 'SIGTERM');
        void waitForOwnedChildTermination(child, CHILD_KILL_GRACE_MS).then(() => {
          if (isOwnedChildRunning(child)) signalOwnedChild(child, 'SIGKILL');
          return waitForOwnedChildTermination(child, CHILD_KILL_GRACE_MS);
        }).then(() => finish(code));
        return;
      }
      finish(code);
    };

    const append = (which: 'stdout' | 'stderr', chunk: unknown): void => {
      if (settled || forcedFailure) return;
      const text = chunkToString(chunk);
      const bytes = chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(text);
      if (which === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes > maxStdoutBytes) {
          stdout = '';
          stop('stdout-too-large');
          return;
        }
        stdout += text;
      } else {
        stderrBytes += bytes;
        if (stderrBytes > maxStderrBytes) {
          stderr = '';
          stop('stderr-too-large');
          return;
        }
        stderr += text;
      }
    };

    const onStdoutData = (chunk: unknown): void => append('stdout', chunk);
    const onStderrData = (chunk: unknown): void => append('stderr', chunk);
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.once('error', onError);
    child.once('close', onClose);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (callerSignal?.aborted) onCallerAbort();
  });
}

type NormalizedAuthStatus = {
  raw: Record<string, boolean | string>;
  malformed: boolean;
};

function parseAuthStatus(output: string): NormalizedAuthStatus {
  const text = output.trim();
  if (text.length === 0) return { raw: {}, malformed: true };

  // The supported `auth status --json` surface is the only trustworthy input.
  // Do not turn human-readable output into an authentication claim: vendor
  // wording is version-bound and cannot provide a bounded field projection.
  if (!text.startsWith('{')) return { raw: {}, malformed: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: {}, malformed: true };
  }
  if (!isRecord(parsed)) return { raw: {}, malformed: true };

  // Apply the same bounded vendor-shape validation used by the launch
  // profile. This accepts the current non-secret metadata fields, rejects
  // unknown/oversized fields, and returns only the three auth facts below.
  const sanitized = sanitizeClaudeAuthStatus(parsed, 0);
  if (sanitized.blocked && sanitized.blockedReason !== 'not-authenticated') {
    return { raw: {}, malformed: true };
  }
  if (sanitized.blockedReason === 'not-authenticated') {
    return { raw: { loggedIn: false, authMethod: 'none', apiProvider: 'unknown' }, malformed: false };
  }
  if (!sanitized.loggedIn) return { raw: {}, malformed: true };
  return {
    raw: {
      loggedIn: true,
      authMethod: sanitized.authMethod,
      apiProvider: sanitized.apiProvider,
    },
    malformed: false,
  };
}

function failureEvidence(command: ClaudeProbeCommand, exitCode: number | null): ClaudeVersionEvidence | ClaudeAuthEvidence {
  const code = exitCode ?? -1;
  return command === 'version' ? sanitizeClaudeVersionStatus({}, code) : sanitizeClaudeAuthStatus({}, code);
}

function makeResult(command: ClaudeProbeCommand, collected: CollectedChild): ClaudeMetadataProbeResult {
  const exitCode = collected.exitCode;
  const result: ClaudeMetadataProbeResult = {
    command,
    ok: false,
    exitCode,
    ...(collected.failure ? { failure: collected.failure } : {}),
    timedOut: collected.failure === 'timeout',
    aborted: collected.failure === 'aborted',
    stdoutBytes: collected.stdoutBytes,
    stderrBytes: collected.stderrBytes,
  };

  if (command === 'version') {
    const evidence = collected.failure
      ? (failureEvidence(command, exitCode) as ClaudeVersionEvidence)
      : sanitizeClaudeVersionStatus(collected.stdout, exitCode ?? -1);
    result.versionEvidence = evidence;
    if (!collected.failure && !evidence.available) result.failure = exitCode !== 0 ? 'nonzero-exit' : 'malformed-output';
    result.ok = !result.failure && evidence.available;
  } else {
    const nonzeroExit = exitCode !== 0;
    const parsed = collected.failure || nonzeroExit ? { raw: {}, malformed: false } : parseAuthStatus(collected.stdout);
    const malformed = !collected.failure && parsed.malformed;
    const evidence = collected.failure || nonzeroExit || malformed
      ? (failureEvidence(command, exitCode) as ClaudeAuthEvidence)
      : sanitizeClaudeAuthStatus(parsed.raw, exitCode ?? -1);
    result.authEvidence = evidence;
    if (!collected.failure && malformed) result.failure = 'malformed-output';
    else if (!collected.failure && nonzeroExit) result.failure = 'nonzero-exit';
    result.ok = !result.failure && evidence.loggedIn && evidence.authMethod === 'subscription' && evidence.apiProvider === 'firstParty';
  }

  return result;
}

/** Run one strictly allowlisted local Claude metadata command. */
export async function runClaudeMetadataProbe(request: ClaudeMetadataProbeRequest): Promise<ClaudeMetadataProbeResult> {
  if (!isRecord(request)) throw new ClaudeProbeError('probe request is required');
  validateCommand(request.command);
  const env = await validateProfile(request.profile, request.allowMaterializedConfig === true);
  const fixtureExecutable = request.runner !== undefined && request.executableEvidence?.kind === 'fixture'
    ? request.executableEvidence.executable
    : undefined;
  const executable = validateExecutable(request.executable ?? fixtureExecutable ?? request.profile.executable ?? 'claude');
  const isPinnedFixtureOverride = request.runner !== undefined && request.executableEvidence?.kind === 'fixture';
  if (request.profile.executable !== undefined && executable !== request.profile.executable && !isPinnedFixtureOverride) {
    throw new ClaudeProbeError('executable must match the profile executable pin');
  }
  const timeoutMs = boundedOption(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxStdoutBytes = boundedOption(request.maxStdoutBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'maxStdoutBytes');
  const maxStderrBytes = boundedOption(request.maxStderrBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'maxStderrBytes');

  const injectedRunner = request.runner !== undefined;
  const runner = request.runner ?? defaultChildRunner;
  let launchExecutable = executable;
  if (!injectedRunner) {
    if (request.executableEvidence === undefined) {
      throw new ClaudeProbeError('real Claude probes require caller-pinned executable evidence');
    }
    launchExecutable = await validateExecutableEvidence(executable, request.executableEvidence, 'claude');
  } else if (request.executableEvidence !== undefined) {
    launchExecutable = await validateExecutableEvidence(executable, request.executableEvidence, request.executableEvidence.kind);
  }

  if (request.signal?.aborted) {
    const result = makeResult(request.command, {
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: null,
      failure: 'aborted',
    });
    return result;
  }

  const controller = new AbortController();
  let child: ClaudeProbeChild;
  try {
    if (request.executableEvidence !== undefined) {
      const expectedKind = injectedRunner ? request.executableEvidence.kind : 'claude';
      launchExecutable = await validateExecutableEvidence(executable, request.executableEvidence, expectedKind);
    }
    const args = [...request.profile.argv, ...CLAUDE_PROBE_COMMANDS[request.command]];
    child = runner(launchExecutable, args, {
      cwd: request.profile.cwd,
      env,
      signal: controller.signal,
    });
  } catch {
    return makeResult(request.command, {
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: null,
      failure: 'spawn-failed',
    });
  }

  const collected = await collectChild(child, controller, request.signal, timeoutMs, maxStdoutBytes, maxStderrBytes);
  const result = makeResult(request.command, collected);
  // Drop transient raw child output before returning the sanitized result.
  collected.stdout = '';
  collected.stderr = '';
  return result;
}

export const runClaudeProbe = runClaudeMetadataProbe;
export const probeClaudeMetadata = runClaudeMetadataProbe;
