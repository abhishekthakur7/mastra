import { FixtureEventRecorder } from './event-recorder';
import { startFixtureHookRelay, type FixtureHookHandler, type FixtureHookRelay } from './hook-relay';
import { startFixtureMcpHttpServer, type FixtureMcpHttpServer } from './mcp-fixture';
import { BoundedResourceScope } from './process-cleanup';
import { PROTOCOL_FIXTURE_MODE } from './types';
import { createDisposableFixtureWorkspace, type FixtureWorkspace } from './workspace';

export type SubscriptionRuntimeFixtureHarness = {
  readonly mode: typeof PROTOCOL_FIXTURE_MODE;
  readonly events: FixtureEventRecorder;
  readonly resources: BoundedResourceScope;
  readonly hookRelay: FixtureHookRelay;
  readonly mcpServer: FixtureMcpHttpServer;
  readonly workspace: FixtureWorkspace;
  cleanup(): Promise<void>;
};

export async function createSubscriptionRuntimeFixtureHarness(options: {
  hookHandler?: FixtureHookHandler;
  hookTimeoutMs?: number;
  resourceScope?: BoundedResourceScope;
} = {}): Promise<SubscriptionRuntimeFixtureHarness> {
  const resources = options.resourceScope ?? new BoundedResourceScope();
  const events = new FixtureEventRecorder({ secretValues: ['fixture-secret', 'fixture-access-token'] });

  try {
    const hookRelay = await startFixtureHookRelay({
      handler: options.hookHandler,
      recorder: events,
      timeoutMs: options.hookTimeoutMs,
    });
    resources.trackCloser(hookRelay.close);

    const mcpServer = await startFixtureMcpHttpServer(events);
    resources.trackCloser(mcpServer.close);

    const workspace = await createDisposableFixtureWorkspace({
      mcpUrl: mcpServer.url,
      hookRelayUrl: hookRelay.url,
      hookTimeoutMs: options.hookTimeoutMs ?? 1_000,
      resourceScope: resources,
    });

    return {
      mode: PROTOCOL_FIXTURE_MODE,
      events,
      resources,
      hookRelay,
      mcpServer,
      workspace,
      cleanup: async () => {
        const evidence = await resources.cleanup();
        if (evidence.remainingPaths.length > 0 || evidence.closeErrors.length > 0) {
          throw new Error(`fixture cleanup incomplete: ${JSON.stringify(evidence)}`);
        }
      },
    };
  } catch (error) {
    try {
      await resources.cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture startup and cleanup failed');
    }
    throw error;
  }
}
