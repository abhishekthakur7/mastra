/**
 * Offline Claude tool/function-hook bridge contract.
 *
 * This is a bounded fixture, not a production runtime.  It models the host
 * boundary that a Claude control/MCP adapter must preserve: one serialized
 * callback relay, durable request correlation, an approval barrier before the
 * tool effect, and result processing before persistence or continuation.
 * Values crossing the boundary are schema validated and the default transport
 * is a harmless deterministic fixture tool.
 */

import { z } from 'zod/v3';
import { FIXTURE_MCP_TOOL_NAME, fixtureToolInputSchema, fixtureToolOutputSchema } from './mcp-fixture';
import type { FixtureToolInput, JsonValue } from './types';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_REASON_BYTES = 512;
const MAX_PENDING_CLIENT_TOOLS = 64;
const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = 5_000;
const MAX_CLIENT_TOOL_TIMEOUT_MS = 30_000;

const idSchema = z.string().regex(ID_PATTERN, 'must be a bounded correlation ID');
const boundedMessageSchema = z.string().min(1).max(MAX_MESSAGE_BYTES);
const boundedReasonSchema = z.string().min(1).max(MAX_REASON_BYTES);
const MAX_CLIENT_JSON_DEPTH = 8;
const MAX_CLIENT_JSON_STRING_LENGTH = 4_096;
const MAX_CLIENT_JSON_ARRAY_ITEMS = 64;
const MAX_CLIENT_JSON_OBJECT_KEYS = 64;

/** JSON-only values are the only values allowed to cross or persist a client boundary. */
const boundedJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(MAX_CLIENT_JSON_STRING_LENGTH),
    z.array(boundedJsonValueSchema).max(MAX_CLIENT_JSON_ARRAY_ITEMS),
    z.record(boundedJsonValueSchema),
  ]),
);

const boundedJsonObjectSchema = z.record(boundedJsonValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_CLIENT_JSON_OBJECT_KEYS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `JSON object has more than ${MAX_CLIENT_JSON_OBJECT_KEYS} keys` });
  }
  if (!isBoundedJsonValue(value, 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON value exceeds the client persistence bounds' });
  }
});

function isBoundedJsonValue(value: JsonValue, depth: number): boolean {
  if (depth > MAX_CLIENT_JSON_DEPTH) return false;
  if (typeof value === 'string') return value.length <= MAX_CLIENT_JSON_STRING_LENGTH;
  if (Array.isArray(value)) return value.length <= MAX_CLIENT_JSON_ARRAY_ITEMS && value.every(item => isBoundedJsonValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length <= MAX_CLIENT_JSON_OBJECT_KEYS && entries.every(([key, child]) => key.length <= MAX_CLIENT_JSON_STRING_LENGTH && isBoundedJsonValue(child, depth + 1));
  }
  return true;
}

/** The only tool admitted by the T05 fixture. */
export const CLAUDE_FIXTURE_TOOL_NAME = FIXTURE_MCP_TOOL_NAME;

export const claudeMcpToolCallSchema = z
  .object({
    protocol: z.literal('mcp'),
    schemaVersion: z.literal(1),
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    toolName: z.literal(CLAUDE_FIXTURE_TOOL_NAME),
    input: fixtureToolInputSchema,
  })
  .strict();

export const claudeMcpToolErrorSchema = z
  .object({
    code: z.enum([
      'invalid-request',
      'invalid-input',
      'approval-required',
      'approval-denied',
      'pre-tool-blocked',
      'hook-timeout',
      'transport-error',
      'result-processing-error',
      'persistence-error',
      'continuation-error',
      'client-tool-timeout',
      'client-tool-disconnected',
      'duplicate-call-conflict',
      'bridge-closed',
    ]),
    message: boundedMessageSchema,
  })
  .strict();

export const claudeMcpToolResultSchema = z
  .object({
    protocol: z.literal('mcp'),
    schemaVersion: z.literal(1),
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    status: z.enum(['success', 'error']),
    output: fixtureToolOutputSchema.optional(),
    error: claudeMcpToolErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasOutput = value.output !== undefined;
    const hasError = value.error !== undefined;
    if (value.status === 'success' && (!hasOutput || hasError)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'success results require output and no error' });
    }
    if (value.status === 'error' && (hasOutput || !hasError)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'error results require error and no output' });
    }
  });

export type ClaudeMcpToolCall = z.infer<typeof claudeMcpToolCallSchema>;
export type ClaudeMcpToolError = z.infer<typeof claudeMcpToolErrorSchema>;
export type ClaudeMcpToolResult = z.infer<typeof claudeMcpToolResultSchema>;

export function serializeClaudeMcpToolCall(request: ClaudeMcpToolCall): string {
  return `${JSON.stringify(claudeMcpToolCallSchema.parse(request))}\n`;
}

export function parseClaudeMcpToolCall(serialized: string): ClaudeMcpToolCall {
  return claudeMcpToolCallSchema.parse(parseJson(serialized, 'MCP tool call'));
}

export function serializeClaudeMcpToolResult(result: ClaudeMcpToolResult): string {
  return `${JSON.stringify(claudeMcpToolResultSchema.parse(result))}\n`;
}

export function parseClaudeMcpToolResult(serialized: string): ClaudeMcpToolResult {
  return claudeMcpToolResultSchema.parse(parseJson(serialized, 'MCP tool result'));
}

