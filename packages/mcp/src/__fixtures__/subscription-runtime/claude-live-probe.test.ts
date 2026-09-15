import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeLaunchProfile,
  createClaudeOwnedWorkspace,
  materializeClaudeMcpConfig,
  type ClaudeOwnedWorkspace,
} from './claude-launch-profile';
import {
  CLAUDE_LIVE_MARKER_ENV,
  CLAUDE_LIVE_MARKER_VALUE,
  CLAUDE_LIVE_PROBE_ENV,
  ClaudeLiveProbeError,
  ClaudeLiveTurnLedger,
  CLAUDE_LIVE_SCENARIOS,
  runClaudeLiveMalformedNegative,
  runClaudeLiveProtocolPlan,
  runClaudeLiveTurn,
} from './claude-live-probe';
import * as claudeLiveProbeModule from './claude-live-probe';
import { captureClaudeExecutableEvidence, type ClaudeMetadataProbeResult } from './claude-probe';
import type { ClaudeProtocolCommand, ClaudeProtocolProcess } from './claude-protocol';
import { BoundedResourceScope } from './process-cleanup';

let workspace: ClaudeOwnedWorkspace | undefined;
const initialOptIn = process.env[CLAUDE_LIVE_PROBE_ENV];
const initialMarker = process.env[CLAUDE_LIVE_MARKER_ENV];
const FIXTURE_CLAUDE_VERSION = '9.9.9';

function metadataResult(command: 'version' | 'auth-status'): ClaudeMetadataProbeResult {
  if (command === 'version') {
    return { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, versionEvidence: { available: true, version: FIXTURE_CLAUDE_VERSION, exitCode: 0 } };
  }
  return {
    command,
    ok: true,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', exitCode: 0, blocked: false },
  };
}

class FakeProtocolChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = undefined;
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  private closed = false;
  private readonly sessionId: string;
  private readonly action: string;
  private readonly emitPartial: boolean;
  private readonly isStructured: boolean;
  private readonly isCancel: boolean;
  private readonly stdinErrorOnWrite: boolean;
  private readonly interruptRace: boolean;
  private readonly nonCancelInterruptResult: boolean;
  private readonly systemInitBeforeUser: boolean;
  private readonly malformedAfterUser: boolean;
  private readonly nonZeroAfterUser: boolean;

  constructor(command: ClaudeProtocolCommand, options: { emitPartial: boolean; isCancel?: boolean; stdinErrorOnWrite?: boolean; onWrite?: (value: string) => void; interruptRace?: boolean; nonCancelInterruptResult?: boolean; systemInitBeforeUser?: boolean; malformedAfterUser?: boolean; nonZeroAfterUser?: boolean }) {
    super();
    this.sessionId = argumentValue(command.argv, '--session-id') ?? argumentValue(command.argv, '--resume') ?? 'dry-session';
    this.action = command.action;
    this.emitPartial = options.emitPartial;
    this.isStructured = command.argv.includes('--json-schema');
    this.isCancel = options.isCancel === true;
    this.stdinErrorOnWrite = options.stdinErrorOnWrite === true;
    this.interruptRace = options.interruptRace === true;
    this.nonCancelInterruptResult = options.nonCancelInterruptResult === true;
    this.systemInitBeforeUser = options.systemInitBeforeUser === true;
    this.malformedAfterUser = options.malformedAfterUser === true;
    this.nonZeroAfterUser = options.nonZeroAfterUser === true;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.stdinErrorOnWrite) {
          callback();
          queueMicrotask(() => this.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
          return;
        }
        options.onWrite?.(String(chunk));
        this.handleInput(String(chunk));
        callback();
      },
      final: callback => {
        this.finish(0);
        callback();
      },
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.finish(typeof signal === 'string' ? null : null);
    return true;
  }

  private handleInput(value: string): void {
    for (const raw of value.split('\n').filter(Boolean)) {
      const frame = JSON.parse(raw) as { type?: string; request_id?: string; request?: { subtype?: string } };
      if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
        if (this.systemInitBeforeUser) this.emitLine({ type: 'system', subtype: 'init', session_id: this.sessionId });
        this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } } });
      } else if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
        // Canonical SDK control responses omit the outer session_id. The
        // live adapter binds this response to the pending process session.
        if (this.interruptRace) {
          this.emitLine({ type: 'error', session_id: this.sessionId, error: { code: 'provider-failure', message: 'final won the interrupt race' } });
        }
        this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [], cancelled: [] } } });
        this.emitLine({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: this.sessionId,
          is_error: true,
          errors: [this.nonCancelInterruptResult ? 'provider failure' : 'aborted'],
          terminal_reason: this.nonCancelInterruptResult ? 'api_error' : 'aborted_streaming',
        });
      } else if (frame.type === 'user') {
        // The installed Claude release emits system/init only after the host
        // dispatches the first user frame. Keep the dry child in that order
        // so the probe cannot accidentally rely on pre-user telemetry.
        if (!this.systemInitBeforeUser) this.emitLine({ type: 'system', subtype: 'init', session_id: this.sessionId });
        if (this.nonZeroAfterUser) {
          this.finish(7);
          return;
        }
        if (this.malformedAfterUser) {
          this.emitLine({ type: 'unadmitted_after_dispatch', session_id: this.sessionId });
          return;
        }
        if (this.isCancel) {
          this.emitTextStream('counting 1');
          return;
        }
        if (this.action === 'start' && this.emitPartial) {
          this.emitTextStream('LIVE_TEXT_OK', true);
        }
        if (this.action === 'resume') {
          this.emitTextStream('LIVE_RESUME_OK');
        }
        if (this.action === 'fork') {
          this.emitTextStream('LIVE_FORK_OK');
        }
        if (this.isStructured) {
          this.emitLine({ type: 'result', subtype: 'success', session_id: this.sessionId, is_error: false, structured_output: { probe: 'LIVE_STRUCTURED_OK' } });
          return;
        }
        this.emitLine({ type: 'assistant', session_id: this.sessionId, message: { content: [{ type: 'text', text: 'LIVE_OK' }] } });
        const result = this.action === 'resume' ? 'LIVE_RESUME_OK' : this.action === 'fork' ? 'LIVE_FORK_OK' : 'LIVE_TEXT_OK';
        this.emitLine({ type: 'result', subtype: 'success', session_id: this.sessionId, is_error: false, result });
      }
    }
  }

  private emitLine(frame: unknown): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private emitTextStream(text: string, withThinking = false): void {
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'message_start', message: { id: 'dry-message', type: 'message', role: 'assistant', content: [] } } });
    let index = 0;
    if (withThinking) {
      this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } });
      this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'bounded thought', estimated_tokens: null } } });
      this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'bounded-signature' } } });
      this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_stop', index } });
      index = 1;
    }
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'content_block_stop', index } });
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } });
    this.emitLine({ type: 'stream_event', session_id: this.sessionId, event: { type: 'message_stop' } });
  }

  private finish(_code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', _code));
  }
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

