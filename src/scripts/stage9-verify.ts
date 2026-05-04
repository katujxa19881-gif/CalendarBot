import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { buildServer } from "../server";

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

async function main(): Promise<void> {
  process.env.MINI_APP_ENABLED = "true";
  process.env.MINI_APP_ADMIN_ENABLED = "true";
  process.env.MINI_APP_ONBOARDING_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "123456:stage9-test-token";
  process.env.MINI_APP_SESSION_SECRET = process.env.MINI_APP_SESSION_SECRET ?? "stage9-test-session-secret";
  process.env.ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ?? "7001001";
  process.env.MINI_APP_ADMIN_PIN = process.env.MINI_APP_ADMIN_PIN ?? "1234";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.GOOGLE_REFRESH_TOKEN = "";

  const app = buildServer();
  try {
    const initData = buildInitData({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      user: {
        id: Number(process.env.ADMIN_TELEGRAM_ID),
        username: "stage9_admin",
        first_name: "Stage9",
        last_name: "Admin"
      }
    });

    const authResponse = await app.inject({
      method: "POST",
      url: "/api/webapp/auth",
      payload: {
        initData
      }
    });

    assert.equal(authResponse.statusCode, 200, `auth status ${authResponse.statusCode}`);
    const authPayload = authResponse.json() as {
      ok: boolean;
      token: string;
      role: string;
      user: { telegram_id: string };
    };
    assert.equal(authPayload.ok, true);
    assert.equal(authPayload.role, "admin");
    assert.equal(authPayload.user.telegram_id, process.env.ADMIN_TELEGRAM_ID);
    assert.equal(typeof authPayload.token, "string");
    assert.ok(authPayload.token.length > 20);

    const bootstrapResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/bootstrap",
      headers: {
        authorization: `Bearer ${authPayload.token}`
      }
    });

    assert.equal(bootstrapResponse.statusCode, 200, `bootstrap status ${bootstrapResponse.statusCode}`);
    const bootstrapPayload = bootstrapResponse.json() as {
      ok: boolean;
      role: string;
      onboarding_enabled: boolean;
      user: { telegram_id: string };
      my_requests: unknown[];
    };

    assert.equal(bootstrapPayload.ok, true);
    assert.equal(bootstrapPayload.role, "admin");
    assert.equal(bootstrapPayload.onboarding_enabled, true);
    assert.equal(bootstrapPayload.user.telegram_id, process.env.ADMIN_TELEGRAM_ID);
    assert.ok(Array.isArray(bootstrapPayload.my_requests));

    const slotsResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/slots?duration=30",
      headers: {
        authorization: `Bearer ${authPayload.token}`
      }
    });
    assert.equal(slotsResponse.statusCode, 200, `slots status ${slotsResponse.statusCode}`);
    const slotsPayload = slotsResponse.json() as {
      ok: boolean;
      slots: Array<{ start_at: string; end_at: string; label: string }>;
    };
    assert.equal(slotsPayload.ok, true);
    assert.ok(Array.isArray(slotsPayload.slots));
    assert.ok(slotsPayload.slots.length > 0);

    const selectedSlot = slotsPayload.slots[0];
    const createRequestResponse = await app.inject({
      method: "POST",
      url: "/api/webapp/requests",
      headers: {
        authorization: `Bearer ${authPayload.token}`
      },
      payload: {
        duration_minutes: 30,
        format: "ONLINE",
        start_at: selectedSlot.start_at,
        end_at: selectedSlot.end_at,
        topic: "Stage9 mini app request",
        description: "Created from verify",
        email: "stage9@example.com",
        first_name: "Stage9",
        last_name: "User",
        location: null
      }
    });
    assert.equal(createRequestResponse.statusCode, 201, `create request status ${createRequestResponse.statusCode}`);
    const createRequestPayload = createRequestResponse.json() as {
      ok: boolean;
      request: { id: string; status: string };
    };
    assert.equal(createRequestPayload.ok, true);
    assert.equal(createRequestPayload.request.status, "PENDING_APPROVAL");
    assert.equal(typeof createRequestPayload.request.id, "string");

    const myRequestsResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/requests/my",
      headers: {
        authorization: `Bearer ${authPayload.token}`
      }
    });
    assert.equal(myRequestsResponse.statusCode, 200, `my requests status ${myRequestsResponse.statusCode}`);
    const myRequestsPayload = myRequestsResponse.json() as {
      ok: boolean;
      requests: Array<{ id: string }>;
    };
    assert.equal(myRequestsPayload.ok, true);
    assert.ok(myRequestsPayload.requests.some((item) => item.id === createRequestPayload.request.id));

    const adminListResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/admin/requests?limit=5",
      headers: {
        authorization: `Bearer ${authPayload.token}`,
        "x-admin-pin": process.env.MINI_APP_ADMIN_PIN
      }
    });
    assert.equal(adminListResponse.statusCode, 200, `admin list status ${adminListResponse.statusCode}`);
    const adminListPayload = adminListResponse.json() as {
      ok: boolean;
      requests: unknown[];
    };
    assert.equal(adminListPayload.ok, true);
    assert.ok(Array.isArray(adminListPayload.requests));

    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/webapp/admin/settings",
      headers: {
        authorization: `Bearer ${authPayload.token}`,
        "x-admin-pin": process.env.MINI_APP_ADMIN_PIN
      }
    });
    assert.equal(settingsResponse.statusCode, 200, `admin settings status ${settingsResponse.statusCode}`);
    const settingsPayload = settingsResponse.json() as {
      ok: boolean;
      settings: { slot_limit: number };
    };
    assert.equal(settingsPayload.ok, true);
    assert.equal(typeof settingsPayload.settings.slot_limit, "number");

    // eslint-disable-next-line no-console
    console.log("stage9 verify ok");
  } finally {
    await app.close();
  }
}

void main();
