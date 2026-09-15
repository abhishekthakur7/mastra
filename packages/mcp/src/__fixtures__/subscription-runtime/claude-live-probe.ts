/**
 * Opt-in, authenticated Claude protocol probe.
 *
 * This module is intentionally separate from the offline protocol fixture and
 * metadata probe. It admits only a small fixed set of harmless prompts,
 * launches the exact strict profile, and records bounded sanitized evidence.
 * Nothing in this module
 * discovers credentials or accepts a caller-supplied prompt/tool/config.
 */

import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readFile, unlink, mkdir, lstat, realpath, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  type ClaudeLaunchProfile,
  type ClaudeOwnedWorkspace,
  parseClaudeVersion,
  validateClaudeLaunchProfileEnvironment,
  validateClaudeLaunchProfilePaths,
} from './claude-launch-profile';
import {
  assertPreparedClaudeT04RecoveryCampaign,
  assertPreparedClaudeT04RecoveryReservation,
  assertRecoveryOptIn,
  CLAUDE_T04_RECOVERY_CAMPAIGN_ID,
  ClaudeT04RecoveryError,
  reserveClaudeT04RecoveryCampaign,
} from './claude-live-recovery';
import type {
  ClaudeT04RecoveryCampaign,
  ClaudeT04RecoveryReservation,
  ClaudeT04RecoveryScenario,
  ClaudeT04RecoveryStatus,
  ClaudeT04RecoveryTurnResult,
} from './claude-live-recovery';
import { ClaudeLiveWireAdapter, ClaudeLiveWireError, hashClaudeLiveId, type ClaudeLiveWireMarker } from './claude-live-wire';
import { captureClaudeExecutableEvidence, runClaudeMetadataProbe } from './claude-probe';
import type { ClaudeExecutableEvidence } from './claude-probe';
import {
  buildClaudeForkCommand,
  buildClaudeCancelCommand,
  buildClaudeProtocolCommand,
  buildClaudeResumeCommand,
  type ClaudeProtocolCommand,
  spawnClaudeProtocolProcess,
  type ClaudeProtocolProcess,
} from './claude-protocol';
import { BoundedResourceScope } from './process-cleanup';
import { FixtureRedactor } from './redactor';
import type { JsonValue } from './types';

export const CLAUDE_LIVE_PROBE_ENV = 'RUN_CLAUDE_PROTOCOL_LIVE_PROBE';
export const CLAUDE_LIVE_PROBE_OPT_IN = '1';
/** A second, exact operator acknowledgement is required before any child spawn. */
/** Source-visible marker used only to prevent accidental live spawning. */
export const CLAUDE_LIVE_MARKER_ENV = 'CLAUDE_T04_LIVE_MARKER';
export const CLAUDE_LIVE_MARKER_VALUE = 'RUN_T04_CLAUDE_PROTOCOL_LIVE_PROBE';
export const CLAUDE_LIVE_LEDGER_FILE = '.t04-claude-live-ledger.json';
export const CLAUDE_LIVE_FIXTURES_DIRECTORY = '.t04-claude-live-fixtures';
export const CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION = 1;

const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const MAX_TURN_TIMEOUT_MS = 30_000;
const INIT_DEADLINE_MS = 5_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_FIXTURE_BYTES = 512 * 1024;
const MAX_LEDGER_BYTES = 128 * 1024;
const MAX_SCENARIO_LABEL_LENGTH = 64;
const SCENARIO_LABEL = /^[a-z][a-z0-9-]{0,63}$/;
/** Claude session IDs accepted from callers are canonical UUIDs only. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The only live scenarios admitted by this fixture. */
export const CLAUDE_LIVE_SCENARIOS = deepFreeze({
  't1-start': {
    action: 'start',
    maxTurns: 1,
    prompt: 'Reply with exactly LIVE_TEXT_OK and do not call any tools.',
    textMarker: 'LIVE_TEXT_OK',
  },
  't2-resume': {
    action: 'resume',
    maxTurns: 1,
    prompt: 'Reply with exactly LIVE_RESUME_OK and do not call any tools.',
    textMarker: 'LIVE_RESUME_OK',
  },
  't3-fork': {
    action: 'fork',
    maxTurns: 1,
    prompt: 'Reply with exactly LIVE_FORK_OK and do not call any tools.',
    textMarker: 'LIVE_FORK_OK',
  },
  't4-structured': {
    action: 'start',
    maxTurns: 1,
    prompt: 'Return the structured value required by the supplied schema. Do not call any tools.',
    textMarker: 'LIVE_STRUCTURED_OK',
    jsonSchema: {
      type: 'object',
      properties: { probe: { type: 'string', enum: ['LIVE_STRUCTURED_OK'] } },
      required: ['probe'],
      additionalProperties: false,
    },
  },
  't5-cancel': {
    action: 'start',
    maxTurns: 1,
    prompt: 'Begin a long harmless response by counting slowly from one to one hundred. Do not call any tools.',
    textMarker: undefined,
  },
} as const);

export type ClaudeLiveScenario = keyof typeof CLAUDE_LIVE_SCENARIOS;
export type ClaudeLiveAction = (typeof CLAUDE_LIVE_SCENARIOS)[ClaudeLiveScenario]['action'];

export type ClaudeLiveProbeErrorCode =
  | 'opt-in-required'
  | 'ledger-invalid'
  | 'ledger-locked'
  | 'workspace-invalid'
  | 'profile-invalid'
  | 'profile-not-ready'
  | 'executable-invalid'
  | 'scenario-invalid'
  | 'session-invalid'
  | 'fixture-invalid'
  | 'turn-timeout'
  | 'turn-aborted'
  | 'spawn-failed'
  | 'protocol-invalid'
  | 'output-limit'
  | 'cleanup-failed';

export class ClaudeLiveProbeError extends Error {
  readonly code: ClaudeLiveProbeErrorCode;

  constructor(code: ClaudeLiveProbeErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeLiveProbeError';
    this.code = code;
  }
}

type LiveLedgerRecord = {
  readonly turnId: string;
  readonly index: number;
  readonly reservationTurns: number;
  readonly scenario: ClaudeLiveScenario;
  readonly action: ClaudeLiveAction;
  /** Exact version observed immediately before this provider turn. */
  readonly claudeVersion?: string;
  readonly status: 'reserved' | 'completed' | 'failed' | 'unknown-recovery' | 'aborted' | 'timed-out' | 'not-exercised';
  readonly outcome?: 'not_started' | 'completed' | 'failed_before_start' | 'unknown_after_dispatch';
  readonly reservedAt: string;
  readonly completedAt?: string;
  readonly sessionIdHash?: string;
  readonly fixtureFile?: string;
  readonly eventCount?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly failureCode?: ClaudeLiveProbeErrorCode;
  /** Fixture persistence is reported separately from provider outcome. */
  readonly fixturePersistenceFailureCode?: 'fixture-invalid' | 'output-limit';
  readonly wireDiagnostic?: ClaudeLiveWireDiagnostic;
};

type LiveLedgerDocument = {
  readonly schemaVersion: typeof CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION;
  /** Historical campaign metadata; it is not an application call quota. */
  readonly maxTurns: number;
  readonly consumedTurns: number;
  readonly records: readonly LiveLedgerRecord[];
};

type LivePathIdentity = { readonly dev: number; readonly ino: number };

export type ClaudeLiveTurnReservation = {
  readonly turnId: string;
  readonly index: number;
  /** One bounded provider-turn budget slot is consumed per child process. */
  readonly reservationTurns: number;
  readonly scenario: ClaudeLiveScenario;
  readonly action: ClaudeLiveAction;
  /** Exact installed version observed before reserving this turn. */
  readonly claudeVersion?: string;
  /** Hash only; the raw UUID remains process-local. */
  readonly sessionIdHash?: string;
};

export type ClaudeLiveLedgerSnapshot = LiveLedgerDocument;

export type ClaudeLiveTurnCompletionUpdate = {
  status: Exclude<LiveLedgerRecord['status'], 'reserved'>;
  outcome?: LiveLedgerRecord['outcome'];
  claudeVersion?: string;
  sessionIdHash?: string;
  fixtureFile?: string;
  eventCount?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  failureCode?: ClaudeLiveProbeErrorCode;
  fixturePersistenceFailureCode?: 'fixture-invalid' | 'output-limit';
  wireDiagnostic?: ClaudeLiveWireDiagnostic;
};

/**
 * Persistent append-by-rewrite ledger. A reservation is consumed before a
 * child is spawned; a crash therefore cannot be retried silently. The lock is
 * an O_EXCL file inside the same opaque workspace and stale locks fail closed.
 */
export class ClaudeLiveTurnLedger {
  private readonly root: string;
  readonly path: string;
  readonly fixturesDirectory: string;
  private readonly lockPath: string;
  private lockHandle?: Awaited<ReturnType<typeof open>>;

  constructor(workspace: ClaudeOwnedWorkspace) {
    if (!workspace || typeof workspace.root !== 'string' || resolve(workspace.root) !== workspace.root) {
      throw new ClaudeLiveProbeError('workspace-invalid', 'live ledger requires a canonical owned workspace');
    }
    this.root = workspace.root;
    this.path = join(this.root, CLAUDE_LIVE_LEDGER_FILE);
    this.fixturesDirectory = join(this.root, CLAUDE_LIVE_FIXTURES_DIRECTORY);
    this.lockPath = `${this.path}.lock`;
  }

  async snapshot(): Promise<ClaudeLiveLedgerSnapshot> {
    return this.read();
  }

  async reserve(
    scenario: ClaudeLiveScenario,
    options: { readonly sessionIdHash?: string; readonly allowExistingSession?: boolean; readonly claudeVersion?: string } = {},
  ): Promise<ClaudeLiveTurnReservation> {
    return this.withLock(() => this.reserveLocked(scenario, options));
  }

  private async reserveLocked(
    scenario: ClaudeLiveScenario,
    options: { readonly sessionIdHash?: string; readonly allowExistingSession?: boolean; readonly claudeVersion?: string } = {},
  ): Promise<ClaudeLiveTurnReservation> {
    assertScenario(scenario);
    const document = await this.read();
    if (options.sessionIdHash !== undefined) assertHash(options.sessionIdHash);
    if (options.claudeVersion !== undefined && parseClaudeVersion(options.claudeVersion) !== options.claudeVersion) {
      throw new ClaudeLiveProbeError('profile-not-ready', 'live Claude version evidence is invalid');
    }
    if (options.sessionIdHash !== undefined && !options.allowExistingSession && document.records.some(record => record.sessionIdHash === options.sessionIdHash)) {
      throw new ClaudeLiveProbeError('session-invalid', 'live session ID collides with an existing ledger reservation');
    }
    if (options.sessionIdHash !== undefined && options.allowExistingSession) {
      const existingSession = document.records.find(record => record.sessionIdHash === options.sessionIdHash);
      if (existingSession === undefined || existingSession.claudeVersion !== options.claudeVersion) {
        throw new ClaudeLiveProbeError('session-invalid', 'live session version evidence is missing or incompatible');
      }
    }
    if (document.records.some(record => record.outcome === 'unknown_after_dispatch' || record.status === 'unknown-recovery')) {
      throw new ClaudeLiveProbeError('scenario-invalid', 'live ledger has an ambiguous dispatch; refusing replay');
    }
    if (scenario === 't5-cancel') assertStructuredTurnComplete(document);
    const reservationTurns = liveReservationTurns(scenario);
    const index = document.consumedTurns + 1;
    const definition = CLAUDE_LIVE_SCENARIOS[scenario];
    const reservation: ClaudeLiveTurnReservation = {
      turnId: `turn-${index}`,
      index,
      reservationTurns,
      scenario,
      action: definition.action,
      ...(options.claudeVersion === undefined ? {} : { claudeVersion: options.claudeVersion }),
      ...(options.sessionIdHash === undefined ? {} : { sessionIdHash: options.sessionIdHash }),
    };
    const record: LiveLedgerRecord = {
      ...reservation,
      status: 'reserved',
      reservedAt: new Date().toISOString(),
      ...(options.sessionIdHash === undefined ? {} : { sessionIdHash: options.sessionIdHash }),
    };
    await this.write({ ...document, consumedTurns: document.consumedTurns + reservationTurns, records: [...document.records, record] });
    return reservation;
  }

