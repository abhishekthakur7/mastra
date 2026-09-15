import { spawn } from 'node:child_process';
import { lstat, open, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAndMaterializeClaudeLaunchProfile,
  buildClaudeLaunchProfile,
  createClaudeOwnedWorkspace,
  materializeClaudeMcpConfig,
  sanitizeClaudeAuthStatus,
  sanitizeClaudeVersionStatus,
  type ClaudeLaunchProfile,
  validateClaudeLaunchProfilePaths,
} from './claude-launch-profile';
import { type ClaudeProbeChild, runClaudeMetadataProbe } from './claude-probe';

const paths = {
  cwd: '/tmp/subscription-runtime/project',
  tmpDir: '/tmp/subscription-runtime/project/tmp',
  mcpConfigPath: '/tmp/subscription-runtime/project/generated/mcp.json',
  symlinkPolicy: 'reject-unvalidated' as const,
} as const;

const fixtureServer = {
  type: 'http' as const,
  url: 'http://127.0.0.1:43123/mcp',
};

// Deliberately use a fixture-only version that is not tied to the installed
// Claude release. Production admission records whichever version --version
// reports and does not compare it with a repository constant.
const FIXTURE_CLAUDE_VERSION = '9.9.9';

function profile(overrides: Record<string, unknown> = {}) {
  return buildClaudeLaunchProfile({
    paths,
    mcpServers: { fixture: fixtureServer },
    ...overrides,
  });
}

