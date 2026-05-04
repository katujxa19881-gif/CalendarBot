import {
  JournalActorRole,
  JournalActionType,
  MeetingRequest,
  MeetingRequestStatus
} from "@prisma/client";
import { prisma } from "../db";
import { logEvent } from "../logger";

const ALLOWED_TRANSITIONS: Record<MeetingRequestStatus, MeetingRequestStatus[]> = {
  NEW: ["PENDING_APPROVAL", "EXPIRED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["RESCHEDULE_REQUESTED", "CANCELLED"],
  REJECTED: [],
  CANCELLED: [],
  RESCHEDULE_REQUESTED: ["RESCHEDULED", "REJECTED", "CANCELLED"],
  RESCHEDULED: ["RESCHEDULE_REQUESTED", "CANCELLED"],
  EXPIRED: []
};

export class MeetingRequestStatusTransitionError extends Error {
  public readonly code: "REQUEST_NOT_FOUND" | "INVALID_STATUS_TRANSITION";

  public constructor(code: "REQUEST_NOT_FOUND" | "INVALID_STATUS_TRANSITION", message: string) {
    super(message);
    this.name = "MeetingRequestStatusTransitionError";
    this.code = code;
  }
}

type TransitionInput = {
  meetingRequestId: string;
  toStatus: MeetingRequestStatus;
  actorId: string;
  actorRole: JournalActorRole;
  comment?: string | null;
};

function assertTransition(from: MeetingRequestStatus, to: MeetingRequestStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new MeetingRequestStatusTransitionError(
      "INVALID_STATUS_TRANSITION",
      `Transition ${from} -> ${to} is not allowed`
    );
  }
}

function getTransitionTimestamps(
  current: MeetingRequest,
  toStatus: MeetingRequestStatus,
  now: Date
): Pick<MeetingRequest, "submittedAt" | "resolvedAt"> {
  const isResolvedStatus: MeetingRequestStatus[] = [
    "APPROVED",
    "REJECTED",
    "CANCELLED",
    "RESCHEDULED",
    "EXPIRED"
  ];

  return {
    submittedAt:
      toStatus === "PENDING_APPROVAL" && current.submittedAt == null ? now : current.submittedAt,
    resolvedAt: isResolvedStatus.includes(toStatus) ? now : current.resolvedAt
  };
}

export async function transitionMeetingRequestStatus(input: TransitionInput): Promise<MeetingRequest> {
  const current = await prisma.meetingRequest.findUnique({
    where: { id: input.meetingRequestId }
  });

  if (!current) {
    throw new MeetingRequestStatusTransitionError(
      "REQUEST_NOT_FOUND",
      `Meeting request ${input.meetingRequestId} not found`
    );
  }

  assertTransition(current.status, input.toStatus);

  const now = new Date();
  const timestamps = getTransitionTimestamps(current, input.toStatus, now);
  const shouldWriteApprover = input.toStatus === "APPROVED" || input.toStatus === "REJECTED";

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.meetingRequest.update({
      where: { id: input.meetingRequestId },
      data: {
        status: input.toStatus,
        submittedAt: timestamps.submittedAt,
        resolvedAt: timestamps.resolvedAt,
        approverId: shouldWriteApprover ? input.actorId : current.approverId,
        approverComment: input.comment ?? current.approverComment
      }
    });

    await tx.actionLog.create({
      data: {
        meetingRequestId: next.id,
        userId: next.userId,
        actorRole: input.actorRole,
        actorId: input.actorId,
        actionType: JournalActionType.STATUS_CHANGED,
        details: {
          fromStatus: current.status,
          toStatus: input.toStatus,
          comment: input.comment ?? null
        },
        result: "ok"
      }
    });

    return next;
  });

  logEvent({
    operation: "status_transition",
    status: "ok",
    actor_id: input.actorId,
    entity_id: input.meetingRequestId,
    details: {
      from_status: current.status,
      to_status: input.toStatus
    }
  });

  return updated;
}