  async complete(
    reservation: ClaudeLiveTurnReservation,
    update: ClaudeLiveTurnCompletionUpdate,
  ): Promise<void> {
    assertReservation(reservation);
    assertLiveTerminalInvariant(update.status, update.outcome);
    if (update.status === 'completed' && update.failureCode !== undefined) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'completed live turns cannot carry a failure code');
    }
    if (update.sessionIdHash !== undefined) assertHash(update.sessionIdHash);
    if (update.fixtureFile !== undefined) assertFixtureFileName(update.fixtureFile);
    if (update.fixturePersistenceFailureCode !== undefined && update.fixturePersistenceFailureCode !== 'fixture-invalid' && update.fixturePersistenceFailureCode !== 'output-limit') {
      throw new ClaudeLiveProbeError('ledger-invalid', 'fixture persistence failure code is invalid');
    }
    return this.withLock(() => this.completeLocked(reservation, update));
  }

  private async completeLocked(
    reservation: ClaudeLiveTurnReservation,
    update: ClaudeLiveTurnCompletionUpdate,
  ): Promise<void> {
    const document = await this.read();
    const existing = document.records.find(record => record.turnId === reservation.turnId);
    if (
      !existing ||
      existing.index !== reservation.index ||
      existing.reservationTurns !== reservation.reservationTurns ||
      existing.scenario !== reservation.scenario
    ) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn reservation is not present in the ledger');
    }
    if (existing.status !== 'reserved') {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn reservation was already finalized');
    }
    if (existing.sessionIdHash !== reservation.sessionIdHash) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn reservation session identity changed');
    }
    if (existing.sessionIdHash !== undefined && update.sessionIdHash !== undefined && update.sessionIdHash !== existing.sessionIdHash) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn completion session identity changed');
    }
    if (existing.claudeVersion !== reservation.claudeVersion) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn reservation version evidence changed');
    }
    if (update.claudeVersion !== undefined && update.claudeVersion !== reservation.claudeVersion) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn completion version evidence changed');
    }
    if (existing.scenario === 't5-cancel') assertStructuredTurnComplete(document);
    const records = document.records.map(record =>
      record.turnId === reservation.turnId
        ? {
            ...record,
            ...update,
            completedAt: new Date().toISOString(),
          }
        : record,
    );
    await this.write({ ...document, records });
  }

  /** Write one bounded sanitized fixture and return only its basename. */
  async writeFixture(reservation: ClaudeLiveTurnReservation, value: JsonValue): Promise<string> {
    return this.withLock(() => this.writeFixtureLocked(reservation, value));
  }

  private async writeFixtureLocked(reservation: ClaudeLiveTurnReservation, value: JsonValue): Promise<string> {
    assertReservation(reservation);
    const redactor = new FixtureRedactor({ maxDepth: 8, maxStringLength: 2_048, maxArrayItems: 100, maxObjectKeys: 100 });
    const fixture = redactor.redact(value) as JsonValue;
    const serialized = `${JSON.stringify(fixture)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FIXTURE_BYTES) {
      throw new ClaudeLiveProbeError('output-limit', 'sanitized live fixture exceeds its byte limit');
    }
    const directoryIdentity = await this.ensureFixtureDirectory();
    const filename = `${reservation.turnId}.json`;
    const path = join(this.fixturesDirectory, filename);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.assertFixtureDirectoryIdentity(directoryIdentity);
      handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ClaudeLiveProbeError('fixture-invalid', 'live fixture already exists for this turn');
      }
      if (error instanceof ClaudeLiveProbeError) throw error;
      throw new ClaudeLiveProbeError('fixture-invalid', 'live fixture could not be created safely');
    } finally {
      await handle?.close();
    }
    await this.assertFixtureDirectoryIdentity(directoryIdentity);
    let created: Awaited<ReturnType<typeof lstat>>;
    try {
      created = await lstat(path);
      if (
        created.isSymbolicLink() ||
        !created.isFile() ||
        (created.mode & 0o777) !== 0o600 ||
        !isOwnedByCurrentUser(created.uid) ||
        resolve(await realpath(path)) !== path
      ) {
        throw new ClaudeLiveProbeError('fixture-invalid', 'live fixture must be a private real file');
      }
    } catch (error) {
      if (error instanceof ClaudeLiveProbeError) throw error;
      throw new ClaudeLiveProbeError('fixture-invalid', 'live fixture could not be validated safely');
    }
    await this.assertFixtureDirectoryIdentity(directoryIdentity);
    return filename;
  }

  private async ensureFixtureDirectory(): Promise<LivePathIdentity> {
    await this.ensureWorkspaceRoot();
    try {
      await mkdir(this.fixturesDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ClaudeLiveProbeError('fixture-invalid', 'live fixtures directory could not be created safely');
      }
    }
    return this.readFixtureDirectoryIdentity();
  }

  private async readFixtureDirectoryIdentity(): Promise<LivePathIdentity> {
    try {
      const directory = await lstat(this.fixturesDirectory);
      if (
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        (directory.mode & 0o777) !== 0o700 ||
        !isOwnedByCurrentUser(directory.uid) ||
        resolve(await realpath(this.fixturesDirectory)) !== this.fixturesDirectory
      ) {
        throw new ClaudeLiveProbeError('fixture-invalid', 'live fixtures directory must be a private real directory');
      }
      return livePathIdentity(directory, 'live fixtures directory');
    } catch (error) {
      if (error instanceof ClaudeLiveProbeError) throw error;
      throw new ClaudeLiveProbeError('fixture-invalid', 'live fixtures directory could not be validated safely');
    }
  }

  private async assertFixtureDirectoryIdentity(expected: LivePathIdentity): Promise<void> {
    const actual = await this.readFixtureDirectoryIdentity();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new ClaudeLiveProbeError('fixture-invalid', 'live fixtures directory identity changed');
    }
  }

  private async read(): Promise<LiveLedgerDocument> {
    await this.ensureWorkspaceRoot();
    let text: string;
    try {
      const ledgerStat = await lstat(this.path);
      if (
        ledgerStat.isSymbolicLink() ||
        !ledgerStat.isFile() ||
        (ledgerStat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && ledgerStat.uid !== process.getuid()) ||
        resolve(await realpath(this.path)) !== this.path
      ) {
        throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger must be a private real file');
      }
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof ClaudeLiveProbeError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION, maxTurns: Object.keys(CLAUDE_LIVE_SCENARIOS).length, consumedTurns: 0, records: [] };
      }
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LEDGER_BYTES) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger is too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger is not valid JSON');
    }
    return validateLedgerDocument(parsed);
  }

  private async write(document: LiveLedgerDocument): Promise<void> {
    await this.ensureWorkspaceRoot();
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger is too large');
    let existingIdentity: LivePathIdentity | undefined;
    try {
      const existing = await lstat(this.path);
      if (
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        (existing.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && existing.uid !== process.getuid()) ||
        resolve(await realpath(this.path)) !== this.path
      ) {
        throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger must be a private real file');
      }
      existingIdentity = livePathIdentity(existing, 'live turn ledger');
    } catch (error) {
      if (error instanceof ClaudeLiveProbeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger could not be validated');
    }
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: LivePathIdentity | undefined;
    let renamed = false;
    try {
      handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      temporaryIdentity = livePathIdentity(await handle.stat(), 'temporary live turn ledger');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      const temporaryBeforeRename = await lstat(temporaryPath);
      if (!sameLivePathIdentity(temporaryIdentity, livePathIdentity(temporaryBeforeRename, 'temporary live turn ledger'))) {
        throw new ClaudeLiveProbeError('ledger-invalid', 'temporary live turn ledger identity changed before atomic commit');
      }

      // The run lock serializes trusted writers, while this identity check
      // preserves the existing fail-closed behavior if the destination is
      // replaced between validation and the atomic commit.
      try {
        const beforeRename = await lstat(this.path);
        if (
          existingIdentity === undefined ||
          !sameLivePathIdentity(existingIdentity, livePathIdentity(beforeRename, 'live turn ledger')) ||
          beforeRename.isSymbolicLink() ||
          !beforeRename.isFile() ||
          (beforeRename.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === 'function' && beforeRename.uid !== process.getuid()) ||
          resolve(await realpath(this.path)) !== this.path
        ) {
          throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger identity changed before atomic commit');
        }
      } catch (error) {
        if (error instanceof ClaudeLiveProbeError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existingIdentity !== undefined) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger changed before atomic commit');
      }
      await rename(temporaryPath, this.path);
      renamed = true;
      const committed = await lstat(this.path);
      if (
        committed.isSymbolicLink() ||
        !committed.isFile() ||
        (committed.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && committed.uid !== process.getuid()) ||
        resolve(await realpath(this.path)) !== this.path
      ) {
        throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger failed post-commit identity validation');
      }
      const directory = await open(this.root, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!renamed && temporaryIdentity !== undefined) {
        try {
          const temporary = await lstat(temporaryPath);
          if (sameLivePathIdentity(temporaryIdentity, livePathIdentity(temporary, 'temporary live turn ledger'))) await unlink(temporaryPath);
        } catch {
          // The temporary path may have been replaced; never remove an
          // artifact whose identity can no longer be tied to this writer.
        }
      }
      if (error instanceof ClaudeLiveProbeError) throw error;
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger could not be persisted atomically');
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockHandle !== undefined) throw new ClaudeLiveProbeError('ledger-locked', 'live turn ledger lock is non-reentrant');
    await this.ensureWorkspaceRoot();
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(this.lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ClaudeLiveProbeError('ledger-locked', 'live turn ledger is locked; refusing concurrent use');
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /**
   * Run a provider turn while retaining the ledger lock for its complete
   * lifecycle. The callback receives only operations that are explicitly
   * intended to run under that lock; ordinary ledger methods remain
   * non-reentrant and fail closed.
   */
  async withExclusive<T>(operation: (ledger: ClaudeLiveLedgerExclusive) => Promise<T>): Promise<T> {
    const release = await this.acquireExclusive();
    try {
      return await operation({
        reserve: (scenario, options) => this.reserveLocked(scenario, options),
        complete: (reservation, update) => this.completeLocked(reservation, update),
        writeFixture: (reservation, value) => this.writeFixtureLocked(reservation, value),
      });
    } finally {
      await release();
    }
  }

  /** Hold the cross-process lock for the entire reservation and child run. */
  async acquireExclusive(): Promise<() => Promise<void>> {
    await this.ensureWorkspaceRoot();
    if (this.lockHandle !== undefined) throw new ClaudeLiveProbeError('ledger-locked', 'live Claude execution is already active');
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(this.lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ClaudeLiveProbeError('ledger-locked', 'live Claude execution is already active');
      throw error;
    }
    this.lockHandle = lock;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (this.lockHandle !== lock) return;
      this.lockHandle = undefined;
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
  }

  private async ensureWorkspaceRoot(): Promise<void> {
    try {
      const rootStat = await lstat(this.root);
      if (
        rootStat.isSymbolicLink() ||
        !rootStat.isDirectory() ||
        (rootStat.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) ||
        resolve(await realpath(this.root)) !== this.root
      ) {
        throw new ClaudeLiveProbeError('workspace-invalid', 'live ledger workspace must be a private real directory');
      }
    } catch (error) {
      if (error instanceof ClaudeLiveProbeError) throw error;
      throw new ClaudeLiveProbeError('workspace-invalid', 'live ledger workspace could not be validated');
    }
  }

}

export type ClaudeLiveLedgerExclusive = Readonly<{
  reserve: ClaudeLiveTurnLedger['reserve'];
  complete: ClaudeLiveTurnLedger['complete'];
  writeFixture: ClaudeLiveTurnLedger['writeFixture'];
}>;

export type ClaudeLiveTurnRequest = {
  readonly scenario: ClaudeLiveScenario;
  /** Explicit UUID for a new session; omitted to generate a fresh UUID. */
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  readonly forkSessionId?: string;
  readonly targetSessionId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type ClaudeLiveTurnResult = {
  readonly evidence: 'live-tested' | 'dry-simulated';
  /** Exact installed version observed by the fresh metadata probe. */
  readonly claudeVersion: string;
  readonly reservation: ClaudeLiveTurnReservation;
  readonly status: 'completed' | 'failed' | 'unknown-recovery' | 'aborted' | 'timed-out' | 'not-exercised';
  readonly outcome: 'not_started' | 'completed' | 'failed_before_start' | 'unknown_after_dispatch';
  readonly dispatch: 'not_started' | 'dispatched' | 'completed' | 'unknown';
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly events: readonly ClaudeLiveWireMarker[];
  /** Hash only; raw session IDs remain inside the fixed plan's private closure. */
  readonly sessionIdHash?: string;
  readonly fixtureFile?: string;
  readonly textMarkerSeen: boolean;
  readonly interruptSent: boolean;
  readonly interruptAcknowledged: boolean;
  readonly failureCode?: ClaudeLiveProbeErrorCode;
  /** Sanitized fixture persistence failure; provider classification remains intact. */
  readonly fixturePersistenceFailureCode?: 'fixture-invalid' | 'output-limit';
  readonly wireDiagnostic?: ClaudeLiveWireDiagnostic;
};

/**
 * Binds one pre-reserved provider invocation to another durable ledger.  The
 * live protocol/process machinery remains shared, while callers such as the
 * T04 recovery campaign own reservation state and fixture persistence.
 */
type ClaudeLiveTurnReservationBinding = Readonly<{
  readonly reservation: ClaudeLiveTurnReservation;
  readonly complete: (update: ClaudeLiveTurnCompletionUpdate) => Promise<void>;
  readonly writeFixture: (value: JsonValue) => Promise<string>;
}>;

export type ClaudeLiveWireDiagnostic = {
  readonly wireCode: string;
  readonly lineNumber: number;
  readonly bytesReceived: number;
};

export type ClaudeLiveProbeOptions = {
  readonly profile: ClaudeLaunchProfile;
  readonly workspace: ClaudeOwnedWorkspace;
  readonly executableEvidence: ClaudeExecutableEvidence;
  /** Real mode uses only the canonical metadata/process runners. */
  readonly executionMode?: 'live' | 'dry-simulated';
  /** Injectable metadata runner for dry tests; defaults to the strict real probe. */
  readonly metadataProbe?: typeof runClaudeMetadataProbe;
  /** Injectable protocol child runner for credential-free orchestration tests. */
  readonly protocolProcessRunner?: (scope: BoundedResourceScope, command: ClaudeProtocolCommand) => ClaudeProtocolProcess;
  readonly ledger?: ClaudeLiveTurnLedger;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
};

/**
 * Runs one admitted live turn. The caller must first opt in with the exact
 * environment marker and must provide an already authenticated strict
 * profile plus canonical executable evidence.
 */
export async function runClaudeLiveTurn(options: ClaudeLiveProbeOptions, request: ClaudeLiveTurnRequest): Promise<ClaudeLiveTurnResult> {
  assertLiveProbeOptIn();
  if (options?.executionMode !== 'dry-simulated') {
    throw new ClaudeLiveProbeError('scenario-invalid', 'public live-turn execution is dry-simulated only; use the T04 recovery executor for live turns');
  }
  assertLiveOptions(options);
  const ledger = options.ledger ?? new ClaudeLiveTurnLedger(options.workspace);
  return ledger.withExclusive(exclusiveLedger => runClaudeLiveTurnLocked(options, exclusiveLedger, request));
}

/** Execute one already-reserved invocation through the existing live machinery. */
async function runClaudeLiveTurnWithReservation(
  options: ClaudeLiveProbeOptions,
  request: ClaudeLiveTurnRequest,
  binding: ClaudeLiveTurnReservationBinding,
): Promise<ClaudeLiveTurnResult> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  if (!binding || !binding.reservation || typeof binding.complete !== 'function' || typeof binding.writeFixture !== 'function') {
    throw new ClaudeLiveProbeError('ledger-invalid', 'live reservation binding is invalid');
  }
  return runClaudeLiveTurnLocked(options, undefined, request, undefined, binding);
}

/** Fresh strict metadata used by a recovery reservation before dispatch. */
export async function observeClaudeLiveVersion(options: ClaudeLiveProbeOptions): Promise<string> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  return assertFreshClaudeMetadata(options);
}

/**
 * Execute one fixed recovery reservation through the private reservation
 * adapter. The adapter is intentionally not exported: all live calls that
 * bypass the ordinary dry-simulated entry point originate in this executor.
 */
async function runClaudeT04RecoveryTurn(
  options: ClaudeLiveProbeOptions,
  campaign: ClaudeT04RecoveryCampaign,
  reservation: ClaudeT04RecoveryReservation,
  requestOptions: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }> = {},
): Promise<ClaudeT04RecoveryTurnResult> {
  assertPreparedClaudeT04RecoveryCampaign(campaign);
  assertPreparedClaudeT04RecoveryReservation(reservation, campaign.ledger);
  if (!campaign || campaign.campaignId !== CLAUDE_T04_RECOVERY_CAMPAIGN_ID) {
    throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery campaign identity is invalid');
  }
  if (!reservation || !Number.isSafeInteger(reservation.ordinal) || reservation.ordinal < 1) {
    throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation ordinal is invalid');
  }
  assertRecoveryOptIn();
  const liveScenario = recoveryToLiveScenario(reservation.scenario);
  let executable: ClaudeExecutableEvidence;
  let claudeVersion: string;
  try {
    ({ executable, claudeVersion } = await observeRecoveryAdmission(options));
  } catch (error) {
    const failure = error instanceof ClaudeT04RecoveryError
      ? error
      : error instanceof ClaudeLiveProbeError
        ? error
        : new ClaudeT04RecoveryError('executable-invalid', 'recovery executable/version evidence could not be observed');
    await campaign.ledger.failBeforeStart(reservation, failure.code);
    throw failure;
  }

  // Bind the provider session before the durable running transition. The raw
  // UUID remains process-local; only its hash crosses the recovery ledger.
  const definition = CLAUDE_LIVE_SCENARIOS[liveScenario];
  const sessionId = definition.action === 'start' ? newSessionId() : undefined;
  const sessionIdHash = sessionId === undefined ? undefined : hashClaudeLiveId(sessionId);
  const running = await campaign.ledger.start(reservation, {
    executable: recoveryExecutableIdentity(executable),
    claudeVersion,
    ...(sessionIdHash === undefined ? {} : { sessionIdHash }),
  });
  let finalized = false;
  let terminalCompletionUpdate: ClaudeLiveTurnCompletionUpdate | undefined;
  const complete = async (update: ClaudeLiveTurnCompletionUpdate): Promise<void> => {
    const crossedProviderBoundary = update.outcome === 'completed' || update.outcome === 'unknown_after_dispatch';
    const boundUpdate = sessionIdHash === undefined || !crossedProviderBoundary
      ? update
      : { ...update, sessionIdHash };
    if (crossedProviderBoundary) terminalCompletionUpdate = boundUpdate;
    if (crossedProviderBoundary && update.sessionIdHash !== sessionIdHash) {
      throw new ClaudeT04RecoveryError('session-invalid', 'recovery provider session identity does not match the prebound session');
    }
    await campaign.ledger.complete(running, {
      status: boundUpdate.status as Exclude<ClaudeT04RecoveryStatus, 'reserved' | 'running'>,
      ...(boundUpdate.outcome === undefined ? {} : { outcome: boundUpdate.outcome }),
      ...(boundUpdate.sessionIdHash === undefined ? {} : { sessionIdHash: boundUpdate.sessionIdHash }),
      ...(boundUpdate.claudeVersion === undefined ? {} : { claudeVersion: boundUpdate.claudeVersion }),
      ...(boundUpdate.fixtureFile === undefined ? {} : { fixtureFile: boundUpdate.fixtureFile }),
      ...(boundUpdate.eventCount === undefined ? {} : { eventCount: boundUpdate.eventCount }),
      ...(boundUpdate.stdoutBytes === undefined ? {} : { stdoutBytes: boundUpdate.stdoutBytes }),
      ...(boundUpdate.stderrBytes === undefined ? {} : { stderrBytes: boundUpdate.stderrBytes }),
      ...(boundUpdate.failureCode === undefined ? {} : { failureCode: boundUpdate.failureCode }),
      ...(boundUpdate.fixturePersistenceFailureCode === undefined ? {} : { fixturePersistenceFailureCode: boundUpdate.fixturePersistenceFailureCode }),
    });
    finalized = true;
  };
  try {
    const result = await runClaudeLiveTurnWithReservation(
      options,
      {
        scenario: liveScenario,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
        ...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
      },
      {
        reservation: {
          turnId: `turn-${reservation.ordinal}`,
          index: reservation.ordinal,
          reservationTurns: 1,
          scenario: liveScenario,
          action: CLAUDE_LIVE_SCENARIOS[liveScenario].action,
          claudeVersion,
          ...(sessionIdHash === undefined ? {} : { sessionIdHash }),
        },
        complete,
        writeFixture: value => campaign.ledger.writeFixture(running, value),
      },
    );
    if (sessionIdHash !== undefined && result.sessionIdHash !== sessionIdHash) {
      throw new ClaudeT04RecoveryError('session-invalid', 'recovery result session identity does not match the prebound session');
    }
    return { recoveryScenario: reservation.scenario, reservation: running, result };
  } catch (error) {
    if (!finalized) {
      const postDispatch = terminalCompletionUpdate !== undefined;
      await campaign.ledger.complete(running, {
        status: postDispatch ? 'unknown-recovery' : 'failed',
        outcome: postDispatch ? 'unknown_after_dispatch' : 'failed_before_start',
        ...(sessionIdHash === undefined ? {} : { sessionIdHash }),
        claudeVersion: terminalCompletionUpdate?.claudeVersion ?? claudeVersion,
        ...(terminalCompletionUpdate?.fixtureFile === undefined ? {} : { fixtureFile: terminalCompletionUpdate.fixtureFile }),
        ...(terminalCompletionUpdate?.eventCount === undefined ? {} : { eventCount: terminalCompletionUpdate.eventCount }),
        ...(terminalCompletionUpdate?.stdoutBytes === undefined ? {} : { stdoutBytes: terminalCompletionUpdate.stdoutBytes }),
        ...(terminalCompletionUpdate?.stderrBytes === undefined ? {} : { stderrBytes: terminalCompletionUpdate.stderrBytes }),
        failureCode: postDispatch
          ? terminalCompletionUpdate?.failureCode ?? (error instanceof ClaudeT04RecoveryError ? error.code : 'execution-failed')
          : error instanceof ClaudeLiveProbeError
            ? error.code
            : 'execution-failed',
        ...(terminalCompletionUpdate?.fixturePersistenceFailureCode === undefined ? {} : { fixturePersistenceFailureCode: terminalCompletionUpdate.fixturePersistenceFailureCode }),
      });
    }
    throw error;
  }
}

function recoveryToLiveScenario(scenario: ClaudeT04RecoveryScenario): 't4-structured' | 't5-cancel' {
  return scenario === 'structured-replacement' ? 't4-structured' : 't5-cancel';
}

function recoveryExecutableIdentity(value: ClaudeExecutableEvidence): import('./claude-live-recovery').RecoveryExecutableIdentity {
  return { realpath: value.realpath, uid: value.uid, dev: value.dev, ino: value.ino, mode: value.mode };
}

function sameRecoveryExecutableIdentity(left: ClaudeExecutableEvidence, right: ClaudeExecutableEvidence): boolean {
  return left.kind === right.kind && left.executable === right.executable && left.realpath === right.realpath && left.uid === right.uid && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

type RecoveryAdmission = Readonly<{
  readonly executable: ClaudeExecutableEvidence;
  readonly claudeVersion: string;
}>;

/**
 * Perform the no-reservation recovery admission check. This is intentionally
 * kept separate from the per-turn revalidation so the campaign cannot create
 * a ledger reservation before executable/version/auth evidence is ready.
 */
async function observeRecoveryAdmission(options: ClaudeLiveProbeOptions): Promise<RecoveryAdmission> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  try {
    const executable = await captureClaudeExecutableEvidence(options.executableEvidence.executable);
    if (!sameRecoveryExecutableIdentity(executable, options.executableEvidence)) {
      throw new ClaudeT04RecoveryError('executable-invalid', 'recovery executable identity changed before reservation start');
    }
    const claudeVersion = await observeClaudeLiveVersion(options);
    return { executable, claudeVersion };
  } catch (error) {
    if (error instanceof ClaudeT04RecoveryError || error instanceof ClaudeLiveProbeError) throw error;
    throw new ClaudeT04RecoveryError('executable-invalid', 'recovery executable/version evidence could not be observed');
  }
}

const LIVE_PLAN_CONTEXT = Symbol('claude-live-plan-context');
type ClaudeLivePlanContext = {
  readonly [LIVE_PLAN_CONTEXT]: true;
  readonly sourceSessionId: string;
  readonly forkTargetSessionId: string;
};

async function runClaudeLiveTurnLocked(
  options: ClaudeLiveProbeOptions,
  ledger: ClaudeLiveLedgerExclusive | undefined,
  request: ClaudeLiveTurnRequest,
  planContext?: ClaudeLivePlanContext,
  binding?: ClaudeLiveTurnReservationBinding,
): Promise<ClaudeLiveTurnResult> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  let currentExecutable: ClaudeExecutableEvidence;
  try {
    currentExecutable = await captureClaudeExecutableEvidence(options.executableEvidence.executable);
  } catch {
    throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable evidence could not be revalidated');
  }
  if (!sameExecutableEvidence(currentExecutable, options.executableEvidence)) {
    throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed since it was pinned');
  }
  assertTurnRequest(request, planContext !== undefined);
  const definition = CLAUDE_LIVE_SCENARIOS[request.scenario];
  const requestedSessionId = definition.action === 'resume'
    ? planContext?.sourceSessionId ?? request.resumeSessionId!
    : definition.action === 'fork'
      ? planContext?.forkTargetSessionId ?? request.targetSessionId!
      : request.scenario === 't1-start' && planContext !== undefined
        ? planContext.sourceSessionId
        : request.sessionId ?? newSessionId();
  assertSessionId(requestedSessionId, 'requested session ID');
  const timeoutMs = boundedInteger(request.timeoutMs, DEFAULT_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS, 'timeoutMs');
  const maxStdoutBytes = boundedInteger(options.maxStdoutBytes, MAX_STDOUT_BYTES, MAX_STDOUT_BYTES, 'maxStdoutBytes');
  const maxStderrBytes = boundedInteger(options.maxStderrBytes, MAX_STDERR_BYTES, MAX_STDERR_BYTES, 'maxStderrBytes');
  // Validate every caller-owned path, environment, materialized config, and
  // pinned version before consuming a subscription reservation. A malformed
  // profile is a local precondition failure, not a billable turn.
  try {
    await validateClaudeLaunchProfilePaths(options.profile, { workspace: options.workspace, allowMaterializedConfig: true });
    validateClaudeLaunchProfileEnvironment(options.profile.env, { cwd: options.profile.cwd, tmpDir: options.profile.tmpDir });
    if (options.profile.readiness !== 'ready') {
      throw new ClaudeLiveProbeError('profile-not-ready', 'authenticated strict profile is not ready for a live turn');
    }
    if (options.profile.executable !== options.executableEvidence.executable) {
      throw new ClaudeLiveProbeError('executable-invalid', 'executable evidence does not match the strict profile');
    }
  } catch (error) {
    throw error instanceof ClaudeLiveProbeError ? error : new ClaudeLiveProbeError('profile-invalid', 'strict live profile validation failed');
  }

  if (binding !== undefined && (binding.reservation.scenario !== request.scenario || binding.reservation.reservationTurns !== 1)) {
    throw new ClaudeLiveProbeError('ledger-invalid', 'live reservation binding scenario does not match the requested invocation');
  }
  const claudeVersion = await assertFreshClaudeMetadata(options);
  if (binding?.reservation.claudeVersion !== undefined && binding.reservation.claudeVersion !== claudeVersion) {
    throw new ClaudeLiveProbeError('profile-not-ready', 'Claude version changed between recovery reservation and invocation');
  }
  // Metadata probes run asynchronously and callers may hold mutable profile
  // objects. Snapshot only after both probes complete, then validate the
  // snapshot's environment/config/owned paths again immediately before the
  // child is created. The command below is built exclusively from this deep,
  // immutable copy.
  let profileSnapshot: ClaudeLaunchProfile;
  try {
    profileSnapshot = snapshotClaudeLaunchProfile(options.profile);
    await validateClaudeLaunchProfilePaths(profileSnapshot, { workspace: options.workspace, allowMaterializedConfig: true });
    validateClaudeLaunchProfileEnvironment(profileSnapshot.env, { cwd: profileSnapshot.cwd, tmpDir: profileSnapshot.tmpDir });
    if (profileSnapshot.readiness !== 'ready') throw new ClaudeLiveProbeError('profile-not-ready', 'authenticated strict profile is not ready for a live turn');
    if (profileSnapshot.executable !== options.executableEvidence.executable) throw new ClaudeLiveProbeError('executable-invalid', 'snapshot executable does not match pinned evidence');
  } catch (error) {
    throw error instanceof ClaudeLiveProbeError ? error : new ClaudeLiveProbeError('profile-invalid', 'strict live profile snapshot failed');
  }
  // Bind the newly selected UUID to the reservation before spawning. A
  // collision is rejected by the persistent ledger and cannot be retried.
  const reservation = binding?.reservation ?? await ledger!.reserve(request.scenario, {
    sessionIdHash: hashClaudeLiveId(requestedSessionId),
    allowExistingSession: definition.action === 'resume',
    claudeVersion,
  });
  const completeReservation = (update: ClaudeLiveTurnCompletionUpdate): Promise<void> =>
    binding?.complete(update) ?? ledger!.complete(reservation, update);
  const persistFixture = (value: JsonValue): Promise<string> => binding?.writeFixture(value) ?? ledger!.writeFixture(reservation, value);
  let command: ClaudeProtocolCommand;
  try {
    // This is the final asynchronous pre-spawn validation. No caller-owned
    // profile object is consulted after this point; command construction and
    // spawn are synchronous, so materialized bytes/path identity are checked
    // after metadata and as close to dispatch as this boundary permits.
    await validateClaudeLaunchProfilePaths(profileSnapshot, { workspace: options.workspace, allowMaterializedConfig: true });
    validateClaudeLaunchProfileEnvironment(profileSnapshot.env, { cwd: profileSnapshot.cwd, tmpDir: profileSnapshot.tmpDir });
    const finalExecutable = await captureClaudeExecutableEvidence(profileSnapshot.executable!);
    if (!sameExecutableEvidence(finalExecutable, options.executableEvidence)) {
      throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed before spawn');
    }
    if (definition.action === 'resume') {
      const resumeSessionId = planContext?.sourceSessionId ?? request.resumeSessionId;
      if (resumeSessionId === undefined) throw new ClaudeLiveProbeError('session-invalid', 'resume scenario requires an explicit stored session ID');
      command = buildClaudeResumeCommand({ profile: profileSnapshot, sessionId: resumeSessionId, prompt: definition.prompt, maxTurns: definition.maxTurns });
    } else if (definition.action === 'fork') {
      const sourceSessionId = planContext?.sourceSessionId ?? request.forkSessionId;
      const targetSessionId = planContext?.forkTargetSessionId ?? request.targetSessionId;
      if (sourceSessionId === undefined || targetSessionId === undefined) {
        throw new ClaudeLiveProbeError('session-invalid', 'fork scenario requires explicit source and target session IDs');
      }
      command = buildClaudeForkCommand({
        profile: profileSnapshot,
        sourceSessionId,
        sessionId: targetSessionId,
        prompt: definition.prompt,
        maxTurns: definition.maxTurns,
      });
    } else {
      const jsonSchema = 'jsonSchema' in definition ? (definition.jsonSchema as unknown as JsonValue) : undefined;
      command = buildClaudeProtocolCommand({
        profile: profileSnapshot,
        sessionId: requestedSessionId,
        prompt: definition.prompt,
        ...(jsonSchema === undefined ? {} : { jsonSchema }),
        maxTurns: definition.maxTurns,
      });
    }
  } catch (error) {
    const failureCode = error instanceof ClaudeLiveProbeError ? error.code : 'scenario-invalid';
    // Command construction is the last pre-spawn boundary. The reservation
    // has already been consumed, but no child or user frame exists, so make
    // that certainty explicit for both the native and recovery ledgers.
    await completeReservation({ status: 'failed', outcome: 'failed_before_start', failureCode });
    throw error instanceof ClaudeLiveProbeError ? error : new ClaudeLiveProbeError(failureCode, 'live command construction failed');
  }

  const scope = new BoundedResourceScope({ graceMs: 500, forceKillMs: 1_000, closerTimeoutMs: 2_000 });
  let child: ChildProcess | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exitCode: number | null = null;
  let status: ClaudeLiveTurnResult['status'] = 'failed';
  let outcome: ClaudeLiveTurnResult['outcome'] = 'not_started';
  let dispatch: ClaudeLiveTurnResult['dispatch'] = 'not_started';
  let failureCode: ClaudeLiveProbeErrorCode | undefined;
  let fixturePersistenceFailureCode: 'fixture-invalid' | 'output-limit' | undefined;
  const events: ClaudeLiveWireMarker[] = [];
  let fixtureFile: string | undefined;
  let sessionId: string | undefined;
  let cleanupPromise: Promise<unknown> | undefined;
  let cleanupFailed = false;
  let initResponseSeen = false;
  let sessionInitAfterUser = false;
  let userSent = false;
  let interruptSent = false;
  let interruptAcknowledged = false;
  let finalSeen = false;
  let structuredOutputValid = false;
  let wireDiagnostic: ClaudeLiveWireDiagnostic | undefined;

  const stop = (code: ClaudeLiveProbeErrorCode): void => {
    if (failureCode === undefined) failureCode = code;
    cleanupPromise ??= scope.cleanup().catch(() => {
      cleanupFailed = true;
    });
  };

  try {
    const expectedSessionId = requestedSessionId;
    // This is process-local continuation state. Only its hash is retained in
    // the ledger/fixture; the fixed plan's private closure owns raw IDs.
    sessionId = expectedSessionId;
    const wire = new ClaudeLiveWireAdapter({
      expectedSessionId,
      expectedTextMarker: 'textMarker' in definition ? definition.textMarker : undefined,
      expectedUserPrompt: definition.prompt,
      ...(request.scenario === 't4-structured'
        ? { expectedStructuredOutput: { shape: 'object' as const, field: 'probe', marker: 'LIVE_STRUCTURED_OK' } }
        : {}),
      onControlRequest: controlRequest => {
        if (!child) throw new ClaudeLiveProbeError('protocol-invalid', 'control request arrived before child setup');
        // T04 runs with native tools disabled and safe mode enabled.  Tool,
        // approval, and hook callbacks are deliberately moved to T06/T07;
        // seeing one here is fail-closed evidence that the strict profile did
        // not preserve the intended no-tool surface.
        throw new ClaudeLiveProbeError('protocol-invalid', 'live T04 does not admit tool or approval callbacks');
      },
    });
    child = (options.protocolProcessRunner ?? spawnClaudeProtocolProcess)(scope, command).child;
    dispatch = 'dispatched';
    const initRequestId = `init-${reservation.turnId}`;
    const interruptRequestId = `interrupt-${reservation.turnId}`;
    const sendUserIfReady = (): void => {
      // The installed Claude release emits the SDK initialize response before any
      // system/init frame. The sole user frame is therefore dispatched as
      // soon as initialize succeeds; system/init is required afterwards,
      // before any model stream/final evidence is accepted.
      if (userSent || !initResponseSeen) return;
      if (request.signal?.aborted) {
        stop('turn-aborted');
        return;
      }
      userSent = true;
      outcome = 'unknown_after_dispatch';
      // Mark dispatch before the write: an injected or unusually eager child
      // can synchronously emit system/init from its stdin callback.
      writeLiveUserPrompt(child!, definition.prompt, request.signal);
    };
    const completion = await collectLiveChild(
      child,
      wire,
      events,
      request.signal,
      timeoutMs,
      INIT_DEADLINE_MS,
      maxStdoutBytes,
      maxStderrBytes,
      initRequestId,
      () => {
        if (request.signal?.aborted) {
          stop('turn-aborted');
          return;
        }
        wire.registerOutboundControl(initRequestId, undefined, 'initialize');
        writeLiveInitialize(child!, initRequestId, request.signal);
      },
      event => {
      // Once the caller has aborted, do not let a queued handshake event or a
      // late stdout chunk trigger another stdin write. Cleanup owns the child
      // from this point onward.
      if (request.signal?.aborted) {
        stop('turn-aborted');
        return;
      }
      if (wire.sessionId !== undefined) sessionId = wire.sessionId;
      if (event.kind === 'session-init') {
        if (userSent) sessionInitAfterUser = true;
        sendUserIfReady();
      }
      if (event.kind === 'control-response' && event.requestIdHash === hashClaudeLiveId(initRequestId) && event.label === 'initialize-success') {
        initResponseSeen = true;
        sendUserIfReady();
      }
      if (
        userSent &&
        !sessionInitAfterUser &&
        (event.kind === 'stream-delta' ||
          event.kind === 'assistant-message' ||
          event.kind === 'tool-use' ||
          event.kind === 'tool-result' ||
          event.kind === 'final-success' ||
          event.kind === 'final-structured' ||
          event.kind === 'final-error')
      ) {
        throw new ClaudeLiveProbeError('protocol-invalid', 'live Claude emitted model evidence before post-dispatch system/init');
      }
      if (
        event.kind === 'control-response' &&
        event.requestIdHash === hashClaudeLiveId(interruptRequestId) &&
        (event.label === 'interrupt-receipt' || event.label === 'interrupt-legacy-cancelled' || event.label === 'interrupt-legacy-interrupted' || event.label === 'interrupt-legacy-still_queued')
      ) interruptAcknowledged = true;
      if (event.kind === 'stream-delta' && request.scenario === 't5-cancel' && !interruptSent) {
        const cancel = buildClaudeCancelCommand({ sessionId: wire.sessionId ?? expectedSessionId!, requestId: interruptRequestId });
        wire.registerOutboundControl(interruptRequestId, wire.sessionId ?? expectedSessionId, 'interrupt');
        writeLiveFrame(child!, cancel.jsonl, request.signal);
        interruptSent = true;
      }
      if (event.kind === 'final-structured') structuredOutputValid = event.label === 'structured-valid' && event.structuredMarkerSeen === true;
      if (event.kind === 'final-success' || event.kind === 'final-structured' || event.kind === 'final-error') {
        finalSeen = true;
        if (!request.signal?.aborted) child?.stdin?.end();
      }
    },
      stop,
    );
    stdoutBytes = completion.stdoutBytes;
    stderrBytes = completion.stderrBytes;
    exitCode = completion.exitCode;
    if (failureCode === undefined && completion.exitCode === 0) {
      dispatch = 'completed';
      const validation = validateLiveScenarioOutcome(request.scenario, {
        events,
        finalSeen,
        textMarkerSeen: wire.textMarkerSeen,
        interruptSent,
        interruptAcknowledged,
        structuredOutputValid,
      });
      if (validation === 'not-exercised') status = 'not-exercised';
      else if (validation === 'aborted') status = 'aborted';
      else if (validation !== undefined) failureCode = validation;
      else status = 'completed';
    } else if (failureCode === undefined) {
      failureCode = 'spawn-failed';
    }
  } catch (error) {
    if (error instanceof ClaudeLiveWireError) {
      wireDiagnostic = { wireCode: error.code, lineNumber: error.lineNumber, bytesReceived: error.bytesReceived };
    }
    if (error instanceof ClaudeLiveProbeError) failureCode ??= error.code;
    else failureCode ??= 'protocol-invalid';
  } finally {
    cleanupPromise ??= scope.cleanup().catch(() => {
      cleanupFailed = true;
    });
    await cleanupPromise;
  }

  if (cleanupFailed) failureCode = 'cleanup-failed';
  if (failureCode === 'turn-timeout') status = 'timed-out';
  else if (failureCode === 'turn-aborted') status = 'aborted';
  // Once the user frame has been written, a protocol error or nonzero child
  // exit cannot establish whether the provider accepted the turn.  Preserve
  // that uncertainty instead of presenting it as an ordinary failed call;
  // only a clean, fully observed terminal result can be completed.
  else if (failureCode !== undefined) status = userSent && dispatch === 'dispatched' ? 'unknown-recovery' : 'failed';
  if (failureCode === undefined && status === 'completed') outcome = 'completed';
  else if (failureCode !== undefined && !userSent) outcome = 'failed_before_start';
  const sanitizedEvents = events;
  const evidence = liveEvidence(options);
  try {
    fixtureFile = await persistFixture({
      schemaVersion: CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION,
      evidence,
      claudeVersion,
      turn: { turnId: reservation.turnId, index: reservation.index, scenario: reservation.scenario, action: reservation.action },
      status,
      outcome,
      dispatch,
      exitCode,
      stdoutBytes,
      stderrBytes,
      events: sanitizedEvents as unknown as JsonValue,
      textMarkerSeen: wireTextMarkerSeen(events),
      interruptSent,
      interruptAcknowledged,
      ...(sessionId === undefined ? {} : { sessionIdHash: hashClaudeLiveId(sessionId) }),
      ...(structuredOutputValid ? { structuredOutput: { shape: 'object', markerSeen: true } } : {}),
      ...(wireDiagnostic === undefined ? {} : { wireDiagnostic }),
    });
  } catch (error) {
    fixturePersistenceFailureCode = error instanceof ClaudeLiveProbeError && (error.code === 'fixture-invalid' || error.code === 'output-limit') ? error.code : 'fixture-invalid';
  }
  await completeReservation({
    status,
    outcome,
    claudeVersion,
    ...(sessionId === undefined ? {} : { sessionIdHash: hashClaudeLiveId(sessionId) }),
    ...(fixtureFile === undefined ? {} : { fixtureFile }),
    eventCount: sanitizedEvents.length,
    stdoutBytes,
    stderrBytes,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(fixturePersistenceFailureCode === undefined ? {} : { fixturePersistenceFailureCode }),
    ...(wireDiagnostic === undefined ? {} : { wireDiagnostic }),
  });
  return {
    evidence,
    claudeVersion,
    reservation,
    status,
    outcome,
    dispatch,
    exitCode,
    stdoutBytes,
    stderrBytes,
    events: sanitizedEvents,
    ...(sessionId === undefined ? {} : { sessionIdHash: hashClaudeLiveId(sessionId) }),
    ...(fixtureFile === undefined ? {} : { fixtureFile }),
    textMarkerSeen: wireTextMarkerSeen(events),
    interruptSent,
    interruptAcknowledged,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(fixturePersistenceFailureCode === undefined ? {} : { fixturePersistenceFailureCode }),
    ...(wireDiagnostic === undefined ? {} : { wireDiagnostic }),
  };
}

export type ClaudeLivePlanResult = {
  readonly turns: readonly ClaudeLiveTurnResult[];
  readonly stoppedAt?: ClaudeLiveScenario;
};

/**
 * Execute the fixed T04 sequence in order.  The helper deliberately stops at
 * the first non-success outcome; callers must inspect that outcome and may not
 * replay a dispatched reservation. The plan uses one explicit
 * `--max-turns 1` child per fixed scenario; this workflow shape is not an
 * application-wide Claude call quota.
 */
export async function runClaudeLiveProtocolPlan(options: ClaudeLiveProbeOptions): Promise<ClaudeLivePlanResult> {
  assertLiveProbeOptIn();
  if (options.executionMode !== 'dry-simulated') {
    throw new ClaudeLiveProbeError('scenario-invalid', 'historical live protocol plan is dry-simulated only; use the recovery executor for live turns');
  }
  assertLiveOptions(options);
  const ledger = options.ledger ?? new ClaudeLiveTurnLedger(options.workspace);
  return ledger.withExclusive(async exclusiveLedger => {
    const turns: ClaudeLiveTurnResult[] = [];
    const sourceSessionId = newSessionId();
    const forkTargetSessionId = newSessionId();
    const context: ClaudeLivePlanContext = Object.freeze({ [LIVE_PLAN_CONTEXT]: true as const, sourceSessionId, forkTargetSessionId });
    const execute = async (request: ClaudeLiveTurnRequest, acceptable: readonly ClaudeLiveTurnResult['status'][]): Promise<boolean> => {
      const result = await runClaudeLiveTurnLocked(options, exclusiveLedger, request, context);
      turns.push(result);
      return acceptable.includes(result.status);
    };
    if (!(await execute({ scenario: 't1-start' }, ['completed']))) return { turns, stoppedAt: 't1-start' };
    if (!(await execute({ scenario: 't2-resume' }, ['completed']))) return { turns, stoppedAt: 't2-resume' };
    if (!(await execute({ scenario: 't3-fork' }, ['completed']))) return { turns, stoppedAt: 't3-fork' };
    if (!(await execute({ scenario: 't4-structured' }, ['completed']))) return { turns, stoppedAt: 't4-structured' };
    if (!(await execute({ scenario: 't5-cancel' }, ['aborted', 'not-exercised']))) return { turns, stoppedAt: 't5-cancel' };
    return { turns };
  });
}

/** Execute the fixed two-scenario recovery workflow through the private turn adapter. */
export async function runClaudeT04RecoveryCampaign(
  options: ClaudeLiveProbeOptions,
  campaign: ClaudeT04RecoveryCampaign,
): Promise<readonly ClaudeT04RecoveryTurnResult[]> {
  assertPreparedClaudeT04RecoveryCampaign(campaign);
  assertRecoveryOptIn();
  // Admission is deliberately before reservation: a missing, malformed, or
  // unauthenticated executable/version must not create recovery ledger state.
  // Each turn repeats this check immediately before its own provider boundary.
  await observeRecoveryAdmission(options);
  const reservations = await reserveClaudeT04RecoveryCampaign(campaign);
  const structured = await runClaudeT04RecoveryTurn(options, campaign, reservations[0]);
  if (structured.result.status !== 'completed' || structured.result.outcome !== 'completed') return [structured];
  const cancellation = await runClaudeT04RecoveryTurn(options, campaign, reservations[1]);
  return [structured, cancellation];
}

export type ClaudeLiveMalformedNegativeResult = {
  readonly evidence: 'live-tested' | 'dry-simulated';
  readonly status: 'rejected' | 'timed-out' | 'failed';
  /** This probe never sends a user frame and never reserves a provider turn. */
  readonly dispatch: 'not_started';
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly events: readonly ClaudeLiveWireMarker[];
  readonly failureCode?: 'protocol-invalid' | 'turn-timeout' | 'cleanup-failed';
};

/**
 * Send one malformed control input after the host handshake, without sending
 * a user frame.  This is a live fail-closed negative only: it is intentionally
 * excluded from the turn ledger and therefore cannot spend a subscription
 * reservation.  It is never called by the default test command.
 */
export async function runClaudeLiveMalformedNegative(options: ClaudeLiveProbeOptions): Promise<ClaudeLiveMalformedNegativeResult> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  const ledger = new ClaudeLiveTurnLedger(options.workspace);
  const release = await ledger.acquireExclusive();
  try {
    return await runClaudeLiveMalformedNegativeLocked(options);
  } finally {
    await release();
  }
}

export type ClaudeMaxTurnsCompatibilityCase = {
  readonly recognized: boolean;
  readonly noUserDispatch: boolean;
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
};

export type ClaudeMaxTurnsCompatibilityResult = {
  readonly evidence: 'version-bound-experiment';
  readonly executableVersion: string;
  /** This check closes stdin and never writes a user/control frame. */
  readonly dispatch: 'not_started';
  readonly eof: ClaudeMaxTurnsCompatibilityCase;
  readonly invalid: ClaudeMaxTurnsCompatibilityCase;
  readonly missing: ClaudeMaxTurnsCompatibilityCase;
};

/**
 * Verify the installed Claude argument parser without dispatching a user
 * message. Claude's help exposes --max-turns only as an SDK-observed,
 * version-bound switch; the host still enforces integer values 1..16 before
 * constructing any provider command.  The invalid/missing cases inspect only
 * bounded byte counts and exit status, never returning vendor stderr.
 */
export async function runClaudeMaxTurnsCompatibilityCheck(options: ClaudeLiveProbeOptions): Promise<ClaudeMaxTurnsCompatibilityResult> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  if (options.executionMode === 'dry-simulated' || options.metadataProbe !== undefined || options.protocolProcessRunner !== undefined) {
    throw new ClaudeLiveProbeError('scenario-invalid', 'max-turns compatibility requires the canonical real Claude process');
  }
  let currentExecutable: ClaudeExecutableEvidence;
  try {
    currentExecutable = await captureClaudeExecutableEvidence(options.executableEvidence.executable);
  } catch {
    throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable evidence could not be revalidated');
  }
  if (!sameExecutableEvidence(currentExecutable, options.executableEvidence)) throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed');
  await validateClaudeLaunchProfilePaths(options.profile, { workspace: options.workspace, allowMaterializedConfig: true });
  validateClaudeLaunchProfileEnvironment(options.profile.env, { cwd: options.profile.cwd, tmpDir: options.profile.tmpDir });
  if (options.profile.readiness !== 'ready' || options.profile.executable !== options.executableEvidence.executable) {
    throw new ClaudeLiveProbeError('profile-not-ready', 'authenticated strict profile is not ready for max-turns compatibility');
  }
  const executableVersion = await assertFreshClaudeMetadata(options);
  const profile = snapshotClaudeLaunchProfile(options.profile);
  await validateClaudeLaunchProfilePaths(profile, { workspace: options.workspace, allowMaterializedConfig: true });
  validateClaudeLaunchProfileEnvironment(profile.env, { cwd: profile.cwd, tmpDir: profile.tmpDir });
  const finalExecutable = await captureClaudeExecutableEvidence(profile.executable!);
  if (!sameExecutableEvidence(finalExecutable, options.executableEvidence)) throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed before compatibility check');
  const base = buildClaudeProtocolCommand({ profile, maxTurns: 1 });
  const cases = await Promise.all([
    runMaxTurnsCompatibilityCase(profile, base.argv),
    runMaxTurnsCompatibilityCase(profile, [...base.argv.slice(0, -2), '--max-turns', 'nope']),
    runMaxTurnsCompatibilityCase(profile, [...base.argv.slice(0, -2), '--max-turns']),
  ]);
  const [eof, invalid, missing] = cases;
  if (!eof || !invalid || !missing) throw new ClaudeLiveProbeError('protocol-invalid', 'max-turns compatibility cases did not complete');
  return {
    evidence: 'version-bound-experiment',
    executableVersion,
    dispatch: 'not_started',
    eof: { ...eof, recognized: eof.exitCode === 0 && eof.stdoutBytes === 0 },
    invalid: { ...invalid, recognized: invalid.exitCode !== 0 && invalid.stderrBytes > 0, noUserDispatch: invalid.stdoutBytes === 0 },
    missing: { ...missing, recognized: missing.exitCode !== 0 && missing.stderrBytes > 0, noUserDispatch: missing.stdoutBytes === 0 },
  };
}

async function runMaxTurnsCompatibilityCase(profile: ClaudeLaunchProfile, argv: readonly string[]): Promise<ClaudeMaxTurnsCompatibilityCase> {
  const scope = new BoundedResourceScope({ graceMs: 500, forceKillMs: 1_000, closerTimeoutMs: 2_000 });
  const child = scope.spawn(profile.executable!, [...argv], { cwd: profile.cwd, env: { ...profile.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exitCode: number | null = null;
  try {
    const result = await new Promise<{ exitCode: number | null; stdoutBytes: number; stderrBytes: number }>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        resolve({ exitCode: code, stdoutBytes, stderrBytes });
      };
      const onStdout = (chunk: unknown): void => {
        stdoutBytes += chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
      };
      const onStderr = (chunk: unknown): void => {
        stderrBytes += chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
      };
      const onClose = (code: number | null): void => finish(code);
      const onError = (): void => finish(null);
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('close', onClose);
      child.once('error', onError);
      child.stdin?.end();
      timer = setTimeout(() => finish(null), 5_000);
    });
    ({ exitCode, stdoutBytes, stderrBytes } = result);
  } finally {
    try {
      await scope.cleanup();
    } catch {
      // The caller receives only bounded parser evidence. A cleanup failure is
      // intentionally represented as a failed process shape by the outer gate.
      exitCode = null;
    }
  }
  return { recognized: false, noUserDispatch: stdoutBytes === 0, exitCode, stdoutBytes, stderrBytes };
}

async function runClaudeLiveMalformedNegativeLocked(options: ClaudeLiveProbeOptions): Promise<ClaudeLiveMalformedNegativeResult> {
  assertLiveProbeOptIn();
  assertLiveOptions(options);
  let currentExecutable: ClaudeExecutableEvidence;
  try {
    currentExecutable = await captureClaudeExecutableEvidence(options.executableEvidence.executable);
  } catch {
    throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable evidence could not be revalidated');
  }
  if (!sameExecutableEvidence(currentExecutable, options.executableEvidence)) throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed since it was pinned');
  try {
    await validateClaudeLaunchProfilePaths(options.profile, { workspace: options.workspace, allowMaterializedConfig: true });
    validateClaudeLaunchProfileEnvironment(options.profile.env, { cwd: options.profile.cwd, tmpDir: options.profile.tmpDir });
    if (options.profile.readiness !== 'ready') throw new ClaudeLiveProbeError('profile-not-ready', 'authenticated strict profile is not ready for a live negative');
    if (options.profile.executable !== options.executableEvidence.executable) throw new ClaudeLiveProbeError('executable-invalid', 'executable evidence does not match the strict profile');
  } catch (error) {
    throw error instanceof ClaudeLiveProbeError ? error : new ClaudeLiveProbeError('profile-invalid', 'strict live profile validation failed');
  }

  await assertFreshClaudeMetadata(options);
  let profileSnapshot: ClaudeLaunchProfile;
  try {
    profileSnapshot = snapshotClaudeLaunchProfile(options.profile);
    await validateClaudeLaunchProfilePaths(profileSnapshot, { workspace: options.workspace, allowMaterializedConfig: true });
    validateClaudeLaunchProfileEnvironment(profileSnapshot.env, { cwd: profileSnapshot.cwd, tmpDir: profileSnapshot.tmpDir });
    if (profileSnapshot.readiness !== 'ready') throw new ClaudeLiveProbeError('profile-not-ready', 'authenticated strict profile is not ready for a live negative');
    if (profileSnapshot.executable !== options.executableEvidence.executable) throw new ClaudeLiveProbeError('executable-invalid', 'snapshot executable does not match pinned evidence');
  } catch (error) {
    throw error instanceof ClaudeLiveProbeError ? error : new ClaudeLiveProbeError('profile-invalid', 'strict live profile snapshot failed');
  }
  const evidence = liveEvidence(options);
  const sessionId = newSessionId();
  await validateClaudeLaunchProfilePaths(profileSnapshot, { workspace: options.workspace, allowMaterializedConfig: true });
  validateClaudeLaunchProfileEnvironment(profileSnapshot.env, { cwd: profileSnapshot.cwd, tmpDir: profileSnapshot.tmpDir });
  const finalExecutable = await captureClaudeExecutableEvidence(profileSnapshot.executable!);
  if (!sameExecutableEvidence(finalExecutable, options.executableEvidence)) throw new ClaudeLiveProbeError('executable-invalid', 'canonical Claude executable identity changed before negative spawn');
  const command = buildClaudeProtocolCommand({ profile: profileSnapshot, sessionId, maxTurns: 1 });
  const scope = new BoundedResourceScope({ graceMs: 500, forceKillMs: 1_000, closerTimeoutMs: 2_000 });
  const events: ClaudeLiveWireMarker[] = [];
  let cleanupFailed = false;
  let child: ChildProcess | undefined;
  let completion: { exitCode: number | null; stdoutBytes: number; stderrBytes: number; rejected: boolean; timedOut: boolean } = {
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    rejected: false,
    timedOut: false,
  };
  try {
    child = (options.protocolProcessRunner ?? spawnClaudeProtocolProcess)(scope, command).child;
    completion = await collectMalformedNegativeChild(child, sessionId, events, MAX_STDOUT_BYTES, MAX_STDERR_BYTES);
  } finally {
    try {
      await scope.cleanup();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) return { evidence, status: 'failed', dispatch: 'not_started', exitCode: completion?.exitCode ?? null, stdoutBytes: completion?.stdoutBytes ?? 0, stderrBytes: completion?.stderrBytes ?? 0, events, failureCode: 'cleanup-failed' };
  if (completion.timedOut) return { evidence, status: 'timed-out', dispatch: 'not_started', exitCode: completion.exitCode, stdoutBytes: completion.stdoutBytes, stderrBytes: completion.stderrBytes, events, failureCode: 'turn-timeout' };
  if (!completion.rejected) return { evidence, status: 'failed', dispatch: 'not_started', exitCode: completion.exitCode, stdoutBytes: completion.stdoutBytes, stderrBytes: completion.stderrBytes, events, failureCode: 'protocol-invalid' };
  return { evidence, status: 'rejected', dispatch: 'not_started', exitCode: completion.exitCode, stdoutBytes: completion.stdoutBytes, stderrBytes: completion.stderrBytes, events };
}

function collectMalformedNegativeChild(
  child: ChildProcess,
  expectedSessionId: string,
  events: ClaudeLiveWireMarker[],
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Promise<{ exitCode: number | null; stdoutBytes: number; stderrBytes: number; rejected: boolean; timedOut: boolean }> {
  return new Promise(resolvePromise => {
    const wire = new ClaudeLiveWireAdapter({ expectedSessionId });
    let settled = false;
    let rejected = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let initializeResponseSeen = false;
    let malformedSent = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdin?.removeListener('error', onStdinError);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      resolvePromise({ exitCode, stdoutBytes, stderrBytes, rejected, timedOut });
    };
    const markRejectedIfArmed = (): void => {
      if (initializeResponseSeen && malformedSent) rejected = true;
    };
    const onError = (): void => {
      markRejectedIfArmed();
      finish(null);
    };
    const onStdinError = (): void => {
      // An EPIPE before the malformed frame is acknowledged is not evidence
      // of fail-closed handling; it is simply a failed negative process.
      markRejectedIfArmed();
      finish(null);
    };
    const onStdout = (chunk: unknown): void => {
      const bytes = chunk instanceof Uint8Array ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      stdoutBytes += bytes;
      if (stdoutBytes > maxStdoutBytes) {
        markRejectedIfArmed();
        finish(null);
        return;
      }
      try {
        for (const event of wire.push(chunk instanceof Uint8Array ? chunk : String(chunk))) {
          events.push(event);
          if (event.kind === 'control-response' && event.requestIdHash === hashClaudeLiveId('init-negative') && event.label === 'initialize-success') {
            initializeResponseSeen = true;
            if (!malformedSent) {
              writeLiveFrame(child, `${JSON.stringify({ type: 'control_request', request_id: 'malformed-negative', request: { subtype: 'not-admitted' } })}\n`);
              malformedSent = true;
            }
          }
        }
      } catch {
        // Any response to the malformed control that is not an admitted,
        // bounded frame is a successful fail-closed observation.
        markRejectedIfArmed();
        finish(null);
      }
    };
    const onStderr = (chunk: unknown): void => {
      stderrBytes += chunk instanceof Uint8Array ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      if (stderrBytes > maxStderrBytes) {
        markRejectedIfArmed();
        finish(null);
      }
    };
    const onClose = (code: number | null): void => {
      try {
        wire.end();
      } catch {
        markRejectedIfArmed();
      }
      if (initializeResponseSeen && malformedSent && code !== 0) rejected = true;
      else if (!initializeResponseSeen || !malformedSent) rejected = false;
      finish(code);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdin?.on('error', onStdinError);
    child.once('error', onError);
    child.once('close', onClose);
    // This deadline is awaited by the no-turn negative; keep it referenced so
    // an in-memory child cannot leave the completion promise pending forever.
    timer = setTimeout(() => {
      timedOut = true;
      finish(null);
    }, 2_000);
    try {
      wire.registerOutboundControl('init-negative');
      writeLiveInitialize(child, 'init-negative');
      // Deliberately no user frame. The malformed host input is sent only
      // after the exact successful initialize response is observed.
    } catch {
      markRejectedIfArmed();
      finish(null);
    }
  });
}

async function collectLiveChild(
  child: ChildProcess,
  wire: ClaudeLiveWireAdapter,
  events: ClaudeLiveWireMarker[],
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  initDeadlineMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
  initRequestId: string,
  onStart: () => void,
  onEvent: (event: ClaudeLiveWireMarker) => void,
  stop: (code: ClaudeLiveProbeErrorCode) => void,
): Promise<{ exitCode: number | null; stdoutBytes: number; stderrBytes: number }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let initTimer: NodeJS.Timeout | undefined;
    let sawSessionInit = false;
    let sawInitializeResponse = false;
    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (initTimer) clearTimeout(initTimer);
      callerSignal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdin?.removeListener('error', onStdinError);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (error) reject(error);
      else resolvePromise({ exitCode, stdoutBytes, stderrBytes });
    };
    const onAbort = (): void => {
      stop('turn-aborted');
      finish(null, new ClaudeLiveProbeError('turn-aborted', 'live Claude turn was aborted'));
    };
    const onError = (): void => {
      stop('spawn-failed');
      finish(null, new ClaudeLiveProbeError('spawn-failed', 'live Claude process failed to spawn'));
    };
    const onStdinError = (): void => {
      const code = callerSignal?.aborted ? 'turn-aborted' : 'protocol-invalid';
      stop(code);
      finish(null, new ClaudeLiveProbeError(code, 'live Claude stdin failed while writing a control or user frame'));
    };
    const onStdout = (chunk: unknown): void => {
      const bytes = chunk instanceof Uint8Array ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      stdoutBytes += bytes;
      if (stdoutBytes > maxStdoutBytes) {
        stop('output-limit');
        finish(null, new ClaudeLiveProbeError('output-limit', 'live Claude stdout exceeded its byte limit'));
        return;
      }
      try {
        const parsed = wire.push(chunk instanceof Uint8Array ? chunk : String(chunk));
        for (const event of parsed) {
          if (event.kind === 'session-init') {
            sawSessionInit = true;
          }
          if (event.kind === 'control-response' && event.requestIdHash === hashClaudeLiveId(initRequestId) && event.label === 'initialize-success') {
            sawInitializeResponse = true;
          }
          if (sawSessionInit && sawInitializeResponse && initTimer) {
            clearTimeout(initTimer);
            initTimer = undefined;
          }
          events.push(event);
          onEvent(event);
        }
      } catch (error) {
        const code = error instanceof ClaudeLiveProbeError ? error.code : 'protocol-invalid';
        stop(code);
        finish(null, error instanceof Error ? error : new ClaudeLiveProbeError('protocol-invalid', 'live Claude protocol was invalid'));
      }
    };
    const onStderr = (chunk: unknown): void => {
      stderrBytes += chunk instanceof Uint8Array ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      if (stderrBytes > maxStderrBytes) {
        stop('output-limit');
        finish(null, new ClaudeLiveProbeError('output-limit', 'live Claude stderr exceeded its byte limit'));
      }
    };
    const onClose = (code: number | null): void => {
      if (!sawSessionInit || !sawInitializeResponse) {
        stop('protocol-invalid');
        finish(code, new ClaudeLiveProbeError('protocol-invalid', 'live Claude stream ended without a complete initialize handshake'));
        return;
      }
      try {
        wire.end();
      } catch (error) {
        stop('protocol-invalid');
        finish(code, error instanceof Error ? error : new ClaudeLiveProbeError('protocol-invalid', 'live Claude protocol ended invalidly'));
        return;
      }
      finish(code);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdin?.on('error', onStdinError);
    child.once('error', onError);
    child.once('close', onClose);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    // The collector's safety deadline is part of the awaited run contract and
    // must remain active even when an injected child has no OS handles.
    timer = setTimeout(() => {
      stop('turn-timeout');
      finish(null, new ClaudeLiveProbeError('turn-timeout', 'live Claude turn timed out'));
    }, timeoutMs);
    // The handshake has its own bounded deadline, also intentionally
    // referenced for in-memory/injected transports.
    initTimer = setTimeout(() => {
      if ((sawSessionInit && sawInitializeResponse) || settled) return;
      stop('turn-timeout');
      finish(null, new ClaudeLiveProbeError('turn-timeout', 'live Claude session init timed out'));
    }, initDeadlineMs);
    if (callerSignal?.aborted) {
      onAbort();
      return;
    }
    try {
      // Listeners and limits are installed before the first write.  This is
      // important because the CLI may emit its handshake synchronously.
      onStart();
    } catch (error) {
      const code = error instanceof ClaudeLiveProbeError ? error.code : 'protocol-invalid';
      stop(code);
      finish(null, error instanceof Error ? error : new ClaudeLiveProbeError(code, 'live Claude initialization failed'));
      return;
    }
    if (callerSignal?.aborted) onAbort();
  });
}

function writeLiveInitialize(child: ChildProcess, requestId: string, signal?: AbortSignal): void {
  // This is the SDK-shaped host initialization frame.  It is intentionally
  // serialized locally instead of passing through the offline event parser,
  // whose input contract models child-to-host frames only.
  writeLiveFrame(child, `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`, signal);
}

function writeLiveUserPrompt(child: ChildProcess, prompt: string, signal?: AbortSignal): void {
  if (!Object.values(CLAUDE_LIVE_SCENARIOS).some(definition => definition.prompt === prompt)) {
    throw new ClaudeLiveProbeError('scenario-invalid', 'live prompt is not one of the fixed fixture prompts');
  }
  // SDKUserMessage.session_id is optional.  Omitting it avoids inventing an
  // empty session identity; the CLI binds this user frame to the explicit
  // --session-id/--resume/--fork command selected for the child.
  writeLiveFrame(child, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null })}\n`, signal);
}

