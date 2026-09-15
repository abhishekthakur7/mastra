/**
 * Strict launch policy for the Claude subscription-runtime fixture.
 *
 * This module deliberately builds data only. It does not discover a user's
 * Claude installation, read settings, write the MCP config, or run a model
 * turn. Authentication metadata is consumed only through the separate,
 * bounded status probe.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type ClaudeAuthMethod = 'none' | 'subscription' | 'apiKey' | 'unknown';
export type ClaudeApiProvider = 'firstParty' | 'apiKey' | 'unknown';

export type ClaudeAuthEvidence = {
  loggedIn: boolean;
  authMethod: ClaudeAuthMethod;
  apiProvider: ClaudeApiProvider;
  exitCode: number;
  blocked: boolean;
  blockedReason?:
    | 'status-command-failed'
    | 'not-authenticated'
    | 'api-key-authentication'
    | 'external-provider'
    | 'unknown-authentication';
};

export type ClaudeVersionEvidence = {
  available: boolean;
  exitCode: number;
  version?: string;
};

export type ClaudeOwnedPaths = {
  /** The disposable root that owns every path below. */
  ownedRoot?: string;
  /** A disposable, caller-owned working directory for the child process. */
  cwd: string;
  /** A disposable, caller-owned temporary directory. */
  tmpDir: string;
  /** The caller-owned path where the generated MCP config will be written. */
  mcpConfigPath: string;
  /**
   * The workspace creator must reject symlinked paths before launch. This
   * data-only profile applies the policy marker but cannot inspect the file
   * system without making path existence an implicit requirement.
   */
  symlinkPolicy?: 'reject-unvalidated';
};

export type ClaudeMcpServer = {
  type?: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export type ClaudeMcpConfig = {
  mcpServers: Record<string, ClaudeMcpServer>;
};

export type ClaudeInheritedRuntimeState = {
  mcpServers?: unknown;
  tools?: unknown;
  hooks?: unknown;
  settings?: unknown;
  extensions?: unknown;
};

export type ClaudeLaunchProfileInput = {
  paths: ClaudeOwnedPaths;
  /** The executable is informational to the launcher; argv is always strict. */
  executable?: string;
  /** Explicit servers only. No server discovery or inherited server merge occurs. */
  mcpServers?: Readonly<Record<string, ClaudeMcpServer>>;
  /** Optional raw config input, accepted solely to apply the top-level key check. */
  mcpConfig?: unknown;
  /** When supplied, server names outside this allow-list are rejected. */
  allowedMcpServers?: readonly string[];
  /** Custom extensions are disabled by the safe launch profile. */
  pluginDirs?: readonly string[];
  /** Environment to sanitize before adding real HOME and owned TMPDIR. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Presence of any inherited runtime seam is a hard failure, even when empty. */
  inherited?: ClaudeInheritedRuntimeState;
  inheritedMcpServers?: unknown;
  inheritedTools?: unknown;
  inheritedHooks?: unknown;
  inheritedSettings?: unknown;
  inheritedExtensions?: unknown;
  /** Optional output from the CLI's supported auth-status surface. */
  authStatusRaw?: unknown;
  authExitCode?: number;
  /** Output from a separate successful `--version` probe; never reuse auth output. */
  versionStatusRaw?: unknown;
  versionExitCode?: number;
};

export const CLAUDE_FIXTURE_MCP_SERVER_NAME = 'fixture' as const;
export const CLAUDE_FIXTURE_MCP_TOOL_NAME = 'mcp__fixture__subscription_fixture_echo' as const;

/**
 * The tool-capable profile is a separate, explicit opt-in from the metadata
 * and no-tool Claude profile.  It still uses strict settings and admits only
 * the harmless fixture MCP tool; native/ambient tools remain disabled.
 */
export type ClaudeToolCapability = {
  enabled: true;
  allowedMcpServer: typeof CLAUDE_FIXTURE_MCP_SERVER_NAME;
  /** Claude's fully-qualified MCP tool name; this is an approval rule, not a catalog whitelist. */
  allowedTool: typeof CLAUDE_FIXTURE_MCP_TOOL_NAME;
  ambientTools: 'disabled';
};

export type ClaudeToolLaunchProfileInput = ClaudeLaunchProfileInput & {
  toolOptIn: true;
  allowedTools?: readonly [typeof CLAUDE_FIXTURE_MCP_TOOL_NAME];
};

export type ClaudeLaunchSettings = {
  safeMode: boolean;
  restrictedMode?: boolean;
  settingSources: readonly [];
  nativeTools: readonly [];
  pluginDirs: readonly [];
  strictMcpConfig: true;
};

export type ClaudeLaunchProfile = {
  executable?: string;
  ownedRoot?: string;
  cwd: string;
  tmpDir: string;
  mcpConfigPath: string;
  argv: readonly string[];
  env: Record<string, string>;
  settings: ClaudeLaunchSettings;
  mcpConfig: ClaudeMcpConfig;
  mcpConfigJson: string;
  authEvidence: ClaudeAuthEvidence;
  versionEvidence: ClaudeVersionEvidence;
  readiness: 'blocked' | 'ready';
  readonly toolCapability?: ClaudeToolCapability;
};

export type ClaudeToolLaunchProfile = ClaudeLaunchProfile & {
  readonly toolCapability: ClaudeToolCapability;
};

export type ClaudeMaterializedLaunchProfile = ClaudeLaunchProfile & {
  readonly workspace: ClaudeOwnedWorkspace;
};

export type ClaudeOwnedWorkspace = {
  readonly root: string;
  readonly paths: ClaudeOwnedPaths & { ownedRoot: string };
  cleanup(): Promise<void>;
};

type ClaudeWorkspaceFileSystem = Pick<ClaudeFileSystem, 'lstat' | 'realpath'>;

export type ClaudeFileSystem = {
  lstat(path: string): Promise<ClaudePathStat>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: string | number, mode?: number): Promise<ClaudeFileHandle>;
  unlink(path: string): Promise<void>;
  readFile?(path: string, encoding: 'utf8'): Promise<string>;
};

type ClaudePathStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
  dev?: number;
  ino?: number;
};

type ClaudeFileHandle = {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  close(): Promise<void>;
};

export type ClaudePathValidationOptions = {
  /** Required for profiles built from plain paths; never inferred from cwd. */
  ownedRoot?: string;
  workspace?: ClaudeOwnedWorkspace;
  filesystem?: ClaudeFileSystem;
  /** Allow only the exact config previously materialized by this profile. */
  allowMaterializedConfig?: boolean;
};

export type ClaudeMcpMaterialization = {
  path: string;
  bytes: number;
};

class ClaudeLaunchProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeLaunchProfileError';
  }
}

export { ClaudeLaunchProfileError };

type OpaqueWorkspaceRecord = {
  root: string;
  paths: ClaudeOwnedPaths & { ownedRoot: string };
  directoryEvidence: Readonly<Record<WorkspaceDirectoryKey, ClaudeDirectoryEvidence>>;
};

type WorkspaceDirectoryKey = 'root' | 'cwd' | 'tmpDir' | 'mcpConfigParent';

const opaqueWorkspaces = new WeakMap<object, OpaqueWorkspaceRecord>();
const opaqueWorkspaceRoots = new Map<string, ClaudeOwnedWorkspace>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ClaudeLaunchProfileError(`${label} must be a non-empty string`);
  }
}

function assertOwnedAbsolutePath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!isAbsolute(value)) {
    throw new ClaudeLaunchProfileError(`${label} must be an absolute caller-owned path`);
  }
  if (value.split('/').some(segment => segment === '..')) {
    throw new ClaudeLaunchProfileError(`${label} must not contain traversal segments`);
  }
}

