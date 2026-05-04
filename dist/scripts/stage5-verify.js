"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const env_1 = require("../env");
const logger_1 = require("../logger");
const bot_1 = require("../telegram/bot");
const USER_TELEGRAM_ID = "900005";
const USER_CHAT_ID = 900005;
const ADMIN_TELEGRAM_ID = "900099";
const ADMIN_CHAT_ID = 900099;
const requester = {
    id: Number(USER_TELEGRAM_ID),
    is_bot: false,
    first_name: "Мария",
    last_name: "Ильина",
    username: "stage5_user",
    language_code: "ru"
};
const admin = {
    id: Number(ADMIN_TELEGRAM_ID),
    is_bot: false,
    first_name: "Админ",
    last_name: "Тестов",
    username: "stage5_admin",
    language_code: "ru"
};
let updateId = 5000;
let messageId = 7000;
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
function createMessageUpdate(user, chatId, text) {
    return {
        update_id: nextUpdateId(),
        message: {
            message_id: nextMessageId(),
            date: nowSeconds(),
            chat: {
                id: chatId,
                type: "private"
            },
            from: user,
            text
        }
    };
}
function createCallbackUpdate(user, chatId, data) {
    return {
        update_id: nextUpdateId(),
        callback_query: {
            id: `cb_${updateId}`,
            from: user,
            chat_instance: "stage5_verify",
            data,
            message: {
                message_id: nextMessageId(),
                date: nowSeconds(),
                chat: {
                    id: chatId,
                    type: "private"
                },
                text: "button"
            }
        }
    };
}
async function cleanupTestData() {
    const users = await db_1.prisma.user.findMany({
        where: {
            telegramId: {
                in: [USER_TELEGRAM_ID, ADMIN_TELEGRAM_ID]
            }
        },
        select: { id: true }
    });
    const userIds = users.map((u) => u.id);
    if (userIds.length === 0) {
        return;
    }
    const requests = await db_1.prisma.meetingRequest.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
    });
    const requestIds = requests.map((request) => request.id);
    if (requestIds.length > 0) {
        await db_1.prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    }
    await db_1.prisma.actionLog.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