function writeLiveFrame(child: ChildProcess, jsonl: string, signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClaudeLiveProbeError('turn-aborted', 'live Claude stdin write skipped after abort');
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) throw new ClaudeLiveProbeError('protocol-invalid', 'live Claude stdin is not writable');
  let callbackError: Error | undefined;
  try {
    child.stdin.write(jsonl, error => {
      if (error) callbackError = error;
    });
  } catch {
    throw new ClaudeLiveProbeError('protocol-invalid', 'live Claude stdin write failed');
  }
  // A few test transports report EPIPE only through the write callback. Real
  // ChildProcess stdin also emits `error`, which collectLiveChild listens for;
  // this synchronous check covers callback-only Writable implementations.
  if (callbackError !== undefined) throw new ClaudeLiveProbeError('protocol-invalid', 'live Claude stdin write failed');
}

type LiveOutcomeObservation = {
  readonly events: readonly ClaudeLiveWireMarker[];
  readonly finalSeen: boolean;
  readonly textMarkerSeen: boolean;
  readonly interruptSent: boolean;
  readonly interruptAcknowledged: boolean;
  readonly structuredOutputValid: boolean;
};

function validateLiveScenarioOutcome(scenario: ClaudeLiveScenario, observation: LiveOutcomeObservation): ClaudeLiveProbeErrorCode | 'aborted' | 'not-exercised' | undefined {
  const finalSuccess = observation.events.some(event => event.kind === 'final-success');
  const finalStructured = observation.events.some(event => event.kind === 'final-structured');
  const finalError = observation.events.some(event => event.kind === 'final-error');
  if (!observation.finalSeen || (!finalSuccess && !finalStructured && !finalError)) return 'protocol-invalid';
  if (scenario === 't5-cancel') {
    if (!observation.interruptSent) return 'not-exercised';
    if (finalSuccess || finalStructured) return 'not-exercised';
    if (!finalError) return 'protocol-invalid';
    const finalIndex = observation.events.findIndex(event => event.kind === 'final-error');
    const interruptReceiptIndex = observation.events.findIndex(
      event => event.kind === 'control-response' && typeof event.label === 'string' && event.label.startsWith('interrupt-'),
    );
    // A terminal result racing the interrupt receipt is inconclusive. It is
    // not a protocol failure and must never be reported as an exercised
    // cancellation: the interrupt may have arrived after the model finished.
    if (interruptReceiptIndex < 0 || finalIndex < 0 || finalIndex < interruptReceiptIndex) return 'not-exercised';
    if (!observation.interruptAcknowledged) return 'not-exercised';
    // Only the explicitly labelled aborted result subtypes prove that the
    // interrupt stopped the turn. Standalone/non-cancel errors are failures,
    // not aborted turns.
    if (!observation.events.some(event => event.kind === 'final-error' && event.label?.startsWith('cancelled-'))) return 'fixture-invalid';
    return 'aborted';
  }
  if (scenario === 't4-structured') {
    if (!finalStructured || !observation.structuredOutputValid) return 'fixture-invalid';
    return undefined;
  }
  if (!finalSuccess || !observation.textMarkerSeen) return 'fixture-invalid';
  if (scenario === 't1-start' && !observation.events.some(event => event.kind === 'stream-delta')) return 'fixture-invalid';
  return undefined;
}

