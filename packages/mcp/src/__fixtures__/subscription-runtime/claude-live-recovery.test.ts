import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeLaunchProfile, createClaudeOwnedWorkspace, materializeClaudeMcpConfig, type ClaudeOwnedWorkspace } from './claude-launch-profile';
import {
  CLAUDE_LIVE_MARKER_ENV,
  CLAUDE_LIVE_MARKER_VALUE,
  CLAUDE_LIVE_LEDGER_FILE,
  CLAUDE_LIVE_PROBE_ENV,
  ClaudeLiveProbeError,
  type ClaudeLiveProbeOptions,
} from './claude-live-probe';
import * as claudeLiveRecoveryModule from './claude-live-recovery';
import {
  CLAUDE_T04_PRIOR_EVIDENCE,
  CLAUDE_T04_PRIOR_EVIDENCE_HASH,
  CLAUDE_T04_ORIGINAL_CAMPAIGN_ID,
  CLAUDE_T04_RECOVERY_MARKER_ENV,
  CLAUDE_T04_RECOVERY_MARKER_VALUE,
  CLAUDE_T04_RECOVERY_CAMPAIGN_ID,
  CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY,
  CLAUDE_T04_RECOVERY_LEDGER_FILE,
  CLAUDE_T04_RECOVERY_OPT_IN_ENV,
  CLAUDE_T04_RECOVERY_SCENARIOS,
  ClaudeT04RecoveryError,
  prepareClaudeT04RecoveryCampaign,
  runClaudeT04RecoveryCampaign,
  reserveClaudeT04RecoveryCampaign,
} from './claude-live-recovery';
import { hashClaudeLiveId } from './claude-live-wire';
import { captureClaudeExecutableEvidence, type ClaudeMetadataProbeResult } from './claude-probe';
import type { ClaudeProtocolCommand, ClaudeProtocolProcess } from './claude-protocol';
import { BoundedResourceScope } from './process-cleanup';

let workspace: ClaudeOwnedWorkspace | undefined;
const initialOptIn = process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV];
const initialMarker = process.env[CLAUDE_T04_RECOVERY_MARKER_ENV];
const initialLiveOptIn = process.env[CLAUDE_LIVE_PROBE_ENV];
const initialLiveMarker = process.env[CLAUDE_LIVE_MARKER_ENV];

afterEach(async () => {
  await workspace?.cleanup();
  workspace = undefined;
  if (initialOptIn === undefined) delete process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV];
  else process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV] = initialOptIn;
  if (initialMarker === undefined) delete process.env[CLAUDE_T04_RECOVERY_MARKER_ENV];
  else process.env[CLAUDE_T04_RECOVERY_MARKER_ENV] = initialMarker;
  if (initialLiveOptIn === undefined) delete process.env[CLAUDE_LIVE_PROBE_ENV];
  else process.env[CLAUDE_LIVE_PROBE_ENV] = initialLiveOptIn;
  if (initialLiveMarker === undefined) delete process.env[CLAUDE_LIVE_MARKER_ENV];
  else process.env[CLAUDE_LIVE_MARKER_ENV] = initialLiveMarker;
});

function authorize(): void {
  process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV] = '1';
  process.env[CLAUDE_T04_RECOVERY_MARKER_ENV] = CLAUDE_T04_RECOVERY_MARKER_VALUE;
  process.env[CLAUDE_LIVE_PROBE_ENV] = '1';
  process.env[CLAUDE_LIVE_MARKER_ENV] = CLAUDE_LIVE_MARKER_VALUE;
}

class RecoveryFakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  readonly stdin: Writable;
  private closed = false;

  constructor(command: ClaudeProtocolCommand, options: Readonly<{ readonly omitSessionInit?: boolean; readonly malformedAfterUser?: boolean }> = {}) {
    super();
    const sessionId = command.argv[command.argv.indexOf('--session-id') + 1] ?? '00000000-0000-4000-8000-000000000001';
    const structured = command.argv.includes('--json-schema');
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const raw of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(raw) as { type?: string; request_id?: string; request?: { subtype?: string } };
          if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
            this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } } });
          } else if (frame.type === 'user') {
            if (options.omitSessionInit) {
              this.finish(1);
              return;
            }
            this.emitLine({ type: 'system', subtype: 'init', session_id: sessionId });
            if (options.malformedAfterUser) {
              this.emitLine({ type: 'unsupported_after_user', session_id: sessionId });
              this.finish(1);
              return;
            }
            if (structured) {
              this.emitLine({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, structured_output: { probe: 'LIVE_STRUCTURED_OK' } });
            } else {
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'recovery-message', type: 'message', role: 'assistant', content: [] } } });
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'counting 1' } } });
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 0 } });
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } });
              this.emitLine({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } });
            }
          } else if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
            this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [], cancelled: [] } } });
            this.emitLine({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true, errors: ['aborted'], terminal_reason: 'aborted_streaming' });
          }
        }
        callback();
      },
      final: callback => {
        this.finish(0);
        callback();
      },
    });
  }

  kill(): boolean {
    this.finish(null);
    return true;
  }

  private emitLine(value: unknown): void {
    if (!this.closed) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  private finish(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code));
  }
}

