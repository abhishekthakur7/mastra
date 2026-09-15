import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { MCPServer } from '../../server/server';
import type { FixtureEventRecorder } from './event-recorder';
import type { FixtureToolInput } from './types';

export const fixtureToolInputSchema = z.object({
  value: z.string().min(1).max(128),
  delayMs: z.number().int().min(0).max(250).optional().default(0),
});

export const FIXTURE_MCP_SERVER_KEY = 'fixture' as const;
export const FIXTURE_MCP_TOOL_NAME = 'subscription_fixture_echo' as const;
export const FIXTURE_MCP_FULL_TOOL_NAME = `mcp__${FIXTURE_MCP_SERVER_KEY}__${FIXTURE_MCP_TOOL_NAME}` as const;

export const fixtureToolOutputSchema = z
  .object({
    value: z.string().min(1).max(128),
    source: z.literal('protocol-fixture'),
  })
  .strict();

export function createFixtureMcpServer(recorder?: FixtureEventRecorder): MCPServer {
  const fixtureTool = createTool({
    id: FIXTURE_MCP_TOOL_NAME,
    description: 'Returns a deterministic value without network, filesystem, or vendor side effects.',
    inputSchema: fixtureToolInputSchema,
    outputSchema: fixtureToolOutputSchema,
    execute: async (input: FixtureToolInput) => {
      recorder?.record('mcp-fixture', 'tool-call', { toolId: FIXTURE_MCP_TOOL_NAME, input });
      if (input.delayMs) await new Promise(resolve => setTimeout(resolve, input.delayMs));
      const output = { value: input.value, source: 'protocol-fixture' as const };
      recorder?.record('mcp-fixture', 'tool-result', output);
      return output;
    },
  });

  return new MCPServer({
    name: 'subscription-runtime-fixture',
    version: '0.1.0',
    // This fixture intentionally exposes one server with one tool.  The
    // launch profile's fully-qualified allow rule is derived from the same
    // fixed names, while the host transport still validates the short MCP
    // tool ID at its boundary.
    tools: { [FIXTURE_MCP_TOOL_NAME]: fixtureTool },
  });
}

export type FixtureMcpHttpServer = {
  readonly url: string;
  readonly mcpServer: MCPServer;
  close(): Promise<void>;
};

export type FixtureMcpHttpServerOptions = {
  closeTimeoutMs?: number;
  maxActiveConnections?: number;
  mcpServer?: MCPServer;
};

const STDIO_CLOSE_TIMEOUT_MS = 1_000;
const MAX_STDIO_CLOSE_TIMEOUT_MS = 5_000;
const HTTP_CLOSE_TIMEOUT_MS = 1_000;
const MAX_HTTP_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ACTIVE_HTTP_CONNECTIONS = 16;
const MAX_ACTIVE_HTTP_CONNECTIONS = 128;
const HTTP_OVERLOAD_BODY = JSON.stringify({ error: 'fixture MCP HTTP overloaded' });

export function shouldAcceptFixtureMcpHttpConnection(activeConnections: number, maxActiveConnections: number): boolean {
  return activeConnections < maxActiveConnections;
}

