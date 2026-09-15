/**
 * Offline recovery campaign for the unresolved T04 structured turn.
 *
 * This is deliberately a different campaign and a different ledger from the
 * original probe. It contains a durable, pre-seeded account of the
 * operator-reported turns from that probe and admits the two named workflow
 * reservations: structured replacement, then cancellation. The executor
 * below can run only those fixed recovery scenarios; it never replays the
 * original T4 reservation.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseClaudeVersion, type ClaudeOwnedWorkspace } from './claude-launch-profile';
import type { ClaudeLiveProbeOptions, ClaudeLiveTurnResult } from './claude-live-probe';
export { runClaudeT04RecoveryCampaign } from './claude-live-probe';
import type { ClaudeExecutableEvidence } from './claude-probe';
import { FixtureRedactor } from './redactor';
import type { JsonValue } from './types';

export const CLAUDE_T04_RECOVERY_CAMPAIGN_ID = 't04-structured-replacement-cancellation-recovery-v1';
export const CLAUDE_T04_ORIGINAL_CAMPAIGN_ID = 't04-original-live-plan-v1';
export const CLAUDE_T04_RECOVERY_OPT_IN_ENV = 'RUN_CLAUDE_T04_RECOVERY_CAMPAIGN';
export const CLAUDE_T04_RECOVERY_OPT_IN_VALUE = '1';
/** Source-visible marker used only to prevent accidental live spawning. */
export const CLAUDE_T04_RECOVERY_MARKER_ENV = 'CLAUDE_T04_RECOVERY_MARKER';
export const CLAUDE_T04_RECOVERY_MARKER_VALUE = 'RUN_T04_CLAUDE_PROTOCOL_RECOVERY_CAMPAIGN_V1';
export const CLAUDE_T04_RECOVERY_LEDGER_FILE = '.t04-claude-recovery-ledger.json';
export const CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY = '.t04-claude-recovery-fixtures';
export const CLAUDE_T04_RECOVERY_EVIDENCE_FILE = 'prior-live-evidence.json';
export const CLAUDE_T04_RECOVERY_SCHEMA_VERSION = 1 as const;
export const CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS = 4 as const;

const RECOVERY_ID = /^recovery-(structured-replacement|cancellation)$/;
const MAX_RECOVERY_RESERVATIONS = 2;

export type ClaudeT04RecoveryScenario = 'structured-replacement' | 'cancellation';
export type ClaudeT04RecoveryStatus = 'reserved' | 'running' | 'completed' | 'failed' | 'unknown-recovery' | 'aborted' | 'timed-out' | 'not-exercised';
export type ClaudeT04RecoveryOutcome = 'not_started' | 'completed' | 'failed_before_start' | 'unknown_after_dispatch';

/** Fixed scenario definitions.  These are intentionally not caller supplied. */
export const CLAUDE_T04_RECOVERY_SCENARIOS = deepFreeze({
  'structured-replacement': {
    action: 'start',
    maxTurns: 1,
    prompt: 'Return the structured value required by the supplied schema. Do not call any tools.',
    marker: 'LIVE_STRUCTURED_OK',
    jsonSchema: {
      type: 'object',
      properties: { probe: { type: 'string', enum: ['LIVE_STRUCTURED_OK'] } },
      required: ['probe'],
      additionalProperties: false,
    },
  },
  cancellation: {
    action: 'start',
    maxTurns: 1,
    prompt: 'Begin a long harmless response by counting slowly from one to one hundred. Do not call any tools.',
    marker: undefined,
  },
} as const);

type PriorEvidence = {
  readonly schemaVersion: typeof CLAUDE_T04_RECOVERY_SCHEMA_VERSION;
  readonly source: { readonly kind: 'operator-report'; readonly identity: 'unknown'; readonly reportStatus: 'reported' };
  readonly originalCampaign: typeof CLAUDE_T04_ORIGINAL_CAMPAIGN_ID;
  readonly baseline: 'operator-reported';
  readonly turns: readonly [
    {
      readonly label: 'T1';
      readonly sessionIdHash: 'af25eef3600d3c12';
      readonly status: 'completed';
      readonly outcome: 'completed';
      readonly evidence: readonly ['stream', 'final'];
    },
    {
      readonly label: 'T2';
      readonly sessionIdHash: 'af25eef3600d3c12';
      readonly status: 'completed';
      readonly outcome: 'completed';
    },
    {
      readonly label: 'T3';
      readonly targetSessionIdHash: 'cfc907152ffeef46';
      readonly distinctFork: true;
      readonly status: 'completed';
      readonly outcome: 'completed';
    },
    {
      readonly label: 'T4';
      readonly status: 'unknown-recovery';
      readonly dispatch: 'dispatched';
      readonly outcome: 'unknown_after_dispatch';
      readonly failure: 'protocol-invalid';
      readonly diagnosis: 'protocol-invalid/unsupported-frame';
    },
    {
      readonly label: 'T5';
      readonly status: 'unattempted';
      readonly dispatch: 'not_started';
    },
  ];
  readonly redaction: {
    readonly rawContent: 'omitted';
    readonly pii: 'omitted';
    readonly timings: 'unknown';
    readonly byteCounts: 'unknown';
    readonly exactWirePayload: 'unknown';
  };
};

