"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const node_crypto_1 = require("node:crypto");
const fastify_1 = __importDefault(require("fastify"));
const db_1 = require("./db");
const bot_1 = require("./telegram/bot");
const logger_1 = require("./logger");
function buildServer() {
    const app = (0, fastify_1.default)({ logger: false });
    app.addHook("onRequest", async (request) => {
        const requestId = request.headers["x-request-id"] ?? (0, node_crypto_1.randomUUID)();
        request.headers["x-request-id"] = requestId;
        (0, logger_1.logEvent)({
            operation: "http_request_received",
            request_id: requestId,
            status: "received",
            details: {
                method: request.method,
                path: request.url
            }
        });
    });
    app.get("/health", async (request, reply) => {
        const requestId = request.headers["x-request-id"];
        await (0, db_1.runHealthcheckProbe)();
        (0, logger_1.logEvent)({
            operation: "healthcheck_ok",
            request_id: requestId,
            status: "ok"
        });
        reply.code(200).send({ status: "ok" });
    });
    app.post("/telegram/webhook", async (_request, reply) => {
        const transport = (process.env.TELEGRAM_TRANSPORT ?? "polling").trim().toLowerCase();
        if (transport === "polling") {
            reply.code(200).send({ ok: true, ignored: "polling_transport_enabled" });
            return;
        }
        const runtime = (0, bot_1.getTelegramRuntime)();
        if (!runtime) {
            (0, logger_1.logEvent)({
                level: "error",
                operation: "startup_error",
                status: "error",
                error_code: "TELEGRAM_BOT_TOKEN_MISSING",
                error_message: "TELEGRAM_BOT_TOKEN is not configured"
            });
            reply.code(503).send({ ok: false, error: "telegram_bot_not_configured" });
            return;
        }
        await runtime.webhookHandler(_request, reply);
    });
    return app;
}