function resolveWithinRoot(value: unknown, root: string, label: string): string {
  assertNonEmptyString(value, label);
  if (value.includes('\0')) {
    throw new ClaudeLaunchProfileError(`${label} must be a valid caller-owned path`);
  }
  if (value.split(/[\\/]/).some(segment => segment === '..')) {
    throw new ClaudeLaunchProfileError(`${label} must not contain traversal segments`);
  }

  // Keep this lexical: the fixture must not probe paths that may not exist yet.
  // `relative` also avoids prefix-collision escapes such as /root-elsewhere.
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(canonicalRoot, value);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ClaudeLaunchProfileError(`${label} must resolve within paths.cwd`);
  }
  return canonicalPath;
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 4_096)) {
    throw new ClaudeLaunchProfileError(`${label} must contain only non-empty strings`);
  }
}

function assertNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ClaudeLaunchProfileError(`${label} contains unknown key: ${key}`);
    }
  }
}

function cloneMcpServer(raw: unknown, serverName: string): ClaudeMcpServer {
  if (!isRecord(raw)) {
    throw new ClaudeLaunchProfileError(`MCP server ${serverName} must be an object`);
  }
  assertNoUnknownKeys(raw, ['type', 'url', 'command', 'args', 'env'], `MCP server ${serverName}`);

  if (raw.type !== undefined && raw.type !== 'http' && raw.type !== 'sse' && raw.type !== 'stdio') {
    throw new ClaudeLaunchProfileError(`MCP server ${serverName} has an unsupported type`);
  }
  if (raw.url !== undefined) assertNonEmptyString(raw.url, `MCP server ${serverName}.url`);
  if (raw.command !== undefined) assertNonEmptyString(raw.command, `MCP server ${serverName}.command`);
  if (raw.args !== undefined) assertStringArray(raw.args, `MCP server ${serverName}.args`);
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      throw new ClaudeLaunchProfileError(`MCP server ${serverName}.env must be an object`);
    }
    for (const [key, value] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
        throw new ClaudeLaunchProfileError(`MCP server ${serverName}.env must contain plain string variables`);
      }
      if (isApiKeyOrProviderVariable(key) || isCredentialLikeVariable(key)) {
        throw new ClaudeLaunchProfileError(`MCP server ${serverName}.env contains a credential-like variable: ${key}`);
      }
    }
  }

  if (serverName !== 'fixture' || raw.type !== 'http' || typeof raw.url !== 'string' || !isFixtureMcpUrl(raw.url)) {
    throw new ClaudeLaunchProfileError(
      `MCP server ${serverName} must be the exact loopback subscription fixture HTTP server`,
    );
  }
  if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined) {
    throw new ClaudeLaunchProfileError(`MCP server ${serverName} cannot load commands or environment variables`);
  }

  const server: ClaudeMcpServer = {};
  if (raw.type !== undefined) server.type = raw.type;
  if (raw.url !== undefined) server.url = raw.url;
  if (raw.command !== undefined) server.command = raw.command;
  if (raw.args !== undefined) server.args = [...raw.args];
  if (raw.env !== undefined) server.env = { ...(raw.env as Record<string, string>) };
  return server;
}

function buildStrictMcpConfig(input: Pick<ClaudeLaunchProfileInput, 'mcpServers' | 'mcpConfig' | 'allowedMcpServers'>): ClaudeMcpConfig {
  let rawServers: unknown = input.mcpServers ?? {};

  if (input.mcpConfig !== undefined) {
    if (!isRecord(input.mcpConfig)) {
      throw new ClaudeLaunchProfileError('mcpConfig must be an object');
    }
    assertNoUnknownKeys(input.mcpConfig, ['mcpServers'], 'mcpConfig');
    if (!hasOwn(input.mcpConfig, 'mcpServers')) {
      throw new ClaudeLaunchProfileError('mcpConfig.mcpServers is required');
    }
    if (input.mcpServers !== undefined) {
      throw new ClaudeLaunchProfileError('provide explicit MCP servers only once');
    }
    rawServers = input.mcpConfig.mcpServers;
  }

  if (!isRecord(rawServers)) {
    throw new ClaudeLaunchProfileError('mcpServers must be an object');
  }
  const allowedNames = input.allowedMcpServers;
  if (allowedNames !== undefined) {
    assertStringArray(allowedNames, 'allowedMcpServers');
    if (new Set(allowedNames).size !== allowedNames.length) {
      throw new ClaudeLaunchProfileError('allowedMcpServers must not contain duplicates');
    }
    if (allowedNames.length !== 1 || allowedNames[0] !== 'fixture') {
      throw new ClaudeLaunchProfileError('allowedMcpServers must contain only the subscription fixture');
    }
  }

  const mcpServers: Record<string, ClaudeMcpServer> = {};
  for (const [name, server] of Object.entries(rawServers)) {
    if (name.length === 0) throw new ClaudeLaunchProfileError('MCP server names must be non-empty');
    if (allowedNames !== undefined && !allowedNames.includes(name)) {
      throw new ClaudeLaunchProfileError(`extra MCP server rejected: ${name}`);
    }
    mcpServers[name] = cloneMcpServer(server, name);
  }
  if (Object.keys(mcpServers).length !== 1 || !hasOwn(mcpServers, 'fixture')) {
    throw new ClaudeLaunchProfileError('strict MCP config must contain only the subscription fixture');
  }
  return { mcpServers };
}

const MAX_MCP_CONFIG_BYTES = 16 * 1024;

function serializeStrictMcpConfig(config: ClaudeMcpConfig): string {
  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_MCP_CONFIG_BYTES) {
    throw new ClaudeLaunchProfileError(`strict MCP config exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
  }
  return json;
}

/** Build the single source of truth for the strict Claude global options. */
export function buildClaudeStrictArgv(mcpConfigPath: string): readonly string[] {
  assertOwnedAbsolutePath(mcpConfigPath, 'mcpConfigPath');
  return [
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    resolve(mcpConfigPath),
    '--setting-sources',
    '',
  ];
}

/**
 * The documented tool-capable launch deliberately omits --safe-mode because
 * safe mode disables MCP. Restricted mode disables the built-in execution
 * tools, while --tools "" makes that intent explicit and --allowedTools
 * auto-approves only the exact fixture MCP tool. The host still publishes and
 * enforces the catalog separately; --allowedTools is never treated as one.
 */
export function buildClaudeToolStrictArgv(mcpConfigPath: string): readonly string[] {
  assertOwnedAbsolutePath(mcpConfigPath, 'mcpConfigPath');
  return [
    '--restricted',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    resolve(mcpConfigPath),
    '--setting-sources',
    '',
    '--allowedTools',
    CLAUDE_FIXTURE_MCP_TOOL_NAME,
  ];
}

function isFixtureMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === '/mcp' &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.href === `http://127.0.0.1:${url.port}/mcp`
    );
  } catch {
    return false;
  }
}

function isCredentialLikeVariable(name: string): boolean {
  const parts = name.toUpperCase().replace(/-/g, '_').split('_').filter(Boolean);
  if (parts.length === 0) return false;
  if (
    parts.some(part =>
      new Set(['AUTH', 'AUTHORIZATION', 'BEARER', 'COOKIE', 'CREDENTIAL', 'CREDENTIALS', 'PASSWORD', 'PASSWD', 'SECRET', 'SESSION', 'TOKEN']).has(part),
    )
  ) {
    return true;
  }
  return parts.includes('KEY') && parts.some(part => ['ACCESS', 'API', 'PRIVATE'].includes(part));
}

function isApiKeyOrProviderVariable(name: string): boolean {
  return (
    /(?:^|_)(?:API[_-]?KEY|APIKEY)$/i.test(name) ||
    /(?:^|_)(?:MODEL_)?PROVIDER$/i.test(name) ||
    /^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX)$/i.test(name) ||
    /^(?:ANTHROPIC|OPENAI|AZURE_OPENAI|GOOGLE|GEMINI|COHERE|MISTRAL)_(?:BASE_URL|API_URL)$/i.test(name)
  );
}

function realHomeDirectory(): string {
  const home = process.env.HOME;
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !isAbsolute(home)) {
    throw new ClaudeLaunchProfileError('the authenticated launch requires the caller\'s real absolute HOME');
  }
  return resolve(home);
}

