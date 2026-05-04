"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDueBackgroundJobs = processDueBackgroundJobs;
exports.startBackgroundWorker = startBackgroundWorker;
exports.stopBackgroundWorker = stopBackgroundWorker;
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const env_1 = require("../env");
const email_1 = require("../integrations/email");
const logger_1 = require("../logger");
const RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 10;
let timer = null;
let processing = false;
function formatDateRangeMoscow(startAt, endAt) {
    const date = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "2-digit"
    }).format(startAt);
    const start = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    }).format(startAt);
    const end = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    }).format(endAt);
    return `${date} ${start} - ${end} (МСК)`;
}
function formatRequestCode(createdAt) {
    const parts = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(createdAt);
    const hh = parts.find((part) => part.type === "hour")?.value ?? "00";
    const mm = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `#${hh}${mm}`;
}
function buildDependencies(input) {
    const telegramConfig = (0, env_1.getTelegramConfig)();
    const approvalConfig = (0, env_1.getApprovalConfig)();
    return {
        emailProvider: input?.emailProvider ?? (0, email_1.createEmailProvider)(),
        adminNotifier: input?.adminNotifier ?? createTelegramAdminNotifier(telegramConfig.botToken),
        adminTelegramId: input?.adminTelegramId ?? approvalConfig.adminTelegramId
    };
}
function createTelegramAdminNotifier(botToken) {
    if (!botToken) {
        return null;
    }
    return {
        async sendMessage(input) {
            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    chat_id: input.chatId,
                    text: input.text
                })
            });
            if (!response.ok) {
                const body = (await response.text()).slice(0, 1000);
                throw new Error(`Telegram notifier error: HTTP ${response.status}. ${body}`);
            }
            const json = (await response.json());
            if (!json.ok) {
                throw new Error(`Telegram notifier error: ${json.description ?? "unknown error"}`);
            }
        }
    };
}
function parseMeetingRequestId(job) {
    const payload = job.payload;
    const meetingRequestId = payload.meetingRequestId;
    if (typeof meetingRequestId !== "string" || meetingRequestId.length === 0) {
        throw new Error(`Job payload is missing meetingRequestId for job ${job.id}`);
    }
    return meetingRequestId;
}
async function completeJob(jobId) {
    await db_1.prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
            status: client_1.BackgroundJobStatus.COMPLETED,
            lockedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null
        }
    });
}
async function retryOrFailJob(job, error) {
    const message = error instanceof Error ? error.message : "Unknown background job error";
    const reachedMaxAttempts = job.attempts >= job.maxAttempts;
    if (reachedMaxAttempts) {
        await db_1.prisma.backgroundJob.update({
            where: { id: job.id },
            data: {
                status: client_1.BackgroundJobStatus.FAILED,
                lockedAt: null,
                lastErrorCode: "BACKGROUND_JOB_FAILED",
                lastErrorMessage: message
            }
        });
        return;
    }
    await db_1.prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
            status: client_1.BackgroundJobStatus.PENDING,
            lockedAt: null,
            runAt: new Date(Date.now() + RETRY_DELAY_MS),
            lastErrorCode: "BACKGROUND_JOB_RETRY_SCHEDULED",
            lastErrorMessage: message
        }
    });
    (0, logger_1.logEvent)({
        operation: "retry_scheduled",
        status: "ok",
        entity_id: job.meetingRequestId,
        details: {
            job_id: job.id,
            job_type: job.jobType,
            next_attempt_in_ms: RETRY_DELAY_MS,
            attempts: job.attempts,
            max_attempts: job.maxAttempts
        }
    });
}
async function claimNextPendingJob(now) {
    const nextJob = await db_1.prisma.backgroundJob.findFirst({
        where: {
            status: client_1.BackgroundJobStatus.PENDING,
            runAt: {
                lte: now
            }
        },
        orderBy: [{ runAt: "asc" }, { createdAt: "asc" }]
    });
    if (!nextJob) {
        return null;
    }
    const claim = await db_1.prisma.backgroundJob.updateMany({
        where: {
            id: nextJob.id,
            status: client_1.BackgroundJobStatus.PENDING
        },
        data: {
            status: client_1.BackgroundJobStatus.PROCESSING,
            lockedAt: now,
            attempts: {
                increment: 1
            }
        }
    });
    if (claim.count === 0) {
        return null;
    }
    const claimedJob = await db_1.prisma.backgroundJob.findUnique({ where: { id: nextJob.id } });
    return claimedJob;
}
async function appendEmailActionLog(input) {
    await db_1.prisma.actionLog.create({
        data: {
            meetingRequestId: input.meetingRequestId,
            userId: input.userId,
            actorRole: client_1.JournalActorRole.SYSTEM,
            actorId: "email_service",
            actionType: input.actionType,
            details: input.details,
            result: input.result
        }
    });
}
async function sendEmailThroughProvider(input) {
    if (!input.deps.emailProvider) {
        const errorMessage = "SendGrid provider is not configured";
        await appendEmailActionLog({
            meetingRequestId: input.meetingRequestId,
            userId: input.userId,
            actionType: client_1.JournalActionType.EMAIL_FAILED,
            details: {
                template: input.template,
                reason: errorMessage
            },
            result: "error"
        });
        (0, logger_1.logEvent)({
            level: "error",
            operation: "email_failed",
            status: "error",
            user_id: input.userId,
            entity_id: input.meetingRequestId,
            error_code: "SENDGRID_NOT_CONFIGURED",
            error_message: errorMessage,
            details: {
                template: input.template
            }
        });
        throw new Error(errorMessage);
    }
    let sendResult;
    try {
        sendResult = await input.deps.emailProvider.send(input.email);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown SendGrid error";
        await appendEmailActionLog({
            meetingRequestId: input.meetingRequestId,
            userId: input.userId,
            actionType: client_1.JournalActionType.EMAIL_FAILED,
            details: {
                template: input.template,
                reason: errorMessage
            },
            result: "error"
        });
        (0, logger_1.logEvent)({
            level: "error",
            operation: "email_failed",
            status: "error",
            user_id: input.userId,
            entity_id: input.meetingRequestId,
            error_code: "SENDGRID_SEND_FAILED",
            error_message: errorMessage,
            details: {
                template: input.template
            }
        });
        throw error;
    }
    await appendEmailActionLog({
        meetingRequestId: input.meetingRequestId,
        userId: input.userId,
        actionType: client_1.JournalActionType.EMAIL_SENT,
        details: {
            template: input.template,
            provider_message_id: sendResult.providerMessageId
        },
        result: "ok"
    });
    (0, logger_1.logEvent)({
        operation: "email_sent",
        status: "ok",
        user_id: input.userId,
        entity_id: input.meetingRequestId,
        details: {
            template: input.template,
            provider_message_id: sendResult.providerMessageId
        }
    });
}
async function processEmailConfirmationJob(job, deps) {
    const meetingRequestId = parseMeetingRequestId(job);
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { user: true }
    });
    if (!request) {
        throw new Error(`Meeting request not found for email confirmation job: ${meetingRequestId}`);
    }
    if (request.status !== client_1.MeetingRequestStatus.APPROVED && request.status !== client_1.MeetingRequestStatus.REJECTED) {
        return;
    }
    const isApproved = request.status === client_1.MeetingRequestStatus.APPROVED;
    const subject = isApproved ? "Ваша встреча подтверждена" : "Ваша заявка отклонена";
    const lines = [isApproved ? "Встреча подтверждена." : "Заявка отклонена.", ""];
    lines.push(`Номер заявки: ${formatRequestCode(request.createdAt)}`);
    lines.push(`Тема: ${request.topic}`);
    lines.push(`Формат: ${request.format === "ONLINE" ? "онлайн" : "оффлайн"}`);
    lines.push(`Длительность: ${request.durationMinutes} мин.`);
    lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);
    if (request.format === "OFFLINE") {
        lines.push(`Место: ${request.location ?? "-"}`);
    }
    if (!isApproved && request.approverComment) {
        lines.push(`Комментарий: ${request.approverComment}`);
    }
    await sendEmailThroughProvider({
        deps,
        meetingRequestId: request.id,
        userId: request.userId,
        template: "decision",
        email: {
            toEmail: request.email,
            toName: [request.firstName ?? "", request.lastName ?? ""].join(" ").trim() || null,
            subject,
            text: lines.join("\n")
        }
    });
}
async function processEmailReminderJob(job, deps) {
    const meetingRequestId = parseMeetingRequestId(job);
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId }
    });
    if (!request) {
        throw new Error(`Meeting request not found for email reminder job: ${meetingRequestId}`);
    }
    if (request.status !== client_1.MeetingRequestStatus.APPROVED) {
        return;
    }
    const lines = [
        "Напоминание о встрече.",
        "",
        `Номер заявки: ${formatRequestCode(request.createdAt)}`,
        `Тема: ${request.topic}`,
        `Формат: ${request.format === "ONLINE" ? "онлайн" : "оффлайн"}`,
        `Длительность: ${request.durationMinutes} мин.`,
        `Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`
    ];
    if (request.format === "OFFLINE") {
        lines.push(`Место: ${request.location ?? "-"}`);
    }
    await sendEmailThroughProvider({
        deps,
        meetingRequestId: request.id,
        userId: request.userId,
        template: "reminder",
        email: {
            toEmail: request.email,
            toName: [request.firstName ?? "", request.lastName ?? ""].join(" ").trim() || null,
            subject: "Напоминание: встреча через 2 часа",
            text: lines.join("\n")
        }
    });
    (0, logger_1.logEvent)({
        operation: "reminder_sent",
        status: "ok",
        user_id: request.userId,
        entity_id: request.id,
        details: {
            reminder_type: "email"
        }
    });
}
async function processApprovalReminderJob(job, deps) {
    const meetingRequestId = parseMeetingRequestId(job);
    if (!deps.adminTelegramId || !deps.adminNotifier) {
        throw new Error("Admin reminder notifier is not configured");
    }
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { user: true }
    });
    if (!request || request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL) {
        return;
    }
    const requesterName = [request.firstName ?? request.user.firstName ?? "", request.lastName ?? request.user.lastName ?? ""]
        .join(" ")
        .trim();
    const lines = ["⏰ Напоминание: есть необработанная заявка.", ""];
    lines.push(`Номер заявки: ${formatRequestCode(request.createdAt)}`);
    lines.push(`Тема: ${request.topic}`);
    lines.push(`Пользователь: ${requesterName || "-"}`);
    lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);
    await deps.adminNotifier.sendMessage({
        chatId: deps.adminTelegramId,
        text: lines.join("\n")
    });
    (0, logger_1.logEvent)({
        operation: "reminder_sent",
        status: "ok",
        entity_id: request.id,
        details: {
            reminder_type: "approval"
        }
    });
}
async function processTtlCleanupJob() {
    const now = new Date();
    const expiredDraftsResult = await db_1.prisma.meetingRequestDraft.updateMany({
        where: {
            status: client_1.DraftStatus.ACTIVE,
            expiresAt: {
                lt: now
            }
        },
        data: {
            status: client_1.DraftStatus.EXPIRED
        }
    });
    (0, logger_1.logEvent)({
        operation: "background_job_processed",
        status: "ok",
        details: {
            job_type: client_1.BackgroundJobType.TTL_CLEANUP,
            expired_drafts: expiredDraftsResult.count
        }
    });
}
async function processJob(job, deps) {
    switch (job.jobType) {
        case client_1.BackgroundJobType.EMAIL_CONFIRMATION:
            await processEmailConfirmationJob(job, deps);
            return;
        case client_1.BackgroundJobType.EMAIL_REMINDER:
            await processEmailReminderJob(job, deps);
            return;
        case client_1.BackgroundJobType.APPROVAL_REMINDER:
            await processApprovalReminderJob(job, deps);
            return;
        case client_1.BackgroundJobType.TTL_CLEANUP:
            await processTtlCleanupJob();
            return;
        case client_1.BackgroundJobType.RETRY_INTEGRATION:
            return;
        default:
            return;
    }
}
async function processDueBackgroundJobs(options) {
    const deps = buildDependencies(options?.deps);
    const limit = options?.limit ?? DEFAULT_LIMIT;
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
        const now = new Date();
        const job = await claimNextPendingJob(now);
        if (!job) {
            break;
        }
        try {
            await processJob(job, deps);
            await completeJob(job.id);
            (0, logger_1.logEvent)({
                operation: "background_job_processed",
                status: "ok",
                entity_id: job.meetingRequestId,
                details: {
                    job_id: job.id,
                    job_type: job.jobType
                }
            });
            processed += 1;
        }
        catch (error) {
            await retryOrFailJob(job, error);
            (0, logger_1.logEvent)({
                level: "error",
                operation: "background_job_processed",
                status: "error",
                entity_id: job.meetingRequestId,
                error_code: "BACKGROUND_JOB_PROCESSING_FAILED",
                error_message: error instanceof Error ? error.message : "Unknown background job error",
                details: {
                    job_id: job.id,
                    job_type: job.jobType,
                    attempts: job.attempts,
                    max_attempts: job.maxAttempts
                }
            });
            processed += 1;
        }
    }
    return processed;
}
function startBackgroundWorker() {
    const config = (0, env_1.getBackgroundJobsConfig)();
    if (!config.enabled || timer) {
        return;
    }
    timer = setInterval(async () => {
        if (processing) {
            return;
        }
        processing = true;
        try {
            await processDueBackgroundJobs({ limit: config.batchSize });
        }
        catch (error) {
            (0, logger_1.logEvent)({
                level: "error",
                operation: "background_job_processed",
                status: "error",
                error_code: "BACKGROUND_WORKER_TICK_FAILED",
                error_message: error instanceof Error ? error.message : "Unknown worker error"
            });
        }
        finally {
            processing = false;
        }
    }, config.pollIntervalMs);
    (0, logger_1.logEvent)({
        operation: "background_worker_started",
        status: "ok",
        details: {
            poll_interval_ms: config.pollIntervalMs,
            batch_size: config.batchSize
        }
    });
}
function stopBackgroundWorker() {
    if (!timer) {
        return;
    }
    clearInterval(timer);
    timer = null;
    processing = false;
    (0, logger_1.logEvent)({
        operation: "background_worker_stopped",
        status: "ok"
    });
}
