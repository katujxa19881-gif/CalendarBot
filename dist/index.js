"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const db_1 = require("./db");
const env_1 = require("./env");
const bot_1 = require("./telegram/bot");
const logger_1 = require("./logger");
const worker_1 = require("./background/worker");
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchTelegramUpdates(input) {
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
    const payload = (await response.json());
    if (!payload.ok) {
        throw new Error(`Telegram getUpdates error: ${payload.description ?? "unknown error"}`);
    }
    return payload.result ?? [];
}
function startTelegramPollingLoop(runtime) {
    let stopped = false;
    let offset;
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
                (0, logger_1.logEvent)({
                    operation: "telegram_updates_bootstrap_skipped",
                    status: "ok",
                    details: {
                        skipped_until_update_id: latestUpdate[0].update_id
                    }
                });
            }
        }
        catch (error) {
            (0, logger_1.logEvent)({
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
                    (0, logger_1.logEvent)({
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
                    await runtime.bot.handleUpdate(update);
                }
            }
            catch (error) {
                (0, logger_1.logEvent)({
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
        const { sqlitePath, databaseUrl } = (0, env_1.resolveDatabaseUrl)();
        (0, logger_1.logEvent)({
            operation: "sqlite_storage_ready",
            status: "ok",
            details: {
                sqlite_path: sqlitePath,
                database_url: databaseUrl
            }
        });
        await (0, db_1.connectDatabase)();
        (0, logger_1.logEvent)({ operation: "db_connected", status: "ok" });
        const app = (0, server_1.buildServer)();
        const { host, port } = (0, env_1.getServerConfig)();
        await app.listen({ host, port });
        (0, logger_1.logEvent)({
            operation: "app_started",
            status: "ok",
            details: { host, port }
        });
        (0, worker_1.startBackgroundWorker)();
        const telegramRuntime = (0, bot_1.getTelegramRuntime)();
        const telegramTransport = (process.env.TELEGRAM_TRANSPORT ?? "polling").trim().toLowerCase();
        const usePolling = telegramTransport === "polling" || telegramTransport === "auto";
        let stopPolling = null;
        if (telegramRuntime && usePolling) {
            stopPolling = startTelegramPollingLoop(telegramRuntime);
            (0, logger_1.logEvent)({
                operation: "telegram_polling_started",
                status: "ok",
                details: {
                    transport: telegramTransport
                }
            });
        }
        const shutdown = async () => {
            stopPolling?.();
            (0, worker_1.stopBackgroundWorker)();
            telegramRuntime?.bot.stop();
            await app.close();
            await (0, db_1.disconnectDatabase)();
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown startup error");
        (0, logger_1.logEvent)({
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