function realUserIdentity(): string {
  const user = process.env.USER;
  if (typeof user !== 'string' || user.length === 0 || user.length > 256 || !/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new ClaudeLaunchProfileError('the authenticated launch requires the caller\'s real USER identity');
  }
  return user;
}

function isAmbientClaudeVariable(name: string): boolean {
  return (
    name.startsWith('CLAUDE_') ||
    name.startsWith('ANTHROPIC_') ||
    name.startsWith('MCP_') ||
    name === 'BASH_ENV' ||
    name === 'ENV' ||
    name === 'NODE_OPTIONS' ||
    name === 'NODE_PATH' ||
    name === 'LD_PRELOAD' ||
    name.startsWith('DYLD_')
  );
}

const LAUNCH_ENV_KEYS = new Set(['PATH', 'LANG', 'TERM', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'USER', 'HOME', 'TMPDIR']);

/**
 * Validate the environment on the profile object itself. This is intentionally
 * separate from sanitizing `baseEnv`: callers can mutate a built profile after
 * construction, so materialization and probe admission must fail closed rather
 * than silently projecting the mutation away.
 */
export function validateClaudeLaunchProfileEnvironment(
  value: unknown,
  paths: Pick<ClaudeOwnedPaths, 'cwd' | 'tmpDir'>,
): Record<string, string> {
  if (!isRecord(value)) throw new ClaudeLaunchProfileError('launch environment must be an object');

  const home = realHomeDirectory();
  const user = realUserIdentity();
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ClaudeLaunchProfileError(`launch environment contains an invalid variable name: ${key}`);
    }
    if (!LAUNCH_ENV_KEYS.has(key) && !/^LC_[A-Z0-9_]+$/.test(key)) {
      throw new ClaudeLaunchProfileError(`launch environment contains a non-allowlisted variable: ${key}`);
    }
    if (isApiKeyOrProviderVariable(key) || isCredentialLikeVariable(key)) {
      throw new ClaudeLaunchProfileError(`launch environment contains a credential/provider variable: ${key}`);
    }
    if (isAmbientClaudeVariable(key)) {
      throw new ClaudeLaunchProfileError(`launch environment contains an ambient Claude variable: ${key}`);
    }
    if (typeof rawValue !== 'string' || rawValue.length > 4_096 || rawValue.includes('\0')) {
      throw new ClaudeLaunchProfileError(`launch environment contains an invalid value: ${key}`);
    }
    if (key === 'HOME' && rawValue !== home) {
      throw new ClaudeLaunchProfileError('launch environment HOME must remain the caller\'s real HOME');
    }
    if (key === 'USER' && rawValue !== user) {
      throw new ClaudeLaunchProfileError('launch environment USER must remain the caller\'s real user identity');
    }
    if (key === 'TMPDIR' && rawValue !== paths.tmpDir) {
      throw new ClaudeLaunchProfileError('launch environment TMPDIR must be the owned temporary directory');
    }
    env[key] = rawValue;
  }

  if (env.HOME !== home || env.USER !== user || env.TMPDIR !== paths.tmpDir) {
    throw new ClaudeLaunchProfileError('launch environment must bind real HOME, real USER, and owned TMPDIR');
  }
  return env;
}

function sanitizeEnvironment(baseEnv: ClaudeLaunchProfileInput['baseEnv'], paths: ClaudeOwnedPaths): Record<string, string> {
  const env: Record<string, string> = {};
  // USER is required by Claude Code's macOS Keychain lookup. It is identity
  // metadata, not a credential, and must match the signed-in caller.
  const safeKeys = new Set(['PATH', 'LANG', 'TERM', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'USER']);
  const home = realHomeDirectory();
  const user = realUserIdentity();
  const sourceEnv = baseEnv ?? {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    TZ: process.env.TZ,
    CI: process.env.CI,
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    USER: process.env.USER,
  };
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ClaudeLaunchProfileError(`environment contains an invalid variable name: ${key}`);
    }
    if (isApiKeyOrProviderVariable(key)) {
      throw new ClaudeLaunchProfileError(`API-key/provider environment variable rejected: ${key}`);
    }
    if (isCredentialLikeVariable(key)) {
      throw new ClaudeLaunchProfileError(`credential/token environment variable rejected: ${key}`);
    }
    if (isAmbientClaudeVariable(key)) {
      throw new ClaudeLaunchProfileError(`ambient Claude configuration environment variable rejected: ${key}`);
    }
    if (key === 'HOME') {
      if (resolve(value) !== home) throw new ClaudeLaunchProfileError('HOME must remain the caller\'s real HOME');
      continue;
    }
    if (key === 'USER') {
      if (value !== user) throw new ClaudeLaunchProfileError('USER must remain the caller\'s real user identity');
      continue;
    }
    if (key === 'TMPDIR') {
      if (resolve(value) !== resolve(paths.tmpDir)) throw new ClaudeLaunchProfileError('TMPDIR must be the owned temporary directory');
      continue;
    }
    if (!safeKeys.has(key) && !/^LC_[A-Z0-9_]+$/.test(key)) continue;
    if (value.length > 4_096) throw new ClaudeLaunchProfileError(`environment value is too large: ${key}`);
    env[key] = value;
  }

  env.HOME = home;
  env.USER = user;
  env.TMPDIR = paths.tmpDir;
  return validateClaudeLaunchProfileEnvironment(env, paths);
}

function assertNoInheritedRuntime(input: ClaudeLaunchProfileInput): void {
  const candidates: ReadonlyArray<[string, unknown]> = [
    ['inherited.mcpServers', input.inherited && hasOwn(input.inherited, 'mcpServers') ? input.inherited.mcpServers : undefined],
    ['inherited.tools', input.inherited && hasOwn(input.inherited, 'tools') ? input.inherited.tools : undefined],
    ['inherited.hooks', input.inherited && hasOwn(input.inherited, 'hooks') ? input.inherited.hooks : undefined],
    ['inherited.settings', input.inherited && hasOwn(input.inherited, 'settings') ? input.inherited.settings : undefined],
    ['inherited.extensions', input.inherited && hasOwn(input.inherited, 'extensions') ? input.inherited.extensions : undefined],
    ['inheritedMcpServers', input.inheritedMcpServers],
    ['inheritedTools', input.inheritedTools],
    ['inheritedHooks', input.inheritedHooks],
    ['inheritedSettings', input.inheritedSettings],
    ['inheritedExtensions', input.inheritedExtensions],
  ];
  for (const [label] of candidates) {
    if (label.startsWith('inherited.')) {
      const key = label.slice('inherited.'.length);
      if (input.inherited && hasOwn(input.inherited, key)) {
        throw new ClaudeLaunchProfileError(`${label} is not permitted in a strict launch profile`);
      }
      continue;
    }
    if (hasOwn(input, label)) {
      throw new ClaudeLaunchProfileError(`${label} is not permitted in a strict launch profile`);
    }
  }
}

function validatePaths(paths: ClaudeOwnedPaths): ClaudeOwnedPaths {
  if (!isRecord(paths)) throw new ClaudeLaunchProfileError('paths are required');
  assertNoUnknownKeys(paths, ['ownedRoot', 'cwd', 'tmpDir', 'mcpConfigPath', 'symlinkPolicy'], 'paths');
  if (paths.symlinkPolicy !== undefined && paths.symlinkPolicy !== 'reject-unvalidated') {
    throw new ClaudeLaunchProfileError('paths.symlinkPolicy must reject unvalidated symlinks');
  }
  assertOwnedAbsolutePath(paths.cwd, 'paths.cwd');
  const cwd = resolve(paths.cwd);
  const ownedRoot = paths.ownedRoot === undefined ? undefined : resolveOwnedRoot(paths.ownedRoot, 'paths.ownedRoot');
  const containmentRoot = ownedRoot ?? cwd;
  if (ownedRoot !== undefined) {
    resolveWithinRoot(cwd, ownedRoot, 'paths.cwd');
  }
  const [tmpDir, mcpConfigPath] = [
    resolveWithinRoot(paths.tmpDir, containmentRoot, 'paths.tmpDir'),
    resolveWithinRoot(paths.mcpConfigPath, containmentRoot, 'paths.mcpConfigPath'),
  ] as [string, string];
  if (new Set([cwd, tmpDir, mcpConfigPath]).size !== 3) {
    throw new ClaudeLaunchProfileError('cwd and all owned Claude paths must be distinct disposable paths');
  }
  return {
    ...(ownedRoot ? { ownedRoot } : {}),
    cwd,
    tmpDir,
    mcpConfigPath,
    symlinkPolicy: 'reject-unvalidated',
  };
}

