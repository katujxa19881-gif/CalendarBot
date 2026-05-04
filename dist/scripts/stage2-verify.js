"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const env_1 = require("../env");
const meeting_request_status_1 = require("../domain/meeting-request-status");
const logger_1 = require("../logger");
function addHours(date, hours) {
    return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
async function run() {
    const marker = Date.now().toString();
    const telegramId = `stage2_${marker}`;
    (0, env_1.resolveDatabaseUrl)();
    (0, logger_1.logEvent)({
        operation: "migration_started",
        status: "ok",
        details: { stage: "2", marker }
    });
    try {
        await (0, db_1.connectDatabase)();
        const user = await db_1.prisma.user.create({
            data: {
                telegramId,
                username: `user_${marker}`,
                firstName: "Stage",
                lastName: "Two",
                lastUsedEmail: `stage2.${marker}@example.com`,
                personalDataConsentGiven: true,
                personalDataConsentAt: new Date()
            }
        });
        (0, logger_1.logEvent)({
            operation: "entity_created",
            status: "ok",
            entity_id: user.id,
            user_id: user.id,
            details: { entity: "user" }
        });
        const draft = await db_1.prisma.meetingRequestDraft.create({
            data: {
                userId: user.id,
                currentStep: "select_slot",
                payload: {
                    durationMinutes: 30,
                    format: client_1.MeetingFormat.ONLINE
                },
                expiresAt: addHours(new Date(), 24)
            }
        });
        (0, logger_1.logEvent)({
            operation: "entity_created",
            status: "ok",
            entity_id: draft.id,
            user_id: user.id,
            details: { entity: "meeting_request_draft" }
        });
        const request = await db_1.prisma.meetingRequest.create({
            data: {
                userId: user.id,
                durationMinutes: 30,
                format: client_1.MeetingFormat.ONLINE,
                startAt: addHours(new Date(), 48),
                endAt: addHours(new Date(), 48.5),
                topic: "Stage 2 validation meeting",
                description: "Smoke check for entity model",
                email: `stage2.${marker}@example.com`,
                firstName: "Stage",
                lastName: "Two",
                status: client_1.MeetingRequestStatus.NEW,
                expiresAt: addHours(new Date(), 24)
            }
        });
        (0, logger_1.logEvent)({
            operation: "entity_created",
            status: "ok",
            entity_id: request.id,
            user_id: user.id,
            details: { entity: "meeting_request" }
        });
        const calendarEvent = await db_1.prisma.calendarEvent.create({
            data: {
                meetingRequestId: request.id,
                googleCalendarEventId: `gcal_${marker}`,
                googleCalendarId: "primary",
                syncStatus: "PENDING"
            }
        });
        (0, logger_1.logEvent)({
            operation: "entity_created",
            status: "ok",
            entity_id: calendarEvent.id,
            user_id: user.id,
            details: { entity: "calendar_event" }
        });
        const backgroundJob = await db_1.prisma.backgroundJob.create({
            data: {
                meetingRequestId: request.id,
                jobType: client_1.BackgroundJobType.EMAIL_CONFIRMATION,
                status: client_1.BackgroundJobStatus.PENDING,
                payload: {
                    template: "meeting_confirmed"
                },
                runAt: addHours(new Date(), 1)
            }
        });
        (0, logger_1.logEvent)({
            operation: "entity_created",
            status: "ok",
            entity_id: backgroundJob.id,
            user_id: user.id,
            details: { entity: "background_job" }
        });
        await db_1.prisma.actionLog.create({
            data: {
                meetingRequestId: request.id,
                userId: user.id,
                actorRole: client_1.JournalActorRole.SYSTEM,
                actorId: "stage2-script",
                actionType: client_1.JournalActionType.MEETING_REQUEST_SUBMITTED,
                details: {
                    source: "stage2-verify"
                },
                result: "ok"
            }
        });
        const updated = await db_1.prisma.meetingRequest.update({
            where: { id: request.id },
            data: { topic: "Stage 2 validation meeting (updated)" }
        });
        (0, logger_1.logEvent)({
            operation: "entity_updated",
            status: "ok",
            entity_id: updated.id,
            user_id: user.id,
            details: { entity: "meeting_request", field: "topic" }
        });
        await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
            meetingRequestId: request.id,
            toStatus: client_1.MeetingRequestStatus.PENDING_APPROVAL,
            actorId: "owner_1",
            actorRole: client_1.JournalActorRole.OWNER
        });
        await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
            meetingRequestId: request.id,
            toStatus: client_1.MeetingRequestStatus.APPROVED,
            actorId: "owner_1",
            actorRole: client_1.JournalActorRole.OWNER
        });
        try {
            await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
                meetingRequestId: request.id,
                toStatus: client_1.MeetingRequestStatus.NEW,
                actorId: "owner_1",
                actorRole: client_1.JournalActorRole.OWNER
            });
        }
        catch (error) {
            if (error instanceof meeting_request_status_1.MeetingRequestStatusTransitionError) {
                (0, logger_1.logEvent)({
                    level: "error",
                    operation: "db_error",
                    status: "error",
                    entity_id: request.id,
                    error_code: error.code,
                    error_message: error.message
                });
            }
            else {
                throw error;
            }
        }
        const finalState = await db_1.prisma.meetingRequest.findUnique({
            where: { id: request.id },
            select: { status: true }
        });
        if (!finalState || finalState.status !== client_1.MeetingRequestStatus.APPROVED) {
            throw new Error("Status verification failed for meeting request");
        }
        (0, logger_1.logEvent)({
            operation: "migration_finished",
            status: "ok",
            details: {
                stage: "2",
                meetingRequestId: request.id,
                finalStatus: finalState.status
            }
        });
    }
    finally {
        await (0, db_1.disconnectDatabase)();
    }
}
run().catch((error) => {
    const err = error instanceof Error ? error : new Error("Unknown stage2 verify error");
    (0, logger_1.logEvent)({
        level: "error",
        operation: "db_error",
        status: "error",
        error_code: "STAGE2_VERIFY_FAILED",
        error_message: err.message
    });
    process.exit(1);
});
