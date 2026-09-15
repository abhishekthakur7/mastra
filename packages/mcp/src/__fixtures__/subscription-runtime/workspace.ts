import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { BoundedResourceScope } from './process-cleanup';
import type { GeneratedFixtureConfig } from './types';
import { PROTOCOL_FIXTURE_MODE } from './types';

const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const HOOK_PATH = '/hook';

const generatedFixtureConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal(PROTOCOL_FIXTURE_MODE),
    mcpServers: z
      .object({
        fixture: z
          .object({
            transport: z.literal('http'),
            url: z.string(),
          })
          .strict(),
      })
      .strict(),
    hookRelay: z
      .object({
        transport: z.literal('http'),
        url: z.string(),
        timeoutMs: z.number().int().min(1).max(5_000),
      })
      .strict(),
    nativeTools: z.object({ enabled: z.literal(false) }).strict(),
  })
  .strict()
  .superRefine((config, context) => {
    addLoopbackIssue(config.mcpServers.fixture.url, MCP_PATH, 'mcpServers.fixture.url', context);
    addLoopbackIssue(config.hookRelay.url, HOOK_PATH, 'hookRelay.url', context);
  });

export type FixtureWorkspace = {
  readonly root: string;
  readonly projectDir: string;
  readonly configPath: string;
  readonly config: GeneratedFixtureConfig;
  cleanup(): Promise<void>;
};

export async function createDisposableFixtureWorkspace(options: {
  mcpUrl: string;
  hookRelayUrl: string;
  hookTimeoutMs: number;
  resourceScope?: BoundedResourceScope;
  removePath?: (path: string) => Promise<void>;
}): Promise<FixtureWorkspace> {
  const removePath = options.removePath ?? (async path => rm(path, { recursive: true, force: true }));
  const root = options.resourceScope
    ? await options.resourceScope.createTempDirectory('mastra-subscription-runtime-fixture-')
    : await mkdtemp(join(tmpdir(), 'mastra-subscription-runtime-fixture-'));

  try {
    const projectDir = join(root, 'project');
    const configDir = join(projectDir, '.subscription-runtime');
    const configPath = join(configDir, 'fixture-config.json');
    await mkdir(configDir, { recursive: true });

    const config = createGeneratedFixtureConfig(options);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return {
      root,
      projectDir,
      configPath,
      config,
      cleanup: async () => {
        await removePath(root);
      },
    };
  } catch (error) {
    // The caller may have no workspace handle yet. The root was created by
    // this function, so it is safe to remove exactly this path on every
    // intermediate failure.
    try {
      await removePath(root);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'failed to create and clean up fixture workspace');
    }
    throw error;
  }
}

export function createGeneratedFixtureConfig(options: {
  mcpUrl: string;
  hookRelayUrl: string;
  hookTimeoutMs: number;
}): GeneratedFixtureConfig {
  assertLoopbackUrl(options.mcpUrl, 'mcpUrl', MCP_PATH);
  assertLoopbackUrl(options.hookRelayUrl, 'hookRelayUrl', HOOK_PATH);
  const config = {
    schemaVersion: 1,
    mode: PROTOCOL_FIXTURE_MODE,
    mcpServers: { fixture: { transport: 'http', url: options.mcpUrl } },
    hookRelay: { transport: 'http', url: options.hookRelayUrl, timeoutMs: options.hookTimeoutMs },
    nativeTools: { enabled: false },
  };
  assertProtocolFixtureConfig(config);
  return config;
}

export async function readGeneratedFixtureConfig(configPath: string): Promise<GeneratedFixtureConfig> {
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  assertProtocolFixtureConfig(parsed);
  return parsed as GeneratedFixtureConfig;
}

export function assertProtocolFixtureConfig(config: unknown): asserts config is GeneratedFixtureConfig {
  const result = generatedFixtureConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`invalid protocol fixture config: ${result.error.issues[0]?.message ?? 'schema validation failed'}`);
  }
}

function assertLoopbackUrl(value: string, label: string, expectedPath: string): void {
  if (!isExactLoopbackUrl(value, expectedPath)) throw new Error(`${label} must be an http loopback URL`);
}

function addLoopbackIssue(value: string, expectedPath: string, label: string, context: z.RefinementCtx): void {
  if (!isExactLoopbackUrl(value, expectedPath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: label.split('.'),
      message: `${label} must be an exact loopback ${expectedPath} URL`,
    });
  }
}

function isExactLoopbackUrl(value: string, expectedPath: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === LOOPBACK_HOST &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === expectedPath &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.href === `http://${LOOPBACK_HOST}:${url.port}${expectedPath}`
    );
  } catch {
    return false;
  }
}
