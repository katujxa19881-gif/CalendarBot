"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MeetingRequestStatusTransitionError = void 0;
exports.transitionMeetingRequestStatus = transitionMeetingRequestStatus;
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const logger_1 = require("../logger");
const ALLOWED_TRANSITIONS = {
    NEW: ["PENDING_APPROVAL", "EXPIRED"],
    PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED"],
    APPROVED: ["RESCHEDULE_REQUESTED", "CANCELLED"],
    REJECTED: [],
    CANCELLED: [],
    RESCHEDULE_REQUESTED: ["RESCHEDULED", "REJECTED", "CANCELLED"],
    RESCHEDULED: ["RESCHEDULE_REQUESTED", "CANCELLED"],
    EXPIRED: []
};
class MeetingRequestStatusTransitionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "MeetingRequestStatusTransitionError";
        this.code = code;
    }
}
exports.MeetingRequestStatusTransitionError = MeetingRequestStatusTransitionError;
function assertTransition(from, to) {
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
        throw new MeetingRequestStatusTransitionError("INVALID_STATUS_TRANSITION", `Transition ${from} -> ${to} is not allowed`);
    }
}
function getTransitionTimestamps(current, toStatus, now) {
    const isResolvedStatus = [
        "APPROVED",
        "REJECTED",
        "CANCELLED",
        "RESCHEDULED",
        "EXPIRED"
    ];
    return {
        submittedAt: toStatus === "PENDING_APPROVAL" && current.submittedAt == null ? now : current.submittedAt,
        resolvedAt: isResolvedStatus.includes(toStatus) ? now : current.resolvedAt
    };
}
async function transitionMeetingRequestStatus(input) {
    const current = await db_1.prisma.meetingRequest.findUnique({
        where: { id: input.meetingRequestId }
    });
    if (!current) {
        throw new MeetingRequestStatusTransitionError("REQUEST_NOT_FOUND", `Meeting request ${input.meetingRequestId} not found`);
    }
    assertTransition(current.status, input.toStatus);
    const now = new Date();
    const timestamps = getTransitionTimestamps(current, input.toStatus, now);
    const shouldWriteApprover = input.toStatus === "APPROVED" || input.toStatus === "REJECTED";
    const updated = await db_1.prisma.$transaction(async (tx) => {
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
                actionType: client_1.JournalActionType.STATUS_CHANGED,
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
    (0, logger_1.logEvent)({
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