type IsolatedMalformedNegativeMode = 'stays-open' | 'close' | 'epipe' | 'parser-error';

type IsolatedMalformedNegativeResult = {
  readonly mode: IsolatedMalformedNegativeMode;
  readonly status: string;
  readonly failureCode?: string;
  readonly elapsedMs: number;
  readonly userFrameCount: number;
  readonly closerInvoked: boolean;
  readonly lockPresent: boolean;
};

/**
 * Run the malformed-negative orchestration in a fresh Node process.  Vitest
 * keeps other handles alive, which can hide an unref'd deadline; this child
 * intentionally has only the in-memory fake child and the awaited probe.
 */
async function runIsolatedMalformedNegative(mode: IsolatedMalformedNegativeMode): Promise<IsolatedMalformedNegativeResult> {
  const liveProbeModule = new URL('./claude-live-probe.ts', import.meta.url).href;
  const launchProfileModule = new URL('./claude-launch-profile.ts', import.meta.url).href;
  const metadataProbeModule = new URL('./claude-probe.ts', import.meta.url).href;
  const script = [
    `const mode = process.argv[1];`,
    `process.env.RUN_CLAUDE_PROTOCOL_LIVE_PROBE = '1';`,
    `process.env.CLAUDE_T04_LIVE_MARKER = 'RUN_T04_CLAUDE_PROTOCOL_LIVE_PROBE';`,
    `const { EventEmitter } = await import('node:events');`,
    `const { PassThrough, Writable } = await import('node:stream');`,
    `const { chmod, copyFile, lstat } = await import('node:fs/promises');`,
    `const { join } = await import('node:path');`,
    `const live = await import(${JSON.stringify(liveProbeModule)});`,
    `const launch = await import(${JSON.stringify(launchProfileModule)});`,
    `const probe = await import(${JSON.stringify(metadataProbeModule)});`,
    `class FakeChild extends EventEmitter {`,
    `  constructor(sessionId) {`,
    `    super(); this.sessionId = sessionId; this.closed = false; this.initialized = false; this.writes = [];`,
    `    this.stdout = new PassThrough(); this.stderr = new PassThrough();`,
    `    this.exitCode = null; this.signalCode = null; this.pid = undefined;`,
    `    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {`,
    `      try {`,
    `        const frame = JSON.parse(String(chunk)); this.writes.push(frame);`,
    `        if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') this.emitInitialize();`,
    `        else if (frame.type === 'control_request' && frame.request?.subtype === 'not-admitted') this.emitMalformedOutcome();`,
    `        callback();`,
    `      } catch (error) { callback(error); }`,
    `    }});`,
    `  }`,
    `  emitInitialize() {`,
    `    if (this.initialized) return; this.initialized = true;`,
    `    this.emitLine({ type: 'system', subtype: 'init', session_id: this.sessionId });`,
    `    this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: 'init-negative', response: { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } } });`,
    `  }`,
    `  emitMalformedOutcome() {`,
    `    if (mode === 'close') return this.finish(1);`,
    `    if (mode === 'epipe') return queueMicrotask(() => this.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));`,
    `    if (mode === 'parser-error') return queueMicrotask(() => this.emitLine({ type: 'not-admitted', session_id: this.sessionId }));`,
    `  }`,
    `  emitLine(frame) { if (!this.closed) this.stdout.write(JSON.stringify(frame) + '\\n'); }`,
    `  kill() { this.finish(null); return true; }`,
    `  finish(code) { if (this.closed) return; this.closed = true; this.exitCode = code; this.stdout.end(); this.stderr.end(); queueMicrotask(() => this.emit('close', code)); }`,
    `}`,
    `const workspace = await launch.createClaudeOwnedWorkspace({ prefix: 'mastra-live-negative-isolated-' });`,
    `let fake; let closerInvoked = false;`,
    `try {`,
    `  const executable = join(workspace.root, 'claude'); await copyFile(process.execPath, executable); await chmod(executable, 0o755);`,
    `  const profile = launch.buildClaudeLaunchProfile({ paths: workspace.paths, executable, mcpServers: { fixture: { type: 'http', url: 'http://127.0.0.1:43123/mcp' } }, authStatusRaw: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' }, versionStatusRaw: 'Claude Code ${FIXTURE_CLAUDE_VERSION}' });`,
    `  await launch.materializeClaudeMcpConfig(profile, { workspace });`,
    `  const executableEvidence = await probe.captureClaudeExecutableEvidence(executable);`,
    `  const metadataProbe = async ({ command }) => command === 'version' ? { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, versionEvidence: { available: true, version: '${FIXTURE_CLAUDE_VERSION}', exitCode: 0 } } : { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', exitCode: 0, blocked: false } };`,
    `  const options = { profile, workspace, executableEvidence, executionMode: 'dry-simulated', metadataProbe, protocolProcessRunner: (scope, command) => { scope.trackCloser(() => { closerInvoked = true; }); const index = command.argv.indexOf('--session-id'); fake = new FakeChild(index >= 0 ? command.argv[index + 1] : '00000000-0000-4000-8000-000000000001'); return { child: fake, command, ownership: 'bounded-resource-scope-process-group' }; } };`,
    `  const started = Date.now(); const result = await live.runClaudeLiveMalformedNegative(options); const elapsedMs = Date.now() - started;`,
    `  const lockPresent = await lstat(join(workspace.root, '.t04-claude-live-ledger.json.lock')).then(() => true).catch(() => false);`,
    `  const userFrameCount = fake.writes.filter(frame => frame.type === 'user').length;`,
    `  process.stdout.write(JSON.stringify({ mode, status: result.status, failureCode: result.failureCode, elapsedMs, userFrameCount, closerInvoked, lockPresent }));`,
    `} finally { await workspace.cleanup(); }`,
  ].join('\n');

  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script, mode], {
    cwd: process.cwd(),
    env: { ...process.env, RUN_CLAUDE_PROTOCOL_LIVE_PROBE: '1', CLAUDE_T04_LIVE_MARKER: 'RUN_T04_CLAUDE_PROTOCOL_LIVE_PROBE' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`isolated malformed-negative ${mode} exceeded 8s`));
    }, 8_000);
    const onError = (error: Error): void => { clearTimeout(timeout); reject(error); };
    child.once('error', onError);
    child.once('close', code => { clearTimeout(timeout); child.removeListener('error', onError); resolve(code); });
  });
  if (exitCode !== 0) throw new Error(`isolated malformed-negative ${mode} exited ${String(exitCode)}: ${stderr}\n${stdout}`);
  return JSON.parse(stdout) as IsolatedMalformedNegativeResult;
}

