/**
 * Bounded live-wire adapter for the opt-in Claude probe.
 *
 * This is deliberately not ClaudeJsonlProtocolParser.  The offline parser is
 * a contract fixture; the live adapter accepts only the small set of candidate
 * observed Claude stream shapes needed by T04 and emits markers/counts only. It never
 * returns prompt/model text, structured values, tool input, or raw IDs.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_FRAMES = 2_000;
const MAX_DEPTH = 16;
const MAX_NODES = 2_048;
const MAX_STRING_LENGTH = 8_192;
const TOP_LEVEL_TELEMETRY_TYPES = new Set([
  'conversation_reset',
  'prompt_suggestion',
  'tool_progress',
  'tool_use_summary',
]);
/**
 * Anthropic partials emitted while a tool call or thinking block is being
 * assembled.  They are useful bounded telemetry, but they are deliberately
 * never treated as text (and therefore cannot satisfy the T1 text-stream
 * acceptance check).
 */
const NON_TEXT_DELTA_TYPES = new Set([
  'input_json_delta',
  'thinking_delta',
  'signature_delta',
  // Newer Anthropic stream blocks can carry citations and compaction
  // metadata.  They are bounded telemetry only and must never satisfy the
  // genuine text-partial requirement for T1.
  'citations_delta',
  'compaction_delta',
]);
/**
 * This starts with the SDK 0.3.220 initialize response and includes the
 * additional metadata fields observed in the canonical installed Claude release.
 * Keep this allow-list bounded: the payload is metadata only and none of its
 * descriptions, account fields, IDs, paths, or model names are evidence.
 */
