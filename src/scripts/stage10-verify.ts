import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { MeetingRequestStatus, MeetingFormat } from "@prisma/client";
import { connectDatabase, disconnectDatabase, prisma } from "../db";
import { buildServer } from "../server";
import { createTelegramBotRuntime } from "../telegram/bot";
import { setWebAppCalendarSyncProvider } from "../webapp/operations";

const USER_A_TELEGRAM_ID = "7101001";
const USER_B_TELEGRAM_ID = "7101002";
const ADMIN_TELEGRAM_ID = "7101999";
const MARKER = "stage10_verify";

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name: string;
  username: string;
  language_code: string;
};

const userA: TelegramUser = {
  id: Number(USER_A_TELEGRAM_ID),
  is_bot: false,
  first_name: "Stage10",
  last_name: "UserA",
  username: `${MARKER}_user_a`,
  language_code: "ru"
};

const adminUser: TelegramUser = {
  id: Number(ADMIN_TELEGRAM_ID),
  is_bot: false,
  first_name: "Stage10",
  last_name: "Admin",
  username: `${MARKER}_admin`,
  language_code: "ru"
};

let updateId = 10000;
let messageId = 11000;

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
      chat_instance: "stage10_verify",
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

function buildInitData(input: { botToken: string; user: Record<string, unknown> }): string {
  const authDate = Math.floor(Date.now() / 1000).toString();
  const fields: Record<string, string> = {
    auth_date: authDate,
    user: JSON.stringify(input.user)
  };

  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort((a, b) => a.localeCompare(b))
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(input.botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");

  return new URLSearchParams({
    ...fields,
    hash
  }).toString();
}

async function cleanupTestData(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { telegramId: USER_A_TELEGRAM_ID },
        { telegramId: USER_B_TELEGRAM_ID },
        { telegramId: ADMIN_TELEGRAM_ID },
        { username: { startsWith: MARKER } }
      ]
    },
    select: { id: true }
  });

  const userIds = users.map((user) => user.id);
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

  await prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.actionLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createPendingRequestViaBot(
  runtime: ReturnType<typeof createTelegramBotRuntime>,
  topic: string
): Promise<string> {
  const chatId = Number(USER_A_TELEGRAM_ID);
  const flow = [
    createMessageUpdate(userA, chatId, "/start"),
    createCallbackUpdate(userA, chatId, "consent:accept"),
    createCallbackUpdate(userA, chatId, "menu:new"),
    createCallbackUpdate(userA, chatId, "dur:30"),
    createCallbackUpdate(userA, chatId, "fmt:ONLINE"),
    createCallbackUpdate(userA, chatId, "slot:0"),
    createMessageUpdate(userA, chatId, topic),
    createMessageUpdate(userA, chatId, "-"),
    createMessageUpdate(userA, chatId, "stage10-bot@example.com"),
    createMessageUpdate(userA, chatId, "Stage10"),
    createMessageUpdate(userA, chatId, "UserA"),
    createCallbackUpdate(userA, chatId, "review:submit")
  ];

  for (const update of flow) {
    await runtime.bot.handleUpdate(update as never);
  }

  const request = await prisma.meetingRequest.findFirst({
    where: {
      topic,
      status: MeetingRequestStatus.PENDING_APPROVAL
    },
    orderBy: { createdAt: "desc" }
  });

  if (!request) {
    throw new Error(`Pending request not found for topic: ${topic}`);
  }

  return request.id;
}

