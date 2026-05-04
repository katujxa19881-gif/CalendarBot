import { buildServer } from "./server";
import { connectDatabase, disconnectDatabase } from "./db";
import { getServerConfig, resolveDatabaseUrl } from "./env";
import { getTelegramRuntime } from "./telegram/bot";
import { logEvent } from "./logger";
import { startBackgroundWorker, stopBackgroundWorker } from "./background/worker";
import type { Update } from "grammy/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTelegramUpdates(input: {
  botToken: string;
  offset?: number;
  timeoutSeconds: number;
  limit?: number;
}): Promise<Update[]> {
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/getUpdates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      offset: input.offset,
      limit: input.limit,
      timeout: input.timeoutSeconds,
      allowed_updates: ["message", "callback_query"]
    })
  });

  if (!response.ok) {
    const text = (await response.text()).slice(0, 1000);
    throw new Error(`Telegram getUpdates HTTP ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as {
    ok: boolean;
    result?: Update[];
    description?: string;
  };

  if (!payload.ok) {
    throw new Error(`Telegram getUpdates error: ${payload.description ?? "unknown error"}`);
  }

  return payload.result ?? [];
}

function startTelegramPollingLoop(runtime: NonNullable<ReturnType<typeof getTelegramRuntime>>): () => void {
  let stopped = false;
  let offset: number | undefined;

  const loop = async () => {
    try {
      const latestUpdate = await fetchTelegramUpdates({
        botToken: runtime.bot.token,
        offset: -1,
        limit: 1,
        timeoutSeconds: 0
      });

      if (latestUpdate.length > 0) {
        offset = latestUpdate[0].update_id + 1;
        logEvent({
          operation: "telegram_updates_bootstrap_skipped",
          status: "ok",
          details: {
            skipped_until_update_id: latestUpdate[0].update_id
          }
        });
      }
    } catch (error) {
      logEvent({
        level: "warn",
        operation: "telegram_updates_bootstrap_skipped",
        status: "error",
        error_code: "TELEGRAM_BOOTSTRAP_OFFSET_FAILED",
        error_message: error instanceof Error ? error.message : "Failed to set initial polling offset"
      });
    }

    while (!stopped) {
      try {
        const updates = await fetchTelegramUpdates({
          botToken: runtime.bot.token,
          offset,
          timeoutSeconds: 30
        });

        if (updates.length > 0) {
          logEvent({
            operation: "telegram_updates_polled",
            status: "ok",
            details: {
              updates_count: updates.length,
              first_update_id: updates[0]?.update_id ?? null,
              last_update_id: updates[updates.length - 1]?.update_id ?? null
            }
          });
        }

        for (const update of updates) {
          offset = update.update_id + 1;
          await runtime.bot.handleUpdate(update as never);
        }
      } catch (error) {
        logEvent({
          level: "error",
          operation: "telegram_polling_failed",
          status: "error",
          error_code: "TELEGRAM_POLLING_LOOP_FAILED",
          error_message: error instanceof Error ? error.message : "Unknown telegram polling error"
        });
        await sleep(2000);
      }
    }
  };

  void loop();

  return () => {
    stopped = true;
  };
}

async function bootstrap() {
  try {
    const { sqlitePath, databaseUrl } = resolveDatabaseUrl();

    logEvent({
      operation: "sqlite_storage_ready",
      status: "ok",
      details: {
        sqlite_path: sqlitePath,
        database_url: databaseUrl
      }
    });

    await connectDatabase();
    logEvent({ operation: "db_connected", status: "ok" });

    const app = buildServer();
    const { host, port } = getServerConfig();

    await app.listen({ host, port });
    logEvent({
      operation: "app_started",
      status: "ok",
      details: { host, port }
    });
    startBackgroundWorker();

    const telegramRuntime = getTelegramRuntime();
    const telegramTransport = (process.env.TELEGRAM_TRANSPORT ?? "polling").trim().toLowerCase();
    const usePolling = telegramTransport === "polling" || telegramTransport === "auto";
    let stopPolling: (() => void) | null = null;

    if (telegramRuntime && usePolling) {
      stopPolling = startTelegramPollingLoop(telegramRuntime);

      logEvent({
        operation: "telegram_polling_started",
        status: "ok",
        details: {
          transport: telegramTransport
        }
      });
    }

    const shutdown = async () => {
      stopPolling?.();
      stopBackgroundWorker();
      telegramRuntime?.bot.stop();
      await app.close();
      await disconnectDatabase();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Unknown startup error");

    logEvent({
      level: "error",
      operation: "startup_error",
      status: "error",
      error_code: "STARTUP_FAILURE",
      error_message: err.message
    });

    process.exit(1);
  }
}

void bootstrap();