/**
 * Bounded facts copied from the operator report.  No timing, byte, prompt,
 * account, raw wire, or personal data is reconstructed here.
 */
export const CLAUDE_T04_PRIOR_EVIDENCE: PriorEvidence = deepFreeze({
  schemaVersion: CLAUDE_T04_RECOVERY_SCHEMA_VERSION,
  source: { kind: 'operator-report', identity: 'unknown', reportStatus: 'reported' },
  originalCampaign: CLAUDE_T04_ORIGINAL_CAMPAIGN_ID,
  baseline: 'operator-reported',
  turns: [
    { label: 'T1', sessionIdHash: 'af25eef3600d3c12', status: 'completed', outcome: 'completed', evidence: ['stream', 'final'] },
    { label: 'T2', sessionIdHash: 'af25eef3600d3c12', status: 'completed', outcome: 'completed' },
    { label: 'T3', targetSessionIdHash: 'cfc907152ffeef46', distinctFork: true, status: 'completed', outcome: 'completed' },
    { label: 'T4', status: 'unknown-recovery', dispatch: 'dispatched', outcome: 'unknown_after_dispatch', failure: 'protocol-invalid', diagnosis: 'protocol-invalid/unsupported-frame' },
    { label: 'T5', status: 'unattempted', dispatch: 'not_started' },
  ],
  redaction: { rawContent: 'omitted', pii: 'omitted', timings: 'unknown', byteCounts: 'unknown', exactWirePayload: 'unknown' },
});

export const CLAUDE_T04_PRIOR_EVIDENCE_HASH = hashJson(CLAUDE_T04_PRIOR_EVIDENCE);

export class ClaudeT04RecoveryError extends Error {
  readonly code: 'opt-in-required' | 'ledger-invalid' | 'ledger-locked' | 'scenario-invalid' | 'session-invalid' | 'workspace-invalid' | 'fixture-invalid' | 'executable-invalid' | 'execution-failed';

  constructor(code: ClaudeT04RecoveryError['code'], message: string) {
    super(message);
    this.name = 'ClaudeT04RecoveryError';
    this.code = code;
  }
}

type RecoveryReservationRecord = {
  readonly reservationId: string;
  readonly ordinal: 1 | 2;
  readonly scenario: ClaudeT04RecoveryScenario;
  readonly reservationTurns: 1;
  readonly status: ClaudeT04RecoveryStatus;
  readonly reservedAt: string;
  readonly completedAt?: string;
  readonly outcome?: ClaudeT04RecoveryOutcome;
  /** Hash only; the provider session UUID remains process-local. */
  readonly sessionIdHash?: string;
  readonly claudeVersion?: string;
  readonly executableIdentity?: RecoveryExecutableIdentity;
  readonly fixtureFile?: string;
  readonly eventCount?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly failureCode?: string;
  readonly fixturePersistenceFailureCode?: 'fixture-invalid' | 'output-limit';
};

export type RecoveryExecutableIdentity = Readonly<Pick<ClaudeExecutableEvidence, 'realpath' | 'uid' | 'dev' | 'ino' | 'mode'>>;

type RecoveryPathIdentity = { readonly dev: number; readonly ino: number };

type RecoveryLedgerDocument = {
  readonly schemaVersion: typeof CLAUDE_T04_RECOVERY_SCHEMA_VERSION;
  readonly campaignId: typeof CLAUDE_T04_RECOVERY_CAMPAIGN_ID;
  readonly baselineConsumedTurns: typeof CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS;
  readonly consumedTurns: number;
  readonly priorEvidenceHash: typeof CLAUDE_T04_PRIOR_EVIDENCE_HASH;
  readonly baseline: PriorEvidence;
  readonly reservations: readonly RecoveryReservationRecord[];
};

export type ClaudeT04RecoveryLedgerSnapshot = RecoveryLedgerDocument;

export type ClaudeT04RecoveryReservation = Omit<RecoveryReservationRecord, 'status' | 'reservedAt' | 'completedAt' | 'outcome'> & {
  readonly status: 'reserved';
  readonly reservedAt: string;
};

export type ClaudeT04RecoveryRunningReservation = Omit<RecoveryReservationRecord, 'status' | 'reservedAt' | 'completedAt' | 'outcome'> & {
  readonly status: 'running';
  readonly reservedAt: string;
};

export type ClaudeT04RecoveryExecutionOptions = Readonly<{
  readonly options: ClaudeLiveProbeOptions;
  readonly campaign: ClaudeT04RecoveryCampaign;
  readonly reservation: ClaudeT04RecoveryReservation;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}>;

export type ClaudeT04RecoveryCampaign = Readonly<{
  readonly campaignId: typeof CLAUDE_T04_RECOVERY_CAMPAIGN_ID;
  readonly ledger: ClaudeT04RecoveryLedger;
  readonly scenarios: typeof CLAUDE_T04_RECOVERY_SCENARIOS;
  readonly priorEvidence: typeof CLAUDE_T04_PRIOR_EVIDENCE;
}>;