function parseJson(serialized: string, label: string): unknown {
  if (typeof serialized !== 'string' || serialized.length === 0 || serialized.length > 128 * 1024) {
    throw new Error(`${label} envelope is missing or oversized`);
  }
  try {
    return JSON.parse(serialized.trim()) as unknown;
  } catch {
    throw new Error(`${label} envelope is not valid JSON`);
  }
}

export type ClaudeToolRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: typeof CLAUDE_FIXTURE_TOOL_NAME;
  readonly input: FixtureToolInput;
  readonly requiresApproval?: boolean;
};

export const claudeToolRequestSchema = z
  .object({
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    toolName: z.literal(CLAUDE_FIXTURE_TOOL_NAME),
    input: fixtureToolInputSchema,
    requiresApproval: z.boolean().optional().default(true),
  })
  .strict();

type ParsedToolRequest = z.infer<typeof claudeToolRequestSchema>;

export type ClaudePreToolDecision =
  | { readonly decision: 'allow'; readonly input?: FixtureToolInput; readonly reason?: string }
  | { readonly decision: 'modify'; readonly input: FixtureToolInput; readonly reason?: string }
  | { readonly decision: 'deny'; readonly reason?: string };

export const claudePreToolDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'modify', 'deny']),
    input: fixtureToolInputSchema.optional(),
    reason: boundedReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'modify' && value.input === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['input'], message: 'modify decisions require input' });
    }
    if (value.decision === 'deny' && value.input !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['input'], message: 'deny decisions cannot carry input' });
    }
  });

export type ClaudeApprovalDecision =
  | 'allow'
  | 'deny'
  | { readonly decision: 'allow' | 'deny'; readonly reason?: string };

export const claudeApprovalDecisionSchema = z.object({ decision: z.enum(['allow', 'deny']), reason: boundedReasonSchema.optional() }).strict();

export type ClaudeToolResult = ClaudeMcpToolResult;

export type ClaudeClientToolRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, JsonValue>;
  readonly requiresApproval?: boolean;
};

export const claudeClientToolRequestSchema = z
  .object({
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    toolName: z.string().regex(ID_PATTERN),
    input: boundedJsonObjectSchema,
    requiresApproval: z.boolean().optional().default(true),
  })
  .strict();

export const claudeClientToolResultSchema = z
  .object({
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    status: z.enum(['success', 'error']),
    output: boundedJsonObjectSchema.optional(),
    error: claudeMcpToolErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'success' && (value.output === undefined || value.error !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'client success requires output and no error' });
    }
    if (value.status === 'error' && (value.output !== undefined || value.error === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'client error requires error and no output' });
    }
  });

export type ClaudeClientToolResult = z.infer<typeof claudeClientToolResultSchema>;

const bridgeRecordSchema = z
  .object({
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    toolName: z.literal(CLAUDE_FIXTURE_TOOL_NAME),
    input: fixtureToolInputSchema,
    requiresApproval: z.boolean(),
    state: z.enum(['received', 'blocked', 'awaiting-approval', 'denied', 'invoking', 'completed', 'errored']),
    invocationStarted: z.boolean(),
    preToolDecision: z.enum(['allow', 'modify', 'deny']).optional(),
    effectiveInput: fixtureToolInputSchema.optional(),
    approvalDecision: z.enum(['allow', 'deny']).optional(),
    result: claudeMcpToolResultSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = value.state === 'blocked' || value.state === 'denied' || value.state === 'completed' || value.state === 'errored';
    if (terminal && value.result === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'terminal calls require a result' });
    if (!terminal && value.result !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'non-terminal calls cannot carry a result' });
    if (value.result !== undefined && (value.result.requestId !== value.requestId || value.result.sessionId !== value.sessionId || value.result.toolCallId !== value.toolCallId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'persisted result correlation does not match the call' });
    }
    if (value.state === 'completed' && (value.result?.status !== 'success' || !value.invocationStarted)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'completed calls require a successful invoked result' });
    }
    if (value.state === 'blocked' && (value.result?.error?.code !== 'pre-tool-blocked' || value.invocationStarted)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'blocked calls must stop before invocation' });
    }
    if (value.state === 'denied' && (value.result?.error?.code !== 'approval-denied' && value.result?.error?.code !== 'approval-required')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'denied calls require an approval result' });
    }
    if (value.state === 'errored' && value.result?.status !== 'error') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'errored calls require an error result' });
    }
  });

const clientRecordSchema = z
  .object({
    requestId: idSchema,
    sessionId: idSchema,
    toolCallId: idSchema,
    toolName: z.string().regex(ID_PATTERN),
    input: boundedJsonObjectSchema,
    requiresApproval: z.boolean(),
    state: z.enum(['pending', 'completed', 'errored']),
    result: claudeMcpToolResultSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === 'pending' && value.result !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'pending client calls cannot carry a result' });
    if (value.state !== 'pending' && value.result === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'terminal client calls require a result' });
    if (value.result !== undefined && (value.result.requestId !== value.requestId || value.result.sessionId !== value.sessionId || value.result.toolCallId !== value.toolCallId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'persisted result correlation does not match the client call' });
    }
    if (value.state === 'completed' && value.result?.status !== 'success') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'completed client calls require a successful result' });
    }
    if (value.state === 'errored' && value.result?.status !== 'error') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'errored client calls require an error result' });
    }
  });

