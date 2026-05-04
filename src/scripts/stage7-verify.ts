import { CalendarEventSyncStatus, MeetingFormat, MeetingRequestStatus } from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { createTelegramBotRuntime } from "../telegram/bot";
import { resolveDatabaseUrl } from "../env";

const MARKER = "stage7_verify";

function plusHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTestData(): Promise<void> {
  const users = await prisma.user.findMany({
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

  const requests = await prisma.meetingRequest.findMany({
    where: { userId: { in: userIds } },
    select: { id: true }
  });
  const requestIds = requests.map((item) => item.id);

  if (requestIds.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
  }

  await prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type CalendarUpdateCall = {
  requestId: string;
  eventId: string;
  startAt: string;
  endAt: string;
};

type CalendarCancelCall = {
  requestId: string;
  eventId: string;
};

function buildCallbackUpdate(input: {
  updateId: number;
  callbackId: string;
  telegramId: number;
  data: string;
}): Record<string, unknown> {
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

async function run(): Promise<void> {
  resolveDatabaseUrl();
  process.env.DISABLE_ANTI_SPAM = "true";
  await connectDatabase();

  try {
    await cleanupTestData();

    const user = await prisma.user.create({
      data: {
        telegramId: "7001001",
        username: `${MARKER}_user`,
        firstName: "Stage",
        lastName: "Seven",
        personalDataConsentGiven: true,
        personalDataConsentAt: new Date()
      }
    });

    const reschedulableRequest = await prisma.meetingRequest.create({
      data: {
        userId: user.id,
        durationMinutes: 30,
        format: MeetingFormat.ONLINE,
        startAt: plusHours(48),
        endAt: plusHours(48.5),
        topic: "Stage7 reschedule",
        description: "verify reschedule",
        email: "stage7-reschedule@example.com",
        firstName: "Stage",
        lastName: "Seven",
        status: MeetingRequestStatus.APPROVED,
        submittedAt: plusHours(-5),
        resolvedAt: plusHours(-4)
      }
    });

    await prisma.calendarEvent.create({
      data: {
        meetingRequestId: reschedulableRequest.id,
        googleCalendarEventId: `stage7_event_${reschedulableRequest.id}`,
        googleCalendarId: "primary",
        syncStatus: CalendarEventSyncStatus.SYNCED,
        syncedAt: new Date()
      }
    });

    const cancellableRequest = await prisma.meetingRequest.create({
      data: {
        userId: user.id,
        durationMinutes: 15,
        format: MeetingFormat.ONLINE,
        startAt: plusHours(72),
        endAt: plusHours(72.25),
        topic: "Stage7 cancel",
        description: "verify cancel",
        email: "stage7-cancel@example.com",
        firstName: "Stage",
        lastName: "Seven",
        status: MeetingRequestStatus.APPROVED,
        submittedAt: plusHours(-6),
        resolvedAt: plusHours(-5)
      }
    });

    await prisma.calendarEvent.create({
      data: {
        meetingRequestId: cancellableRequest.id,
        googleCalendarEventId: `stage7_event_${cancellableRequest.id}`,
        googleCalendarId: "primary",
        syncStatus: CalendarEventSyncStatus.SYNCED,
        syncedAt: new Date()
      }
    });

    const updateCalls: CalendarUpdateCall[] = [];
    const cancelCalls: CalendarCancelCall[] = [];

    const runtime = createTelegramBotRuntime({
      botToken: "1:test-token",
      dryRun: true,
      adminTelegramId: "999999",
      availabilityProvider: {
        async getBusyIntervals() {
          return [];
        }
      },
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
    await runtime.bot.handleUpdate(
      buildCallbackUpdate({
        updateId: updateId++,
        callbackId: "cb-resched-request",
        telegramId: 7001001,
        data: `request:reschedule:${reschedulableRequest.id}`
      }) as never
    );

    await sleep(2600);

    await runtime.bot.handleUpdate(
      buildCallbackUpdate({
        updateId: updateId++,
        callbackId: "cb-resched-slot",
        telegramId: 7001001,
        data: `reslot:${reschedulableRequest.id}:0`
      }) as never
    );

    await sleep(2600);

    await runtime.bot.handleUpdate(
      buildCallbackUpdate({
        updateId: updateId++,
        callbackId: "cb-cancel-request",
        telegramId: 7001001,
        data: `request:cancel:${cancellableRequest.id}`
      }) as never
    );

    await runtime.bot.handleUpdate(
      buildCallbackUpdate({
        updateId: updateId++,
        callbackId: "cb-cancel-duplicate",
        telegramId: 7001001,
        data: `request:cancel:${cancellableRequest.id}`
      }) as never
    );

    if (updateCalls.length < 1) {
      throw new Error("Expected at least one calendar update call for reschedule");
    }

    if (cancelCalls.length < 1) {
      throw new Error("Expected at least one calendar cancel call");
    }

    const rescheduled = await prisma.meetingRequest.findUnique({
      where: { id: reschedulableRequest.id },
      include: { calendarEvent: true }
    });
    if (!rescheduled) {
      throw new Error("Rescheduled request not found");
    }
    if (rescheduled.status !== MeetingRequestStatus.RESCHEDULED) {
      throw new Error(`Expected RESCHEDULED status, got ${rescheduled.status}`);
    }
    if (!rescheduled.calendarEvent || rescheduled.calendarEvent.syncStatus !== CalendarEventSyncStatus.UPDATED) {
      throw new Error("Expected UPDATED calendar event status after reschedule");
    }

    const cancelled = await prisma.meetingRequest.findUnique({
      where: { id: cancellableRequest.id },
      include: { calendarEvent: true }
    });
    if (!cancelled) {
      throw new Error("Cancelled request not found");
    }
    if (cancelled.status !== MeetingRequestStatus.CANCELLED) {
      throw new Error(`Expected CANCELLED status, got ${cancelled.status}`);
    }
    if (!cancelled.calendarEvent || cancelled.calendarEvent.syncStatus !== CalendarEventSyncStatus.CANCELLED) {
      throw new Error("Expected CANCELLED calendar event status after cancellation");
    }
  } finally {
    await disconnectDatabase();
  }
}

void run().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDatabase();
  process.exit(1);
});