const INITIALIZE_RESPONSE_KEYS = new Set([
  'commands',
  'agents',
  'output_style',
  'available_output_styles',
  'user_output_styles_dir',
  'models',
  'account',
  'pid',
  'current_permission_mode',
  'analytics_disabled',
  'remote_control_auto_enable',
  'remote_control_auto_connect_default',
  'remote_control_available',
  'remote_control_auto_on_by_default',
  'ide_rc_auto_enable_gate',
  'session_state',
  'fast_mode_state',
  'fast_mode_disabled_reason',
]);
const INITIALIZE_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
const INITIALIZE_SESSION_STATES = new Set(['idle', 'running', 'requires_action']);
const INITIALIZE_FAST_MODE_STATES = new Set(['off', 'cooldown', 'on']);
const INITIALIZE_FAST_MODE_DISABLED_REASONS = new Set([
  'free',
  'preference',
  'extra_usage_disabled',
  'network_error',
  'unknown',
  'not_first_party',
  'disabled_by_env',
  'model_not_allowed',
  'sdk_opt_in_required',
  'pending',
]);
const ACCOUNT_API_PROVIDERS = new Set(['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'anthropicGoogleCloud', 'mantle', 'gateway']);
const INITIALIZE_COMMAND_KEYS = new Set(['name', 'description', 'argumentHint', 'aliases']);
const INITIALIZE_AGENT_KEYS = new Set(['name', 'description', 'model']);
const INITIALIZE_MODEL_KEYS = new Set([
  'value',
  'resolvedModel',
  'displayName',
  'description',
  'supportsEffort',
  'supportedEffortLevels',
  'supportsAdaptiveThinking',
  'supportsFastMode',
  'supportsAutoMode',
]);
const INITIALIZE_ACCOUNT_KEYS = new Set(['email', 'organization', 'subscriptionType', 'tokenSource', 'apiKeySource', 'apiProvider']);
const PENDING_CONTROL_KEYS = new Set(['type', 'request_id', 'request']);
const PENDING_PERMISSION_REQUEST_KEYS = new Set([
  'subtype',
  'tool_name',
  'input',
  'permission_suggestions',
  'blocked_path',
  'decision_reason',
  'decision_reason_type',
  'classifier_approvable',
  'suppress_always_allow_rule',
  'matched_ask_rule',
  'title',
  'display_name',
  'tool_use_id',
  'agent_id',
  'description',
  'requires_user_interaction',
]);
const PENDING_USER_DIALOG_REQUEST_KEYS = new Set(['subtype', 'dialog_kind', 'payload', 'tool_use_id']);
const PERMISSION_DECISION_REASONS = new Set([
  'rule',
  'mode',
  'subcommandResults',
  'permissionPromptTool',
  'hook',
  'asyncAgent',
  'sandboxOverride',
  'workingDir',
  'safetyCheck',
  'classifier',
  'other',
]);
const CAPABILITY_FLAGS = {
  interruptReceipt: 'interrupt_receipt_v1',
  interruptCancelQueued: 'interrupt_cancel_queued_v1',
} as const;
const LEGACY_INTERRUPT_STATUSES = new Set(['cancelled', 'interrupted', 'still_queued']);
const INTERRUPT_RECEIPT_KEYS = new Set(['still_queued', 'cancelled']);
const RESULT_ERROR_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);
/**
 * `type:error` is a separate stream-json failure envelope rather than the
 * SDK `result` error union. Keep its accepted payload deliberately narrow so
 * arbitrary diagnostics cannot become cancellation evidence.
 */
const STANDALONE_ERROR_KEYS = new Set(['type', 'session_id', 'error']);
const STANDALONE_ERROR_OBJECT_KEYS = new Set(['code', 'message', 'retryable']);
const TERMINAL_REASONS = new Set([
  'blocking_limit',
  'rapid_refill_breaker',
  'prompt_too_long',
  'image_error',
  'model_error',
  'api_error',
  'malformed_tool_use_exhausted',
  'aborted_streaming',
  'aborted_tools',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
  'max_turns',
  'background_requested',
  'completed',
  'budget_exhausted',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed',
]);
const KNOWN_TELEMETRY = new Set([
  'keep_alive',
  'status',
  'rate_limit_event',
  'api_retry',
  'compact_boundary',
  'session_state_changed',
  'hook_started',
  'hook_progress',
  'response',
  'task_started',
  'task_progress',
  'task_notification',
  'notification',
  'auth_status',
]);
/** SDK system subtypes that are informational rather than required control. */
const KNOWN_SYSTEM_TELEMETRY = new Set([
  'compact_boundary',
  'api_retry',
  'session_state_changed',
  'background_tasks_changed',
  'commands_changed',
  'control_request_progress',
  'elicitation_complete',
  'files_persisted',
  'hook_started',
  'hook_progress',
  'hook_response',
  'informational',
  'local_command_output',
  'memory_recall',
  'mirror_error',
  'model_refusal_fallback',
  'model_refusal_no_fallback',
  'task_started',
  'task_progress',
  'task_notification',
  'task_updated',
  'thinking_tokens',
  'permission_denied',
  'plugin_install',
  'prompt_suggestion',
  'notification',
  'auth_status',
  'rate_limit_event',
  'keep_alive',
  'worker_shutting_down',
]);

export type ClaudeLiveWireErrorCode =
  | 'invalid-utf8'
  | 'byte-limit'
  | 'line-limit'
  | 'frame-limit'
  | 'malformed-json'
  | 'non-object'
  | 'unsupported-frame'
  | 'malformed-frame'
  | 'control-invalid'
  | 'control-correlation'
  | 'partial-eof';

export class ClaudeLiveWireError extends Error {
  readonly code: ClaudeLiveWireErrorCode;
  readonly lineNumber: number;
  readonly bytesReceived: number;

  constructor(code: ClaudeLiveWireErrorCode, message: string, lineNumber: number, bytesReceived: number) {
    super(message);
    this.name = 'ClaudeLiveWireError';
    this.code = code;
    this.lineNumber = lineNumber;
    this.bytesReceived = bytesReceived;
  }
}

export type ClaudeLiveWireMarker = {
  readonly kind:
    | 'session-init'
    | 'session-status'
    | 'stream-delta'
    | 'assistant-message'
    | 'tool-use'
    | 'tool-result'
    | 'final-success'
    | 'final-structured'
    | 'final-error'
    | 'control-request'
    | 'control-response'
    | 'control-cancel-request'
    | 'telemetry';
  readonly wireType: string;
  readonly sessionIdHash?: string;
  readonly requestIdHash?: string;
  readonly label?: string;
  readonly count?: number;
  readonly bytes?: number;
  /** Sanitized structured-output shape; never the value itself. */
  readonly structuredShape?: string;
  readonly structuredMarkerSeen?: boolean;
  /** Only the two host-relevant capabilities are persisted; unknown open-set
   * capability names are ignored as version-bound telemetry. */
  readonly capabilityFlags?: Readonly<{
    interruptReceipt: boolean;
    interruptCancelQueued: boolean;
  }>;
  /** Monotonic-enough process-local elapsed time; never a wall-clock stamp. */
  readonly elapsedMs: number;
};

export type ClaudeLiveControlRequest = {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly subtype: 'interrupt' | 'can_use_tool' | 'hook_callback';
  readonly toolName?: string;
  readonly toolUseIdHash?: string;
  readonly toolInputValid: boolean;
  readonly fixtureInput: boolean;
};

export type ClaudeLiveStructuredExpectation = {
  readonly shape: 'object';
  readonly field: string;
  readonly marker: string;
};

export type ClaudeLiveWireAdapterOptions = {
  readonly expectedSessionId?: string;
  /** Optional marker used only to record that bounded fixture text was observed. */
  readonly expectedTextMarker?: string;
  /** Exact fixed prompt that the CLI may echo as a user frame. */
  readonly expectedUserPrompt?: string;
  /** Exact tool contract admitted for the MCP turn; omitted means no tools. */
  readonly expectedToolName?: string;
  readonly expectedToolInput?: { readonly value: string; readonly delayMs: number };
  /** Exact structured-output contract admitted for the structured turn. */
  readonly expectedStructuredOutput?: ClaudeLiveStructuredExpectation;
  readonly onControlRequest?: (request: ClaudeLiveControlRequest) => void;
};

export class ClaudeLiveWireAdapter {
  private readonly expectedSessionId?: string;
  private readonly expectedTextMarker?: string;
  private readonly expectedUserPrompt?: string;
  private readonly onControlRequest?: (request: ClaudeLiveControlRequest) => void;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private bytesReceived = 0;
  private lineNumber = 0;
  private frameCount = 0;
  private ended = false;
  private failed = false;
  private currentSessionId?: string;
  private readonly startedAt = Date.now();
  /** Requests sent by the child and awaiting a host response. */
  private readonly pendingIncomingControls = new Map<string, string | undefined>();
  /** Requests sent by the host and awaiting a child response. */
  private readonly pendingOutgoingControls = new Map<string, { readonly sessionId?: string; readonly purpose: 'initialize' | 'interrupt' }>();
  private textBuffer = '';
  private expectedTextMarkerSeen = false;
  private readonly toolUseIds = new Set<string>();
  private readonly expectedToolName?: string;
  private readonly expectedToolInput?: { readonly value: string; readonly delayMs: number };
  private readonly expectedStructuredOutput?: ClaudeLiveStructuredExpectation;
  /** Raw Anthropic partial-message lifecycle, kept in memory only. */
  private streamMessageStarted = false;
  private streamMessageDeltaSeen = false;
  private streamMessageStopped = false;
  private readonly openContentBlocks = new Map<number, { readonly type: string }>();

  /** The current session ID is process-local only; hash it before persistence. */
  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  get textMarkerSeen(): boolean {
    return this.expectedTextMarkerSeen;
  }

  get structuredOutputValid(): boolean {
    return this.lastStructuredOutputValid;
  }

  private lastStructuredOutputValid = false;

  /** Register a bounded host-to-child control before writing it to stdin. */
  registerOutboundControl(requestId: string, sessionId?: string, purpose: 'initialize' | 'interrupt' = 'initialize'): void {
    if (!REQUEST_ID.test(requestId) || this.pendingOutgoingControls.has(requestId) || this.pendingIncomingControls.has(requestId)) {
      throw new ClaudeLiveWireError('control-correlation', 'live outbound control request ID is invalid or already pending', this.lineNumber, this.bytesReceived);
    }
    if (this.pendingOutgoingControls.size + this.pendingIncomingControls.size >= 128) {
      throw new ClaudeLiveWireError('control-correlation', 'live control request limit exceeded', this.lineNumber, this.bytesReceived);
    }
    if (sessionId !== undefined) assertId(sessionId, 'session_id');
    this.pendingOutgoingControls.set(requestId, { ...(sessionId === undefined ? {} : { sessionId }), purpose });
  }

  /** Mark a host response written to stdin for an incoming control request. */
  acknowledgeControlResponse(requestId: string, sessionId?: string): void {
    if (!REQUEST_ID.test(requestId) || !this.pendingIncomingControls.has(requestId)) {
      throw new ClaudeLiveWireError('control-correlation', 'live control response has no matching request', this.lineNumber, this.bytesReceived);
    }
    const expectedSession = this.pendingIncomingControls.get(requestId);
    if (expectedSession !== sessionId) {
      throw new ClaudeLiveWireError('control-correlation', 'live control response session does not match its request', this.lineNumber, this.bytesReceived);
    }
    this.pendingIncomingControls.delete(requestId);
  }

  constructor(options: ClaudeLiveWireAdapterOptions = {}) {
    this.expectedSessionId = options.expectedSessionId === undefined ? undefined : assertId(options.expectedSessionId, 'session_id');
    this.expectedTextMarker = options.expectedTextMarker;
    if (this.expectedTextMarker !== undefined && (this.expectedTextMarker.length === 0 || this.expectedTextMarker.length > 128 || this.expectedTextMarker.includes('\0'))) {
      throw new Error('expectedTextMarker is invalid');
    }
    this.expectedUserPrompt = options.expectedUserPrompt;
    if (this.expectedUserPrompt !== undefined && (this.expectedUserPrompt.length === 0 || this.expectedUserPrompt.length > 2_048 || this.expectedUserPrompt.includes('\0'))) {
      throw new Error('expectedUserPrompt is invalid');
    }
    this.expectedToolName = options.expectedToolName;
    this.expectedToolInput = options.expectedToolInput;
    if (this.expectedToolName !== undefined && (!LABEL.test(this.expectedToolName) || !['subscription_fixture_echo', 'mcp__fixture__subscription_fixture_echo'].includes(this.expectedToolName))) {
      throw new Error('expectedToolName is not admitted');
    }
    if (this.expectedToolInput !== undefined && (!this.expectedToolInput.value || this.expectedToolInput.delayMs !== 0)) {
      throw new Error('expectedToolInput is not admitted');
    }
    this.expectedStructuredOutput = options.expectedStructuredOutput;
    if (
      this.expectedStructuredOutput !== undefined &&
      (this.expectedStructuredOutput.shape !== 'object' ||
        !LABEL.test(this.expectedStructuredOutput.field) ||
        this.expectedStructuredOutput.marker.length === 0 ||
        this.expectedStructuredOutput.marker.length > 128)
    ) {
      throw new Error('expectedStructuredOutput is invalid');
    }
    this.onControlRequest = options.onControlRequest;
  }

  push(chunk: string | Uint8Array): ClaudeLiveWireMarker[] {
    this.assertWritable();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const next = this.bytesReceived + bytes.byteLength;
    if (next > MAX_BYTES) throw this.fail('byte-limit', 'live wire byte limit exceeded');
    this.bytesReceived = next;
    let decoded: string;
    try {
      // Route strings through the same incremental decoder as byte chunks so
      // a caller cannot strand a split UTF-8 sequence by changing chunk type.
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw this.fail('invalid-utf8', 'live wire is not valid UTF-8');
    }
    this.pending += decoded;
    const output: ClaudeLiveWireMarker[] = [];
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      let line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw this.fail('line-limit', 'live wire line limit exceeded');
      this.lineNumber += 1;
      output.push(this.parseLine(line));
    }
    if (Buffer.byteLength(this.pending, 'utf8') > MAX_LINE_BYTES) throw this.fail('line-limit', 'live wire line limit exceeded');
    return output;
  }

  end(): void {
    this.assertWritable();
    try {
      const trailing = this.decoder.decode();
      this.pending += trailing;
    } catch {
      throw this.fail('invalid-utf8', 'live wire ended with incomplete UTF-8');
    }
    this.ended = true;
    if (this.pendingIncomingControls.size > 0 || this.pendingOutgoingControls.size > 0) throw this.fail('control-correlation', 'live wire ended with pending control requests');
    if (this.pending.length > 0) throw this.fail('partial-eof', 'live wire ended before a JSONL terminator');
    // A clean EOF is only valid after every raw Anthropic message lifecycle
    // has reached message_stop and every content block has reached
    // content_block_stop.  Without this check a truncated thinking/text
    // stream could be mistaken for a complete turn after the child exits.
    if (this.openContentBlocks.size > 0) throw this.fail('control-correlation', 'live wire ended with open content blocks');
    if (this.streamMessageStarted && !this.streamMessageStopped) {
      throw this.fail('control-correlation', 'live wire ended before message_stop');
    }
  }

  private parseLine(line: string): ClaudeLiveWireMarker {
    if (line.length === 0) throw this.fail('malformed-frame', 'blank live wire line is not allowed');
    if (this.frameCount >= MAX_FRAMES) throw this.fail('frame-limit', 'live wire frame limit exceeded');
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw this.fail('malformed-json', 'live wire line is not valid JSON');
    }
    if (!isRecord(frame)) throw this.fail('non-object', 'live wire frames must be objects');
    assertJsonBounds(frame, MAX_DEPTH, MAX_NODES, MAX_STRING_LENGTH, this.lineNumber, this.bytesReceived);
    this.frameCount += 1;
    try {
      const normalized = this.normalize(frame);
      return { ...normalized, elapsedMs: Math.min(120_000, Math.max(0, Date.now() - this.startedAt)) };
    } catch (error) {
      if (error instanceof ClaudeLiveWireError) throw error;
      throw this.fail('malformed-frame', 'live wire frame shape is invalid');
    }
  }

  private normalize(frame: Record<string, unknown>): ClaudeLiveWireMarker {
    if (typeof frame.type !== 'string' || !LABEL.test(frame.type)) throw this.fail('unsupported-frame', 'live wire type is invalid');
    const wireType = frame.type;
    // The SDK-shaped control response nests request_id (and, on some builds,
    // session_id) under response.  Initialization responses may intentionally
    // omit a session, so do not apply the turn-session requirement to that
    // one frame shape.
    const frameForSession = frame.type === 'control_response' && frame.session_id === undefined
      ? { ...frame, session_id: readNestedSession(frame) }
      : frame.type === 'user' && frame.session_id === ''
        ? (() => {
            const { session_id: _ignoredSessionId, ...withoutEmptySession } = frame;
            return withoutEmptySession;
          })()
        : frame;
    const sessionId = frame.type === 'control_response' && frameForSession.session_id === undefined
      ? undefined
      : readSessionId(frameForSession, this.expectedSessionId, this.lineNumber, this.bytesReceived);
    if (sessionId !== undefined) this.currentSessionId = sessionId;
    const sessionIdHash = sessionId === undefined ? undefined : hashClaudeLiveId(sessionId);
    if (frame.type === 'system') {
      if (frame.subtype === 'init') {
        const capabilities = validateSystemInitCapabilities(frame.capabilities, this.lineNumber, this.bytesReceived);
        return {
          ...marker('session-init', wireType, sessionIdHash),
          capabilityFlags: capabilities,
        };
      }
      if (frame.subtype === 'status') return marker('session-status', wireType, sessionIdHash);
      if (typeof frame.subtype === 'string' && KNOWN_SYSTEM_TELEMETRY.has(frame.subtype)) {
        if (frame.subtype === 'thinking_tokens') validateThinkingTokens(frame, this.lineNumber, this.bytesReceived);
        return marker('telemetry', wireType, sessionIdHash, `system-${frame.subtype}`);
      }
      throw this.fail('unsupported-frame', 'system subtype is not admitted');
    }
    if (frame.type === 'stream_event') {
      const event = requiredRecord(frame.event, 'stream event', this.lineNumber, this.bytesReceived);
      return this.normalizeStreamEvent(event, wireType, sessionIdHash);
    }
    if (wireType === 'assistant') return this.normalizeAssistant(frame, sessionIdHash);
    if (wireType === 'user' || wireType === 'user-replay') return this.normalizeUser(frame, sessionIdHash);
    if (wireType === 'result') return this.normalizeResult(frame, sessionIdHash);
    if (wireType === 'error') {
      validateStandaloneError(frame, this.lineNumber, this.bytesReceived);
      // A standalone error is provider/protocol failure evidence only. Its
      // marker is intentionally not labelled as cancelled, even if an error
      // string happens to contain the word "abort".
      return marker('final-error', wireType, sessionIdHash, 'standalone-error');
    }
    if (wireType === 'control_request') return this.normalizeControlRequest(frame, sessionIdHash);
    if (wireType === 'control_response') return this.normalizeControlResponse(frame, sessionIdHash);
    if (wireType === 'control_cancel_request') return this.normalizeControlCancel(frame, sessionIdHash);
    if (TOP_LEVEL_TELEMETRY_TYPES.has(wireType)) {
      validateTopLevelTelemetry(frame, wireType, this.lineNumber, this.bytesReceived);
      return marker('telemetry', wireType, sessionIdHash, `top-level-${wireType}`);
    }
    if (KNOWN_TELEMETRY.has(wireType)) return marker('telemetry', wireType, sessionIdHash);
    throw this.fail('unsupported-frame', 'live wire frame type is not admitted');
  }

  private normalizeStreamEvent(event: Record<string, unknown>, wireType: string, sessionIdHash?: string): ClaudeLiveWireMarker {
    if (typeof event.type !== 'string') throw this.fail('malformed-frame', 'stream event type is invalid');
    if (event.type === 'ping') return marker('telemetry', wireType, sessionIdHash, 'stream-ping');
    if (event.type === 'message_start') {
      if (this.streamMessageStarted && !this.streamMessageStopped) throw this.fail('malformed-frame', 'stream message_start arrived before message_stop');
      requiredRecord(event.message, 'stream message_start message', this.lineNumber, this.bytesReceived);
      this.streamMessageStarted = true;
      this.streamMessageDeltaSeen = false;
      this.streamMessageStopped = false;
      this.openContentBlocks.clear();
      return marker('telemetry', wireType, sessionIdHash, 'stream-message_start');
    }
    if (!this.streamMessageStarted || this.streamMessageStopped) throw this.fail('control-correlation', 'stream event is outside a message lifecycle');
    if (event.type === 'content_block_start') {
      if (this.streamMessageDeltaSeen) throw this.fail('malformed-frame', 'content block started after message_delta');
      const index = requiredStreamIndex(event.index, this.lineNumber, this.bytesReceived);
      if (this.openContentBlocks.has(index)) throw this.fail('control-correlation', 'duplicate stream content block index');
      const contentBlock = requiredRecord(event.content_block, 'stream content block', this.lineNumber, this.bytesReceived);
      const type = boundedWireLabel(contentBlock.type, 'stream content block type', this.lineNumber, this.bytesReceived);
      validateContentBlockStart(type, contentBlock, this.lineNumber, this.bytesReceived);
      this.openContentBlocks.set(index, { type });
      return marker('telemetry', wireType, sessionIdHash, 'stream-content_block_start');
    }
    if (event.type === 'content_block_delta') {
      if (this.streamMessageDeltaSeen) throw this.fail('malformed-frame', 'content block delta arrived after message_delta');
      const index = requiredStreamIndex(event.index, this.lineNumber, this.bytesReceived);
      const block = this.openContentBlocks.get(index);
      if (block === undefined) throw this.fail('control-correlation', 'stream delta has no open content block');
      const delta = requiredRecord(event.delta, 'stream delta', this.lineNumber, this.bytesReceived);
      const type = boundedWireLabel(delta.type, 'stream delta type', this.lineNumber, this.bytesReceived);
      validateStreamDelta(type, delta, block.type, this.lineNumber, this.bytesReceived);
      if (type === 'text_delta') {
        const text = delta.text as string;
        this.observeText(text);
        return marker('stream-delta', wireType, sessionIdHash, this.expectedTextMarkerSeen ? 'expected-text-marker' : undefined, 1, Buffer.byteLength(text, 'utf8'));
      }
      return marker('telemetry', wireType, sessionIdHash, `stream-${type}`);
    }
    if (event.type === 'content_block_stop') {
      if (this.streamMessageDeltaSeen) throw this.fail('malformed-frame', 'content block stopped after message_delta');
      const index = requiredStreamIndex(event.index, this.lineNumber, this.bytesReceived);
      if (!this.openContentBlocks.has(index)) throw this.fail('control-correlation', 'stream content block stop has no open block');
      this.openContentBlocks.delete(index);
      return marker('telemetry', wireType, sessionIdHash, 'stream-content_block_stop');
    }
    if (event.type === 'message_delta') {
      if (this.streamMessageDeltaSeen) throw this.fail('control-correlation', 'duplicate stream message_delta');
      if (this.openContentBlocks.size > 0) throw this.fail('control-correlation', 'message_delta arrived before all content blocks stopped');
      requiredRecord(event.delta, 'stream message delta', this.lineNumber, this.bytesReceived);
      const usage = requiredRecord(event.usage, 'stream message usage', this.lineNumber, this.bytesReceived);
      validateStreamUsage(usage, this.lineNumber, this.bytesReceived);
      this.streamMessageDeltaSeen = true;
      return marker('telemetry', wireType, sessionIdHash, 'stream-message_delta');
    }
    if (event.type === 'message_stop') {
      if (!this.streamMessageDeltaSeen || this.openContentBlocks.size > 0) throw this.fail('control-correlation', 'message_stop arrived before message_delta or block stops');
      this.streamMessageStopped = true;
      return marker('telemetry', wireType, sessionIdHash, 'stream-message_stop');
    }
    throw this.fail('unsupported-frame', 'stream event type is not admitted');
  }

  private normalizeAssistant(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    const message = requiredRecord(frame.message, 'assistant message', this.lineNumber, this.bytesReceived);
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) throw this.fail('malformed-frame', 'assistant content is invalid');
    let textCount = 0;
    let toolCount = 0;
    let ignoredThinkingCount = 0;
    for (const item of content) {
      if (!isRecord(item) || typeof item.type !== 'string') throw this.fail('malformed-frame', 'assistant content block is invalid');
      if (item.type === 'text') {
        if (typeof item.text !== 'string' || item.text.length === 0) throw this.fail('malformed-frame', 'assistant text block is invalid');
        textCount += 1;
      } else if (item.type === 'tool_use') {
        if (typeof item.name !== 'string' || !LABEL.test(item.name) || typeof item.id !== 'string' || !REQUEST_ID.test(item.id)) {
          throw this.fail('malformed-frame', 'assistant tool-use block is invalid');
        }
        if (this.expectedToolName === undefined || item.name !== this.expectedToolName || !isFixtureInput(item.input, this.expectedToolInput)) {
          throw this.fail('unsupported-frame', 'assistant requested an unadmitted tool or input');
        }
        if (this.toolUseIds.has(item.id)) throw this.fail('control-correlation', 'assistant repeated a tool-use ID');
        this.toolUseIds.add(item.id);
        toolCount += 1;
      } else if (item.type === 'thinking' || item.type === 'redacted_thinking') {
        // Thinking blocks are normal assistant content when partial messages
        // are enabled.  They are telemetry only: validate a bounded payload,
        // then discard it so private reasoning can never become evidence.
        if (item.type === 'thinking') {
          if (!boundedThinkingString(item.thinking) || !boundedThinkingString(item.signature)) {
            throw this.fail('malformed-frame', 'assistant thinking block is invalid');
          }
        } else if (!boundedThinkingString(item.data)) {
          throw this.fail('malformed-frame', 'assistant redacted thinking block is invalid');
        }
        ignoredThinkingCount += 1;
      } else {
        throw this.fail('unsupported-frame', 'assistant content block is not admitted');
      }
    }
    if (textCount === 0 && toolCount === 0 && ignoredThinkingCount === 0) throw this.fail('unsupported-frame', 'assistant content has no admitted block');
    if (toolCount > 0) return marker('tool-use', 'assistant', sessionIdHash, 'mcp-fixture-tool', toolCount);
    if (textCount === 0) return marker('telemetry', 'assistant', sessionIdHash, 'assistant-thinking', ignoredThinkingCount);
    return marker('assistant-message', 'assistant', sessionIdHash, undefined, textCount);
  }

  private normalizeUser(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    const message = requiredRecord(frame.message, 'user message', this.lineNumber, this.bytesReceived);
    if (!Array.isArray(message.content) || message.content.length === 0) throw this.fail('malformed-frame', 'user content is invalid');
    let results = 0;
    for (const item of message.content) {
      if (!isRecord(item) || typeof item.type !== 'string') throw this.fail('malformed-frame', 'user content block is invalid');
      if (item.type === 'tool_result') {
        if (typeof item.tool_use_id !== 'string' || !REQUEST_ID.test(item.tool_use_id) || !this.toolUseIds.has(item.tool_use_id)) {
          throw this.fail('unsupported-frame', 'user tool result ID is invalid');
        }
        this.toolUseIds.delete(item.tool_use_id);
        results += 1;
      } else if (item.type === 'text') {
        if (typeof item.text !== 'string' || item.text.length === 0 || this.expectedUserPrompt === undefined || item.text !== this.expectedUserPrompt) {
          throw this.fail('unsupported-frame', 'user frame contains an unadmitted text block');
        }
      } else {
        throw this.fail('unsupported-frame', 'user frame contains an unadmitted content block');
      }
    }
    return marker(results > 0 ? 'tool-result' : 'telemetry', frame.type as string, sessionIdHash, results > 0 ? undefined : 'user-message', results || undefined);
  }

  private normalizeResult(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    if (frame.subtype === 'success') {
      // Claude's result success contract carries an explicit false sentinel.
      // Requiring it prevents an error-shaped result from being mistaken for
      // a successful (or cancellation) terminal event.
      if (frame.is_error !== false) throw this.fail('malformed-frame', 'successful result requires is_error=false');
      const hasText = typeof frame.result === 'string' && frame.result.length > 0;
      const hasStructured = frame.structured_output !== undefined;
      if (!hasText && !hasStructured) throw this.fail('malformed-frame', 'successful result has no output');
      if (hasText) this.observeText(frame.result as string);
      if (hasStructured) {
        const structured = validateStructuredOutput(frame.structured_output, this.expectedStructuredOutput);
        this.lastStructuredOutputValid = structured.valid;
        return marker(
          'final-structured',
          'result',
          sessionIdHash,
          structured.valid ? 'structured-valid' : 'structured-invalid',
          undefined,
          undefined,
          structured.shape,
          structured.markerSeen,
        );
      }
      return marker(hasStructured ? 'final-structured' : 'final-success', 'result', sessionIdHash, this.expectedTextMarkerSeen ? 'expected-text-marker' : undefined);
    }
    if (RESULT_ERROR_SUBTYPES.has(frame.subtype as string)) {
      if (frame.is_error !== true || !Array.isArray(frame.errors) || frame.errors.length > 64 || frame.errors.some(error => typeof error !== 'string' || error.length > MAX_STRING_LENGTH)) {
        throw this.fail('malformed-frame', 'result error requires bounded is_error and errors fields');
      }
      if (frame.terminal_reason !== undefined && (typeof frame.terminal_reason !== 'string' || !TERMINAL_REASONS.has(frame.terminal_reason))) {
        throw this.fail('malformed-frame', 'result error terminal_reason is invalid');
      }
      const terminalReason = typeof frame.terminal_reason === 'string' ? frame.terminal_reason : undefined;
      const cancelled = terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools';
      return marker('final-error', 'result', sessionIdHash, cancelled ? `cancelled-${terminalReason}` : `error-${String(frame.subtype)}`);
    }
    // The short `cancelled` result was used by an older candidate wire shape.
    // Keep it only as explicitly version-bound compatibility evidence; the
    // installed SDK's result contract is the error_* union above.
    if (frame.subtype === 'cancelled') return marker('final-error', 'result', sessionIdHash, 'cancelled-legacy');
    throw this.fail('unsupported-frame', 'result subtype is not admitted');
  }

  private normalizeControlRequest(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    if (typeof frame.request_id !== 'string' || !REQUEST_ID.test(frame.request_id)) throw this.fail('control-invalid', 'control request ID is invalid');
    const requestId = frame.request_id;
    const request = requiredRecord(frame.request, 'control request', this.lineNumber, this.bytesReceived);
    if (request.subtype !== 'interrupt' && request.subtype !== 'can_use_tool' && request.subtype !== 'hook_callback') {
      throw this.fail('control-invalid', 'control request subtype is not admitted');
    }
    let toolName: string | undefined;
    let toolUseId: string | undefined;
    if (request.subtype === 'can_use_tool') {
      if (typeof request.tool_name !== 'string' || !LABEL.test(request.tool_name)) throw this.fail('control-invalid', 'control tool name is invalid');
      toolName = request.tool_name;
      if (typeof request.tool_use_id !== 'string' || !REQUEST_ID.test(request.tool_use_id) || !this.toolUseIds.has(request.tool_use_id)) {
        throw this.fail('control-correlation', 'control tool-use ID does not match an assistant tool-use');
      }
      toolUseId = request.tool_use_id;
    }
    if (request.subtype === 'can_use_tool' && toolName === undefined) {
      throw this.fail('control-invalid', 'control tool name is invalid');
    }
    const fixtureInput = request.subtype === 'can_use_tool' && isFixtureInput(request.input);
    if (this.pendingIncomingControls.has(requestId) || this.pendingOutgoingControls.has(requestId)) throw this.fail('control-correlation', 'duplicate live control request ID');
    if (this.pendingIncomingControls.size + this.pendingOutgoingControls.size >= 128) throw this.fail('control-correlation', 'live control request limit exceeded');
    const rawSessionId = readRawSession(frame);
    this.pendingIncomingControls.set(requestId, rawSessionId);
    this.onControlRequest?.({
      requestId,
      ...(rawSessionId === undefined ? {} : { sessionId: rawSessionId }),
      subtype: request.subtype,
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolUseId === undefined ? {} : { toolUseIdHash: hashClaudeLiveId(toolUseId) }),
      toolInputValid: request.subtype === 'can_use_tool' && isFixtureInput(request.input, this.expectedToolInput),
      fixtureInput,
    });
    return {
      ...marker(
        'control-request',
        'control_request',
        sessionIdHash,
        request.subtype === 'can_use_tool'
          ? toolName === 'subscription_fixture_echo'
            ? 'fixture-tool-request'
            : 'other-tool-request'
          : (request.subtype as 'interrupt' | 'hook_callback'),
      ),
      requestIdHash: hashClaudeLiveId(requestId),
    };
  }

  private normalizeControlResponse(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    const response = requiredRecord(frame.response, 'control response', this.lineNumber, this.bytesReceived);
    // SDK pending-control arrays are siblings of `response` inside the
    // control envelope.  They are not fields on the outer stream frame.
    validatePendingControlArrays(response, this.lineNumber, this.bytesReceived);
    const nestedRequestId = response.request_id;
    const requestId = frame.request_id ?? nestedRequestId;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw this.fail('control-invalid', 'control response ID is invalid');
    if (frame.request_id !== undefined && nestedRequestId !== undefined && frame.request_id !== nestedRequestId) {
      throw this.fail('control-correlation', 'control response IDs do not match');
    }
    const pending = this.assertControlCorrelation(requestId, frame);
    // Canonical SDK control responses omit top-level session_id.  Bind that
    // response to the process-local session recorded with the pending host
    // request; if a session is explicitly present, correlation below still
    // requires it to match exactly.
    const correlatedSessionIdHash = pending.sessionId === undefined ? sessionIdHash : hashClaudeLiveId(pending.sessionId);
    if (response.subtype !== 'success' && response.subtype !== 'error' && response.subtype !== 'cancelled') {
      throw this.fail('control-invalid', 'control response subtype is not admitted');
    }
    const subtype = response.subtype as 'success' | 'error' | 'cancelled';
    if (pending.purpose === 'initialize') {
      if (subtype !== 'success') throw this.fail('control-invalid', 'initialize response must be successful');
      const capabilities = validateInitializeResponse(response.response, this.lineNumber, this.bytesReceived);
      return {
        ...marker('control-response', 'control_response', correlatedSessionIdHash, 'initialize-success', capabilities),
        requestIdHash: hashClaudeLiveId(requestId),
      };
    }
    if (pending.purpose === 'interrupt') {
      if (subtype !== 'success') throw this.fail('control-invalid', 'interrupt response must be successful');
      const interrupt = validateInterruptResponse(response.response, this.lineNumber, this.bytesReceived);
      return {
        ...marker('control-response', 'control_response', correlatedSessionIdHash, `interrupt-${interrupt.label}`, undefined, undefined, undefined, true),
        requestIdHash: hashClaudeLiveId(requestId),
      };
    }
    return {
      ...marker('control-response', 'control_response', correlatedSessionIdHash, subtype),
      requestIdHash: hashClaudeLiveId(requestId),
    };
  }

  private normalizeControlCancel(frame: Record<string, unknown>, sessionIdHash?: string): ClaudeLiveWireMarker {
    if (typeof frame.request_id !== 'string' || !REQUEST_ID.test(frame.request_id)) throw this.fail('control-invalid', 'control cancellation ID is invalid');
    const requestId = frame.request_id;
    const pending = this.assertControlCorrelation(requestId, frame);
    const correlatedSessionIdHash = pending.sessionId === undefined ? sessionIdHash : hashClaudeLiveId(pending.sessionId);
    return { ...marker('control-cancel-request', 'control_cancel_request', correlatedSessionIdHash), requestIdHash: hashClaudeLiveId(requestId) };
  }

  private assertControlCorrelation(requestId: string, frame: Record<string, unknown>): { readonly sessionId?: string; readonly purpose: 'initialize' | 'interrupt' } {
    if (!this.pendingOutgoingControls.has(requestId)) throw this.fail('control-correlation', 'live control response has no matching outbound request');
    const pending = this.pendingOutgoingControls.get(requestId)!;
    const expectedSession = pending.sessionId;
    let actualSession: string | undefined;
    try {
      actualSession = readControlResponseSession(frame);
    } catch {
      throw this.fail('control-correlation', 'live control response session IDs do not match');
    }
    // The canonical SDK response has no session_id at either envelope level.
    // An absent value inherits the private session bound to this pending
    // process request.  Explicit values remain fail-closed and must match.
    if (actualSession !== undefined && expectedSession !== undefined && expectedSession !== actualSession) {
      throw this.fail('control-correlation', 'live control response session does not match its request');
    }
    this.pendingOutgoingControls.delete(requestId);
    return { ...pending, ...(actualSession === undefined ? {} : { sessionId: actualSession }) };
  }

  private observeText(value: string): void {
    if (this.expectedTextMarker === undefined || this.expectedTextMarkerSeen) return;
    this.textBuffer = `${this.textBuffer}${value}`.slice(-4_096);
    this.expectedTextMarkerSeen = this.textBuffer.includes(this.expectedTextMarker);
  }

  private fail(code: ClaudeLiveWireErrorCode, message: string): ClaudeLiveWireError {
    this.failed = true;
    return new ClaudeLiveWireError(code, message, this.lineNumber, this.bytesReceived);
  }

  private assertWritable(): void {
    if (this.failed || this.ended) throw new ClaudeLiveWireError('malformed-frame', 'live wire adapter is closed', this.lineNumber + 1, this.bytesReceived);
  }
}