/**
 * Build a launch profile whose ambient Claude settings, tools, hooks, and
 * credentials cannot silently enter the protocol fixture.
 */
export function buildClaudeLaunchProfile(input: ClaudeLaunchProfileInput): ClaudeLaunchProfile {
  if (!isRecord(input)) throw new ClaudeLaunchProfileError('launch profile input is required');
  assertNoUnknownKeys(
    input,
    [
      'paths',
      'executable',
      'mcpServers',
      'mcpConfig',
      'allowedMcpServers',
      'pluginDirs',
      'baseEnv',
      'inherited',
      'inheritedMcpServers',
      'inheritedTools',
      'inheritedHooks',
      'inheritedSettings',
      'inheritedExtensions',
      'authStatusRaw',
      'authExitCode',
      'versionStatusRaw',
      'versionExitCode',
    ],
    'launch profile input',
  );
  const paths = validatePaths(input.paths);
  assertNoInheritedRuntime(input);

  const pluginDirs = input.pluginDirs ?? [];
  assertStringArray(pluginDirs, 'pluginDirs');
  if (pluginDirs.length > 0) {
    throw new ClaudeLaunchProfileError('ambient/custom plugin inputs are disabled by --safe-mode');
  }

  const mcpConfig = buildStrictMcpConfig(input);
  const mcpConfigJson = serializeStrictMcpConfig(mcpConfig);
  const argv = [...buildClaudeStrictArgv(paths.mcpConfigPath)];

  const authEvidence = sanitizeClaudeAuthStatus(input.authStatusRaw, input.authExitCode ?? 0);
  const versionEvidence = sanitizeClaudeVersionStatus(input.versionStatusRaw, input.versionExitCode ?? 0);
  const readiness = authEvidence.blocked || !versionEvidence.available ? 'blocked' : 'ready';
  return {
    executable: input.executable,
    ...(paths.ownedRoot ? { ownedRoot: paths.ownedRoot } : {}),
    cwd: paths.cwd,
    tmpDir: paths.tmpDir,
    mcpConfigPath: paths.mcpConfigPath,
    argv,
    env: sanitizeEnvironment(input.baseEnv, paths),
    settings: {
      safeMode: true,
      settingSources: [],
      nativeTools: [],
      pluginDirs: [],
      strictMcpConfig: true,
    },
    mcpConfig,
    mcpConfigJson,
    authEvidence,
    versionEvidence,
    readiness,
  };
}

/**
 * Build the separately opted-in tool profile used by the T05 fixture.
 *
 * Keeping this as a distinct builder makes accidental tool enablement
 * impossible for callers that use the ordinary strict launch profile.  The
 * base builder still owns all ambient environment, path, and MCP validation;
 * this wrapper only adds the explicit capability allow-list.
 */
export function buildClaudeToolLaunchProfile(input: ClaudeToolLaunchProfileInput): ClaudeToolLaunchProfile {
  if (!isRecord(input) || input.toolOptIn !== true) {
    throw new ClaudeLaunchProfileError('tool-capable launch requires explicit toolOptIn: true');
  }
  const allowedTools = input.allowedTools;
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.length !== 1 || allowedTools[0] !== CLAUDE_FIXTURE_MCP_TOOL_NAME)) {
    throw new ClaudeLaunchProfileError(`tool-capable launch allow-list must contain only ${CLAUDE_FIXTURE_MCP_TOOL_NAME}`);
  }
  const { toolOptIn: _toolOptIn, allowedTools: _allowedTools, ...baseInput } = input;
  const profile = buildClaudeLaunchProfile(baseInput);
  const serverNames = Object.keys(profile.mcpConfig.mcpServers);
  if (serverNames.length !== 1 || serverNames[0] !== 'fixture') {
    throw new ClaudeLaunchProfileError('tool-capable launch requires the explicit fixture MCP server');
  }
  const toolProfile: ClaudeToolLaunchProfile = {
    ...profile,
    argv: buildClaudeToolStrictArgv(profile.mcpConfigPath),
    settings: {
      safeMode: false,
      restrictedMode: true,
      settingSources: [],
      nativeTools: [],
      pluginDirs: [],
      strictMcpConfig: true,
    },
    toolCapability: {
      enabled: true,
      allowedMcpServer: CLAUDE_FIXTURE_MCP_SERVER_NAME,
      allowedTool: CLAUDE_FIXTURE_MCP_TOOL_NAME,
      ambientTools: 'disabled',
    },
  };
  return toolProfile;
}

function resolveOwnedRoot(value: unknown, label: string): string {
  assertOwnedAbsolutePath(value, label);
  const root = resolve(value);
  if (root === parse(root).root) {
    throw new ClaudeLaunchProfileError(`${label} must be a disposable directory, not the filesystem root`);
  }
  return root;
}

function assertOpaqueWorkspace(value: unknown): ClaudeOwnedWorkspace {
  if (!isRecord(value) || !opaqueWorkspaces.has(value)) {
    throw new ClaudeLaunchProfileError('workspace must be created by createClaudeOwnedWorkspace');
  }
  return value as unknown as ClaudeOwnedWorkspace;
}

function assertOpaqueWorkspaceRoot(value: unknown): string {
  const root = resolveOwnedRoot(value, 'ownedRoot');
  if (!opaqueWorkspaceRoots.has(root)) {
    throw new ClaudeLaunchProfileError('ownedRoot must be an opaque workspace created by createClaudeOwnedWorkspace');
  }
  return root;
}

function workspaceRecord(workspace: ClaudeOwnedWorkspace): OpaqueWorkspaceRecord {
  const record = opaqueWorkspaces.get(workspace);
  if (!record) throw new ClaudeLaunchProfileError('workspace is no longer active');
  return record;
}

function defaultClaudeFileSystem(): ClaudeFileSystem {
  return {
    lstat: async path => lstat(path),
    realpath: async path => realpath(path),
    open: async (path, flags, mode) => open(path, flags, mode),
    unlink: async path => unlink(path),
    readFile: async (path, encoding) => readFile(path, encoding),
  };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwnedStat(stat: ClaudePathStat, path: string, label: string): void {
  if (stat.isSymbolicLink()) {
    throw new ClaudeLaunchProfileError(`${label} must not contain symlinks: ${path}`);
  }
  const uid = currentUid();
  if (uid === undefined || !Number.isSafeInteger(uid) || !Number.isSafeInteger(stat.uid)) {
    throw new ClaudeLaunchProfileError(`${label} ownership UID evidence is unavailable: ${path}`);
  }
  if (stat.uid !== uid) {
    throw new ClaudeLaunchProfileError(`${label} is not owned by the current user: ${path}`);
  }
}

type ClaudePathIdentity = {
  dev: number;
  ino: number;
};

type ClaudeDirectoryEvidence = {
  identity: ClaudePathIdentity;
  mode: number;
};

const PRIVATE_DIRECTORY_MODE = 0o700;

function pathIdentity(stat: ClaudePathStat, path: string, label: string): ClaudePathIdentity {
  const { dev, ino } = stat;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new ClaudeLaunchProfileError(`${label} device and inode identity is unavailable: ${path}`);
  }
  return { dev: dev as number, ino: ino as number };
}