// These identities are process-local capabilities, not persisted authorization
// data. A JSON/spread clone therefore cannot be mistaken for a prepared
// campaign or a reservation returned by this module.
const preparedCampaigns = new WeakSet<object>();
const campaignLedgers = new WeakMap<object, ClaudeT04RecoveryLedger>();
const preparedReservations = new WeakSet<object>();
const reservationLedgers = new WeakMap<object, ClaudeT04RecoveryLedger>();

/** Internal provenance check used by the recovery executor before probing. */
export function assertPreparedClaudeT04RecoveryCampaign(value: unknown): asserts value is ClaudeT04RecoveryCampaign {
  if (typeof value !== 'object' || value === null || !preparedCampaigns.has(value) || campaignLedgers.get(value) !== (value as ClaudeT04RecoveryCampaign).ledger) {
    throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery campaign provenance is invalid');
  }
}

/** Internal provenance check used by the recovery executor before probing. */
export function assertPreparedClaudeT04RecoveryReservation(value: unknown, ledger: ClaudeT04RecoveryLedger): asserts value is ClaudeT04RecoveryReservation | ClaudeT04RecoveryRunningReservation {
  if (typeof value !== 'object' || value === null || !preparedReservations.has(value) || reservationLedgers.get(value) !== ledger) {
    throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation provenance is invalid');
  }
}

export class ClaudeT04RecoveryLedger {
  readonly path: string;
  readonly fixturesDirectory: string;
  private readonly root: string;
  private readonly lockPath: string;
  private lockHandle?: Awaited<ReturnType<typeof open>>;

  constructor(workspace: ClaudeOwnedWorkspace) {
    if (!workspace || typeof workspace.root !== 'string' || resolve(workspace.root) !== workspace.root) {
      throw new ClaudeT04RecoveryError('workspace-invalid', 'recovery ledger requires a canonical owned workspace');
    }
    this.root = workspace.root;
    this.path = join(this.root, CLAUDE_T04_RECOVERY_LEDGER_FILE);
    this.fixturesDirectory = join(this.root, CLAUDE_T04_RECOVERY_FIXTURES_DIRECTORY);
    this.lockPath = `${this.path}.lock`;
  }

  async initialize(): Promise<ClaudeT04RecoveryLedgerSnapshot> {
    assertRecoveryOptIn();
    return this.withLock(async () => {
      const existing = await this.readOptional();
      const document = existing === undefined ? makeBaselineDocument() : validateLedgerDocument(existing);
      if (existing === undefined) await this.write(document);
      await this.writePriorEvidenceFixture();
      return document;
    });
  }

  async snapshot(): Promise<ClaudeT04RecoveryLedgerSnapshot> {
    const existing = await this.readOptional();
    if (existing === undefined) return this.initialize();
    return validateLedgerDocument(existing);
  }