function marker(
  kind: ClaudeLiveWireMarker['kind'],
  wireType: string,
  sessionIdHash?: string,
  label?: string,
  count?: number,
  bytes?: number,
  structuredShape?: string,
  structuredMarkerSeen?: boolean,
): ClaudeLiveWireMarker {
  return {
    kind,
    wireType,
    elapsedMs: 0,
    ...(sessionIdHash === undefined ? {} : { sessionIdHash }),
    ...(label === undefined ? {} : { label }),
    ...(count === undefined ? {} : { count }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(structuredShape === undefined ? {} : { structuredShape }),
    ...(structuredMarkerSeen === undefined ? {} : { structuredMarkerSeen }),
  };
}

export function hashClaudeLiveId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function assertId(value: string, label: string): string {
  if (!SESSION_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function readRawSession(frame: Record<string, unknown>): string | undefined {
  if (frame.session_id === undefined) return undefined;
  if (typeof frame.session_id !== 'string' || !SESSION_ID.test(frame.session_id)) throw new Error('session_id is invalid');
  return frame.session_id;
}

function readNestedSession(frame: Record<string, unknown>): string | undefined {
  if (!isRecord(frame.response) || frame.response.session_id === undefined) return undefined;
  if (typeof frame.response.session_id !== 'string' || !SESSION_ID.test(frame.response.session_id)) throw new Error('session_id is invalid');
  return frame.response.session_id;
}

function readControlResponseSession(frame: Record<string, unknown>): string | undefined {
  const topLevel = readRawSession(frame);
  const nested = readNestedSession(frame);
  if (topLevel !== undefined && nested !== undefined && topLevel !== nested) throw new Error('control response session IDs do not match');
  return topLevel ?? nested;
}

function readSessionId(frame: Record<string, unknown>, expected: string | undefined, line: number, bytes: number): string | undefined {
  let current: string | undefined;
  try {
    current = readRawSession(frame);
  } catch {
    throw new ClaudeLiveWireError('malformed-frame', 'session_id is invalid', line, bytes);
  }
  if (expected !== undefined && current !== expected) throw new ClaudeLiveWireError('malformed-frame', 'session_id does not match expected session', line, bytes);
  return current;
}

function requiredRecord(value: unknown, label: string, line: number, bytes: number): Record<string, unknown> {
  if (!isRecord(value)) throw new ClaudeLiveWireError('malformed-frame', `${label} must be an object`, line, bytes);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFixtureInput(value: unknown, expected = { value: 'LIVE_TOOL_OK', delayMs: 0 }): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes('value') && keys.includes('delayMs') && value.value === expected.value && value.delayMs === expected.delayMs;
}

function validateStandaloneError(frame: Record<string, unknown>, line: number, bytes: number): void {
  if (Object.keys(frame).some(key => !STANDALONE_ERROR_KEYS.has(key))) {
    throw new ClaudeLiveWireError('malformed-frame', 'standalone error contains an unknown field', line, bytes);
  }
  const value = frame.error;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_STRING_LENGTH || value.includes('\0')) {
      throw new ClaudeLiveWireError('malformed-frame', 'standalone error message is invalid', line, bytes);
    }
    return;
  }
  if (!isRecord(value) || Object.keys(value).some(key => !STANDALONE_ERROR_OBJECT_KEYS.has(key))) {
    throw new ClaudeLiveWireError('malformed-frame', 'standalone error payload is invalid', line, bytes);
  }
  if (value.code !== undefined && (typeof value.code !== 'string' || !LABEL.test(value.code))) {
    throw new ClaudeLiveWireError('malformed-frame', 'standalone error code is invalid', line, bytes);
  }
  if (typeof value.message !== 'string' || value.message.length === 0 || value.message.length > MAX_STRING_LENGTH || value.message.includes('\0')) {
    throw new ClaudeLiveWireError('malformed-frame', 'standalone error message is invalid', line, bytes);
  }
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
    throw new ClaudeLiveWireError('malformed-frame', 'standalone error retryable flag is invalid', line, bytes);
  }
}