function wireTextMarkerSeen(events: readonly ClaudeLiveWireMarker[]): boolean {
  return events.some(event => event.label === 'expected-text-marker');
}

function validateWireDiagnostic(value: unknown): ClaudeLiveWireDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaudeLiveProbeError('ledger-invalid', 'wire diagnostic is invalid');
  const record = value as Record<string, unknown>;
  const wireCode = record.wireCode;
  const lineNumber = record.lineNumber;
  const bytesReceived = record.bytesReceived;
  if (Object.keys(record).some(key => !['wireCode', 'lineNumber', 'bytesReceived'].includes(key)) || typeof wireCode !== 'string' || wireCode.length === 0 || wireCode.length > 64 || !Number.isSafeInteger(lineNumber) || (lineNumber as number) < 0 || (lineNumber as number) > 2_000 || !Number.isSafeInteger(bytesReceived) || (bytesReceived as number) < 0 || (bytesReceived as number) > MAX_STDOUT_BYTES) {
    throw new ClaudeLiveProbeError('ledger-invalid', 'wire diagnostic is invalid');
  }
  return { wireCode, lineNumber: lineNumber as number, bytesReceived: bytesReceived as number };
}

function validateLedgerDocument(value: unknown): LiveLedgerDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger must be an object');
  const record = value as Record<string, unknown>;
  assertLedgerKeys(record, ['schemaVersion', 'maxTurns', 'consumedTurns', 'records']);
  if (
    record.schemaVersion !== CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.maxTurns) ||
    (record.maxTurns as number) < 1 ||
    !Number.isSafeInteger(record.consumedTurns) ||
    (record.consumedTurns as number) < 0 ||
    !Array.isArray(record.records)
  ) {
    throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger schema is invalid');
  }
  const records: LiveLedgerRecord[] = [];
  let consumedTurns = 0;
  for (let index = 0; index < record.records.length; index += 1) {
    const item = record.records[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger record is invalid');
    const current = item as Record<string, unknown>;
    assertLedgerKeys(current, ['turnId', 'index', 'reservationTurns', 'scenario', 'action', 'claudeVersion', 'status', 'outcome', 'reservedAt', 'completedAt', 'sessionIdHash', 'fixtureFile', 'eventCount', 'stdoutBytes', 'stderrBytes', 'failureCode', 'fixturePersistenceFailureCode', 'wireDiagnostic']);
    if (typeof current.scenario !== 'string' || !isScenario(current.scenario)) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger ordering or scenario is invalid');
    }
    const reservationTurns = liveReservationTurns(current.scenario);
    if (
      current.reservationTurns !== reservationTurns ||
      current.index !== consumedTurns + 1 ||
      current.turnId !== `turn-${current.index}`
    ) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger ordering or reservation size is invalid');
    }
    consumedTurns += reservationTurns;
    const action = CLAUDE_LIVE_SCENARIOS[current.scenario].action;
    if (current.action !== action || !['reserved', 'completed', 'failed', 'unknown-recovery', 'aborted', 'timed-out', 'not-exercised'].includes(String(current.status))) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger record status is invalid');
    }
    if (current.claudeVersion !== undefined && (typeof current.claudeVersion !== 'string' || parseClaudeVersion(current.claudeVersion) !== current.claudeVersion)) {
      throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger Claude version evidence is invalid');
    }
    if (typeof current.reservedAt !== 'string' || current.reservedAt.length > 64) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger timestamp is invalid');
    if (current.completedAt !== undefined && (typeof current.completedAt !== 'string' || current.completedAt.length > 64)) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger completion timestamp is invalid');
    if (current.sessionIdHash !== undefined && typeof current.sessionIdHash === 'string') assertHash(current.sessionIdHash);
    else if (current.sessionIdHash !== undefined) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger session ID hash is invalid');
    if (current.fixtureFile !== undefined && typeof current.fixtureFile === 'string') assertFixtureFileName(current.fixtureFile);
    else if (current.fixtureFile !== undefined) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger fixture file is invalid');
    for (const key of ['eventCount', 'stdoutBytes', 'stderrBytes'] as const) {
      if (current[key] !== undefined && (!Number.isSafeInteger(current[key]) || (current[key] as number) < 0 || (current[key] as number) > MAX_STDOUT_BYTES * 16)) {
        throw new ClaudeLiveProbeError('ledger-invalid', `live turn ledger ${key} is invalid`);
      }
    }
    if (current.failureCode !== undefined && (typeof current.failureCode !== 'string' || !LIVE_FAILURE_CODES.has(current.failureCode as ClaudeLiveProbeErrorCode))) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger failure code is invalid');
    if (current.fixturePersistenceFailureCode !== undefined && current.fixturePersistenceFailureCode !== 'fixture-invalid' && current.fixturePersistenceFailureCode !== 'output-limit') throw new ClaudeLiveProbeError('ledger-invalid', 'live turn fixture persistence failure code is invalid');
    if (current.outcome !== undefined && !['not_started', 'completed', 'failed_before_start', 'unknown_after_dispatch'].includes(String(current.outcome))) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger outcome is invalid');
    assertLiveTerminalInvariant(current.status, current.outcome, true);
    if (current.wireDiagnostic !== undefined) validateWireDiagnostic(current.wireDiagnostic);
    records.push({
      turnId: current.turnId,
      index: current.index,
      reservationTurns,
      scenario: current.scenario,
      action,
      ...(typeof current.claudeVersion === 'string' ? { claudeVersion: current.claudeVersion } : {}),
      ...(typeof current.sessionIdHash === 'string' ? { sessionIdHash: assertHash(current.sessionIdHash) } : {}),
      status: current.status as LiveLedgerRecord['status'],
      reservedAt: current.reservedAt,
      ...(typeof current.completedAt === 'string' ? { completedAt: current.completedAt } : {}),
      ...(typeof current.fixtureFile === 'string' ? { fixtureFile: validateFixtureFileName(current.fixtureFile) } : {}),
      ...(typeof current.eventCount === 'number' ? { eventCount: current.eventCount } : {}),
      ...(typeof current.stdoutBytes === 'number' ? { stdoutBytes: current.stdoutBytes } : {}),
      ...(typeof current.stderrBytes === 'number' ? { stderrBytes: current.stderrBytes } : {}),
      ...(typeof current.failureCode === 'string' ? { failureCode: current.failureCode as ClaudeLiveProbeErrorCode } : {}),
      ...(typeof current.fixturePersistenceFailureCode === 'string' ? { fixturePersistenceFailureCode: current.fixturePersistenceFailureCode as 'fixture-invalid' | 'output-limit' } : {}),
      ...(typeof current.outcome === 'string' ? { outcome: current.outcome as LiveLedgerRecord['outcome'] } : {}),
      ...(current.wireDiagnostic === undefined ? {} : { wireDiagnostic: validateWireDiagnostic(current.wireDiagnostic) }),
    });
  }
  if (record.consumedTurns !== consumedTurns) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger consumed-turn count is invalid');
  return { schemaVersion: CLAUDE_LIVE_FIXTURE_SCHEMA_VERSION, maxTurns: record.maxTurns as number, consumedTurns, records };
}

