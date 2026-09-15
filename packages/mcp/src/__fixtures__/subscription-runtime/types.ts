export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const PROTOCOL_FIXTURE_MODE = 'protocol-fixture' as const;
export type ProtocolFixtureMode = typeof PROTOCOL_FIXTURE_MODE;

export type FixtureEvent = {
  sequence: number;
  source: string;
  type: string;
  payload?: unknown;
};

export type FixtureToolInput = {
  value: string;
  delayMs?: number;
};

export type FixtureHookRequest = {
  event: string;
  payload?: unknown;
};

export type FixtureHookDecision = {
  decision: 'allow' | 'deny' | 'modify';
  reason?: string;
  input?: unknown;
  context?: string;
};

export type GeneratedFixtureConfig = {
  schemaVersion: 1;
  mode: ProtocolFixtureMode;
  mcpServers: {
    fixture: {
      transport: 'http';
      url: string;
    };
  };
  hookRelay: {
    transport: 'http';
    url: string;
    timeoutMs: number;
  };
  nativeTools: {
    enabled: false;
  };
};