function requiredStreamIndex(value: unknown, line: number, bytes: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 256) {
    throw new ClaudeLiveWireError('malformed-frame', 'stream content block index is invalid', line, bytes);
  }
  return value;
}

function boundedWireLabel(value: unknown, label: string, line: number, bytes: number): string {
  if (typeof value !== 'string' || !LABEL.test(value)) throw new ClaudeLiveWireError('malformed-frame', `${label} is invalid`, line, bytes);
  return value;
}

function boundedThinkingString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH && !value.includes('\0');
}

function boundedThinkingStringOrEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && !value.includes('\0');
}

function validateContentBlockStart(type: string, block: Record<string, unknown>, line: number, bytes: number): void {
  if (type === 'thinking') {
    // The SDK's canonical thinking block includes a signature field.  The
    // field may be an empty string while the stream is being assembled, but
    // its presence is required; accepting a missing field would blur a
    // version-bound delta-start shape into canonical evidence.
    if (!boundedThinkingStringOrEmpty(block.thinking) || !boundedThinkingStringOrEmpty(block.signature)) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream thinking content block is invalid', line, bytes);
    }
  } else if (type === 'redacted_thinking') {
    if (!boundedThinkingString(block.data)) throw new ClaudeLiveWireError('malformed-frame', 'stream redacted thinking content block is invalid', line, bytes);
  } else if (type === 'text') {
    if (typeof block.text !== 'string' || block.text.length > MAX_STRING_LENGTH || block.text.includes('\0')) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream text content block is invalid', line, bytes);
    }
  }
}