function samePathIdentity(left: ClaudePathIdentity, right: ClaudePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readOwnedDirectoryIdentity(
  path: string,
  label: string,
  filesystem: ClaudeFileSystem,
): Promise<ClaudePathIdentity> {
  return (await readOwnedDirectoryEvidence(path, label, filesystem)).identity;
}

async function readOwnedDirectoryEvidence(
  path: string,
  label: string,
  filesystem: ClaudeFileSystem,
  expectedMode?: number,
): Promise<ClaudeDirectoryEvidence> {
  let stat: ClaudePathStat;
  try {
    stat = await filesystem.lstat(path);
  } catch {
    throw new ClaudeLaunchProfileError(`${label} could not be validated inside the owned workspace`);
  }
  assertOwnedStat(stat, path, label);
  if (!stat.isDirectory()) throw new ClaudeLaunchProfileError(`${label} must be a directory`);
  try {
    if (resolve(await filesystem.realpath(path)) !== resolve(path)) {
      throw new ClaudeLaunchProfileError(`${label} must not resolve through a symlink: ${path}`);
    }
  } catch (error) {
    if (error instanceof ClaudeLaunchProfileError) throw error;
    throw new ClaudeLaunchProfileError(`${label} could not be canonicalized safely`);
  }
  const mode = stat.mode;
  if (typeof mode !== 'number' || !Number.isSafeInteger(mode)) {
    throw new ClaudeLaunchProfileError(`${label} mode is unavailable: ${path}`);
  }
  const permissions = mode & 0o777;
  if (expectedMode !== undefined && permissions !== expectedMode) {
    throw new ClaudeLaunchProfileError(`${label} must have mode ${expectedMode.toString(8)}: ${path}`);
  }
  return { identity: pathIdentity(stat, path, label), mode: permissions };
}

function ownedPathComponents(root: string, target: string, label: string): string[] {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  const fromRoot = relative(canonicalRoot, canonicalTarget);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ClaudeLaunchProfileError(`${label} must resolve within the owned workspace`);
  }
  return fromRoot.split(sep).filter(Boolean);
}

async function validateOwnedPath(
  target: string,
  root: string,
  label: string,
  filesystem: ClaudeFileSystem,
  options: { directory: boolean; allowMissingFinal: boolean; expectedMode?: number },
): Promise<boolean> {
  const components = ownedPathComponents(root, target, label);
  let current = root;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index]!);
    let stat: ClaudePathStat;
    try {
      stat = await filesystem.lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && options.allowMissingFinal && index === components.length - 1) return false;
      throw new ClaudeLaunchProfileError(`${label} could not be validated inside the owned workspace`);
    }
    assertOwnedStat(stat, current, label);
    let canonical: string;
    try {
      canonical = resolve(await filesystem.realpath(current));
    } catch {
      throw new ClaudeLaunchProfileError(`${label} could not be canonicalized safely`);
    }
    if (canonical !== resolve(current)) {
      throw new ClaudeLaunchProfileError(`${label} must not resolve through a symlink: ${current}`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new ClaudeLaunchProfileError(`${label} contains a non-directory path component`);
    }
    if (index === components.length - 1 && !options.directory && stat.isDirectory()) {
      throw new ClaudeLaunchProfileError(`${label} must be a file`);
    }
    if (index === components.length - 1 && options.directory && !stat.isDirectory()) {
      throw new ClaudeLaunchProfileError(`${label} must be a directory`);
    }
    if (index === components.length - 1 && options.expectedMode !== undefined) {
      if (typeof stat.mode !== 'number' || (stat.mode & 0o777) !== options.expectedMode) {
        throw new ClaudeLaunchProfileError(`${label} must have mode ${options.expectedMode.toString(8)}: ${current}`);
      }
    }
  }
  return true;
}

type WorkspaceDirectoryEntry = {
  key: WorkspaceDirectoryKey;
  path: string;
  label: string;
};

function workspaceDirectoryEntries(root: string, paths: ClaudeOwnedPaths): WorkspaceDirectoryEntry[] {
  return [
    { key: 'root', path: root, label: 'ownedRoot' },
    { key: 'cwd', path: paths.cwd, label: 'profile.cwd' },
    { key: 'tmpDir', path: paths.tmpDir, label: 'profile.tmpDir' },
    { key: 'mcpConfigParent', path: dirname(paths.mcpConfigPath), label: 'mcpConfigPath parent' },
  ];
}

function assertRegisteredWorkspacePaths(
  paths: ClaudeOwnedPaths,
  record: OpaqueWorkspaceRecord,
): void {
  for (const key of ['cwd', 'tmpDir', 'mcpConfigPath'] as const) {
    if (paths[key] !== record.paths[key]) {
      throw new ClaudeLaunchProfileError(`${key} must match the registered opaque workspace path`);
    }
  }
}

async function validateRegisteredWorkspaceEvidence(
  root: string,
  paths: ClaudeOwnedPaths,
  record: OpaqueWorkspaceRecord,
  filesystem: ClaudeFileSystem,
): Promise<void> {
  for (const entry of workspaceDirectoryEntries(root, paths)) {
    const current = await readOwnedDirectoryEvidence(entry.path, entry.label, filesystem, PRIVATE_DIRECTORY_MODE);
    const expected = record.directoryEvidence[entry.key];
    if (!samePathIdentity(expected.identity, current.identity) || expected.mode !== current.mode) {
      throw new ClaudeLaunchProfileError(`${entry.label} identity/mode does not match the registered workspace evidence`);
    }
  }
}

type MaterializationIdentities = {
  root: ClaudeDirectoryEvidence;
  parent: ClaudeDirectoryEvidence;
};

async function captureMaterializationIdentities(
  root: string,
  parent: string,
  record: OpaqueWorkspaceRecord,
  filesystem: ClaudeFileSystem,
): Promise<MaterializationIdentities> {
  const current = {
    root: await readOwnedDirectoryEvidence(root, 'ownedRoot', filesystem, PRIVATE_DIRECTORY_MODE),
    parent: await readOwnedDirectoryEvidence(parent, 'mcpConfigPath parent', filesystem, PRIVATE_DIRECTORY_MODE),
  };
  for (const key of ['root', 'mcpConfigParent'] as const) {
    const actual = current[key === 'root' ? 'root' : 'parent'];
    const expected = record.directoryEvidence[key];
    if (!samePathIdentity(expected.identity, actual.identity) || expected.mode !== actual.mode) {
      throw new ClaudeLaunchProfileError(`${key} identity/mode does not match the registered workspace evidence`);
    }
  }
  return current;
}

async function verifyMaterializationIdentities(
  expected: MaterializationIdentities,
  root: string,
  parent: string,
  record: OpaqueWorkspaceRecord,
  phase: string,
  filesystem: ClaudeFileSystem,
): Promise<void> {
  let current: MaterializationIdentities;
  try {
    current = await captureMaterializationIdentities(root, parent, record, filesystem);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'identity lookup failed';
    throw new ClaudeLaunchProfileError(`owned workspace identity changed ${phase}: ${detail}`);
  }
  if (
    !samePathIdentity(expected.root.identity, current.root.identity) ||
    expected.root.mode !== current.root.mode ||
    !samePathIdentity(expected.parent.identity, current.parent.identity) ||
    expected.parent.mode !== current.parent.mode
  ) {
    throw new ClaudeLaunchProfileError(`owned workspace root/parent identity changed ${phase}; refusing to continue`);
  }
}

