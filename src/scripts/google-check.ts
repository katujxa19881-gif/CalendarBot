import { google } from "googleapis";
import { getGoogleCalendarConfig } from "../env";

async function run(): Promise<void> {
  const cfg = getGoogleCalendarConfig();

  if (!cfg.enabled || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    console.error("Google config is incomplete. Fill GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN.");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  oauth2.setCredentials({ refresh_token: cfg.refreshToken });

  const accessToken = await oauth2.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;

  if (!token) {
    throw new Error("No access token returned from refresh token");
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2 });
  const now = new Date();
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: in24h.toISOString(),
      timeZone: "Europe/Moscow",
      items: [{ id: cfg.calendarId }]
    }
  });

  const calendars = fb.data.calendars ?? {};
  const target = calendars[cfg.calendarId] ?? calendars.primary;
  const busyCount = Array.isArray(target?.busy) ? target.busy.length : 0;

  console.log(
    JSON.stringify(
      {
        ok: true,
        calendarId: cfg.calendarId,
        busyIntervalsNext24h: busyCount
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: message
      },
      null,
      2
    )
  );
  process.exit(1);
});