async function buildAndSubmitRequest(runtime, topic) {
    const flow = [
        createMessageUpdate(requester, USER_CHAT_ID, "/start"),
        createCallbackUpdate(requester, USER_CHAT_ID, "consent:accept"),
        createCallbackUpdate(requester, USER_CHAT_ID, "menu:new"),
        createCallbackUpdate(requester, USER_CHAT_ID, "dur:30"),
        createCallbackUpdate(requester, USER_CHAT_ID, "fmt:ONLINE"),
        createCallbackUpdate(requester, USER_CHAT_ID, "slot:0"),
        createMessageUpdate(requester, USER_CHAT_ID, topic),
        createMessageUpdate(requester, USER_CHAT_ID, "-"),
        createMessageUpdate(requester, USER_CHAT_ID, "guest.stage5@example.com"),
        createMessageUpdate(requester, USER_CHAT_ID, "Мария"),
        createMessageUpdate(requester, USER_CHAT_ID, "Ильина"),
        createCallbackUpdate(requester, USER_CHAT_ID, "review:submit")
    ];
    for (const update of flow) {
        await runtime.bot.handleUpdate(update);
    }
    const pending = await db_1.prisma.meetingRequest.findFirst({
        where: {
            status: client_1.MeetingRequestStatus.PENDING_APPROVAL,
            topic
        },
        orderBy: { createdAt: "desc" }
    });
    if (!pending) {
        throw new Error(`Expected pending request for topic: ${topic}`);
    }
    return pending.id;
}
async function run() {
    (0, env_1.resolveDatabaseUrl)();
    process.env.DISABLE_ANTI_SPAM = "true";
    (0, logger_1.logEvent)({
        operation: "approval_requested",
        status: "ok",
        details: { stage: "5", mode: "verify_script_start" }
    });
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage5verify";
    let eventSeq = 0;
    const calendarEventSyncProvider = {
        async createEvent(input) {
            eventSeq += 1;
            return {
                googleCalendarEventId: `gcal_event_${eventSeq}_${input.externalRequestId}`,
                googleCalendarId: "primary",
                googleMeetLink: null
            };
        },
        async updateEvent(input) {
            return {
                googleCalendarEventId: input.googleCalendarEventId,
                googleCalendarId: "primary",
                googleMeetLink: null
            };
        },
        async cancelEvent(_input) {
            return;
        }
    };
    const runtime = (0, bot_1.createTelegramBotRuntime)({
        botToken,
        webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
        dryRun: true,
        calendarEventSyncProvider,
        adminTelegramId: ADMIN_TELEGRAM_ID
    });
    try {
        await (0, db_1.connectDatabase)();
        await cleanupTestData();
        const requestToApproveId = await buildAndSubmitRequest(runtime, "Этап 5 подтверждение");
        await runtime.bot.handleUpdate(createCallbackUpdate(admin, ADMIN_CHAT_ID, `approval:confirm:${requestToApproveId}`));
        const approved = await db_1.prisma.meetingRequest.findUnique({
            where: { id: requestToApproveId }
        });
        if (!approved || approved.status !== client_1.MeetingRequestStatus.APPROVED) {
            throw new Error("Expected APPROVED status after admin confirmation");
        }
        const syncedEvent = await db_1.prisma.calendarEvent.findUnique({ where: { meetingRequestId: requestToApproveId } });
        if (!syncedEvent || syncedEvent.syncStatus !== client_1.CalendarEventSyncStatus.SYNCED) {
            throw new Error("Expected synced calendar event");
        }
        const requestToRejectId = await buildAndSubmitRequest(runtime, "Этап 5 отклонение");
        await runtime.bot.handleUpdate(createCallbackUpdate(admin, ADMIN_CHAT_ID, `approval:reject:${requestToRejectId}`));
        await runtime.bot.handleUpdate(createMessageUpdate(admin, ADMIN_CHAT_ID, "Слот конфликтует с личной встречей"));
        const rejected = await db_1.prisma.meetingRequest.findUnique({
            where: { id: requestToRejectId }
        });
        if (!rejected || rejected.status !== client_1.MeetingRequestStatus.REJECTED) {
            throw new Error("Expected REJECTED status after admin rejection");
        }
        if (!rejected.approverComment || !rejected.approverComment.includes("конфликт")) {
            throw new Error("Expected rejection comment saved in meeting request");
        }
        const userEntity = await db_1.prisma.user.findUnique({ where: { telegramId: USER_TELEGRAM_ID } });
        if (!userEntity) {
            throw new Error("Expected requester user to exist");
        }
        const logs = await db_1.prisma.actionLog.findMany({
            where: {
                userId: userEntity.id,
                actionType: {
                    in: [
                        client_1.JournalActionType.APPROVAL_CONFIRMED,
                        client_1.JournalActionType.APPROVAL_REJECTED,
                        client_1.JournalActionType.CALENDAR_EVENT_CREATED
                    ]
                }
            }
        });
        const hasApprovalConfirmed = logs.some((log) => log.actionType === client_1.JournalActionType.APPROVAL_CONFIRMED);
        const hasApprovalRejected = logs.some((log) => log.actionType === client_1.JournalActionType.APPROVAL_REJECTED);
        const hasCalendarEventCreated = logs.some((log) => log.actionType === client_1.JournalActionType.CALENDAR_EVENT_CREATED);
        if (!hasApprovalConfirmed || !hasApprovalRejected || !hasCalendarEventCreated) {
            throw new Error("Expected approval and calendar action logs for stage 5 flow");
        }
        const noActiveDraft = (await db_1.prisma.meetingRequestDraft.count({ where: { userId: userEntity.id, status: client_1.DraftStatus.ACTIVE } })) === 0;
        if (!noActiveDraft) {
            throw new Error("Expected no active drafts after completed stage 5 scenarios");
        }
        (0, logger_1.logEvent)({
            operation: "approval_confirmed",
            status: "ok",
            details: {
                stage: "5",
                approved_request_id: requestToApproveId,
                rejected_request_id: requestToRejectId
            }
        });
    }
    finally {
        await (0, db_1.disconnectDatabase)();
    }
}
run().catch((error) => {
    const err = error instanceof Error ? error : new Error("Unknown stage5 verification error");
    (0, logger_1.logEvent)({
        level: "error",
        operation: "db_error",
        status: "error",
        error_code: "STAGE5_VERIFY_FAILED",
        error_message: err.message
    });
    process.exit(1);
});