async function createDryLiveOptions(
  options: { emitPartial: boolean; isCancel?: boolean; mcpUrl?: string; stdinErrorOnWrite?: boolean; onWrite?: (value: string) => void; interruptRace?: boolean; nonCancelInterruptResult?: boolean; systemInitBeforeUser?: boolean; malformedAfterUser?: boolean; nonZeroAfterUser?: boolean } = { emitPartial: true },
): Promise<{
  options: import('./claude-live-probe').ClaudeLiveProbeOptions;
  workspace: ClaudeOwnedWorkspace;
}> {
  const dryWorkspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-live-dry-' });
  const executable = `${dryWorkspace.root}/claude`;
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const profile = buildClaudeLaunchProfile({
    paths: dryWorkspace.paths,
    executable,
    mcpServers: { fixture: { type: 'http', url: options.mcpUrl ?? 'http://127.0.0.1:43123/mcp' } },
    authStatusRaw: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
    versionStatusRaw: `Claude Code ${FIXTURE_CLAUDE_VERSION}`,
  });
  await materializeClaudeMcpConfig(profile, { workspace: dryWorkspace });
  const executableEvidence = await captureClaudeExecutableEvidence(executable);
  const metadataProbe = async (request: { command: 'version' | 'auth-status' }): Promise<ClaudeMetadataProbeResult> => metadataResult(request.command);
  let invocation = 0;
  const protocolProcessRunner = (_scope: BoundedResourceScope, command: ClaudeProtocolCommand): ClaudeProtocolProcess => ({
      child: new FakeProtocolChild(command, { ...options, isCancel: options.isCancel === true || ++invocation === 5 }) as unknown as ClaudeProtocolProcess['child'],
    command,
    ownership: 'bounded-resource-scope-process-group',
  });
  return { options: { profile, workspace: dryWorkspace, executableEvidence, executionMode: 'dry-simulated', metadataProbe, protocolProcessRunner }, workspace: dryWorkspace };
}

