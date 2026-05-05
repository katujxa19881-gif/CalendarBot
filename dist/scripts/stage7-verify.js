"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const bot_1 = require("../telegram/bot");
const env_1 = require("../env");
const MARKER = "stage7_verify";
function plusHours(hours) {
    return new Date(Date.now() + hours * 60 * 60 * 1000);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function cleanupTestData() {
    const users = await db_1.prisma.user.findMany({
        where: {
            OR: [
                {
                    username: {
                        startsWith: MARKER
                    }
                },
                {
                    telegramId: "7001001"
                },
                {
                    telegramId: {
                        startsWith: MARKER
                    }
                }
            ]
        },
        select: { id: true }
    });
    const userIds = users.map((item) => item.id);
    if (userIds.length === 0) {
        return;
    }
    const requests = await db_1.prisma.meetingRequest.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
    });
    const requestIds = requests.map((item) => item.id);
    if (requestIds.length > 0) {
        await db_1.prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    }
    await db_1.prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
function buildCallbackUpdate(input) {
    return {
        update_id: input.updateId,
        callback_query: {
            id: input.callbackId,
            from: {
                id: input.telegramId,
                is_bot: false,
                first_name: "Stage7",
                username: "stage7_user"
            },
            message: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: {
                    id: input.telegramId,
                    type: "private"
                }
            },
            chat_instance: "stage7_chat_instance",
            data: input.data
        }
    };
}
async function run() {
    (0, env_1.resolveDatabaseUrl)();
    process.env.DISABLE_ANTI_SPAM = "true";
    await (0, db_1.connectDatabase)();
    try {
        await cleanupTestData();
        const user = await db_1.prisma.user.create({
            data: {
                telegramId: "7001001",
                username: `${MARKER}_user`,
                firstName: "Stage",
                lastName: "Seven",
                personalDataConsentGiven: true,
                personalDataConsentAt: new Date()
            }
        });
        const reschedulableRequest = await db_1.prisma.meetingRequest.create({
            data: {
                userId: user.id,
                durationMinutes: 30,
                format: client_1.MeetingFormat.ONLINE,
                startAt: plusHours(48),
                endAt: plusHours(48.5),
                topic: "Stage7 reschedule",
                description: "verify reschedule",
                email: "stage7-reschedule@example.com",
                firstName: "Stage",
                lastName: "Seven",
                status: client_1.MeetingRequestStatus.APPROVED,
                submittedAt: plusHours(-5),
                resolvedAt: plusHours(-4)
            }
        });
        await db_1.prisma.calendarEvent.create({
            data: {
                meetingRequestId: reschedulableRequest.id,
                googleCalendarEventId: `stage7_event_${reschedulableRequest.id}`,
                googleCalendarId: "primary",
                syncStatus: client_1.CalendarEventSyncStatus.SYNCED,
                syncedAt: new Date()
            }
        });
        const cancellableRequest = await db_1.prisma.meetingRequest.create({
            data: {
                userId: user.id,
                durationMinutes: 15,
                format: client_1.MeetingFormat.ONLINE,
                startAt: plusHours(72),
                endAt: plusHours(72.25),
                topic: "Stage7 cancel",
                description: "verify cancel",
                email: "stage7-cancel@example.com",
                firstName: "Stage",
                lastName: "Seven",
                status: client_1.MeetingRequestStatus.APPROVED,
                submittedAt: plusHours(-6),
                resolvedAt: plusHours(-5)
            }
        });
        await db_1.prisma.calendarEvent.create({
            data: {
                meetingRequestId: cancellableRequest.id,
                googleCalendarEventId: `stage7_event_${cancellableRequest.id}`,
                googleCalendarId: "primary",
                syncStatus: client_1.CalendarEventSyncStatus.SYNCED,
                syncedAt: new Date()
            }
        });
        const updateCalls = [];
        const cancelCalls = [];
        const runtime = (0, bot_1.createTelegramBotRuntime)({
            botToken: "1:test-token",
            dryRun: true,
            adminTelegramId: "999999",
            calendarEventSyncProvider: {
                async createEvent() {
                    return {
                        googleCalendarEventId: "unused",
                        googleCalendarId: "primary",
                        googleMeetLink: null
                    };
                },
                async updateEvent(input) {
                    updateCalls.push({
                        requestId: input.externalRequestId,
                        eventId: input.googleCalendarEventId,
                        startAt: input.startAt.toISOString(),
                        endAt: input.endAt.toISOString()
                    });
                    return {
                        googleCalendarEventId: input.googleCalendarEventId,
                        googleCalendarId: "primary",
                        googleMeetLink: null
                    };
                },
                async cancelEvent(input) {
                    cancelCalls.push({
                        requestId: input.externalRequestId,
                        eventId: input.googleCalendarEventId
                    });
                }
            }
        });
        let updateId = 1000;
        await runtime.bot.handleUpdate(buildCallbackUpdate({
            updateId: updateId++,
            callbackId: "cb-resched-request",
            telegramId: 7001001,
            data: `request:reschedule:${reschedulableRequest.id}`
        }));
        await sleep(2600);
        await runtime.bot.handleUpdate(buildCallbackUpdate({
            updateId: updateId++,
            callbackId: "cb-resched-slot",
            telegramId: 7001001,
            data: `reslot:${reschedulableRequest.id}:0`
        }));
        await sleep(2600);
        await runtime.bot.handleUpdate(buildCallbackUpdate({
            updateId: updateId++,
            callbackId: "cb-cancel-request",
            telegramId: 7001001,
            data: `request:cancel:${cancellableRequest.id}`
        }));
        await runtime.bot.handleUpdate(buildCallbackUpdate({
            updateId: updateId++,
            callbackId: "cb-cancel-duplicate",
            telegramId: 7001001,
            data: `request:cancel:${cancellableRequest.id}`
        }));
        if (updateCalls.length < 1) {
            throw new Error("Expected at least one calendar update call for reschedule");
        }
        if (cancelCalls.length < 1) {
            throw new Error("Expected at least one calendar cancel call");
        }
        const rescheduled = await db_1.prisma.meetingRequest.findUnique({
            where: { id: reschedulableRequest.id },
            include: { calendarEvent: true }
        });
        if (!rescheduled) {
            throw new Error("Rescheduled request not found");
        }
        if (rescheduled.status !== client_1.MeetingRequestStatus.RESCHEDULED) {
            throw new Error(`Expected RESCHEDULED status, got ${rescheduled.status}`);
        }
        if (!rescheduled.calendarEvent || rescheduled.calendarEvent.syncStatus !== client_1.CalendarEventSyncStatus.UPDATED) {
            throw new Error("Expected UPDATED calendar event status after reschedule");
        }
        const cancelled = await db_1.prisma.meetingRequest.findUnique({
            where: { id: cancellableRequest.id },
            include: { calendarEvent: true }
        });
        if (!cancelled) {
            throw new Error("Cancelled request not found");
        }
        if (cancelled.status !== client_1.MeetingRequestStatus.CANCELLED) {
            throw new Error(`Expected CANCELLED status, got ${cancelled.status}`);
        }
        if (!cancelled.calendarEvent || cancelled.calendarEvent.syncStatus !== client_1.CalendarEventSyncStatus.CANCELLED) {
            throw new Error("Expected CANCELLED calendar event status after cancellation");
        }
    }
    finally {
        await (0, db_1.disconnectDatabase)();
    }
}
void run().catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await (0, db_1.disconnectDatabase)();
    process.exit(1);
});
