"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const env_1 = require("../env");
const jobs_1 = require("../background/jobs");
const worker_1 = require("../background/worker");
const logger_1 = require("../logger");
const MARKER = "stage6_verify";
async function cleanupTestData() {
    const users = await db_1.prisma.user.findMany({
        where: {
            telegramId: {
                startsWith: MARKER
            }
        },
        select: {
            id: true
        }
    });
    const userIds = users.map((user) => user.id);
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
        await db_1.prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
        await db_1.prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    }
    await db_1.prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
    await db_1.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
function plusMinutes(minutes) {
    return new Date(Date.now() + minutes * 60 * 1000);
}
async function run() {
    (0, env_1.resolveDatabaseUrl)();
    (0, logger_1.logEvent)({
        operation: "background_job_processed",
        status: "ok",
        details: {
            stage: "6",
            mode: "verify_script_start"
        }
    });
    await (0, db_1.connectDatabase)();
    try {
        await cleanupTestData();
        const user = await db_1.prisma.user.create({
            data: {
                telegramId: `${MARKER}_user_1`,
                username: `${MARKER}_username`,
                firstName: "Stage",
                lastName: "Six",
                personalDataConsentGiven: true,
                personalDataConsentAt: new Date()
            }
        });
        const approvedRequest = await db_1.prisma.meetingRequest.create({
            data: {
                userId: user.id,
                durationMinutes: 30,
                format: client_1.MeetingFormat.ONLINE,
                startAt: plusMinutes(200),
                endAt: plusMinutes(230),
                topic: "Этап 6 подтвержденная",
                description: "Проверка email задач",
                email: "stage6-approved@example.com",
                firstName: "Stage",
                lastName: "Six",
                status: client_1.MeetingRequestStatus.APPROVED,
                submittedAt: plusMinutes(-30),
                resolvedAt: plusMinutes(-10)
            }
        });
        await db_1.prisma.calendarEvent.create({
            data: {
                meetingRequestId: approvedRequest.id,
                googleCalendarEventId: `stage6_event_${approvedRequest.id}`,
                googleCalendarId: "primary",
                syncStatus: client_1.CalendarEventSyncStatus.SYNCED,
                syncedAt: new Date()
            }
        });
        const pendingRequest = await db_1.prisma.meetingRequest.create({
            data: {
                userId: user.id,
                durationMinutes: 45,
                format: client_1.MeetingFormat.OFFLINE,
                startAt: plusMinutes(500),
                endAt: plusMinutes(545),
                topic: "Этап 6 без решения",
                description: "Проверка reminder администратору",
                location: "Офис",
                email: "stage6-pending@example.com",
                firstName: "Stage",
                lastName: "Six",
                status: client_1.MeetingRequestStatus.PENDING_APPROVAL,
                submittedAt: plusMinutes(-180),
                expiresAt: plusMinutes(1200)
            }
        });
        await (0, jobs_1.scheduleDecisionEmailJob)(approvedRequest.id);
        await (0, jobs_1.scheduleUpcomingReminderEmailJob)(approvedRequest);
        await (0, jobs_1.scheduleApprovalReminderJob)(pendingRequest);
        await db_1.prisma.backgroundJob.updateMany({
            where: {
                meetingRequestId: approvedRequest.id,
                jobType: client_1.BackgroundJobType.EMAIL_REMINDER
            },
            data: {
                runAt: plusMinutes(-1)
            }
        });
        const sentEmails = [];
        const sentAdminReminders = [];
        const processedCount = await (0, worker_1.processDueBackgroundJobs)({
            limit: 20,
            deps: {
                emailProvider: {
                    async send(email) {
                        sentEmails.push({ to: email.toEmail, subject: email.subject });
                        return { providerMessageId: `msg_${sentEmails.length}` };
                    }
                },
                adminNotifier: {
                    async sendMessage(input) {
                        sentAdminReminders.push(`${input.chatId}:${input.text}`);
                    }
                },
                adminTelegramId: "900099"
            }
        });
        if (processedCount < 3) {
            throw new Error(`Expected at least 3 processed jobs, got ${processedCount}`);
        }
        if (sentEmails.length < 2) {
            throw new Error(`Expected at least 2 sent emails, got ${sentEmails.length}`);
        }
        if (sentAdminReminders.length < 1) {
            throw new Error("Expected at least 1 admin reminder sent");
        }
        const remainingPendingJobs = await db_1.prisma.backgroundJob.count({
            where: {
                status: {
                    in: [client_1.BackgroundJobStatus.PENDING, client_1.BackgroundJobStatus.PROCESSING]
                },
                meetingRequestId: {
                    in: [approvedRequest.id, pendingRequest.id]
                }
            }
        });
        if (remainingPendingJobs !== 0) {
            throw new Error(`Expected 0 pending/processing jobs, got ${remainingPendingJobs}`);
        }
        const emailSentLogs = await db_1.prisma.actionLog.count({
            where: {
                meetingRequestId: approvedRequest.id,
                actionType: client_1.JournalActionType.EMAIL_SENT
            }
        });
        if (emailSentLogs < 2) {
            throw new Error(`Expected at least 2 EMAIL_SENT action logs, got ${emailSentLogs}`);
        }
        (0, logger_1.logEvent)({
            operation: "background_job_processed",
            status: "ok",
            details: {
                stage: "6",
                mode: "verify_script_completed",
                processed_jobs: processedCount,
                sent_emails: sentEmails.length,
                sent_admin_reminders: sentAdminReminders.length
            }
        });
    }
    finally {
        await (0, db_1.disconnectDatabase)();
    }
}
void run().catch(async (error) => {
    const message = error instanceof Error ? error.message : "Unknown stage6 verify error";
    (0, logger_1.logEvent)({
        level: "error",
        operation: "background_job_processed",
        status: "error",
        error_code: "STAGE6_VERIFY_FAILED",
        error_message: message,
        details: {
            stage: "6"
        }
    });
    await (0, db_1.disconnectDatabase)();
    process.exit(1);
});