async function recordSuccessfulStructuredTurn(workspace: ClaudeOwnedWorkspace): Promise<void> {
  const ledger = new ClaudeLiveTurnLedger(workspace);
  const reservation = await ledger.reserve('t4-structured');
  await ledger.complete(reservation, { status: 'completed', outcome: 'completed' });
}

afterEach(async () => {
  await workspace?.cleanup();
  workspace = undefined;
  if (initialOptIn === undefined) delete process.env[CLAUDE_LIVE_PROBE_ENV];
  else process.env[CLAUDE_LIVE_PROBE_ENV] = initialOptIn;
  if (initialMarker === undefined) delete process.env[CLAUDE_LIVE_MARKER_ENV];
  else process.env[CLAUDE_LIVE_MARKER_ENV] = initialMarker;
});

describe('Claude authenticated live-turn guard', () => {
  it.each(['stays-open', 'close', 'epipe', 'parser-error'] as const)(
    'settles the isolated malformed-negative fake child for %s without dispatching a user frame',
    async mode => {
      const result = await runIsolatedMalformedNegative(mode);
      if (mode === 'stays-open') {
        expect(result).toMatchObject({ status: 'timed-out', failureCode: 'turn-timeout' });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(1_700);
      } else {
        expect(result).toMatchObject({ status: 'rejected' });
      }
      expect(result.elapsedMs).toBeLessThan(8_000);
      expect(result.userFrameCount).toBe(0);
      expect(result.closerInvoked).toBe(true);
      expect(result.lockPresent).toBe(false);
    },
    15_000,
  );

  it('requires exact opt-in before inspecting the profile or consuming a turn', async () => {
    delete process.env[CLAUDE_LIVE_PROBE_ENV];
    const error = await runClaudeLiveTurn({} as never, { scenario: 't1-start' }).catch(value => value);
    expect(error).toBeInstanceOf(ClaudeLiveProbeError);
    expect(error).toMatchObject({ code: 'opt-in-required' });
  });

  it('requires the separate exact spawn marker as well as the opt-in marker', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    delete process.env[CLAUDE_LIVE_MARKER_ENV];
    const error = await runClaudeLiveTurn({} as never, { scenario: 't1-start' }).catch(value => value);
    expect(error).toMatchObject({ code: 'opt-in-required' });
    process.env[CLAUDE_LIVE_MARKER_ENV] = `${CLAUDE_LIVE_MARKER_VALUE}-typo`;
    const second = await runClaudeLiveTurn({} as never, { scenario: 't1-start' }).catch(value => value);
    expect(second).toMatchObject({ code: 'opt-in-required' });
  });

  it('keeps the no-user malformed negative behind the same guard and out of the ledger', async () => {
    delete process.env[CLAUDE_LIVE_PROBE_ENV];
    delete process.env[CLAUDE_LIVE_MARKER_ENV];
    const error = await runClaudeLiveMalformedNegative({} as never).catch(value => value);
    expect(error).toMatchObject({ code: 'opt-in-required' });
  });

  it('does not impose an application-wide numeric Claude-call cap', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const callCount = 12;
    for (let index = 1; index <= callCount; index += 1) {
      const reservation = await ledger.reserve('t1-start');
      expect(reservation).toMatchObject({ index, turnId: `turn-${index}`, reservationTurns: 1, scenario: 't1-start', action: 'start' });
      await ledger.complete(reservation, { status: 'failed', outcome: 'failed_before_start', failureCode: 'protocol-invalid', eventCount: 0, stdoutBytes: 0, stderrBytes: 0 });
    }
    const snapshot = await new ClaudeLiveTurnLedger(workspace).snapshot();
    expect(snapshot.records).toHaveLength(callCount);
    expect(snapshot.consumedTurns).toBe(callCount);
    expect(snapshot.records.every(record => record.status === 'failed')).toBe(true);
  });

  it('fails closed when another process holds the ledger lock', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const lockPath = `${ledger.path}.lock`;
    const lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await expect(ledger.reserve('t1-start')).rejects.toMatchObject({ code: 'ledger-locked' });
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  });

  it('rejects same-instance lock reentry and new-session UUID collisions', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const release = await ledger.acquireExclusive();
    try {
      await expect(ledger.reserve('t1-start', { sessionIdHash: '0123456789abcdef' })).rejects.toMatchObject({ code: 'ledger-locked' });
    } finally {
      await release();
    }
    const reservation = await ledger.reserve('t1-start', { sessionIdHash: '0123456789abcdef' });
    await ledger.complete(reservation, { status: 'failed', outcome: 'failed_before_start', failureCode: 'protocol-invalid' });
    await expect(ledger.reserve('t4-structured', { sessionIdHash: '0123456789abcdef' })).rejects.toMatchObject({ code: 'session-invalid' });
  });

  it('retains observed version evidence and rejects incompatible session resume', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const first = await ledger.reserve('t1-start', { sessionIdHash: '0123456789abcdef', claudeVersion: '1.2.3' });
    await ledger.complete(first, { status: 'completed', outcome: 'completed' });
    await expect(
      ledger.reserve('t2-resume', { sessionIdHash: '0123456789abcdef', allowExistingSession: true, claudeVersion: '1.2.4' }),
    ).rejects.toMatchObject({ code: 'session-invalid' });
    await expect(new ClaudeLiveTurnLedger(workspace).snapshot()).resolves.toMatchObject({
      records: [{ claudeVersion: '1.2.3', sessionIdHash: '0123456789abcdef' }],
    });
  });

  it('enforces terminal status/outcome invariants and refuses replay after ambiguity', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const reservation = await ledger.reserve('t1-start');

    await expect(ledger.complete(reservation, { status: 'completed' })).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(ledger.complete(reservation, { status: 'failed', outcome: 'unknown_after_dispatch', failureCode: 'protocol-invalid' })).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(ledger.complete(reservation, { status: 'unknown-recovery', outcome: 'completed', failureCode: 'protocol-invalid' })).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(ledger.complete(reservation, { status: 'not-exercised', outcome: 'unknown_after_dispatch' })).rejects.toMatchObject({ code: 'ledger-invalid' });

    await ledger.complete(reservation, {
      status: 'unknown-recovery',
      outcome: 'unknown_after_dispatch',
      sessionIdHash: '0123456789abcdef',
      failureCode: 'protocol-invalid',
    });
    const completed = await ledger.snapshot();
    expect(completed.records[0]).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', sessionIdHash: '0123456789abcdef' });
    await expect(ledger.reserve('t1-start', { sessionIdHash: 'fedcba9876543210' })).rejects.toMatchObject({ code: 'scenario-invalid' });
  });

  it('rejects reserved or running completion statuses without changing the reservation', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const reservation = await ledger.reserve('t1-start');

    await expect(ledger.complete(reservation, { status: 'reserved' } as never)).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(ledger.complete(reservation, { status: 'running' } as never)).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(ledger.snapshot()).resolves.toMatchObject({ records: [{ status: 'reserved' }] });

    await ledger.complete(reservation, { status: 'completed', outcome: 'completed' });
    await expect(ledger.snapshot()).resolves.toMatchObject({ records: [{ status: 'completed', outcome: 'completed' }] });
  });

  it('rejects invalid persisted terminal combinations', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    await ledger.reserve('t1-start');
    const baseline = await ledger.snapshot();
    const reserved = baseline.records[0];
    if (reserved === undefined) throw new Error('expected reserved ledger record');
    const invalidRecords: Array<Record<string, unknown>> = [
      { ...reserved, status: 'completed' },
      { ...reserved, status: 'failed' },
      { ...reserved, status: 'unknown-recovery', outcome: 'completed' },
      { ...reserved, status: 'aborted' },
      { ...reserved, status: 'not-exercised', outcome: 'unknown_after_dispatch' },
    ];
    for (const invalid of invalidRecords) {
      await writeFile(ledger.path, JSON.stringify({ ...baseline, records: [invalid] }), { mode: 0o600 });
      await expect(ledger.snapshot()).rejects.toMatchObject({ code: 'ledger-invalid' });
    }
    await writeFile(ledger.path, JSON.stringify({ ...baseline, records: [{ ...reserved, status: 'completed', outcome: 'completed', completedAt: new Date().toISOString() }] }), { mode: 0o600 });
    await expect(ledger.snapshot()).resolves.toMatchObject({ records: [{ status: 'completed', outcome: 'completed' }] });
  });

  it('rejects tampered or symlinked persistent ledger data', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    await writeFile(ledger.path, '{"schemaVersion":1,"maxTurns":5,"consumedTurns":0,"records":[]}', { mode: 0o600 });
    await expect(ledger.snapshot()).resolves.toMatchObject({ records: [] });
    await writeFile(ledger.path, '{not-json', { mode: 0o600 });
    await expect(ledger.snapshot()).rejects.toMatchObject({ code: 'ledger-invalid' });
  });

  it('writes only bounded redacted fixture payloads', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const reservation = await ledger.reserve('t1-start');
    const filename = await ledger.writeFixture(reservation, {
      schemaVersion: 1,
      token: 'fixture-secret',
      nested: { access_token: 'bearer fixture-access-token', value: 'safe' },
    });
    expect(filename).toBe('turn-1.json');
    const contents = await readFile(`${ledger.fixturesDirectory}/${filename}`, 'utf8');
    expect(contents).not.toContain('fixture-secret');
    expect(contents).not.toContain('fixture-access-token');
    expect(JSON.parse(contents)).toMatchObject({ nested: { value: 'safe' } });
  });

  it('fails closed before writing through a replaced fixture directory or file', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions();
    workspace = dry.workspace;
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const reservation = await ledger.reserve('t1-start');
    const outside = await mkdtemp(join(tmpdir(), 'mastra-live-fixture-outside-'));
    try {
      await rm(ledger.fixturesDirectory, { recursive: true, force: true });
      await symlink(outside, ledger.fixturesDirectory, 'dir');
      await expect(ledger.writeFixture(reservation, { value: 'safe' })).rejects.toMatchObject({ code: 'fixture-invalid' });
      await expect(readFile(join(outside, 'turn-1.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await rm(ledger.fixturesDirectory, { recursive: true, force: true });
      await mkdir(ledger.fixturesDirectory, { mode: 0o700 });
      await symlink(join(outside, 'outside.json'), join(ledger.fixturesDirectory, 'turn-1.json'), 'file');
      await expect(ledger.writeFixture(reservation, { value: 'safe' })).rejects.toMatchObject({ code: 'fixture-invalid' });
      await expect(readFile(join(outside, 'outside.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps live scenarios fixed and excludes an arbitrary caller prompt', () => {
    expect(Object.keys(CLAUDE_LIVE_SCENARIOS)).toEqual(['t1-start', 't2-resume', 't3-fork', 't4-structured', 't5-cancel']);
    expect(CLAUDE_LIVE_SCENARIOS['t1-start'].prompt).toContain('LIVE_TEXT_OK');
    expect(CLAUDE_LIVE_SCENARIOS['t2-resume'].prompt).toContain('LIVE_RESUME_OK');
    expect(CLAUDE_LIVE_SCENARIOS['t3-fork'].prompt).toContain('LIVE_FORK_OK');
    expect(CLAUDE_LIVE_SCENARIOS['t4-structured'].jsonSchema).toMatchObject({ properties: { probe: { enum: ['LIVE_STRUCTURED_OK'] } } });
    expect(CLAUDE_LIVE_SCENARIOS['t1-start'].maxTurns).toBe(1);
    expect(CLAUDE_LIVE_SCENARIOS['t2-resume'].maxTurns).toBe(1);
    expect(CLAUDE_LIVE_SCENARIOS['t3-fork'].maxTurns).toBe(1);
    expect(CLAUDE_LIVE_SCENARIOS['t4-structured'].maxTurns).toBe(1);
    expect(CLAUDE_LIVE_SCENARIOS['t5-cancel'].maxTurns).toBe(1);
  });

  it('keeps live execution guarded by two exact opt-in values', () => {
    expect(CLAUDE_LIVE_PROBE_ENV).toBe('RUN_CLAUDE_PROTOCOL_LIVE_PROBE');
    expect(CLAUDE_LIVE_MARKER_ENV).toBe('CLAUDE_T04_LIVE_MARKER');
    expect(CLAUDE_LIVE_MARKER_VALUE).toMatch(/^RUN_T04_CLAUDE_PROTOCOL_/);
  });

  it('deep-freezes every scenario definition so prompts and turn budgets cannot be mutated', () => {
    expect(Object.isFrozen(CLAUDE_LIVE_SCENARIOS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LIVE_SCENARIOS['t4-structured'])).toBe(true);
    expect(Object.isFrozen(CLAUDE_LIVE_SCENARIOS['t4-structured'].jsonSchema)).toBe(true);
    expect(() => ((CLAUDE_LIVE_SCENARIOS['t1-start'] as unknown as { maxTurns: number }).maxTurns = 16)).toThrow();
  });

  it('requires injected runners to opt into explicitly dry-simulated evidence', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions();
    workspace = dry.workspace;
    const { executionMode: _ignored, ...injectedWithoutMode } = dry.options;
    await expect(runClaudeLiveTurn(injectedWithoutMode, { scenario: 't1-start' })).rejects.toMatchObject({ code: 'scenario-invalid' });
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result.evidence).toBe('dry-simulated');
  });

  it('rejects profile/config mutation performed by an injected metadata runner before spawn', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions();
    workspace = dry.workspace;
    let calls = 0;
    const metadataProbe = async (request: { command: 'version' | 'auth-status' }): Promise<ClaudeMetadataProbeResult> => {
      calls += 1;
      if (calls === 2) dry.options.profile.env.TMPDIR = `${dry.workspace.root}/tampered-tmp`;
      return metadataResult(request.command);
    };
    await expect(runClaudeLiveTurn({ ...dry.options, metadataProbe }, { scenario: 't1-start' })).rejects.toMatchObject({ code: 'profile-invalid' });
  });

  it('rejects installed-version drift between profile preparation and the fresh metadata probe', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions();
    workspace = dry.workspace;
    const metadataProbe = async (request: { command: 'version' | 'auth-status' }): Promise<ClaudeMetadataProbeResult> =>
      request.command === 'version'
        ? { ...metadataResult('version'), versionEvidence: { available: true, version: '1.2.4', exitCode: 0 } }
        : metadataResult('auth-status');
    await expect(runClaudeLiveTurn({ ...dry.options, metadataProbe }, { scenario: 't1-start' })).rejects.toMatchObject({ code: 'profile-not-ready' });
  });

  it('routes stdin EPIPE through bounded failure, cleanup, and the final ledger record', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, stdinErrorOnWrite: true });
    workspace = dry.workspace;
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result).toMatchObject({ evidence: 'dry-simulated', status: 'failed', dispatch: 'dispatched', failureCode: 'protocol-invalid' });
    await expect(new ClaudeLiveTurnLedger(workspace).snapshot()).resolves.toMatchObject({ records: [{ status: 'failed', failureCode: 'protocol-invalid' }] });
  });

  it.each(['t4-structured', 't5-cancel'] as const)('requires a canonical UUID for direct %s session IDs', async scenario => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions();
    workspace = dry.workspace;
    await expect(runClaudeLiveTurn(dry.options, { scenario, sessionId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'session-invalid' });
    await expect(runClaudeLiveTurn(dry.options, { scenario, sessionId: '00000000-0000-0000-0000-000000000001' })).rejects.toMatchObject({ code: 'session-invalid' });
  });

  it('refuses direct cancellation until structured completion is durable', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, isCancel: true });
    workspace = dry.workspace;
    await expect(runClaudeLiveTurn(dry.options, { scenario: 't5-cancel' })).rejects.toMatchObject({ code: 'scenario-invalid' });
    await expect(new ClaudeLiveTurnLedger(workspace).snapshot()).resolves.toMatchObject({ consumedTurns: 0, records: [] });
  });

  it('does not send a user frame when the caller is already aborted or aborts during the handshake', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const writes: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const dry = await createDryLiveOptions({ emitPartial: true, onWrite: value => writes.push(value) });
    workspace = dry.workspace;
    const beforeStart = await runClaudeLiveTurn(dry.options, { scenario: 't1-start', signal: controller.signal });
    expect(beforeStart).toMatchObject({ status: 'aborted', failureCode: 'turn-aborted' });
    expect(writes).toEqual([]);
    await dry.workspace.cleanup();
    workspace = undefined;

    const handshakeWrites: string[] = [];
    const handshakeController = new AbortController();
    const handshakeDry = await createDryLiveOptions({ emitPartial: true, onWrite: value => {
      handshakeWrites.push(value);
      handshakeController.abort();
    } });
    workspace = handshakeDry.workspace;
    await expect(runClaudeLiveTurn(handshakeDry.options, { scenario: 't1-start', signal: handshakeController.signal })).resolves.toMatchObject({
      status: 'aborted',
      failureCode: 'turn-aborted',
    });
    expect(handshakeWrites).toHaveLength(1);
    expect(JSON.parse(handshakeWrites[0]!).type).toBe('control_request');
  });

  it('rejects a T1 result that has no genuine streamed text partial', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: false });
    workspace = dry.workspace;
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result).toMatchObject({ status: 'failed', dispatch: 'completed', failureCode: 'fixture-invalid', textMarkerSeen: true });
    expect(result.events.some(event => event.kind === 'stream-delta')).toBe(false);
  });

  it('requires system/init after user dispatch before accepting model evidence', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, systemInitBeforeUser: true });
    workspace = dry.workspace;
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', dispatch: 'dispatched', failureCode: 'protocol-invalid' });
  });

  it('persists only bounded wire diagnostics and marks post-dispatch protocol failure as unknown recovery', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, malformedAfterUser: true });
    workspace = dry.workspace;
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', failureCode: 'protocol-invalid', wireDiagnostic: { wireCode: 'unsupported-frame' } });
    expect(result.wireDiagnostic?.lineNumber).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('unadmitted_after_dispatch');
    const snapshot = await new ClaudeLiveTurnLedger(workspace).snapshot();
    expect(snapshot.records[0]).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', wireDiagnostic: { wireCode: 'unsupported-frame' } });
  });

  it('classifies a nonzero child exit after user dispatch as unknown recovery', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, nonZeroAfterUser: true });
    workspace = dry.workspace;
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't1-start' });
    expect(result).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', dispatch: 'dispatched', failureCode: 'spawn-failed', exitCode: 7 });
  });

  it('runs the fixed five-turn dry plan in order and excludes MCP/tool claims', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true });
    workspace = dry.workspace;
    const plan = await runClaudeLiveProtocolPlan(dry.options);
    expect(plan.stoppedAt).toBeUndefined();
    expect(plan.turns.map(turn => turn.reservation.scenario)).toEqual(['t1-start', 't2-resume', 't3-fork', 't4-structured', 't5-cancel']);
    expect(plan.turns.map(turn => turn.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'aborted']);
    expect(plan.turns.every(turn => turn.claudeVersion === FIXTURE_CLAUDE_VERSION)).toBe(true);
    expect(plan.turns[0]?.events.some(event => event.kind === 'stream-delta')).toBe(true);
  });

  it('refuses to run the historical protocol plan in live mode before dispatch', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true });
    workspace = dry.workspace;
    const liveOptions = {
      ...dry.options,
      executionMode: 'live' as const,
      metadataProbe: undefined,
      protocolProcessRunner: undefined,
    };
    await expect(runClaudeLiveProtocolPlan(liveOptions)).rejects.toMatchObject({ code: 'scenario-invalid' });
  });

  it('keeps exported live-turn entry points from dispatching outside recovery', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true });
    workspace = dry.workspace;
    const liveOptions = {
      ...dry.options,
      executionMode: 'live' as const,
      metadataProbe: undefined,
      protocolProcessRunner: undefined,
    };
    await expect(runClaudeLiveTurn(liveOptions, { scenario: 't4-structured' })).rejects.toMatchObject({ code: 'scenario-invalid' });
    expect('runClaudeLiveTurnWithReservation' in claudeLiveProbeModule).toBe(false);
    expect('ClaudeLiveTurnReservationBinding' in claudeLiveProbeModule).toBe(false);
  });

  it('marks a terminal result that wins the interrupt race as not-exercised', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, isCancel: true, interruptRace: true });
    workspace = dry.workspace;
    await recordSuccessfulStructuredTurn(workspace);
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't5-cancel' });
    expect(result).toMatchObject({ status: 'not-exercised', dispatch: 'completed' });
    expect(result.failureCode).toBeUndefined();
    expect(result.interruptSent).toBe(true);
    expect(result.interruptAcknowledged).toBe(true);
    expect(result.events.some(event => event.kind === 'final-error' && event.label === 'standalone-error')).toBe(true);
  });

  it('does not classify a non-cancellation error result as aborted', async () => {
    process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
    process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
    const dry = await createDryLiveOptions({ emitPartial: true, isCancel: true, nonCancelInterruptResult: true });
    workspace = dry.workspace;
    await recordSuccessfulStructuredTurn(workspace);
    const result = await runClaudeLiveTurn(dry.options, { scenario: 't5-cancel' });
    expect(result).toMatchObject({ status: 'failed', dispatch: 'completed', failureCode: 'fixture-invalid' });
    expect(result.status).not.toBe('aborted');
  });

  it('charges one slot per provider turn and refuses replay after ambiguous dispatch', async () => {
    workspace = await createClaudeOwnedWorkspace();
    const ledger = new ClaudeLiveTurnLedger(workspace);
    const first = await ledger.reserve('t1-start');
    await ledger.complete(first, { status: 'failed', outcome: 'failed_before_start', failureCode: 'protocol-invalid' });
    const second = await ledger.reserve('t2-resume');
    await ledger.complete(second, { status: 'failed', outcome: 'failed_before_start', failureCode: 'protocol-invalid' });
    const third = await ledger.reserve('t3-fork');
    await ledger.complete(third, { status: 'failed', outcome: 'failed_before_start', failureCode: 'protocol-invalid' });
    const fourth = await ledger.reserve('t4-structured');
    await ledger.complete(fourth, { status: 'completed', outcome: 'completed' });
    const cancel = await ledger.reserve('t5-cancel');
    expect(cancel).toMatchObject({ index: 5, turnId: 'turn-5', reservationTurns: 1 });
    await ledger.complete(cancel, { status: 'aborted', outcome: 'unknown_after_dispatch', failureCode: 'turn-aborted' });
    const snapshot = await ledger.snapshot();
    expect(snapshot.consumedTurns).toBe(5);
    expect(snapshot.records).toHaveLength(5);
    await expect(ledger.reserve('t1-start')).rejects.toMatchObject({ code: 'scenario-invalid' });
  });
});