  async writePriorEvidenceFixture(): Promise<string> {
    await this.ensureWorkspaceRoot();
    const directoryIdentity = await this.ensureFixturesDirectory();
    const path = join(this.fixturesDirectory, CLAUDE_T04_RECOVERY_EVIDENCE_FILE);
    const serialized = `${JSON.stringify(CLAUDE_T04_PRIOR_EVIDENCE, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture is too large');
    try {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        !isOwnedByCurrentUser(stat.uid) ||
        resolve(await realpath(path)) !== path
      ) {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture must be a private real file');
      }
      const identity = pathIdentity(stat, 'prior evidence fixture');
      await this.assertFixturesDirectoryIdentity(directoryIdentity);
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let current: string;
      try {
        current = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      await this.assertFixturesDirectoryIdentity(directoryIdentity);
      const after = await lstat(path);
      if (
        !samePathIdentity(identity, pathIdentity(after, 'prior evidence fixture')) ||
        after.isSymbolicLink() ||
        !after.isFile() ||
        (after.mode & 0o777) !== 0o600 ||
        !isOwnedByCurrentUser(after.uid) ||
        resolve(await realpath(path)) !== path
      ) {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture identity changed while it was read');
      }
      if (current !== serialized) throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture was modified');
    } catch (error) {
      if (error instanceof ClaudeT04RecoveryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture could not be read');
      await this.assertFixturesDirectoryIdentity(directoryIdentity);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      } catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture appeared during exclusive creation');
        }
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture could not be created safely');
      }
      try {
        await handle.writeFile(serialized, 'utf8');
      } finally {
        await handle.close();
      }
      await this.assertFixturesDirectoryIdentity(directoryIdentity);
      const created = await lstat(path);
      if (
        created.isSymbolicLink() ||
        !created.isFile() ||
        (created.mode & 0o777) !== 0o600 ||
        !isOwnedByCurrentUser(created.uid) ||
        resolve(await realpath(path)) !== path
      ) {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture failed post-create identity validation');
      }
    }
    return path;
  }

  async reserve(scenario: ClaudeT04RecoveryScenario): Promise<ClaudeT04RecoveryReservation> {
    assertRecoveryOptIn();
    assertScenario(scenario);
    return this.withLock(async () => {
      const document = validateLedgerDocument(await this.readRequired());
      const nextOrdinal = document.reservations.length + 1;
      if (nextOrdinal > MAX_RECOVERY_RESERVATIONS) {
        throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery ledger admits exactly two named scenarios');
      }
      const expectedScenario = nextOrdinal === 1 ? 'structured-replacement' : nextOrdinal === 2 ? 'cancellation' : undefined;
      if (expectedScenario !== undefined && scenario !== expectedScenario) throw new ClaudeT04RecoveryError('scenario-invalid', `recovery scenario must run in order: ${expectedScenario}`);
      if (document.reservations.some(item => item.status === 'unknown-recovery' || item.outcome === 'unknown_after_dispatch')) {
        throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery ledger has an ambiguous dispatch; refusing replay');
      }
      if (document.reservations.some(item => item.scenario === scenario && (item.status === 'reserved' || item.status === 'running'))) {
        throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery scenario already has an active reservation');
      }
      const ordinal = nextOrdinal as 1 | 2;
      const reservation: ClaudeT04RecoveryReservation = {
        reservationId: recoveryReservationId(scenario, ordinal),
        ordinal,
        scenario,
        reservationTurns: 1,
        status: 'reserved',
        reservedAt: new Date().toISOString(),
      };
      await this.write({ ...document, consumedTurns: document.consumedTurns + reservation.reservationTurns, reservations: [...document.reservations, reservation] });
      preparedReservations.add(reservation);
      reservationLedgers.set(reservation, this);
      return reservation;
    });
  }

  async complete(
    reservation: ClaudeT04RecoveryRunningReservation,
    update: {
      readonly status: Exclude<ClaudeT04RecoveryStatus, 'reserved' | 'running'>;
      readonly outcome?: ClaudeT04RecoveryOutcome;
      /** Hash only; the provider session UUID remains process-local. */
      readonly sessionIdHash?: string;
      readonly claudeVersion?: string;
      readonly fixtureFile?: string;
      readonly eventCount?: number;
      readonly stdoutBytes?: number;
      readonly stderrBytes?: number;
      readonly failureCode?: string;
      readonly fixturePersistenceFailureCode?: 'fixture-invalid' | 'output-limit';
    },
  ): Promise<void> {
    if (!reservation || !RECOVERY_ID.test(reservation.reservationId) || reservation.reservationTurns !== 1 || reservation.status !== 'running') throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is invalid');
    assertPreparedClaudeT04RecoveryReservation(reservation, this);
    assertRecoveryTerminalInvariant(update.status, update.outcome);
    return this.withLock(async () => {
      const document = validateLedgerDocument(await this.readRequired());
      const index = document.reservations.findIndex(item => item.reservationId === reservation.reservationId);
      const existing = document.reservations[index];
      if (!existing || existing.status !== 'running' || existing.scenario !== reservation.scenario || existing.ordinal !== reservation.ordinal) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is missing, reused, or already completed');
      }
      assertCompletionTransition(document, existing, update);
      if (update.claudeVersion !== undefined && update.claudeVersion !== existing.claudeVersion) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery completion version evidence changed');
      }
      if (update.sessionIdHash !== undefined && !isValidSessionIdHash(update.sessionIdHash)) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery completion session ID hash is invalid');
      }
      if (existing.sessionIdHash !== undefined && update.sessionIdHash !== existing.sessionIdHash) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery completion session ID hash changed');
      }
      const completed: RecoveryReservationRecord = {
        ...existing,
        ...update,
        status: update.status,
        completedAt: new Date().toISOString(),
      };
      const reservations = [...document.reservations];
      reservations[index] = completed;
      await this.write({ ...document, reservations });
    });
  }

  async start(
    reservation: ClaudeT04RecoveryReservation,
    identity?: { readonly executable: RecoveryExecutableIdentity; readonly claudeVersion: string; readonly sessionIdHash?: string },
  ): Promise<ClaudeT04RecoveryRunningReservation> {
    if (!reservation || !RECOVERY_ID.test(reservation.reservationId) || reservation.reservationTurns !== 1 || reservation.status !== 'reserved') {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is invalid');
    }
    assertPreparedClaudeT04RecoveryReservation(reservation, this);
    return this.withLock(async () => {
      const document = validateLedgerDocument(await this.readRequired());
      const index = document.reservations.findIndex(item => item.reservationId === reservation.reservationId);
      const existing = document.reservations[index];
      if (!existing || existing.status !== 'reserved' || existing.scenario !== reservation.scenario || existing.ordinal !== reservation.ordinal) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is missing, reused, or already started');
      }
      if (existing.scenario === 'cancellation') assertStructuredReplacementComplete(document);
      if (identity !== undefined) {
        if (!isValidExecutableIdentity(identity.executable) || !isValidVersion(identity.claudeVersion)) {
          throw new ClaudeT04RecoveryError('executable-invalid', 'recovery executable identity or version is invalid');
        }
        if (identity.sessionIdHash !== undefined && !isValidSessionIdHash(identity.sessionIdHash)) {
          throw new ClaudeT04RecoveryError('session-invalid', 'recovery session ID hash is invalid');
        }
      }
      const running: RecoveryReservationRecord = {
        ...existing,
        status: 'running',
        ...(identity === undefined ? {} : { executableIdentity: identity.executable, claudeVersion: identity.claudeVersion }),
        ...(identity?.sessionIdHash === undefined ? {} : { sessionIdHash: identity.sessionIdHash }),
      };
      const reservations = [...document.reservations];
      reservations[index] = running;
      await this.write({ ...document, reservations });
      preparedReservations.add(running);
      reservationLedgers.set(running, this);
      return running as ClaudeT04RecoveryRunningReservation;
    });
  }

  /** Finalize a reservation that failed before the running/provider boundary. */
  async failBeforeStart(reservation: ClaudeT04RecoveryReservation, failureCode: string): Promise<void> {
    if (!reservation || !RECOVERY_ID.test(reservation.reservationId) || reservation.reservationTurns !== 1 || reservation.status !== 'reserved') {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is invalid');
    }
    assertPreparedClaudeT04RecoveryReservation(reservation, this);
    if (typeof failureCode !== 'string' || failureCode.length === 0 || failureCode.length > 64) {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery pre-start failure code is invalid');
    }
    return this.withLock(async () => {
      const document = validateLedgerDocument(await this.readRequired());
      const index = document.reservations.findIndex(item => item.reservationId === reservation.reservationId);
      const existing = document.reservations[index];
      if (!existing || existing.status !== 'reserved' || existing.scenario !== reservation.scenario || existing.ordinal !== reservation.ordinal) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is missing, reused, or already started');
      }
      const failed: RecoveryReservationRecord = {
        ...existing,
        status: 'failed',
        outcome: 'failed_before_start',
        failureCode,
        completedAt: new Date().toISOString(),
      };
      const reservations = [...document.reservations];
      reservations[index] = failed;
      await this.write({ ...document, reservations });
    });
  }

  /** Write one bounded sanitized recovery fixture using exclusive creation. */
  async writeFixture(reservation: ClaudeT04RecoveryRunningReservation, value: JsonValue): Promise<string> {
    if (!reservation || !RECOVERY_ID.test(reservation.reservationId) || reservation.reservationTurns !== 1 || reservation.status !== 'running') {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is invalid');
    }
    assertPreparedClaudeT04RecoveryReservation(reservation, this);
    return this.withLock(async () => {
      const document = validateLedgerDocument(await this.readRequired());
      const existing = document.reservations.find(item => item.reservationId === reservation.reservationId);
      if (!existing || existing.status !== 'running') throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is not running');
      const redactor = new FixtureRedactor({ maxDepth: 8, maxStringLength: 2_048, maxArrayItems: 100, maxObjectKeys: 100 });
      const serialized = `${JSON.stringify(redactor.redact(value))}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) throw new ClaudeT04RecoveryError('fixture-invalid', 'recovery fixture is too large');
      const directoryIdentity = await this.ensureFixturesDirectory();
      const filename = `${reservation.reservationId}.json`;
      const path = join(this.fixturesDirectory, filename);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await this.assertFixturesDirectoryIdentity(directoryIdentity);
        handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ClaudeT04RecoveryError('fixture-invalid', 'recovery fixture already exists for this turn');
        if (error instanceof ClaudeT04RecoveryError) throw error;
        throw new ClaudeT04RecoveryError('fixture-invalid', 'recovery fixture could not be created safely');
      } finally {
        await handle?.close();
      }
      await this.assertFixturesDirectoryIdentity(directoryIdentity);
      const created = await lstat(path);
      if (created.isSymbolicLink() || !created.isFile() || (created.mode & 0o777) !== 0o600 || !isOwnedByCurrentUser(created.uid) || resolve(await realpath(path)) !== path) {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'recovery fixture failed post-create identity validation');
      }
      return filename;
    });
  }

  private async readRequired(): Promise<unknown> {
    const value = await this.readOptional();
    if (value === undefined) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger is missing; initialize the pre-seeded campaign first');
    return value;
  }

  private async readOptional(): Promise<unknown | undefined> {
    await this.ensureWorkspaceRoot();
    let text: string;
    try {
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || resolve(await realpath(this.path)) !== this.path) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger must be a private real file');
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof ClaudeT04RecoveryError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger is too large');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger is not valid JSON');
    }
  }

  private async write(document: RecoveryLedgerDocument): Promise<void> {
    await this.ensureWorkspaceRoot();
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger is too large');
    let existingIdentity: RecoveryPathIdentity | undefined;
    try {
      const existing = await lstat(this.path);
      if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o777) !== 0o600 || !isOwnedByCurrentUser(existing.uid) || resolve(await realpath(this.path)) !== this.path) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger must be a private real file');
      }
      existingIdentity = pathIdentity(existing, 'recovery ledger');
    } catch (error) {
      if (error instanceof ClaudeT04RecoveryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger could not be validated');
    }
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: RecoveryPathIdentity | undefined;
    let renamed = false;
    try {
      handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      temporaryIdentity = pathIdentity(await handle.stat(), 'temporary recovery ledger');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      const temporaryBeforeRename = await lstat(temporaryPath);
      if (!samePathIdentity(temporaryIdentity, pathIdentity(temporaryBeforeRename, 'temporary recovery ledger'))) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'temporary recovery ledger identity changed before atomic commit');
      }
      try {
        const beforeRename = await lstat(this.path);
        if (existingIdentity === undefined || !samePathIdentity(existingIdentity, pathIdentity(beforeRename, 'recovery ledger')) || beforeRename.isSymbolicLink() || !beforeRename.isFile() || (beforeRename.mode & 0o777) !== 0o600 || !isOwnedByCurrentUser(beforeRename.uid) || resolve(await realpath(this.path)) !== this.path) {
          throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger identity changed before atomic commit');
        }
      } catch (error) {
        if (error instanceof ClaudeT04RecoveryError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existingIdentity !== undefined) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger changed before atomic commit');
      }
      await rename(temporaryPath, this.path);
      renamed = true;
      const committed = await lstat(this.path);
      if (committed.isSymbolicLink() || !committed.isFile() || (committed.mode & 0o777) !== 0o600 || !isOwnedByCurrentUser(committed.uid) || resolve(await realpath(this.path)) !== this.path) {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger failed post-commit identity validation');
      }
      const directory = await open(this.root, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (!renamed && temporaryIdentity !== undefined) {
        try {
          const temporary = await lstat(temporaryPath);
          if (samePathIdentity(temporaryIdentity, pathIdentity(temporary, 'temporary recovery ledger'))) await unlink(temporaryPath);
        } catch {
          // The temporary path may have been replaced; never remove an
          // artifact whose identity can no longer be tied to this writer.
        }
      }
      if (error instanceof ClaudeT04RecoveryError) throw error;
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger could not be persisted atomically');
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureWorkspaceRoot();
    if (this.lockHandle !== undefined) throw new ClaudeT04RecoveryError('ledger-locked', 'recovery campaign lock is non-reentrant');
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(this.lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ClaudeT04RecoveryError('ledger-locked', 'recovery campaign is already active');
      throw error;
    }
    this.lockHandle = lock;
    try {
      return await operation();
    } finally {
      this.lockHandle = undefined;
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async ensureWorkspaceRoot(): Promise<void> {
    try {
      const stat = await lstat(this.root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || !isOwnedByCurrentUser(stat.uid) || resolve(await realpath(this.root)) !== this.root) throw new ClaudeT04RecoveryError('workspace-invalid', 'recovery workspace must be a private real directory');
    } catch (error) {
      if (error instanceof ClaudeT04RecoveryError) throw error;
      throw new ClaudeT04RecoveryError('workspace-invalid', 'recovery workspace could not be validated');
    }
  }

  private async ensureFixturesDirectory(): Promise<RecoveryPathIdentity> {
    try {
      await mkdir(this.fixturesDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture directory could not be created safely');
      }
    }
    return this.readFixturesDirectoryIdentity();
  }

  private async readFixturesDirectoryIdentity(): Promise<RecoveryPathIdentity> {
    try {
      const stat = await lstat(this.fixturesDirectory);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (stat.mode & 0o777) !== 0o700 ||
        !isOwnedByCurrentUser(stat.uid) ||
        resolve(await realpath(this.fixturesDirectory)) !== this.fixturesDirectory
      ) {
        throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture directory must be a private real owned directory');
      }
      return pathIdentity(stat, 'prior evidence fixture directory');
    } catch (error) {
      if (error instanceof ClaudeT04RecoveryError) throw error;
      throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture directory could not be validated safely');
    }
  }

  private async assertFixturesDirectoryIdentity(expected: RecoveryPathIdentity): Promise<void> {
    const actual = await this.readFixturesDirectoryIdentity();
    if (!samePathIdentity(expected, actual)) throw new ClaudeT04RecoveryError('fixture-invalid', 'prior evidence fixture directory identity changed');
  }
}

