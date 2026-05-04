import { mkdirSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export function resolveDatabaseUrl(): { sqlitePath: string; databaseUrl: string } {
  const sqlitePath = path.resolve(process.env.SQLITE_PATH ?? "./data/app.db");
  mkdirSync(path.dirname(sqlitePath), { recursive: true });

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${sqlitePath}`;
  }

  return {
    sqlitePath,
    databaseUrl: process.env.DATABASE_URL
  };
}

export function getServerConfig(): { host: string; port: number } {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000)
  };
}

export function getTelegramConfig(): {
  botToken: string | null;
  webhookSecretToken: string | null;
} {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null
  };
}

export function getGoogleCalendarConfig(): {
  enabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  calendarId: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? null;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? null;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? null;

  return {
    enabled: Boolean(clientId && clientSecret && refreshToken),
    clientId,
    clientSecret,
    refreshToken,
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary"
  };
}

export function getApprovalConfig(): {
  adminTelegramId: string | null;
} {
  return {
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID ?? null
  };
}

export function getEmailConfig(): {
  enabled: boolean;
  sendGridApiKey: string | null;
  fromEmail: string;
  fromName: string | null;
} {
  const sendGridApiKey = process.env.SENDGRID_API_KEY ?? null;

  return {
    enabled: Boolean(sendGridApiKey),
    sendGridApiKey,
    fromEmail: process.env.SENDGRID_FROM_EMAIL ?? "no-reply@example.com",
    fromName: process.env.SENDGRID_FROM_NAME ?? null
  };
}

export function getBackgroundJobsConfig(): {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
} {
  const enabledRaw = (process.env.BACKGROUND_JOBS_ENABLED ?? "true").trim().toLowerCase();
  const enabled = enabledRaw !== "0" && enabledRaw !== "false" && enabledRaw !== "no";
  const pollIntervalMs = Number(process.env.BACKGROUND_JOBS_POLL_MS ?? 15000);
  const batchSize = Number(process.env.BACKGROUND_JOBS_BATCH_SIZE ?? 10);

  return {
    enabled,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 15000,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 10
  };
}