function validateStreamDelta(type: string, delta: Record<string, unknown>, blockType: string, line: number, bytes: number): void {
  if (type === 'text_delta') {
    if (blockType !== 'text' || Object.keys(delta).some(key => !['type', 'text'].includes(key)) || typeof delta.text !== 'string' || delta.text.length === 0 || delta.text.length > MAX_STRING_LENGTH || delta.text.includes('\0')) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream text delta is invalid', line, bytes);
    }
    return;
  }
  if (type === 'thinking_delta') {
    if (blockType !== 'thinking' || Object.keys(delta).some(key => !['type', 'thinking', 'estimated_tokens'].includes(key)) || !boundedThinkingString(delta.thinking) || !boundedTokenEstimate(delta.estimated_tokens)) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream thinking delta is invalid', line, bytes);
    }
    return;
  }
  if (type === 'signature_delta') {
    if (blockType !== 'thinking' || Object.keys(delta).some(key => !['type', 'signature'].includes(key)) || !boundedThinkingString(delta.signature)) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream signature delta is invalid', line, bytes);
    }
    return;
  }
  if (type === 'input_json_delta') {
    if (blockType !== 'tool_use' || Object.keys(delta).some(key => !['type', 'partial_json'].includes(key)) || typeof delta.partial_json !== 'string' || delta.partial_json.length > MAX_STRING_LENGTH || delta.partial_json.includes('\0')) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream input JSON delta is invalid', line, bytes);
    }
    return;
  }
  if (NON_TEXT_DELTA_TYPES.has(type)) {
    // Citations/compaction are telemetry only. Their exact payloads are
    // version-bound; the framing/index lifecycle remains authoritative.
    return;
  }
  throw new ClaudeLiveWireError('unsupported-frame', 'stream delta type is not admitted', line, bytes);
}