export async function prepareClaudeT04RecoveryCampaign(workspace: ClaudeOwnedWorkspace): Promise<ClaudeT04RecoveryCampaign> {
  assertRecoveryOptIn();
  const ledger = new ClaudeT04RecoveryLedger(workspace);
  await ledger.initialize();
  const campaign = Object.freeze({
    campaignId: CLAUDE_T04_RECOVERY_CAMPAIGN_ID,
    ledger,
    scenarios: CLAUDE_T04_RECOVERY_SCENARIOS,
    priorEvidence: CLAUDE_T04_PRIOR_EVIDENCE,
  });
  preparedCampaigns.add(campaign);
  campaignLedgers.set(campaign, ledger);
  return campaign;
}

/** Reserve exactly the two recovery slots in fixed order; this never spawns a child. */
export async function reserveClaudeT04RecoveryCampaign(campaign: ClaudeT04RecoveryCampaign): Promise<readonly [ClaudeT04RecoveryReservation, ClaudeT04RecoveryReservation]> {
  assertPreparedClaudeT04RecoveryCampaign(campaign);
  if (campaign.campaignId !== CLAUDE_T04_RECOVERY_CAMPAIGN_ID) throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery campaign identity is invalid');
  const first = await campaign.ledger.reserve('structured-replacement');
  try {
    const second = await campaign.ledger.reserve('cancellation');
    return Object.freeze([first, second] as const);
  } catch (error) {
    // The first reservation is durable and must not be silently rolled back;
    // callers receive the failure and must reconcile it explicitly.
    throw error;
  }
}