const LIVE_FAILURE_CODES = new Set<ClaudeLiveProbeErrorCode>([
  'opt-in-required',
  'ledger-invalid',
  'ledger-locked',
  'workspace-invalid',
  'profile-invalid',
  'profile-not-ready',
  'executable-invalid',
  'scenario-invalid',
  'session-invalid',
  'fixture-invalid',
  'turn-timeout',
  'turn-aborted',
  'spawn-failed',
  'protocol-invalid',
  'output-limit',
  'cleanup-failed',
]);

function assertLedgerKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) throw new ClaudeLiveProbeError('ledger-invalid', 'live turn ledger contains an unknown key');
}

function assertLiveOptions(options: ClaudeLiveProbeOptions): void {
  if (!options || !options.profile || !options.workspace || !options.executableEvidence) throw new ClaudeLiveProbeError('profile-invalid', 'live probe requires profile, workspace, and executable evidence');
  const hasInjectedRunner = options.metadataProbe !== undefined || options.protocolProcessRunner !== undefined;
  if (hasInjectedRunner && options.executionMode !== 'dry-simulated') {
    throw new ClaudeLiveProbeError('scenario-invalid', 'injected metadata/process runners require explicit dry-simulated execution mode');
  }
  if (!hasInjectedRunner && options.executionMode === 'dry-simulated') {
    throw new ClaudeLiveProbeError('scenario-invalid', 'dry-simulated execution mode requires an injected metadata or process runner');
  }
  if (options.profile.executable === undefined || options.profile.executable !== options.executableEvidence.executable) throw new ClaudeLiveProbeError('executable-invalid', 'live probe requires a pinned profile executable');
  if (options.executableEvidence.kind !== 'claude' || !options.executableEvidence.realpath.startsWith('/') || options.executableEvidence.basename !== 'claude') throw new ClaudeLiveProbeError('executable-invalid', 'live probe requires canonical Claude executable evidence');
  if (!options.profile.versionEvidence.available || options.profile.versionEvidence.version === undefined || parseClaudeVersion(options.profile.versionEvidence.version) !== options.profile.versionEvidence.version) {
    throw new ClaudeLiveProbeError('profile-not-ready', 'live probe requires observed Claude version evidence');
  }
}