function boundedTokenEstimate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000);
}

function validateStreamUsage(usage: Record<string, unknown>, line: number, bytes: number): void {
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    if (usage[key] !== undefined && (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > 10_000_000)) {
      throw new ClaudeLiveWireError('malformed-frame', 'stream message usage is invalid', line, bytes);
    }
  }
}

function validateThinkingTokens(frame: Record<string, unknown>, line: number, bytes: number): void {
  if (!boundedTokenEstimate(frame.estimated_tokens) || typeof frame.estimated_tokens_delta !== 'number' || !Number.isFinite(frame.estimated_tokens_delta) || frame.estimated_tokens_delta < 0 || frame.estimated_tokens_delta > 1_000_000) {
    throw new ClaudeLiveWireError('malformed-frame', 'thinking token telemetry is invalid', line, bytes);
  }
}

function validateTopLevelTelemetry(frame: Record<string, unknown>, type: string, line: number, bytes: number): void {
  if (type === 'conversation_reset') {
    if (!boundedWireId(frame.new_conversation_id) || !boundedWireId(frame.uuid)) throw new ClaudeLiveWireError('malformed-frame', 'conversation reset telemetry is invalid', line, bytes);
    return;
  }
  if (type === 'prompt_suggestion') {
    if (!boundedMetadataString(frame.suggestion)) throw new ClaudeLiveWireError('malformed-frame', 'prompt suggestion telemetry is invalid', line, bytes);
    return;
  }
  if (type === 'tool_progress') {
    if (!boundedWireId(frame.tool_use_id) || !boundedMetadataString(frame.tool_name) || (frame.parent_tool_use_id !== null && !boundedWireId(frame.parent_tool_use_id)) || typeof frame.elapsed_time_seconds !== 'number' || !Number.isFinite(frame.elapsed_time_seconds) || frame.elapsed_time_seconds < 0 || frame.elapsed_time_seconds > 86_400) {
      throw new ClaudeLiveWireError('malformed-frame', 'tool progress telemetry is invalid', line, bytes);
    }
    return;
  }
  if (type === 'tool_use_summary') {
    if (!boundedMetadataString(frame.summary) || !Array.isArray(frame.preceding_tool_use_ids) || frame.preceding_tool_use_ids.length > 128 || frame.preceding_tool_use_ids.some(value => !boundedWireId(value))) {
      throw new ClaudeLiveWireError('malformed-frame', 'tool use summary telemetry is invalid', line, bytes);
    }
  }
}