export const claudeToolBridgeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    closed: z.boolean().default(false),
    calls: z.array(bridgeRecordSchema).max(128),
    clientCalls: z.array(clientRecordSchema).max(128).default([]),
    pendingClientTools: z.array(idSchema).max(MAX_PENDING_CLIENT_TOOLS).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const callIds = new Set<string>();
    for (const call of value.calls) {
      if (callIds.has(call.toolCallId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['calls'], message: 'duplicate tool call ID' });
      callIds.add(call.toolCallId);
    }
    const clientIds = new Set<string>();
    for (const call of value.clientCalls) {
      // Native MCP and client-tool calls have independent ledgers. Their
      // vendor call IDs may coincide without making either request a retry of
      // the other; uniqueness is enforced within each ledger only.
      if (clientIds.has(call.toolCallId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['clientCalls'], message: 'duplicate tool call ID' });
      clientIds.add(call.toolCallId);
    }
    const pendingIds = new Set(value.pendingClientTools);
    if (pendingIds.size !== value.pendingClientTools.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['pendingClientTools'], message: 'duplicate pending client tool ID' });
    const expectedPending = value.clientCalls.filter(call => call.state === 'pending').map(call => call.toolCallId).sort();
    const actualPending = [...pendingIds].sort();
    if (JSON.stringify(expectedPending) !== JSON.stringify(actualPending)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['pendingClientTools'], message: 'pending client tool IDs do not match client call state' });
  });

export type ClaudeHostRelayPhase =
  | 'pre-tool'
  | 'approval'
  | 'tool-call'
  | 'client-tool-request'
  | 'tool-result'
  | 'persist'
  | 'model-continuation';

export type ClaudeHostRelayEvent = {
  readonly sequence: number;
  readonly phase: ClaudeHostRelayPhase;
  readonly status: 'started' | 'completed' | 'failed';
  readonly requestId: string;
  readonly toolCallId: string;
};

/**
 * Serializes every host callback.  The queue is advanced on both fulfillment
 * and rejection so a failed hook cannot permanently wedge the relay.
 */
export class ClaudeSerializedHostRelay {
  private tail: Promise<void> = Promise.resolve();
  private nextSequence = 1;
  private readonly recordedEvents: ClaudeHostRelayEvent[] = [];

  get events(): readonly ClaudeHostRelayEvent[] {
    return this.recordedEvents.slice();
  }

  get orderingMap(): Readonly<Record<ClaudeHostRelayPhase, readonly number[]>> {
    const result = {} as Record<ClaudeHostRelayPhase, number[]>;
    for (const event of this.recordedEvents) {
      (result[event.phase] ??= []).push(event.sequence);
    }
    return result;
  }

  run<T>(
    phase: ClaudeHostRelayPhase,
    request: Pick<ClaudeHostRelayEvent, 'requestId' | 'toolCallId'>,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    const invoke = async (): Promise<T> => {
      this.record(phase, 'started', request);
      try {
        const value = await callback();
        this.record(phase, 'completed', request);
        return value;
      } catch (error) {
        this.record(phase, 'failed', request);
        throw error;
      }
    };
    const result = this.tail.then(invoke, invoke);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private record(
    phase: ClaudeHostRelayPhase,
    status: ClaudeHostRelayEvent['status'],
    request: Pick<ClaudeHostRelayEvent, 'requestId' | 'toolCallId'>,
  ): void {
    this.recordedEvents.push({ sequence: this.nextSequence++, phase, status, requestId: request.requestId, toolCallId: request.toolCallId });
  }
}

export type ClaudeToolBridgeCallbacks = {
  readonly preTool?: (
    request: ClaudeToolRequest,
    context: { readonly signal: AbortSignal },
  ) => ClaudePreToolDecision | Promise<ClaudePreToolDecision>;
  readonly approve?: (
    request: ClaudeToolRequest,
    context: { readonly signal: AbortSignal },
  ) => ClaudeApprovalDecision | Promise<ClaudeApprovalDecision>;
  readonly processToolResult?: (
    request: ClaudeToolRequest,
    result: ClaudeMcpToolResult,
    context: { readonly signal: AbortSignal },
  ) => ClaudeMcpToolResult | Promise<ClaudeMcpToolResult>;
  readonly persistToolResult?: (result: ClaudeMcpToolResult, context?: { readonly signal: AbortSignal }) => Promise<void> | void;
  readonly continueModel?: (result: ClaudeMcpToolResult, context?: { readonly signal: AbortSignal }) => Promise<void> | void;
};

export type ClaudeMcpTransport = (
  request: ClaudeMcpToolCall,
  context: { readonly signal: AbortSignal },
) => ClaudeMcpToolResult | Promise<ClaudeMcpToolResult>;

export type ClaudeClientToolHandler = (
  request: ClaudeClientToolRequest,
  context: { readonly signal: AbortSignal },
) => ClaudeClientToolResult | Promise<ClaudeClientToolResult>;

export type ClaudeToolBridgeOptions = ClaudeToolBridgeCallbacks & {
  readonly transport?: ClaudeMcpTransport;
  /** Maximum time allowed for one host callback, including approval/hooks. */
  readonly hookTimeoutMs?: number;
  readonly clientToolTimeoutMs?: number;
  readonly maxPendingClientTools?: number;
  readonly relay?: ClaudeSerializedHostRelay;
};

type ToolRecord = {
  readonly request: ParsedToolRequest;
  readonly fingerprint: string;
  state: 'received' | 'blocked' | 'awaiting-approval' | 'denied' | 'invoking' | 'completed' | 'errored';
  invocationStarted: boolean;
  preToolDecision?: ClaudePreToolDecision['decision'];
  effectiveInput?: FixtureToolInput;
  approvalDecision?: 'allow' | 'deny';
  result?: ClaudeMcpToolResult;
};

export type ClaudeToolBridgeRecord = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: typeof CLAUDE_FIXTURE_TOOL_NAME;
  readonly input: FixtureToolInput;
  readonly requiresApproval: boolean;
  readonly state: ToolRecord['state'];
  readonly invocationStarted: boolean;
  readonly preToolDecision?: 'allow' | 'modify' | 'deny';
  readonly effectiveInput?: FixtureToolInput;
  readonly approvalDecision?: 'allow' | 'deny';
  readonly result?: ClaudeMcpToolResult;
};

