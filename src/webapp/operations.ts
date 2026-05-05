import {
  BackgroundJobType,
  CalendarEventSyncStatus,
  JournalActionType,
  JournalActorRole,
  MeetingRequestStatus,
  Prisma
} from "@prisma/client";
import { prisma } from "../db";
import {
  cancelPendingBackgroundJobsByTypes,
  cancelPendingApprovalReminderJobs,
  scheduleApprovalReminderJob,
  scheduleDecisionEmailJob,
  scheduleUpcomingReminderEmailJob
} from "../background/jobs";
import { transitionMeetingRequestStatus } from "../domain/meeting-request-status";
import { patchMeetingSettings } from "../domain/app-settings";
import {
  CalendarEventSyncProvider,
  CalendarEventCreateResult,
  createGoogleCalendarEventSyncProvider
} from "../integrations/google-calendar";
import { logEvent } from "../logger";
import { ensureSlotStillAvailable } from "../application/slots";
import { getApprovalConfig, getTelegramConfig } from "../env";

export class WebAppOperationError extends Error {
  public readonly code:
    | "REQUEST_NOT_FOUND"
    | "REQUEST_STATUS_INVALID"
    | "CALENDAR_PROVIDER_MISSING"
    | "CALENDAR_SYNC_FAILED"
    | "CALENDAR_EVENT_MISSING"
    | "SLOT_NOT_AVAILABLE"
    | "SETTINGS_PATCH_INVALID";

  public constructor(
    code:
      | "REQUEST_NOT_FOUND"
      | "REQUEST_STATUS_INVALID"
      | "CALENDAR_PROVIDER_MISSING"
      | "CALENDAR_SYNC_FAILED"
      | "CALENDAR_EVENT_MISSING"
      | "SLOT_NOT_AVAILABLE"
      | "SETTINGS_PATCH_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WebAppOperationError";
    this.code = code;
  }
}

let calendarSyncProviderOverride: CalendarEventSyncProvider | null | undefined;

function getCalendarSyncProvider(): CalendarEventSyncProvider | null {
  if (calendarSyncProviderOverride !== undefined) {
    return calendarSyncProviderOverride;
  }

  return createGoogleCalendarEventSyncProvider();
}

export function setWebAppCalendarSyncProvider(provider: CalendarEventSyncProvider | null | undefined): void {
  calendarSyncProviderOverride = provider;
}

