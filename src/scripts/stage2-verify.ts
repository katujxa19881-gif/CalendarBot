import {
  BackgroundJobStatus,
  BackgroundJobType,
  JournalActorRole,
  JournalActionType,
  MeetingFormat,
  MeetingRequestStatus
} from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { resolveDatabaseUrl } from "../env";
import {
  MeetingRequestStatusTransitionError,
  transitionMeetingRequestStatus
} from "../domain/meeting-request-status";
import { logEvent } from "../logger";

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function run(): Promise<void> {
  const marker = Date.now().toString();
  const telegramId = `stage2_${marker}`;

  resolveDatabaseUrl();

  logEvent({
    operation: "migration_started",
    status: "ok",
    details: { stage: "2", marker }
  });

  try {
    await connectDatabase();

    const user = await prisma.user.create({
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
    logEvent({
      operation: "entity_created",
      status: "ok",
      entity_id: user.id,
      user_id: user.id,
      details: { entity: "user" }
    });

    const draft = await prisma.meetingRequestDraft.create({
      data: {
        userId: user.id,
        currentStep: "select_slot",
        payload: {
          durationMinutes: 30,
          format: MeetingFormat.ONLINE
        },
        expiresAt: addHours(new Date(), 24)
      }
    });
    logEvent({
      operation: "entity_created",
      status: "ok",
      entity_id: draft.id,
      user_id: user.id,
      details: { entity: "meeting_request_draft" }
    });

    const request = await prisma.meetingRequest.create({
      data: {
        userId: user.id,
        durationMinutes: 30,
        format: MeetingFormat.ONLINE,
        startAt: addHours(new Date(), 48),
        endAt: addHours(new Date(), 48.5),
        topic: "Stage 2 validation meeting",
        description: "Smoke check for entity model",
        email: `stage2.${marker}@example.com`,
        firstName: "Stage",
        lastName: "Two",
        status: MeetingRequestStatus.NEW,
        expiresAt: addHours(new Date(), 24)
      }
    });
    logEvent({
      operation: "entity_created",
      status: "ok",
      entity_id: request.id,
      user_id: user.id,
      details: { entity: "meeting_request" }
    });

    const calendarEvent = await prisma.calendarEvent.create({
      data: {
        meetingRequestId: request.id,
        googleCalendarEventId: `gcal_${marker}`,
        googleCalendarId: "primary",
        syncStatus: "PENDING"
      }
    });
    logEvent({
      operation: "entity_created",
      status: "ok",
      entity_id: calendarEvent.id,
      user_id: user.id,
      details: { entity: "calendar_event" }
    });

    const backgroundJob = await prisma.backgroundJob.create({
      data: {
        meetingRequestId: request.id,
        jobType: BackgroundJobType.EMAIL_CONFIRMATION,
        status: BackgroundJobStatus.PENDING,
        payload: {
          template: "meeting_confirmed"
        },
        runAt: addHours(new Date(), 1)
      }
    });
    logEvent({
      operation: "entity_created",
      status: "ok",
      entity_id: backgroundJob.id,
      user_id: user.id,
      details: { entity: "background_job" }
    });

    await prisma.actionLog.create({
      data: {
        meetingRequestId: request.id,
        userId: user.id,
        actorRole: JournalActorRole.SYSTEM,
        actorId: "stage2-script",
        actionType: JournalActionType.MEETING_REQUEST_SUBMITTED,
        details: {
          source: "stage2-verify"
        },
        result: "ok"
      }
    });

    const updated = await prisma.meetingRequest.update({
      where: { id: request.id },
      data: { topic: "Stage 2 validation meeting (updated)" }
    });
    logEvent({
      operation: "entity_updated",
      status: "ok",
      entity_id: updated.id,
      user_id: user.id,
      details: { entity: "meeting_request", field: "topic" }
    });

    await transitionMeetingRequestStatus({
      meetingRequestId: request.id,
      toStatus: MeetingRequestStatus.PENDING_APPROVAL,
      actorId: "owner_1",
      actorRole: JournalActorRole.OWNER
    });

    await transitionMeetingRequestStatus({
      meetingRequestId: request.id,
      toStatus: MeetingRequestStatus.APPROVED,
      actorId: "owner_1",
      actorRole: JournalActorRole.OWNER
    });

    try {
      await transitionMeetingRequestStatus({
        meetingRequestId: request.id,
        toStatus: MeetingRequestStatus.NEW,
        actorId: "owner_1",
        actorRole: JournalActorRole.OWNER
      });
    } catch (error) {
      if (error instanceof MeetingRequestStatusTransitionError) {
        logEvent({
          level: "error",
          operation: "db_error",
          status: "error",
          entity_id: request.id,
          error_code: error.code,
          error_message: error.message
        });
      } else {
        throw error;
      }
    }

    const finalState = await prisma.meetingRequest.findUnique({
      where: { id: request.id },
      select: { status: true }
    });

    if (!finalState || finalState.status !== MeetingRequestStatus.APPROVED) {
      throw new Error("Status verification failed for meeting request");
    }

    logEvent({
      operation: "migration_finished",
      status: "ok",
      details: {
        stage: "2",
        meetingRequestId: request.id,
        finalStatus: finalState.status
      }
    });
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error) => {
  const err = error instanceof Error ? error : new Error("Unknown stage2 verify error");

  logEvent({
    level: "error",
    operation: "db_error",
    status: "error",
    error_code: "STAGE2_VERIFY_FAILED",
    error_message: err.message
  });

  process.exit(1);
});