export type ClaudeT04RecoveryTurnResult = Readonly<{
  readonly recoveryScenario: ClaudeT04RecoveryScenario;
  readonly reservation: ClaudeT04RecoveryRunningReservation;
  readonly result: ClaudeLiveTurnResult;
}>;

export function assertRecoveryOptIn(): void {
  if (process.env[CLAUDE_T04_RECOVERY_OPT_IN_ENV] !== CLAUDE_T04_RECOVERY_OPT_IN_VALUE || process.env[CLAUDE_T04_RECOVERY_MARKER_ENV] !== CLAUDE_T04_RECOVERY_MARKER_VALUE) {
    throw new ClaudeT04RecoveryError('opt-in-required', `set ${CLAUDE_T04_RECOVERY_OPT_IN_ENV}=1 and the recovery marker before reserving scenarios`);
  }
}

function makeBaselineDocument(): RecoveryLedgerDocument {
  return {
    schemaVersion: CLAUDE_T04_RECOVERY_SCHEMA_VERSION,
    campaignId: CLAUDE_T04_RECOVERY_CAMPAIGN_ID,
    baselineConsumedTurns: CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS,
    consumedTurns: CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS,
    priorEvidenceHash: CLAUDE_T04_PRIOR_EVIDENCE_HASH,
    baseline: CLAUDE_T04_PRIOR_EVIDENCE,
    reservations: [],
  };
}

