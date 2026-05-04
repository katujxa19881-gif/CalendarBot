"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDatabaseUrl = resolveDatabaseUrl;
exports.getServerConfig = getServerConfig;
exports.getTelegramConfig = getTelegramConfig;
exports.getGoogleCalendarConfig = getGoogleCalendarConfig;
exports.getApprovalConfig = getApprovalConfig;
exports.getEmailConfig = getEmailConfig;
exports.getBackgroundJobsConfig = getBackgroundJobsConfig;
exports.getMiniAppConfig = getMiniAppConfig;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function resolveDatabaseUrl() {
    const sqlitePath = node_path_1.default.resolve(process.env.SQLITE_PATH ?? "./data/app.db");
    (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(sqlitePath), { recursive: true });
    if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL = `file:${sqlitePath}`;
    }
    return {
        sqlitePath,
        databaseUrl: process.env.DATABASE_URL
    };
}
function getServerConfig() {
    return {
        host: process.env.HOST ?? "0.0.0.0",
        port: Number(process.env.PORT ?? 3000)
    };
}
function getTelegramConfig() {
    return {
        botToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
        webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null
    };
}
function getGoogleCalendarConfig() {
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
function getApprovalConfig() {
    return {
        adminTelegramId: process.env.ADMIN_TELEGRAM_ID ?? null
    };
}
function getEmailConfig() {
    const sendGridApiKey = process.env.SENDGRID_API_KEY ?? null;
    return {
        enabled: Boolean(sendGridApiKey),
        sendGridApiKey,
        fromEmail: process.env.SENDGRID_FROM_EMAIL ?? "no-reply@example.com",
        fromName: process.env.SENDGRID_FROM_NAME ?? null
    };
}
function getBackgroundJobsConfig() {
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
function getMiniAppConfig() {
    const enabledRaw = (process.env.MINI_APP_ENABLED ?? "false").trim().toLowerCase();
    const adminEnabledRaw = (process.env.MINI_APP_ADMIN_ENABLED ?? "false").trim().toLowerCase();
    const browserAuthEnabledRaw = (process.env.MINI_APP_BROWSER_AUTH_ENABLED ?? "false").trim().toLowerCase();
    const onboardingEnabledRaw = (process.env.MINI_APP_ONBOARDING_ENABLED ?? "true").trim().toLowerCase();
    const authMaxAgeSeconds = Number(process.env.MINI_APP_AUTH_MAX_AGE_SECONDS ?? 86400);
    const sessionTtlSeconds = Number(process.env.MINI_APP_SESSION_TTL_SECONDS ?? 43200);
    const sessionSecret = process.env.MINI_APP_SESSION_SECRET ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    const webAppUrl = process.env.MINI_APP_URL ?? null;
    const menuButtonText = process.env.MINI_APP_MENU_BUTTON_TEXT ?? "Открыть NexaMeet";
    const browserAuthTelegramId = (process.env.MINI_APP_BROWSER_AUTH_TELEGRAM_ID ?? "").trim() || null;
    return {
        enabled: enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes",
        adminEnabled: adminEnabledRaw === "1" || adminEnabledRaw === "true" || adminEnabledRaw === "yes",
        browserAuthEnabled: browserAuthEnabledRaw === "1" || browserAuthEnabledRaw === "true" || browserAuthEnabledRaw === "yes",
        onboardingEnabled: onboardingEnabledRaw !== "0" && onboardingEnabledRaw !== "false" && onboardingEnabledRaw !== "no",
        authMaxAgeSeconds: Number.isFinite(authMaxAgeSeconds) && authMaxAgeSeconds > 0
            ? Math.floor(authMaxAgeSeconds)
            : 86400,
        sessionTtlSeconds: Number.isFinite(sessionTtlSeconds) && sessionTtlSeconds > 0
            ? Math.floor(sessionTtlSeconds)
            : 43200,
        sessionSecret,
        webAppUrl,
        menuButtonText,
        browserAuthTelegramId
    };
}
