import { describe, expect, it } from 'vitest';

import { ClaudeLiveWireAdapter, ClaudeLiveWireError, hashClaudeLiveId } from './claude-live-wire';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function streamLifecycle(text: string, session = sessionId, options: { readonly thinking?: boolean } = {}): string {
  const thinking = options.thinking === true
    ? line({ type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } }) +
      line({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning', estimated_tokens: null } } }) +
      line({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-signature' } } }) +
      line({ type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: 0 } })
    : '';
  return line({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [] } } }) +
    thinking +
    line({ type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: options.thinking ? 1 : 0, content_block: { type: 'text', text: '' } } }) +
    line({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: options.thinking ? 1 : 0, delta: { type: 'text_delta', text } } }) +
    line({ type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: options.thinking ? 1 : 0 } }) +
    line({ type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } }) +
    line({ type: 'stream_event', session_id: session, event: { type: 'message_stop' } });
}

const sessionId = '00000000-0000-4000-8000-000000000001';
const initializeResponse = { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} };
const canonicalInitializeResponse = {
  commands: [{ name: 'deep-research', description: 'bounded command description', argumentHint: '' }],
  agents: [{ name: 'general-purpose', description: 'bounded agent description', model: 'inherit' }],
  output_style: 'default',
  available_output_styles: ['default', 'Concise'],
  user_output_styles_dir: '/Users/example/.claude/output-styles',
  models: [{
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default',
    description: 'bounded model description',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  }],
  account: { email: 'redacted@example.test', organization: 'bounded', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
  pid: 12345,
  current_permission_mode: 'default',
  analytics_disabled: false,
  remote_control_auto_enable: true,
  remote_control_auto_connect_default: true,
  remote_control_available: true,
  remote_control_auto_on_by_default: true,
  ide_rc_auto_enable_gate: true,
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  session_state: 'idle',
};
const hashSessionId = hashClaudeLiveId;

describe('Claude live-wire adapter', () => {
  it('records markers only for the observed text/final stream', () => {
    const adapter = new ClaudeLiveWireAdapter();
    const events = adapter.push(
      line({ type: 'system', subtype: 'init', session_id: sessionId }) +
        streamLifecycle('secret model text', sessionId, { thinking: true }) +
        line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'secret model text' }] } }) +
        line({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'secret model text' }),
    );
    adapter.end();
    expect(events.map(event => event.kind)).toEqual([
      'session-init',
      'telemetry', 'telemetry', 'telemetry', 'telemetry', 'telemetry', 'telemetry',
      'stream-delta',
      'telemetry', 'telemetry', 'telemetry',
      'assistant-message', 'final-success',
    ]);
    expect(JSON.stringify(events)).not.toContain('secret model text');
    expect(events[0]).toMatchObject({ sessionIdHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it('marks structured output without retaining the value', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedStructuredOutput: { shape: 'object', field: 'probe', marker: 'LIVE_STRUCTURED_OK' } });
    const events = adapter.push(line({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, structured_output: { probe: 'LIVE_STRUCTURED_OK' } }));
    adapter.end();
    expect(events).toEqual([
      expect.objectContaining({ kind: 'final-structured', wireType: 'result', sessionIdHash: expect.any(String), label: 'structured-valid', structuredShape: 'object{probe:string}', structuredMarkerSeen: true }),
    ]);
    expect(JSON.stringify(events)).not.toContain('LIVE_STRUCTURED_OK');
  });

  it('requires an explicit false is_error on successful results', () => {
    const missing = new ClaudeLiveWireAdapter();
    expect(() => missing.push(line({ type: 'result', session_id: sessionId, subtype: 'success', result: 'ok' }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
    const truthy = new ClaudeLiveWireAdapter();
    expect(() => truthy.push(line({ type: 'result', session_id: sessionId, subtype: 'success', is_error: true, result: 'ok' }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
  });

  it('validates standalone error envelopes and never labels them as cancellation', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    const events = adapter.push(
      line({ type: 'error', session_id: sessionId, error: { code: 'provider-failure', message: 'bounded failure', retryable: false } }),
      );
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'final-error', wireType: 'error', label: 'standalone-error' });
    expect(JSON.stringify(events)).not.toContain('bounded failure');

    for (const error of [
      { type: 'error', session_id: sessionId },
      { type: 'error', session_id: sessionId, error: { message: 'ok', extra: 'not admitted' } },
      { type: 'error', session_id: sessionId, error: { code: 'bad code!', message: 'ok' } },
      { type: 'error', session_id: sessionId, error: { code: 'x', message: '' } },
      { type: 'error', session_id: sessionId, error: { code: 'x', message: 'ok', retryable: 'yes' } },
      { type: 'error', session_id: sessionId, error: 'x'.repeat(8_193) },
      { type: 'error', session_id: sessionId, extra: 'not admitted', error: 'ok' },
    ]) {
      const invalid = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
      expect(() => invalid.push(line(error))).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^(malformed-frame|frame-limit)$/) }));
    }
  });

  it('exposes only bounded control metadata to the handler', () => {
    const requests: unknown[] = [];
    const adapter = new ClaudeLiveWireAdapter({
      expectedToolName: 'subscription_fixture_echo',
      expectedToolInput: { value: 'LIVE_TOOL_OK', delayMs: 0 },
      onControlRequest: request => {
        requests.push(request);
        adapter.acknowledgeControlResponse(request.requestId, request.sessionId);
      },
    });
    const events = adapter.push(
      line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'subscription_fixture_echo', input: { value: 'LIVE_TOOL_OK', delayMs: 0 } }] } }) +
      line({
        type: 'control_request',
        session_id: sessionId,
        request_id: 'request-1',
        request: { subtype: 'can_use_tool', tool_name: 'subscription_fixture_echo', tool_use_id: 'tool-1', input: { value: 'LIVE_TOOL_OK', delayMs: 0 } },
      }),
    );
    adapter.end();
    expect(events[1]).toMatchObject({ kind: 'control-request', label: 'fixture-tool-request', requestIdHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(requests).toEqual([
      {
        requestId: 'request-1',
        sessionId,
        subtype: 'can_use_tool',
        toolName: 'subscription_fixture_echo',
        toolUseIdHash: expect.any(String),
        toolInputValid: true,
        fixtureInput: true,
      },
    ]);

    const responseAdapter = new ClaudeLiveWireAdapter();
    expect(() => responseAdapter.push(line({ type: 'control_response', request_id: 'missing', response: { subtype: 'success' } }))).toThrowError(
      expect.objectContaining({ code: 'control-correlation' }),
    );
  });

  it('correlates SDK-shaped nested responses to host-issued controls', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    adapter.registerOutboundControl('init-1');
    const events = adapter.push(
      line({ type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: initializeResponse } }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'control-response', requestIdHash: expect.any(String), label: 'initialize-success' });
  });

  it('accepts the observed Claude initialize metadata shape without retaining sensitive values', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    adapter.registerOutboundControl('init-canonical');
    const events = adapter.push(
      line({ type: 'control_response', response: { subtype: 'success', request_id: 'init-canonical', response: canonicalInitializeResponse } }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'control-response', label: 'initialize-success', count: 3 });
    expect(JSON.stringify(events)).not.toContain('output-styles');
    expect(JSON.stringify(events)).not.toContain('redacted@example.test');
    expect(JSON.stringify(events)).not.toContain('deep-research');
  });

  it('fails closed for unknown observed-shape fields and invalid bounded metadata', () => {
    const unknown = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    unknown.registerOutboundControl('init-unknown-field');
    expect(() => unknown.push(line({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'init-unknown-field', response: { ...canonicalInitializeResponse, unexpected: true } },
    }))).toThrowError(expect.objectContaining({ code: 'control-invalid' }));

    const invalidState = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    invalidState.registerOutboundControl('init-invalid-state');
    expect(() => invalidState.push(line({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'init-invalid-state', response: { ...canonicalInitializeResponse, session_state: 'unknown' } },
    }))).toThrowError(expect.objectContaining({ code: 'control-invalid' }));

    const invalidHint = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    invalidHint.registerOutboundControl('init-invalid-hint');
    expect(() => invalidHint.push(line({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'init-invalid-hint', response: { ...canonicalInitializeResponse, commands: [{ name: 'x', description: 'y', argumentHint: '\0' }] } },
    }))).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^(control-invalid|frame-limit)$/) }));
  });

  it('accepts SDK pending-control siblings inside the control envelope only when bounded and empty for T04', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    adapter.registerOutboundControl('init-pending');
    const events = adapter.push(
      line({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'init-pending',
          response: initializeResponse,
          pending_permission_requests: [],
          pending_user_dialog_requests: [],
        },
      }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'control-response', label: 'initialize-success' });

    const pending = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    pending.registerOutboundControl('init-pending-2');
    expect(() =>
      pending.push(
        line({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'init-pending-2',
            response: initializeResponse,
            pending_permission_requests: [
              { type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'fixtureTool', tool_use_id: 'tool-1', input: { value: 'safe' } } },
            ],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'control-invalid' }));
  });

  it('accepts SDK error result subtypes and records only bounded cancellation metadata', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    const events = adapter.push(
      line({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true, errors: ['secret detail'], terminal_reason: 'aborted_streaming' }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'final-error', label: 'cancelled-aborted_streaming' });
    expect(JSON.stringify(events)).not.toContain('secret detail');
    const invalid = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    expect(() => invalid.push(line({ type: 'result', subtype: 'error_max_turns', session_id: sessionId, is_error: false, errors: [] }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
  });

  it('validates initialize capabilities and ignores only admitted non-text stream events', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    adapter.registerOutboundControl('init-2');
    const events = adapter.push(
      line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'bounded' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } }) +
        line({ type: 'control_response', response: { subtype: 'success', request_id: 'init-2', response: initializeResponse } }),
    );
    adapter.end();
    expect(events.map(event => event.kind)).toEqual(['telemetry', 'telemetry', 'telemetry', 'control-response']);
    expect(events[3]).toMatchObject({ label: 'initialize-success', count: 0 });

    const unknown = new ClaudeLiveWireAdapter();
    unknown.registerOutboundControl('init-3');
    expect(() => unknown.push(line({ type: 'control_response', response: { subtype: 'success', request_id: 'init-3', response: { unknown: true } } }))).toThrowError(
      expect.objectContaining({ code: 'control-invalid' }),
    );

    const missing = new ClaudeLiveWireAdapter();
    missing.registerOutboundControl('init-4');
    expect(() => missing.push(line({ type: 'control_response', response: { subtype: 'success', request_id: 'init-4' } }))).toThrowError(
      expect.objectContaining({ code: 'control-invalid' }),
    );
  });

  it('accepts normal tool/thinking/signature partials as telemetry without treating them as text', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedTextMarker: 'LIVE_TEXT_OK' });
    const events = adapter.push(
      line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'fixture', input: {} } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 0 } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'private reasoning', estimated_tokens: 2 } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'private-signature' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 1 } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } }),
    );
    adapter.end();
    expect(events.map(event => event.label).filter(label => label?.startsWith('stream-') && label.endsWith('_delta'))).toEqual(['stream-input_json_delta', 'stream-thinking_delta', 'stream-signature_delta', 'stream-message_delta']);
    expect(adapter.textMarkerSeen).toBe(false);
  });

  it('accepts bounded citation/compaction partials and normal system telemetry', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    const events = adapter.push(
      line({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state: 'bounded' }) +
        line({ type: 'system', subtype: 'api_retry', session_id: sessionId, attempt: 1 }) +
        line({ type: 'system', subtype: 'compact_boundary', session_id: sessionId }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'bounded' } } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', data: { kept: 1 } } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 0 } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } }),
    );
    adapter.end();
    expect(events.map(event => event.label)).toEqual([
      'system-session_state_changed',
      'system-api_retry',
      'system-compact_boundary',
      'stream-message_start',
      'stream-content_block_start',
      'stream-citations_delta',
      'stream-compaction_delta',
      'stream-content_block_stop',
      'stream-message_delta',
      'stream-message_stop',
    ]);
    expect(events.every(event => event.kind === 'telemetry')).toBe(true);
  });

  it('bounds and ignores keep-alive and assistant thinking blocks', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedTextMarker: 'LIVE_TEXT_OK' });
    const events = adapter.push(
      line({ type: 'keep_alive' }) +
        line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'private-signature' }, { type: 'redacted_thinking', data: 'redacted' }] } }),
    );
    adapter.end();
    expect(events).toMatchObject([{ kind: 'telemetry', wireType: 'keep_alive' }, { kind: 'telemetry', label: 'assistant-thinking', count: 2 }]);
    expect(adapter.textMarkerSeen).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });

  it('validates the canonical thought-to-text raw stream lifecycle and discards thought payloads', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedTextMarker: 'LIVE_TEXT_OK' });
    const events = adapter.push(streamLifecycle('LIVE_TEXT_OK', sessionId, { thinking: true }));
    adapter.end();
    expect(events.filter(event => event.label === 'stream-thinking_delta')).toHaveLength(1);
    expect(events.filter(event => event.label === 'stream-signature_delta')).toHaveLength(1);
    expect(events.some(event => event.kind === 'stream-delta' && event.label === 'expected-text-marker')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private reasoning');
    expect(JSON.stringify(events)).not.toContain('private-signature');
  });

  it.each([
    ['delta without message_start', line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } })],
    ['delta without block start', line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } })],
    ['duplicate block start', line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })],
    ['message delta with open block', line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_delta', delta: {}, usage: { output_tokens: 1 } } })],
    ['message stop without delta', line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) + line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } })],
  ])('fails closed for raw stream order/correlation: %s', (_label, input) => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    expect(() => adapter.push(input)).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^(malformed-frame|control-correlation)$/) }));
  });

  it('fails closed when EOF truncates an open block or message lifecycle', () => {
    const openBlock = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    openBlock.push(
      line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
    );
    expect(() => openBlock.end()).toThrowError(expect.objectContaining({ code: 'control-correlation' }));

    const openMessage = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    openMessage.push(line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }));
    expect(() => openMessage.end()).toThrowError(expect.objectContaining({ code: 'control-correlation' }));
  });

  it('requires canonical thinking/signature fields and bounded token estimates', () => {
    const missingSignature = new ClaudeLiveWireAdapter();
    expect(() => missingSignature.push(line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'thinking', thinking: 'private' }] } }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
    const missingStreamSignature = new ClaudeLiveWireAdapter();
    expect(() => missingStreamSignature.push(
      line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }),
    )).toThrowError(expect.objectContaining({ code: 'malformed-frame' }));
    const fallbackData = new ClaudeLiveWireAdapter();
    expect(() => fallbackData.push(line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'redacted_thinking', thinking: 'private' }] } }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
    const invalidEstimate = new ClaudeLiveWireAdapter();
    expect(() => invalidEstimate.push(
      line({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'm' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } }) +
        line({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x', estimated_tokens: -1 } } }),
    )).toThrowError(expect.objectContaining({ code: 'malformed-frame' }));
  });

  it('records bounded thinking-token and known top-level telemetry without payloads', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    const events = adapter.push(
      line({ type: 'system', subtype: 'thinking_tokens', session_id: sessionId, estimated_tokens: 4, estimated_tokens_delta: 2, secret: 'discard' }) +
        line({ type: 'conversation_reset', session_id: sessionId, new_conversation_id: 'new-conversation', uuid: 'event-1' }) +
        line({ type: 'prompt_suggestion', session_id: sessionId, suggestion: 'private suggestion', uuid: 'event-2' }) +
        line({ type: 'tool_progress', session_id: sessionId, tool_use_id: 'tool-1', tool_name: 'fixture', parent_tool_use_id: null, elapsed_time_seconds: 0, uuid: 'event-3' }) +
        line({ type: 'tool_use_summary', session_id: sessionId, summary: 'private summary', preceding_tool_use_ids: ['tool-1'], uuid: 'event-4' }),
    );
    adapter.end();
    expect(events.map(event => event.label)).toEqual(['system-thinking_tokens', 'top-level-conversation_reset', 'top-level-prompt_suggestion', 'top-level-tool_progress', 'top-level-tool_use_summary']);
    expect(JSON.stringify(events)).not.toContain('private suggestion');
    expect(JSON.stringify(events)).not.toContain('private summary');
    const invalid = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    expect(() => invalid.push(line({ type: 'system', subtype: 'thinking_tokens', session_id: sessionId, estimated_tokens: 1, estimated_tokens_delta: -1 }))).toThrowError(expect.objectContaining({ code: 'malformed-frame' }));
  });

  it('uses a generic structured shape for untrusted object keys', () => {
    const adapter = new ClaudeLiveWireAdapter();
    const events = adapter.push(line({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, structured_output: { authorization: 'secret', arbitrary: true } }));
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'final-structured', structuredShape: 'object' });
    expect(JSON.stringify(events)).not.toContain('authorization');
  });

  it('requires exact interrupt outcome statuses and request/session correlation', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    adapter.registerOutboundControl('interrupt-1', sessionId, 'interrupt');
    const events = adapter.push(
      line({ type: 'control_response', session_id: sessionId, response: { subtype: 'success', request_id: 'interrupt-1', response: { status: 'interrupted' } } }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({ label: 'interrupt-legacy-interrupted' });

    const invalid = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    invalid.registerOutboundControl('interrupt-2', sessionId, 'interrupt');
    expect(() => invalid.push(line({ type: 'control_response', session_id: sessionId, response: { subtype: 'success', request_id: 'interrupt-2', response: { status: 'unknown' } } }))).toThrowError(
      expect.objectContaining({ code: 'control-invalid' }),
    );
  });

  it('accepts the canonical SDK interrupt receipt without session_id and inherits the pending process session', () => {
    const adapter = new ClaudeLiveWireAdapter();
    adapter.registerOutboundControl('interrupt-canonical', sessionId, 'interrupt');
    const events = adapter.push(
      line({ type: 'control_response', response: { subtype: 'success', request_id: 'interrupt-canonical', response: { still_queued: [], cancelled: [] } } }),
    );
    adapter.end();
    expect(events[0]).toMatchObject({
      kind: 'control-response',
      label: 'interrupt-receipt',
      sessionIdHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(events[0]?.sessionIdHash).toBe(hashSessionId(sessionId));
  });

  it('rejects an explicitly mismatched session on a canonical interrupt response', () => {
    const adapter = new ClaudeLiveWireAdapter();
    adapter.registerOutboundControl('interrupt-mismatch', sessionId, 'interrupt');
    expect(() =>
      adapter.push(
        line({ type: 'control_response', session_id: 'other-session', response: { subtype: 'success', request_id: 'interrupt-mismatch', response: { still_queued: [], cancelled: [] } } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'control-correlation' }));
  });

  it('accepts only the exact fixed prompt when the CLI echoes a user frame', () => {
    const prompt = 'Reply with exactly LIVE_TEXT_OK and do not call any tools.';
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId, expectedUserPrompt: prompt });
    const events = adapter.push(line({ type: 'user', session_id: sessionId, message: { content: [{ type: 'text', text: prompt }] } }));
    adapter.end();
    expect(events[0]).toMatchObject({ kind: 'telemetry', label: 'user-message' });
    expect(adapter.textMarkerSeen).toBe(false);
  });

  it.each([
    ['t1-start', 'LIVE_TEXT_OK'],
    ['t2-resume', 'LIVE_RESUME_OK'],
    ['t3-fork', 'LIVE_FORK_OK'],
    ['t4-structured', 'LIVE_STRUCTURED_OK'],
    ['t5-cancel', 'LIVE_CANCEL_OK'],
  ])('never accepts a %s echoed user prompt as output marker', (_scenario, marker) => {
    const prompt = `fixed prompt containing ${marker}`;
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId, expectedUserPrompt: prompt, expectedTextMarker: marker });
    adapter.push(line({ type: 'user', session_id: sessionId, message: { content: [{ type: 'text', text: prompt }] } }));
    adapter.end();
    expect(adapter.textMarkerSeen).toBe(false);
  });

  it('requires can_use_tool to correlate to an earlier assistant tool-use ID', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedToolName: 'subscription_fixture_echo', expectedToolInput: { value: 'LIVE_TOOL_OK', delayMs: 0 } });
    adapter.push(line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'subscription_fixture_echo', input: { value: 'LIVE_TOOL_OK', delayMs: 0 } }] } }));
    expect(() => adapter.push(line({ type: 'control_request', session_id: sessionId, request_id: 'request-2', request: { subtype: 'can_use_tool', tool_name: 'subscription_fixture_echo', input: { value: 'LIVE_TOOL_OK', delayMs: 0 } } }))).toThrowError(
      expect.objectContaining({ code: 'control-correlation' }),
    );
  });

  it('records an expected marker without retaining its text', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId, expectedTextMarker: 'LIVE_TEXT_OK' });
    const events = adapter.push(
      streamLifecycle('LIVE_TEXT_OK', sessionId),
    );
    adapter.end();
    expect(adapter.textMarkerSeen).toBe(true);
    expect(events.find(event => event.kind === 'stream-delta')).toMatchObject({ kind: 'stream-delta', label: 'expected-text-marker' });
    expect(JSON.stringify(events)).not.toContain('LIVE_TEXT_OK');
  });

  it('fails closed for malformed control frames and unknown frame types', () => {
    const malformed = new ClaudeLiveWireAdapter();
    expect(() => malformed.push(line({ type: 'control_request', request_id: 'request-1', request: { subtype: 'unknown' } }))).toThrowError(
      expect.objectContaining({ code: 'control-invalid' }),
    );

    const unknown = new ClaudeLiveWireAdapter();
    expect(() => unknown.push(line({ type: 'made_up_event', session_id: sessionId }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-frame' }),
    );
  });

  it('rejects non-tool user frames instead of retaining user content', () => {
    const adapter = new ClaudeLiveWireAdapter();
    expect(() =>
      adapter.push(
        line({
          type: 'user',
          session_id: sessionId,
          message: { content: [{ type: 'text', text: 'user secret' }] },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-frame' }));
  });

  it('rejects invalid UTF-8, overlong input, and partial EOF with bounded diagnostics', () => {
    const invalid = new ClaudeLiveWireAdapter();
    expect(() => invalid.push(new Uint8Array([0x7b, 0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ code: 'invalid-utf8', lineNumber: 0 }),
    );

    const partial = new ClaudeLiveWireAdapter();
    partial.push('{"type":"system"');
    expect(() => partial.end()).toThrowError(expect.objectContaining({ code: 'partial-eof' }));

    const oversized = new ClaudeLiveWireAdapter();
    expect(() => oversized.push(`${'x'.repeat(128 * 1024)}\n`)).toThrowError(
      expect.objectContaining({ code: 'byte-limit' }),
    );
  });

  it('keeps UTF-8 decoding incremental across mixed string and byte chunks', () => {
    const adapter = new ClaudeLiveWireAdapter();
    const input = streamLifecycle('café', sessionId);
    const split = input.indexOf('é');
    const events = [...adapter.push(input.slice(0, split)), ...adapter.push(Buffer.from(input.slice(split), 'utf8'))];
    adapter.end();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'stream-delta', bytes: Buffer.byteLength('café') })]));
  });

  it('binds an explicitly selected session', () => {
    const adapter = new ClaudeLiveWireAdapter({ expectedSessionId: sessionId });
    expect(() => adapter.push(line({ type: 'system', subtype: 'init', session_id: 'other-session' }))).toThrowError(
      expect.objectContaining({ code: 'malformed-frame' }),
    );
  });

  it('does not leak error details in its public failure object', () => {
    const adapter = new ClaudeLiveWireAdapter();
    try {
      adapter.push(line({ type: 'result', subtype: 'success', is_error: false, result: 'x'.repeat(10_000_000) }));
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeLiveWireError);
      expect((error as ClaudeLiveWireError).message).not.toContain('x'.repeat(100));
    }
  });
});
