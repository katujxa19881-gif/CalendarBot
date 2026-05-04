import {
  BackgroundJobStatus,
  BackgroundJobType,
  MeetingRequest,
  MeetingRequestStatus
} from "@prisma/client";
import { prisma } from "../db";
import { logEvent } from "../logger";

const DEFAULT_MAX_ATTEMPTS = 5;
const APPROVAL_REMINDER_DELAY_HOURS = 2;
const EMAIL_REMINDER_LEAD_HOURS = 2;

export type EmailConfirmationPayload = {
  meetingRequestId: string;
};

export type EmailReminderPayload = {
  meetingRequestId: string;
};

export type ApprovalReminderPayload = {
  meetingRequestId: string;
};

function plusHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function createBackgroundJob(input: {
  jobType: BackgroundJobType;
  meetingRequestId?: string;
  payload: unknown;
  runAt: Date;
  maxAttempts?: number;
}): Promise<void> {
  await prisma.backgroundJob.create({
    data: {
      jobType: input.jobType,
      meetingRequestId: input.meetingRequestId ?? null,
      payload: input.payload as never,
      runAt: input.runAt,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    }
  });
}

export async function scheduleApprovalReminderJob(request: MeetingRequest): Promise<void> {
  if (request.status !== MeetingRequestStatus.PENDING_APPROVAL || !request.submittedAt) {
    return;
  }

  const runAt = plusHours(request.submittedAt, APPROVAL_REMINDER_DELAY_HOURS);

  await createBackgroundJob({
    jobType: BackgroundJobType.APPROVAL_REMINDER,
    meetingRequestId: request.id,
    payload: { meetingRequestId: request.id } satisfies ApprovalReminderPayload,
    runAt
  });
}

export async function scheduleDecisionEmailJob(requestId: string): Promise<void> {
  await createBackgroundJob({
    jobType: BackgroundJobType.EMAIL_CONFIRMATION,
    meetingRequestId: requestId,
    payload: { meetingRequestId: requestId } satisfies EmailConfirmationPayload,
    runAt: new Date()
  });

  logEvent({
    operation: "email_job_scheduled",
    status: "ok",
    entity_id: requestId,
    details: {
      job_type: BackgroundJobType.EMAIL_CONFIRMATION
    }
  });
}

export async function scheduleUpcomingReminderEmailJob(request: MeetingRequest): Promise<void> {
  if (request.status !== MeetingRequestStatus.APPROVED && request.status !== MeetingRequestStatus.RESCHEDULED) {
    return;
  }

  const runAt = plusHours(request.startAt, -EMAIL_REMINDER_LEAD_HOURS);
  const now = new Date();

  if (runAt <= now) {
    return;
  }

  await createBackgroundJob({
    jobType: BackgroundJobType.EMAIL_REMINDER,
    meetingRequestId: request.id,
    payload: { meetingRequestId: request.id } satisfies EmailReminderPayload,
    runAt
  });

  logEvent({
    operation: "email_job_scheduled",
    status: "ok",
    entity_id: request.id,
    details: {
      job_type: BackgroundJobType.EMAIL_REMINDER,
      run_at: runAt.toISOString()
    }
  });
}

export async function cancelPendingApprovalReminderJobs(meetingRequestId: string): Promise<number> {
  return cancelPendingBackgroundJobsByTypes(meetingRequestId, [BackgroundJobType.APPROVAL_REMINDER]);
}

export async function cancelPendingBackgroundJobsByTypes(
  meetingRequestId: string,
  jobTypes: BackgroundJobType[]
): Promise<number> {
  if (jobTypes.length === 0) {
    return 0;
  }

  const result = await prisma.backgroundJob.updateMany({
    where: {
      meetingRequestId,
      jobType: {
        in: jobTypes
      },
      status: BackgroundJobStatus.PENDING
    },
    data: {
      status: BackgroundJobStatus.CANCELLED,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedAt: null
    }
  });

  return result.count;
}
