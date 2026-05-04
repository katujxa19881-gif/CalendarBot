"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleApprovalReminderJob = scheduleApprovalReminderJob;
exports.scheduleDecisionEmailJob = scheduleDecisionEmailJob;
exports.scheduleUpcomingReminderEmailJob = scheduleUpcomingReminderEmailJob;
exports.cancelPendingApprovalReminderJobs = cancelPendingApprovalReminderJobs;
exports.cancelPendingBackgroundJobsByTypes = cancelPendingBackgroundJobsByTypes;
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const logger_1 = require("../logger");
const DEFAULT_MAX_ATTEMPTS = 5;
const APPROVAL_REMINDER_DELAY_HOURS = 2;
const EMAIL_REMINDER_LEAD_HOURS = 2;
function plusHours(date, hours) {
    return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
async function createBackgroundJob(input) {
    await db_1.prisma.backgroundJob.create({
        data: {
            jobType: input.jobType,
            meetingRequestId: input.meetingRequestId ?? null,
            payload: input.payload,
            runAt: input.runAt,
            maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
        }
    });
}
async function scheduleApprovalReminderJob(request) {
    if (request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL || !request.submittedAt) {
        return;
    }
    const runAt = plusHours(request.submittedAt, APPROVAL_REMINDER_DELAY_HOURS);
    await createBackgroundJob({
        jobType: client_1.BackgroundJobType.APPROVAL_REMINDER,
        meetingRequestId: request.id,
        payload: { meetingRequestId: request.id },
        runAt
    });
}
async function scheduleDecisionEmailJob(requestId) {
    await createBackgroundJob({
        jobType: client_1.BackgroundJobType.EMAIL_CONFIRMATION,
        meetingRequestId: requestId,
        payload: { meetingRequestId: requestId },
        runAt: new Date()
    });
    (0, logger_1.logEvent)({
        operation: "email_job_scheduled",
        status: "ok",
        entity_id: requestId,
        details: {
            job_type: client_1.BackgroundJobType.EMAIL_CONFIRMATION
        }
    });
}
async function scheduleUpcomingReminderEmailJob(request) {
    if (request.status !== client_1.MeetingRequestStatus.APPROVED && request.status !== client_1.MeetingRequestStatus.RESCHEDULED) {
        return;
    }
    const runAt = plusHours(request.startAt, -EMAIL_REMINDER_LEAD_HOURS);
    const now = new Date();
    if (runAt <= now) {
        return;
    }
    await createBackgroundJob({
        jobType: client_1.BackgroundJobType.EMAIL_REMINDER,
        meetingRequestId: request.id,
        payload: { meetingRequestId: request.id },
        runAt
    });
    (0, logger_1.logEvent)({
        operation: "email_job_scheduled",
        status: "ok",
        entity_id: request.id,
        details: {
            job_type: client_1.BackgroundJobType.EMAIL_REMINDER,
            run_at: runAt.toISOString()
        }
    });
}
async function cancelPendingApprovalReminderJobs(meetingRequestId) {
    return cancelPendingBackgroundJobsByTypes(meetingRequestId, [client_1.BackgroundJobType.APPROVAL_REMINDER]);
}
async function cancelPendingBackgroundJobsByTypes(meetingRequestId, jobTypes) {
    if (jobTypes.length === 0) {
        return 0;
    }
    const result = await db_1.prisma.backgroundJob.updateMany({
        where: {
            meetingRequestId,
            jobType: {
                in: jobTypes
            },
            status: client_1.BackgroundJobStatus.PENDING
        },
        data: {
            status: client_1.BackgroundJobStatus.CANCELLED,
            lastErrorCode: null,
            lastErrorMessage: null,
            lockedAt: null
        }
    });
    return result.count;
}
