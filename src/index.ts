import { loadConfig, publicConfig } from "./config.ts";
import { loadEnvironment } from "./env.ts";
import { createStructuredLogger, serializeError, type StructuredLogger } from "./logging.ts";
import { createProxyServer } from "./proxy.ts";

type ShutdownSignal = "SIGINT" | "SIGTERM";

async function closeLogger(logger: StructuredLogger): Promise<void> {
  if (typeof logger.close === "function") {
    await logger.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(await loadEnvironment(Bun.env));
  const logger = createStructuredLogger({
    pretty: config.prettyLogs,
    filePath: config.logFile,
  });
  const server = createProxyServer(config, logger);
  let shuttingDown = false;

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log({
      timestamp: new Date().toISOString(),
      event: "proxy.stopping",
      signal,
    });

    let exitCode = 0;

    try {
      await server.stop();
    } catch (error) {
      logger.log({
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

  logger.log({
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