function boundedWireId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function validateStructuredOutput(
  value: unknown,
  expectation: ClaudeLiveStructuredExpectation | undefined,
): { readonly valid: boolean; readonly shape: string; readonly markerSeen: boolean } {
  const shape = structuredShape(value, expectation?.field);
  if (expectation === undefined) return { valid: true, shape, markerSeen: false };
  if (!isRecord(value)) return { valid: false, shape, markerSeen: false };
  const keys = Object.keys(value);
  const markerSeen = value[expectation.field] === expectation.marker;
  const valid = (expectation.shape === 'object' ? shape.startsWith('object{') : false) && keys.length === 1 && keys[0] === expectation.field && markerSeen;
  return { valid, shape, markerSeen };
}

function structuredShape(value: unknown, allowlistedField?: string): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (!isRecord(value)) return 'unknown';
  // Never persist arbitrary vendor/object key names.  The only field name
  // admitted into a shape is the fixed, caller-supplied schema field used by
  // the structured probe (currently `probe`); generic objects are summarized
  // without their keys.
  if (allowlistedField !== undefined && Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, allowlistedField)) {
    return `object{${allowlistedField}:${typeof value[allowlistedField]}}`;
  }
  return 'object';
}

function validateInitializeResponse(value: unknown, line: number, bytes: number): number | undefined {
  if (value === undefined) throw new ClaudeLiveWireError('control-invalid', 'initialize response payload is required', line, bytes);
  if (!isRecord(value)) throw new ClaudeLiveWireError('control-invalid', 'initialize response payload must be an object', line, bytes);
  if (Object.keys(value).some(key => !INITIALIZE_RESPONSE_KEYS.has(key))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize response contains an unknown field', line, bytes);
  }
  if (!Array.isArray(value.commands) || value.commands.length > 256) throw new ClaudeLiveWireError('control-invalid', 'initialize commands are invalid', line, bytes);
  if (!Array.isArray(value.agents) || value.agents.length > 256) throw new ClaudeLiveWireError('control-invalid', 'initialize agents are invalid', line, bytes);
  if (typeof value.output_style !== 'string' || value.output_style.length === 0 || value.output_style.length > 128) throw new ClaudeLiveWireError('control-invalid', 'initialize output_style is invalid', line, bytes);
  if (!Array.isArray(value.available_output_styles) || value.available_output_styles.length > 256 || value.available_output_styles.some(item => !boundedMetadataString(item))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize available_output_styles are invalid', line, bytes);
  }
  if (!Array.isArray(value.models) || value.models.length > 256) throw new ClaudeLiveWireError('control-invalid', 'initialize models are invalid', line, bytes);
  if (!isRecord(value.account)) throw new ClaudeLiveWireError('control-invalid', 'initialize account is invalid', line, bytes);
  if (Object.keys(value.account).some(key => !INITIALIZE_ACCOUNT_KEYS.has(key))) throw new ClaudeLiveWireError('control-invalid', 'initialize account contains an unknown field', line, bytes);
  for (const command of value.commands) validateInitializeCommand(command, line, bytes);
  for (const agent of value.agents) validateInitializeAgent(agent, line, bytes);
  for (const model of value.models) validateInitializeModel(model, line, bytes);
  if (value.account.apiProvider !== undefined && (typeof value.account.apiProvider !== 'string' || !ACCOUNT_API_PROVIDERS.has(value.account.apiProvider))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize account apiProvider is invalid', line, bytes);
  }
  for (const key of ['email', 'organization', 'subscriptionType', 'tokenSource', 'apiKeySource'] as const) {
    if (value.account[key] !== undefined && !boundedMetadataString(value.account[key])) throw new ClaudeLiveWireError('control-invalid', 'initialize account metadata is invalid', line, bytes);
  }
  if (value.fast_mode_state !== undefined && (typeof value.fast_mode_state !== 'string' || !INITIALIZE_FAST_MODE_STATES.has(value.fast_mode_state))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize fast_mode_state is invalid', line, bytes);
  }
  if (value.fast_mode_disabled_reason !== undefined && (typeof value.fast_mode_disabled_reason !== 'string' || !INITIALIZE_FAST_MODE_DISABLED_REASONS.has(value.fast_mode_disabled_reason))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize fast_mode_disabled_reason is invalid', line, bytes);
  }
  // The observed installed Claude release includes these additional connection/session metadata
  // fields in the SDK-shaped initialize response. Validate their bounded
  // types, but retain none of their values (the path/account/pid fields are
  // sensitive or environment-specific and are not evidence).
  if (value.user_output_styles_dir !== undefined && !boundedMetadataString(value.user_output_styles_dir)) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize user_output_styles_dir is invalid', line, bytes);
  }
  if (value.pid !== undefined && (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2_147_483_647)) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize pid is invalid', line, bytes);
  }
  if (value.current_permission_mode !== undefined && (typeof value.current_permission_mode !== 'string' || !INITIALIZE_PERMISSION_MODES.has(value.current_permission_mode))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize current_permission_mode is invalid', line, bytes);
  }
  for (const key of [
    'analytics_disabled',
    'remote_control_auto_enable',
    'remote_control_auto_connect_default',
    'remote_control_available',
    'remote_control_auto_on_by_default',
    'ide_rc_auto_enable_gate',
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new ClaudeLiveWireError('control-invalid', `initialize ${key} is invalid`, line, bytes);
    }
  }
  if (value.session_state !== undefined && (typeof value.session_state !== 'string' || !INITIALIZE_SESSION_STATES.has(value.session_state))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize session_state is invalid', line, bytes);
  }
  // Only bounded counts are retained in the marker; all names, descriptions,
  // account values, model IDs, and command IDs are discarded.
  return value.commands.length + value.agents.length + value.models.length;
}

/**
 * SDK control responses may re-arm parked permission/dialog requests while a
 * client joins an existing session. T04 cannot safely answer parked requests,
 * so it admits only empty arrays and rejects malformed/non-empty state before
 * any user frame can be dispatched. The nested request shape is still fully
 * bounded so diagnostics cannot be used as an unbounded payload sink.
 */
function validatePendingControlArrays(frame: Record<string, unknown>, line: number, bytes: number): void {
  const permission = validatePendingControlArray(frame.pending_permission_requests, 'permission', line, bytes);
  const dialog = validatePendingControlArray(frame.pending_user_dialog_requests, 'dialog', line, bytes);
  if (permission + dialog > 0) throw new ClaudeLiveWireError('control-invalid', 'T04 cannot admit pending control requests', line, bytes);
}

