import { DraftStatus, MeetingRequestStatus } from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { resolveDatabaseUrl } from "../env";
import { logEvent } from "../logger";
import { createTelegramBotRuntime, ensureWizardStateForUser } from "../telegram/bot";

const TELEGRAM_USER_ID = "900001";
const CHAT_ID = 900001;

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name: string;
  username: string;
  language_code: string;
};

const user: TelegramUser = {
  id: Number(TELEGRAM_USER_ID),
  is_bot: false,
  first_name: "Иван",
  last_name: "Петров",
  username: "stage3_user",
  language_code: "ru"
};

let updateId = 1000;
let messageId = 2000;

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

function createMessageUpdate(text: string) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextMessageId(),
      date: nowSeconds(),
      chat: {
        id: CHAT_ID,
        type: "private"
      },
      from: user,
      text
    }
  };
}

function createCallbackUpdate(data: string) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `cb_${updateId}`,
      from: user,
      chat_instance: "stage3_verify",
      data,
      message: {
        message_id: nextMessageId(),
        date: nowSeconds(),
        chat: {
          id: CHAT_ID,
          type: "private"
        },
        text: "button"
      }
    }
  };
}

async function cleanupTestUserData(): Promise<void> {
  const dbUser = await prisma.user.findUnique({ where: { telegramId: TELEGRAM_USER_ID } });
  if (!dbUser) {
    return;
  }

  const requests = await prisma.meetingRequest.findMany({
    where: { userId: dbUser.id },
    select: { id: true }
  });

  const requestIds = requests.map((request) => request.id);

  if (requestIds.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
  }

  await prisma.actionLog.deleteMany({ where: { userId: dbUser.id } });
  await prisma.meetingRequestDraft.deleteMany({ where: { userId: dbUser.id } });
  await prisma.meetingRequest.deleteMany({ where: { userId: dbUser.id } });
  await prisma.user.delete({ where: { id: dbUser.id } });
}

async function run(): Promise<void> {
  resolveDatabaseUrl();

  logEvent({
    operation: "wizard_started",
    status: "ok",
    details: { stage: "3", mode: "verify_script_start" }
  });

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage3verify";
  const runtime = createTelegramBotRuntime({
    botToken,
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
    dryRun: true
  });

  try {
    await connectDatabase();
    await cleanupTestUserData();

    const updates = [
      createMessageUpdate("/start"),
      createCallbackUpdate("consent:accept"),
      createCallbackUpdate("menu:new"),
      createCallbackUpdate("dur:30"),
      createCallbackUpdate("fmt:ONLINE"),
      createCallbackUpdate("slot:0"),
      createMessageUpdate("Планирование MVP"),
      createMessageUpdate("-"),
      createMessageUpdate("wrong-email"),
      createMessageUpdate("guest@example.com"),
      createMessageUpdate("Иван"),
      createMessageUpdate("Петров"),
      createCallbackUpdate("review:submit"),
      createMessageUpdate("/history"),
      createCallbackUpdate("menu:new"),
      createCallbackUpdate("dur:15"),
      createMessageUpdate("/start"),
      createCallbackUpdate("menu:resume")
    ];

    for (const update of updates) {
      await runtime.bot.handleUpdate(update as never);
    }

    const state = await ensureWizardStateForUser(TELEGRAM_USER_ID);

    const hasSubmittedRequest = state.requests.some(
      (request) => request.status === MeetingRequestStatus.PENDING_APPROVAL
    );

    const hasDraftAfterResume = state.draft?.status === DraftStatus.ACTIVE;

    if (!hasSubmittedRequest) {
      throw new Error("Expected at least one submitted meeting request with PENDING_APPROVAL status");
    }

    if (!hasDraftAfterResume) {
      throw new Error("Expected active draft after resume flow");
    }

    logEvent({
      operation: "meeting_request_submitted",
      status: "ok",
      details: {
        stage: "3",
        requests_count: state.requests.length,
        has_active_draft: Boolean(state.draft)
      }
    });
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error) => {
  const err = error instanceof Error ? error : new Error("Unknown stage3 verification error");

  logEvent({
    level: "error",
    operation: "db_error",
    status: "error",
    error_code: "STAGE3_VERIFY_FAILED",
    error_message: err.message
  });

  process.exit(1);
});
