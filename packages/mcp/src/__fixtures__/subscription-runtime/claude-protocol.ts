import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import type { ClaudeLaunchProfile } from './claude-launch-profile';
import type { BoundedResourceScope } from './process-cleanup';
import { FixtureRedactor } from './redactor';
import type { JsonValue } from './types';

/**
 * Evidence labels deliberately distinguish documented CLI switches from the
 * event/control wire.  The latter is represented by sanitized offline
 * fixtures only; no label in this module means that a live turn was run.
 */
export type ClaudeProtocolEvidence =
  | 'public-documentation'
  | 'version-bound-experiment'
  | 'fixture-only'
  | 'live-tested';

export const CLAUDE_PROTOCOL_EVIDENCE = {
  streamJsonFlags: 'public-documentation',
  sessionResumeForkFlags: 'public-documentation',
  eventWire: 'version-bound-experiment',
  controlWire: 'version-bound-experiment',
  fixture: 'fixture-only',
} as const satisfies Readonly<Record<string, ClaudeProtocolEvidence>>;

const DEFAULT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxFrameBytes: 128 * 1024,
  maxFrames: 2_000,
  maxStringLength: 8_192,
  maxJsonDepth: 16,
  maxJsonNodes: 1_024,
  maxJsonKeys: 128,
  maxJsonKeyLength: 256,
} as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PROMPT_LENGTH = 32_768;
const MAX_JSON_SCHEMA_BYTES = 64 * 1024;
const MAX_JSON_SCHEMA_DEPTH = 16;
const MAX_JSON_SCHEMA_NODES = 1_024;
const MAX_JSON_SCHEMA_KEYS = 128;
const MAX_JSON_SCHEMA_KEY_LENGTH = 256;
const MAX_JSON_SCHEMA_STRING_LENGTH = 8_192;
const PERMISSION_DECISION_CLASSIFICATIONS = new Set(['user_temporary', 'user_permanent', 'user_reject']);
const SDK_RESULT_ERROR_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

/** Host-side guard for the version-bound Claude CLI --max-turns switch. */
export function validateClaudeMaxTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new Error('maxTurns must be an integer between 1 and 16');
  }
  return value;
}

export type ClaudeProtocolLimits = {
  /** Total UTF-8 bytes accepted by one parser instance. */
  maxBytes?: number;
  /** Bytes in one physical JSONL line, excluding CR/LF terminators. */
  maxLineBytes?: number;
  /** Bytes in the compact parsed JSON frame, excluding the line terminator. */
  maxFrameBytes?: number;
  /** Number of JSON objects accepted by one parser instance. */
  maxFrames?: number;
  maxStringLength?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
  maxJsonKeys?: number;
  /** Maximum character/byte-safe length of one JSON object key. */
  maxJsonKeyLength?: number;
};

type EffectiveLimits = {
  -readonly [Key in keyof typeof DEFAULT_LIMITS]: number;
};

export type ClaudeProtocolParserOptions = ClaudeProtocolLimits & {
  /** Require every normalized event to carry a session_id. */
  requireSessionId?: boolean;
  /** Reject a frame that belongs to another explicitly selected session. */
  expectedSessionId?: string;
  /** Values known to the host and safe to replace in the sanitized output. */
  secretValues?: Iterable<string>;
  /** Optional state machine that enforces exact control request/response correlation. */
  controlLedger?: ClaudeControlLedger;
};

export type ClaudeProtocolEventBase = {
  readonly evidence: (typeof CLAUDE_PROTOCOL_EVIDENCE)['eventWire'];
  readonly wireType: string;
  readonly sessionId?: string;
};

export type ClaudeSessionEvent = ClaudeProtocolEventBase & {
  readonly kind: 'session';
  readonly subtype: 'init' | 'status';
  readonly sessionId: string;
};

export type ClaudeStreamEvent = ClaudeProtocolEventBase & {
  readonly kind: 'stream';
  readonly text: string;
};

export type ClaudeFinalEvent = ClaudeProtocolEventBase & {
  readonly kind: 'final';
  readonly status: 'success';
  readonly text?: string;
  readonly structuredOutput?: JsonValue;
};

export type ClaudeStructuredEvent = ClaudeProtocolEventBase & {
  readonly kind: 'structured';
  readonly status: 'success';
  readonly value: JsonValue;
};

export type ClaudeErrorEvent = ClaudeProtocolEventBase & {
  readonly kind: 'error';
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
};

export type ClaudeControlRequestEvent = ClaudeProtocolEventBase & {
  readonly kind: 'control-request';
  readonly requestId: string;
  readonly subtype: ClaudeControlRequestSubtype;
  readonly toolName?: string;
  /** SDK can_use_tool correlation ID (snake_case on the wire). */
  readonly toolUseId?: string;
  readonly input?: JsonValue;
  readonly callbackId?: string;
  readonly event?: string;
  readonly payload?: JsonValue;
};

export type ClaudeControlResponseEvent = ClaudeProtocolEventBase & {
  readonly kind: 'control-response';
  readonly requestId: string;
  readonly subtype: 'success' | 'error' | 'cancelled';
  readonly response?: JsonValue;
  readonly message?: string;
  /** Sanitized canonical interrupt receipt, when present. */
  readonly interruptReceipt?: {
    readonly stillQueued: readonly string[];
    readonly cancelled: readonly string[];
  };
  /** Counts only; pending request payloads are never returned. */
  readonly pendingPermissionCount?: number;
  readonly pendingUserDialogCount?: number;
};

export type ClaudeControlCancelRequestEvent = ClaudeProtocolEventBase & {
  readonly kind: 'control-cancel-request';
  readonly requestId: string;
};

export type ClaudeProtocolEvent =
  | ClaudeSessionEvent
  | ClaudeStreamEvent
  | ClaudeFinalEvent
  | ClaudeStructuredEvent
  | ClaudeErrorEvent
  | ClaudeControlRequestEvent
  | ClaudeControlResponseEvent
  | ClaudeControlCancelRequestEvent;

export type ClaudeProtocolErrorCode =
  | 'parser-closed'
  | 'invalid-utf8'
  | 'byte-limit'
  | 'line-limit'
  | 'frame-limit'
  | 'frame-count-limit'
  | 'partial-eof'
  | 'malformed-json'
  | 'non-object'
  | 'malformed-frame'
  | 'unsupported-frame'
  | 'session-mismatch'
  | 'control-correlation';

export class ClaudeProtocolError extends Error {
  readonly code: ClaudeProtocolErrorCode;
  readonly lineNumber: number;
  readonly bytesReceived: number;

  constructor(code: ClaudeProtocolErrorCode, message: string, options: { lineNumber?: number; bytesReceived?: number } = {}) {
    super(message);
    this.name = 'ClaudeProtocolError';
    this.code = code;
    this.lineNumber = options.lineNumber ?? 0;
    this.bytesReceived = options.bytesReceived ?? 0;
  }
}

/**
 * Incremental, strict JSONL parser for the offline Claude protocol fixture.
 * It never returns the parsed wire object.  Only allow-listed, bounded fields
 * are normalized and sensitive strings/keys are redacted before returning.
 */
export class ClaudeJsonlProtocolParser {
  private readonly limits: EffectiveLimits;
  private readonly requireSessionId: boolean;
  private readonly expectedSessionId?: string;
  private readonly controlLedger?: ClaudeControlLedger;
  private readonly redactor: FixtureRedactor;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  /** Raw bytes in the current physical line, including a possible CR terminator. */
  private pendingLineBytes = 0;
  private pendingLineLastByte?: number;
  private bytesReceived = 0;
  private lineNumber = 0;
  private frameCount = 0;
  private ended = false;
  private failed = false;

