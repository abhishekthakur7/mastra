import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  buildClaudeLaunchProfile,
  createClaudeOwnedWorkspace,
  materializeClaudeMcpConfig,
  type ClaudeFileSystem,
  type ClaudeLaunchProfile,
  type ClaudeOwnedWorkspace,
  validateClaudeLaunchProfilePaths,
} from './claude-launch-profile';
import {
  CLAUDE_PROBE_COMMANDS,
  captureClaudeExecutableEvidence,
  captureClaudeFixtureExecutableEvidence,
  type ClaudeChildRunner,
  type ClaudeProbeChild,
  runClaudeMetadataProbe,
} from './claude-probe';

let workspace: ClaudeOwnedWorkspace;
let profile: ClaudeLaunchProfile;
let paths: ClaudeOwnedWorkspace['paths'];
let fixtureExecutablePath: string;
const FIXTURE_CLAUDE_VERSION = '9.9.9';

const fixtureServer = {
  type: 'http' as const,
  url: 'http://127.0.0.1:43123/mcp',
};

beforeAll(async () => {
  workspace = await createClaudeOwnedWorkspace();
  paths = workspace.paths;
  fixtureExecutablePath = `${workspace.root}/fixture-node`;
  await copyFile(process.execPath, fixtureExecutablePath);
  await chmod(fixtureExecutablePath, 0o755);
  profile = buildClaudeLaunchProfile({
    paths,
    mcpServers: { fixture: fixtureServer },
    executable: process.execPath,
    baseEnv: {
      PATH: process.env.PATH,
      LANG: 'C',
    },
  });
});

afterAll(async () => {
  await workspace.cleanup();
});