async function unlinkCreatedConfigIfSafe(
  path: string,
  expectedParent: ClaudePathIdentity,
  filesystem: ClaudeFileSystem,
): Promise<void> {
  // Node's portable fs/promises API has no unlinkat(dirfd, name). Revalidate
  // the parent before pathname unlink and skip cleanup if it moved: deleting a
  // redirected pathname is worse than leaving an unreferenced 0600 file for
  // the workspace cleanup. A same-user/privileged actor can still swap the
  // parent after this last check; this is intentionally not race-proof.
  let currentParent: ClaudePathIdentity;
  try {
    currentParent = await readOwnedDirectoryIdentity(dirname(path), 'mcpConfigPath parent', filesystem);
  } catch {
    return;
  }
  if (!samePathIdentity(expectedParent, currentParent)) return;
  try {
    await filesystem.unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function assertMcpConfigBinding(profile: ClaudeLaunchProfile): void {
  if (!Array.isArray(profile.argv) || profile.argv.some(value => typeof value !== 'string')) {
    throw new ClaudeLaunchProfileError('argv must be a canonical string array');
  }
  assertNoUnknownKeys(
    profile,
    [
      'executable',
      'ownedRoot',
      'cwd',
      'tmpDir',
      'mcpConfigPath',
      'argv',
      'env',
      'settings',
      'mcpConfig',
      'mcpConfigJson',
      'authEvidence',
      'versionEvidence',
      'readiness',
      'toolCapability',
    ],
    'launch profile',
  );
  if (!isRecord(profile.settings)) {
    throw new ClaudeLaunchProfileError('launch settings must be an object');
  }
  assertNoUnknownKeys(profile.settings, ['safeMode', 'restrictedMode', 'settingSources', 'nativeTools', 'pluginDirs', 'strictMcpConfig'], 'launch settings');
  if (typeof profile.settings.safeMode !== 'boolean' || (profile.settings.restrictedMode !== undefined && typeof profile.settings.restrictedMode !== 'boolean')) {
    throw new ClaudeLaunchProfileError('launch profile mode settings must be booleans');
  }
  assertStringArray(profile.settings.settingSources, 'settings.settingSources');
  assertStringArray(profile.settings.nativeTools, 'settings.nativeTools');
  assertStringArray(profile.settings.pluginDirs, 'settings.pluginDirs');
  if (profile.settings.settingSources.length !== 0 || profile.settings.nativeTools.length !== 0 || profile.settings.pluginDirs.length !== 0) {
    throw new ClaudeLaunchProfileError('launch profile must keep ambient settings and native tools disabled');
  }
  if (profile.settings.strictMcpConfig !== true) {
    throw new ClaudeLaunchProfileError('launch profile must keep strict MCP enabled');
  }
  if (profile.toolCapability !== undefined) {
    const capability = profile.toolCapability;
    if (
      !isRecord(capability) ||
      capability.enabled !== true ||
      capability.allowedMcpServer !== CLAUDE_FIXTURE_MCP_SERVER_NAME ||
      capability.allowedTool !== CLAUDE_FIXTURE_MCP_TOOL_NAME ||
      capability.ambientTools !== 'disabled'
    ) {
      throw new ClaudeLaunchProfileError('tool capability must remain the explicit fixture allow-list');
    }
    assertNoUnknownKeys(capability, ['enabled', 'allowedMcpServer', 'allowedTool', 'ambientTools'], 'tool capability');
  }

  const mcpFlagIndexes = profile.argv.flatMap((value, index) => (value === '--mcp-config' ? [index] : []));
  if (mcpFlagIndexes.length !== 1 || profile.argv[mcpFlagIndexes[0]! + 1] !== profile.mcpConfigPath) {
    throw new ClaudeLaunchProfileError('argv must bind --mcp-config to the exact generated MCP config path');
  }

  const canonicalArgv = profile.toolCapability === undefined
    ? buildClaudeStrictArgv(profile.mcpConfigPath)
    : buildClaudeToolStrictArgv(profile.mcpConfigPath);
  if (profile.argv.length !== canonicalArgv.length || profile.argv.some((value, index) => value !== canonicalArgv[index])) {
    throw new ClaudeLaunchProfileError('argv must match the complete canonical strict launch contract');
  }
  if (profile.toolCapability === undefined && (profile.settings.safeMode !== true || profile.settings.restrictedMode !== undefined)) {
    throw new ClaudeLaunchProfileError('baseline launch profile must use safe mode without restricted mode');
  }
  if (profile.toolCapability !== undefined && (profile.settings.safeMode !== false || profile.settings.restrictedMode !== true)) {
    throw new ClaudeLaunchProfileError('tool launch profile must use restricted mode without safe mode');
  }
  validateClaudeLaunchProfileEnvironment(profile.env, { cwd: profile.cwd, tmpDir: profile.tmpDir });
  const canonicalConfig = buildStrictMcpConfig({ mcpConfig: profile.mcpConfig });
  if (profile.mcpConfigJson !== serializeStrictMcpConfig(canonicalConfig)) {
    throw new ClaudeLaunchProfileError('MCP config JSON must be the canonical strict configuration');
  }
}

function assertProfilePaths(
  profile: ClaudeLaunchProfile,
  ownedRoot: string,
  record: OpaqueWorkspaceRecord,
): ClaudeOwnedPaths {
  const paths = validatePaths({
    ownedRoot,
    cwd: profile.cwd,
    tmpDir: profile.tmpDir,
    mcpConfigPath: profile.mcpConfigPath,
    symlinkPolicy: 'reject-unvalidated',
  });
  if (profile.ownedRoot !== undefined && profile.ownedRoot !== paths.ownedRoot) {
    throw new ClaudeLaunchProfileError('profile ownedRoot does not match the validation root');
  }
  return paths;
}

function validationRoot(profile: ClaudeLaunchProfile, options: ClaudePathValidationOptions): string {
  if (options.workspace !== undefined) {
    const workspace = assertOpaqueWorkspace(options.workspace);
    const record = workspaceRecord(workspace);
    if (options.ownedRoot !== undefined && resolveOwnedRoot(options.ownedRoot, 'ownedRoot') !== record.root) {
      throw new ClaudeLaunchProfileError('ownedRoot does not match the supplied opaque workspace');
    }
    if (profile.ownedRoot !== undefined && resolveOwnedRoot(profile.ownedRoot, 'profile.ownedRoot') !== record.root) {
      throw new ClaudeLaunchProfileError('profile ownedRoot does not match the supplied opaque workspace');
    }
    return record.root;
  }

  const rootValue = options.ownedRoot ?? profile.ownedRoot;
  if (rootValue === undefined) {
    throw new ClaudeLaunchProfileError('an explicit opaque ownedRoot is required before filesystem validation');
  }
  return assertOpaqueWorkspaceRoot(rootValue);
}

function registeredWorkspaceRecord(root: string): OpaqueWorkspaceRecord {
  const workspace = opaqueWorkspaceRoots.get(root);
  if (!workspace) {
    throw new ClaudeLaunchProfileError('ownedRoot must be an opaque workspace created by createClaudeOwnedWorkspace');
  }
  return workspaceRecord(workspace);
}

/**
 * Validate every launch directory without resolving or probing anything outside
 * the explicitly supplied disposable root. Existing components must be owned,
 * real directories; the generated MCP file itself must not already exist.
 */
export async function validateClaudeLaunchProfilePaths(
  profile: ClaudeLaunchProfile,
  options: ClaudePathValidationOptions = {},
): Promise<void> {
  if (!isRecord(profile)) throw new ClaudeLaunchProfileError('profile is required');
  const ownedRoot = validationRoot(profile, options);
  const record = registeredWorkspaceRecord(ownedRoot);
  const paths = assertProfilePaths(profile, ownedRoot, record);
  assertMcpConfigBinding(profile);
  const filesystem = options.filesystem ?? defaultClaudeFileSystem();

  await validateRegisteredWorkspaceEvidence(ownedRoot, paths, record, filesystem);
  await validateOwnedPath(paths.cwd, ownedRoot, 'profile.cwd', filesystem, { directory: true, allowMissingFinal: false });
  await validateOwnedPath(paths.tmpDir, ownedRoot, 'profile.tmpDir', filesystem, { directory: true, allowMissingFinal: false });
  await validateOwnedPath(dirname(paths.mcpConfigPath), ownedRoot, 'mcpConfigPath parent', filesystem, {
    directory: true,
    allowMissingFinal: false,
  });
  const allowMaterializedConfig = options.allowMaterializedConfig === true;
  const configExists = await validateOwnedPath(paths.mcpConfigPath, ownedRoot, 'mcpConfigPath', filesystem, {
    directory: false,
    allowMissingFinal: !allowMaterializedConfig,
    ...(allowMaterializedConfig ? { expectedMode: 0o600 } : {}),
  });
  if (allowMaterializedConfig && !configExists) {
    throw new ClaudeLaunchProfileError('materialized MCP config is missing; refusing to launch');
  }
  if (!allowMaterializedConfig && configExists) {
    throw new ClaudeLaunchProfileError('mcpConfigPath already exists; refusing to overwrite it');
  }
  if (allowMaterializedConfig) {
    if (filesystem.readFile === undefined) {
      throw new ClaudeLaunchProfileError('materialized MCP config cannot be verified without readFile support');
    }
    let materializedJson: string;
    try {
      materializedJson = await filesystem.readFile(paths.mcpConfigPath, 'utf8');
    } catch {
      throw new ClaudeLaunchProfileError('materialized MCP config could not be read safely');
    }
    if (materializedJson !== profile.mcpConfigJson) {
      throw new ClaudeLaunchProfileError('materialized MCP config does not match the canonical profile JSON');
    }
  }
  assertRegisteredWorkspacePaths(paths, record);
}

/** Materialize the exact strict JSON that is bound in the profile argv. */
export async function materializeClaudeMcpConfig(
  profile: ClaudeLaunchProfile,
  options: ClaudePathValidationOptions = {},
): Promise<ClaudeMcpMaterialization> {
  await validateClaudeLaunchProfilePaths(profile, options);
  const filesystem = options.filesystem ?? defaultClaudeFileSystem();

  const ownedRoot = validationRoot(profile, options);
  const record = registeredWorkspaceRecord(ownedRoot);
  const parent = dirname(profile.mcpConfigPath);
  const beforeOpen = await captureMaterializationIdentities(ownedRoot, parent, record, filesystem);
  await validateOwnedPath(profile.mcpConfigPath, ownedRoot, 'mcpConfigPath', filesystem, {
    directory: false,
    allowMissingFinal: true,
  });

  let handle: ClaudeFileHandle | undefined;
  let failure: unknown;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    handle = await filesystem.open(profile.mcpConfigPath, flags, 0o600);
    await verifyMaterializationIdentities(beforeOpen, ownedRoot, parent, record, 'after exclusive open', filesystem);
    await handle.writeFile(profile.mcpConfigJson, 'utf8');
    await verifyMaterializationIdentities(beforeOpen, ownedRoot, parent, record, 'after exclusive write', filesystem);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      failure = new ClaudeLaunchProfileError('mcpConfigPath already exists; refusing to overwrite it');
    } else {
      failure = error;
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'failed to close MCP config');
      }
    }
  }
  if (failure !== undefined) {
    if (handle !== undefined) {
      try {
        await unlinkCreatedConfigIfSafe(profile.mcpConfigPath, beforeOpen.parent.identity, filesystem);
      } catch (cleanupError) {
        throw new AggregateError([failure, cleanupError], 'failed to fail closed after MCP config materialization');
      }
    }
    throw failure;
  }
  return { path: profile.mcpConfigPath, bytes: Buffer.byteLength(profile.mcpConfigJson, 'utf8') };
}