async function authToken(
  app: ReturnType<typeof buildServer>,
  input: { botToken: string; telegramId: string; username: string; firstName: string; lastName: string }
): Promise<string> {
  const initData = buildInitData({
    botToken: input.botToken,
    user: {
      id: Number(input.telegramId),
      username: input.username,
      first_name: input.firstName,
      last_name: input.lastName
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/webapp/auth",
    payload: { initData }
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json() as { ok: boolean; token: string };
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.token, "string");
  return payload.token;
}

async function main(): Promise<void> {
  process.env.DISABLE_ANTI_SPAM = "true";
  process.env.MINI_APP_ENABLED = "true";
  process.env.MINI_APP_ADMIN_ENABLED = "true";
  process.env.MINI_APP_ONBOARDING_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage10-test-token";
  process.env.MINI_APP_SESSION_SECRET = process.env.MINI_APP_SESSION_SECRET ?? "stage10-session-secret";
  process.env.ADMIN_TELEGRAM_ID = ADMIN_TELEGRAM_ID;
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.GOOGLE_REFRESH_TOKEN = "";

  const calendarEventSyncProvider = {
    async createEvent(input: { externalRequestId: string }) {
      return {
        googleCalendarEventId: `stage10_event_${input.externalRequestId}`,
        googleCalendarId: "primary",
        googleMeetLink: null
      };
    },
    async updateEvent(input: { googleCalendarEventId: string }) {
      return {
        googleCalendarEventId: input.googleCalendarEventId,
        googleCalendarId: "primary",
        googleMeetLink: null
      };
    },
    async cancelEvent() {
      return;
    }
  };

  const runtime = createTelegramBotRuntime({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    dryRun: true,
    adminTelegramId: ADMIN_TELEGRAM_ID,
    calendarEventSyncProvider
  });

  setWebAppCalendarSyncProvider(calendarEventSyncProvider);
  const app = buildServer();

  await connectDatabase();
  try {
    await cleanupTestData();

    const requestFromBotId = await createPendingRequestViaBot(runtime, "Stage10 bot -> webapp approve");

    const adminToken = await authToken(app, {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramId: ADMIN_TELEGRAM_ID,
      username: `${MARKER}_admin`,
      firstName: "Stage10",
      lastName: "Admin"
    });

    const approveByWebApp = await app.inject({
      method: "POST",
      url: `/api/webapp/admin/requests/${requestFromBotId}/approve`,
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    assert.equal(approveByWebApp.statusCode, 200);

    const approvedFromBot = await prisma.meetingRequest.findUnique({
      where: { id: requestFromBotId },
      include: { calendarEvent: true }
    });
    assert.ok(approvedFromBot);
    assert.equal(approvedFromBot.status, MeetingRequestStatus.APPROVED);
    assert.ok(approvedFromBot.calendarEvent);

    await runtime.bot.handleUpdate(
      createCallbackUpdate(userA, Number(USER_A_TELEGRAM_ID), `request:cancel:${requestFromBotId}`) as never
    );

    const cancelledFromBot = await prisma.meetingRequest.findUnique({ where: { id: requestFromBotId } });
    assert.ok(cancelledFromBot);
    assert.equal(cancelledFromBot.status, MeetingRequestStatus.CANCELLED);

    const userToken = await authToken(app, {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramId: USER_B_TELEGRAM_ID,
      username: `${MARKER}_user_b`,
      firstName: "Stage10",
      lastName: "UserB"
    });

    const slotsResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/slots?duration=30",
      headers: {
        authorization: `Bearer ${userToken}`
      }
    });
    assert.equal(slotsResponse.statusCode, 200);
    const slotsPayload = slotsResponse.json() as {
      ok: boolean;
      slots: Array<{ start_at: string; end_at: string }>;
    };
    assert.equal(slotsPayload.ok, true);
    assert.ok(slotsPayload.slots.length >= 2);

    const createByWebApp = await app.inject({
      method: "POST",
      url: "/api/webapp/requests",
      headers: {
        authorization: `Bearer ${userToken}`
      },
      payload: {
        duration_minutes: 30,
        format: MeetingFormat.ONLINE,
        start_at: slotsPayload.slots[0].start_at,
        end_at: slotsPayload.slots[0].end_at,
        topic: "Stage10 webapp -> bot approve",
        description: "cross-channel verify",
        email: "stage10-webapp@example.com",
        first_name: "Stage10",
        last_name: "UserB",
        location: null
      }
    });
    assert.equal(createByWebApp.statusCode, 201);
    const createByWebAppPayload = createByWebApp.json() as { ok: boolean; request: { id: string } };
    assert.equal(createByWebAppPayload.ok, true);
    const requestFromWebAppId = createByWebAppPayload.request.id;

    await runtime.bot.handleUpdate(
      createCallbackUpdate(
        adminUser,
        Number(ADMIN_TELEGRAM_ID),
        `approval:confirm:${requestFromWebAppId}`
      ) as never
    );

    const approvedFromWebApp = await prisma.meetingRequest.findUnique({ where: { id: requestFromWebAppId } });
    assert.ok(approvedFromWebApp);
    assert.equal(approvedFromWebApp.status, MeetingRequestStatus.APPROVED);

    const rescheduleByAdminWebApp = await app.inject({
      method: "POST",
      url: `/api/webapp/admin/requests/${requestFromWebAppId}/reschedule`,
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        start_at: slotsPayload.slots[1].start_at,
        end_at: slotsPayload.slots[1].end_at
      }
    });
    assert.equal(rescheduleByAdminWebApp.statusCode, 200);

    const rescheduled = await prisma.meetingRequest.findUnique({ where: { id: requestFromWebAppId } });
    assert.ok(rescheduled);
    assert.equal(rescheduled.status, MeetingRequestStatus.RESCHEDULED);
    assert.equal(rescheduled.startAt.toISOString(), slotsPayload.slots[1].start_at);

    // eslint-disable-next-line no-console
    console.log("stage10 verify ok");
  } finally {
    setWebAppCalendarSyncProvider(undefined);
    await app.close();
    await disconnectDatabase();
  }
}

void main();