function fixtureRunner(script: string, extraArgs: readonly string[] = []): ClaudeChildRunner {
  return (_executable, _args, options) =>
    spawn(process.execPath, ['-e', script, ...extraArgs], {
      cwd: options.cwd,
      env: { ...options.env },
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ClaudeProbeChild;
}

function emitJson(value: unknown, exitCode = 0, stderr = ''): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(value))});${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}process.exit(${exitCode});`;
}

function createOwnedStubbornFixture(): {
  child: ReturnType<typeof spawn>;
  closed: Promise<void>;
  ready: Promise<boolean>;
  processGroupId: number | undefined;
  runner: ClaudeChildRunner;
  signals: NodeJS.Signals[];
} {
  const signals: NodeJS.Signals[] = [];
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        'process.on("SIGTERM", () => {});',
        'if (process.send) process.send("ready");',
        "process.stdout.write('fixture-discarded-output');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    ],
    {
      cwd: paths.cwd,
      env: { ...profile.env },
      // POSIX gets a disposable process-group leader; all platforms expose
      // only this exact owned child handle to the probe.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const ready = new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.removeListener('message', onMessage);
      resolve(value);
    };
    const onError = (): void => finish(false);
    const onClose = (): void => finish(false);
    const onMessage = (message: unknown): void => finish(message === 'ready');
    child.once('error', onError);
    child.once('close', onClose);
    child.once('message', onMessage);
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));

  // Fixture coverage owns this exact child handle. It does not accept a PID,
  // path, shell command, or process-group fallback from the caller.
  const runner: ClaudeChildRunner = () => ({
    pid: child.pid,
    processGroupId: process.platform === 'win32' ? undefined : child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child),
    once: child.once.bind(child),
    removeListener: child.removeListener.bind(child),
    kill: (signal?: NodeJS.Signals | number): boolean => {
      if (typeof signal === 'string') signals.push(signal);
      return child.kill(signal);
    },
  });

  return { child, closed, ready, processGroupId: child.pid, runner, signals };
}

function createOwnedDescendantFixture(descendantPidPath: string): {
  child: ReturnType<typeof spawn>;
  closed: Promise<void>;
  descendantPidPath: string;
  processGroupId: number | undefined;
  runner: ClaudeChildRunner;
  signals: NodeJS.Signals[];
} {
  const signals: NodeJS.Signals[] = [];
  const script = [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("descendant-fixture-started");',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], {
    cwd: paths.cwd,
    env: { ...profile.env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const runner: ClaudeChildRunner = () => ({
    pid: child.pid,
    processGroupId: process.platform === 'win32' ? undefined : child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child),
    once: child.once.bind(child),
    removeListener: child.removeListener.bind(child),
    kill: (signal?: NodeJS.Signals | number): boolean => {
      if (typeof signal === 'string') signals.push(signal);
      return child.kill(signal);
    },
  });
  return { child, closed, descendantPidPath, processGroupId: child.pid, runner, signals };
}

async function waitForDescendantPid(path: string): Promise<number> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The descendant may not have created its marker yet.
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('descendant fixture did not publish its PID');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return !isProcessRunning(pid);
}

async function disposeOwnedDescendantFixture(fixture: ReturnType<typeof createOwnedDescendantFixture>): Promise<void> {
  if (process.platform !== 'win32' && fixture.processGroupId !== undefined) {
    try {
      process.kill(-fixture.processGroupId, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  } else if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill('SIGKILL');
  }
  await fixture.closed;
  try {
    await unlink(fixture.descendantPidPath);
  } catch {
    // Workspace cleanup also removes the marker.
  }
}

const OWNED_FIXTURE_SKIP_REASON = 'sandbox could not spawn and observe an owned detached process group';

function canObserveOwnedProcessGroup(processGroupId: number | undefined): boolean {
  if (process.platform === 'win32' || processGroupId === undefined) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function disposeOwnedStubbornFixture(fixture: ReturnType<typeof createOwnedStubbornFixture>): Promise<void> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill('SIGKILL');
  await fixture.closed;
}

async function prepareOwnedStubbornFixture(): Promise<ReturnType<typeof createOwnedStubbornFixture> | undefined> {
  let fixture: ReturnType<typeof createOwnedStubbornFixture> | undefined;
  try {
    fixture = createOwnedStubbornFixture();
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      fixture.ready,
      new Promise<boolean>(resolve => {
        readinessTimer = setTimeout(() => resolve(false), 500);
      }),
    ]);
    if (readinessTimer) clearTimeout(readinessTimer);
    if (!ready || !canObserveOwnedProcessGroup(fixture.processGroupId)) {
      await disposeOwnedStubbornFixture(fixture);
      return undefined;
    }
    return fixture;
  } catch {
    if (fixture) await disposeOwnedStubbornFixture(fixture);
    return undefined;
  }
}

async function waitForOwnedProcessGroupExit(processGroupId: number | undefined): Promise<boolean> {
  if (process.platform === 'win32' || processGroupId === undefined) return false;
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && canObserveOwnedProcessGroup(processGroupId)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return !canObserveOwnedProcessGroup(processGroupId);
}

describe('Claude metadata probe', () => {
  it('executes the exact strict profile for real metadata-only version and auth checks', async ({ skip }) => {
    if (process.env.RUN_CLAUDE_STRICT_METADATA_PROBE !== '1') {
      return skip('set RUN_CLAUDE_STRICT_METADATA_PROBE=1 with a canonical CLAUDE_EXECUTABLE to run the vendor check');
    }
    const executable = process.env.CLAUDE_EXECUTABLE;
    if (!executable) return skip('CLAUDE_EXECUTABLE must point to the installed canonical Claude executable');

    const realWorkspace = await createClaudeOwnedWorkspace();
    try {
      const realProfile = buildClaudeLaunchProfile({
        paths: realWorkspace.paths,
        executable,
        mcpServers: { fixture: fixtureServer },
      });
      await materializeClaudeMcpConfig(realProfile, { workspace: realWorkspace });
      const evidence = await captureClaudeExecutableEvidence(executable);
      const version = await runClaudeMetadataProbe({
        profile: realProfile,
        command: 'version',
        executableEvidence: evidence,
        allowMaterializedConfig: true,
      });
      const auth = await runClaudeMetadataProbe({
        profile: realProfile,
        command: 'auth-status',
        executableEvidence: evidence,
        allowMaterializedConfig: true,
      });

      expect(version).toMatchObject({ ok: true, versionEvidence: { available: true, version: expect.any(String) } });
      expect(version.versionEvidence?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
      expect(auth).toMatchObject({
        ok: true,
        authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
      });
    } finally {
      await realWorkspace.cleanup();
    }
  });

  it('accepts an explicitly pinned fixture executable only through an injected runner', async () => {
    const executableEvidence = await captureClaudeFixtureExecutableEvidence(fixtureExecutablePath);
    let seenExecutable: string | undefined;
    const result = await runClaudeMetadataProbe({
      profile,
      command: 'version',
      executableEvidence,
      runner: (executable, args, options) => {
        seenExecutable = executable;
        return fixtureRunner(emitJson(`claude ${FIXTURE_CLAUDE_VERSION}`))(executable, args, options);
      },
    });

    expect(seenExecutable).toBe(fixtureExecutablePath);
    expect(result).toMatchObject({ ok: true, versionEvidence: { available: true, version: FIXTURE_CLAUDE_VERSION } });
  });

  it('requires caller-pinned Claude evidence for the real/default runner', async () => {
    await expect(runClaudeMetadataProbe({ profile, command: 'version' })).rejects.toThrow(/pinned executable evidence/);
  });

  it('validates the complete safe launch profile before any metadata child starts', async () => {
    let called = false;
    const unsafeProfile = {
      ...profile,
      argv: [...profile.argv, '--bare'],
    };

    await expect(
      runClaudeMetadataProbe({
        profile: unsafeProfile,
        command: 'version',
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/canonical|strict/);
    expect(called).toBe(false);
  });

  it.each([
    ['a bare PATH name', 'claude'],
    ['a relative path', './claude'],
  ])('rejects %s before invoking an injected runner', async (_label, executable) => {
    let called = false;
    await expect(
      runClaudeMetadataProbe({
        profile,
        command: 'version',
        executable,
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/absolute canonical/);
    expect(called).toBe(false);
  });

  it('rejects an arbitrary executable replacement instead of overriding the profile pin', async () => {
    let called = false;
    await expect(
      runClaudeMetadataProbe({
        profile,
        command: 'version',
        executable: `${paths.cwd}/claude`,
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/profile executable pin/);
    expect(called).toBe(false);
  });

  it('revalidates fixture realpath, ownership, device/inode, and mode before spawning', async () => {
    const pinned = await captureClaudeFixtureExecutableEvidence(fixtureExecutablePath);
    const stale = { ...pinned, ino: pinned.ino + 1 };
    let called = false;
    await expect(
      runClaudeMetadataProbe({
        profile,
        command: 'version',
        executableEvidence: stale,
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/identity changed/);
    expect(called).toBe(false);
  });

  it('rejects a symlinked injected fixture executable before spawning', async () => {
    const symlinkedExecutable = `${workspace.root}/symlinked-claude`;
    await symlink(fixtureExecutablePath, symlinkedExecutable);
    const pinned = await captureClaudeFixtureExecutableEvidence(fixtureExecutablePath);
    const symlinkEvidence = {
      ...pinned,
      executable: symlinkedExecutable,
      realpath: symlinkedExecutable,
      basename: 'symlinked-claude',
    } as const;
    let called = false;
    try {
      await expect(
        runClaudeMetadataProbe({
          profile: { ...profile, executable: symlinkedExecutable },
          command: 'version',
          executableEvidence: symlinkEvidence,
          runner: () => {
            called = true;
            throw new Error('must not run');
          },
        }),
      ).rejects.toThrow(/symlink/);
      expect(called).toBe(false);
    } finally {
      await unlink(symlinkedExecutable);
    }
  });

  it('rejects an executable not owned by the caller', async ({ skip }) => {
    const callerUid = process.getuid?.();
    if (callerUid === undefined) return skip('caller UID is unavailable on this platform');
    const pinned = await captureClaudeFixtureExecutableEvidence(fixtureExecutablePath);
    await expect(
      runClaudeMetadataProbe({
        profile,
        command: 'version',
        executableEvidence: { ...pinned, uid: callerUid + 1 },
        runner: () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/owned by/);
  });

  it('rejects missing executable ownership UID evidence before spawning', async () => {
    const pinned = await captureClaudeFixtureExecutableEvidence(fixtureExecutablePath);
    let called = false;
    await expect(
      runClaudeMetadataProbe({
        profile,
        command: 'version',
        executableEvidence: { ...pinned, uid: undefined } as unknown as typeof pinned,
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/safe integer/);
    expect(called).toBe(false);
  });

  it('invokes only the exact version allow-list entry with sanitized local environment', async () => {
    let seenArgs: readonly string[] = [];
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const runner: ClaudeChildRunner = (executable, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      return fixtureRunner(emitJson(`claude ${FIXTURE_CLAUDE_VERSION}`))(executable, args, options);
    };

    const result = await runClaudeMetadataProbe({ profile, command: 'version', runner });

    expect(seenArgs).toEqual([...profile.argv, ...CLAUDE_PROBE_COMMANDS.version]);
    expect(seenEnv).toMatchObject({ HOME: process.env.HOME, TMPDIR: paths.tmpDir });
    expect(seenEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(JSON.stringify(result)).not.toMatch(/must-not-be-injected|token|secret|raw/i);
  });

  it('passes only the disposable cwd and keeps version/auth probes separate', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
    const runner: ClaudeChildRunner = (executable, args, options) => {
      calls.push({ executable, args: [...args], cwd: options.cwd });
      const script = args.includes('--version')
        ? emitJson(`claude ${FIXTURE_CLAUDE_VERSION}`)
        : emitJson({
            loggedIn: true,
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
            analyticsDisabled: false,
            configDirectory: '/Users/example/.claude',
            projectsDirectory: '/Users/example/.claude/projects',
            email: 'user@example.com',
            orgId: 'org-id',
            orgName: 'Example Org',
            subscriptionType: 'max',
          });
      return fixtureRunner(script)(executable, args, options);
    };

    const version = await runClaudeMetadataProbe({ profile, command: 'version', runner });
    const auth = await runClaudeMetadataProbe({ profile, command: 'auth-status', runner });

    expect(calls).toEqual([
      { executable: process.execPath, args: [...profile.argv, ...CLAUDE_PROBE_COMMANDS.version], cwd: paths.cwd },
      { executable: process.execPath, args: [...profile.argv, ...CLAUDE_PROBE_COMMANDS['auth-status']], cwd: paths.cwd },
    ]);
    expect(CLAUDE_PROBE_COMMANDS['auth-status']).toEqual(['auth', 'status', '--json']);
    expect(version).toMatchObject({ command: 'version', ok: true, versionEvidence: { available: true, version: FIXTURE_CLAUDE_VERSION } });
    expect(version).not.toHaveProperty('authEvidence');
    expect(auth).toMatchObject({
      command: 'auth-status',
      ok: true,
      authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
    });
    expect(auth).not.toHaveProperty('versionEvidence');
  });

  it('rejects disposable environment paths with traversal segments before creating a child', async () => {
    let called = false;
    const unsafeProfile = {
      ...profile,
      env: { ...profile.env, HOME: `${paths.cwd}/../outside-probe-home` },
    };

    await expect(
      runClaudeMetadataProbe({
        profile: unsafeProfile,
        command: 'version',
        runner: () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/owned|traversal|environment/);
    expect(called).toBe(false);
  });

  it('rejects a real symlinked launch path before invoking the child runner', async () => {
    const symlinkedTmp = `${workspace.root}/symlinked-tmp`;
    await symlink(paths.tmpDir, symlinkedTmp, 'dir');
    const unsafeProfile = {
      ...profile,
      tmpDir: symlinkedTmp,
      env: { ...profile.env, TMPDIR: symlinkedTmp },
    };
    let called = false;
    try {
      await expect(
        runClaudeMetadataProbe({
          profile: unsafeProfile,
          command: 'version',
          runner: () => {
            called = true;
            throw new Error('must not run');
          },
        }),
      ).rejects.toThrow(/symlink/);
      expect(called).toBe(false);
    } finally {
      await unlink(symlinkedTmp);
    }
  });

  it('rejects a non-owned launch directory during the same workspace preflight', async () => {
    const fakeFilesystem: ClaudeFileSystem = {
      lstat: async path => {
        const actual = await lstat(path);
        if (path !== paths.tmpDir) return actual;
        return {
          isDirectory: () => actual.isDirectory(),
          isSymbolicLink: () => false,
          uid: (actual.uid ?? 0) + 1,
          dev: actual.dev,
          ino: actual.ino,
        };
      },
      realpath: async path => path,
      open: async () => {
        throw new Error('open must not be reached for a non-owned path');
      },
      unlink: async () => undefined,
    };

    await expect(validateClaudeLaunchProfilePaths(profile, { workspace, filesystem: fakeFilesystem })).rejects.toThrow(/owned by/);
  });

  it('rejects missing ownership UID evidence during the same workspace preflight', async () => {
    const fakeFilesystem: ClaudeFileSystem = {
      lstat: async path => {
        const actual = await lstat(path);
        if (path !== paths.tmpDir) return actual;
        return {
          isDirectory: () => actual.isDirectory(),
          isSymbolicLink: () => false,
          mode: actual.mode,
          dev: actual.dev,
          ino: actual.ino,
        };
      },
      realpath: async path => realpath(path),
      open: async () => {
        throw new Error('open must not be reached without ownership evidence');
      },
      unlink: async () => undefined,
    };

    await expect(validateClaudeLaunchProfilePaths(profile, { workspace, filesystem: fakeFilesystem })).rejects.toThrow(/ownership UID evidence/);
  });

  it('rejects arbitrary commands and arguments before creating a child', async () => {
    let called = false;
    const runner: ClaudeChildRunner = () => {
      called = true;
      throw new Error('must not run');
    };

    const invalidRequest = { profile, command: 'login' as never, runner, args: ['--dangerous'] };

    await expect(runClaudeMetadataProbe(invalidRequest)).rejects.toThrow('allowlisted');
    expect(called).toBe(false);
  });

  it('terminates an owned child on timeout and escalates to SIGKILL with a bounded fallback', async ({ skip }) => {
    if (process.platform === 'win32') return skip('SIGTERM/SIGKILL process-group observation is unsupported on Windows');
    const fixture = await prepareOwnedStubbornFixture();
    if (!fixture) return skip(OWNED_FIXTURE_SKIP_REASON);

    try {
      const result = await runClaudeMetadataProbe({
        profile,
        command: 'auth-status',
        runner: fixture.runner,
        timeoutMs: 1,
      });
      await fixture.closed;

      expect(result).toMatchObject({ ok: false, failure: 'timeout', timedOut: true, authEvidence: { loggedIn: false, authMethod: 'none' } });
      expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(fixture.child.signalCode).toBe('SIGKILL');
      expect(fixture.child.exitCode).toBeNull();
      expect(await waitForOwnedProcessGroupExit(fixture.processGroupId)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('fixture-discarded-output');
    } finally {
      await disposeOwnedStubbornFixture(fixture);
    }
  });

  it('terminates a real stubborn descendant through the owned process group', async ({ skip }) => {
    if (process.platform === 'win32') return skip('SIGTERM/SIGKILL process-group observation is unsupported on Windows');
    const descendantPidPath = `${paths.cwd}/descendant.pid`;
    const fixture = createOwnedDescendantFixture(descendantPidPath);
    if (!canObserveOwnedProcessGroup(fixture.processGroupId)) {
      await disposeOwnedDescendantFixture(fixture);
      return skip(OWNED_FIXTURE_SKIP_REASON);
    }

    const descendantPid = await waitForDescendantPid(descendantPidPath);
    try {
      const result = await runClaudeMetadataProbe({
        profile,
        command: 'version',
        runner: fixture.runner,
        timeoutMs: 1,
      });
      await fixture.closed;

      expect(result).toMatchObject({ ok: false, failure: 'timeout', timedOut: true });
      expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
      expect(await waitForOwnedProcessGroupExit(fixture.processGroupId)).toBe(true);
    } finally {
      await disposeOwnedDescendantFixture(fixture);
    }
  });

  it('honors a caller AbortSignal and does not classify it as a timeout', async ({ skip }) => {
    if (process.platform === 'win32') return skip('SIGTERM/SIGKILL process-group observation is unsupported on Windows');
    const fixture = await prepareOwnedStubbornFixture();
    if (!fixture) return skip(OWNED_FIXTURE_SKIP_REASON);
    const controller = new AbortController();
    let started!: () => void;
    const childStarted = new Promise<void>(resolve => {
      started = resolve;
    });

    try {
      const abortResult = runClaudeMetadataProbe({
        profile,
        command: 'version',
        runner: (executable, args, options) => {
          started();
          return fixture.runner(executable, args, options);
        },
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      await childStarted;
      controller.abort();
      const result = await abortResult;
      await fixture.closed;

      expect(result).toMatchObject({ ok: false, failure: 'aborted', timedOut: false, aborted: true });
      expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(fixture.child.signalCode).toBe('SIGKILL');
      expect(await waitForOwnedProcessGroupExit(fixture.processGroupId)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('fixture-discarded-output');
    } finally {
      await disposeOwnedStubbornFixture(fixture);
    }
  });

  it('invokes only the exact version allow-list entry with sanitized local environment', async () => {
    let seenArgs: readonly string[] = [];
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const runner: ClaudeChildRunner = (executable, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      return fixtureRunner(emitJson(`claude ${FIXTURE_CLAUDE_VERSION}`))(executable, args, options);
    };

    const result = await runClaudeMetadataProbe({ profile, command: 'version', runner });

    expect(seenArgs).toEqual([...profile.argv, ...CLAUDE_PROBE_COMMANDS.version]);
    expect(seenEnv).toMatchObject({ HOME: process.env.HOME, TMPDIR: paths.tmpDir });
    expect(seenEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(seenEnv).not.toHaveProperty('AUTH_TOKEN');
    expect(result).toMatchObject({ ok: true, versionEvidence: { available: true, version: FIXTURE_CLAUDE_VERSION } });
    expect(JSON.stringify(result)).not.toMatch(/must-not-be-injected|token|secret|raw/i);
  });

  it('terminates an owned child on timeout without retaining output', async () => {
    const result = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner("process.stdout.write('secret-token'); setInterval(() => {}, 1000);"),
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, failure: 'timeout', timedOut: true, authEvidence: { loggedIn: false, authMethod: 'none' } });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('bounds stdout and stderr independently', async () => {
    const stdoutResult = await runClaudeMetadataProbe({
      profile,
      command: 'version',
      runner: fixtureRunner("process.stdout.write('x'.repeat(1000)); setInterval(() => {}, 1000);"),
      maxStdoutBytes: 32,
    });
    const stderrResult = await runClaudeMetadataProbe({
      profile,
      command: 'version',
      runner: fixtureRunner("process.stderr.write('y'.repeat(1000)); setInterval(() => {}, 1000);"),
      maxStderrBytes: 32,
    });

    expect(stdoutResult.failure).toBe('stdout-too-large');
    expect(stderrResult.failure).toBe('stderr-too-large');
    expect(JSON.stringify(stdoutResult)).not.toContain('x'.repeat(100));
    expect(JSON.stringify(stderrResult)).not.toContain('y'.repeat(100));
  });

  it('does not claim auth from malformed, ambiguous, or contradictory status', async () => {
    const malformed = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner("process.stdout.write('not valid status output'); process.exit(0);"),
    });
    const contradictory = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner(emitJson({ loggedIn: false, authMethod: 'subscription', apiProvider: 'firstParty' })),
    });
    const ambiguous = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner(emitJson({ loggedIn: true, authMethod: 'subscription' })),
    });

    expect(malformed).toMatchObject({ failure: 'malformed-output', authEvidence: { loggedIn: false, authMethod: 'none' } });
    expect(contradictory).toMatchObject({ failure: 'malformed-output', authEvidence: { loggedIn: false, authMethod: 'none' } });
    expect(ambiguous).toMatchObject({ failure: 'malformed-output', authEvidence: { loggedIn: false, authMethod: 'none' } });
  });

  it('does not claim auth from human-readable status text', async () => {
    const result = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner("process.stdout.write('logged in to claude.ai'); process.exit(0);"),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: 'malformed-output',
      authEvidence: { loggedIn: false, authMethod: 'none', apiProvider: 'unknown' },
    });
  });

  it('rejects unknown vendor status fields while accepting bounded metadata', async () => {
    const result = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner(
        emitJson({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
          unrecognizedControlField: 'must-not-be-trusted',
        }),
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: 'malformed-output',
      authEvidence: { loggedIn: false, authMethod: 'none', apiProvider: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-trusted');
  });

  it('preserves the observed unauthenticated exit-one result and redacts secrets', async () => {
    const result = await runClaudeMetadataProbe({
      profile,
      command: 'auth-status',
      runner: fixtureRunner(emitJson({ loggedIn: false, authMethod: 'subscription', apiProvider: 'firstParty', accessToken: 'secret-token' }, 1)),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: 'nonzero-exit',
      exitCode: 1,
      authEvidence: { loggedIn: false, authMethod: 'none', exitCode: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|accessToken|subscription/);
  });
});
