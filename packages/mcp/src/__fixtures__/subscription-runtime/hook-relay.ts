import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod/v3';
import type { FixtureEventRecorder } from './event-recorder';
import type { FixtureHookDecision, FixtureHookRequest } from './types';

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DECISION_STRING_BYTES = 4 * 1024;
const MAX_DECISION_INPUT_BYTES = 64 * 1024;
const MAX_DECISION_INPUT_DEPTH = 16;
const MAX_DECISION_INPUT_NODES = 512;
const MAX_DECISION_INPUT_KEYS = 128;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 16;
const MAX_IN_FLIGHT_REQUESTS = 1_000;

const fixtureHookDecisionStringSchema = z.string().refine(value => isWithinByteLimit(value, MAX_DECISION_STRING_BYTES), {
  message: `hook decision strings must be at most ${MAX_DECISION_STRING_BYTES} bytes`,
});

const fixtureHookDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'deny', 'modify']),
    reason: fixtureHookDecisionStringSchema.optional(),
    input: z.unknown().optional().refine(value => value === undefined || isBoundedJsonValue(value), {
      message: 'hook decision input must be bounded JSON',
    }),
    context: fixtureHookDecisionStringSchema.optional(),
  })
  .strict();

export type FixtureHookHandler = (
  request: FixtureHookRequest,
  context: { signal: AbortSignal },
) => FixtureHookDecision | Promise<FixtureHookDecision>;

export type FixtureHookRelay = {
  readonly url: string;
  close(): Promise<void>;
};

export type FixtureHookRelayOptions = {
  handler?: FixtureHookHandler;
  recorder?: FixtureEventRecorder;
  timeoutMs?: number;
  maxInFlightRequests?: number;
};

type RelayErrorCode =
  | 'body-timeout'
  | 'body-too-large'
  | 'client-aborted'
  | 'handler-timeout'
  | 'shutdown'
  | 'invalid-decision';

class FixtureHookRelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = 'FixtureHookRelayError';
    this.code = code;
  }
}

type InFlightRequest = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly controller: AbortController;
};