function validatePendingControlArray(value: unknown, kind: 'permission' | 'dialog', line: number, bytes: number): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 64) throw new ClaudeLiveWireError('control-invalid', `pending ${kind} controls are invalid`, line, bytes);
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some(key => !PENDING_CONTROL_KEYS.has(key)) || item.type !== 'control_request') {
      throw new ClaudeLiveWireError('control-invalid', `pending ${kind} control envelope is invalid`, line, bytes);
    }
    if (typeof item.request_id !== 'string' || !REQUEST_ID.test(item.request_id)) {
      throw new ClaudeLiveWireError('control-invalid', `pending ${kind} control request_id is invalid`, line, bytes);
    }
    const request = requiredRecord(item.request, `pending ${kind} control request`, line, bytes);
    if (kind === 'permission') {
      if (Object.keys(request).some(key => !PENDING_PERMISSION_REQUEST_KEYS.has(key)) || request.subtype !== 'can_use_tool') {
        throw new ClaudeLiveWireError('control-invalid', 'pending permission request shape is invalid', line, bytes);
      }
      if (typeof request.tool_name !== 'string' || !LABEL.test(request.tool_name) || !isRecord(request.input)) {
        throw new ClaudeLiveWireError('control-invalid', 'pending permission request fields are invalid', line, bytes);
      }
      if (typeof request.tool_use_id !== 'string' || !REQUEST_ID.test(request.tool_use_id)) {
        throw new ClaudeLiveWireError('control-invalid', 'pending permission request tool_use_id is invalid', line, bytes);
      }
      if (request.decision_reason_type !== undefined && (typeof request.decision_reason_type !== 'string' || !PERMISSION_DECISION_REASONS.has(request.decision_reason_type))) {
        throw new ClaudeLiveWireError('control-invalid', 'pending permission request decision reason is invalid', line, bytes);
      }
    } else {
      if (Object.keys(request).some(key => !PENDING_USER_DIALOG_REQUEST_KEYS.has(key)) || request.subtype !== 'request_user_dialog') {
        throw new ClaudeLiveWireError('control-invalid', 'pending user dialog request shape is invalid', line, bytes);
      }
      if (typeof request.dialog_kind !== 'string' || !LABEL.test(request.dialog_kind) || !isRecord(request.payload)) {
        throw new ClaudeLiveWireError('control-invalid', 'pending user dialog request fields are invalid', line, bytes);
      }
      if (request.tool_use_id !== undefined && (typeof request.tool_use_id !== 'string' || !REQUEST_ID.test(request.tool_use_id))) {
        throw new ClaudeLiveWireError('control-invalid', 'pending user dialog tool_use_id is invalid', line, bytes);
      }
    }
  }
  return value.length;
}

function validateSystemInitCapabilities(value: unknown, line: number, bytes: number): { interruptReceipt: boolean; interruptCancelQueued: boolean } {
  if (value === undefined) return { interruptReceipt: false, interruptCancelQueued: false };
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 128 || item.includes('\0'))) {
    throw new ClaudeLiveWireError('control-invalid', 'system init capabilities are invalid', line, bytes);
  }
  return {
    interruptReceipt: value.includes(CAPABILITY_FLAGS.interruptReceipt),
    interruptCancelQueued: value.includes(CAPABILITY_FLAGS.interruptCancelQueued),
  };
}

function boundedMetadataString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0');
}

function boundedMetadataStringOrEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4_096 && !value.includes('\0');
}

function validateInitializeObjectKeys(value: unknown, keys: Set<string>, label: string, line: number, bytes: number): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.has(key))) throw new ClaudeLiveWireError('control-invalid', `${label} shape is invalid`, line, bytes);
  return value;
}

function validateInitializeCommand(value: unknown, line: number, bytes: number): void {
  const command = validateInitializeObjectKeys(value, INITIALIZE_COMMAND_KEYS, 'initialize command', line, bytes);
  for (const key of ['name', 'description'] as const) {
    if (!boundedMetadataString(command[key])) throw new ClaudeLiveWireError('control-invalid', 'initialize command metadata is invalid', line, bytes);
  }
  if (!boundedMetadataStringOrEmpty(command.argumentHint)) throw new ClaudeLiveWireError('control-invalid', 'initialize command argumentHint is invalid', line, bytes);
  if (command.aliases !== undefined && (!Array.isArray(command.aliases) || command.aliases.length > 32 || command.aliases.some(item => !boundedMetadataString(item)))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize command aliases are invalid', line, bytes);
  }
}

function validateInitializeAgent(value: unknown, line: number, bytes: number): void {
  const agent = validateInitializeObjectKeys(value, INITIALIZE_AGENT_KEYS, 'initialize agent', line, bytes);
  if (!boundedMetadataString(agent.name) || !boundedMetadataString(agent.description) || (agent.model !== undefined && !boundedMetadataString(agent.model))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize agent metadata is invalid', line, bytes);
  }
}

function validateInitializeModel(value: unknown, line: number, bytes: number): void {
  const model = validateInitializeObjectKeys(value, INITIALIZE_MODEL_KEYS, 'initialize model', line, bytes);
  for (const key of ['value', 'displayName', 'description'] as const) {
    if (!boundedMetadataString(model[key])) throw new ClaudeLiveWireError('control-invalid', 'initialize model metadata is invalid', line, bytes);
  }
  for (const key of ['resolvedModel'] as const) {
    if (model[key] !== undefined && !boundedMetadataString(model[key])) throw new ClaudeLiveWireError('control-invalid', 'initialize model metadata is invalid', line, bytes);
  }
  for (const key of ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode'] as const) {
    if (model[key] !== undefined && typeof model[key] !== 'boolean') throw new ClaudeLiveWireError('control-invalid', 'initialize model feature flag is invalid', line, bytes);
  }
  if (model.supportedEffortLevels !== undefined && (!Array.isArray(model.supportedEffortLevels) || model.supportedEffortLevels.length > 8 || model.supportedEffortLevels.some(item => !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(item))))) {
    throw new ClaudeLiveWireError('control-invalid', 'initialize model effort levels are invalid', line, bytes);
  }
}

function validateInterruptResponse(value: unknown, line: number, bytes: number): { label: string; stillQueued: number; cancelled: number } {
  if (!isRecord(value)) throw new ClaudeLiveWireError('control-invalid', 'interrupt response must be an object', line, bytes);
  if (typeof value.status === 'string' && LEGACY_INTERRUPT_STATUSES.has(value.status)) {
    // Compatibility with the pre-SDK candidate fixture is intentionally
    // explicit and labelled; canonical SDK responses use arrays below.
    return { label: `legacy-${value.status}`, stillQueued: 0, cancelled: 0 };
  }
  if (Object.keys(value).some(key => !INTERRUPT_RECEIPT_KEYS.has(key)) || !Array.isArray(value.still_queued) || value.still_queued.length > 256 || value.still_queued.some(item => typeof item !== 'string' || !SESSION_ID.test(item))) {
    throw new ClaudeLiveWireError('control-invalid', 'interrupt response must contain bounded still_queued/cancelled arrays', line, bytes);
  }
  if (value.cancelled !== undefined && (!Array.isArray(value.cancelled) || value.cancelled.length > 256 || value.cancelled.some(item => typeof item !== 'string' || !SESSION_ID.test(item)))) {
    throw new ClaudeLiveWireError('control-invalid', 'interrupt response cancelled array is invalid', line, bytes);
  }
  return { label: 'receipt', stillQueued: value.still_queued.length, cancelled: Array.isArray(value.cancelled) ? value.cancelled.length : 0 };
}

function assertJsonBounds(value: unknown, maxDepth: number, maxNodes: number, maxStringLength: number, line: number, bytes: number): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) throw new ClaudeLiveWireError('frame-limit', 'live wire JSON bounds exceeded', line, bytes);
    if (typeof current.value === 'string') {
      if (current.value.length > maxStringLength || current.value.includes('\0')) throw new ClaudeLiveWireError('frame-limit', 'live wire string bounds exceeded', line, bytes);
      continue;
    }
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) throw new ClaudeLiveWireError('malformed-frame', 'live wire number is invalid', line, bytes);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) throw new ClaudeLiveWireError('malformed-frame', 'live wire JSON value is invalid', line, bytes);
    for (const [key, child] of Object.entries(current.value)) {
      if (key.length > maxStringLength) throw new ClaudeLiveWireError('frame-limit', 'live wire key bounds exceeded', line, bytes);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}