export type ClaudeToolBridgeSnapshot = {
  readonly schemaVersion: 1;
  readonly closed: boolean;
  readonly calls: readonly ClaudeToolBridgeRecord[];
  readonly clientCalls: readonly ClaudeToolBridgeClientRecord[];
  readonly pendingClientTools: readonly string[];
};

export type ClaudeToolBridgeClientRecord = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, JsonValue>;
  readonly requiresApproval: boolean;
  readonly state: 'pending' | 'completed' | 'errored';
  readonly result?: ClaudeMcpToolResult;
};

type ClientPending = {
  readonly request: z.infer<typeof claudeClientToolRequestSchema>;
  readonly resolve: (result: ClaudeClientToolResult) => void;
  settled: boolean;
};

type ClientCallRecord = {
  readonly request: z.infer<typeof claudeClientToolRequestSchema>;
  readonly fingerprint: string;
  state: 'pending' | 'completed' | 'errored';
  result?: ClaudeMcpToolResult;
};

export class ClaudeToolBridge {
  readonly relay: ClaudeSerializedHostRelay;
  private readonly callbacks: ClaudeToolBridgeCallbacks;
  private readonly transport: ClaudeMcpTransport;
  private readonly hookTimeoutMs: number;
  private readonly clientToolTimeoutMs: number;
  private readonly maxPendingClientTools: number;
  private readonly calls = new Map<string, { readonly promise: Promise<ClaudeMcpToolResult>; readonly record: ToolRecord }>();
  private readonly clientCalls = new Map<string, { readonly promise: Promise<ClaudeMcpToolResult>; readonly record: ClientCallRecord }>();
  private readonly pendingClientTools = new Map<string, ClientPending>();
  private closed = false;

  constructor(options: ClaudeToolBridgeOptions = {}) {
    this.callbacks = options;
    this.relay = options.relay ?? new ClaudeSerializedHostRelay();
    this.transport = options.transport ?? createFixtureMcpTransport();
    this.hookTimeoutMs = boundedHookTimeout(options.hookTimeoutMs);
    this.clientToolTimeoutMs = boundedTimeout(options.clientToolTimeoutMs);
    this.maxPendingClientTools = boundedPendingClientTools(options.maxPendingClientTools);
  }

  /** Rehydrate a bridge from a JSON-safe host snapshot before accepting work. */
  static fromSnapshot(snapshot: unknown, options: ClaudeToolBridgeOptions = {}): ClaudeToolBridge {
    const bridge = new ClaudeToolBridge(options);
    bridge.restore(snapshot);
    return bridge;
  }

  get callRecords(): readonly ToolRecord[] {
    return Array.from(this.calls.values(), entry => ({ ...entry.record }));
  }

  /** A JSON-safe ledger snapshot suitable for durable host persistence. */
  snapshot(): ClaudeToolBridgeSnapshot {
    const snapshot = {
      schemaVersion: 1,
      closed: this.closed,
      calls: this.callRecords.map(record => ({
        requestId: record.request.requestId,
        sessionId: record.request.sessionId,
        toolCallId: record.request.toolCallId,
        toolName: record.request.toolName,
        input: record.request.input,
        requiresApproval: record.request.requiresApproval,
        state: record.state,
        invocationStarted: record.invocationStarted,
        ...(record.preToolDecision === undefined ? {} : { preToolDecision: record.preToolDecision }),
        ...(record.effectiveInput === undefined ? {} : { effectiveInput: record.effectiveInput }),
        ...(record.approvalDecision === undefined ? {} : { approvalDecision: record.approvalDecision }),
        ...(record.result === undefined ? {} : { result: record.result }),
      })),
      clientCalls: Array.from(this.clientCalls.values(), ({ record }) => ({
        requestId: record.request.requestId,
        sessionId: record.request.sessionId,
        toolCallId: record.request.toolCallId,
        toolName: record.request.toolName,
        input: record.request.input,
        requiresApproval: record.request.requiresApproval,
        state: record.state,
        ...(record.result === undefined ? {} : { result: record.result }),
      })),
      pendingClientTools: Array.from(this.pendingClientTools.keys()),
    };
    return claudeToolBridgeSnapshotSchema.parse(snapshot) as ClaudeToolBridgeSnapshot;
  }

