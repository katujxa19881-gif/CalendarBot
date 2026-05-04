import { DraftStatus, MeetingRequestStatus } from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { resolveDatabaseUrl } from "../env";
import { BusyInterval } from "../integrations/google-calendar";
import { logEvent } from "../logger";
import { createTelegramBotRuntime, ensureWizardStateForUser } from "../telegram/bot";

const TELEGRAM_USER_ID = "900004";
const CHAT_ID = 900004;

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
  first_name: "Анна",
  last_name: "Смирнова",
  username: "stage4_user",
  language_code: "ru"
};

let updateId = 4000;
let messageId = 5000;

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
      chat_instance: "stage4_verify",
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
    operation: "slots_built",
    status: "ok",
    details: { stage: "4", mode: "verify_script_start" }
  });

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage4verify";

  let conflictChecksRemaining = 1;
  let oauthLogged = false;

  const testProvider = {
    async getBusyIntervals(range: { timeMin: Date; timeMax: Date }): Promise<BusyInterval[]> {
      if (!oauthLogged) {
        oauthLogged = true;
        logEvent({
          operation: "google_oauth_connected",
          status: "ok",
          details: {
            stage: "4",
            mode: "verify_mock_provider"
          }
        });
      }

      logEvent({
        operation: "calendar_availability_requested",
        status: "ok",
        details: {
          stage: "4",
          time_min: range.timeMin.toISOString(),
          time_max: range.timeMax.toISOString()
        }
      });

      const spanMs = range.timeMax.getTime() - range.timeMin.getTime();
      const sixHoursMs = 6 * 60 * 60 * 1000;

      if (spanMs <= sixHoursMs && conflictChecksRemaining > 0) {
        conflictChecksRemaining -= 1;
        const busy = [
          {
            startAt: new Date(range.timeMin.getTime() + 5 * 60 * 1000),
            endAt: new Date(range.timeMax.getTime() - 5 * 60 * 1000)
          }
        ];

        logEvent({
          operation: "calendar_availability_received",
          status: "ok",
          details: {
            stage: "4",
            busy_count: busy.length
          }
        });

        return busy;
      }

      logEvent({
        operation: "calendar_availability_received",
        status: "ok",
        details: {
          stage: "4",
          busy_count: 0
        }
      });

      return [];
    }
  };

  const runtime = createTelegramBotRuntime({
    botToken,
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
    dryRun: true,
    availabilityProvider: testProvider
  });

  try {
    await connectDatabase();
    await cleanupTestUserData();

    const firstAttemptUpdates = [
      createMessageUpdate("/start"),
      createCallbackUpdate("consent:accept"),
      createCallbackUpdate("menu:new"),
      createCallbackUpdate("dur:30"),
      createCallbackUpdate("fmt:ONLINE"),
      createCallbackUpdate("slot:0"),
      createMessageUpdate("Сверка расписания"),
      createMessageUpdate("-"),
      createMessageUpdate("guest.stage4@example.com"),
      createMessageUpdate("Анна"),
      createMessageUpdate("Смирнова"),
      createCallbackUpdate("review:submit")
    ];

    for (const update of firstAttemptUpdates) {
      await runtime.bot.handleUpdate(update as never);
    }

    const firstAttemptState = await ensureWizardStateForUser(TELEGRAM_USER_ID);

    if (firstAttemptState.requests.length !== 0) {
      throw new Error("Expected no created requests after conflict recheck");
    }

    if (firstAttemptState.draft?.status !== DraftStatus.ACTIVE || firstAttemptState.draft.currentStep !== "slot") {
      throw new Error("Expected active draft moved back to slot step after conflict");
    }

    const secondAttemptUpdates = [createCallbackUpdate("slot:0"), createCallbackUpdate("review:submit")];

    for (const update of secondAttemptUpdates) {
      await runtime.bot.handleUpdate(update as never);
    }

    const finalState = await ensureWizardStateForUser(TELEGRAM_USER_ID);

    const hasSubmittedRequest = finalState.requests.some(
      (request) => request.status === MeetingRequestStatus.PENDING_APPROVAL
    );

    if (!hasSubmittedRequest) {
      throw new Error("Expected pending approval request after second submit attempt");
    }

    logEvent({
      operation: "slot_conflict_detected",
      status: "ok",
      details: {
        stage: "4",
        requests_count: finalState.requests.length,
        has_active_draft: Boolean(finalState.draft)
      }
    });
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error) => {
  const err = error instanceof Error ? error : new Error("Unknown stage4 verification error");

  logEvent({
    level: "error",
    operation: "db_error",
    status: "error",
    error_code: "STAGE4_VERIFY_FAILED",
    error_message: err.message
  });

  process.exit(1);
});