  constructor(options: ClaudeProtocolParserOptions = {}) {
    this.limits = resolveLimits(options);
    this.requireSessionId = options.requireSessionId ?? false;
    this.expectedSessionId = options.expectedSessionId === undefined ? undefined : sessionId(options.expectedSessionId, 'expectedSessionId');
    this.controlLedger = options.controlLedger;
    this.redactor = new FixtureRedactor({
      secretValues: options.secretValues,
      maxDepth: this.limits.maxJsonDepth,
      maxStringLength: this.limits.maxStringLength,
      maxArrayItems: this.limits.maxJsonNodes,
      maxObjectKeys: this.limits.maxJsonKeys,
    });
  }

  get receivedBytes(): number {
    return this.bytesReceived;
  }

  get framesParsed(): number {
    return this.frameCount;
  }

  push(chunk: string | Uint8Array): ClaudeProtocolEvent[] {
    this.assertWritable();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const nextBytesReceived = this.bytesReceived + bytes.byteLength;
    this.bytesReceived = Math.min(nextBytesReceived, this.limits.maxBytes);
    const events: ClaudeProtocolEvent[] = [];

    // Decode one byte at a time.  TextDecoder otherwise rejects an entire
    // chunk before returning any preceding text, which loses the completed
    // lines needed to identify an invalid byte's actual JSONL line.  This
    // remains incremental across chunks, so split UTF-8 sequences retain the
    // decoder's state while line/byte limits are checked against raw bytes.
    const bytesToProcess = Math.min(bytes.byteLength, Math.max(0, this.limits.maxBytes - (nextBytesReceived - bytes.byteLength)));
    for (let index = 0; index < bytesToProcess; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) continue;
      this.pendingLineBytes += 1;
      this.pendingLineLastByte = byte;

      let decoded: string;
      try {
        decoded = this.decoder.decode(bytes.subarray(index, index + 1), { stream: true });
      } catch {
        throw this.fail(this.pendingLineError('invalid-utf8', 'protocol input is not valid UTF-8'));
      }

      if (decoded === '\n') {
        // LF is always the physical line terminator.  A preceding CR is the
        // other half of CRLF and must not count toward maxLineBytes (nor be
        // passed to JSON.parse as part of the frame).  Keep a bare CR in the
        // line when it is followed by anything other than LF; only this
        // confirmed CRLF pair is stripped.
        const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
        this.pending = '';
        this.pendingLineBytes = 0;
        this.pendingLineLastByte = undefined;
        this.lineNumber += 1;
        events.push(this.parseLine(line));
      } else {
        this.pending += decoded;
        if (this.pendingLineBytes - (this.pendingLineLastByte === 0x0d ? 1 : 0) > this.limits.maxLineBytes) {
          throw this.fail(this.pendingLineError('line-limit', 'protocol line limit exceeded'));
        }
      }
    }