  /**
   * Restore durable call state.  Non-terminal in-process tool calls are
   * converted to terminal bridge errors because their callback/process handle
   * cannot be safely reconstructed; they are never replayed. Pending client
   * calls are different: their explicit external result can still be
   * correlated after restore and is processed through the normal host phases.
   */
  restore(snapshot: unknown): void {
    if (this.calls.size > 0 || this.clientCalls.size > 0 || this.pendingClientTools.size > 0) {
      throw new Error('tool bridge restore requires a fresh bridge');
    }
    const parsed = claudeToolBridgeSnapshotSchema.parse(snapshot);
    this.closed = parsed.closed;

    for (const persisted of parsed.calls) {
      const request = claudeToolRequestSchema.parse({
        requestId: persisted.requestId,
        sessionId: persisted.sessionId,
        toolCallId: persisted.toolCallId,
        toolName: persisted.toolName,
        input: persisted.input,
        requiresApproval: persisted.requiresApproval,
      });
      const record: ToolRecord = {
        request,
        fingerprint: toolRequestFingerprint(request),
        state: persisted.state,
        invocationStarted: persisted.invocationStarted,
        ...(persisted.preToolDecision === undefined ? {} : { preToolDecision: persisted.preToolDecision }),
        ...(persisted.effectiveInput === undefined ? {} : { effectiveInput: persisted.effectiveInput }),
        ...(persisted.approvalDecision === undefined ? {} : { approvalDecision: persisted.approvalDecision }),
        ...(persisted.result === undefined ? {} : { result: persisted.result }),
      };
      const terminal = persisted.result ?? this.errorResult(request, 'bridge-closed', 'in-flight tool call was not replayed after restore');
      if (persisted.result === undefined) {
        record.state = 'errored';
        record.result = terminal;
      }
      this.calls.set(request.toolCallId, { promise: Promise.resolve(terminal), record });
    }

    const pendingIds = new Set(parsed.pendingClientTools);
    for (const persisted of parsed.clientCalls) {
      const request = claudeClientToolRequestSchema.parse({
        requestId: persisted.requestId,
        sessionId: persisted.sessionId,
        toolCallId: persisted.toolCallId,
        toolName: persisted.toolName,
        input: persisted.input,
        requiresApproval: persisted.requiresApproval,
      });
      const record: ClientCallRecord = {
        request,
        fingerprint: clientToolRequestFingerprint(request),
        state: persisted.state,
        ...(persisted.result === undefined ? {} : { result: persisted.result }),
      };
      if (persisted.state === 'pending') {
        if (!pendingIds.has(request.toolCallId)) throw new Error('pending client call is missing from the pending index');
        const pendingResult = new Promise<ClaudeClientToolResult>(resolve => {
          this.pendingClientTools.set(request.toolCallId, { request, resolve, settled: false });
        });
        const promise = this.processClientToolResult(request, pendingResult, new AbortController(), record);
        this.clientCalls.set(request.toolCallId, { promise, record });
      } else {
        if (persisted.result === undefined) throw new Error('terminal client call is missing its result');
        this.clientCalls.set(request.toolCallId, { promise: Promise.resolve(persisted.result), record });
      }
    }
  }

  async dispatch(request: ClaudeToolRequest): Promise<ClaudeMcpToolResult> {
    const parsed = claudeToolRequestSchema.parse(request);
    const fingerprint = toolRequestFingerprint(parsed);
    const existing = this.calls.get(parsed.toolCallId);
    if (existing) {
      if (existing.record.fingerprint !== fingerprint) {
        return this.errorResult(parsed, 'duplicate-call-conflict', 'tool call ID was reused with different request data');
      }
      // Return the original promise.  This is the at-most-once invocation
      // guarantee for retries and duplicate vendor callbacks.
      return existing.promise;
    }
    if (this.closed) return this.errorResult(parsed, 'bridge-closed', 'tool bridge is closed');

    const record: ToolRecord = { request: parsed, fingerprint, state: 'received', invocationStarted: false };
    const promise = this.executeTool(parsed, record);
    this.calls.set(parsed.toolCallId, { promise, record });
    return promise;
  }

  /**
   * Starts a client-tool request and waits for an explicit correlated result.
   * The request remains pending until `provideClientToolResult` is called.
   */
  async dispatchClientTool(request: ClaudeClientToolRequest): Promise<ClaudeMcpToolResult> {
    const parsed = claudeClientToolRequestSchema.parse(request);
    const fingerprint = clientToolRequestFingerprint(parsed);
    const existing = this.clientCalls.get(parsed.toolCallId);
    if (existing) {
      if (existing.record.fingerprint !== fingerprint) {
        return this.errorResult(parsed, 'duplicate-call-conflict', 'client tool call ID was reused with different request data');
      }
      return existing.promise;
    }
    if (this.closed) return this.errorResult(parsed, 'bridge-closed', 'tool bridge is closed');
    if (this.pendingClientTools.size >= this.maxPendingClientTools) {
      return this.errorResult(parsed, 'client-tool-disconnected', 'client-tool pending limit exceeded');
    }

    const record: ClientCallRecord = { request: parsed, fingerprint, state: 'pending' };
    const promise = this.waitForClientToolResult(parsed, record);
    this.clientCalls.set(parsed.toolCallId, { promise, record });
    return promise;
  }