function validateLedgerDocument(value: unknown): RecoveryLedgerDocument {
  if (!isRecord(value)) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger must be an object');
  const allowed = ['schemaVersion', 'campaignId', 'baselineConsumedTurns', 'consumedTurns', 'priorEvidenceHash', 'baseline', 'reservations'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger contains an unknown field');
  if (value.schemaVersion !== CLAUDE_T04_RECOVERY_SCHEMA_VERSION || value.campaignId !== CLAUDE_T04_RECOVERY_CAMPAIGN_ID || value.baselineConsumedTurns !== CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS || !Number.isSafeInteger(value.consumedTurns) || (value.consumedTurns as number) < CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS || value.priorEvidenceHash !== CLAUDE_T04_PRIOR_EVIDENCE_HASH || JSON.stringify(value.baseline) !== JSON.stringify(CLAUDE_T04_PRIOR_EVIDENCE) || !Array.isArray(value.reservations)) {
    throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger baseline or integrity hash is invalid');
  }
  if (value.reservations.length > MAX_RECOVERY_RESERVATIONS) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger admits exactly two named scenarios');
  if (value.consumedTurns !== CLAUDE_T04_RECOVERY_BASELINE_CONSUMED_TURNS + value.reservations.length) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery ledger scenario accounting is invalid');
  const reservations: RecoveryReservationRecord[] = [];
  for (let index = 0; index < value.reservations.length; index += 1) {
    const item = value.reservations[index];
    if (!isRecord(item)) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation is invalid');
    const allowedReservationKeys = ['reservationId', 'ordinal', 'scenario', 'reservationTurns', 'status', 'reservedAt', 'completedAt', 'outcome', 'sessionIdHash', 'claudeVersion', 'executableIdentity', 'fixtureFile', 'eventCount', 'stdoutBytes', 'stderrBytes', 'failureCode', 'fixturePersistenceFailureCode'];
    if (Object.keys(item).some(key => !allowedReservationKeys.includes(key)) || item.ordinal !== index + 1 || item.reservationTurns !== 1 || !isScenario(item.scenario) || item.reservationId !== recoveryReservationId(item.scenario, item.ordinal) || !RECOVERY_ID.test(String(item.reservationId)) || !['reserved', 'running', 'completed', 'failed', 'unknown-recovery', 'aborted', 'timed-out', 'not-exercised'].includes(String(item.status)) || typeof item.reservedAt !== 'string' || item.reservedAt.length === 0 || item.reservedAt.length > 64 || (item.completedAt !== undefined && (typeof item.completedAt !== 'string' || item.completedAt.length > 64)) || (item.outcome !== undefined && !['not_started', 'completed', 'failed_before_start', 'unknown_after_dispatch'].includes(String(item.outcome))) || (item.sessionIdHash !== undefined && !isValidSessionIdHash(item.sessionIdHash)) || (item.claudeVersion !== undefined && !isValidVersion(item.claudeVersion)) || (item.executableIdentity !== undefined && !isValidExecutableIdentity(item.executableIdentity)) || (item.fixtureFile !== undefined && !isValidFixtureFileName(item.fixtureFile)) || (item.failureCode !== undefined && (typeof item.failureCode !== 'string' || item.failureCode.length === 0 || item.failureCode.length > 64)) || (item.fixturePersistenceFailureCode !== undefined && item.fixturePersistenceFailureCode !== 'fixture-invalid' && item.fixturePersistenceFailureCode !== 'output-limit') || !areValidCounts(item)) {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation schema is invalid');
    }
    if (item.ordinal === 1 && item.scenario !== 'structured-replacement') throw new ClaudeT04RecoveryError('ledger-invalid', 'structured replacement must be the first recovery reservation');
    if (item.ordinal === 2 && item.scenario !== 'cancellation') throw new ClaudeT04RecoveryError('ledger-invalid', 'cancellation must be the second recovery reservation');
    if (item.ordinal === 2 && item.status !== 'reserved') {
      const structured = value.reservations[0];
      if (!isRecord(structured) || structured.status !== 'completed' || structured.outcome !== 'completed') {
        throw new ClaudeT04RecoveryError('ledger-invalid', 'cancellation state is invalid before structured replacement completion');
      }
    }
    if (item.status === 'failed' && item.outcome !== 'failed_before_start') {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'failed recovery reservations require failed_before_start outcome');
    }
    if (item.status === 'completed' && item.outcome !== 'completed') {
      throw new ClaudeT04RecoveryError('ledger-invalid', 'completed recovery reservations require completed outcome');
    }
    reservations.push(item as unknown as RecoveryReservationRecord);
  }
  return { ...makeBaselineDocument(), consumedTurns: value.consumedTurns as number, baseline: CLAUDE_T04_PRIOR_EVIDENCE, reservations };
}

