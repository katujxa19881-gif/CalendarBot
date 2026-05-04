"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const env_1 = require("../env");
const logger_1 = require("../logger");
const bot_1 = require("../telegram/bot");
const TELEGRAM_USER_ID = "900004";
const CHAT_ID = 900004;
const user = {
    id: Number(TELEGRAM_USER_ID),
    is_bot: false,
    first_name: "Анна",
    last_name: "Смирнова",
    username: "stage4_user",
    language_code: "ru"
};
let updateId = 4000;
let messageId = 5000;
function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
function nextUpdateId() {
    updateId += 1;
    return updateId;
}
function nextMessageId() {
    messageId += 1;
    return messageId;
}
function createMessageUpdate(text) {
    return {
        update_id: nextUpdateId(),
        message: {
            message_id: nextMessageId(),
            date: nowSeconds(),
            chat: {
                id: CHAT_ID,
                type: "private"
            },
            from: user,
            text
        }
    };
}
function createCallbackUpdate(data) {
    return {
        update_id: nextUpdateId(),
        callback_query: {
            id: `cb_${updateId}`,
            from: user,
            chat_instance: "stage4_verify",
            data,
            message: {
                message_id: nextMessageId(),
                date: nowSeconds(),
                chat: {
                    id: CHAT_ID,
                    type: "private"
                },
                text: "button"
            }
        }
    };
}
async function cleanupTestUserData() {
    const dbUser = await db_1.prisma.user.findUnique({ where: { telegramId: TELEGRAM_USER_ID } });
    if (!dbUser) {
        return;
    }
    const requests = await db_1.prisma.meetingRequest.findMany({
        where: { userId: dbUser.id },
        select: { id: true }
    });
    const requestIds = requests.map((request) => request.id);
    if (requestIds.length > 0) {
        await db_1.prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    }
    await db_1.prisma.actionLog.deleteMany({ where: { userId: dbUser.id } });
    await db_1.prisma.meetingRequestDraft.deleteMany({ where: { userId: dbUser.id } });
    await db_1.prisma.meetingRequest.deleteMany({ where: { userId: dbUser.id } });
    await db_1.prisma.user.delete({ where: { id: dbUser.id } });
}
async function run() {
    (0, env_1.resolveDatabaseUrl)();
    (0, logger_1.logEvent)({
        operation: "slots_built",
        status: "ok",
        details: { stage: "4", mode: "verify_script_start" }
    });
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage4verify";
    let conflictChecksRemaining = 1;
    let oauthLogged = false;
    const testProvider = {
        async getBusyIntervals(range) {
            if (!oauthLogged) {
                oauthLogged = true;
                (0, logger_1.logEvent)({
                    operation: "google_oauth_connected",
                    status: "ok",
                    details: {
                        stage: "4",
                        mode: "verify_mock_provider"
                    }
                });
            }
            (0, logger_1.logEvent)({
                operation: "calendar_availability_requested",
                status: "ok",
                details: {
                    stage: "4",
                    time_min: range.timeMin.toISOString(),
                    time_max: range.timeMax.toISOString()
                }
            });
            const spanMs = range.timeMax.getTime() - range.timeMin.getTime();
            const sixHoursMs = 6 * 60 * 60 * 1000;
            if (spanMs <= sixHoursMs && conflictChecksRemaining > 0) {
                conflictChecksRemaining -= 1;
                const busy = [
                    {
                        startAt: new Date(range.timeMin.getTime() + 5 * 60 * 1000),
                        endAt: new Date(range.timeMax.getTime() - 5 * 60 * 1000)
                    }
                ];
                (0, logger_1.logEvent)({
                    operation: "calendar_availability_received",
                    status: "ok",
                    details: {
                        stage: "4",
                        busy_count: busy.length
                    }
                });
                return busy;
            }
            (0, logger_1.logEvent)({
                operation: "calendar_availability_received",
                status: "ok",
                details: {
                    stage: "4",
                    busy_count: 0
                }
            });
            return [];
        }
    };
    const runtime = (0, bot_1.createTelegramBotRuntime)({
        botToken,
        webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
        dryRun: true,
        availabilityProvider: testProvider
    });
    try {
        await (0, db_1.connectDatabase)();
        await cleanupTestUserData();
        const firstAttemptUpdates = [
            createMessageUpdate("/start"),
            createCallbackUpdate("consent:accept"),
            createCallbackUpdate("menu:new"),
            createCallbackUpdate("dur:30"),
            createCallbackUpdate("fmt:ONLINE"),
            createCallbackUpdate("slot:0"),
            createMessageUpdate("Сверка расписания"),
            createMessageUpdate("-"),
            createMessageUpdate("guest.stage4@example.com"),
            createMessageUpdate("Анна"),
            createMessageUpdate("Смирнова"),
            createCallbackUpdate("review:submit")
        ];
        for (const update of firstAttemptUpdates) {
            await runtime.bot.handleUpdate(update);
        }
        const firstAttemptState = await (0, bot_1.ensureWizardStateForUser)(TELEGRAM_USER_ID);
        if (firstAttemptState.requests.length !== 0) {
            throw new Error("Expected no created requests after conflict recheck");
        }
        if (firstAttemptState.draft?.status !== client_1.DraftStatus.ACTIVE || firstAttemptState.draft.currentStep !== "slot") {
            throw new Error("Expected active draft moved back to slot step after conflict");
        }
        const secondAttemptUpdates = [createCallbackUpdate("slot:0"), createCallbackUpdate("review:submit")];
        for (const update of secondAttemptUpdates) {
            await runtime.bot.handleUpdate(update);
        }
        const finalState = await (0, bot_1.ensureWizardStateForUser)(TELEGRAM_USER_ID);
        const hasSubmittedRequest = finalState.requests.some((request) => request.status === client_1.MeetingRequestStatus.PENDING_APPROVAL);
        if (!hasSubmittedRequest) {
            throw new Error("Expected pending approval request after second submit attempt");
        }
        (0, logger_1.logEvent)({
            operation: "slot_conflict_detected",
            status: "ok",
            details: {
                stage: "4",
                requests_count: finalState.requests.length,
                has_active_draft: Boolean(finalState.draft)
            }
        });
    }
    finally {
        await (0, db_1.disconnectDatabase)();
    }
}
run().catch((error) => {
    const err = error instanceof Error ? error : new Error("Unknown stage4 verification error");
    (0, logger_1.logEvent)({
        level: "error",
        operation: "db_error",
        status: "error",
        error_code: "STAGE4_VERIFY_FAILED",
        error_message: err.message
    });
    process.exit(1);
});
