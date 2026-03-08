import { loadConfig, parseCliArgs, publicConfig } from "./config.ts";
import { loadEnvironment } from "./env.ts";
import { createStructuredLogger, serializeError, type StructuredLogger } from "./logging.ts";
import { createProxyServer } from "./proxy.ts";

type ShutdownSignal = "SIGINT" | "SIGTERM";

async function closeLogger(logger: StructuredLogger | undefined): Promise<void> {
  if (logger && typeof logger.close === "function") {
    await logger.close();
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
cc-lmstudio-proxy - Claude Code LM Studio Proxy Server

Usage: bun run src/index.ts [options]

Options:
  --log, -l    Enable logging (outputs to LOG_FILE from .env or stdout)
  --help, -h   Show this help message

Environment Variables:
  UPSTREAM_BASE_URL     Upstream server URL (required)
  PROXY_HOST            Proxy host (default: 127.0.0.1)
  PROXY_PORT            Proxy port (default: 9000)
  LOG_FILE              Log file path (used only with --log flag)
  LOG_PRETTY            Pretty print logs (default: false)
`);
}

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));

  if (cliOptions.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig(await loadEnvironment(Bun.env), cliOptions);

  // --log が指定された場合のみロギングを有効化
  const logger = config.enableLogging
    ? createStructuredLogger({
        pretty: config.prettyLogs,
        filePath: config.logFile,
      })
    : undefined;
  const server = createProxyServer(config, logger);
  let shuttingDown = false;

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger?.log({
      timestamp: new Date().toISOString(),
      event: "proxy.stopping",
      signal,
    });

    let exitCode = 0;

    try {
      await server.stop();
    } catch (error) {
      logger?.log({
        timestamp: new Date().toISOString(),
        event: "proxy.shutdown_error",
        signal,
        error: serializeError(error),
      });
      exitCode = 1;
    }

    try {
      await closeLogger(logger);
    } catch (error) {
      await Bun.write(
        Bun.stderr,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "proxy.log_close_error",
          error: serializeError(error),
        })}\n`,
      );
      exitCode = 1;
    }

    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  logger?.log({
    timestamp: new Date().toISOString(),
    event: "proxy.started",
    ...publicConfig({
      ...config,
      host: server.hostname ?? config.host,
      port: server.port ?? config.port,
    }),
  });
}

void main().catch(async (error) => {
  await Bun.write(
    Bun.stderr,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "proxy.startup_error",
      error: serializeError(error),
    })}\n`,
  );
  process.exit(1);
});