export async function startFixtureMcpHttpServer(
  recorder?: FixtureEventRecorder,
  options: FixtureMcpHttpServerOptions = {},
): Promise<FixtureMcpHttpServer> {
  const mcpServer = options.mcpServer ?? createFixtureMcpServer(recorder);
  const closeTimeoutMs = boundedCloseTimeout(options.closeTimeoutMs);
  const maxActiveConnections = boundedMaxActiveConnections(options.maxActiveConnections);
  const sockets = new Set<Socket>();
  const httpServer = createServer((request, response) => {
    void mcpServer
      .startHTTP({
        url: new URL(request.url ?? '/', 'http://127.0.0.1'),
        httpPath: '/mcp',
        req: request,
        res: response,
        options: { serverless: true, serverlessStreaming: true, sessionIdGenerator: undefined },
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'fixture MCP request failed' }));
        }
      });
  });
  httpServer.on('connection', socket => {
    if (!shouldAcceptFixtureMcpHttpConnection(sockets.size, maxActiveConnections)) {
      rejectOverloadedConnection(socket);
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const url = await listen(httpServer);
  let closePromise: Promise<void> | undefined;
  return {
    url,
    mcpServer,
    close: async () => {
      if (!closePromise) {
        closePromise = closeMcpHttpServer(httpServer, sockets, mcpServer, closeTimeoutMs);
      }
      return closePromise;
    },
  };
}

export async function startFixtureMcpStdioServer(recorder?: FixtureEventRecorder): Promise<MCPServer> {
  const server = createFixtureMcpServer(recorder);
  await server.startStdio();
  return server;
}

export async function closeFixtureMcpStdioServer(
  server: MCPServer,
  timeoutMs = STDIO_CLOSE_TIMEOUT_MS,
  forceClose?: () => Promise<void> | void,
): Promise<void> {
  const boundedTimeoutMs = boundedStdioCloseTimeout(timeoutMs);
  const ownedForceClose = forceClose ?? (() => closeOwnedStdioTransport(server));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('fixture MCP stdio shutdown timed out')), boundedTimeoutMs);
        timeout.unref();
      }),
    ]);
  } catch (error) {
    try {
      await withTimeout(Promise.resolve(ownedForceClose()), boundedTimeoutMs, 'fixture MCP stdio force shutdown timed out');
    } catch (forceError) {
      throw new AggregateError([error, forceError], 'fixture MCP stdio shutdown and force close failed');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeOwnedStdioTransport(server: MCPServer): Promise<void> | void {
  const transport = server.getStdioTransport();
  if (!transport) throw new Error('fixture MCP stdio transport is not owned or available for force shutdown');
  return transport.close?.();
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture MCP server did not bind to a loopback port'));
        return;
      }
      resolve(`http://127.0.0.1:${(address as AddressInfo).port}/mcp`);
    });
  });
}

async function closeMcpHttpServer(
  httpServer: Server,
  sockets: Set<Socket>,
  mcpServer: MCPServer,
  timeoutMs: number,
): Promise<void> {
  const errors: unknown[] = [];

  try {
    await closeServer(httpServer, sockets, timeoutMs);
  } catch (error) {
    errors.push(error);
  }

  try {
    await withTimeout(Promise.resolve(mcpServer.close()), timeoutMs, 'fixture MCP HTTP shutdown timed out');
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'fixture MCP HTTP shutdown failed');
}

function closeServer(server: Server, sockets: Set<Socket>, timeoutMs: number): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      destroyConnections(server, sockets);
      resolve();
      return;
    }

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      destroyConnections(server, sockets);
      settled = true;
      reject(new Error('fixture MCP HTTP shutdown timed out'));
    }, timeoutMs);
    timeout.unref();

    server.close(error => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });

    // A fixture shutdown owns every socket accepted by this server. Ending
    // active connections immediately makes close deterministic for a client
    // that deliberately keeps an MCP request open.
    destroyConnections(server, sockets);
  });
}

function destroyConnections(server: Server, sockets: Set<Socket>): void {
  server.closeAllConnections?.();
  for (const socket of sockets) socket.destroy();
}

function rejectOverloadedConnection(socket: Socket): void {
  if (socket.destroyed) return;

  socket.once('error', () => socket.destroy());
  socket.end(
    [
      'HTTP/1.1 503 Service Unavailable',
      'Connection: close',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(HTTP_OVERLOAD_BODY)}`,
      '',
      HTTP_OVERLOAD_BODY,
    ].join('\r\n'),
    () => socket.destroy(),
  );
}

function boundedCloseTimeout(value: number | undefined): number {
  if (value === undefined) return HTTP_CLOSE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HTTP_CLOSE_TIMEOUT_MS) {
    throw new Error(`MCP HTTP close timeout must be an integer between 1 and ${MAX_HTTP_CLOSE_TIMEOUT_MS}`);
  }
  return value;
}

function boundedMaxActiveConnections(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ACTIVE_HTTP_CONNECTIONS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_HTTP_CONNECTIONS) {
    throw new Error(`MCP HTTP max active connections must be an integer between 1 and ${MAX_ACTIVE_HTTP_CONNECTIONS}`);
  }
  return value;
}

function boundedStdioCloseTimeout(value: number | undefined): number {
  if (value === undefined) return STDIO_CLOSE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_STDIO_CLOSE_TIMEOUT_MS) {
    throw new Error(`MCP stdio close timeout must be an integer between 1 and ${MAX_STDIO_CLOSE_TIMEOUT_MS}`);
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