function liveEvidence(options: ClaudeLiveProbeOptions): 'live-tested' | 'dry-simulated' {
  return options.executionMode === 'dry-simulated' ? 'dry-simulated' : 'live-tested';
}

/** Copy every profile-owned container before crossing the child boundary. */
function snapshotClaudeLaunchProfile(profile: ClaudeLaunchProfile): ClaudeLaunchProfile {
  const copy = structuredClone(profile) as ClaudeLaunchProfile;
  return deepFreeze(copy);
}

async function assertFreshClaudeMetadata(options: ClaudeLiveProbeOptions): Promise<string> {
  const probe = options.metadataProbe ?? runClaudeMetadataProbe;
  let version;
  try {
    version = await probe({
      profile: options.profile,
      command: 'version',
      executable: options.executableEvidence.executable,
      executableEvidence: options.executableEvidence,
      allowMaterializedConfig: true,
    });
  } catch {
    throw new ClaudeLiveProbeError('profile-not-ready', 'fresh strict Claude version metadata probe failed');
  }
  const observedVersion = version.versionEvidence?.version;
  if (!version.ok || !version.versionEvidence?.available || observedVersion === undefined || parseClaudeVersion(observedVersion) !== observedVersion) {
    throw new ClaudeLiveProbeError('profile-not-ready', 'fresh strict Claude version metadata was missing or malformed');
  }
  if (observedVersion !== options.profile.versionEvidence.version) {
    throw new ClaudeLiveProbeError('profile-not-ready', 'Claude version changed since the launch profile was prepared');
  }
  let auth;
  try {
    auth = await probe({
      profile: options.profile,
      command: 'auth-status',
      executable: options.executableEvidence.executable,
      executableEvidence: options.executableEvidence,
      allowMaterializedConfig: true,
    });
  } catch {
    throw new ClaudeLiveProbeError('profile-not-ready', 'fresh strict Claude auth metadata probe failed');
  }
  if (!auth.ok || !auth.authEvidence?.loggedIn || auth.authEvidence.authMethod !== 'subscription' || auth.authEvidence.apiProvider !== 'firstParty') {
    throw new ClaudeLiveProbeError('profile-not-ready', 'fresh strict Claude auth metadata did not prove first-party subscription access');
  }
  return observedVersion;
}

