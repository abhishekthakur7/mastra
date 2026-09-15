import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeToolLaunchProfile,
  createClaudeOwnedWorkspace,
  validateClaudeLaunchProfilePaths,
  type ClaudeOwnedWorkspace,
} from './claude-launch-profile';
import {
  CLAUDE_FIXTURE_TOOL_NAME,
  ClaudeToolBridge,
  ClaudeSerializedHostRelay,
  claudeMcpToolResultSchema,
  createFixtureMcpTransport,
  parseClaudeMcpToolCall,
  parseClaudeMcpToolResult,
  serializeClaudeMcpToolCall,
  serializeClaudeMcpToolResult,
  type ClaudeMcpToolCall,
  type ClaudeMcpToolResult,
  type ClaudeToolRequest,
} from './claude-tool-bridge';
import { fixtureToolOutputSchema, startFixtureMcpHttpServer, type FixtureMcpHttpServer } from './mcp-fixture';

const fixtureServer = { type: 'http' as const, url: 'http://127.0.0.1:43123/mcp' };

type BridgeRequest = ClaudeMcpToolCall & { readonly requiresApproval?: boolean };

const request = (overrides: Partial<BridgeRequest> = {}): BridgeRequest => ({
  protocol: 'mcp',
  schemaVersion: 1,
  requestId: 'request-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  toolName: CLAUDE_FIXTURE_TOOL_NAME,
  input: { value: 'BRIDGE_OK', delayMs: 0 },
  ...overrides,
});

const hostRequest = (overrides: Partial<BridgeRequest> = {}): ClaudeToolRequest => {
  const { protocol: _protocol, schemaVersion: _schemaVersion, ...call } = request(overrides);
  return call;
};

const result = (requestValue: ClaudeMcpToolCall, value = requestValue.input.value): ClaudeMcpToolResult => ({
  protocol: 'mcp',
  schemaVersion: 1,
  requestId: requestValue.requestId,
  sessionId: requestValue.sessionId,
  toolCallId: requestValue.toolCallId,
  status: 'success',
  output: { value, source: 'protocol-fixture' },
});

let fixtureHttpServer: FixtureMcpHttpServer | undefined;
let workspaces: ClaudeOwnedWorkspace[] = [];

afterEach(async () => {
  await fixtureHttpServer?.close().catch(() => {});
  fixtureHttpServer = undefined;
  await Promise.all(workspaces.splice(0).map(workspace => workspace.cleanup().catch(() => {})));
});

