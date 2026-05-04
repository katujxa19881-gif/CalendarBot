import { randomUUID } from "node:crypto";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import { runHealthcheckProbe } from "./db";
import { getTelegramRuntime } from "./telegram/bot";
import { logEvent } from "./logger";

export function buildServer() {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const requestId = (request.headers["x-request-id"] as string | undefined) ?? randomUUID();
    request.headers["x-request-id"] = requestId;

    logEvent({
      operation: "http_request_received",
      request_id: requestId,
      status: "received",
      details: {
        method: request.method,
        path: request.url
      }
    });
  });

  app.get("/health", async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.headers["x-request-id"] as string;

    await runHealthcheckProbe();

    logEvent({
      operation: "healthcheck_ok",
      request_id: requestId,
      status: "ok"
    });

    reply.code(200).send({ status: "ok" });
  });

  app.post("/telegram/webhook", async (_request: FastifyRequest, reply: FastifyReply) => {
    const transport = (process.env.TELEGRAM_TRANSPORT ?? "polling").trim().toLowerCase();
    if (transport === "polling") {
      reply.code(200).send({ ok: true, ignored: "polling_transport_enabled" });
      return;
    }

    const runtime = getTelegramRuntime();

    if (!runtime) {
      logEvent({
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