/** Build and materialize a profile in one caller-owned workspace operation. */
export async function buildAndMaterializeClaudeLaunchProfile(
  input: ClaudeLaunchProfileInput,
  options: ClaudePathValidationOptions = {},
): Promise<ClaudeLaunchProfile> {
  const profile = buildClaudeLaunchProfile(input);
  await materializeClaudeMcpConfig(profile, options);
  return profile;
}

/** Create a fresh workspace whose paths are safe inputs for a Claude launch. */
export async function createClaudeOwnedWorkspace(
  options: { prefix?: string; filesystem?: ClaudeWorkspaceFileSystem } = {},
): Promise<ClaudeOwnedWorkspace> {
  const prefix = options.prefix ?? 'mastra-subscription-runtime-claude-';
  if (!/^[A-Za-z0-9_-]{1,64}-$/.test(prefix)) {
    throw new ClaudeLaunchProfileError('workspace prefix must be a bounded local name ending in a hyphen');
  }
  const filesystem = options.filesystem ?? defaultClaudeFileSystem();
  const temporaryDirectory = resolve(await filesystem.realpath(tmpdir()));
  const root = await mkdtemp(join(temporaryDirectory, prefix));
  const paths = {
    ownedRoot: root,
    cwd: join(root, 'project'),
    tmpDir: join(root, 'project', 'tmp'),
    mcpConfigPath: join(root, 'project', 'generated', 'mcp.json'),
    symlinkPolicy: 'reject-unvalidated' as const,
  };
  let directoryEvidence!: Readonly<Record<WorkspaceDirectoryKey, ClaudeDirectoryEvidence>>;
  try {
    await chmod(root, 0o700);
    await assertPrivateOwnedDirectory(root, filesystem);
    await mkdirOwnedDirectory(paths.cwd, filesystem);
    await mkdirOwnedDirectory(paths.tmpDir, filesystem);
    await mkdirOwnedDirectory(dirname(paths.mcpConfigPath), filesystem);
    directoryEvidence = await captureWorkspaceDirectoryEvidence(root, paths, filesystem);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let workspace!: ClaudeOwnedWorkspace;
  workspace = {
    root,
    paths,
    cleanup: async () => {
      opaqueWorkspaces.delete(workspace);
      opaqueWorkspaceRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    },
  };
  opaqueWorkspaces.set(workspace, { root, paths, directoryEvidence });
  opaqueWorkspaceRoots.set(root, workspace);
  return workspace;
}

async function captureWorkspaceDirectoryEvidence(
  root: string,
  paths: ClaudeOwnedPaths,
  filesystem: ClaudeWorkspaceFileSystem,
): Promise<Readonly<Record<WorkspaceDirectoryKey, ClaudeDirectoryEvidence>>> {
  const evidence = {} as Record<WorkspaceDirectoryKey, ClaudeDirectoryEvidence>;
  for (const entry of workspaceDirectoryEntries(root, paths)) {
    evidence[entry.key] = await readPrivateOwnedDirectoryEvidence(entry.path, entry.label, filesystem);
  }
  return evidence;
}

async function mkdirOwnedDirectory(path: string, filesystem: ClaudeWorkspaceFileSystem): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await assertPrivateOwnedDirectory(path, filesystem);
}

async function assertPrivateOwnedDirectory(path: string, filesystem: ClaudeWorkspaceFileSystem): Promise<void> {
  await readPrivateOwnedDirectoryEvidence(path, 'workspace directory', filesystem);
}

async function readPrivateOwnedDirectoryEvidence(
  path: string,
  label: string,
  filesystem: ClaudeWorkspaceFileSystem = defaultClaudeFileSystem(),
): Promise<ClaudeDirectoryEvidence> {
  const entry = await filesystem.lstat(path);
  assertOwnedStat(entry, path, label);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ClaudeLaunchProfileError(`${label} must be a real directory: ${path}`);
  }
  const mode = entry.mode;
  if (typeof mode !== 'number' || !Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new ClaudeLaunchProfileError(`${label} must be private mode 0700: ${path}`);
  }
  if (resolve(await filesystem.realpath(path)) !== resolve(path)) {
    throw new ClaudeLaunchProfileError(`${label} must not resolve through a symlink: ${path}`);
  }
  return { identity: pathIdentity(entry, path, label), mode: PRIVATE_DIRECTORY_MODE };
}

function boundedExitCode(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1;
  return Math.max(-255, Math.min(255, Math.trunc(value)));
}

const CLAUDE_VERSION_TOKEN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g;
const CLAUDE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Extract one semver-like version from the vendor's bounded version output.
 * The value is deliberately not compared with a repository constant: the
 * installed executable is the source of truth.  Requiring exactly one token
 * keeps free-form/ambiguous output fail-closed while still supporting the
 * human-readable `Claude Code <version>` form.
 */
