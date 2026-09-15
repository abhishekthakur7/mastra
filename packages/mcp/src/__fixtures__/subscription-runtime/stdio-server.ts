import { closeFixtureMcpStdioServer, startFixtureMcpStdioServer } from './mcp-fixture';

const server = await startFixtureMcpStdioServer();
let shutdownPromise: Promise<void> | undefined;
let shutdownFailureReported = false;

const shutdown = (): Promise<void> => {
  if (!shutdownPromise) {
    process.stdin.pause();
    shutdownPromise = closeFixtureMcpStdioServer(server);
  }
  return shutdownPromise;
};

const handleShutdown = (): void => {
  void shutdown().catch(error => {
    process.exitCode = 1;
    process.stdin.destroy();
    process.stdout.destroy();
    if (!shutdownFailureReported) {
      shutdownFailureReported = true;
      console.error('Fatal error shutting down fixture MCP stdio server', error);
    }
    process.exit(1);
  });
};

process.once('SIGINT', handleShutdown);
process.once('SIGTERM', handleShutdown);
process.stdin.once('end', handleShutdown);
process.stdin.once('close', handleShutdown);
