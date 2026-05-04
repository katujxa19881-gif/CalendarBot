import {
  CalendarEventSyncStatus,
  DraftStatus,
  JournalActionType,
  MeetingRequestStatus
} from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { resolveDatabaseUrl } from "../env";
import {
  CalendarEventCreateInput,
  CalendarEventCreateResult,
  CalendarEventUpdateInput,
  CalendarEventCancelInput
} from "../integrations/google-calendar";
import { logEvent } from "../logger";
import { createTelegramBotRuntime } from "../telegram/bot";

const USER_TELEGRAM_ID = "900005";
const USER_CHAT_ID = 900005;
const ADMIN_TELEGRAM_ID = "900099";
const ADMIN_CHAT_ID = 900099;

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name: string;
  username: string;
  language_code: string;
};

const requester: TelegramUser = {
  id: Number(USER_TELEGRAM_ID),
  is_bot: false,
  first_name: "Мария",
  last_name: "Ильина",
  username: "stage5_user",
  language_code: "ru"
};

const admin: TelegramUser = {
  id: Number(ADMIN_TELEGRAM_ID),
  is_bot: false,
  first_name: "Админ",
  last_name: "Тестов",
  username: "stage5_admin",
  language_code: "ru"
};

let updateId = 5000;
let messageId = 7000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function nextMessageId(): number {
  messageId += 1;
  return messageId;
}

function createMessageUpdate(user: TelegramUser, chatId: number, text: string) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextMessageId(),
      date: nowSeconds(),
      chat: {
        id: chatId,
        type: "private"
      },
      from: user,
      text
    }
  };
}

function createCallbackUpdate(user: TelegramUser, chatId: number, data: string) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `cb_${updateId}`,
      from: user,
      chat_instance: "stage5_verify",
      data,
      message: {
        message_id: nextMessageId(),
        date: nowSeconds(),
        chat: {
          id: chatId,
          type: "private"
        },
        text: "button"
      }
    }
  };
}

async function cleanupTestData(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      telegramId: {
        in: [USER_TELEGRAM_ID, ADMIN_TELEGRAM_ID]
      }
    },
    select: { id: true }
  });

  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) {
    return;
  }

  const requests = await prisma.meetingRequest.findMany({
    where: { userId: { in: userIds } },
    select: { id: true }
  });

  const requestIds = requests.map((request) => request.id);

  if (requestIds.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
  }

  await prisma.actionLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function buildAndSubmitRequest(runtime: ReturnType<typeof createTelegramBotRuntime>, topic: string): Promise<string> {
  const flow = [
    createMessageUpdate(requester, USER_CHAT_ID, "/start"),
    createCallbackUpdate(requester, USER_CHAT_ID, "consent:accept"),
    createCallbackUpdate(requester, USER_CHAT_ID, "menu:new"),
    createCallbackUpdate(requester, USER_CHAT_ID, "dur:30"),
    createCallbackUpdate(requester, USER_CHAT_ID, "fmt:ONLINE"),
    createCallbackUpdate(requester, USER_CHAT_ID, "slot:0"),
    createMessageUpdate(requester, USER_CHAT_ID, topic),
    createMessageUpdate(requester, USER_CHAT_ID, "-"),
    createMessageUpdate(requester, USER_CHAT_ID, "guest.stage5@example.com"),
    createMessageUpdate(requester, USER_CHAT_ID, "Мария"),
    createMessageUpdate(requester, USER_CHAT_ID, "Ильина"),
    createCallbackUpdate(requester, USER_CHAT_ID, "review:submit")
  ];

  for (const update of flow) {
    await runtime.bot.handleUpdate(update as never);
  }

  const pending = await prisma.meetingRequest.findFirst({
    where: {
      status: MeetingRequestStatus.PENDING_APPROVAL,
      topic
    },
    orderBy: { createdAt: "desc" }
  });

  if (!pending) {
    throw new Error(`Expected pending request for topic: ${topic}`);
  }

  return pending.id;
}