export async function startFixtureHookRelay(options: FixtureHookRelayOptions = {}): Promise<FixtureHookRelay> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const maxInFlightRequests = boundedMaxInFlightRequests(options.maxInFlightRequests);
  const handler = options.handler ?? (() => ({ decision: 'allow' as const }));
  const inFlight = new Set<InFlightRequest>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (closing) {
      writeJson(response, 503, { error: 'hook relay is shutting down' });
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (inFlight.size >= maxInFlightRequests) {
      writeJson(response, 503, { error: 'hook relay overloaded' });
      destroyRequestAfterResponse(request, response);
      return;
    }

    const entry: InFlightRequest = { request, response, controller: new AbortController() };
    inFlight.add(entry);
    request.once('aborted', () => abort(entry.controller, new FixtureHookRelayError('client-aborted', 'client aborted')));
    response.once('close', () => {
      if (!response.writableEnded) {
        abort(entry.controller, new FixtureHookRelayError('client-aborted', 'client disconnected'));
      }
    });
    void handleRequest(request, response, handler, options.recorder, timeoutMs, entry.controller, () => closing).finally(() => {
      inFlight.delete(entry);
    });
  });

  const url = await listen(server);
  return {
    url,
    close: async () => {
      if (!closePromise) {
        closing = true;
        for (const entry of inFlight) {
          abort(entry.controller, new FixtureHookRelayError('shutdown', 'hook relay is shutting down'));
          entry.request.destroy();
          entry.response.destroy();
        }
        closePromise = closeServer(server);
      }
      return closePromise;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: FixtureHookHandler,
  recorder: FixtureEventRecorder | undefined,
  timeoutMs: number,
  controller: AbortController,
  isClosing: () => boolean,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/hook') {
    writeJson(response, 404, { error: 'not found' });
    return;
  }

  if (isClosing()) return;

  let body: string;
  try {
    body = await readBody(request, controller.signal, timeoutMs);
  } catch (error) {
    if (isSilentAbort(error, response, isClosing)) return;
    if (isRelayError(error, 'body-timeout')) {
      abort(controller, error);
      writeJson(response, 408, { error: 'hook request body timeout' });
      destroyRequestAfterResponse(request, response);
      return;
    }
    if (isRelayError(error, 'body-too-large')) {
      writeJson(response, 413, { error: error.message });
      destroyRequestAfterResponse(request, response);
      return;
    }
    writeJson(response, 400, { error: 'invalid hook payload' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    writeJson(response, 400, { error: 'invalid hook payload' });
    return;
  }
  if (!isHookRequest(parsed)) {
    writeJson(response, 400, { error: 'invalid hook payload' });
    return;
  }

  recorder?.record('hook-relay', 'request', parsed);
  const handlerDeadline = setTimeout(() => {
    abort(controller, new FixtureHookRelayError('handler-timeout', 'hook relay timeout'));
  }, timeoutMs);
  handlerDeadline.unref();
  try {
    const decision = await raceWithAbort(
      Promise.resolve().then(() => handler(parsed, { signal: controller.signal })),
      controller.signal,
    );
    const validatedDecision = parseFixtureHookDecision(decision);
    if (!validatedDecision) {
      throw new FixtureHookRelayError('invalid-decision', 'invalid hook decision');
    }
    if (!isResponseBodyWithinLimit(validatedDecision)) {
      throw new FixtureHookRelayError('invalid-decision', 'invalid hook decision');
    }
    recorder?.record('hook-relay', 'decision', validatedDecision);
    writeJson(response, 200, validatedDecision);
  } catch (error) {
    if (isSilentAbort(error, response, isClosing)) return;
    const timedOut = isRelayError(error, 'handler-timeout');
    const invalidDecision = isRelayError(error, 'invalid-decision');
    recorder?.record('hook-relay', timedOut ? 'timeout' : 'error', {
      message: timedOut ? 'hook relay timeout' : 'hook handler failed',
    });
    writeJson(response, timedOut ? 504 : 500, {
      error: timedOut ? 'hook relay timeout' : invalidDecision ? 'invalid hook decision' : 'hook relay failed',
    });
  } finally {
    clearTimeout(handlerDeadline);
  }
}

function isHookRequest(value: unknown): value is FixtureHookRequest {
  return !!value && typeof value === 'object' && typeof (value as { event?: unknown }).event === 'string';
}

function parseFixtureHookDecision(value: unknown): FixtureHookDecision | undefined {
  try {
    const result = fixtureHookDecisionSchema.safeParse(value);
    return result.success ? (result.data as FixtureHookDecision) : undefined;
  } catch {
    return undefined;
  }
}

type JsonInspectionState = {
  bytes: number;
  nodes: number;
  seen: WeakSet<object>;
};

type JsonInspectionLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxStringBytes: number;
};

const decisionInputLimits: JsonInspectionLimits = {
  maxBytes: MAX_DECISION_INPUT_BYTES,
  maxDepth: MAX_DECISION_INPUT_DEPTH,
  maxNodes: MAX_DECISION_INPUT_NODES,
  maxObjectKeys: MAX_DECISION_INPUT_KEYS,
  maxStringBytes: MAX_DECISION_STRING_BYTES,
};

const responseBodyLimits: JsonInspectionLimits = {
  ...decisionInputLimits,
  maxBytes: MAX_RESPONSE_BODY_BYTES,
};

function isBoundedJsonValue(value: unknown): boolean {
  return inspectJsonValue(value, decisionInputLimits, { bytes: 0, nodes: 0, seen: new WeakSet() }, 0);
}

function isResponseBodyWithinLimit(value: unknown): boolean {
  return inspectJsonValue(value, responseBodyLimits, { bytes: 0, nodes: 0, seen: new WeakSet() }, 0);
}

function inspectJsonValue(
  value: unknown,
  limits: JsonInspectionLimits,
  state: JsonInspectionState,
  depth: number,
): boolean {
  if (depth > limits.maxDepth || state.nodes >= limits.maxNodes) return false;
  state.nodes += 1;

  if (value === null) return addJsonBytes(state, 4, limits.maxBytes);
  if (typeof value === 'string') {
    return (
      isWithinByteLimit(value, limits.maxStringBytes) &&
      addJsonBytes(state, jsonStringByteLength(value), limits.maxBytes)
    );
  }
  if (typeof value === 'boolean') return addJsonBytes(state, value ? 4 : 5, limits.maxBytes);
  if (typeof value === 'number') {
    const serialized = JSON.stringify(value);
    return Number.isFinite(value) && serialized !== undefined && addJsonBytes(state, Buffer.byteLength(serialized), limits.maxBytes);
  }
  if (typeof value !== 'object' || value === null || state.seen.has(value)) return false;

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxObjectKeys || !addJsonBytes(state, 2, limits.maxBytes)) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (!inspectJsonValue(value[index], limits, state, depth + 1)) return false;
        if (index < value.length - 1 && !addJsonBytes(state, 1, limits.maxBytes)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    if (keys.length > limits.maxObjectKeys || !addJsonBytes(state, 2, limits.maxBytes)) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) return false;
      if (
        !isWithinByteLimit(key, limits.maxStringBytes) ||
        !addJsonBytes(state, jsonStringByteLength(key) + 1, limits.maxBytes) ||
        !inspectJsonValue((value as Record<string, unknown>)[key], limits, state, depth + 1)
      ) {
        return false;
      }
      if (index < keys.length - 1 && !addJsonBytes(state, 1, limits.maxBytes)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    state.seen.delete(value);
  }
}

