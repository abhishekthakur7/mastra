import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeCancelCommand,
  buildClaudeForkCommand,
  buildClaudeProtocolCommand,
  buildClaudeResumeCommand,
  CLAUDE_PROTOCOL_EVIDENCE,
  ClaudeControlLedger,
  ClaudeJsonlProtocolParser,
  ClaudeProtocolError,
  parseClaudeJsonl,
  serializeClaudeControlFrame,
  spawnClaudeProtocolProcess,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
  type ClaudeProtocolCommand,
} from './claude-protocol';
import { BoundedResourceScope } from './process-cleanup';

const sessionId = 'fixture-session-001';
const profile = {
  executable: '/tmp/subscription-runtime/project/claude',
  argv: ['--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '/tmp/fixture-mcp.json', '--setting-sources', ''],
  cwd: '/tmp/subscription-runtime/project',
  env: { PATH: '/usr/bin', HOME: '/Users/fixture', TMPDIR: '/tmp/subscription-runtime/project/tmp' },
} as const;

function line(value: unknown, ending = '\n'): string {
  return `${JSON.stringify(value)}${ending}`;
}

function streamFrame(text = 'hello', id = sessionId) {
  return {
    type: 'stream_event',
    session_id: id,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

describe('offline Claude JSONL protocol fixture', () => {
  it('normalizes session, streaming, final, structured, and error fixtures without returning raw fields', () => {
    const input = [
      line({ type: 'system', subtype: 'init', session_id: sessionId, auth_token: 'fixture-secret' }),
      line(streamFrame('hel')),
      line(streamFrame('lo')),
      line({ type: 'result', subtype: 'success', session_id: sessionId, result: 'hello', usage: { input_tokens: 9 } }),
      line({ type: 'result', subtype: 'success', session_id: sessionId, structured_output: { answer: 'ok', accessToken: 'fixture-secret' } }),
      line({ type: 'result', subtype: 'error', session_id: sessionId, error: { code: 'quota', message: 'safe failure', secret: 'fixture-secret' } }),
    ].join('');

    const events = parseClaudeJsonl(input, { expectedSessionId: sessionId, secretValues: ['fixture-secret'] });

    expect(events).toEqual([
      { kind: 'session', subtype: 'init', sessionId, wireType: 'system', evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire },
      { kind: 'stream', sessionId, text: 'hel', wireType: 'stream_event', evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire },
      { kind: 'stream', sessionId, text: 'lo', wireType: 'stream_event', evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire },
      { kind: 'final', status: 'success', sessionId, text: 'hello', wireType: 'result', evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire },
      {
        kind: 'structured',
        status: 'success',
        sessionId,
        value: { answer: 'ok', '[REDACTED_KEY_1]': '[REDACTED]' },
        wireType: 'result',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
      },
      {
        kind: 'error',
        sessionId,
        code: 'quota',
        message: 'safe failure',
        wireType: 'result',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
    expect(JSON.stringify(events)).not.toContain('usage');
  });

  it('handles every chunk boundary and CRLF without changing normalized output', () => {
    const input = [line({ type: 'system', subtype: 'init', session_id: sessionId }, '\r\n'), line(streamFrame('chunk'), '\r\n')].join('');
    const expected = parseClaudeJsonl(input, { expectedSessionId: sessionId });
    for (let index = 1; index < input.length; index += 1) {
      const parser = new ClaudeJsonlProtocolParser({ expectedSessionId: sessionId });
      const actual = [...parser.push(input.slice(0, index)), ...parser.push(input.slice(index))];
      parser.end();
      expect(actual).toEqual(expected);
    }
  });

  it('excludes LF and CRLF terminators from the exact maxLineBytes boundary', () => {
    const frame = { type: 'system', subtype: 'init', session_id: sessionId };
    const content = JSON.stringify(frame);
    const contentBytes = Buffer.byteLength(content);

    for (const ending of ['\n', '\r\n']) {
      const input = `${content}${ending}`;
      const expected = parseClaudeJsonl(input, { expectedSessionId: sessionId, maxLineBytes: contentBytes });
      expect(expected).toHaveLength(1);

      // Exercise the terminator in one chunk and split at each byte boundary,
      // including between CR and LF for the CRLF form.
      for (let split = 0; split <= input.length; split += 1) {
        const parser = new ClaudeJsonlProtocolParser({ expectedSessionId: sessionId, maxLineBytes: contentBytes });
        const actual = [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))];
        parser.end();
        expect(actual).toEqual(expected);
      }
    }
  });

  it('rejects maxLineBytes plus one content byte across same and split chunks', () => {
    const frame = { type: 'system', subtype: 'init', session_id: sessionId, extra: 'x' };
    const content = JSON.stringify(frame);
    const maxLineBytes = Buffer.byteLength(content) - 1;

    for (const ending of ['\n', '\r\n']) {
      const input = `${content}${ending}`;
      for (let split = 0; split <= input.length; split += 1) {
        const parser = new ClaudeJsonlProtocolParser({ expectedSessionId: sessionId, maxLineBytes });
        let thrown: unknown;
        try {
          parser.push(input.slice(0, split));
          parser.push(input.slice(split));
          parser.end();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'line-limit', lineNumber: 1 });
      }
    }
  });

  it('counts a bare CR as content at the exact boundary and rejects max plus one', () => {
    const frame = { type: 'system', subtype: 'init', session_id: sessionId };
    const content = `${JSON.stringify(frame)}\r `;
    const input = `${content}\n`;
    const contentBytes = Buffer.byteLength(content);

    expect(parseClaudeJsonl(input, { expectedSessionId: sessionId, maxLineBytes: contentBytes })).toHaveLength(1);
    expect(() => parseClaudeJsonl(input, { expectedSessionId: sessionId, maxLineBytes: contentBytes - 1 })).toThrowError(
      expect.objectContaining({ code: 'line-limit', lineNumber: 1 }),
    );
  });

  it('supports UTF-8 byte chunks split across a multibyte character', () => {
    const bytes = new TextEncoder().encode(line(streamFrame('café')));
    const parser = new ClaudeJsonlProtocolParser({ expectedSessionId: sessionId });
    const split = bytes.findIndex((value, index) => index > 0 && (value & 0xc0) === 0x80);
    const actual = [...parser.push(bytes.slice(0, split)), ...parser.push(bytes.slice(split))];
    parser.end();
    expect(actual[0]).toMatchObject({ kind: 'stream', text: 'café' });
  });

  it('rejects invalid UTF-8 before attempting JSON parsing', () => {
    expect(() => parseClaudeJsonl(Uint8Array.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ code: 'invalid-utf8', lineNumber: 1, bytesReceived: 2 }),
    );
  });

  it('attributes invalid UTF-8 in one byte chunk to the actual line after valid input', () => {
    const firstLine = Buffer.from(line({ type: 'system', subtype: 'init', session_id: sessionId }, '\r\n'));
    const invalidLine = Uint8Array.from([0x7b, 0xff, 0x0a]);
    const input = Uint8Array.from([...firstLine, ...invalidLine]);

    expect(() => parseClaudeJsonl(input, { expectedSessionId: sessionId })).toThrowError(
      expect.objectContaining({ code: 'invalid-utf8', lineNumber: 2, bytesReceived: input.byteLength }),
    );
  });

  it('preserves line diagnostics across CRLF and a chunk boundary before invalid UTF-8', () => {
    const firstLine = Buffer.from(line({ type: 'system', subtype: 'init', session_id: sessionId }, '\r\n'));
    const invalidLine = Uint8Array.from([0x7b, 0xff, 0x0a]);
    const parser = new ClaudeJsonlProtocolParser({ expectedSessionId: sessionId });
    parser.push(firstLine);

    expect(() => parser.push(invalidLine)).toThrowError(
      expect.objectContaining({ code: 'invalid-utf8', lineNumber: 2, bytesReceived: firstLine.byteLength + invalidLine.byteLength }),
    );
  });

  it('attaches bounded line and received-byte context to nested validation failures', () => {
    const input = `${line({ type: 'system', subtype: 'init', session_id: sessionId })}${line({ type: 'stream_event', event: { type: 'content_block_delta' } })}`;
    expect(() => parseClaudeJsonl(input, { expectedSessionId: sessionId })).toThrowError(
      expect.objectContaining({ code: 'malformed-frame', lineNumber: 2, bytesReceived: Buffer.byteLength(input) }),
    );

    const partial = '{"type":"stream_event"';
    const parser = new ClaudeJsonlProtocolParser();
    parser.push(partial);
    expect(() => parser.end()).toThrowError(
      expect.objectContaining({ code: 'partial-eof', lineNumber: 1, bytesReceived: Buffer.byteLength(partial) }),
    );
  });

  it('rejects a partial EOF even when the partial frame is otherwise valid JSON prefix', () => {
    const parser = new ClaudeJsonlProtocolParser();
    parser.push(JSON.stringify(streamFrame('partial')));
    expect(() => parser.end()).toThrowError(ClaudeProtocolError);
    try {
      parser.end();
    } catch (error) {
      expect(error).toMatchObject({ code: 'parser-closed' });
    }
    const fresh = new ClaudeJsonlProtocolParser();
    fresh.push('{"type":"stream_event"');
    expect(() => fresh.end()).toThrowError(expect.objectContaining({ code: 'partial-eof' }));
  });

  it('enforces total byte, line, compact frame, and frame-count limits', () => {
    expect(() => parseClaudeJsonl(line(streamFrame('12345')), { maxBytes: 5 })).toThrowError(expect.objectContaining({ code: 'byte-limit' }));
    expect(() => parseClaudeJsonl(line(streamFrame('12345')), { maxLineBytes: 10 })).toThrowError(expect.objectContaining({ code: 'line-limit' }));
    const spaced = `{ "type": "stream_event", "session_id": "${sessionId}", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "x" } } }\n`;
    const compact = JSON.stringify(JSON.parse(spaced));
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(spaced));
    expect(() => parseClaudeJsonl(spaced, { maxLineBytes: 1_000, maxFrameBytes: Buffer.byteLength(compact) - 1 })).toThrowError(
      expect.objectContaining({ code: 'frame-limit' }),
    );
    expect(() => parseClaudeJsonl(`${line(streamFrame('a'))}${line(streamFrame('b'))}`, { maxFrames: 1 })).toThrowError(
      expect.objectContaining({ code: 'frame-count-limit' }),
    );
  });

  it('attributes a same-chunk byte-limit overflow after a complete line to the next line', () => {
    const firstLine = line({ type: 'system', subtype: 'init', session_id: sessionId });
    const input = `${firstLine}{x`;
    const maxBytes = Buffer.byteLength(firstLine) + 1;

    expect(() => parseClaudeJsonl(input, { expectedSessionId: sessionId, maxBytes })).toThrowError(
      expect.objectContaining({ code: 'byte-limit', lineNumber: 2, bytesReceived: maxBytes }),
    );
  });

  it.each([
    ['malformed JSON', '{"type":\n', 'malformed-json'],
    ['non-object array', '[]\n', 'non-object'],
    ['non-object string', '"text"\n', 'non-object'],
    ['unknown event', line({ type: 'made_up', session_id: sessionId }), 'unsupported-frame'],
    ['unknown stream subtype', line({ ...streamFrame(), event: { type: 'unknown', delta: {} } }), 'unsupported-frame'],
    ['missing final output', line({ type: 'result', subtype: 'success', session_id: sessionId }), 'malformed-frame'],
  ])('rejects %s', (_label, input, code) => {
    expect(() => parseClaudeJsonl(input, { expectedSessionId: sessionId })).toThrowError(expect.objectContaining({ code }));
  });

  it('requires explicit session IDs and rejects cross-session frames', () => {
    expect(() => parseClaudeJsonl(line({ type: 'result', subtype: 'success', result: 'missing id' }), { requireSessionId: true })).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
    expect(() => parseClaudeJsonl(line(streamFrame('wrong', 'other-session')), { expectedSessionId: sessionId })).toThrowError(
      expect.objectContaining({ code: 'session-mismatch' }),
    );
  });

  it('retains text when a result also includes structured output', () => {
    const [event] = parseClaudeJsonl(
      line({ type: 'result', subtype: 'success', session_id: sessionId, result: 'text answer', structured_output: { answer: 'structured answer' } }),
      { expectedSessionId: sessionId },
    );
    expect(event).toMatchObject({ kind: 'final', status: 'success', text: 'text answer', structuredOutput: { answer: 'structured answer' } });
  });

  it('normalizes the SDK result error subtypes without retaining raw error metadata', () => {
    const [event] = parseClaudeJsonl(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: sessionId,
        is_error: true,
        errors: ['provider detail with secret-token'],
        terminal_reason: 'aborted_streaming',
        usage: { input_tokens: 1 },
      }),
      { expectedSessionId: sessionId, secretValues: ['secret-token'] },
    );
    expect(event).toMatchObject({ kind: 'error', code: 'error_during_execution', message: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(event)).not.toContain('secret-token');
    expect(() =>
      parseClaudeJsonl(line({ type: 'result', subtype: 'error_max_turns', session_id: sessionId, is_error: false, errors: [] }), { expectedSessionId: sessionId }),
    ).toThrowError(expect.objectContaining({ code: 'malformed-frame' }));
  });

  it('validates and normalizes bidirectional control request/response fixtures', () => {
    const input = [
      line({ type: 'control_request', session_id: sessionId, request_id: 'request-1', request: { subtype: 'interrupt' } }),
      line({
        type: 'control_request',
        session_id: sessionId,
        request_id: 'request-2',
        request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-1', input: { value: 'safe' } },
      }),
      line({
        type: 'control_request',
        session_id: sessionId,
        request_id: 'request-3',
        request: { subtype: 'hook_callback', callback_id: 'callback-1', event: 'PreToolUse', payload: { value: 'safe' } },
      }),
      line({ type: 'control_response', session_id: sessionId, request_id: 'request-1', response: { subtype: 'cancelled', message: 'stopped' } }),
    ].join('');
    expect(parseClaudeJsonl(input, { expectedSessionId: sessionId })).toMatchObject([
      { kind: 'control-request', subtype: 'interrupt', requestId: 'request-1' },
      { kind: 'control-request', subtype: 'can_use_tool', requestId: 'request-2', toolName: 'fixtureTool', input: { value: 'safe' } },
      { kind: 'control-request', subtype: 'hook_callback', requestId: 'request-3', callbackId: 'callback-1', event: 'PreToolUse' },
      { kind: 'control-response', subtype: 'cancelled', requestId: 'request-1', message: 'stopped' },
    ]);

    const serialized = serializeClaudeControlFrame(
      {
        type: 'control_request',
        session_id: sessionId,
        request_id: 'request-safe',
        request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-safe', input: { accessToken: 'fixture-secret', value: 'safe' } },
        raw: 'not-allowed',
      } as unknown as ClaudeControlRequest,
      { secretValues: ['fixture-secret'] },
    );
    expect(JSON.parse(serialized)).toEqual({
      type: 'control_request',
      session_id: sessionId,
      request_id: 'request-safe',
      request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-safe', input: { '[REDACTED_KEY_1]': '[REDACTED]', value: 'safe' } },
    });
    expect(serialized).not.toContain('not-allowed');
  });

  it('correlates controls with a bounded ledger and normalizes approval outcomes', () => {
    const ledger = new ClaudeControlLedger({ expectedSessionId: sessionId, maxPending: 2 });
    const input = [
      line({ type: 'control_request', session_id: sessionId, request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-approval', input: { value: 'safe' } } }),
      line({
        type: 'control_response',
        session_id: sessionId,
        request_id: 'approval-1',
        response: { subtype: 'success', response: { behavior: 'allow', toolUseID: 'tool-approval', updatedInput: { value: 'changed' } } },
      }),
    ].join('');

    const events = parseClaudeJsonl(input, { expectedSessionId: sessionId, controlLedger: ledger });
    expect(events).toHaveLength(2);
    expect(ledger.get('approval-1')).toEqual({
      requestId: 'approval-1',
      sessionId,
      requestSubtype: 'can_use_tool',
      toolUseId: 'tool-approval',
      state: 'approved',
      outcome: { kind: 'approval', status: 'approved', updatedInput: { value: 'changed' } },
    });
    expect(ledger.pendingCount).toBe(0);
  });

  it('fails closed for duplicate, unknown, and late control IDs', () => {
    const ledger = new ClaudeControlLedger();
    const request = {
      kind: 'control-request' as const,
      requestId: 'request-1',
      subtype: 'interrupt' as const,
      wireType: 'control_request',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
    const response = {
      kind: 'control-response' as const,
      requestId: 'request-1',
      subtype: 'cancelled' as const,
      wireType: 'control_response',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
    ledger.apply(request);
    expect(() => ledger.apply(request)).toThrowError(expect.objectContaining({ code: 'duplicate-request', requestId: 'request-1' }));
    expect(() => ledger.apply({ ...response, requestId: 'missing' })).toThrowError(expect.objectContaining({ code: 'unknown-response' }));
    ledger.apply(response);
    expect(() => ledger.apply(response)).toThrowError(expect.objectContaining({ code: 'late-response' }));
  });

  it('fails closed for malformed interrupt responses and cross-session responses', () => {
    const ledger = new ClaudeControlLedger();
    ledger.apply({
      kind: 'control-request',
      requestId: 'interrupt-1',
      subtype: 'interrupt',
      sessionId: 'session-a',
      wireType: 'control_request',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    });

    expect(() =>
      ledger.apply({
        kind: 'control-response',
        requestId: 'interrupt-1',
        subtype: 'success',
        response: { status: 'unknown' },
        sessionId: 'session-a',
        wireType: 'control_response',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-response', requestId: 'interrupt-1' }));

    expect(() =>
      ledger.apply({
        kind: 'control-response',
        requestId: 'interrupt-1',
        subtype: 'success',
        response: { status: 'cancelled' },
        sessionId: 'session-b',
        wireType: 'control_response',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
      }),
    ).toThrowError(expect.objectContaining({ code: 'session-mismatch', requestId: 'interrupt-1' }));

    expect(() =>
      ledger.apply({
        kind: 'control-response',
        requestId: 'interrupt-1',
        subtype: 'success',
        response: { status: 'cancelled' },
        sessionId: undefined,
        wireType: 'control_response',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
      }),
    ).toThrowError(expect.objectContaining({ code: 'session-mismatch', requestId: 'interrupt-1' }));
  });

  it('normalizes control_cancel_request and interrupt cancellation statuses', () => {
    const ledger = new ClaudeControlLedger();
    const request = {
      kind: 'control-request' as const,
      requestId: 'hook-1',
      subtype: 'hook_callback' as const,
      callbackId: 'callback-1',
      event: 'PreToolUse',
      payload: { value: 'safe' },
      wireType: 'control_request',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    };
    ledger.apply(request);
    const cancelled = ledger.apply({
      kind: 'control-cancel-request',
      requestId: 'hook-1',
      wireType: 'control_cancel_request',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    });
    expect(cancelled).toMatchObject({ state: 'cancelled', outcome: { kind: 'cancellation', status: 'cancelled' } });
    expect(() =>
      ledger.apply({
        kind: 'control-cancel-request',
        requestId: 'hook-1',
        wireType: 'control_cancel_request',
        evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
      }),
    ).toThrowError(expect.objectContaining({ code: 'late-cancel' }));

    const interruptLedger = new ClaudeControlLedger();
    interruptLedger.apply({ ...request, requestId: 'interrupt-1', subtype: 'interrupt', callbackId: undefined, event: undefined, payload: undefined });
    const stillQueued = interruptLedger.apply({
      kind: 'control-response',
      requestId: 'interrupt-1',
      subtype: 'success',
      response: { status: 'still_queued' },
      wireType: 'control_response',
      evidence: CLAUDE_PROTOCOL_EVIDENCE.controlWire,
    });
    expect(stillQueued).toMatchObject({ state: 'cancelled', outcome: { kind: 'cancellation', status: 'still_queued' } });
  });

  it('parses control_cancel_request and rejects an invalid approval through the ledger', () => {
    const ledger = new ClaudeControlLedger();
    const input = [
      line({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-invalid', input: { value: 'safe' } } }),
      line({ type: 'control_response', request_id: 'r', response: { subtype: 'success', response: { unexpected: true } } }),
    ].join('');
    expect(() => parseClaudeJsonl(input, { controlLedger: ledger })).toThrowError(
      expect.objectContaining({ code: 'control-correlation', lineNumber: 2, bytesReceived: Buffer.byteLength(input) }),
    );

    const cancel = parseClaudeJsonl(line({ type: 'control_cancel_request', request_id: 'r' }));
    expect(cancel[0]).toMatchObject({ kind: 'control-cancel-request', requestId: 'r' });
    expect(serializeClaudeControlFrame({ type: 'control_cancel_request', request_id: 'r' })).toBe(
      '{"type":"control_cancel_request","request_id":"r"}\n',
    );
  });

  it('serializes SDK permission responses with camelCase toolUseID and rejects snake_case aliases', () => {
    const serialized = serializeClaudeControlFrame({
      type: 'control_response',
      request_id: 'permission-1',
      response: { subtype: 'success', response: { behavior: 'allow', toolUseID: 'tool-1', updatedInput: { value: 'safe' } } },
    });
    expect(JSON.parse(serialized)).toMatchObject({
      response: { response: { behavior: 'allow', toolUseID: 'tool-1', updatedInput: { value: 'safe' } } },
    });
    expect(serialized).not.toContain('tool_use_id');
    expect(() =>
      serializeClaudeControlFrame({
        type: 'control_response',
        request_id: 'permission-2',
        response: { subtype: 'success', response: { behavior: 'allow', tool_use_id: 'tool-1' } },
      } as unknown as ClaudeControlResponse),
    ).toThrow(/unknown field/);
  });

  it('bounds pending SDK control arrays and returns only their counts', () => {
    const pendingPermission = {
      type: 'control_request',
      request_id: 'pending-permission',
      request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-pending', input: { value: 'safe', token: 'secret' } },
    };
    const [event] = parseClaudeJsonl(
      line({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: { commands: [] }, pending_permission_requests: [pendingPermission] } }),
    );
    expect(event).toMatchObject({ kind: 'control-response', pendingPermissionCount: 1 });
    expect(JSON.stringify(event)).not.toContain('pending-permission');
    expect(() => parseClaudeJsonl(line({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: {}, pending_permission_requests: [{ ...pendingPermission, request: { subtype: 'unknown' } }] } }))).toThrow(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
    expect(() => parseClaudeJsonl(line({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: {}, pending_user_dialog_requests: Array.from({ length: 65 }, () => pendingPermission) } }))).toThrow(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
  });

  it.each([
    ['missing request id', { type: 'control_request', request: { subtype: 'interrupt' } }],
    ['unknown request subtype', { type: 'control_request', request_id: 'r', request: { subtype: 'allow' } }],
    ['interrupt extra field', { type: 'control_request', request_id: 'r', request: { subtype: 'interrupt', input: {} } }],
    ['missing tool input', { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'fixtureTool' } }],
    ['missing response object', { type: 'control_response', request_id: 'r' }],
  ])('rejects malformed control frame: %s', (_label, frame) => {
    expect(() => parseClaudeJsonl(line(frame))).toThrowError(ClaudeProtocolError);
  });

  it('bounds JSON structure before redaction and does not include raw unknown fields', () => {
    const huge = { type: 'result', subtype: 'success', session_id: sessionId, structured_output: { value: 'x'.repeat(50) } };
    expect(() => parseClaudeJsonl(line(huge), { maxStringLength: 16 })).toThrowError(expect.objectContaining({ code: 'frame-limit' }));
    const unknown = { type: 'error', session_id: sessionId, error: { code: 'safe', message: 'safe', nested_secret: 'do-not-return' }, raw: 'do-not-return' };
    const result = parseClaudeJsonl(line(unknown), { expectedSessionId: sessionId });
    expect(result).toEqual([
      { kind: 'error', sessionId, code: 'safe', message: 'safe', wireType: 'error', evidence: CLAUDE_PROTOCOL_EVIDENCE.eventWire },
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('enforces depth, node, and object-key bounds independently of physical frame size', () => {
    const nested: Record<string, unknown> = { value: 'x' };
    let current = nested;
    for (let index = 0; index < 6; index += 1) {
      current.child = { value: 'x' };
      current = current.child as Record<string, unknown>;
    }
    expect(() => parseClaudeJsonl(line({ type: 'error', session_id: sessionId, error: { code: 'x', message: 'x', details: nested } }), { maxJsonDepth: 2 })).toThrowError(
      expect.objectContaining({ code: 'frame-limit' }),
    );
    expect(() => parseClaudeJsonl(line({ type: 'error', session_id: sessionId, error: { code: 'x', message: 'x', details: ['a', 'b', 'c'] } }), { maxJsonNodes: 5 })).toThrowError(
      expect.objectContaining({ code: 'frame-limit' }),
    );
    expect(() => parseClaudeJsonl(line({ type: 'error', session_id: sessionId, error: { code: 'x', message: 'x', a: 1, b: 2, c: 3 } }), { maxJsonKeys: 3 })).toThrowError(
      expect.objectContaining({ code: 'frame-limit' }),
    );
  });

  it('accepts every bounded JsonValue as structured output, including arrays and scalars', () => {
    for (const value of [null, true, 42, 'answer', ['a', { ok: true }]]) {
      const [event] = parseClaudeJsonl(line({ type: 'result', subtype: 'success', session_id: sessionId, structured_output: value }), {
        expectedSessionId: sessionId,
      });
      expect(event).toMatchObject({ kind: 'structured', status: 'success', value });
    }
  });

  it('constructs explicit start, resume, fork, and cancel commands with classification metadata', () => {
    const start = buildClaudeProtocolCommand({ profile, sessionId, prompt: 'hello' });
    expect(start).toMatchObject({ action: 'start', executable: profile.executable, cwd: profile.cwd });
    expect(start.argv).not.toContain('--model');
    expect(start.argv).toContain('-p');
    expect(start.argv.slice(0, profile.argv.length)).toEqual(profile.argv);
    expect(start.argv).toEqual([
      ...profile.argv,
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--session-id',
      sessionId,
    ]);
    expect(start.evidence).toEqual({
      streamJson: 'public-documentation',
      sessionControl: 'public-documentation',
      eventWire: 'version-bound-experiment',
    });

    expect(buildClaudeResumeCommand({ profile, sessionId, maxTurns: 1 })).toMatchObject({
      action: 'resume',
      argv: [...profile.argv, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose', '--resume', sessionId, '--max-turns', '1'],
    });
    expect(buildClaudeForkCommand({ profile, sourceSessionId: sessionId, sessionId: 'fixture-fork-002' })).toMatchObject({
      action: 'fork',
      argv: expect.arrayContaining(['--session-id', 'fixture-fork-002', '--resume', sessionId, '--fork-session']),
    });
    expect(() => buildClaudeProtocolCommand({ profile, fork: true })).toThrow(/resumeSessionId/);

    const cancel = buildClaudeCancelCommand({ sessionId, requestId: 'request-4' });
    expect(cancel).toMatchObject({ action: 'cancel', sessionId, requestId: 'request-4', evidence: 'version-bound-experiment' });
    expect(cancel.frame).not.toHaveProperty('session_id');
    expect(JSON.parse(cancel.jsonl)).toEqual({ type: 'control_request', request_id: 'request-4', request: { subtype: 'interrupt' } });
    expect(cancel.jsonl).toBe(`${JSON.stringify(cancel.frame)}\n`);
    expect(serializeClaudeControlFrame(cancel.frame)).toBe(cancel.jsonl);
  });

  it('rejects duplicate/implicit session controls and invalid command identities', () => {
    expect(() => buildClaudeProtocolCommand({ profile: { ...profile, argv: [...profile.argv, '--continue'] } })).toThrow(/session controls/);
    expect(() => buildClaudeProtocolCommand({ profile: { ...profile, executable: 'claude' } })).toThrow(/absolute executable/);
    expect(() => buildClaudeCancelCommand({ sessionId: '', requestId: 'r' })).toThrow(/invalid/);
  });

  it('rejects ambiguous resume/fork session identities', () => {
    expect(() => buildClaudeProtocolCommand({ profile, sessionId, resumeSessionId: 'fixture-source-002' })).toThrow(/unless fork is true/);
    expect(() => buildClaudeProtocolCommand({ profile, fork: true, sessionId, resumeSessionId: sessionId })).toThrow(/distinct source and target/);
  });

  it('rejects equals-form and split profile session controls, and requires a fork target', () => {
    for (const argv of [
      [...profile.argv, '--resume=old'],
      [...profile.argv, '--session-id', 'old'],
      [...profile.argv, '--fork-session=true'],
      [...profile.argv, '--continue', 'true'],
    ]) {
      expect(() => buildClaudeProtocolCommand({ profile: { ...profile, argv } })).toThrow(/session controls/);
    }
    expect(() => buildClaudeProtocolCommand({ profile, fork: true, resumeSessionId: sessionId })).toThrow(/target sessionId/);
  });

  it('bounds and emits an explicit per-turn max-turns option for the live MCP fixture', () => {
    const command = buildClaudeProtocolCommand({ profile, sessionId, prompt: 'hello', maxTurns: 2 });
    expect(command.argv.slice(-4)).toEqual(['--session-id', sessionId, '--max-turns', '2']);
    expect(() => buildClaudeProtocolCommand({ profile, sessionId, prompt: 'hello', maxTurns: 0 })).toThrow(/maxTurns/);
    expect(() => buildClaudeProtocolCommand({ profile, sessionId, prompt: 'hello', maxTurns: 17 })).toThrow(/maxTurns/);
  });

  it('uses print mode for stream-json but never puts a positional prompt on the child command', () => {
    const command = buildClaudeProtocolCommand({ profile, sessionId, prompt: 'hello', maxTurns: 1 });
    expect(command.argv).toContain('-p');
    expect(command.argv).not.toContain('hello');
    expect(command.argv.slice(-2)).toEqual(['--max-turns', '1']);
    expect(command.argv.filter(value => value === 'hello')).toHaveLength(0);
  });

  it('bounds schema keys, strings, finite numbers, and serialized bytes before spawning', () => {
    expect(() => buildClaudeProtocolCommand({ profile, jsonSchema: { ['k'.repeat(257)]: true } })).toThrow(/object key/);
    expect(() => buildClaudeProtocolCommand({ profile, jsonSchema: Number.NaN })).toThrow(/non-finite/);
    expect(() => buildClaudeProtocolCommand({ profile, jsonSchema: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    const oversized = Object.fromEntries(Array.from({ length: 8 }, (_unused, index) => [`key${index}`, 'x'.repeat(8_190)]));
    expect(() => buildClaudeProtocolCommand({ profile, jsonSchema: oversized })).toThrow(/serialized byte/);
  });

  it('starts protocol children only through the bounded resource scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mastra-protocol-process-'));
    const scope = new BoundedResourceScope({ graceMs: 50, forceKillMs: 100 });
    try {
      const command: ClaudeProtocolCommand = {
        kind: 'turn',
        action: 'start',
        executable: process.execPath,
        argv: ['-e', 'process.stdout.write("fixture-child");'],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        evidence: { streamJson: 'public-documentation', sessionControl: 'public-documentation', eventWire: 'version-bound-experiment' },
      };
      const owned = spawnClaudeProtocolProcess(scope, command);
      expect(owned.ownership).toBe('bounded-resource-scope-process-group');
      await once(owned.child, 'close');
      const cleanup = await scope.cleanup();
      expect(cleanup.remainingPaths).toEqual([]);
      expect(cleanup.closeErrors).toEqual([]);
      expect(cleanup.processes).toEqual([expect.objectContaining({ pid: expect.any(Number), exited: true })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