function sameExecutableEvidence(left: ClaudeExecutableEvidence, right: ClaudeExecutableEvidence): boolean {
  return (
    left.kind === right.kind &&
    left.executable === right.executable &&
    left.realpath === right.realpath &&
    left.basename === right.basename &&
    left.uid === right.uid &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function isOwnedByCurrentUser(uid: unknown): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return currentUid !== undefined && Number.isSafeInteger(currentUid) && Number.isSafeInteger(uid) && uid === currentUid;
}

function livePathIdentity(stat: { dev?: number; ino?: number }, label: string): LivePathIdentity {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) {
    throw new ClaudeLiveProbeError('fixture-invalid', `${label} device and inode identity is unavailable`);
  }
  return { dev: stat.dev as number, ino: stat.ino as number };
}

function sameLivePathIdentity(left: LivePathIdentity, right: LivePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTurnRequest(request: ClaudeLiveTurnRequest, inPlan = false): void {
  if (!request || typeof request !== 'object' || !isScenario(request.scenario)) throw new ClaudeLiveProbeError('scenario-invalid', 'live scenario is not allowlisted');
  if (request.sessionId !== undefined) assertSessionId(request.sessionId, 'sessionId');
  const definition = CLAUDE_LIVE_SCENARIOS[request.scenario];
  if (request.scenario === 't1-start' && request.sessionId !== undefined) {
    throw new ClaudeLiveProbeError('session-invalid', 'T1 session IDs are generated and bound only by the process-local plan ledger');
  }
  if ((definition.action === 'resume' || definition.action === 'fork') && !inPlan) {
    throw new ClaudeLiveProbeError('session-invalid', `${definition.action} is available only through the fixed process-local live plan`);
  }
  if (definition.action !== 'start' && request.sessionId !== undefined) {
    throw new ClaudeLiveProbeError('session-invalid', `${definition.action} cannot provide a new session ID`);
  }
  if (definition.action === 'resume') {
    if (inPlan) {
      if (request.resumeSessionId !== undefined) throw new ClaudeLiveProbeError('session-invalid', 'resume IDs are bound by the process-local plan ledger');
    } else {
      if (request.resumeSessionId === undefined) throw new ClaudeLiveProbeError('session-invalid', 'resume requires an explicit session ID');
      assertSessionId(request.resumeSessionId, 'resumeSessionId');
    }
  }
  if (definition.action === 'fork') {
    if (inPlan) {
      if (request.forkSessionId !== undefined || request.targetSessionId !== undefined) throw new ClaudeLiveProbeError('session-invalid', 'fork IDs are bound by the process-local plan ledger');
    } else {
      if (request.forkSessionId === undefined || request.targetSessionId === undefined) throw new ClaudeLiveProbeError('session-invalid', 'fork requires source and target session IDs');
      assertSessionId(request.forkSessionId, 'forkSessionId');
      assertSessionId(request.targetSessionId, 'targetSessionId');
      if (request.forkSessionId === request.targetSessionId) throw new ClaudeLiveProbeError('session-invalid', 'fork source and target IDs must differ');
    }
  }
}

function assertScenario(value: unknown): asserts value is ClaudeLiveScenario {
  if (typeof value !== 'string' || !isScenario(value)) throw new ClaudeLiveProbeError('scenario-invalid', 'live scenario is not allowlisted');
}

/**
 * Keep terminal status and provider outcome as one state machine.  In
 * particular, a dispatched turn must remain explicitly unknown unless a
 * provider terminal result was observed; it may not be persisted as an
 * ordinary failure or success.
 */
function assertLiveTerminalInvariant(status: unknown, outcome: unknown, allowReserved = false): void {
  const valid =
    status === 'reserved'
      ? allowReserved && outcome === undefined
      : status === 'completed'
        ? outcome === 'completed'
        : status === 'failed'
          ? outcome === 'failed_before_start'
          : status === 'unknown-recovery'
            ? outcome === 'unknown_after_dispatch'
            : status === 'not-exercised'
              ? outcome === 'not_started'
              : status === 'aborted' || status === 'timed-out'
                ? outcome === 'failed_before_start' || outcome === 'unknown_after_dispatch'
                : false;
  if (!valid) {
    throw new ClaudeLiveProbeError('ledger-invalid', `live turn status ${String(status)} has an invalid outcome`);
  }
}

function assertStructuredTurnComplete(document: LiveLedgerDocument): void {
  const structured = document.records.find(record => record.scenario === 't4-structured');
  if (structured?.status !== 'completed' || structured.outcome !== 'completed') {
    throw new ClaudeLiveProbeError('scenario-invalid', 'cancellation cannot begin until structured output completes successfully');
  }
}

function isScenario(value: string): value is ClaudeLiveScenario {
  return Object.prototype.hasOwnProperty.call(CLAUDE_LIVE_SCENARIOS, value) && value.length <= MAX_SCENARIO_LABEL_LENGTH && SCENARIO_LABEL.test(value);
}

function assertSessionId(value: string, label: string): void {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new ClaudeLiveProbeError('session-invalid', `${label} is invalid`);
}

function assertHash(value: string): string {
  if (!/^[0-9a-f]{16}$/.test(value)) throw new ClaudeLiveProbeError('ledger-invalid', 'identifier hash is invalid');
  return value;
}

export function newSessionId(): string {
  const id = randomUUID();
  assertSessionId(id, 'generated sessionId');
  return id;
}

function assertFixtureFileName(value: string): void {
  if (!/^turn-[1-5]\.json$/.test(value)) throw new ClaudeLiveProbeError('ledger-invalid', 'fixture file name is invalid');
}

function validateFixtureFileName(value: string): string {
  assertFixtureFileName(value);
  return value;
}

function assertReservation(value: ClaudeLiveTurnReservation): void {
  if (
    !value ||
    !/^turn-[1-9][0-9]*$/.test(value.turnId) ||
    value.index < 1 ||
    !isScenario(value.scenario) ||
    value.reservationTurns !== liveReservationTurns(value.scenario)
  ) {
    throw new ClaudeLiveProbeError('ledger-invalid', 'live turn reservation is invalid');
  }
  if (value.sessionIdHash !== undefined) assertHash(value.sessionIdHash);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function liveReservationTurns(scenario: ClaudeLiveScenario): number {
  void scenario;
  return 1;
}

function assertLiveProbeOptIn(): void {
  if (process.env[CLAUDE_LIVE_PROBE_ENV] !== CLAUDE_LIVE_PROBE_OPT_IN) {
    throw new ClaudeLiveProbeError('opt-in-required', `set ${CLAUDE_LIVE_PROBE_ENV}=1 to run the authenticated live probe`);
  }
  if (process.env[CLAUDE_LIVE_MARKER_ENV] !== CLAUDE_LIVE_MARKER_VALUE) {
    throw new ClaudeLiveProbeError('opt-in-required', `set ${CLAUDE_LIVE_MARKER_ENV} to the live-spawn marker before spawning Claude`);
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ClaudeLiveProbeError('scenario-invalid', `${label} must be an integer between 1 and ${maximum}`);
  return value;
}