  /** Resolves exactly one pending client-tool request by its stable call ID. */
  provideClientToolResult(result: ClaudeClientToolResult): void {
    const parsed = claudeClientToolResultSchema.parse(result);
    const pending = this.pendingClientTools.get(parsed.toolCallId);
    if (!pending) throw new Error('client-tool result has no matching pending call');
    if (pending.request.requestId !== parsed.requestId || pending.request.sessionId !== parsed.sessionId) {
      throw new Error('client-tool result correlation does not match the pending request');
    }
    if (pending.settled) throw new Error('client-tool result was already applied');
    pending.settled = true;
    pending.resolve(parsed);
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pendingClientTools.values()) {
      if (pending.settled) continue;
      pending.settled = true;
      pending.resolve({
        requestId: pending.request.requestId,
        sessionId: pending.request.sessionId,
        toolCallId: pending.request.toolCallId,
        status: 'error',
        error: { code: 'client-tool-disconnected', message: 'client-tool bridge closed before a result arrived' },
      });
    }
  }

  private async executeTool(request: ParsedToolRequest, record: ToolRecord): Promise<ClaudeMcpToolResult> {
    const controller = new AbortController();
    let effectiveInput = request.input;
    try {
      if (this.callbacks.preTool) {
        const decision = await this.runHostCallback('pre-tool', request, controller, () =>
          this.callbacks.preTool!(request, { signal: controller.signal }),
        );
        const parsedDecision = claudePreToolDecisionSchema.parse(decision);
        record.preToolDecision = parsedDecision.decision;
        if (parsedDecision.decision === 'deny') {
          record.state = 'blocked';
          return this.finishRecord(record, this.errorResult(request, 'pre-tool-blocked', parsedDecision.reason ?? 'pre-tool hook denied execution'));
        }
        if (parsedDecision.input !== undefined) effectiveInput = parsedDecision.input;
      }
      record.effectiveInput = effectiveInput;

      if (request.requiresApproval !== false) {
        record.state = 'awaiting-approval';
        if (!this.callbacks.approve) {
          record.state = 'denied';
          return this.finishRecord(record, this.errorResult(request, 'approval-required', 'approval callback is required before tool invocation'));
        }
        const approvalRequest = { ...request, input: effectiveInput };
        const decision = await this.runHostCallback('approval', approvalRequest, controller, () => this.callbacks.approve!(approvalRequest, { signal: controller.signal }));
        const parsedDecision = claudeApprovalDecisionSchema.parse(
          typeof decision === 'string' ? { decision } : decision,
        );
        record.approvalDecision = parsedDecision.decision;
        if (parsedDecision.decision === 'deny') {
          record.state = 'denied';
          return this.finishRecord(record, this.errorResult(request, 'approval-denied', parsedDecision.reason ?? 'tool invocation denied'));
        }
      }

      record.state = 'invoking';
      // Set this before crossing the MCP boundary.  If the transport fails
      // after dispatch, the call remains terminal and is never replayed.
      record.invocationStarted = true;
      const mcpRequest = claudeMcpToolCallSchema.parse({
        protocol: 'mcp',
        schemaVersion: 1,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: effectiveInput,
      });
      let result = claudeMcpToolResultSchema.parse(
        await this.relay.run('tool-call', request, () => this.transport(mcpRequest, { signal: controller.signal })),
      );
      if (result.requestId !== request.requestId || result.sessionId !== request.sessionId || result.toolCallId !== request.toolCallId) {
        throw new BridgeRuntimeError('transport-error', 'MCP result correlation does not match the dispatched call');
      }

      if (this.callbacks.processToolResult) {
        try {
          result = claudeMcpToolResultSchema.parse(
            await this.runHostCallback('tool-result', request, controller, () => this.callbacks.processToolResult!(request, result, { signal: controller.signal })),
          );
          if (result.requestId !== request.requestId || result.sessionId !== request.sessionId || result.toolCallId !== request.toolCallId) {
            throw new BridgeRuntimeError('result-processing-error', 'processed MCP result correlation does not match the call');
          }
        } catch (error) {
          if (error instanceof BridgeRuntimeError && error.code === 'hook-timeout') throw error;
          throw new BridgeRuntimeError('result-processing-error', errorMessage(error));
        }
      }
      if (result.status === 'error') {
        // Error results still pass through result processing, but are not
        // persisted/continued as successful model-visible output.
        record.state = 'errored';
        return this.finishRecord(record, result);
      }
      if (this.callbacks.persistToolResult) {
        try {
          await this.runHostCallback('persist', request, controller, () => this.callbacks.persistToolResult!(result, { signal: controller.signal }));
        } catch (error) {
          if (error instanceof BridgeRuntimeError && error.code === 'hook-timeout') throw error;
          throw new BridgeRuntimeError('persistence-error', errorMessage(error));
        }
      }
      if (this.callbacks.continueModel) {
        try {
          await this.runHostCallback('model-continuation', request, controller, () => this.callbacks.continueModel!(result, { signal: controller.signal }));
        } catch (error) {
          if (error instanceof BridgeRuntimeError && error.code === 'hook-timeout') throw error;
          throw new BridgeRuntimeError('continuation-error', errorMessage(error));
        }
      }
      record.state = 'completed';
      return this.finishRecord(record, result);
    } catch (error) {
      const bridgeError = error instanceof BridgeRuntimeError ? error : new BridgeRuntimeError('transport-error', errorMessage(error));
      record.state = 'errored';
      return this.finishRecord(record, this.errorResult(request, bridgeError.code, bridgeError.message));
    }
  }

  private runHostCallback<T>(
    phase: ClaudeHostRelayPhase,
    request: Pick<ClaudeHostRelayEvent, 'requestId' | 'toolCallId'>,
    controller: AbortController,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    return this.relay.run(phase, request, () =>
      withAbortTimeout(Promise.resolve().then(callback), this.hookTimeoutMs, controller),
    );
  }

  private async waitForClientToolResult(request: z.infer<typeof claudeClientToolRequestSchema>, record: ClientCallRecord): Promise<ClaudeMcpToolResult> {
    const pendingResult = new Promise<ClaudeClientToolResult>(resolve => {
      // Timeout and close resolve a terminal protocol error so the deferred
      // cannot become an unhandled rejection after its race has settled.
      this.pendingClientTools.set(request.toolCallId, { request, resolve, settled: false });
    });
    const hostRequest = { requestId: request.requestId, toolCallId: request.toolCallId };
    await this.relay.run('client-tool-request', hostRequest, () => undefined);
    const clientController = new AbortController();
    let result: ClaudeClientToolResult;
    try {
      result = await withAbortTimeout(pendingResult, this.clientToolTimeoutMs, clientController, 'client-tool-timeout', 'client-tool result deadline elapsed');
    } catch (error) {
      const pending = this.pendingClientTools.get(request.toolCallId);
      if (pending) {
        pending.settled = true;
        pending.resolve({
          requestId: request.requestId,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          status: 'error',
          error: { code: 'client-tool-timeout', message: 'client-tool result deadline elapsed' },
        });
      }
      result = {
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        status: 'error',
        error: {
          code: error instanceof BridgeRuntimeError && error.code === 'client-tool-timeout' ? 'client-tool-timeout' : 'client-tool-disconnected',
          message: boundedMessage(errorMessage(error)),
        },
      };
    }
    return this.processClientToolResult(request, Promise.resolve(result), clientController, record);
  }

  private async processClientToolResult(
    request: z.infer<typeof claudeClientToolRequestSchema>,
    clientResult: Promise<ClaudeClientToolResult>,
    controller: AbortController,
    record: ClientCallRecord,
  ): Promise<ClaudeMcpToolResult> {
    try {
      let result: ClaudeClientToolResult;
      try {
        result = await clientResult;
      } catch (error) {
        const terminal = this.errorResult(request, 'client-tool-disconnected', errorMessage(error));
        return this.finishClientRecord(record, terminal);
      }

      const hostRequest = { requestId: request.requestId, toolCallId: request.toolCallId };
      let mcpResult: ClaudeMcpToolResult;
      if (result.status === 'success') {
        let serializedOutput: string;
        try {
          const encoded = JSON.stringify(result.output);
          if (typeof encoded !== 'string') return this.finishClientRecord(record, this.errorResult(request, 'invalid-request', 'client-tool output is not JSON serializable'));
          serializedOutput = encoded;
        } catch {
          return this.finishClientRecord(record, this.errorResult(request, 'invalid-request', 'client-tool output is not JSON serializable'));
        }
        if (serializedOutput.length > 128) return this.finishClientRecord(record, this.errorResult(request, 'invalid-request', 'client-tool output exceeds the fixture result bound'));
        mcpResult = {
          protocol: 'mcp',
          schemaVersion: 1,
          requestId: result.requestId,
          sessionId: result.sessionId,
          toolCallId: result.toolCallId,
          status: 'success',
          // The fixture MCP result has a deterministic string value.  Preserve
          // the client payload inside that bounded field so continuation and
          // persistence can observe the delayed result without widening the
          // MCP output schema used by the harmless tool.
          output: { value: serializedOutput, source: 'protocol-fixture' },
        };
      } else {
        mcpResult = {
          protocol: 'mcp',
          schemaVersion: 1,
          requestId: result.requestId,
          sessionId: result.sessionId,
          toolCallId: result.toolCallId,
          status: 'error',
          error: result.error,
        };
      }
      if (this.callbacks.processToolResult) {
        try {
          const processed = await this.runHostCallback('tool-result', hostRequest, controller, () =>
            this.callbacks.processToolResult!(
              { ...request, toolName: CLAUDE_FIXTURE_TOOL_NAME, input: { value: 'client-result', delayMs: 0 }, requiresApproval: false },
              mcpResult,
              { signal: controller.signal },
            ),
          );
          const parsedProcessed = claudeMcpToolResultSchema.parse(processed);
          if (parsedProcessed.requestId !== request.requestId || parsedProcessed.sessionId !== request.sessionId || parsedProcessed.toolCallId !== request.toolCallId) {
            return this.finishClientRecord(record, this.errorResult(request, 'result-processing-error', 'processed client-tool result correlation does not match the call'));
          }
          mcpResult = parsedProcessed;
        } catch (error) {
          return this.finishClientRecord(record, this.errorResult(request, error instanceof BridgeRuntimeError && error.code === 'hook-timeout' ? 'hook-timeout' : 'result-processing-error', errorMessage(error)));
        }
      }
      if (mcpResult.status === 'error') return this.finishClientRecord(record, mcpResult);
      if (mcpResult.status === 'success') {
        if (this.callbacks.persistToolResult) {
          try {
            await this.runHostCallback('persist', hostRequest, controller, () => this.callbacks.persistToolResult!(mcpResult, { signal: controller.signal }));
          } catch (error) {
            return this.finishClientRecord(record, this.errorResult(request, error instanceof BridgeRuntimeError && error.code === 'hook-timeout' ? 'hook-timeout' : 'persistence-error', errorMessage(error)));
          }
        }
        if (this.callbacks.continueModel) {
          try {
            await this.runHostCallback('model-continuation', hostRequest, controller, () => this.callbacks.continueModel!(mcpResult, { signal: controller.signal }));
          } catch (error) {
            return this.finishClientRecord(record, this.errorResult(request, error instanceof BridgeRuntimeError && error.code === 'hook-timeout' ? 'hook-timeout' : 'continuation-error', errorMessage(error)));
          }
        }
      }
      return this.finishClientRecord(record, mcpResult);
    } finally {
      // Keep a settled pending entry visible until result processing reaches a
      // terminal state. This makes snapshots internally consistent if the
      // host snapshots immediately after providing a result or closing.
      this.pendingClientTools.delete(request.toolCallId);
    }
  }

  private finishClientRecord(record: ClientCallRecord, result: ClaudeMcpToolResult): ClaudeMcpToolResult {
    record.result = result;
    record.state = result.status === 'success' ? 'completed' : 'errored';
    return result;
  }

  private finishRecord(record: ToolRecord, result: ClaudeMcpToolResult): ClaudeMcpToolResult {
    record.result = result;
    return result;
  }

  private errorResult(
    request: Pick<ParsedToolRequest, 'requestId' | 'sessionId' | 'toolCallId'>,
    code: ClaudeMcpToolError['code'],
    message: string,
  ): ClaudeMcpToolResult;
  private errorResult(
    request: Pick<z.infer<typeof claudeClientToolRequestSchema>, 'requestId' | 'sessionId' | 'toolCallId'>,
    code: ClaudeMcpToolError['code'],
    message: string,
  ): ClaudeMcpToolResult;
  private errorResult(
    request: Pick<{ requestId: string; sessionId: string; toolCallId: string }, 'requestId' | 'sessionId' | 'toolCallId'>,
    code: ClaudeMcpToolError['code'],
    message: string,
  ): ClaudeMcpToolResult {
    return {
      protocol: 'mcp',
      schemaVersion: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      status: 'error',
      error: { code, message: boundedMessage(message) },
    };
  }
}

