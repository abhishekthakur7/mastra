import { readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureEventRecorder } from './event-recorder';
import { createSubscriptionRuntimeFixtureHarness, type SubscriptionRuntimeFixtureHarness } from './harness';
import { startFixtureHookRelay, type FixtureHookRelayOptions } from './hook-relay';
import {
  closeFixtureMcpStdioServer,
  createFixtureMcpServer,
  shouldAcceptFixtureMcpHttpConnection,
  startFixtureMcpHttpServer,
} from './mcp-fixture';
import { BoundedResourceScope } from './process-cleanup';
import { FixtureRedactor } from './redactor';
import { assertProtocolFixtureConfig, createDisposableFixtureWorkspace, createGeneratedFixtureConfig, readGeneratedFixtureConfig } from './workspace';

describe('subscription runtime T02 fixture harness', () => {
  let harness: SubscriptionRuntimeFixtureHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('keeps generated protocol configuration loopback-only and calls a harmless schema-backed MCP tool', async context => {
    try {
      harness = await createSubscriptionRuntimeFixtureHarness();
    } catch (error) {
      if (isLoopbackPermissionError(error)) return context.skip('loopback sockets are unavailable in this sandbox');
      throw error;
    }
    const config = await readGeneratedFixtureConfig(harness.workspace.configPath);

    expect(harness.mode).toBe('protocol-fixture');
    expect(config.nativeTools.enabled).toBe(false);
    expect(config.mcpServers.fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(JSON.stringify(config)).not.toMatch(/auth|credential|token|secret|header/i);

    const client = new Client({ name: 'subscription-runtime-fixture-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.fixture.url)));
    try {
      const result = await client.callTool({
        name: 'fixtureTool',
        arguments: { value: 'fixture-value' },
      });

      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('fixture-value');
      expect(JSON.stringify(result)).toContain('protocol-fixture');
      expect(harness.events.events).toEqual([
        {
          sequence: 0,
          source: 'mcp-fixture',
          type: 'tool-call',
          payload: { toolId: 'subscription_fixture_echo', input: { value: 'fixture-value', delayMs: 0 } },
        },
        {
          sequence: 1,
          source: 'mcp-fixture',
          type: 'tool-result',
          payload: { value: 'fixture-value', source: 'protocol-fixture' },
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it('provides one bounded hook relay seam and redacts recorded payloads', async context => {
    try {
      harness = await createSubscriptionRuntimeFixtureHarness({
        hookHandler: async request => ({ decision: 'modify', input: request.payload, context: 'fixture-context' }),
      });
    } catch (error) {
      if (isLoopbackPermissionError(error)) return context.skip('loopback sockets are unavailable in this sandbox');
      throw error;
    }

    const response = await fetch(harness.hookRelay.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'PreToolUse',
        payload: { value: 'safe-value', accessToken: 'fixture-access-token' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      decision: 'modify',
      input: { value: 'safe-value', accessToken: 'fixture-access-token' },
      context: 'fixture-context',
    });
    expect(harness.events.events).toEqual([
      {
        sequence: 0,
        source: 'hook-relay',
        type: 'request',
        payload: { event: 'PreToolUse', payload: { value: 'safe-value', '[REDACTED_KEY_1]': '[REDACTED]' } },
      },
      {
        sequence: 1,
        source: 'hook-relay',
        type: 'decision',
        payload: {
          decision: 'modify',
          input: { value: 'safe-value', '[REDACTED_KEY_1]': '[REDACTED]' },
          context: 'fixture-context',
        },
      },
    ]);
  });

  it('preserves deny decisions and returns a bounded timeout for a hanging hook', async context => {
    try {
      harness = await createSubscriptionRuntimeFixtureHarness({
        hookTimeoutMs: 25,
        hookHandler: async request => {
          if (request.event === 'deny-me') return { decision: 'deny', reason: 'fixture policy' };
          return await new Promise<never>(() => {});
        },
      });
    } catch (error) {
      if (isLoopbackPermissionError(error)) return context.skip('loopback sockets are unavailable in this sandbox');
      throw error;
    }

    const denied = await fetch(harness.hookRelay.url, {
      method: 'POST',
      body: JSON.stringify({ event: 'deny-me', payload: {} }),
    });
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toEqual({ decision: 'deny', reason: 'fixture policy' });

    const timedOut = await fetch(harness.hookRelay.url, {
      method: 'POST',
      body: JSON.stringify({ event: 'hang', payload: {} }),
    });
    expect(timedOut.status).toBe(504);
    await expect(timedOut.json()).resolves.toEqual({ error: 'hook relay timeout' });
    expect(harness.events.events.map(event => event.type)).toEqual(['request', 'decision', 'request', 'timeout']);
  });

  it('enforces a deadline while a hook request body is still arriving', async () => {
    const relay = await startRelayOrSkip({ timeoutMs: 25 });
    if (!relay) return;

    try {
      const response = await sendSlowBody(relay.url, 75);

      expect(response.status).toBe(408);
      expect(response.body).toEqual({ error: 'hook request body timeout' });
    } finally {
      await relay.close();
    }
  });

  it('aborts an active hook handler when the client disconnects', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const handlerStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    const handlerAborted = new Promise<void>(resolve => {
      aborted = resolve;
    });
    const relay = await startRelayOrSkip({
      timeoutMs: 1_000,
      handler: async (_request, { signal }) => {
        started();
        signal.addEventListener('abort', () => aborted(), { once: true });
        return await new Promise<never>(() => {});
      },
    });
    if (!relay) return;

    const request = httpRequest(relay.url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ event: 'disconnect', payload: {} }));
    try {
      await withTimeout(handlerStarted, 500);
      request.destroy();
      await withTimeout(handlerAborted, 500);
    } finally {
      request.destroy();
      await relay.close();
    }
  });

  it('aborts active hook handlers before bounded relay shutdown completes', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const handlerStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    const handlerAborted = new Promise<void>(resolve => {
      aborted = resolve;
    });
    const relay = await startRelayOrSkip({
      timeoutMs: 1_000,
      handler: async (_request, { signal }) => {
        started();
        signal.addEventListener('abort', () => aborted(), { once: true });
        return await new Promise<never>(() => {});
      },
    });
    if (!relay) return;

    const request = httpRequest(relay.url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ event: 'shutdown', payload: {} }));
    try {
      await withTimeout(handlerStarted, 500);
      await relay.close();
      await withTimeout(handlerAborted, 500);
    } finally {
      request.destroy();
      await relay.close();
    }
  });

  it('returns a safe overload response when the hook relay reaches its in-flight limit', async () => {
    let started!: () => void;
    const handlerStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    const relay = await startRelayOrSkip({
      timeoutMs: 1_000,
      maxInFlightRequests: 1,
      handler: async () => {
        started();
        return await new Promise<never>(() => {});
      },
    });
    if (!relay) return;

    const request = httpRequest(relay.url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ event: 'held-open', payload: {} }));
    try {
      await withTimeout(handlerStarted, 500);

      const overloaded = await fetchHook(relay.url, { event: 'overload', payload: {} });
      expect(overloaded.status).toBe(503);
      expect(overloaded.body).toEqual({ error: 'hook relay overloaded' });
    } finally {
      request.destroy();
      await relay.close();
    }
  });

  it('rejects invalid hook decisions at the relay boundary', async () => {
    const relay = await startRelayOrSkip({
      handler: async request => {
        if (request.event === 'invalid-decision') return { decision: 'maybe' } as never;
        return { decision: 'allow', extra: 'not-allowed' } as never;
      },
    });
    if (!relay) return;

    try {
      const invalidDecision = await fetchHook(relay.url, { event: 'invalid-decision', payload: {} });
      expect(invalidDecision.status).toBe(500);
      expect(invalidDecision.body).toEqual({ error: 'invalid hook decision' });

      const extraField = await fetchHook(relay.url, { event: 'extra-field', payload: {} });
      expect(extraField.status).toBe(500);
      expect(extraField.body).toEqual({ error: 'invalid hook decision' });
    } finally {
      await relay.close();
    }
  });

  it('rejects oversized hook decisions before serializing the response', async () => {
    const relay = await startRelayOrSkip({
      handler: async request => {
        if (request.event !== 'oversized-decision') return { decision: 'allow' };
        return {
          decision: 'modify',
          reason: 'r'.repeat(4 * 1024),
          context: 'c'.repeat(4 * 1024),
          input: Object.fromEntries(
            Array.from({ length: 14 }, (_, index) => [`part-${index}`, 'x'.repeat(4 * 1024)]),
          ),
        };
      },
    });
    if (!relay) return;

    try {
      const response = await fetchHook(relay.url, { event: 'oversized-decision', payload: {} });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'invalid hook decision' });
    } finally {
      await relay.close();
    }
  });

  it('omits unallowlisted event payloads and bounds allowlisted payloads', () => {
    const recorder = new FixtureEventRecorder({
      secretValues: ['fixture-secret'],
      maxDepth: 2,
      maxStringLength: 32,
    });
    recorder.record('mcp-fixture', 'tool-call', {
      toolId: 'subscription_fixture_echo',
      input: {
        secret: 'fixture-secret',
        long: 'x'.repeat(100),
        nested: { deeper: { value: 'not recorded at this depth' } },
      },
    });

    expect(recorder.events).toEqual([
      {
        sequence: 0,
        source: 'mcp-fixture',
        type: 'tool-call',
        payload: {
          toolId: 'subscription_fixture_echo',
          input: {
            '[REDACTED_KEY_1]': '[REDACTED]',
            long: 'xxxxxxxxxxxxxxxxxx...[truncated]',
            nested: { deeper: '[MaxDepth]' },
          },
        },
      },
    ]);

    const returnedEvents = recorder.events;
    expect(returnedEvents).toHaveLength(1);
    const returnedEvent = returnedEvents[0];
    if (!returnedEvent) throw new Error('expected a recorded event');
    (returnedEvent.payload as { input: { nested: { deeper: string } } }).input.nested.deeper = 'mutated';
    const recordedEvent = recorder.events[0];
    if (!recordedEvent) throw new Error('expected a recorded event');
    expect(recordedEvent.payload).toEqual({
      toolId: 'subscription_fixture_echo',
      input: {
        '[REDACTED_KEY_1]': '[REDACTED]',
        long: 'xxxxxxxxxxxxxxxxxx...[truncated]',
        nested: { deeper: '[MaxDepth]' },
      },
    });

    recorder.record('test', 'bounded', { secret: 'fixture-secret' });
    expect(recorder.events).toHaveLength(2);
    const boundedEvent = recorder.events[1];
    if (!boundedEvent) throw new Error('expected a bounded event');
    expect(boundedEvent).toEqual({
      sequence: 1,
      source: 'test',
      type: 'bounded',
      payload: '[Omitted]',
    });

    const boundedRecorder = new FixtureEventRecorder({
      secretValues: ['fixture-secret'],
      maxDepth: 2,
      maxStringLength: 32,
    });
    boundedRecorder.record('hook-relay', 'request', {
      event: 'bounded',
      payload: {
        secret: 'fixture-secret',
        long: 'x'.repeat(100),
        nested: { deeper: { value: 'not recorded at this depth' } },
      },
    });
    expect(boundedRecorder.events).toEqual([
      {
        sequence: 0,
        source: 'hook-relay',
        type: 'request',
        payload: {
          event: 'bounded',
          payload: {
            '[REDACTED_KEY_1]': '[REDACTED]',
            long: 'xxxxxxxxxxxxxxxxxx...[truncated]',
            nested: { deeper: '[MaxDepth]' },
          },
        },
      },
    ]);
  });

  it('bounds examined secret values when an iterable yields only empty values', () => {
    let examinedEntries = 0;
    function* emptySecretValues(): Iterable<string> {
      while (true) {
        examinedEntries += 1;
        if (examinedEntries > 100) throw new Error('secret values iterable examined too many entries');
        yield '';
      }
    }

    expect(() => new FixtureRedactor({ secretValues: emptySecretValues() })).not.toThrow();
    expect(examinedEntries).toBe(100);
  });

  it('does not inspect payloads after the recorder is full or for unknown event types', () => {
    let payloadReads = 0;
    const unsafePayload = new Proxy(
      Object.create({ inherited: 'must not be read' }) as Record<string, unknown>,
      {
        get() {
          payloadReads += 1;
          throw new Error('unsafe payload was read');
        },
        ownKeys() {
          payloadReads += 1;
          throw new Error('unsafe payload keys were enumerated');
        },
      },
    );

    const fullRecorder = new FixtureEventRecorder({ maxEvents: 1 });
    fullRecorder.record('mcp-fixture', 'tool-call');
    expect(() => fullRecorder.record('mcp-fixture', 'tool-call', unsafePayload)).not.toThrow();

    const invalidRecorder = new FixtureEventRecorder();
    expect(() => invalidRecorder.record('mcp-fixture', 'unknown-event', unsafePayload)).not.toThrow();

    expect(payloadReads).toBe(0);
    expect(fullRecorder.droppedEventCount).toBe(1);
    expect(invalidRecorder.events).toEqual([
      { sequence: 0, source: 'mcp-fixture', type: 'unknown-event', payload: '[Omitted]' },
    ]);
  });

  it('bounds secret input during recorder construction independently of redaction', () => {
    let examinedEntries = 0;
    function* secretValues(): Iterable<string> {
      while (true) {
        examinedEntries += 1;
        if (examinedEntries > 100) throw new Error('secret values iterable examined too many entries');
        yield '';
      }
    }

    expect(() => new FixtureEventRecorder({ secretValues: secretValues() })).not.toThrow();
    expect(examinedEntries).toBe(100);
  });

  it('counts inherited enumerable keys toward the object key cap', () => {
    const prototypeTarget = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`inherited_${index}`, index]),
    );
    const value = Object.create(prototypeTarget) as Record<string, unknown>;
    value.own = 'kept';

    const redacted = new FixtureRedactor({ maxObjectKeys: 1 }).redact(value);

    expect(redacted).toEqual({ own: 'kept', __omittedKeys: '[additional keys omitted]' });
    expect(Object.keys(redacted as Record<string, unknown>)).toHaveLength(2);
  });

  it('terminates tracked processes and removes only the disposable workspace', async () => {
    const resources = new BoundedResourceScope({ graceMs: 50, forceKillMs: 100 });
    const root = await resources.createTempDirectory('mastra-subscription-runtime-cleanup-');
    const child = resources.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root });
    await new Promise(resolve => setTimeout(resolve, 50));

    const evidence = await resources.cleanup();

    expect(evidence.closeErrors).toEqual([]);
    expect(evidence.remainingPaths).toEqual([]);
    expect(evidence.processes).toEqual([{ pid: child.pid, exited: true, escalated: false }]);
  });

  it('terminates an ordinary descendant inherited by the parent process group', async () => {
    const resources = new BoundedResourceScope({ graceMs: 50, forceKillMs: 200 });
    const root = await resources.createTempDirectory('mastra-subscription-runtime-descendant-');
    const descendantMarkerPath = `${root}-descendant-alive`;
    const waitForMarker = async (expected: boolean): Promise<void> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const present = await readFile(descendantMarkerPath, 'utf8')
          .then(() => true)
          .catch(() => false);
        if (present === expected) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`descendant marker did not become ${expected ? 'present' : 'absent'}`);
    };

    try {
      const parent = resources.spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const descendant = spawn(process.execPath, ['-e', [",
            "  \"const { writeFileSync, unlinkSync } = require('node:fs');\",",
            "  \"const markerPath = process.argv[1];\",",
            "  \"writeFileSync(markerPath, 'alive');\",",
            "  \"process.on('SIGTERM', () => { try { unlinkSync(markerPath); } finally { process.exit(0); } });\",",
            "  \"setInterval(() => {}, 1000);\",",
            "].join('\\n'), process.argv[1]], { detached: false, stdio: 'ignore' });",
            "process.on('SIGTERM', () => process.exit(0));",
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          descendantMarkerPath,
        ],
        { cwd: root },
      );

      await waitForMarker(true);
      const evidence = await resources.cleanup();

      expect(evidence.closeErrors).toEqual([]);
      expect(evidence.remainingPaths).toEqual([]);
      expect(evidence.processes).toEqual([{ pid: parent.pid, exited: true, escalated: false }]);
      await waitForMarker(false);
    } finally {
      await resources.cleanup().catch(() => undefined);
      await rm(descendantMarkerPath, { force: true });
    }
  });

  it('force-kills a tracked child that survives graceful shutdown', async () => {
    const resources = new BoundedResourceScope({ graceMs: 25, forceKillMs: 200 });
    const root = await resources.createTempDirectory('mastra-subscription-runtime-stubborn-');
    const readyPath = `${root}/ready`;
    const child = resources.spawn(
      process.execPath,
      [
        '-e',
        [
          "const { writeFileSync } = require('node:fs');",
          'process.on("SIGTERM", () => {});',
          `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      ],
      { cwd: root },
    );

    try {
      let ready = false;
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        ready = await readFile(readyPath, 'utf8')
          .then(value => value === 'ready')
          .catch(() => false);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(ready).toBe(true);

      const evidence = await resources.cleanup();

      expect(evidence.closeErrors).toEqual([]);
      expect(evidence.remainingPaths).toEqual([]);
      expect(evidence.processes).toEqual([{ pid: child.pid, exited: true, escalated: true }]);
    } finally {
      await resources.cleanup().catch(() => undefined);
    }
  });

  it('propagates closer failures with cleanup evidence', async () => {
    const resources = new BoundedResourceScope({ closerTimeoutMs: 50 });
    resources.trackCloser(() => {
      throw new Error('fixture closer failed');
    });

    await expect(resources.cleanup()).rejects.toMatchObject({
      evidence: { closeErrors: ['fixture closer failed'], remainingPaths: [], processes: [] },
    });
  });

  it('surfaces startup and cleanup failures together', async () => {
    const resources = new BoundedResourceScope({ closerTimeoutMs: 50 });
    resources.trackCloser(() => {
      throw new Error('fixture startup cleanup failed');
    });

    await expect(
      createSubscriptionRuntimeFixtureHarness({
        hookTimeoutMs: 0,
        resourceScope: resources,
      }),
    ).rejects.toSatisfy(error => {
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors;
      expect(errors[0]).toMatchObject({ message: 'hook timeout must be an integer between 1 and 5000' });
      expect(errors[1]).toMatchObject({
        name: 'BoundedResourceCleanupError',
        evidence: { closeErrors: ['fixture startup cleanup failed'], remainingPaths: [], processes: [] },
      });
      return true;
    });
  });

  it('bounds HTTP MCP shutdown, closes a held-open connection, and propagates MCP close failures', async context => {
    const mcpServer = createFixtureMcpServer();
    const mcpCloseError = new Error('fixture MCP close failed');
    vi.spyOn(mcpServer, 'close').mockRejectedValue(mcpCloseError);
    let server: Awaited<ReturnType<typeof startFixtureMcpHttpServer>> | undefined;
    let request: ReturnType<typeof httpRequest> | undefined;
    let connectionClosed!: () => void;
    const closed = new Promise<void>(resolve => {
      connectionClosed = resolve;
    });

    try {
      try {
        server = await startFixtureMcpHttpServer(undefined, { mcpServer, closeTimeoutMs: 50 });
      } catch (error) {
        if (isLoopbackPermissionError(error)) return context.skip('loopback sockets are unavailable in this sandbox');
        throw error;
      }

      request = httpRequest(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'keep-alive' },
      });
      request.once('close', connectionClosed);
      request.on('error', () => undefined);
      request.write('{"jsonrpc":"2.0"');
      await new Promise(resolve => setTimeout(resolve, 25));

      const startedAt = Date.now();
      await expect(server.close()).rejects.toBe(mcpCloseError);
      expect(Date.now() - startedAt).toBeLessThan(500);
      await withTimeout(closed, 500);
    } finally {
      request?.destroy();
      await server?.close().catch(() => undefined);
    }
  });

  it('does not admit an HTTP MCP connection at the active connection cap', () => {
    expect(shouldAcceptFixtureMcpHttpConnection(0, 1)).toBe(true);
    expect(shouldAcceptFixtureMcpHttpConnection(1, 1)).toBe(false);
    expect(shouldAcceptFixtureMcpHttpConnection(2, 1)).toBe(false);
  });

  it('returns a safe overload response and closes rejected HTTP MCP sockets at the active cap', async context => {
    let server: Awaited<ReturnType<typeof startFixtureMcpHttpServer>> | undefined;
    let heldRequest: ReturnType<typeof httpRequest> | undefined;
    let rejectedRequest: ReturnType<typeof httpRequest> | undefined;
    let rejectedSocket: { destroyed: boolean } | undefined;
    let rejectedSocketClosed!: () => void;
    const socketClosed = new Promise<void>(resolve => {
      rejectedSocketClosed = resolve;
    });

    try {
      try {
        server = await startFixtureMcpHttpServer(undefined, { maxActiveConnections: 1 });
      } catch (error) {
        if (isLoopbackPermissionError(error)) return context.skip('loopback sockets are unavailable in this sandbox');
        throw error;
      }

      const heldSocketReady = new Promise<void>(resolve => {
        heldRequest = httpRequest(server!.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', connection: 'keep-alive' },
        });
        heldRequest.once('socket', () => resolve());
        heldRequest.on('error', () => undefined);
        heldRequest.write('{"jsonrpc":"2.0"');
      });
      await withTimeout(heldSocketReady, 500);
      await new Promise<void>(resolve => setImmediate(resolve));

      const overloaded = await withTimeout(
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          rejectedRequest = httpRequest(
            server!.url,
            { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } },
            response => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', chunk => {
                body += chunk;
              });
              response.once('end', () => {
                try {
                  resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as unknown });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          rejectedRequest.once('socket', socket => {
            rejectedSocket = socket;
            socket.once('close', rejectedSocketClosed);
          });
          rejectedRequest.on('error', () => undefined);
          rejectedRequest.end(JSON.stringify({ jsonrpc: '2.0', method: 'overload' }));
        }),
        500,
      );

      expect(overloaded).toEqual({ status: 503, body: { error: 'fixture MCP HTTP overloaded' } });
      await withTimeout(socketClosed, 500);
      expect(rejectedSocket?.destroyed).toBe(true);
    } finally {
      heldRequest?.destroy();
      rejectedRequest?.destroy();
      await server?.close().catch(() => undefined);
    }
  });

  it('propagates standalone workspace cleanup failures', async () => {
    let attempts = 0;
    const workspace = await createDisposableFixtureWorkspace({
      mcpUrl: 'http://127.0.0.1:1234/mcp',
      hookRelayUrl: 'http://127.0.0.1:1235/hook',
      hookTimeoutMs: 1000,
      removePath: async path => {
        attempts += 1;
        if (attempts === 1) throw new Error('fixture workspace removal failed');
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(workspace.cleanup()).rejects.toThrow('fixture workspace removal failed');
    await workspace.cleanup();
  });

  it('uses an explicit bounded close for stdio servers', async () => {
    const server = {
      close: async () => await new Promise<void>(() => {}),
      getStdioTransport: () => ({ close: () => undefined }),
    } as unknown as ReturnType<typeof createFixtureMcpServer>;

    await expect(closeFixtureMcpStdioServer(server, 10)).rejects.toThrow('fixture MCP stdio shutdown timed out');
  });

  it('escalates an owned stdio shutdown after the graceful close times out', async () => {
    const server = { close: async () => await new Promise<void>(() => {}) } as unknown as ReturnType<typeof createFixtureMcpServer>;
    let forceCloseCalls = 0;

    await expect(
      closeFixtureMcpStdioServer(server, 10, () => {
        forceCloseCalls += 1;
      }),
    ).rejects.toThrow('fixture MCP stdio shutdown timed out');
    expect(forceCloseCalls).toBe(1);
  });

  it('reports graceful and forced stdio shutdown failures together', async () => {
    const gracefulError = new Error('fixture MCP graceful close failed');
    const forceError = new Error('fixture MCP force close failed');
    const server = {
      close: async () => {
        throw gracefulError;
      },
      getStdioTransport: () => ({ close: async () => { throw forceError; } }),
    } as unknown as ReturnType<typeof createFixtureMcpServer>;

    await expect(closeFixtureMcpStdioServer(server, 10)).rejects.toSatisfy(error => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([gracefulError, forceError]);
      return true;
    });
  });

  it('rejects credentials, wrong paths, queries, fragments, and non-loopback URLs', () => {
    const invalidMcpUrls = [
      'https://vendor.example/mcp',
      'http://localhost:1234/mcp',
      'http://user@127.0.0.1:1234/mcp',
      'http://user:password@127.0.0.1:1234/mcp',
      'http://127.0.0.1:1234/wrong',
      'http://127.0.0.1:1234/mcp?token=fixture',
      'http://127.0.0.1:1234/mcp#fragment',
    ];

    for (const mcpUrl of invalidMcpUrls) {
      expect(() =>
        createGeneratedFixtureConfig({
          mcpUrl,
          hookRelayUrl: 'http://127.0.0.1:1235/hook',
          hookTimeoutMs: 1000,
        }),
      ).toThrow('mcpUrl must be an http loopback URL');
    }

    for (const hookRelayUrl of [
      'http://user:password@127.0.0.1:1235/hook',
      'http://127.0.0.1:1235/other',
      'http://127.0.0.1:1235/hook?token=fixture',
      'http://127.0.0.1:1235/hook#fragment',
    ]) {
      expect(() =>
        createGeneratedFixtureConfig({
          mcpUrl: 'http://127.0.0.1:1234/mcp',
          hookRelayUrl,
          hookTimeoutMs: 1000,
        }),
      ).toThrow('hookRelayUrl must be an http loopback URL');
    }
  });

  it('rejects extra generated configuration fields at runtime', () => {
    const config = createGeneratedFixtureConfig({
      mcpUrl: 'http://127.0.0.1:1234/mcp',
      hookRelayUrl: 'http://127.0.0.1:1235/hook',
      hookTimeoutMs: 1000,
    });

    expect(() => assertProtocolFixtureConfig({ ...config, inheritedHooks: [] })).toThrow('invalid protocol fixture config');
    expect(() =>
      assertProtocolFixtureConfig({
        ...config,
        mcpServers: { ...config.mcpServers, inherited: { transport: 'http', url: 'http://127.0.0.1:1236/mcp' } },
      }),
    ).toThrow('invalid protocol fixture config');
  });
});

async function startRelayOrSkip(
  options: Pick<FixtureHookRelayOptions, 'handler' | 'timeoutMs' | 'maxInFlightRequests'> = {},
) {
  try {
    return await startFixtureHookRelay(options);
  } catch (error) {
    if (isLoopbackPermissionError(error)) return undefined;
    throw error;
  }
}

async function sendSlowBody(url: string, delayMs: number): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let finishTimer: NodeJS.Timeout | undefined;
    const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.once('end', () => {
        settled = true;
        if (finishTimer) clearTimeout(finishTimer);
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', error => {
      if (!settled) reject(error);
    });
    request.write('{"event":"slow"');
    finishTimer = setTimeout(() => {
      if (!settled) request.end(',"payload":{}}');
    }, delayMs);
  });
}

async function fetchHook(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isLoopbackPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === 'EPERM' || isLoopbackPermissionError(candidate.cause);
}