export function parseClaudeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const matches = value.match(CLAUDE_VERSION_TOKEN);
  if (matches?.length !== 1) return undefined;
  const [version] = matches;
  const tokenEnd = value.indexOf(version) + version.length;
  if (/[.+-]/.test(value[tokenEnd] ?? '')) return undefined;
  return version && version.length <= 64 && CLAUDE_SEMVER.test(version) ? version : undefined;
}

type StrictAuthField<T> = {
  present: boolean;
  value?: T;
  ambiguous: boolean;
};

const AUTH_STATUS_KEYS = [
  'loggedIn',
  'logged_in',
  'isLoggedIn',
  'authenticated',
  'authMethod',
  'auth_method',
  'method',
  'type',
  'apiProvider',
  'api_provider',
  'provider',
  // Current Claude Code `auth status` metadata. These fields are accepted
  // only to consume the vendor's status shape and are never returned.
  'analyticsDisabled',
  'projectsDirectory',
  'configDirectory',
  'email',
  'orgId',
  'orgName',
  'subscriptionType',
] as const;

const AUTH_STATUS_METADATA_LIMITS: Readonly<Record<string, { type: 'boolean' | 'string'; maxLength?: number }>> = {
  analyticsDisabled: { type: 'boolean' },
  projectsDirectory: { type: 'string', maxLength: 1_024 },
  configDirectory: { type: 'string', maxLength: 1_024 },
  email: { type: 'string', maxLength: 320 },
  orgId: { type: 'string', maxLength: 128 },
  orgName: { type: 'string', maxLength: 256 },
  subscriptionType: { type: 'string', maxLength: 64 },
};

function readStrictAuthField<T>(
  raw: Record<string, unknown>,
  keys: readonly string[],
  normalize: (value: unknown) => T | undefined,
): StrictAuthField<T> {
  const values: T[] = [];
  for (const key of keys) {
    if (!hasOwn(raw, key)) continue;
    const value = normalize(raw[key]);
    if (value === undefined) return { present: true, ambiguous: true };
    values.push(value);
  }
  if (values.length === 0) return { present: false, ambiguous: false };
  return { present: true, value: values[0], ambiguous: values.some(value => value !== values[0]) };
}

function strictAuthBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function strictAuthToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return token.length > 0 && token.length <= 64 ? token : undefined;
}

type StrictAuthMethod = 'none' | 'subscription' | 'apiKey' | 'invalid';
type StrictAuthProvider = 'unknown' | 'firstParty' | 'apiKey' | 'external' | 'invalid';

function classifyStrictAuthMethod(value: string): StrictAuthMethod {
  if (/^(?:none|unauthenticated|not[ _-]?authenticated|logged[ _-]?out)$/.test(value)) return 'none';
  if (/^(?:subscription|claude\.ai|claudeai|oauth|first[ _-]?party)$/.test(value)) return 'subscription';
  if (/^(?:api[ _-]?key|apikey)$/.test(value)) return 'apiKey';
  return 'invalid';
}

function classifyStrictAuthProvider(value: string): StrictAuthProvider {
  if (/^(?:unknown|none|unauthenticated|not[ _-]?authenticated)$/.test(value)) return 'unknown';
  if (/^(?:first[ _-]?party|firstparty|claude\.ai|claudeai|oauth)$/.test(value)) return 'firstParty';
  if (/^(?:api[ _-]?key|apikey)$/.test(value)) return 'apiKey';
  if (/^(?:bedrock|vertex|azure|openrouter|gateway|external|third[ _-]?party|thirdparty)$/.test(value)) return 'external';
  return 'invalid';
}

function blockedAuthEvidence(
  exitCode: number,
  blockedReason: NonNullable<ClaudeAuthEvidence['blockedReason']>,
): ClaudeAuthEvidence {
  return {
    loggedIn: false,
    authMethod: 'none',
    apiProvider: 'unknown',
    exitCode,
    blocked: true,
    blockedReason,
  };
}

/**
 * Keep only bounded auth facts from the canonical JSON status shape. Free
 * text, unknown fields, duplicate aliases, invalid values, and contradictory
 * combinations fail closed. Version is intentionally not part of auth
 * evidence; it must come from the separate version probe.
 */
export function sanitizeClaudeAuthStatus(raw: unknown, exitCode: number): ClaudeAuthEvidence {
  const statusExitCode = boundedExitCode(exitCode);
  if (statusExitCode !== 0) return blockedAuthEvidence(statusExitCode, 'status-command-failed');
  if (!isRecord(raw)) return blockedAuthEvidence(statusExitCode, 'unknown-authentication');

  const keys = Object.keys(raw);
  if (keys.length > 32 || keys.some(key => !(AUTH_STATUS_KEYS as readonly string[]).includes(key))) {
    return blockedAuthEvidence(statusExitCode, 'unknown-authentication');
  }
  for (const [key, constraint] of Object.entries(AUTH_STATUS_METADATA_LIMITS)) {
    if (!hasOwn(raw, key)) continue;
    const value = raw[key];
    if (typeof value !== constraint.type || (typeof value === 'string' && value.length > constraint.maxLength!)) {
      return blockedAuthEvidence(statusExitCode, 'unknown-authentication');
    }
  }

  const loggedIn = readStrictAuthField(raw, ['loggedIn', 'logged_in', 'isLoggedIn', 'authenticated'], strictAuthBoolean);
  const method = readStrictAuthField(raw, ['authMethod', 'auth_method', 'method', 'type'], strictAuthToken);
  const provider = readStrictAuthField(raw, ['apiProvider', 'api_provider', 'provider'], strictAuthToken);
  if (
    !loggedIn.present ||
    loggedIn.ambiguous ||
    loggedIn.value === undefined ||
    !method.present ||
    method.ambiguous ||
    method.value === undefined ||
    !provider.present ||
    provider.ambiguous ||
    provider.value === undefined
  ) {
    return blockedAuthEvidence(statusExitCode, 'unknown-authentication');
  }

  const methodKind = classifyStrictAuthMethod(method.value);
  const providerKind = classifyStrictAuthProvider(provider.value);
  if (!loggedIn.value) {
    return methodKind === 'none' && providerKind === 'unknown'
      ? {
          loggedIn: false,
          authMethod: 'none',
          apiProvider: 'unknown',
          exitCode: statusExitCode,
          blocked: true,
          blockedReason: 'not-authenticated',
        }
      : blockedAuthEvidence(statusExitCode, 'unknown-authentication');
  }

  if (methodKind === 'apiKey' || providerKind === 'apiKey') {
    return blockedAuthEvidence(statusExitCode, 'api-key-authentication');
  }
  if (providerKind === 'external') return blockedAuthEvidence(statusExitCode, 'external-provider');
  if (methodKind !== 'subscription' || providerKind !== 'firstParty') {
    return blockedAuthEvidence(statusExitCode, 'unknown-authentication');
  }

  return {
    loggedIn: true,
    authMethod: 'subscription',
    apiProvider: 'firstParty',
    exitCode: statusExitCode,
    blocked: false,
  };
}

/** Extract only bounded version facts from a CLI version/status result. */
export function sanitizeClaudeVersionStatus(raw: unknown, exitCode: number): ClaudeVersionEvidence {
  const text = typeof raw === 'string' ? raw : '';
  let versionInput = text;
  if (isRecord(raw)) {
    const versionFields = ['version', 'cliVersion', 'cli_version'];
    const present = versionFields.filter(key => hasOwn(raw, key));
    if (present.length !== 1 || typeof raw[present[0]!] !== 'string') versionInput = '';
    else versionInput = raw[present[0]!] as string;
  }
  const version = parseClaudeVersion(versionInput);
  const statusExitCode = boundedExitCode(exitCode);
  return {
    available: statusExitCode === 0 && version !== undefined,
    exitCode: statusExitCode,
    ...(version ? { version } : {}),
  };
}