export function createFixtureMcpTransport(): ClaudeMcpTransport {
  return async (request, context) => {
    if (context.signal.aborted) {
      return {
        protocol: 'mcp',
        schemaVersion: 1,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        status: 'error',
        error: { code: 'transport-error', message: 'MCP fixture call aborted' },
      };
    }
    const input = fixtureToolInputSchema.safeParse(request.input);
    if (!input.success) {
      return {
        protocol: 'mcp',
        schemaVersion: 1,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        status: 'error',
        error: { code: 'invalid-input', message: boundedMessage('fixture input failed schema validation') },
      };
    }
    if (input.data.delayMs > 0) await delay(input.data.delayMs);
    const output = fixtureToolOutputSchema.parse({ value: input.data.value, source: 'protocol-fixture' });
    return {
      protocol: 'mcp',
      schemaVersion: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      status: 'success',
      output,
    };
  };
}

class BridgeRuntimeError extends Error {
  readonly code: ClaudeMcpToolError['code'];

  constructor(code: ClaudeMcpToolError['code'], message: string) {
    super(message);
    this.name = 'BridgeRuntimeError';
    this.code = code;
  }
}

function boundedMessage(value: string): string {
  return value.length > MAX_MESSAGE_BYTES ? `${value.slice(0, MAX_MESSAGE_BYTES - 1)}…` : value;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CLIENT_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CLIENT_TOOL_TIMEOUT_MS) {
    throw new Error(`clientToolTimeoutMs must be an integer between 1 and ${MAX_CLIENT_TOOL_TIMEOUT_MS}`);
  }
  return value;
}