function addJsonBytes(state: JsonInspectionState, bytes: number, maxBytes: number): boolean {
  state.bytes += bytes;
  return state.bytes <= maxBytes;
}

function isWithinByteLimit(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function jsonStringByteLength(value: string): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, 'utf8');
}

function readBody(request: IncomingMessage, signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      signal.removeEventListener('abort', onAbort);
      if (deadline) clearTimeout(deadline);
    };
    const finish = (callback: (value: string) => void, value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        fail(new FixtureHookRelayError('body-too-large', 'hook payload too large'));
        return;
      }
      body += chunk;
    };
    const onEnd = () => finish(resolve, body);
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new FixtureHookRelayError('client-aborted', 'client aborted'));
    const onAbort = () => fail(abortReason(signal));

    request.setEncoding('utf8');
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    signal.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => {
      fail(new FixtureHookRelayError('body-timeout', 'hook request body timeout'));
    }, timeoutMs);
    deadline.unref();
    if (signal.aborted) onAbort();
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  if (!isResponseBodyWithinLimit(body)) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'hook relay response too large' }));
    return;
  }
  let serializedBody: string | undefined;
  try {
    serializedBody = JSON.stringify(body);
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'hook relay response unavailable' }));
    return;
  }
  if (serializedBody === undefined || Buffer.byteLength(serializedBody, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'hook relay response too large' }));
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(serializedBody);
}

function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  const destroy = () => {
    if (!request.destroyed) request.destroy();
  };
  if (response.writableFinished) destroy();
  else response.once('finish', destroy);
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`hook timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function boundedMaxInFlightRequests(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_IN_FLIGHT_REQUESTS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_IN_FLIGHT_REQUESTS) {
    throw new Error(`maxInFlightRequests must be an integer between 1 and ${MAX_IN_FLIGHT_REQUESTS}`);
  }
  return value;
}

function abort(controller: AbortController, reason: Error): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new FixtureHookRelayError('client-aborted', 'hook request aborted');
}

function isRelayError(error: unknown, code: RelayErrorCode): error is FixtureHookRelayError {
  return error instanceof FixtureHookRelayError && error.code === code;
}

function isSilentAbort(error: unknown, response: ServerResponse, isClosing: () => boolean): boolean {
  return (
    isClosing() ||
    response.destroyed ||
    isRelayError(error, 'shutdown') ||
    isRelayError(error, 'client-aborted')
  );
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture hook relay did not bind to a loopback port'));
        return;
      }
      resolve(`http://127.0.0.1:${(address as AddressInfo).port}/hook`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      server.closeAllConnections?.();
      settled = true;
      reject(new Error('fixture hook relay shutdown timed out'));
    }, CLOSE_TIMEOUT_MS);
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
    server.closeAllConnections?.();
  });
}
