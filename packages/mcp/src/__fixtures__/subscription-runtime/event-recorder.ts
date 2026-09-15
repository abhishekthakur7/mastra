import { FixtureRedactor, type FixtureRedactorOptions } from './redactor';
import type { FixtureEvent } from './types';

const DEFAULT_MAX_EVENTS = 100;
const SAFE_LABEL = /^[a-z][a-z0-9-]{0,63}$/i;
const DECISIONS = new Set(['allow', 'deny', 'modify']);
const ALLOWED_EVENT_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  'mcp-fixture': new Set(['tool-call', 'tool-result']),
  'hook-relay': new Set(['request', 'decision', 'timeout', 'error']),
};

export type FixtureEventRecorderOptions = FixtureRedactorOptions & {
  maxEvents?: number;
};

export class FixtureEventRecorder {
  private readonly redactor: FixtureRedactor;
  private readonly maxEvents: number;
  private readonly recordedEvents: FixtureEvent[] = [];
  private droppedEvents = 0;

  constructor(options: FixtureEventRecorderOptions = {}) {
    this.redactor = new FixtureRedactor(options);
    this.maxEvents = boundedMaxEvents(options.maxEvents);
  }

  record(source: string, type: string, payload?: unknown): FixtureEvent {
    // Check capacity before touching the event payload. Rejected events must
    // not cause arbitrary payload getters, proxies, or iterables to run.
    if (this.recordedEvents.length >= this.maxEvents) {
      this.droppedEvents += 1;
      return {
        sequence: this.maxEvents,
        source: 'event-recorder',
        type: 'limit',
        payload: { maxEvents: this.maxEvents },
      };
    }

    const safeSource = safeLabel(source);
    const safeType = safeLabel(type);
    const allowlisted = isAllowlistedEvent(safeSource, safeType);
    const event: FixtureEvent = {
      sequence: this.recordedEvents.length,
      source: safeSource,
      type: safeType,
      ...(payload === undefined
        ? {}
        : { payload: allowlisted ? this.sanitizePayload(safeSource, safeType, payload) : '[Omitted]' }),
    };

    this.recordedEvents.push(event);
    return event;
  }

  get events(): readonly FixtureEvent[] {
    // Return an independent snapshot so callers cannot mutate nested redacted
    // payloads stored by the recorder.
    return structuredClone(this.recordedEvents);
  }

  get droppedEventCount(): number {
    return this.droppedEvents;
  }

  clear(): void {
    this.recordedEvents.length = 0;
    this.droppedEvents = 0;
  }

  private sanitizePayload(source: string, type: string, payload: unknown): unknown {
    // Event shapes are deliberately allowlisted. Unknown event kinds do not
    // get a generic object dump, even when their values look harmless.
    if (source === 'mcp-fixture' && type === 'tool-call') {
      const value = asRecord(payload);
      return {
        toolId: value?.toolId === 'subscription_fixture_echo' ? value.toolId : '[Omitted]',
        ...(value && 'input' in value ? { input: this.redactor.redact(value.input) } : {}),
      };
    }
    if (source === 'mcp-fixture' && type === 'tool-result') {
      const value = asRecord(payload);
      return {
        ...(value && 'value' in value ? { value: this.redactor.redact(value.value) } : {}),
        source: value?.source === 'protocol-fixture' ? value.source : '[Omitted]',
      };
    }
    if (source === 'hook-relay' && type === 'request') {
      const value = asRecord(payload);
      return {
        ...(typeof value?.event === 'string' ? { event: this.redactor.redact(value.event) } : {}),
        ...(value && 'payload' in value ? { payload: this.redactor.redact(value.payload) } : {}),
      };
    }
    if (source === 'hook-relay' && type === 'decision') {
      const value = asRecord(payload);
      return {
        decision: DECISIONS.has(String(value?.decision)) ? value?.decision : '[Omitted]',
        ...(value && 'reason' in value ? { reason: this.redactor.redact(value.reason) } : {}),
        ...(value && 'input' in value ? { input: this.redactor.redact(value.input) } : {}),
        ...(value && 'context' in value ? { context: this.redactor.redact(value.context) } : {}),
      };
    }
    if (source === 'hook-relay' && (type === 'timeout' || type === 'error')) {
      return { message: type === 'timeout' ? 'hook relay timeout' : 'hook handler failed' };
    }
    return '[Omitted]';
  }
}

function isAllowlistedEvent(source: string, type: string): boolean {
  return ALLOWED_EVENT_TYPES[source]?.has(type) ?? false;
}

function safeLabel(value: string): string {
  return typeof value === 'string' && SAFE_LABEL.test(value) ? value : '[Omitted]';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedMaxEvents(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('maxEvents must be an integer between 1 and 10000');
  }
  return value;
}