async function createRecoveryDryOptions(prefix: string): Promise<ClaudeLiveProbeOptions> {
  workspace = await createClaudeOwnedWorkspace({ prefix });
  const executable = join(workspace.root, 'claude');
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const profile = buildClaudeLaunchProfile({
    paths: workspace.paths,
    executable,
    mcpServers: { fixture: { type: 'http', url: 'http://127.0.0.1:43123/mcp' } },
    authStatusRaw: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
    versionStatusRaw: 'Claude Code 9.9.9',
  });
  await materializeClaudeMcpConfig(profile, { workspace });
  const executableEvidence = await captureClaudeExecutableEvidence(executable);
  const metadataProbe = async ({ command }: { command: 'version' | 'auth-status' }): Promise<ClaudeMetadataProbeResult> =>
    command === 'version'
      ? { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, versionEvidence: { available: true, version: '9.9.9', exitCode: 0 } }
      : { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', exitCode: 0, blocked: false } };
  return {
    profile,
    workspace,
    executableEvidence,
    executionMode: 'dry-simulated',
    metadataProbe,
    protocolProcessRunner: (_scope: BoundedResourceScope, command: ClaudeProtocolCommand): ClaudeProtocolProcess => ({
      child: new RecoveryFakeChild(command) as unknown as ClaudeProtocolProcess['child'],
      command,
      ownership: 'bounded-resource-scope-process-group',
    }),
  };
}

describe('T04 replacement recovery campaign', () => {
  it('uses a distinct immutable campaign and accidental-spawn marker', () => {
    expect(CLAUDE_T04_RECOVERY_CAMPAIGN_ID).not.toContain('original');
    expect(CLAUDE_T04_RECOVERY_CAMPAIGN_ID).not.toBe(CLAUDE_T04_ORIGINAL_CAMPAIGN_ID);
    expect(CLAUDE_T04_RECOVERY_LEDGER_FILE).not.toBe(CLAUDE_LIVE_LEDGER_FILE);
    expect(CLAUDE_T04_RECOVERY_MARKER_ENV).not.toBe(CLAUDE_LIVE_MARKER_ENV);
    expect(Object.isFrozen(CLAUDE_T04_RECOVERY_SCENARIOS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_T04_RECOVERY_SCENARIOS['structured-replacement'])).toBe(true);
    expect(Object.isFrozen(CLAUDE_T04_RECOVERY_SCENARIOS['structured-replacement'].jsonSchema)).toBe(true);
    expect(() => ((CLAUDE_T04_RECOVERY_SCENARIOS['structured-replacement'] as unknown as { maxTurns: number }).maxTurns = 8)).toThrow();
  });

  it('pre-seeds the durable four-turn baseline and writes only sanitized prior evidence', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-baseline-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const snapshot = await campaign.ledger.snapshot();
    expect(snapshot).toMatchObject({
      campaignId: CLAUDE_T04_RECOVERY_CAMPAIGN_ID,
      baselineConsumedTurns: 4,
      consumedTurns: 4,
      priorEvidenceHash: CLAUDE_T04_PRIOR_EVIDENCE_HASH,
      reservations: [],
    });
    expect(snapshot.baseline).toEqual(CLAUDE_T04_PRIOR_EVIDENCE);
    expect(snapshot.baseline.turns[0]).toMatchObject({ label: 'T1', sessionIdHash: 'af25eef3600d3c12', evidence: ['stream', 'final'] });
    expect(snapshot.baseline.turns[1]).toMatchObject({ label: 'T2', sessionIdHash: 'af25eef3600d3c12', status: 'completed' });
    expect(snapshot.baseline.turns[2]).toMatchObject({ label: 'T3', targetSessionIdHash: 'cfc907152ffeef46', distinctFork: true });
    expect(snapshot.baseline.turns[3]).toMatchObject({ label: 'T4', outcome: 'unknown_after_dispatch', status: 'unknown-recovery', failure: 'protocol-invalid' });
    expect(snapshot.baseline.turns[4]).toMatchObject({ label: 'T5', status: 'unattempted' });
    const evidence = await readFile(`${workspace.root}/${CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY}/prior-live-evidence.json`, 'utf8');
    expect(JSON.parse(evidence)).toEqual(CLAUDE_T04_PRIOR_EVIDENCE);
    expect(evidence).not.toMatch(/prompt|email|organization|token|authorization|secret|pid/i);
    expect(await readFile(`${workspace.root}/${CLAUDE_T04_RECOVERY_LEDGER_FILE}`, 'utf8')).toContain(CLAUDE_T04_PRIOR_EVIDENCE_HASH);
    expect(await readFile(`${workspace.root}/${CLAUDE_LIVE_LEDGER_FILE}`, 'utf8').catch(() => undefined)).toBeUndefined();
  });

  it('reserves only structured replacement then cancellation, with no replay', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-reserve-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const reservations = await reserveClaudeT04RecoveryCampaign(campaign);
    expect(reservations.map(item => item.scenario)).toEqual(['structured-replacement', 'cancellation']);
    expect((await campaign.ledger.snapshot()).consumedTurns).toBe(6);
    const structured = await campaign.ledger.start(reservations[0]);
    await campaign.ledger.complete(structured, { status: 'completed', outcome: 'completed' });
    const cancellation = await campaign.ledger.start(reservations[1]);
    await campaign.ledger.complete(cancellation, { status: 'not-exercised', outcome: 'not_started' });
    await expect(campaign.ledger.reserve('cancellation')).rejects.toMatchObject({ code: 'scenario-invalid' });
    await expect(campaign.ledger.start(reservations[1])).rejects.toMatchObject({ code: 'ledger-invalid' });
    const snapshot = await campaign.ledger.snapshot();
    expect(snapshot.reservations.map(item => item.status)).toEqual(['completed', 'not-exercised']);
    expect(snapshot.consumedTurns).toBe(6);
  });

  it('rejects a third recovery reservation even after both named scenarios finish', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-third-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const reservations = await reserveClaudeT04RecoveryCampaign(campaign);
    const structured = await campaign.ledger.start(reservations[0]);
    await campaign.ledger.complete(structured, { status: 'completed', outcome: 'completed' });
    const cancellation = await campaign.ledger.start(reservations[1]);
    await campaign.ledger.complete(cancellation, { status: 'not-exercised', outcome: 'not_started' });
    await expect(campaign.ledger.reserve('cancellation')).rejects.toMatchObject({ code: 'scenario-invalid' });
    expect((await campaign.ledger.snapshot()).reservations).toHaveLength(2);
  });

  it('rejects a forged or spread-cloned campaign before metadata probing or child spawn', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-forged-campaign-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    let metadataCalls = 0;
    let spawnCalls = 0;
    const guardedOptions: ClaudeLiveProbeOptions = {
      ...options,
      metadataProbe: async input => {
        metadataCalls += 1;
        return options.metadataProbe!(input);
      },
      protocolProcessRunner: (scope, command) => {
        spawnCalls += 1;
        return options.protocolProcessRunner!(scope, command);
      },
    };
    const forgedCampaign = { ...campaign };
    await expect(runClaudeT04RecoveryCampaign(guardedOptions, forgedCampaign)).rejects.toMatchObject({ code: 'scenario-invalid' });
    expect(metadataCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect((await campaign.ledger.snapshot()).reservations).toHaveLength(0);
  });

  it('exposes only the whole recovery executor, never a per-turn dispatch function', () => {
    expect('runClaudeT04RecoveryCampaign' in claudeLiveRecoveryModule).toBe(true);
    expect('runClaudeT04RecoveryTurn' in claudeLiveRecoveryModule).toBe(false);
  });

  it('rejects wrong order and refuses a zero or tampered baseline', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-integrity-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    await expect(campaign.ledger.reserve('cancellation')).rejects.toMatchObject({ code: 'scenario-invalid' });
    const valid = await campaign.ledger.snapshot();
    await writeFile(campaign.ledger.path, JSON.stringify({ ...valid, consumedTurns: 0 }), { mode: 0o600 });
    await expect(campaign.ledger.snapshot()).rejects.toMatchObject({ code: 'ledger-invalid' });
    await writeFile(campaign.ledger.path, JSON.stringify({ ...valid, priorEvidenceHash: '0000000000000000' }), { mode: 0o600 });
    await expect(campaign.ledger.snapshot()).rejects.toMatchObject({ code: 'ledger-invalid' });
  });

  it('rejects symlinked or non-private fixture directories before any outside write', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-fixture-dir-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const fixturesDirectory = join(workspace.root, CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY);
    const outside = await mkdtemp(join(tmpdir(), 'mastra-recovery-outside-'));
    try {
      await rm(fixturesDirectory, { recursive: true, force: true });
      await symlink(outside, fixturesDirectory, 'dir');
      await expect(campaign.ledger.writePriorEvidenceFixture()).rejects.toMatchObject({ code: 'fixture-invalid' });
      await expect(readFile(join(outside, 'prior-live-evidence.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await rm(fixturesDirectory, { recursive: true, force: true });
      await mkdir(fixturesDirectory, { mode: 0o700 });
      await chmod(fixturesDirectory, 0o755);
      await expect(campaign.ledger.writePriorEvidenceFixture()).rejects.toMatchObject({ code: 'fixture-invalid' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('requires explicit structured completion before starting or completing cancellation', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-order-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const [structured, cancellation] = await reserveClaudeT04RecoveryCampaign(campaign);

    await expect(campaign.ledger.start(cancellation)).rejects.toMatchObject({ code: 'scenario-invalid' });
    await expect(campaign.ledger.complete(cancellation as never, { status: 'completed', outcome: 'completed' })).rejects.toMatchObject({ code: 'ledger-invalid' });

    const activeStructured = await campaign.ledger.start(structured);
    await campaign.ledger.complete(activeStructured, { status: 'unknown-recovery', outcome: 'unknown_after_dispatch' });
    await expect(campaign.ledger.start(cancellation)).rejects.toMatchObject({ code: 'scenario-invalid' });
  });

  it('rejects failed terminal recovery records without a pre-start outcome', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-failed-outcome-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const [structured] = await reserveClaudeT04RecoveryCampaign(campaign);
    const running = await campaign.ledger.start(structured);

    await expect(campaign.ledger.complete(running, { status: 'failed', failureCode: 'scenario-invalid' })).rejects.toMatchObject({ code: 'ledger-invalid' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'running' });
  });

  it('rejects reserved or running completion statuses without changing the running reservation', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-terminal-status-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const [reserved] = await reserveClaudeT04RecoveryCampaign(campaign);
    const running = await campaign.ledger.start(reserved);

    await expect(campaign.ledger.complete(running, { status: 'reserved' } as never)).rejects.toMatchObject({ code: 'ledger-invalid' });
    await expect(campaign.ledger.complete(running, { status: 'running' } as never)).rejects.toMatchObject({ code: 'ledger-invalid' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'running' });

    await campaign.ledger.complete(running, { status: 'completed', outcome: 'completed' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'completed', outcome: 'completed' });
  });

  it('fails closed for same-instance reentry and preserves one-writer concurrency', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-lock-' });
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const privateLedger = campaign.ledger as unknown as {
      withLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    await expect(privateLedger.withLock(() => campaign.ledger.reserve('structured-replacement'))).rejects.toMatchObject({ code: 'ledger-locked' });

    const results = await Promise.allSettled([
      campaign.ledger.reserve('structured-replacement'),
      campaign.ledger.reserve('structured-replacement'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await campaign.ledger.snapshot()).reservations).toHaveLength(1);
    for (const result of results.filter(result => result.status === 'rejected')) {
      expect(['ledger-locked', 'scenario-invalid']).toContain((result as PromiseRejectedResult).reason.code);
    }
  });

  it('requires both recovery opt-in values before creating a campaign', async () => {
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-guard-' });
    await expect(prepareClaudeT04RecoveryCampaign(workspace)).rejects.toMatchObject({ code: 'opt-in-required' });
    process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV] = '1';
    await expect(prepareClaudeT04RecoveryCampaign(workspace)).rejects.toBeInstanceOf(ClaudeT04RecoveryError);
  });

  it('executes ordered recovery reservations through the shared dry live machinery and records identity/version/session binding', async () => {
    authorize();
    workspace = await createClaudeOwnedWorkspace({ prefix: 'mastra-recovery-executor-' });
    const executable = join(workspace.root, 'claude');
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    const profile = buildClaudeLaunchProfile({
      paths: workspace.paths,
      executable,
      mcpServers: { fixture: { type: 'http', url: 'http://127.0.0.1:43123/mcp' } },
      authStatusRaw: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
      versionStatusRaw: 'Claude Code 9.9.9',
    });
    await materializeClaudeMcpConfig(profile, { workspace });
    const executableEvidence = await captureClaudeExecutableEvidence(executable);
    const metadataProbe = async ({ command }: { command: 'version' | 'auth-status' }): Promise<ClaudeMetadataProbeResult> =>
      command === 'version'
        ? { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, versionEvidence: { available: true, version: '9.9.9', exitCode: 0 } }
        : { command, ok: true, exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, authEvidence: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', exitCode: 0, blocked: false } };
    const options: ClaudeLiveProbeOptions = {
      profile,
      workspace,
      executableEvidence,
      executionMode: 'dry-simulated',
      metadataProbe,
      protocolProcessRunner: (_scope: BoundedResourceScope, command: ClaudeProtocolCommand): ClaudeProtocolProcess => ({
        child: new RecoveryFakeChild(command) as unknown as ClaudeProtocolProcess['child'],
        command,
        ownership: 'bounded-resource-scope-process-group',
      }),
    };
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace);
    const results = await runClaudeT04RecoveryCampaign(options, campaign);
    expect(results.map(item => item.recoveryScenario)).toEqual(['structured-replacement', 'cancellation']);
    expect(results[0]?.result).toMatchObject({ status: 'completed', outcome: 'completed', claudeVersion: '9.9.9' });
    expect(results[1]?.result).toMatchObject({ status: 'aborted', dispatch: 'completed', claudeVersion: '9.9.9' });
    expect(results[0]?.result.sessionIdHash).toBeDefined();
    expect(results[1]?.result.sessionIdHash).toBeDefined();
    const snapshot = await campaign.ledger.snapshot();
    expect(snapshot.reservations).toMatchObject([
      { status: 'completed', outcome: 'completed', claudeVersion: '9.9.9', executableIdentity: { realpath: executable }, fixtureFile: 'recovery-structured-replacement.json', sessionIdHash: results[0]?.result.sessionIdHash },
      { status: 'aborted', outcome: 'unknown_after_dispatch', claudeVersion: '9.9.9', executableIdentity: { realpath: executable }, fixtureFile: 'recovery-cancellation.json', sessionIdHash: results[1]?.result.sessionIdHash },
    ]);
    for (const reservation of snapshot.reservations) {
      const fixture = JSON.parse(await readFile(join(workspace!.root, CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY, reservation.fixtureFile!), 'utf8')) as { sessionIdHash?: string };
      expect(fixture.sessionIdHash).toBe(reservation.sessionIdHash);
    }
    expect(snapshot.consumedTurns).toBe(6);
  });

  it('preserves a completed provider classification when recovery fixture persistence fails', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-fixture-persist-complete-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    const injectedLedger = campaign.ledger as unknown as {
      writeFixture: (...args: Parameters<typeof campaign.ledger.writeFixture>) => ReturnType<typeof campaign.ledger.writeFixture>;
    };
    injectedLedger.writeFixture = async () => {
      throw new ClaudeLiveProbeError('fixture-invalid', 'injected fixture persistence failure');
    };

    const result = (await runClaudeT04RecoveryCampaign(options, campaign))[0]!;
    expect(result.result).toMatchObject({ status: 'completed', outcome: 'completed', dispatch: 'completed', fixturePersistenceFailureCode: 'fixture-invalid' });
    expect(result.result.failureCode).toBeUndefined();
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      fixturePersistenceFailureCode: 'fixture-invalid',
    });
  });

  it('preserves unknown-after-dispatch classification when recovery fixture persistence fails after a protocol error', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-fixture-persist-unknown-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    const injectedLedger = campaign.ledger as unknown as {
      writeFixture: (...args: Parameters<typeof campaign.ledger.writeFixture>) => ReturnType<typeof campaign.ledger.writeFixture>;
    };
    injectedLedger.writeFixture = async () => {
      throw new ClaudeLiveProbeError('fixture-invalid', 'injected fixture persistence failure');
    };
    const malformedOptions: ClaudeLiveProbeOptions = {
      ...options,
      protocolProcessRunner: (_scope, command) => ({
        child: new RecoveryFakeChild(command, { malformedAfterUser: true }) as unknown as ClaudeProtocolProcess['child'],
        command,
        ownership: 'bounded-resource-scope-process-group',
      }),
    };

    const result = (await runClaudeT04RecoveryCampaign(malformedOptions, campaign))[0]!;
    expect(result.result).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', fixturePersistenceFailureCode: 'fixture-invalid', failureCode: 'protocol-invalid' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({
      status: 'unknown-recovery',
      outcome: 'unknown_after_dispatch',
      fixturePersistenceFailureCode: 'fixture-invalid',
      failureCode: 'protocol-invalid',
    });
  });

  it('finalizes a pre-spawn failure as failed before start without dispatch', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-command-prestart-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    let spawnCalls = 0;
    const commandOptions: ClaudeLiveProbeOptions = {
      ...options,
      protocolProcessRunner: (scope, command) => {
        spawnCalls += 1;
        void scope;
        void command;
        throw new ClaudeLiveProbeError('spawn-failed', 'injected pre-spawn failure');
      },
    };

    const result = (await runClaudeT04RecoveryCampaign(commandOptions, campaign))[0]!;
    expect(spawnCalls).toBe(1);
    expect(result.result).toMatchObject({ status: 'failed', outcome: 'failed_before_start', dispatch: 'not_started', failureCode: 'spawn-failed' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'failed', outcome: 'failed_before_start', failureCode: 'spawn-failed' });
  });

  it('reconciles a terminal recovery-ledger persistence failure as unknown after dispatch', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-terminal-persist-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    const originalComplete = campaign.ledger.complete.bind(campaign.ledger);
    let injectFailure = true;
    const injectedLedger = campaign.ledger as unknown as { complete: typeof campaign.ledger.complete };
    injectedLedger.complete = async (running, update) => {
      if (injectFailure) {
        injectFailure = false;
        throw new ClaudeT04RecoveryError('ledger-invalid', 'injected terminal completion persistence failure');
      }
      return originalComplete(running, update);
    };

    await expect(runClaudeT04RecoveryCampaign(options, campaign)).rejects.toMatchObject({ code: 'ledger-invalid' });
    const snapshot = await campaign.ledger.snapshot();
    expect(snapshot.reservations[0]).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', failureCode: 'ledger-invalid' });
    expect(snapshot.reservations[0]?.outcome).not.toBe('failed_before_start');
  });

  it('prebinds the session hash before an early-init crash and rejects a mismatched completion', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-session-binding-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    let runningRecord: { status?: string; sessionIdHash?: string } | undefined;
    let commandSessionId: string | undefined;
    const crashOptions: ClaudeLiveProbeOptions = {
      ...options,
      protocolProcessRunner: (_scope, command) => {
        commandSessionId = command.argv[command.argv.indexOf('--session-id') + 1];
        runningRecord = (JSON.parse(readFileSync(campaign.ledger.path, 'utf8')) as { reservations?: Array<{ status?: string; sessionIdHash?: string }> }).reservations?.[0];
        return {
          child: new RecoveryFakeChild(command, { omitSessionInit: true }) as unknown as ClaudeProtocolProcess['child'],
          command,
          ownership: 'bounded-resource-scope-process-group',
        };
      },
    };

    const result = (await runClaudeT04RecoveryCampaign(crashOptions, campaign))[0]!;
    expect(commandSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(runningRecord).toMatchObject({ status: 'running', sessionIdHash: hashClaudeLiveId(commandSessionId!) });
    expect(result.result).toMatchObject({ status: 'unknown-recovery', outcome: 'unknown_after_dispatch', sessionIdHash: runningRecord?.sessionIdHash });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({
      status: 'unknown-recovery',
      outcome: 'unknown_after_dispatch',
      sessionIdHash: runningRecord?.sessionIdHash,
    });
  });

  it('rejects a recovery completion whose session hash differs from the prebound running record', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-session-mismatch-');
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    const expectedSessionIdHash = hashClaudeLiveId('00000000-0000-4000-8000-000000000002');
    const [structured] = await reserveClaudeT04RecoveryCampaign(campaign);
    const running = await campaign.ledger.start(structured, {
      executable: {
        realpath: options.executableEvidence.realpath,
        uid: options.executableEvidence.uid,
        dev: options.executableEvidence.dev,
        ino: options.executableEvidence.ino,
        mode: options.executableEvidence.mode,
      },
      claudeVersion: '9.9.9',
      sessionIdHash: expectedSessionIdHash,
    });

    await expect(
      campaign.ledger.complete(running, {
        status: 'unknown-recovery',
        outcome: 'unknown_after_dispatch',
        sessionIdHash: hashClaudeLiveId('00000000-0000-4000-8000-000000000001'),
      }),
    ).rejects.toMatchObject({ code: 'ledger-invalid' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'running', sessionIdHash: expectedSessionIdHash });
  });

  it('finalizes a first version-probe failure before spawning a provider process', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-version-prestart-');
    const initialMetadataProbe = options.metadataProbe!;
    let metadataCalls = 0;
    let spawnCalls = 0;
    const preStartOptions: ClaudeLiveProbeOptions = {
      ...options,
      metadataProbe: async input => {
        metadataCalls += 1;
        if (metadataCalls === 1) throw new Error('injected first version-probe failure');
        return initialMetadataProbe(input);
      },
      protocolProcessRunner: (scope, command) => {
        spawnCalls += 1;
        return options.protocolProcessRunner!(scope, command);
      },
    };
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    await expect(runClaudeT04RecoveryCampaign(preStartOptions, campaign)).rejects.toMatchObject({ code: 'profile-not-ready' });
    expect(metadataCalls).toBe(1);
    expect(spawnCalls).toBe(0);
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'failed', outcome: 'failed_before_start', failureCode: 'profile-not-ready' });
  });

  it('keeps a genuine pre-dispatch failure classified as failed before start', async () => {
    authorize();
    const options = await createRecoveryDryOptions('mastra-recovery-prestart-');
    const initialMetadataProbe = options.metadataProbe!;
    let metadataCalls = 0;
    const preStartOptions: ClaudeLiveProbeOptions = {
      ...options,
      metadataProbe: async input => {
        metadataCalls += 1;
        if (metadataCalls === 3) throw new Error('injected pre-dispatch metadata failure');
        return initialMetadataProbe(input);
      },
    };
    const campaign = await prepareClaudeT04RecoveryCampaign(workspace!);
    await expect(runClaudeT04RecoveryCampaign(preStartOptions, campaign)).rejects.toMatchObject({ code: 'profile-not-ready' });
    expect((await campaign.ledger.snapshot()).reservations[0]).toMatchObject({ status: 'failed', outcome: 'failed_before_start' });
  });
});