    if (nextBytesReceived > this.limits.maxBytes) {
      throw this.fail(this.protocolError('byte-limit', 'protocol byte limit exceeded', this.nextLineNumber()));
    }
    return events;
  }

  end(): void {
    this.assertWritable();
    try {
      this.decoder.decode();
    } catch {
      throw this.fail(this.pendingLineError('invalid-utf8', 'protocol input ended with an incomplete UTF-8 sequence'));
    }
    this.ended = true;
    if (this.pending.length > 0) {
      throw this.fail(this.pendingLineError('partial-eof', 'protocol ended before a JSONL line terminator'));
    }
  }

  private parseLine(line: string): ClaudeProtocolEvent {
    if (byteLength(line) > this.limits.maxLineBytes) {
      throw this.fail(this.lineError('line-limit', 'protocol line limit exceeded'));
    }
    if (line.length === 0) {
      throw this.fail(this.lineError('malformed-frame', 'blank JSONL lines are not allowed'));
    }
    if (this.frameCount >= this.limits.maxFrames) {
      throw this.fail(this.lineError('frame-count-limit', 'protocol frame count limit exceeded'));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw this.fail(this.lineError('malformed-json', 'protocol line is not valid JSON'));
    }
    if (!isRecord(parsed)) {
      throw this.fail(this.lineError('non-object', 'protocol frames must be JSON objects'));
    }
    const compactBytes = byteLength(JSON.stringify(parsed));
    if (compactBytes > this.limits.maxFrameBytes) {
      throw this.fail(this.lineError('frame-limit', 'protocol frame limit exceeded'));
    }
    this.assertJsonValue(parsed, 'frame');
    this.frameCount += 1;
    try {
      const normalized = this.normalizeFrame(parsed);
      if (this.controlLedger && isControlEvent(normalized)) this.controlLedger.apply(normalized);
      return normalized;
    } catch (error) {
      if (error instanceof ClaudeProtocolError) throw this.fail(this.withContext(error));
      if (error instanceof ClaudeControlLedgerError) {
        throw this.fail(this.lineError('control-correlation', error.message));
      }
      throw this.fail(this.lineError('malformed-frame', 'protocol frame shape is invalid'));
    }
  }

  private normalizeFrame(frame: Record<string, unknown>): ClaudeProtocolEvent {
    const wireType = frame.type;
    if (typeof wireType !== 'string' || !LABEL_PATTERN.test(wireType)) {
      throw this.lineError('unsupported-frame', 'protocol frame type is unsupported');
    }

    switch (wireType) {
      case 'system':
        return this.normalizeSystem(frame, wireType);
      case 'stream_event':
        return this.normalizeStream(frame, wireType);
      case 'result':
        return this.normalizeResult(frame, wireType);
      case 'error':
        return this.normalizeError(frame, wireType);
      case 'control_request':
        return this.normalizeControlRequest(frame, wireType);
      case 'control_response':
        return this.normalizeControlResponse(frame, wireType);
      case 'control_cancel_request':
        return this.normalizeControlCancelRequest(frame, wireType);
      default:
        throw this.lineError('unsupported-frame', 'protocol frame type is unsupported');
    }
  }

  private normalizeSystem(frame: Record<string, unknown>, wireType: string): ClaudeSessionEvent {
    const subtype = enumValue(frame.subtype, ['init', 'status'] as const, 'system subtype');
    const sessionId = this.frameSessionId(frame, subtype === 'init');
    if (!sessionId) throw this.lineError('malformed-frame', 'system frame requires session_id');
    return { kind: 'session', subtype, sessionId, wireType, evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire };
  }

  private normalizeStream(frame: Record<string, unknown>, wireType: string): ClaudeStreamEvent {
    const sessionId = this.frameSessionId(frame);
    const event = requiredRecord(frame.event, 'stream event');
    if (event.type !== 'content_block_delta') throw this.lineError('unsupported-frame', 'stream event subtype is unsupported');
    const delta = requiredRecord(event.delta, 'stream delta');
    if (delta.type !== 'text_delta') throw this.lineError('unsupported-frame', 'stream delta subtype is unsupported');
    const text = this.safeString(delta.text, 'stream text');
    return {
      kind: 'stream',
      ...(sessionId === undefined ? {} : { sessionId }),
      text,
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
  }

  private normalizeResult(frame: Record<string, unknown>, wireType: string): ClaudeProtocolEvent {
    if (typeof frame.subtype !== 'string') throw this.lineError('malformed-frame', 'result subtype is invalid');
    const subtype = frame.subtype;
    const sessionId = this.frameSessionId(frame);
    if (SDK_RESULT_ERROR_SUBTYPES.has(subtype)) return this.normalizeSdkResultError(frame, wireType, sessionId, subtype);
    if (subtype === 'error') return this.normalizeResultError(frame, wireType, sessionId);
    if (subtype === 'cancelled') {
      return {
        kind: 'error',
        ...(sessionId === undefined ? {} : { sessionId }),
        code: 'cancelled',
        message: this.safeString(frame.reason ?? 'protocol turn cancelled', 'cancellation reason'),
        wireType,
        evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
      };
    }

    const text = frame.result === undefined ? undefined : this.safeString(frame.result, 'final result');
    const structuredOutput = frame.structured_output === undefined ? undefined : this.safeStructured(frame.structured_output);
    if (text === undefined && structuredOutput === undefined) {
      throw this.lineError('malformed-frame', 'successful result requires result or structured_output');
    }
    const finalEvent: ClaudeFinalEvent = {
      kind: 'final',
      status: 'success',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(text === undefined ? {} : { text }),
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
    // A result frame may carry both textual and structured output.  Keep both
    // values on the normalized final event rather than silently discarding
    // the text just because structured_output is present.  A structured-only
    // frame retains the dedicated structured event shape for callers that
    // consume structured output directly.
    if (structuredOutput === undefined || text !== undefined) return finalEvent;
    return {
      kind: 'structured',
      status: 'success',
      ...(sessionId === undefined ? {} : { sessionId }),
      value: structuredOutput,
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
  }

  private normalizeSdkResultError(
    frame: Record<string, unknown>,
    wireType: string,
    sessionId: string | undefined,
    subtype: string,
  ): ClaudeErrorEvent {
    if (frame.is_error !== true || !Array.isArray(frame.errors) || frame.errors.length > 64 || frame.errors.some(error => typeof error !== 'string')) {
      throw this.lineError('malformed-frame', 'SDK result error requires bounded is_error and errors fields');
    }
    const message = frame.errors.length === 0 ? 'Claude result error' : this.safeString(frame.errors[0], 'result error');
    return {
      kind: 'error',
      ...(sessionId === undefined ? {} : { sessionId }),
      code: subtype,
      message,
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
  }

  private normalizeResultError(frame: Record<string, unknown>, wireType: string, sessionId?: string): ClaudeErrorEvent {
    const value = frame.error;
    if (typeof value === 'string') {
      return {
        kind: 'error',
        ...(sessionId === undefined ? {} : { sessionId }),
        code: 'vendor-error',
        message: this.safeString(value, 'error message'),
        wireType,
        evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
      };
    }
    const error = requiredRecord(value, 'error');
    const code = error.code === undefined ? 'vendor-error' : this.safeLabel(error.code, 'error code');
    const message = this.safeString(error.message, 'error message');
    return {
      kind: 'error',
      ...(sessionId === undefined ? {} : { sessionId }),
      code,
      message,
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
  }

  private normalizeError(frame: Record<string, unknown>, wireType: string): ClaudeErrorEvent {
    const sessionId = this.frameSessionId(frame);
    const value = frame.error;
    if (typeof value === 'string') {
      return {
        kind: 'error',
        ...(sessionId === undefined ? {} : { sessionId }),
        code: 'vendor-error',
        message: this.safeString(value, 'error message'),
        wireType,
        evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
      };
    }
    const error = requiredRecord(value, 'error');
    return {
      kind: 'error',
      ...(sessionId === undefined ? {} : { sessionId }),
      code: error.code === undefined ? 'vendor-error' : this.safeLabel(error.code, 'error code'),
      message: this.safeString(error.message, 'error message'),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    };
  }

  private normalizeControlRequest(frame: Record<string, unknown>, wireType: string): ClaudeControlRequestEvent {
    const sessionId = this.frameSessionId(frame);
    const requestId = requestIdValue(frame.request_id);
    const request = requiredRecord(frame.request, 'control request');
    const subtype = enumValue(request.subtype, ['interrupt', 'can_use_tool', 'hook_callback'] as const, 'control request subtype');
    if (subtype === 'interrupt') {
      if (Object.keys(request).some(key => key !== 'subtype')) throw this.lineError('malformed-frame', 'interrupt control request has extra fields');
      return this.controlRequestBase(sessionId, requestId, subtype, wireType);
    }
    if (subtype === 'can_use_tool') {
      const toolName = this.safeLabel(request.tool_name, 'tool name');
      const input = this.safeJson(request.input, 'tool input');
      const toolUseId = this.safeLabel(request.tool_use_id, 'tool use id');
      return { ...this.controlRequestBase(sessionId, requestId, subtype, wireType), toolName, input, toolUseId };
    }
    const callbackId = this.safeLabel(request.callback_id, 'callback id');
    const event = this.safeLabel(request.event, 'hook event');
    const payload = this.safeJson(request.payload, 'hook payload');
    return { ...this.controlRequestBase(sessionId, requestId, subtype, wireType), callbackId, event, payload };
  }

  private normalizeControlResponse(frame: Record<string, unknown>, wireType: string): ClaudeControlResponseEvent {
    const response = requiredRecord(frame.response, 'control response');
    // The SDK places pending-control arrays inside the nested control
    // envelope (`frame.response`), alongside its subtype/request_id/value;
    // they are not fields on the outer stream frame.
    const pendingPermissionCount = validatePendingControlArray(response.pending_permission_requests, 'permission').length;
    const pendingUserDialogCount = validatePendingControlArray(response.pending_user_dialog_requests, 'dialog').length;
    const topLevelSessionId = this.frameSessionId(frame, false);
    const nestedSessionValue: string | undefined = response.session_id === undefined ? undefined : sessionId(response.session_id, 'response session_id');
    if (topLevelSessionId !== undefined && nestedSessionValue !== undefined && topLevelSessionId !== nestedSessionValue) {
      throw this.lineError('session-mismatch', 'control response session IDs do not match');
    }
    const sessionIdValue = topLevelSessionId ?? nestedSessionValue;
    const nestedRequestId = response.request_id;
    const requestId = requestIdValue(frame.request_id ?? nestedRequestId);
    if (frame.request_id !== undefined && nestedRequestId !== undefined && frame.request_id !== nestedRequestId) {
      throw this.lineError('control-correlation', 'control response request IDs do not match');
    }
    const subtype = enumValue(response.subtype, ['success', 'error', 'cancelled'] as const, 'control response subtype');
    const value = response.response === undefined ? undefined : this.safeJson(response.response, 'control response value');
    const message = response.message === undefined ? undefined : this.safeString(response.message, 'control response message');
    const interruptReceipt = subtype === 'success' ? eventInterruptReceipt(value) : undefined;
    return {
      kind: 'control-response',
      ...(sessionIdValue === undefined ? {} : { sessionId: sessionIdValue }),
      requestId,
      subtype,
      ...(value === undefined ? {} : { response: value }),
      ...(message === undefined ? {} : { message }),
      ...(interruptReceipt === undefined ? {} : { interruptReceipt }),
      ...(pendingPermissionCount === 0 ? {} : { pendingPermissionCount }),
      ...(pendingUserDialogCount === 0 ? {} : { pendingUserDialogCount }),
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
  }

  private normalizeControlCancelRequest(frame: Record<string, unknown>, wireType: string): ClaudeControlCancelRequestEvent {
    const sessionId = this.frameSessionId(frame);
    const requestId = requestIdValue(frame.request_id);
    return {
      kind: 'control-cancel-request',
      ...(sessionId === undefined ? {} : { sessionId }),
      requestId,
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
  }

  private controlRequestBase(
    sessionId: string | undefined,
    requestId: string,
    subtype: ClaudeControlRequestSubtype,
    wireType: string,
  ): ClaudeControlRequestEvent {
    return {
      kind: 'control-request',
      ...(sessionId === undefined ? {} : { sessionId }),
      requestId,
      subtype,
      wireType,
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
  }

  private frameSessionId(frame: Record<string, unknown>, required = this.requireSessionId): string | undefined {
    const value = frame.session_id;
    if (value === undefined) {
      if (required) throw this.lineError('malformed-frame', 'protocol frame requires session_id');
      return undefined;
    }
    const current = sessionId(value, 'session_id');
    if (this.expectedSessionId !== undefined && current !== this.expectedSessionId) {
      throw this.lineError('session-mismatch', 'protocol frame session_id does not match the selected session');
    }
    return current;
  }

  private safeString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || byteLength(value) > this.limits.maxStringLength || value.includes('\0')) {
      throw this.lineError('malformed-frame', `${label} must be a bounded non-empty string`);
    }
    return this.redactor.redact(value) as string;
  }

  private safeLabel(value: unknown, label: string): string {
    if (typeof value !== 'string' || !LABEL_PATTERN.test(value)) throw this.lineError('malformed-frame', `${label} is invalid`);
    return this.redactor.redact(value) as string;
  }

  private safeJson(value: unknown, label: string): JsonValue {
    this.assertJsonValue(value, label);
    return this.redactor.redact(value) as JsonValue;
  }

  private safeStructured(value: unknown): JsonValue {
    return this.safeJson(value, 'structured_output');
  }

  private assertJsonValue(value: unknown, label: string): void {
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      nodes += 1;
      if (nodes > this.limits.maxJsonNodes) throw this.lineError('frame-limit', `${label} contains too many JSON values`);
      if (current.depth > this.limits.maxJsonDepth) throw this.lineError('frame-limit', `${label} exceeds JSON depth limit`);
      if (typeof current.value === 'string') {
        if (byteLength(current.value) > this.limits.maxStringLength || current.value.includes('\0')) {
          throw this.lineError('frame-limit', `${label} contains an oversized string`);
        }
        continue;
      }
      if (current.value === null || typeof current.value === 'boolean') continue;
      if (typeof current.value === 'number') {
        if (!Number.isFinite(current.value)) throw this.lineError('malformed-frame', `${label} contains a non-finite number`);
        continue;
      }
      if (Array.isArray(current.value)) {
        for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
        continue;
      }
      if (!isRecord(current.value)) throw this.lineError('malformed-frame', `${label} is not JSON-compatible`);
      const keys = Object.keys(current.value);
      if (keys.length > this.limits.maxJsonKeys) throw this.lineError('frame-limit', `${label} contains too many object keys`);
      for (const key of keys) {
        if (byteLength(key) > this.limits.maxJsonKeyLength) throw this.lineError('frame-limit', `${label} contains an oversized object key`);
        pending.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
  }

  private lineError(code: ClaudeProtocolErrorCode, message: string): ClaudeProtocolError {
    return new ClaudeProtocolError(code, message, { lineNumber: this.lineNumber, bytesReceived: this.bytesReceived });
  }

  private pendingLineError(code: ClaudeProtocolErrorCode, message: string): ClaudeProtocolError {
    return new ClaudeProtocolError(code, message, { lineNumber: this.nextLineNumber(), bytesReceived: this.bytesReceived });
  }

  private protocolError(code: ClaudeProtocolErrorCode, message: string, line: number): ClaudeProtocolError {
    return new ClaudeProtocolError(code, message, { lineNumber: line, bytesReceived: this.bytesReceived });
  }

  private withContext(error: ClaudeProtocolError): ClaudeProtocolError {
    if (error.lineNumber === this.lineNumber && error.bytesReceived === this.bytesReceived) return error;
    return new ClaudeProtocolError(error.code, error.message, { lineNumber: this.lineNumber, bytesReceived: this.bytesReceived });
  }

  private nextLineNumber(): number {
    return this.lineNumber + 1;
  }

  private fail(error: ClaudeProtocolError): ClaudeProtocolError {
    this.failed = true;
    return error;
  }

  private assertWritable(): void {
    if (this.failed || this.ended) {
      throw new ClaudeProtocolError('parser-closed', 'protocol parser is closed', {
        lineNumber: this.nextLineNumber(),
        bytesReceived: this.bytesReceived,
      });
    }
  }
}

export type ClaudeControlRequestSubtype = 'interrupt' | 'can_use_tool' | 'hook_callback';

export type ClaudeControlRequest = {
  readonly type: 'control_request';
  readonly session_id?: string;
  readonly request_id: string;
  readonly request:
    | { readonly subtype: 'interrupt' }
    | { readonly subtype: 'can_use_tool'; readonly tool_name: string; readonly tool_use_id: string; readonly input: JsonValue }
    | { readonly subtype: 'hook_callback'; readonly callback_id: string; readonly event: string; readonly payload: JsonValue };
};

export type ClaudeControlCancelRequest = {
  readonly type: 'control_cancel_request';
  readonly session_id?: string;
  readonly request_id: string;
};

export type ClaudeControlResponse = {
  readonly type: 'control_response';
  readonly session_id?: string;
  readonly request_id: string;
  readonly response: {
    readonly subtype: 'success' | 'error' | 'cancelled';
    readonly response?: JsonValue;
    readonly message?: string;
    /** Parked SDK control requests re-sent on initialize; kept bounded and sanitized. */
    readonly pending_permission_requests?: readonly ClaudePendingControlRequest[];
    readonly pending_user_dialog_requests?: readonly ClaudePendingControlRequest[];
  };
};

/** The narrow SDK request shapes that may occur in initialize pending arrays. */
export type ClaudePendingControlRequest =
  | {
      readonly type: 'control_request';
      readonly request_id: string;
      readonly request: {
        readonly subtype: 'can_use_tool';
        readonly tool_name: string;
        readonly tool_use_id: string;
        readonly input: Record<string, unknown>;
      };
    }
  | {
      readonly type: 'control_request';
      readonly request_id: string;
      readonly request: {
        readonly subtype: 'request_user_dialog';
        readonly dialog_kind: string;
        readonly payload: Record<string, unknown>;
        readonly tool_use_id?: string;
      };
    };

/** Version-bound SDK control payloads retained for offline contract tests. */
export type ClaudePermissionResult =
  | {
      readonly behavior: 'allow';
      readonly updatedInput?: JsonValue;
      readonly updatedPermissions?: JsonValue;
      readonly toolUseID?: string;
      readonly decisionClassification?: string;
    }
  | {
      readonly behavior: 'deny';
      readonly message: string;
      readonly interrupt?: boolean;
      readonly toolUseID?: string;
      readonly decisionClassification?: string;
    };

export type ClaudeInterruptReceipt = {
  readonly still_queued: readonly string[];
  readonly cancelled?: readonly string[];
};

export type ClaudeControlFrame = ClaudeControlRequest | ClaudeControlResponse | ClaudeControlCancelRequest;

export type ClaudeControlLedgerState = 'pending' | 'approved' | 'denied' | 'cancelled' | 'completed' | 'errored';

export type ClaudeControlLedgerOutcome =
  | { readonly kind: 'pending'; readonly status: 'pending' }
  | { readonly kind: 'approval'; readonly status: 'approved' | 'denied'; readonly updatedInput?: JsonValue; readonly message?: string }
  | {
      readonly kind: 'cancellation';
      readonly status: 'cancelled' | 'interrupted' | 'still_queued';
      readonly stillQueued?: readonly string[];
      readonly cancelled?: readonly string[];
      readonly message?: string;
    }
  | { readonly kind: 'completion'; readonly status: 'completed'; readonly value?: JsonValue; readonly message?: string }
  | { readonly kind: 'error'; readonly status: 'errored'; readonly message?: string };

export type ClaudeControlLedgerRecord = {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly requestSubtype: ClaudeControlRequestSubtype;
  readonly toolUseId?: string;
  readonly state: ClaudeControlLedgerState;
  readonly outcome: ClaudeControlLedgerOutcome;
};

export type ClaudeControlLedgerErrorCode =
  | 'duplicate-request'
  | 'unknown-response'
  | 'late-response'
  | 'unknown-cancel'
  | 'late-cancel'
  | 'pending-limit'
  | 'invalid-response'
  | 'session-mismatch';

export class ClaudeControlLedgerError extends Error {
  readonly code: ClaudeControlLedgerErrorCode;
  readonly requestId?: string;

  constructor(code: ClaudeControlLedgerErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'ClaudeControlLedgerError';
    this.code = code;
    this.requestId = requestId;
  }
}

export type ClaudeControlLedgerOptions = {
  /** Maximum unresolved requests retained by the ledger. */
  readonly maxPending?: number;
  /** Maximum finalized records retained for late/duplicate detection. */
  readonly maxCompleted?: number;
  readonly expectedSessionId?: string;
};

/**
 * Small bounded state machine for the bidirectional control fixture. A
 * response is valid only for an exactly matching unresolved request ID;
 * unknown and late responses/cancellations fail closed instead of being
 * silently attached to another approval or interrupt.
 */
export class ClaudeControlLedger {
  private readonly maxPending: number;
  private readonly maxCompleted: number;
  private readonly expectedSessionId?: string;
  private readonly pending = new Map<string, ClaudeControlLedgerRecord>();
  private readonly completed = new Map<string, ClaudeControlLedgerRecord>();

  constructor(options: ClaudeControlLedgerOptions = {}) {
    this.maxPending = boundedLedgerLimit(options.maxPending, 1_024, 'maxPending');
    this.maxCompleted = boundedLedgerLimit(options.maxCompleted, 1_024, 'maxCompleted');
    this.expectedSessionId = options.expectedSessionId === undefined ? undefined : sessionId(options.expectedSessionId, 'expectedSessionId');
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get completedCount(): number {
    return this.completed.size;
  }

  get(requestId: string): ClaudeControlLedgerRecord | undefined {
    return this.pending.get(requestId) ?? this.completed.get(requestId);
  }

  apply(event: ClaudeControlRequestEvent | ClaudeControlResponseEvent | ClaudeControlCancelRequestEvent): ClaudeControlLedgerRecord {
    if (event.kind === 'control-request') return this.acceptRequest(event);
    if (event.kind === 'control-response') return this.acceptResponse(event);
    return this.acceptCancel(event);
  }

  acceptRequest(event: ClaudeControlRequestEvent): ClaudeControlLedgerRecord {
    this.assertSession(event.sessionId);
    if (this.pending.has(event.requestId)) {
      throw new ClaudeControlLedgerError('duplicate-request', 'control request_id is already pending', event.requestId);
    }
    if (this.completed.has(event.requestId)) {
      throw new ClaudeControlLedgerError('duplicate-request', 'control request_id was already finalized', event.requestId);
    }
    if (this.pending.size >= this.maxPending) {
      throw new ClaudeControlLedgerError('pending-limit', 'pending control request limit exceeded', event.requestId);
    }
    const record: ClaudeControlLedgerRecord = {
      requestId: event.requestId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      requestSubtype: event.subtype,
      ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
      state: 'pending',
      outcome: { kind: 'pending', status: 'pending' },
    };
    this.pending.set(event.requestId, record);
    return record;
  }

  acceptResponse(event: ClaudeControlResponseEvent): ClaudeControlLedgerRecord {
    this.assertSession(event.sessionId);
    const pending = this.pending.get(event.requestId);
    if (!pending) {
      if (this.completed.has(event.requestId)) {
        throw new ClaudeControlLedgerError('late-response', 'control response arrived after request finalization', event.requestId);
      }
      throw new ClaudeControlLedgerError('unknown-response', 'control response has no matching request', event.requestId);
    }
    this.assertPendingSession(event.sessionId, pending.sessionId, event.requestId);
    const finalized = this.normalizeResponse(pending, event);
    this.finalize(event.requestId, finalized);
    return finalized;
  }

  acceptCancel(event: ClaudeControlCancelRequestEvent): ClaudeControlLedgerRecord {
    this.assertSession(event.sessionId);
    const pending = this.pending.get(event.requestId);
    if (!pending) {
      if (this.completed.has(event.requestId)) {
        throw new ClaudeControlLedgerError('late-cancel', 'control cancellation arrived after request finalization', event.requestId);
      }
      throw new ClaudeControlLedgerError('unknown-cancel', 'control cancellation has no matching request', event.requestId);
    }
    this.assertPendingSession(event.sessionId, pending.sessionId, event.requestId);
    const finalized: ClaudeControlLedgerRecord = {
      ...pending,
      state: 'cancelled',
      outcome: { kind: 'cancellation', status: 'cancelled', message: 'vendor cancelled the pending control request' },
    };
    this.finalize(event.requestId, finalized);
    return finalized;
  }

  private normalizeResponse(pending: ClaudeControlLedgerRecord, event: ClaudeControlResponseEvent): ClaudeControlLedgerRecord {
    const value = event.response;
    if (event.subtype === 'error') {
      return { ...pending, state: 'errored', outcome: { kind: 'error', status: 'errored', ...(event.message === undefined ? {} : { message: event.message }) } };
    }
    if (event.subtype === 'cancelled') {
      return {
        ...pending,
        state: 'cancelled',
        outcome: { kind: 'cancellation', status: 'cancelled', ...(event.message === undefined ? {} : { message: event.message }) },
      };
    }

    if (pending.requestSubtype === 'can_use_tool') {
      if (!isRecord(value) || (value.behavior !== 'allow' && value.behavior !== 'deny')) {
        throw new ClaudeControlLedgerError('invalid-response', 'can_use_tool success must contain behavior allow or deny', event.requestId);
      }
      const permission = validatePermissionResult(value, pending.toolUseId);
      const message = event.message ?? (typeof value.message === 'string' ? value.message : undefined);
      if (permission.behavior === 'allow') {
        const updatedInput = permission.updatedInput === undefined ? undefined : validateLedgerJson(permission.updatedInput);
        return {
          ...pending,
          state: 'approved',
          outcome: { kind: 'approval', status: 'approved', ...(updatedInput === undefined ? {} : { updatedInput }), ...(message === undefined ? {} : { message }) },
        };
      }
      return { ...pending, state: 'denied', outcome: { kind: 'approval', status: 'denied', ...(message === undefined ? {} : { message }) } };
    }

    if (pending.requestSubtype === 'interrupt') {
      const cancellation = cancellationStatus(value);
      if (cancellation === undefined) {
        throw new ClaudeControlLedgerError(
          'invalid-response',
          'interrupt success must contain canonical still_queued/cancelled arrays or an explicitly version-bound legacy status',
          event.requestId,
        );
      }
      const receipt = event.interruptReceipt ?? eventInterruptReceipt(value);
      return {
        ...pending,
        state: 'cancelled',
        outcome: {
          kind: 'cancellation',
          status: cancellation,
          ...(receipt === undefined ? {} : { stillQueued: receipt.stillQueued, cancelled: receipt.cancelled }),
          ...(event.message === undefined ? {} : { message: event.message }),
        },
      };
    }
    const safeValue = value === undefined ? undefined : validateLedgerJson(value);
    return {
      ...pending,
      state: 'completed',
      outcome: { kind: 'completion', status: 'completed', ...(safeValue === undefined ? {} : { value: safeValue }), ...(event.message === undefined ? {} : { message: event.message }) },
    };
  }

  private finalize(requestId: string, record: ClaudeControlLedgerRecord): void {
    this.pending.delete(requestId);
    this.completed.set(requestId, record);
    while (this.completed.size > this.maxCompleted) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private assertSession(current?: string): void {
    if (this.expectedSessionId !== undefined && current !== this.expectedSessionId) {
      throw new ClaudeControlLedgerError('session-mismatch', 'control event session_id does not match the selected session');
    }
  }

  private assertPendingSession(current: string | undefined, pending: string | undefined, requestId: string): void {
    if (current !== pending) {
      throw new ClaudeControlLedgerError('session-mismatch', 'control response session_id does not match its request', requestId);
    }
  }
}

export type ClaudeControlWireCommand = {
  readonly kind: 'control';
  readonly action: 'cancel';
  readonly sessionId: string;
  readonly requestId: string;
  readonly frame: ClaudeControlRequest;
  readonly jsonl: string;
  readonly evidence: (typeof CLAUDE_PROTOCOL_EVIDENCE)['controlWire'];
};

export function serializeClaudeControlFrame(
  frame: ClaudeControlFrame,
  options: { readonly secretValues?: Iterable<string> } = {},
): string {
  const redactor = new FixtureRedactor({ secretValues: options.secretValues, maxDepth: 16, maxStringLength: 4_096, maxArrayItems: 256, maxObjectKeys: 128 });
  const safeFrame = normalizeControlWireFrame(frame, redactor);
  return `${JSON.stringify(safeFrame)}\n`;
}

export function buildClaudeCancelCommand(options: { sessionId: string; requestId: string }): ClaudeControlWireCommand {
  const sessionIdValue = sessionId(options.sessionId, 'sessionId');
  const requestIdValueResult = requestIdValue(options.requestId);
  const frame: ClaudeControlRequest = {
    type: 'control_request',
    request_id: requestIdValueResult,
    request: { subtype: 'interrupt' },
  };
  return {
    kind: 'control',
    action: 'cancel',
    sessionId: sessionIdValue,
    requestId: requestIdValueResult,
    frame,
    jsonl: serializeClaudeControlFrame(frame),
    evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
  };
}

export type ClaudeProtocolCommandAction = 'start' | 'resume' | 'fork';

export type ClaudeProtocolCommand = {
  readonly kind: 'turn';
  readonly action: ClaudeProtocolCommandAction;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly evidence: {
    readonly streamJson: (typeof CLAUDE_PROTOCOL_EVIDENCE)['streamJsonFlags'];
    readonly sessionControl: (typeof CLAUDE_PROTOCOL_EVIDENCE)['sessionResumeForkFlags'];
    readonly eventWire: (typeof CLAUDE_PROTOCOL_EVIDENCE)['eventWire'];
  };
};

export type ClaudeProtocolCommandOptions = {
  readonly profile: Pick<ClaudeLaunchProfile, 'executable' | 'argv' | 'cwd' | 'env'>;
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  readonly fork?: boolean;
  readonly prompt?: string;
  readonly jsonSchema?: JsonValue;
  /** Optional bounded per-turn vendor loop limit for the live fixture. */
  readonly maxTurns?: number;
};

export function buildClaudeProtocolCommand(options: ClaudeProtocolCommandOptions): ClaudeProtocolCommand {
  const executable = options.profile.executable;
  if (typeof executable !== 'string' || executable.length === 0 || !executable.startsWith('/')) {
    throw new Error('Claude protocol command requires an absolute executable');
  }
  assertNoProfileSessionControls(options.profile.argv);
  const sessionIdValue = options.sessionId === undefined ? undefined : sessionId(options.sessionId, 'sessionId');
  const resumeSessionIdValue = options.resumeSessionId === undefined ? undefined : sessionId(options.resumeSessionId, 'resumeSessionId');
  if (!options.fork && sessionIdValue !== undefined && resumeSessionIdValue !== undefined) {
    throw new Error('sessionId and resumeSessionId cannot both be set unless fork is true');
  }
  if (options.fork && resumeSessionIdValue === undefined) throw new Error('fork command requires an explicit resumeSessionId');
  if (options.fork && sessionIdValue === undefined) throw new Error('fork command requires an explicit target sessionId');
  if (options.fork && sessionIdValue === resumeSessionIdValue) throw new Error('fork command requires distinct source and target session IDs');
  if (options.prompt !== undefined && (options.prompt.length === 0 || options.prompt.length > MAX_PROMPT_LENGTH || options.prompt.includes('\0'))) {
    throw new Error(`prompt must be a bounded non-empty string of at most ${MAX_PROMPT_LENGTH} characters`);
  }

  // Print mode is required by Claude Code before the stream-json input/output
  // switches take effect, but the prompt itself is delivered exactly once as
  // the SDK-shaped `user` JSONL frame after the initialize handshake.  Keep
  // `-p` and omit every positional prompt so no model turn can dispatch before
  // the host has admitted the session.
  const argv = [...options.profile.argv, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (sessionIdValue !== undefined) argv.push('--session-id', sessionIdValue);
  if (resumeSessionIdValue !== undefined) argv.push('--resume', resumeSessionIdValue);
  if (options.fork) argv.push('--fork-session');
  if (options.jsonSchema !== undefined) {
    const serializedSchema = serializeBoundedJsonValue(options.jsonSchema, {
      maxBytes: MAX_JSON_SCHEMA_BYTES,
      maxDepth: MAX_JSON_SCHEMA_DEPTH,
      maxNodes: MAX_JSON_SCHEMA_NODES,
      maxKeys: MAX_JSON_SCHEMA_KEYS,
      maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH,
      maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH,
    });
    argv.push('--json-schema', serializedSchema);
  }
  if (options.maxTurns !== undefined) {
    argv.push('--max-turns', String(validateClaudeMaxTurns(options.maxTurns)));
  }
  return {
    kind: 'turn',
    action: options.fork ? 'fork' : resumeSessionIdValue === undefined ? 'start' : 'resume',
    executable,
    argv,
    cwd: options.profile.cwd,
    env: { ...options.profile.env },
    evidence: {
      streamJson: CLAUDE_PROTOCOL_EVIDENCE.streamJsonFlags,
      sessionControl: CLAUDE_PROTOCOL_EVIDENCE.sessionResumeForkFlags,
      eventWire: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
    },
  };
}

export function buildClaudeResumeCommand(options: {
  readonly profile: ClaudeProtocolCommandOptions['profile'];
  readonly sessionId: string;
  readonly prompt?: string;
  readonly maxTurns?: number;
}): ClaudeProtocolCommand {
  return buildClaudeProtocolCommand({ profile: options.profile, resumeSessionId: options.sessionId, prompt: options.prompt, maxTurns: options.maxTurns });
}

export function buildClaudeForkCommand(options: {
  readonly profile: ClaudeProtocolCommandOptions['profile'];
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly prompt?: string;
  readonly maxTurns?: number;
}): ClaudeProtocolCommand {
  return buildClaudeProtocolCommand({
    profile: options.profile,
    resumeSessionId: options.sourceSessionId,
    sessionId: options.sessionId,
    fork: true,
    prompt: options.prompt,
    maxTurns: options.maxTurns,
  });
}

export type ClaudeProtocolProcess = {
  readonly child: ChildProcess;
  readonly command: ClaudeProtocolCommand;
  readonly ownership: 'bounded-resource-scope-process-group';
};

/**
 * Starts a command only through BoundedResourceScope.  That scope supplies a
 * detached POSIX process-group leader and owns the subsequent SIGTERM →
 * SIGKILL cleanup; this helper intentionally has no raw-PID fallback.
 */
export function spawnClaudeProtocolProcess(scope: BoundedResourceScope, command: ClaudeProtocolCommand): ClaudeProtocolProcess {
  const child = scope.spawn(command.executable, [...command.argv], {
    cwd: command.cwd,
    env: { ...command.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, command, ownership: 'bounded-resource-scope-process-group' };
}

export function parseClaudeJsonl(input: string | Uint8Array, options: ClaudeProtocolParserOptions = {}): ClaudeProtocolEvent[] {
  const parser = new ClaudeJsonlProtocolParser(options);
  const events = parser.push(input);
  parser.end();
  return events;
}

function resolveLimits(options: ClaudeProtocolLimits): EffectiveLimits {
  const limits = {} as EffectiveLimits;
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS) as Array<[keyof EffectiveLimits, number]>) {
    const value = options[key];
    if (value === undefined) {
      limits[key] = fallback;
    } else if (!Number.isInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
      throw new Error(`protocol ${String(key)} must be an integer between 1 and 16777216`);
    } else {
      limits[key] = value;
    }
  }
  return limits;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ClaudeProtocolError('malformed-frame', `${label} must be an object`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new ClaudeProtocolError('unsupported-frame', `${label} is unsupported`);
  return value as T[number];
}

function sessionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requestIdValue(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) throw new ClaudeProtocolError('malformed-frame', 'request_id is invalid');
  return value;
}

type JsonBounds = {
  maxBytes?: number;
  maxDepth: number;
  maxNodes: number;
  maxKeys: number;
  maxKeyLength: number;
  maxStringLength: number;
};

function assertBoundedJsonValue(value: unknown, bounds: JsonBounds): asserts value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > bounds.maxNodes || current.depth > bounds.maxDepth) throw new Error('JSON value exceeds protocol limits');
    if (typeof current.value === 'string') {
      if (byteLength(current.value) > bounds.maxStringLength || current.value.includes('\0')) throw new Error('JSON value contains an oversized string');
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') {
      if (typeof current.value === 'number' && !Number.isFinite(current.value)) throw new Error('JSON value contains a non-finite number');
      if (typeof current.value === 'function' || typeof current.value === 'symbol' || typeof current.value === 'bigint' || current.value === undefined) {
        throw new Error('JSON value contains an unsupported value');
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else {
      if (!isRecord(current.value)) throw new Error('JSON value contains an unsupported object');
      const keys = Object.keys(current.value);
      if (keys.length > bounds.maxKeys) throw new Error('JSON value contains too many object keys');
      for (const key of keys) {
        if (byteLength(key) > bounds.maxKeyLength) throw new Error('JSON value contains an oversized object key');
        pending.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
  }
  if (bounds.maxBytes !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error('JSON value cannot be serialized');
    }
    if (serialized === undefined || byteLength(serialized) > bounds.maxBytes) throw new Error('JSON value exceeds serialized byte limit');
  }
}

function serializeBoundedJsonValue(value: unknown, bounds: JsonBounds): string {
  assertBoundedJsonValue(value, bounds);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('JSON value cannot be serialized');
  return serialized;
}

function normalizeControlWireFrame(frame: ClaudeControlFrame, redactor: FixtureRedactor): ClaudeControlFrame {
  if (!isRecord(frame) || (frame.type !== 'control_request' && frame.type !== 'control_response')) {
    if (!isRecord(frame) || frame.type !== 'control_cancel_request') throw new Error('control frame type is invalid');
  }
  const session_id = frame.session_id === undefined ? undefined : sessionId(frame.session_id, 'session_id');
  const request_id = requestIdValue(frame.request_id);
  if (frame.type === 'control_cancel_request') {
    return { type: 'control_cancel_request', ...(session_id === undefined ? {} : { session_id }), request_id };
  }
  if (frame.type === 'control_request') {
    const request = requiredRecord(frame.request, 'control request');
    const subtype = enumValue(request.subtype, ['interrupt', 'can_use_tool', 'hook_callback'] as const, 'control request subtype');
    if (subtype === 'interrupt') {
      if (Object.keys(request).some(key => key !== 'subtype')) throw new Error('interrupt control request has extra fields');
      return { type: 'control_request', ...(session_id === undefined ? {} : { session_id }), request_id, request: { subtype } };
    }
    if (subtype === 'can_use_tool') {
      const tool_name = controlString(request.tool_name, 'tool_name', redactor);
      const input = controlJson(request.input, 'tool input', redactor);
      const tool_use_id = controlString(request.tool_use_id, 'tool_use_id', redactor);
      return { type: 'control_request', ...(session_id === undefined ? {} : { session_id }), request_id, request: { subtype, tool_name, input, tool_use_id } };
    }
    const callback_id = controlString(request.callback_id, 'callback_id', redactor);
    const event = controlString(request.event, 'event', redactor);
    const payload = controlJson(request.payload, 'hook payload', redactor);
    return { type: 'control_request', ...(session_id === undefined ? {} : { session_id }), request_id, request: { subtype, callback_id, event, payload } };
  }

  const response = requiredRecord(frame.response, 'control response');
  const subtype = enumValue(response.subtype, ['success', 'error', 'cancelled'] as const, 'control response subtype');
  const value = response.response === undefined
    ? undefined
    : isPermissionResultCandidate(response.response)
      ? redactor.redact(validatePermissionResult(response.response)) as JsonValue
      : controlJson(response.response, 'control response value', redactor);
  const message = response.message === undefined ? undefined : controlString(response.message, 'message', redactor);
  const pendingPermissionRequests = normalizePendingControlArray(response.pending_permission_requests, 'permission');
  const pendingUserDialogRequests = normalizePendingControlArray(response.pending_user_dialog_requests, 'dialog');
  return {
    type: 'control_response',
    ...(session_id === undefined ? {} : { session_id }),
    request_id,
    response: {
      subtype,
      ...(value === undefined ? {} : { response: value }),
      ...(message === undefined ? {} : { message }),
      ...(pendingPermissionRequests === undefined ? {} : { pending_permission_requests: redactor.redact(pendingPermissionRequests) as readonly ClaudePendingControlRequest[] }),
      ...(pendingUserDialogRequests === undefined ? {} : { pending_user_dialog_requests: redactor.redact(pendingUserDialogRequests) as readonly ClaudePendingControlRequest[] }),
    },
  };
}

const PENDING_CONTROL_ENVELOPE_KEYS = new Set(['type', 'request_id', 'request']);
const PENDING_PERMISSION_KEYS = new Set(['subtype', 'tool_name', 'input', 'permission_suggestions', 'blocked_path', 'decision_reason', 'decision_reason_type', 'classifier_approvable', 'suppress_always_allow_rule', 'matched_ask_rule', 'title', 'display_name', 'tool_use_id', 'agent_id', 'description', 'requires_user_interaction']);
const PENDING_DIALOG_KEYS = new Set(['subtype', 'dialog_kind', 'payload', 'tool_use_id']);
const PERMISSION_DECISION_REASONS = new Set(['rule', 'mode', 'subcommandResults', 'permissionPromptTool', 'hook', 'asyncAgent', 'sandboxOverride', 'workingDir', 'safetyCheck', 'classifier', 'other']);

function isPermissionResultCandidate(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.behavior !== undefined;
}

/**
 * Normalize the SDK PermissionResult spelling. In particular, the SDK wire
 * uses camelCase `toolUseID`; accepting snake_case here would produce a
 * response the SDK cannot correlate to its pending tool request.
 */
function validatePermissionResult(value: unknown, expectedToolUseId?: string): ClaudePermissionResult {
  if (!isRecord(value) || (value.behavior !== 'allow' && value.behavior !== 'deny')) {
    throw new Error('permission result behavior is invalid');
  }
  const allowed = value.behavior === 'allow'
    ? new Set(['behavior', 'updatedInput', 'updatedPermissions', 'toolUseID', 'decisionClassification'])
    : new Set(['behavior', 'message', 'interrupt', 'toolUseID', 'decisionClassification']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('permission result contains an unknown field');
  if (value.toolUseID !== undefined && (typeof value.toolUseID !== 'string' || !LABEL_PATTERN.test(value.toolUseID))) {
    throw new Error('permission result toolUseID is invalid');
  }
  if (expectedToolUseId !== undefined && value.toolUseID !== expectedToolUseId) {
    throw new Error('permission result toolUseID does not match the pending tool request');
  }
  if (value.decisionClassification !== undefined && (typeof value.decisionClassification !== 'string' || !PERMISSION_DECISION_CLASSIFICATIONS.has(value.decisionClassification))) {
    throw new Error('permission result decisionClassification is invalid');
  }
  if (value.behavior === 'allow') {
    if (value.updatedInput !== undefined) assertBoundedJsonValue(value.updatedInput, { maxDepth: MAX_JSON_SCHEMA_DEPTH, maxNodes: MAX_JSON_SCHEMA_NODES, maxKeys: MAX_JSON_SCHEMA_KEYS, maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH, maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH });
    if (value.updatedPermissions !== undefined) assertBoundedJsonValue(value.updatedPermissions, { maxDepth: MAX_JSON_SCHEMA_DEPTH, maxNodes: MAX_JSON_SCHEMA_NODES, maxKeys: MAX_JSON_SCHEMA_KEYS, maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH, maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH });
    return {
      behavior: 'allow',
      ...(value.updatedInput === undefined ? {} : { updatedInput: value.updatedInput as JsonValue }),
      ...(value.updatedPermissions === undefined ? {} : { updatedPermissions: value.updatedPermissions as JsonValue }),
      ...(value.toolUseID === undefined ? {} : { toolUseID: value.toolUseID }),
      ...(value.decisionClassification === undefined ? {} : { decisionClassification: value.decisionClassification }),
    };
  }
  if (typeof value.message !== 'string' || value.message.length === 0 || byteLength(value.message) > 4_096 || value.message.includes('\0')) {
    throw new Error('permission denial message is invalid');
  }
  if (value.interrupt !== undefined && typeof value.interrupt !== 'boolean') throw new Error('permission denial interrupt is invalid');
  return {
    behavior: 'deny',
    message: value.message,
    ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
    ...(value.toolUseID === undefined ? {} : { toolUseID: value.toolUseID }),
    ...(value.decisionClassification === undefined ? {} : { decisionClassification: value.decisionClassification }),
  };
}

function normalizePendingControlArray(value: unknown, kind: 'permission' | 'dialog'): readonly ClaudePendingControlRequest[] | undefined {
  if (value === undefined) return undefined;
  const array = validatePendingControlArray(value, kind);
  return array as readonly ClaudePendingControlRequest[];
}

function validatePendingControlArray(value: unknown, kind: 'permission' | 'dialog'): ClaudePendingControlRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error(`pending ${kind} controls are invalid`);
  const output: ClaudePendingControlRequest[] = [];
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some(key => !PENDING_CONTROL_ENVELOPE_KEYS.has(key)) || item.type !== 'control_request') {
      throw new Error(`pending ${kind} control envelope is invalid`);
    }
    const requestId = requestIdValue(item.request_id);
    if (!isRecord(item.request)) throw new Error(`pending ${kind} control request is invalid`);
    const request = item.request;
    if (kind === 'permission') {
      if (Object.keys(request).some(key => !PENDING_PERMISSION_KEYS.has(key)) || request.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string' || !LABEL_PATTERN.test(request.tool_name) || typeof request.tool_use_id !== 'string' || !REQUEST_ID_PATTERN.test(request.tool_use_id)) {
        throw new Error('pending permission request is invalid');
      }
      assertBoundedJsonValue(request.input, { maxDepth: MAX_JSON_SCHEMA_DEPTH, maxNodes: MAX_JSON_SCHEMA_NODES, maxKeys: MAX_JSON_SCHEMA_KEYS, maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH, maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH });
      if (request.decision_reason_type !== undefined && (typeof request.decision_reason_type !== 'string' || !PERMISSION_DECISION_REASONS.has(request.decision_reason_type))) throw new Error('pending permission decision reason is invalid');
      output.push({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: request.tool_name, tool_use_id: request.tool_use_id, input: request.input as Record<string, unknown> } });
    } else {
      if (Object.keys(request).some(key => !PENDING_DIALOG_KEYS.has(key)) || request.subtype !== 'request_user_dialog' || typeof request.dialog_kind !== 'string' || !LABEL_PATTERN.test(request.dialog_kind) || !isRecord(request.payload)) {
        throw new Error('pending user dialog request is invalid');
      }
      assertBoundedJsonValue(request.payload, { maxDepth: MAX_JSON_SCHEMA_DEPTH, maxNodes: MAX_JSON_SCHEMA_NODES, maxKeys: MAX_JSON_SCHEMA_KEYS, maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH, maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH });
      if (request.tool_use_id !== undefined && (typeof request.tool_use_id !== 'string' || !REQUEST_ID_PATTERN.test(request.tool_use_id))) throw new Error('pending user dialog tool_use_id is invalid');
      output.push({ type: 'control_request', request_id: requestId, request: { subtype: 'request_user_dialog', dialog_kind: request.dialog_kind, payload: request.payload as Record<string, unknown>, ...(request.tool_use_id === undefined ? {} : { tool_use_id: request.tool_use_id }) } });
    }
  }
  return output;
}

function controlString(value: unknown, label: string, redactor: FixtureRedactor): string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > 4_096 || value.includes('\0')) throw new Error(`${label} is invalid`);
  return redactor.redact(value) as string;
}

function controlJson(value: unknown, label: string, redactor: FixtureRedactor): JsonValue {
  assertBoundedJsonValue(value, {
    maxDepth: MAX_JSON_SCHEMA_DEPTH,
    maxNodes: MAX_JSON_SCHEMA_NODES,
    maxKeys: MAX_JSON_SCHEMA_KEYS,
    maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH,
    maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH,
  });
  return redactor.redact(value) as JsonValue;
}

function isControlEvent(event: ClaudeProtocolEvent): event is ClaudeControlRequestEvent | ClaudeControlResponseEvent | ClaudeControlCancelRequestEvent {
  return event.kind === 'control-request' || event.kind === 'control-response' || event.kind === 'control-cancel-request';
}

function eventInterruptReceipt(value: JsonValue | undefined): ClaudeControlResponseEvent['interruptReceipt'] | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.still_queued) || value.still_queued.length > 256 || value.still_queued.some(item => typeof item !== 'string' || !REQUEST_ID_PATTERN.test(item))) return undefined;
  if (value.cancelled !== undefined && (!Array.isArray(value.cancelled) || value.cancelled.length > 256 || value.cancelled.some(item => typeof item !== 'string' || !REQUEST_ID_PATTERN.test(item)))) return undefined;
  return {
    stillQueued: value.still_queued.filter((item): item is string => typeof item === 'string'),
    cancelled: Array.isArray(value.cancelled) ? value.cancelled.filter((item): item is string => typeof item === 'string') : [],
  };
}

function cancellationStatus(value: JsonValue | undefined): 'cancelled' | 'interrupted' | 'still_queued' | undefined {
  const receipt = eventInterruptReceipt(value);
  if (receipt !== undefined) {
    if (receipt.cancelled.length > 0) return 'cancelled';
    if (receipt.stillQueued.length > 0) return 'still_queued';
    return 'interrupted';
  }
  // Legacy fixture-only status shape. Canonical SDK receipts use arrays.
  if (!isRecord(value) || typeof value.status !== 'string') return undefined;
  if (value.status === 'cancelled' || value.status === 'interrupted' || value.status === 'still_queued') return value.status;
  return undefined;
}

function validateLedgerJson(value: unknown): JsonValue {
  assertBoundedJsonValue(value, {
    maxDepth: MAX_JSON_SCHEMA_DEPTH,
    maxNodes: MAX_JSON_SCHEMA_NODES,
    maxKeys: MAX_JSON_SCHEMA_KEYS,
    maxKeyLength: MAX_JSON_SCHEMA_KEY_LENGTH,
    maxStringLength: MAX_JSON_SCHEMA_STRING_LENGTH,
  });
  return value;
}

function boundedLedgerLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error(`${label} must be an integer between 1 and 10000`);
  return value;
}

function assertNoProfileSessionControls(argv: readonly string[]): void {
  const controls = new Set(['--continue', '--resume', '--fork-session', '--session-id']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (controls.has(flag)) {
      throw new Error(`Claude launch profile must not contain implicit or duplicate session controls (found ${arg})`);
    }
  }
}