describe('Claude T05 tool bridge', () => {
  it('requires a separate tool opt-in and keeps the explicit allow-list isolated', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    workspaces.push(workspace);

    const profile = buildClaudeToolLaunchProfile({
      toolOptIn: true,
      paths: workspace.paths,
      mcpServers: { fixture: fixtureServer },
    });

    expect(profile.toolCapability).toEqual({
      enabled: true,
      allowedMcpServer: 'fixture',
      allowedTool: 'mcp__fixture__subscription_fixture_echo',
      ambientTools: 'disabled',
    });
    expect(profile.argv).toEqual([
      '--restricted',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      workspace.paths.mcpConfigPath,
      '--setting-sources',
      '',
      '--allowedTools',
      'mcp__fixture__subscription_fixture_echo',
    ]);
    expect(profile.settings).toMatchObject({ safeMode: false, restrictedMode: true, nativeTools: [], settingSources: [], strictMcpConfig: true });
    expect(profile.settings.nativeTools).toEqual([]);
    expect(profile.settings.settingSources).toEqual([]);
    await expect(validateClaudeLaunchProfilePaths(profile, { workspace })).resolves.toBeUndefined();

    expect(() =>
      buildClaudeToolLaunchProfile({
        toolOptIn: false as true,
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      }),
    ).toThrow(/toolOptIn/);
    expect(() =>
      buildClaudeToolLaunchProfile({
        toolOptIn: true,
        allowedTools: ['other_tool'] as unknown as ['mcp__fixture__subscription_fixture_echo'],
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      }),
    ).toThrow(/allow-list/);

    const widenedCapability = { ...profile, toolCapability: { ...profile.toolCapability, extraTool: 'mcp__fixture__other' } };
    await expect(validateClaudeLaunchProfilePaths(widenedCapability, { workspace })).rejects.toThrow(/tool capability/);
  });

  it('round-trips bounded MCP call/result envelopes and rejects cross-field errors', () => {
    const call = request();
    expect(parseClaudeMcpToolCall(serializeClaudeMcpToolCall(call))).toEqual(call);

    const success = result(call);
    expect(parseClaudeMcpToolResult(serializeClaudeMcpToolResult(success))).toEqual(success);
    expect(claudeMcpToolResultSchema.parse(success)).toEqual(success);
    expect(() =>
      parseClaudeMcpToolResult(
        JSON.stringify({ ...success, status: 'error' }) + '\n',
      ),
    ).toThrow(/error results require/);
    expect(() => parseClaudeMcpToolCall('{"protocol":"mcp","schemaVersion":1}')).toThrow();
  });

  it('uses the real loopback MCP fixture for schema, structured result, and error round-trips', async context => {
    try {
      fixtureHttpServer = await startFixtureMcpHttpServer();
    } catch (error) {
      // Some CI sandboxes prohibit loopback listeners.  The pure envelope and
      // fixture-transport tests below still provide deterministic static proof.
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
        return context.skip('loopback sockets are unavailable in this sandbox');
      }
      throw error;
    }
    const client = new Client({ name: 'subscription-runtime-t05', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(fixtureHttpServer.url)));
    try {
      const listed = await client.listTools();
      const listedTool = listed.tools.find(tool => tool.name === CLAUDE_FIXTURE_TOOL_NAME);
      expect(listedTool?.inputSchema).toBeDefined();
      expect(listedTool?.outputSchema).toBeDefined();

      const success = await client.callTool({ name: CLAUDE_FIXTURE_TOOL_NAME, arguments: { value: 'MCP_OK', delayMs: 1 } });
      expect(success.isError).toBe(false);
      expect(fixtureToolOutputSchema.parse(success.structuredContent)).toEqual({ value: 'MCP_OK', source: 'protocol-fixture' });

      const invalid = await client.callTool({ name: CLAUDE_FIXTURE_TOOL_NAME, arguments: { value: '' } });
      expect(invalid.isError).toBe(true);
      expect((invalid.content[0] as { type: 'text'; text: string }).text).toContain('Tool validation failed');
    } finally {
      await client.close();
    }
  });

  it('applies pre-tool mutation before approval and invokes an approved call at most once', async () => {
    const calls: string[] = [];
    let invocationCount = 0;
    const bridge = new ClaudeToolBridge({
      preTool: async call => {
        calls.push(`pre:${call.input.value}`);
        return { decision: 'modify', input: { value: 'MUTATED', delayMs: 0 } };
      },
      approve: async call => {
        calls.push(`approve:${call.input.value}`);
        return 'allow' as const;
      },
      transport: async call => {
        invocationCount += 1;
        calls.push(`execute:${call.input.value}`);
        return result(call);
      },
    });

    const first = bridge.dispatch(hostRequest({ requiresApproval: true }));
    const duplicate = bridge.dispatch(hostRequest({ requiresApproval: true }));
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      result(request({ input: { value: 'MUTATED', delayMs: 0 } })),
      result(request({ input: { value: 'MUTATED', delayMs: 0 } })),
    ]);
    expect(invocationCount).toBe(1);
    expect(calls).toEqual(['pre:BRIDGE_OK', 'approve:MUTATED', 'execute:MUTATED']);
    expect(bridge.callRecords[0]).toMatchObject({ state: 'completed', invocationStarted: true });
    expect(JSON.parse(JSON.stringify(bridge.snapshot()))).toMatchObject({
      schemaVersion: 1,
      calls: [{
        requestId: 'request-1',
        toolCallId: 'tool-1',
        state: 'completed',
        invocationStarted: true,
        preToolDecision: 'modify',
        effectiveInput: { value: 'MUTATED', delayMs: 0 },
        approvalDecision: 'allow',
      }],
    });
  });

  it('blocks before the effect on pre-tool deny or approval deny', async () => {
    let invocations = 0;
    const blocked = new ClaudeToolBridge({
      preTool: () => ({ decision: 'deny', reason: 'policy' }),
      approve: () => 'allow' as const,
      transport: async call => {
        invocations += 1;
        return result(call);
      },
    });
    await expect(blocked.dispatch(hostRequest())).resolves.toMatchObject({ status: 'error', error: { code: 'pre-tool-blocked' } });

    const denied = new ClaudeToolBridge({
      approve: () => 'deny' as const,
      transport: async call => {
        invocations += 1;
        return result(call);
      },
    });
    await expect(denied.dispatch(hostRequest({ toolCallId: 'tool-2' }))).resolves.toMatchObject({ status: 'error', error: { code: 'approval-denied' } });
    expect(invocations).toBe(0);
    expect(denied.callRecords[0]).toMatchObject({ state: 'denied', invocationStarted: false });
  });

  it('serializes callbacks through one observable relay and processes results before persistence/continuation', async () => {
    const callbackOrder: string[] = [];
    let active = 0;
    let maxActive = 0;
    const relay = new ClaudeSerializedHostRelay();
    const bridge = new ClaudeToolBridge({
      relay,
      approve: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        callbackOrder.push('approval');
        return 'allow' as const;
      },
      transport: async call => result(call),
      processToolResult: async (_call, output) => {
        callbackOrder.push(`processed:${output.output?.value}`);
        return output;
      },
      persistToolResult: () => {
        callbackOrder.push('persisted');
      },
      continueModel: () => {
        callbackOrder.push('continued');
      },
    });

    await bridge.dispatch(hostRequest());
    expect(maxActive).toBe(1);
    expect(callbackOrder).toEqual(['approval', 'processed:BRIDGE_OK', 'persisted', 'continued']);
    const map = relay.orderingMap;
    expect(map.approval?.[0]).toBeLessThan(map['tool-result']?.[0] ?? Infinity);
    expect(map['tool-result']?.[1]).toBeLessThan(map.persist?.[0] ?? Infinity);
    expect(map.persist?.[1]).toBeLessThan(map['model-continuation']?.[0] ?? Infinity);
    expect(relay.events.filter(event => event.status === 'started')).toHaveLength(5);
  });

  it('serializes two genuinely concurrent calls with deterministic per-phase order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const bridge = new ClaudeToolBridge({
      approve: async call => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`approval:start:${call.toolCallId}`);
        await new Promise(resolve => setTimeout(resolve, 3));
        active -= 1;
        order.push(`approval:end:${call.toolCallId}`);
        return 'allow' as const;
      },
      transport: async call => result(call),
      processToolResult: (call, output) => {
        order.push(`processed:${call.toolCallId}`);
        return output;
      },
      persistToolResult: (output, context) => {
        order.push(`persisted:${output.toolCallId}:${context?.signal.aborted ? 'aborted' : 'live'}`);
      },
      continueModel: output => {
        order.push(`continued:${output.toolCallId}`);
      },
    });

    const first = bridge.dispatch(hostRequest({ toolCallId: 'concurrent-a' }));
    const second = bridge.dispatch(hostRequest({ toolCallId: 'concurrent-b' }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      'approval:start:concurrent-a',
      'approval:end:concurrent-a',
      'approval:start:concurrent-b',
      'approval:end:concurrent-b',
      'processed:concurrent-a',
      'processed:concurrent-b',
      'persisted:concurrent-a:live',
      'persisted:concurrent-b:live',
      'continued:concurrent-a',
      'continued:concurrent-b',
    ]);
  });

  it('waits for delayed client-tool results and rejects wrong or late correlations', async () => {
    const callbackOrder: string[] = [];
    const bridge = new ClaudeToolBridge({
      clientToolTimeoutMs: 1_000,
      processToolResult: (_call, output) => {
        callbackOrder.push('processed');
        return output;
      },
      persistToolResult: () => {
        callbackOrder.push('persisted');
      },
      continueModel: () => {
        callbackOrder.push('continued');
      },
    });
    const clientRequest = {
      requestId: 'client-request-1',
      sessionId: 'session-1',
      toolCallId: 'client-tool-1',
      toolName: 'client_echo',
      input: { value: 'from-client' },
    };
    const pending = bridge.dispatchClientTool(clientRequest);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(bridge.relay.events.some(event => event.phase === 'client-tool-request')).toBe(true);
    expect(() =>
      bridge.provideClientToolResult({
        requestId: 'wrong-request',
        sessionId: clientRequest.sessionId,
        toolCallId: clientRequest.toolCallId,
        status: 'success',
        output: { value: 'late' },
      }),
    ).toThrow(/correlation/);

    bridge.provideClientToolResult({
      requestId: clientRequest.requestId,
      sessionId: clientRequest.sessionId,
      toolCallId: clientRequest.toolCallId,
      status: 'success',
      output: { value: 'CLIENT_OK' },
    });
    await expect(pending).resolves.toMatchObject({ status: 'success', output: { value: '{"value":"CLIENT_OK"}' } });
    expect(callbackOrder).toEqual(['processed', 'persisted', 'continued']);
    expect(() =>
      bridge.provideClientToolResult({
        requestId: clientRequest.requestId,
        sessionId: clientRequest.sessionId,
        toolCallId: clientRequest.toolCallId,
        status: 'success',
        output: { value: 'DUPLICATE' },
      }),
    ).toThrow(/matching pending/);

  });

  it('bounds hook callbacks and makes transport loss terminal without replay', async () => {
    let transportCalls = 0;
    const timedOut = new ClaudeToolBridge({
      hookTimeoutMs: 10,
      preTool: () => new Promise(() => {}),
    });
    await expect(timedOut.dispatch(hostRequest())).resolves.toMatchObject({ status: 'error', error: { code: 'hook-timeout' } });
    expect(timedOut.callRecords[0]).toMatchObject({ state: 'errored', invocationStarted: false });

    const disconnected = new ClaudeToolBridge({
      approve: () => 'allow' as const,
      transport: async () => {
        transportCalls += 1;
        throw new Error('relay disconnected');
      },
    });
    const first = await disconnected.dispatch(hostRequest({ toolCallId: 'transport-tool' }));
    const retry = await disconnected.dispatch(hostRequest({ toolCallId: 'transport-tool' }));
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ status: 'error', error: { code: 'transport-error' } });
    expect(transportCalls).toBe(1);
  });

  it('expires an unanswered client-tool request without accepting a later result', async () => {
    const bridge = new ClaudeToolBridge({ clientToolTimeoutMs: 10 });
    const clientRequest = {
      requestId: 'timeout-request',
      sessionId: 'session-1',
      toolCallId: 'timeout-tool',
      toolName: 'client_echo',
      input: { value: 'pending' },
    };
    await expect(bridge.dispatchClientTool(clientRequest)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'client-tool-timeout' },
    });
    expect(() =>
      bridge.provideClientToolResult({
        requestId: clientRequest.requestId,
        sessionId: clientRequest.sessionId,
        toolCallId: clientRequest.toolCallId,
        status: 'success',
        output: { value: 'too-late' },
      }),
    ).toThrow(/matching pending/);
  });

  it('persists requiresApproval in request identity and rejects conflicting retries', async () => {
    const bridge = new ClaudeToolBridge({ approve: () => 'allow' as const, transport: async call => result(call) });
    await bridge.dispatch(hostRequest({ requiresApproval: false }));
    await expect(bridge.dispatch(hostRequest({ requiresApproval: true }))).resolves.toMatchObject({
      status: 'error',
      error: { code: 'duplicate-call-conflict' },
    });

    const client = new ClaudeToolBridge({ clientToolTimeoutMs: 1_000 });
    const clientRequest = {
      requestId: 'approval-client-request',
      sessionId: 'session-1',
      toolCallId: 'approval-client-tool',
      toolName: 'client_echo',
      input: { value: 'approval' },
      requiresApproval: false,
    };
    const pending = client.dispatchClientTool(clientRequest);
    await expect(client.dispatchClientTool({ ...clientRequest, requiresApproval: true })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'duplicate-call-conflict' },
    });
    client.provideClientToolResult({
      requestId: clientRequest.requestId,
      sessionId: clientRequest.sessionId,
      toolCallId: clientRequest.toolCallId,
      status: 'success',
      output: { value: 'ok' },
    });
    await pending;
  });

  it('rehydrates completed and pending client calls without replaying effects', async () => {
    let transportCalls = 0;
    const completed = new ClaudeToolBridge({
      approve: () => 'allow' as const,
      transport: async call => {
        transportCalls += 1;
        return result(call);
      },
    });
    const completedRequest = hostRequest({ toolCallId: 'completed-before-restore', requiresApproval: false });
    const completedResult = await completed.dispatch(completedRequest);
    const completedSnapshot = JSON.parse(JSON.stringify(completed.snapshot())) as unknown;
    const restoredCompleted = ClaudeToolBridge.fromSnapshot(completedSnapshot, {
      transport: async call => {
        transportCalls += 1;
        return result(call);
      },
    });
    await expect(restoredCompleted.dispatch(completedRequest)).resolves.toEqual(completedResult);
    expect(transportCalls).toBe(1);

    const pendingRequest = {
      requestId: 'restore-client-request',
      sessionId: 'session-1',
      toolCallId: 'restore-client-tool',
      toolName: 'client_echo',
      input: { value: 'restore-me' },
    };
    const pendingBridge = new ClaudeToolBridge({ clientToolTimeoutMs: 5_000 });
    const abandoned = pendingBridge.dispatchClientTool(pendingRequest);
    const pendingSnapshot = JSON.parse(JSON.stringify(pendingBridge.snapshot())) as unknown;
    const restoredPending = ClaudeToolBridge.fromSnapshot(pendingSnapshot, { clientToolTimeoutMs: 5_000 });
    const restoredPromise = restoredPending.dispatchClientTool(pendingRequest);
    restoredPending.provideClientToolResult({
      requestId: pendingRequest.requestId,
      sessionId: pendingRequest.sessionId,
      toolCallId: pendingRequest.toolCallId,
      status: 'success',
      output: { value: 'restored' },
    });
    expect(restoredPending.snapshot()).toMatchObject({
      clientCalls: [{ toolCallId: pendingRequest.toolCallId, state: 'pending' }],
      pendingClientTools: [pendingRequest.toolCallId],
    });
    await expect(restoredPromise).resolves.toMatchObject({ status: 'success', output: { value: '{"value":"restored"}' } });
    expect(restoredPending.snapshot().clientCalls).toMatchObject([{ toolCallId: pendingRequest.toolCallId, state: 'completed' }]);

    const closedSnapshotSource = new ClaudeToolBridge({ approve: () => 'allow' as const });
    const closedResult = await closedSnapshotSource.dispatch(hostRequest({ toolCallId: 'closed-terminal', requiresApproval: false }));
    closedSnapshotSource.close();
    const restoredClosed = ClaudeToolBridge.fromSnapshot(JSON.parse(JSON.stringify(closedSnapshotSource.snapshot())));
    await expect(restoredClosed.dispatch(hostRequest({ toolCallId: 'closed-terminal', requiresApproval: false }))).resolves.toEqual(closedResult);
    pendingBridge.close();
    await abandoned;
  });

  it('uses the bounded callback timeout and aborts client persistence', async () => {
    let signal: AbortSignal | undefined;
    const bridge = new ClaudeToolBridge({
      hookTimeoutMs: 10,
      approve: () => 'allow' as const,
      transport: async call => result(call),
      persistToolResult: (_output, context) => {
        signal = context?.signal;
        return new Promise<void>(() => {});
      },
    });
    const output = await bridge.dispatch(hostRequest({ requiresApproval: false }));
    expect(output).toMatchObject({ status: 'error', error: { code: 'hook-timeout' } });
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the default fixture transport harmless and schema-backed', async () => {
    const bridge = new ClaudeToolBridge({ approve: () => 'allow' as const, transport: createFixtureMcpTransport() });
    const output = await bridge.dispatch(hostRequest({ input: { value: 'FIXTURE_OK', delayMs: 1 } }));
    expect(output.status).toBe('success');
    expect(fixtureToolOutputSchema.parse(output.output)).toEqual({ value: 'FIXTURE_OK', source: 'protocol-fixture' });
  });
});