function formatDateRangeMoscow(startAt: Date, endAt: Date): string {
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

function formatRequestCode(createdAt: Date): string {
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

async function sendTelegramMessage(input: { chatId: string; text: string; meetLink?: string | null }): Promise<void> {
  const { botToken } = getTelegramConfig();
  if (!botToken) {
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        ...(input.meetLink
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Открыть встречу", url: input.meetLink }]]
              }
            }
          : {})
      })
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage HTTP ${response.status}`);
    }
  } catch (error) {
    logEvent({
      level: "warn",
      operation: "user_notified",
      status: "error",
      error_code: "WEBAPP_TELEGRAM_NOTIFY_FAILED",
      error_message: error instanceof Error ? error.message : "Telegram notify failed",
      details: {
        channel: "webapp"
      }
    });
  }
}

export async function listAdminRequests(input: {
  status?: MeetingRequestStatus;
  createdFrom?: Date;
  createdTo?: Date;
  limit: number;
}) {
  const where: Prisma.MeetingRequestWhereInput = {};

  if (input.status) {
    where.status = input.status;
  }

  if (input.createdFrom || input.createdTo) {
    where.createdAt = {
      ...(input.createdFrom ? { gte: input.createdFrom } : {}),
      ...(input.createdTo ? { lte: input.createdTo } : {})
    };
  }

  return prisma.meetingRequest.findMany({
    where,
    include: {
      user: true,
      calendarEvent: {
        select: {
          googleMeetLink: true
        }
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    take: input.limit
  });
}

async function createCalendarEvent(input: {
  requestId: string;
  topic: string;
  description: string | null;
  format: "ONLINE" | "OFFLINE";
  location: string | null;
  startAt: Date;
  endAt: Date;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Promise<CalendarEventCreateResult> {
  const calendarSyncProvider = getCalendarSyncProvider();
  if (!calendarSyncProvider) {
    throw new WebAppOperationError("CALENDAR_PROVIDER_MISSING", "Calendar provider is not configured");
  }

  try {
    return await calendarSyncProvider.createEvent({
      externalRequestId: input.requestId,
      topic: input.topic,
      description: input.description,
      format: input.format,
      location: input.location,
      startAt: input.startAt,
      endAt: input.endAt,
      attendeeEmail: input.email,
      attendeeFirstName: input.firstName,
      attendeeLastName: input.lastName
    });
  } catch (error) {
    throw new WebAppOperationError(
      "CALENDAR_SYNC_FAILED",
      error instanceof Error ? error.message : "Calendar sync failed"
    );
  }
}

export async function approveMeetingRequestByAdmin(input: {
  meetingRequestId: string;
  adminTelegramId: string;
  comment?: string | null;
}) {
  const request = await prisma.meetingRequest.findUnique({
    where: {
      id: input.meetingRequestId
    },
    include: {
      user: true
    }
  });

  if (!request) {
    throw new WebAppOperationError("REQUEST_NOT_FOUND", "Meeting request not found");
  }

  if (request.status !== MeetingRequestStatus.PENDING_APPROVAL) {
    throw new WebAppOperationError("REQUEST_STATUS_INVALID", `Cannot approve request in status ${request.status}`);
  }

  const calendarEvent = await createCalendarEvent({
    requestId: request.id,
    topic: request.topic,
    description: request.description ?? null,
    format: request.format,
    location: request.location ?? null,
    startAt: request.startAt,
    endAt: request.endAt,
    email: request.email,
    firstName: request.firstName ?? null,
    lastName: request.lastName ?? null
  });

  await transitionMeetingRequestStatus({
    meetingRequestId: request.id,
    toStatus: MeetingRequestStatus.APPROVED,
    actorId: input.adminTelegramId,
    actorRole: JournalActorRole.ADMIN,
    comment: input.comment ?? null
  });

  await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.upsert({
      where: { meetingRequestId: request.id },
      update: {
        googleCalendarEventId: calendarEvent.googleCalendarEventId,
        googleCalendarId: calendarEvent.googleCalendarId,
        googleMeetLink: calendarEvent.googleMeetLink,
        syncStatus: CalendarEventSyncStatus.SYNCED,
        syncedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null
      },
      create: {
        meetingRequestId: request.id,
        googleCalendarEventId: calendarEvent.googleCalendarEventId,
        googleCalendarId: calendarEvent.googleCalendarId,
        googleMeetLink: calendarEvent.googleMeetLink,
        syncStatus: CalendarEventSyncStatus.SYNCED,
        syncedAt: new Date()
      }
    });

    await tx.actionLog.create({
      data: {
        meetingRequestId: request.id,
        userId: request.userId,
        actorRole: JournalActorRole.ADMIN,
        actorId: input.adminTelegramId,
        actionType: JournalActionType.APPROVAL_CONFIRMED,
        details: {
          comment: input.comment ?? null,
          source: "webapp_admin",
          channel: "webapp"
        },
        result: "ok"
      }
    });
  });

  await cancelPendingApprovalReminderJobs(request.id);
  await scheduleDecisionEmailJob(request.id);
  await scheduleUpcomingReminderEmailJob({
    ...request,
    status: MeetingRequestStatus.APPROVED
  });

  await sendTelegramMessage({
    chatId: request.user.telegramId,
    text: [
      "✅ Встреча подтверждена.",
      "",
      `Номер заявки: ${formatRequestCode(request.createdAt)}`,
      `Тема: ${request.topic}`,
      `Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`,
      ...(input.comment ? [`Комментарий: ${input.comment}`] : [])
    ].join("\n"),
    meetLink: calendarEvent.googleMeetLink
  });

  return request;
}

export async function rejectMeetingRequestByAdmin(input: {
  meetingRequestId: string;
  adminTelegramId: string;
  comment: string | null;
}) {
  const request = await prisma.meetingRequest.findUnique({
    where: {
      id: input.meetingRequestId
    },
    include: {
      user: true
    }
  });

  if (!request) {
    throw new WebAppOperationError("REQUEST_NOT_FOUND", "Meeting request not found");
  }

  if (request.status !== MeetingRequestStatus.PENDING_APPROVAL) {
    throw new WebAppOperationError("REQUEST_STATUS_INVALID", `Cannot reject request in status ${request.status}`);
  }

  await transitionMeetingRequestStatus({
    meetingRequestId: request.id,
    toStatus: MeetingRequestStatus.REJECTED,
    actorId: input.adminTelegramId,
    actorRole: JournalActorRole.ADMIN,
    comment: input.comment
  });

  await prisma.actionLog.create({
    data: {
      meetingRequestId: request.id,
      userId: request.userId,
      actorRole: JournalActorRole.ADMIN,
      actorId: input.adminTelegramId,
      actionType: JournalActionType.APPROVAL_REJECTED,
      details: {
        comment: input.comment,
        source: "webapp_admin",
        channel: "webapp"
      },
      result: "ok"
    }
  });

  await cancelPendingApprovalReminderJobs(request.id);
  await scheduleDecisionEmailJob(request.id);

  const lines = [
    "❌ Заявка отклонена.",
    "",
    `Номер заявки: ${formatRequestCode(request.createdAt)}`,
    `Тема: ${request.topic}`,
    `Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`
  ];
  if (input.comment) {
    lines.push(`Комментарий: ${input.comment}`);
  }

  await sendTelegramMessage({
    chatId: request.user.telegramId,
    text: lines.join("\n")
  });

  return request;
}

export async function cancelMeetingRequest(input: {
  meetingRequestId: string;
  actorTelegramId: string;
  actorRole: "USER" | "ADMIN";
  comment?: string | null;
}) {
  const request = await prisma.meetingRequest.findUnique({
    where: {
      id: input.meetingRequestId
    },
    include: {
      calendarEvent: true,
      user: true
    }
  });

  if (!request) {
    throw new WebAppOperationError("REQUEST_NOT_FOUND", "Meeting request not found");
  }

  if (
    request.status !== MeetingRequestStatus.PENDING_APPROVAL &&
    request.status !== MeetingRequestStatus.APPROVED &&
    request.status !== MeetingRequestStatus.RESCHEDULE_REQUESTED &&
    request.status !== MeetingRequestStatus.RESCHEDULED
  ) {
    throw new WebAppOperationError("REQUEST_STATUS_INVALID", `Cannot cancel request in status ${request.status}`);
  }

  if (request.calendarEvent?.googleCalendarEventId) {
    const calendarSyncProvider = getCalendarSyncProvider();
    if (!calendarSyncProvider) {
      throw new WebAppOperationError("CALENDAR_PROVIDER_MISSING", "Calendar provider is not configured");
    }
    await calendarSyncProvider.cancelEvent({
      externalRequestId: request.id,
      googleCalendarEventId: request.calendarEvent.googleCalendarEventId
    });
  }

  await transitionMeetingRequestStatus({
    meetingRequestId: request.id,
    toStatus: MeetingRequestStatus.CANCELLED,
    actorId: input.actorTelegramId,
    actorRole: input.actorRole
  });

  await prisma.$transaction(async (tx) => {
    if (request.calendarEvent) {
      await tx.calendarEvent.update({
        where: { meetingRequestId: request.id },
        data: {
          syncStatus: CalendarEventSyncStatus.CANCELLED,
          syncedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null
        }
      });
    }

    await tx.actionLog.create({
      data: {
        meetingRequestId: request.id,
        userId: request.userId,
        actorRole: input.actorRole,
        actorId: input.actorTelegramId,
        actionType: JournalActionType.CANCELLATION_COMPLETED,
        details: {
          comment: input.comment ?? null,
          source: input.actorRole === JournalActorRole.ADMIN ? "webapp_admin" : "webapp_user",
          channel: "webapp"
        },
        result: "ok"
      }
    });
  });

  await cancelPendingBackgroundJobsByTypes(request.id, [
    BackgroundJobType.APPROVAL_REMINDER,
    BackgroundJobType.EMAIL_REMINDER
  ]);

  const cancelLines = [`Заявка ${formatRequestCode(request.createdAt)} отменена.`];
  if (input.comment) {
    cancelLines.push(`Комментарий: ${input.comment}`);
  }

  await sendTelegramMessage({
    chatId: request.user.telegramId,
    text: cancelLines.join("\n")
  });

  return request;
}

export async function rescheduleMeetingRequest(input: {
  meetingRequestId: string;
  actorTelegramId: string;
  actorRole: "USER" | "ADMIN";
  newStartAt: Date;
  newEndAt: Date;
  comment?: string | null;
}) {
  const request = await prisma.meetingRequest.findUnique({
    where: {
      id: input.meetingRequestId
    },
    include: {
      calendarEvent: true,
      user: true
    }
  });

  if (!request) {
    throw new WebAppOperationError("REQUEST_NOT_FOUND", "Meeting request not found");
  }

  if (request.status !== MeetingRequestStatus.APPROVED && request.status !== MeetingRequestStatus.RESCHEDULED) {
    throw new WebAppOperationError(
      "REQUEST_STATUS_INVALID",
      `Cannot reschedule request in status ${request.status}`
    );
  }

  if (!request.calendarEvent?.googleCalendarEventId) {
    throw new WebAppOperationError("CALENDAR_EVENT_MISSING", "Calendar event for request is missing");
  }

  const slotAvailable = await ensureSlotStillAvailable({
    startAt: input.newStartAt,
    endAt: input.newEndAt,
    excludeMeetingRequestId: request.id
  });

  if (!slotAvailable) {
    throw new WebAppOperationError("SLOT_NOT_AVAILABLE", "Selected slot is not available");
  }

  const calendarSyncProvider = getCalendarSyncProvider();
  if (!calendarSyncProvider) {
    throw new WebAppOperationError("CALENDAR_PROVIDER_MISSING", "Calendar provider is not configured");
  }

  const updatedEvent = await calendarSyncProvider.updateEvent({
    externalRequestId: request.id,
    googleCalendarEventId: request.calendarEvent.googleCalendarEventId,
    topic: request.topic,
    description: request.description ?? null,
    format: request.format,
    location: request.location ?? null,
    startAt: input.newStartAt,
    endAt: input.newEndAt,
    attendeeEmail: request.email,
    attendeeFirstName: request.firstName ?? null,
    attendeeLastName: request.lastName ?? null
  });

  await transitionMeetingRequestStatus({
    meetingRequestId: request.id,
    toStatus: MeetingRequestStatus.RESCHEDULE_REQUESTED,
    actorId: input.actorTelegramId,
    actorRole: input.actorRole
  });

  await prisma.meetingRequest.update({
    where: {
      id: request.id
    },
    data: {
      startAt: input.newStartAt,
      endAt: input.newEndAt
    }
  });

  await transitionMeetingRequestStatus({
    meetingRequestId: request.id,
    toStatus: MeetingRequestStatus.RESCHEDULED,
    actorId: input.actorTelegramId,
    actorRole: input.actorRole
  });

  await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.update({
      where: { meetingRequestId: request.id },
      data: {
        googleCalendarEventId: updatedEvent.googleCalendarEventId,
        googleCalendarId: updatedEvent.googleCalendarId,
        googleMeetLink: updatedEvent.googleMeetLink,
        syncStatus: CalendarEventSyncStatus.UPDATED,
        syncedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    await tx.actionLog.create({
      data: {
        meetingRequestId: request.id,
        userId: request.userId,
        actorRole: input.actorRole,
        actorId: input.actorTelegramId,
        actionType: JournalActionType.RESCHEDULED,
        details: {
          old_start_at: request.startAt.toISOString(),
          old_end_at: request.endAt.toISOString(),
          new_start_at: input.newStartAt.toISOString(),
          new_end_at: input.newEndAt.toISOString(),
          comment: input.comment ?? null,
          source: input.actorRole === JournalActorRole.ADMIN ? "webapp_admin" : "webapp_user",
          channel: "webapp"
        },
        result: "ok"
      }
    });
  });

  await cancelPendingBackgroundJobsByTypes(request.id, [BackgroundJobType.EMAIL_REMINDER]);
  const updatedRequest = await prisma.meetingRequest.findUnique({
    where: {
      id: request.id
    }
  });
  if (updatedRequest) {
    await scheduleUpcomingReminderEmailJob(updatedRequest);
  }

  await sendTelegramMessage({
    chatId: request.user.telegramId,
    text: [
      "Встреча перенесена.",
      `Номер заявки: ${formatRequestCode(request.createdAt)}`,
      `Новое время: ${formatDateRangeMoscow(input.newStartAt, input.newEndAt)}`,
      ...(input.comment ? [`Комментарий: ${input.comment}`] : [])
    ].join("\n"),
    meetLink: updatedEvent.googleMeetLink
  });

  return request;
}

export async function patchMeetingSettingsByAdmin(input: {
  adminTelegramId: string;
  patch: {
    workdayStartHour?: number;
    workdayEndHour?: number;
    slotLimit?: number;
    slotBufferMinutes?: number;
    slotMinLeadHours?: number;
    slotHorizonDays?: number;
  };
}) {
  const patchKeys = Object.keys(input.patch);
  if (patchKeys.length === 0) {
    throw new WebAppOperationError("SETTINGS_PATCH_INVALID", "Settings patch payload is empty");
  }

  const updated = await patchMeetingSettings(input.patch);

  logEvent({
    operation: "admin_settings_updated",
    status: "ok",
    actor_id: input.adminTelegramId,
    details: {
      channel: "webapp",
      keys: patchKeys
    }
  });

  return updated;
}

export async function assertAdminActor(telegramId: string): Promise<void> {
  const { adminTelegramId } = getApprovalConfig();
  if (!adminTelegramId || adminTelegramId !== telegramId) {
    throw new WebAppOperationError("REQUEST_STATUS_INVALID", "Admin access denied");
  }
}

export async function submitMeetingRequestFromWebApp(input: {
  userId: string;
  userTelegramId: string;
  durationMinutes: number;
  format: "ONLINE" | "OFFLINE";
  startAt: Date;
  endAt: Date;
  topic: string;
  description: string | null;
  email: string;
  firstName: string;
  lastName: string;
  location: string | null;
}) {
  const slotStillAvailable = await ensureSlotStillAvailable({
    startAt: input.startAt,
    endAt: input.endAt
  });

  if (!slotStillAvailable) {
    throw new WebAppOperationError("SLOT_NOT_AVAILABLE", "Selected slot is not available");
  }

  const meetingRequest = await prisma.meetingRequest.create({
    data: {
      userId: input.userId,
      durationMinutes: input.durationMinutes,
      format: input.format,
      startAt: input.startAt,
      endAt: input.endAt,
      topic: input.topic,
      description: input.description,
      location: input.format === "OFFLINE" ? input.location : null,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      status: MeetingRequestStatus.PENDING_APPROVAL,
      submittedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  await prisma.user.update({
    where: {
      id: input.userId
    },
    data: {
      lastUsedEmail: input.email,
      firstName: input.firstName,
      lastName: input.lastName
    }
  });

  await prisma.actionLog.create({
    data: {
      meetingRequestId: meetingRequest.id,
      userId: input.userId,
      actorRole: JournalActorRole.USER,
      actorId: input.userTelegramId,
      actionType: JournalActionType.MEETING_REQUEST_SUBMITTED,
      details: {
        source: "webapp_user",
        channel: "webapp"
      },
      result: "ok"
    }
  });

  await scheduleApprovalReminderJob(meetingRequest);

  const { adminTelegramId } = getApprovalConfig();
  if (adminTelegramId) {
    const lines = [
      "🟡 Новая заявка на подтверждение (mini app).",
      "",
      `Номер заявки: ${formatRequestCode(meetingRequest.createdAt)}`,
      `Тема: ${meetingRequest.topic}`,
      `Формат: ${meetingRequest.format === "ONLINE" ? "онлайн" : "оффлайн"}`,
      `Длительность: ${meetingRequest.durationMinutes} мин.`,
      `Дата и время: ${formatDateRangeMoscow(meetingRequest.startAt, meetingRequest.endAt)}`,
      `Email: ${meetingRequest.email}`
    ];
    if (meetingRequest.format === "OFFLINE") {
      lines.push(`Место: ${meetingRequest.location ?? "-"}`);
    }
    await sendTelegramMessage({
      chatId: adminTelegramId,
      text: lines.join("\n")
    });
  }

  logEvent({
    operation: "meeting_request_submitted",
    status: "ok",
    user_id: input.userId,
    entity_id: meetingRequest.id,
    details: {
      channel: "webapp"
    }
  });

  return meetingRequest;
}