function boundedHookTimeout(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new Error('hookTimeoutMs must be an integer between 1 and 5000');
  }
  return value;
}

function boundedPendingClientTools(value: number | undefined): number {
  if (value === undefined) return MAX_PENDING_CLIENT_TOOLS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PENDING_CLIENT_TOOLS) {
    throw new Error(`maxPendingClientTools must be an integer between 1 and ${MAX_PENDING_CLIENT_TOOLS}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'tool bridge operation failed';
}

function toolRequestFingerprint(request: Pick<ParsedToolRequest, 'requestId' | 'sessionId' | 'toolName' | 'input' | 'requiresApproval'>): string {
  return JSON.stringify({
    sessionId: request.sessionId,
    requestId: request.requestId,
    toolName: request.toolName,
    input: request.input,
    requiresApproval: request.requiresApproval,
  });
}

function clientToolRequestFingerprint(request: Pick<z.infer<typeof claudeClientToolRequestSchema>, 'requestId' | 'sessionId' | 'toolName' | 'input' | 'requiresApproval'>): string {
  return JSON.stringify({
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolName: request.toolName,
    input: request.input,
    requiresApproval: request.requiresApproval,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withAbortTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  code: ClaudeMcpToolError['code'] = 'hook-timeout',
  message = 'host callback deadline elapsed',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const failure = new BridgeRuntimeError(code, message);
      controller.abort(failure);
      reject(failure);
    }, timeoutMs);
    timeout.unref();
    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