async function run(): Promise<void> {
  resolveDatabaseUrl();
  process.env.DISABLE_ANTI_SPAM = "true";

  logEvent({
    operation: "approval_requested",
    status: "ok",
    details: { stage: "5", mode: "verify_script_start" }
  });

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage5verify";

  let eventSeq = 0;
  const calendarEventSyncProvider = {
    async createEvent(input: CalendarEventCreateInput): Promise<CalendarEventCreateResult> {
      eventSeq += 1;
      return {
        googleCalendarEventId: `gcal_event_${eventSeq}_${input.externalRequestId}`,
        googleCalendarId: "primary",
        googleMeetLink: null
      };
    },
    async updateEvent(input: CalendarEventUpdateInput): Promise<CalendarEventCreateResult> {
      return {
        googleCalendarEventId: input.googleCalendarEventId,
        googleCalendarId: "primary",
        googleMeetLink: null
      };
    },
    async cancelEvent(_input: CalendarEventCancelInput): Promise<void> {
      return;
    }
  };

  const runtime = createTelegramBotRuntime({
    botToken,
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
    dryRun: true,
    calendarEventSyncProvider,
    adminTelegramId: ADMIN_TELEGRAM_ID
  });

  try {
    await connectDatabase();
    await cleanupTestData();

    const requestToApproveId = await buildAndSubmitRequest(runtime, "Этап 5 подтверждение");

    await runtime.bot.handleUpdate(
      createCallbackUpdate(admin, ADMIN_CHAT_ID, `approval:confirm:${requestToApproveId}`) as never
    );

    const approved = await prisma.meetingRequest.findUnique({
      where: { id: requestToApproveId }
    });

    if (!approved || approved.status !== MeetingRequestStatus.APPROVED) {
      throw new Error("Expected APPROVED status after admin confirmation");
    }

    const syncedEvent = await prisma.calendarEvent.findUnique({ where: { meetingRequestId: requestToApproveId } });
    if (!syncedEvent || syncedEvent.syncStatus !== CalendarEventSyncStatus.SYNCED) {
      throw new Error("Expected synced calendar event");
    }

    const requestToRejectId = await buildAndSubmitRequest(runtime, "Этап 5 отклонение");

    await runtime.bot.handleUpdate(
      createCallbackUpdate(admin, ADMIN_CHAT_ID, `approval:reject:${requestToRejectId}`) as never
    );

    await runtime.bot.handleUpdate(createMessageUpdate(admin, ADMIN_CHAT_ID, "Слот конфликтует с личной встречей") as never);

    const rejected = await prisma.meetingRequest.findUnique({
      where: { id: requestToRejectId }
    });

    if (!rejected || rejected.status !== MeetingRequestStatus.REJECTED) {
      throw new Error("Expected REJECTED status after admin rejection");
    }

    if (!rejected.approverComment || !rejected.approverComment.includes("конфликт")) {
      throw new Error("Expected rejection comment saved in meeting request");
    }

    const userEntity = await prisma.user.findUnique({ where: { telegramId: USER_TELEGRAM_ID } });
    if (!userEntity) {
      throw new Error("Expected requester user to exist");
    }

    const logs = await prisma.actionLog.findMany({
      where: {
        userId: userEntity.id,
        actionType: {
          in: [
            JournalActionType.APPROVAL_CONFIRMED,
            JournalActionType.APPROVAL_REJECTED,
            JournalActionType.CALENDAR_EVENT_CREATED
          ]
        }
      }
    });

    const hasApprovalConfirmed = logs.some((log) => log.actionType === JournalActionType.APPROVAL_CONFIRMED);
    const hasApprovalRejected = logs.some((log) => log.actionType === JournalActionType.APPROVAL_REJECTED);
    const hasCalendarEventCreated = logs.some((log) => log.actionType === JournalActionType.CALENDAR_EVENT_CREATED);

    if (!hasApprovalConfirmed || !hasApprovalRejected || !hasCalendarEventCreated) {
      throw new Error("Expected approval and calendar action logs for stage 5 flow");
    }

    const noActiveDraft =
      (await prisma.meetingRequestDraft.count({ where: { userId: userEntity.id, status: DraftStatus.ACTIVE } })) === 0;

    if (!noActiveDraft) {
      throw new Error("Expected no active drafts after completed stage 5 scenarios");
    }

    logEvent({
      operation: "approval_confirmed",
      status: "ok",
      details: {
        stage: "5",
        approved_request_id: requestToApproveId,
        rejected_request_id: requestToRejectId
      }
    });
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error) => {
  const err = error instanceof Error ? error : new Error("Unknown stage5 verification error");

  logEvent({
    level: "error",
    operation: "db_error",
    status: "error",
    error_code: "STAGE5_VERIFY_FAILED",
    error_message: err.message
  });

  process.exit(1);
});