function isScenario(value: unknown): value is ClaudeT04RecoveryScenario {
  return value === 'structured-replacement' || value === 'cancellation';
}

function isValidVersion(value: unknown): value is string {
  return typeof value === 'string' && parseClaudeVersion(value) === value;
}

function isValidExecutableIdentity(value: unknown): value is RecoveryExecutableIdentity {
  if (!isRecord(value) || typeof value.realpath !== 'string' || value.realpath.length === 0 || value.realpath.length > 4096 || resolve(value.realpath) !== value.realpath) return false;
  return ['uid', 'dev', 'ino', 'mode'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

function isValidFixtureFileName(value: unknown): value is string {
  return typeof value === 'string' && /^recovery-(structured-replacement|cancellation)\.json$/.test(value);
}

function recoveryReservationId(scenario: ClaudeT04RecoveryScenario, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_RECOVERY_RESERVATIONS) throw new ClaudeT04RecoveryError('ledger-invalid', 'recovery reservation ordinal is invalid');
  return `recovery-${scenario}`;
}

function isValidSessionIdHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

function areValidCounts(value: Record<string, unknown>): boolean {
  return ['eventCount', 'stdoutBytes', 'stderrBytes'].every(key => value[key] === undefined || (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 8 * 1024 * 1024));
}

function assertScenario(value: ClaudeT04RecoveryScenario): void {
  if (!isScenario(value)) throw new ClaudeT04RecoveryError('scenario-invalid', 'recovery scenario is not allowlisted');
}

function assertStructuredReplacementComplete(document: RecoveryLedgerDocument): void {
  const structured = document.reservations.find(item => item.scenario === 'structured-replacement');
  if (structured?.status !== 'completed' || structured.outcome !== 'completed') {
    throw new ClaudeT04RecoveryError('scenario-invalid', 'cancellation cannot start until structured replacement completes successfully');
  }
}

function assertCompletionTransition(
  document: RecoveryLedgerDocument,
  existing: RecoveryReservationRecord,
  update: { readonly status: Exclude<ClaudeT04RecoveryStatus, 'reserved'>; readonly outcome?: ClaudeT04RecoveryOutcome },
): void {
  if (existing.scenario === 'cancellation') assertStructuredReplacementComplete(document);
  if (update.status === 'completed' && update.outcome !== 'completed') {
    throw new ClaudeT04RecoveryError('scenario-invalid', 'a completed recovery reservation requires completed outcome');
  }
  if (update.status === 'failed' && update.outcome !== 'failed_before_start') {
    throw new ClaudeT04RecoveryError('ledger-invalid', 'a failed recovery reservation requires failed_before_start outcome');
  }
}

function assertRecoveryTerminalInvariant(status: unknown, outcome: unknown): void {
  const valid =
    status === 'completed'
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
    throw new ClaudeT04RecoveryError('ledger-invalid', `recovery status ${String(status)} has an invalid outcome`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOwnedByCurrentUser(uid: unknown): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return currentUid !== undefined && Number.isSafeInteger(currentUid) && Number.isSafeInteger(uid) && uid === currentUid;
}

function pathIdentity(stat: { dev?: number; ino?: number }, label: string): RecoveryPathIdentity {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) {
    throw new ClaudeT04RecoveryError('fixture-invalid', `${label} device and inode identity is unavailable`);
  }
  return { dev: stat.dev as number, ino: stat.ino as number };
}

function samePathIdentity(left: RecoveryPathIdentity, right: RecoveryPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