describe('Claude subscription-runtime launch profile', () => {
  it('builds a real owned workspace whose probe environment is contained by cwd', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const profile = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
        executable: process.execPath,
      });

      expect(relative(profile.cwd, profile.tmpDir)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(profile.env.HOME).toBe(process.env.HOME);
      expect(profile.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');

      const result = await runClaudeMetadataProbe({
        profile,
        command: 'version',
        runner: (_executable, _args, options) =>
          spawn(process.execPath, ['-e', `process.stdout.write('claude ${FIXTURE_CLAUDE_VERSION}')`], {
            cwd: options.cwd,
            env: { ...options.env },
            signal: options.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
          }) as ClaudeProbeChild,
      });

      expect(result).toMatchObject({ ok: true, versionEvidence: { available: true, version: FIXTURE_CLAUDE_VERSION } });
    } finally {
      await workspace.cleanup();
    }
  });

  it('disables native tools and ambient settings with a strict MCP config', () => {
    const result = profile();

    expect(result.argv).toEqual([
      '--safe-mode',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      paths.mcpConfigPath,
      '--setting-sources',
      '',
    ]);
    expect(result.settings).toEqual({
      safeMode: true,
      settingSources: [],
      nativeTools: [],
      pluginDirs: [],
      strictMcpConfig: true,
    });
    expect(result.cwd).toBe(paths.cwd);
    expect(result.mcpConfigJson).toBe(`${JSON.stringify(result.mcpConfig, null, 2)}\n`);
    expect(JSON.parse(result.mcpConfigJson)).toEqual({ mcpServers: { fixture: fixtureServer } });
    expect(result.readiness).toBe('blocked');
    expect(result.authEvidence).toMatchObject({ blocked: true, blockedReason: 'unknown-authentication' });
    expect(result.mcpConfig).toEqual({ mcpServers: { fixture: fixtureServer } });
  });

  it('rejects credential/configuration environment inputs and keeps real HOME', () => {
    expect(() => profile({
      baseEnv: {
        PATH: '/usr/bin',
        LANG: 'C',
        NODE_OPTIONS: '--require /tmp/untrusted.js',
        CLAUDE_PLUGIN_PATH: '/inherited/plugins',
        GITHUB_TOKEN: 'do-not-copy',
        PASSWORD: 'do-not-copy',
        HOME: '/inherited/home',
        TMPDIR: '/inherited/tmp',
        CLAUDE_CONFIG_DIR: '/inherited/config',
      },
    })).toThrow(/credential|ambient/);

    const result = profile({ baseEnv: { PATH: '/usr/bin', LANG: 'C', HOME: process.env.HOME, TMPDIR: paths.tmpDir } });
    expect(result.env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C',
      TMPDIR: paths.tmpDir,
      HOME: process.env.HOME,
      USER: process.env.USER,
    });
  });

  it('preserves a subscription auth result as ready evidence without exposing raw status fields', () => {
    const result = profile({
      authStatusRaw: {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        analyticsDisabled: false,
        configDirectory: '/Users/example/.claude',
        projectsDirectory: '/Users/example/.claude/projects',
        email: 'user@example.com',
        orgId: 'org-id',
        orgName: 'Example Org',
        subscriptionType: 'max',
      },
      versionStatusRaw: `claude ${FIXTURE_CLAUDE_VERSION}`,
    });

    expect(result.readiness).toBe('ready');
    expect(result.authEvidence).toEqual({
      loggedIn: true,
      authMethod: 'subscription',
      apiProvider: 'firstParty',
      exitCode: 0,
      blocked: false,
    });
    expect(result.versionEvidence).toEqual({ available: true, exitCode: 0, version: FIXTURE_CLAUDE_VERSION });
  });

  it('admits any single well-formed installed Claude version and records it', () => {
    for (const version of ['0.0.1', '99.99.99', '3.4.5-beta.1', '3.4.5+local-build']) {
      const evidence = sanitizeClaudeVersionStatus(`claude ${version}`, 0);
      expect(evidence).toMatchObject({ available: true, exitCode: 0, version });
    }

    const installed = profile({
      authStatusRaw: { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty' },
      versionStatusRaw: 'claude 3.4.6',
    });
    expect(installed.readiness).toBe('ready');
    expect(installed.versionEvidence).toEqual({ available: true, exitCode: 0, version: '3.4.6' });
  });

  it('requires separate successful version evidence and never derives it from auth status', () => {
    const authOnly = profile({
      authStatusRaw: {
        loggedIn: true,
        authMethod: 'subscription',
        apiProvider: 'firstParty',
        version: `claude ${FIXTURE_CLAUDE_VERSION}`,
      },
    });

    expect(authOnly.readiness).toBe('blocked');
    expect(authOnly.versionEvidence).toEqual({ available: false, exitCode: 0 });
    expect(authOnly.authEvidence).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'unknown',
      exitCode: 0,
      blocked: true,
      blockedReason: 'unknown-authentication',
    });
  });

  it('fails closed for free-text, extra-field, and ambiguous auth status', () => {
    for (const raw of [
      'logged in to claude.ai',
      { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', version: FIXTURE_CLAUDE_VERSION },
      { loggedIn: true, logged_in: false, authMethod: 'subscription', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'subscription', apiProvider: 'firstParty', provider: 'apiKey' },
    ]) {
      expect(sanitizeClaudeAuthStatus(raw, 0)).toMatchObject({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'unknown',
        blocked: true,
        blockedReason: 'unknown-authentication',
      });
    }
  });

  it('rejects explicit extension directories because safe mode disables customizations', () => {
    const pluginDirs = [`${paths.cwd}/plugins/one`, `${paths.cwd}/plugins/two`];
    expect(() => profile({ pluginDirs })).toThrow(/plugin/);
  });

  it('rejects the unvalidated restricted candidate and bare launch controls', () => {
    expect(() => profile({ restrictedCandidate: true })).toThrow(/unknown key/);
    expect(() => profile({ bare: true })).toThrow(/unknown key/);
  });

  it.each([
    ['inherited MCP servers', { inheritedMcpServers: [] }],
    ['inherited tools', { inheritedTools: [] }],
    ['inherited hooks', { inheritedHooks: [] }],
    ['inherited settings', { inheritedSettings: {} }],
    ['inherited extensions', { inheritedExtensions: [] }],
    ['empty inherited hooks', { inherited: { hooks: undefined } }],
  ])('rejects %s', (_label, input) => {
    expect(() => profile(input)).toThrow(/not permitted/);
  });

  it('rejects API-key and provider environment variables instead of selecting them', () => {
    expect(() => profile({ baseEnv: { ANTHROPIC_API_KEY: 'secret' } })).toThrow(/API-key\/provider/);
    expect(() => profile({ baseEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } })).toThrow(/API-key\/provider/);
  });

  it('rejects common cloud credential environment variables instead of copying them', () => {
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET']) {
      expect(() => profile({ baseEnv: { [key]: 'secret' } })).toThrow(/credential|API-key\/provider/);
    }
  });

  it('rejects unknown MCP config keys and servers outside the explicit allow-list', () => {
    expect(() => profile({ mcpConfig: { mcpServers: { fixture: fixtureServer }, hooks: {} } })).toThrow(/unknown key/);
    expect(() => profile({ allowedMcpServers: ['fixture'], mcpServers: { fixture: fixtureServer, extra: fixtureServer } })).toThrow(
      /extra MCP server/,
    );
  });

  it.each([
    ['non-loopback host', { ...fixtureServer, url: 'http://localhost:43123/mcp' }],
    ['wrong path', { ...fixtureServer, url: 'http://127.0.0.1:43123/not-mcp' }],
    ['credentials', { ...fixtureServer, url: 'http://user:password@127.0.0.1:43123/mcp' }],
    ['query string', { ...fixtureServer, url: 'http://127.0.0.1:43123/mcp?token=fixture' }],
    ['stdio command', { type: 'stdio' as const, command: '/tmp/server' }],
  ])('rejects malicious or non-fixture MCP configuration: %s', (_label, server) => {
    expect(() => profile({ mcpServers: { fixture: server } })).toThrow(/exact loopback|commands/);
  });

  it('rejects extension directories outside the explicit disposable workspace', () => {
    expect(() => profile({ pluginDirs: ['/Users/other-user/.claude/plugins'] })).toThrow(/plugin/);
  });

  it('rejects extension directory traversal outside the explicit disposable workspace', () => {
    expect(() => profile({ pluginDirs: ['../outside/plugins'] })).toThrow(/plugin/);
  });

  it('rejects extension directories even when they resolve within the disposable workspace', () => {
    expect(() => profile({ pluginDirs: ['plugins/one'] })).toThrow(/plugin/);
  });

  it('does not admit any plugin directory to the safe launch contract', () => {
    expect(() => profile({ pluginDirs: ['plugins/approved'] })).toThrow(/plugin/);
  });

  it('validates the complete canonical launch contract before materialization', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const built = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });

      await expect(validateClaudeLaunchProfilePaths(built, { ownedRoot: workspace.root })).resolves.toBeUndefined();

      const mutations = [
        ['missing --safe-mode', (argv: string[]) => argv.splice(0, 1)],
        ['changed --safe-mode', (argv: string[]) => { argv[0] = '--restricted'; }],
        ['missing --tools', (argv: string[]) => argv.splice(1, 2)],
        ['changed --tools value', (argv: string[]) => { argv[2] = 'default'; }],
        ['missing --strict-mcp-config', (argv: string[]) => argv.splice(3, 1)],
        ['changed --strict-mcp-config', (argv: string[]) => { argv[3] = '--allow-settings'; }],
        ['missing --setting-sources', (argv: string[]) => argv.splice(6, 2)],
        ['ambient setting source', (argv: string[]) => { argv[7] = 'user'; }],
        ['injected --bare', (argv: string[]) => argv.push('--bare')],
        ['injected plugin path', (argv: string[]) => argv.push('--plugin-dir', `${workspace.paths.cwd}/plugins/other`)],
      ] as const;

      for (const [, mutate] of mutations) {
        const mutated = { ...built, argv: [...built.argv] };
        mutate(mutated.argv);
        await expect(validateClaudeLaunchProfilePaths(mutated, { ownedRoot: workspace.root })).rejects.toThrow(/canonical|strict/);
        await expect(materializeClaudeMcpConfig(mutated, { ownedRoot: workspace.root })).rejects.toThrow(/canonical|strict/);
      }

      const mutatedSettings = {
        ...built,
        settings: { ...built.settings, settingSources: ['user'] },
      } as unknown as ClaudeLaunchProfile;
      await expect(validateClaudeLaunchProfilePaths(mutatedSettings, { ownedRoot: workspace.root })).rejects.toThrow(/ambient|strict/);

      const mutatedEnvironments = [
        ['credential', { ...built.env, ANTHROPIC_API_KEY: 'must-not-enter' }],
        ['provider selection', { ...built.env, CLAUDE_CODE_USE_BEDROCK: '1' }],
        ['ambient runtime', { ...built.env, NODE_OPTIONS: '--require /tmp/untrusted.js' }],
        ['unknown runtime', { ...built.env, MASTRA_RUNTIME_MODE: 'ambient' }],
        ['wrong user', { ...built.env, USER: 'other-user' }],
      ] as const;
      for (const [, env] of mutatedEnvironments) {
        const mutated = { ...built, env } as unknown as ClaudeLaunchProfile;
        await expect(validateClaudeLaunchProfilePaths(mutated, { ownedRoot: workspace.root })).rejects.toThrow(
          /environment|credential|provider|ambient|user/,
        );
        await expect(materializeClaudeMcpConfig(mutated, { ownedRoot: workspace.root })).rejects.toThrow(
          /environment|credential|provider|ambient|user/,
        );
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it('materializes canonical JSON exclusively and supports the combined builder path', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const built = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });
      const materialized = await materializeClaudeMcpConfig(built, { ownedRoot: workspace.root });

      expect(materialized).toEqual({ path: workspace.paths.mcpConfigPath, bytes: Buffer.byteLength(built.mcpConfigJson, 'utf8') });
      expect(await readFile(workspace.paths.mcpConfigPath, 'utf8')).toBe(built.mcpConfigJson);
      expect((await stat(workspace.paths.mcpConfigPath)).mode & 0o777).toBe(0o600);
    } finally {
      await workspace.cleanup();
    }

    const combinedWorkspace = await createClaudeOwnedWorkspace();
    try {
      const built = await buildAndMaterializeClaudeLaunchProfile(
        {
          paths: combinedWorkspace.paths,
          mcpServers: { fixture: fixtureServer },
        },
        { ownedRoot: combinedWorkspace.root },
      );
      expect(await readFile(combinedWorkspace.paths.mcpConfigPath, 'utf8')).toBe(built.mcpConfigJson);
    } finally {
      await combinedWorkspace.cleanup();
    }
  });

  it('validates an already-materialized config only when its bytes and mode remain canonical', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const built = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });
      await materializeClaudeMcpConfig(built, { workspace });
      await expect(validateClaudeLaunchProfilePaths(built, { workspace, allowMaterializedConfig: true })).resolves.toBeUndefined();

      await expect(validateClaudeLaunchProfilePaths(built, { workspace })).rejects.toThrow(/already exists/);
      const mutated = { ...built, mcpConfigJson: `${built.mcpConfigJson} ` } as ClaudeLaunchProfile;
      await expect(validateClaudeLaunchProfilePaths(mutated, { workspace, allowMaterializedConfig: true })).rejects.toThrow(
        /MCP config JSON/,
      );
      await writeFile(workspace.paths.mcpConfigPath, '{"mcpServers":{}}\n', { mode: 0o600 });
      await expect(validateClaudeLaunchProfilePaths(built, { workspace, allowMaterializedConfig: true })).rejects.toThrow(
        /canonical profile JSON/,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('rejects symlinked roots, ancestors, and final config paths', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    const target = await createClaudeOwnedWorkspace();
    try {
      const rootStat = await lstat(workspace.root);
      const rootSymlinkFilesystem = {
        lstat: async (path: string) =>
          path === workspace.root
            ? {
                isDirectory: () => rootStat.isDirectory(),
                isSymbolicLink: () => true,
                uid: rootStat.uid,
                dev: rootStat.dev,
                ino: rootStat.ino,
              }
            : lstat(path),
        realpath: async (path: string) => path,
        open: async () => {
          throw new Error('open must not be reached for a symlinked root');
        },
        unlink: async () => undefined,
      };
      const rootProfile = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });
      await expect(
        validateClaudeLaunchProfilePaths(rootProfile, { workspace, filesystem: rootSymlinkFilesystem }),
      ).rejects.toThrow(/symlink/);

      const ancestorLink = join(workspace.root, 'linked-root');
      await symlink(target.root, ancestorLink, 'dir');
      const ancestorProfile = buildClaudeLaunchProfile({
        paths: {
          ...workspace.paths,
          cwd: join(ancestorLink, 'project'),
          tmpDir: join(ancestorLink, 'project', 'tmp'),
          mcpConfigPath: join(ancestorLink, 'project', 'generated', 'mcp.json'),
        },
        mcpServers: { fixture: fixtureServer },
      });
      await expect(validateClaudeLaunchProfilePaths(ancestorProfile, { workspace })).rejects.toThrow(/symlink/);

      await symlink(workspace.paths.tmpDir, workspace.paths.mcpConfigPath, 'dir');
      await expect(validateClaudeLaunchProfilePaths(rootProfile, { workspace })).rejects.toThrow(/symlink/);
      await unlink(workspace.paths.mcpConfigPath);
      await unlink(ancestorLink);
    } finally {
      await workspace.cleanup();
      await target.cleanup();
    }
  });

  it('fails closed when the owned root or config parent identity changes during materialization', async () => {
    for (const swappedPath of ['root', 'parent'] as const) {
      for (const swapPhase of ['open', 'write'] as const) {
        const workspace = await createClaudeOwnedWorkspace();
        let swapped = false;
        const swapTarget = swappedPath === 'root' ? workspace.root : dirname(workspace.paths.mcpConfigPath);
        const built = buildClaudeLaunchProfile({
          paths: workspace.paths,
          mcpServers: { fixture: fixtureServer },
        });
        const filesystem = {
          lstat: async (path: string) => {
            const actual = await lstat(path);
            if (swapped && path === swapTarget) {
              return {
                isDirectory: () => actual.isDirectory(),
                isSymbolicLink: () => false,
                uid: actual.uid,
                dev: actual.dev,
                ino: (actual.ino ?? 0) + 1,
              };
            }
            return actual;
          },
          realpath: async (path: string) => path,
          open: async (path: string, flags: number, mode?: number) => {
            const handle = await open(path, flags, mode);
            if (swapPhase === 'open') swapped = true;
            return {
              writeFile: async (data: string, encoding: 'utf8') => {
                await handle.writeFile(data, encoding);
                if (swapPhase === 'write') swapped = true;
              },
              close: () => handle.close(),
            };
          },
          unlink: async (path: string) => unlink(path),
        };

        try {
          await expect(materializeClaudeMcpConfig(built, { workspace, filesystem })).rejects.toThrow(/identity changed/);
        } finally {
          await workspace.cleanup();
        }
      }
    }
  });

  it('rejects same-path replacement of every registered workspace directory', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const built = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });
      const directoryPaths = [
        workspace.root,
        workspace.paths.cwd,
        workspace.paths.tmpDir,
        dirname(workspace.paths.mcpConfigPath),
      ];

      for (const replacedPath of directoryPaths) {
        const filesystem = {
          lstat: async (path: string) => {
            const actual = await lstat(path);
            if (path !== replacedPath) return actual;
            return {
              isDirectory: () => true,
              isSymbolicLink: () => false,
              mode: (actual.mode & ~0o777) | 0o700,
              uid: actual.uid,
              dev: actual.dev,
              ino: (actual.ino ?? 0) + 1,
            };
          },
          realpath: async (path: string) => path,
          open: async () => {
            throw new Error('open must not be reached after replacement');
          },
          unlink: async () => undefined,
        };

        await expect(validateClaudeLaunchProfilePaths(built, { workspace, filesystem })).rejects.toThrow(
          /identity\/mode|registered workspace evidence/,
        );
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it('rejects a registered workspace directory whose mode changes', async () => {
    const workspace = await createClaudeOwnedWorkspace();
    try {
      const built = buildClaudeLaunchProfile({
        paths: workspace.paths,
        mcpServers: { fixture: fixtureServer },
      });
      const replacedPath = workspace.paths.tmpDir;
      const filesystem = {
        lstat: async (path: string) => {
          const actual = await lstat(path);
          if (path !== replacedPath) return actual;
          return {
            isDirectory: () => true,
            isSymbolicLink: () => false,
            mode: (actual.mode & ~0o777) | 0o750,
            uid: actual.uid,
            dev: actual.dev,
            ino: actual.ino,
          };
        },
        realpath: async (path: string) => path,
        open: async () => {
          throw new Error('open must not be reached after mode change');
        },
        unlink: async () => undefined,
      };

      await expect(validateClaudeLaunchProfilePaths(built, { workspace, filesystem })).rejects.toThrow(/mode 700/);
    } finally {
      await workspace.cleanup();
    }
  });

  it('sanitizes a failed auth status to bounded no-auth evidence', () => {
    expect(sanitizeClaudeAuthStatus({ loggedIn: false, token: 'must-not-leak', version: FIXTURE_CLAUDE_VERSION }, 1)).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'unknown',
      exitCode: 1,
      blocked: true,
      blockedReason: 'status-command-failed',
    });
  });

  it('blocks API-key authentication even when the vendor reports logged in', () => {
    const result = profile({
      authStatusRaw: {
        loggedIn: true,
        authMethod: 'apiKey',
        apiProvider: 'apiKey',
      },
    });

    expect(result.readiness).toBe('blocked');
    expect(result.authEvidence).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'unknown',
      exitCode: 0,
      blocked: true,
      blockedReason: 'api-key-authentication',
    });
  });

  it('blocks contradictory subscription status from API-key or external providers', () => {
    for (const apiProvider of ['apiKey', 'bedrock', 'external']) {
      const result = profile({
        authStatusRaw: {
          loggedIn: true,
          authMethod: 'subscription',
          apiProvider,
          version: FIXTURE_CLAUDE_VERSION,
        },
      });

      expect(result.readiness).toBe('blocked');
      expect(result.authEvidence.blocked).toBe(true);
    }
  });

  it('rejects an unsafe symlink policy and canonicalizes paths under the disposable root', () => {
    expect(() => profile({ paths: { ...paths, symlinkPolicy: 'allow' } })).toThrow(/symlinks/);
    expect(() => profile({ paths: { ...paths, tmpDir: 'tmp/../tmp' } })).toThrow(/traversal/);
    expect(() => profile({ paths: { ...paths, mcpConfigPath: '/tmp/subscription-runtime/mcp.json' } })).toThrow(
      /within paths\.cwd/,
    );

    const result = profile({ paths: { ...paths, tmpDir: 'tmp' } });
    expect(result.env.TMPDIR).toBe(`${paths.cwd}/tmp`);
  });

  it('rejects missing ownership UID evidence while creating a workspace', async () => {
    const filesystem = {
      lstat: async (path: string) => {
        const actual = await lstat(path);
        return {
          isDirectory: () => actual.isDirectory(),
          isSymbolicLink: () => actual.isSymbolicLink(),
          mode: actual.mode,
          dev: actual.dev,
          ino: actual.ino,
        };
      },
      realpath: async (path: string) => realpath(path),
    };

    await expect(createClaudeOwnedWorkspace({ filesystem })).rejects.toThrow(/ownership UID evidence/);
  });

  it('does not treat a missing or malformed version result as installed', () => {
    expect(sanitizeClaudeVersionStatus({ loggedIn: true }, 0)).toEqual({ available: false, exitCode: 0 });
    expect(sanitizeClaudeVersionStatus('credentials=secret', 0)).toEqual({ available: false, exitCode: 0 });
    expect(sanitizeClaudeVersionStatus('Claude 1.2.3 then 4.5.6', 0)).toEqual({ available: false, exitCode: 0 });
    expect(sanitizeClaudeVersionStatus('Claude 1.2', 0)).toEqual({ available: false, exitCode: 0 });
    expect(sanitizeClaudeVersionStatus('Claude 01.2.3', 0)).toEqual({ available: false, exitCode: 0 });
  });
});
