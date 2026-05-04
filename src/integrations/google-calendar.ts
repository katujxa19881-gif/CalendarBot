import { MeetingFormat } from "@prisma/client";
import { google } from "googleapis";
import { getGoogleCalendarConfig } from "../env";
import { logEvent } from "../logger";

export type BusyInterval = {
  startAt: Date;
  endAt: Date;
};

export type AvailabilityRange = {
  timeMin: Date;
  timeMax: Date;
};

export type CalendarAvailabilityProvider = {
  getBusyIntervals(range: AvailabilityRange): Promise<BusyInterval[]>;
};

export type CalendarEventCreateInput = {
  externalRequestId: string;
  topic: string;
  description: string | null;
  format: MeetingFormat;
  location: string | null;
  startAt: Date;
  endAt: Date;
  attendeeEmail: string;
  attendeeFirstName: string | null;
  attendeeLastName: string | null;
};

export type CalendarEventCreateResult = {
  googleCalendarEventId: string;
  googleCalendarId: string;
  googleMeetLink: string | null;
};

export type CalendarEventUpdateInput = CalendarEventCreateInput & {
  googleCalendarEventId: string;
};

export type CalendarEventCancelInput = {
  externalRequestId: string;
  googleCalendarEventId: string;
};

export type CalendarEventSyncProvider = {
  createEvent(input: CalendarEventCreateInput): Promise<CalendarEventCreateResult>;
  updateEvent(input: CalendarEventUpdateInput): Promise<CalendarEventCreateResult>;
  cancelEvent(input: CalendarEventCancelInput): Promise<void>;
};

type GoogleCalendarContext = {
  calendarId: string;
  calendar: ReturnType<typeof google.calendar>;
  ensureOAuthConnected: () => Promise<void>;
};

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Google Calendar error";
}

function parseBusyIntervals(input: unknown): BusyInterval[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: BusyInterval[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item == null) {
      continue;
    }

    const busy = item as { start?: unknown; end?: unknown };
    if (typeof busy.start !== "string" || typeof busy.end !== "string") {
      continue;
    }

    const startAt = new Date(busy.start);
    const endAt = new Date(busy.end);

    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || startAt >= endAt) {
      continue;
    }

    result.push({ startAt, endAt });
  }

  return result;
}

function createGoogleCalendarContext(): GoogleCalendarContext | null {
  const config = getGoogleCalendarConfig();

  if (!config.enabled) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(config.clientId!, config.clientSecret!);
  oauth2Client.setCredentials({ refresh_token: config.refreshToken! });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  let oauthConnectedLogged = false;

  const ensureOAuthConnected = async (): Promise<void> => {
    if (oauthConnectedLogged) {
      return;
    }

    const accessToken = await oauth2Client.getAccessToken();
    const token =
      typeof accessToken === "string"
        ? accessToken
        : typeof accessToken?.token === "string"
          ? accessToken.token
          : null;

    if (!token) {
      throw new Error("Google OAuth access token is missing");
    }

    oauthConnectedLogged = true;

    logEvent({
      operation: "google_oauth_connected",
      status: "ok",
      details: {
        calendar_id: config.calendarId
      }
    });
  };

  return {
    calendarId: config.calendarId,
    calendar,
    ensureOAuthConnected
  };
}

export function createGoogleCalendarAvailabilityProvider(): CalendarAvailabilityProvider | null {
  const context = createGoogleCalendarContext();

  if (!context) {
    return null;
  }

  return {
    async getBusyIntervals(range: AvailabilityRange): Promise<BusyInterval[]> {
      logEvent({
        operation: "calendar_availability_requested",
        status: "ok",
        details: {
          calendar_id: context.calendarId,
          time_min: range.timeMin.toISOString(),
          time_max: range.timeMax.toISOString()
        }
      });

      try {
        await context.ensureOAuthConnected();

        const response = await context.calendar.freebusy.query({
          requestBody: {
            timeMin: range.timeMin.toISOString(),
            timeMax: range.timeMax.toISOString(),
            timeZone: "Europe/Moscow",
            items: [{ id: context.calendarId }]
          }
        });

        const calendars = response.data.calendars ?? {};
        const targetCalendar = calendars[context.calendarId] ?? calendars.primary;
        const busyIntervals = parseBusyIntervals(targetCalendar?.busy);

        logEvent({
          operation: "calendar_availability_received",
          status: "ok",
          details: {
            calendar_id: context.calendarId,
            busy_count: busyIntervals.length,
            time_min: range.timeMin.toISOString(),
            time_max: range.timeMax.toISOString()
          }
        });

        return busyIntervals;
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);

        logEvent({
          level: "error",
          operation: "integration_error",
          status: "error",
          error_code: "GOOGLE_CALENDAR_AVAILABILITY_FAILED",
          error_message: errorMessage,
          details: {
            calendar_id: context.calendarId,
            time_min: range.timeMin.toISOString(),
            time_max: range.timeMax.toISOString()
          }
        });

        throw error instanceof Error ? error : new Error(errorMessage);
      }
    }
  };
}

export function createGoogleCalendarEventSyncProvider(): CalendarEventSyncProvider | null {
  const context = createGoogleCalendarContext();

  if (!context) {
    return null;
  }

  return {
    async createEvent(input: CalendarEventCreateInput): Promise<CalendarEventCreateResult> {
      try {
        await context.ensureOAuthConnected();

        const attendeeName = [input.attendeeFirstName, input.attendeeLastName]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join(" ");

        const response = await context.calendar.events.insert({
          calendarId: context.calendarId,
          conferenceDataVersion: 0,
          sendUpdates: "all",
          requestBody: {
            summary: input.topic,
            description: input.description ?? undefined,
            location: input.format === "OFFLINE" ? input.location ?? undefined : undefined,
            start: {
              dateTime: input.startAt.toISOString(),
              timeZone: "Europe/Moscow"
            },
            end: {
              dateTime: input.endAt.toISOString(),
              timeZone: "Europe/Moscow"
            },
            attendees: [
              {
                email: input.attendeeEmail,
                displayName: attendeeName || undefined
              }
            ]
          }
        });

        const eventId = response.data.id;

        if (!eventId) {
          throw new Error("Google Calendar event id is missing");
        }

        return {
          googleCalendarEventId: eventId,
          googleCalendarId: context.calendarId,
          googleMeetLink: null
        };
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);

        logEvent({
          level: "error",
          operation: "integration_error",
          status: "error",
          error_code: "GOOGLE_CALENDAR_EVENT_CREATE_FAILED",
          error_message: errorMessage,
          details: {
            calendar_id: context.calendarId,
            request_id: input.externalRequestId,
            start_at: input.startAt.toISOString(),
            end_at: input.endAt.toISOString()
          }
        });

        throw error instanceof Error ? error : new Error(errorMessage);
      }
    },

    async updateEvent(input: CalendarEventUpdateInput): Promise<CalendarEventCreateResult> {
      try {
        await context.ensureOAuthConnected();

        const attendeeName = [input.attendeeFirstName, input.attendeeLastName]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join(" ");

        const response = await context.calendar.events.patch({
          calendarId: context.calendarId,
          eventId: input.googleCalendarEventId,
          conferenceDataVersion: 0,
          sendUpdates: "all",
          requestBody: {
            summary: input.topic,
            description: input.description ?? undefined,
            location: input.format === "OFFLINE" ? input.location ?? undefined : undefined,
            start: {
              dateTime: input.startAt.toISOString(),
              timeZone: "Europe/Moscow"
            },
            end: {
              dateTime: input.endAt.toISOString(),
              timeZone: "Europe/Moscow"
            },
            attendees: [
              {
                email: input.attendeeEmail,
                displayName: attendeeName || undefined
              }
            ]
          }
        });

        const eventId = response.data.id;
        if (!eventId) {
          throw new Error("Google Calendar event id is missing after update");
        }

        return {
          googleCalendarEventId: eventId,
          googleCalendarId: context.calendarId,
          googleMeetLink: null
        };
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);

        logEvent({
          level: "error",
          operation: "integration_error",
          status: "error",
          error_code: "GOOGLE_CALENDAR_EVENT_UPDATE_FAILED",
          error_message: errorMessage,
          details: {
            calendar_id: context.calendarId,
            request_id: input.externalRequestId,
            event_id: input.googleCalendarEventId,
            start_at: input.startAt.toISOString(),
            end_at: input.endAt.toISOString()
          }
        });

        throw error instanceof Error ? error : new Error(errorMessage);
      }
    },

    async cancelEvent(input: CalendarEventCancelInput): Promise<void> {
      try {
        await context.ensureOAuthConnected();

        await context.calendar.events.delete({
          calendarId: context.calendarId,
          eventId: input.googleCalendarEventId,
          sendUpdates: "all"
        });
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);

        logEvent({
          level: "error",
          operation: "integration_error",
          status: "error",
          error_code: "GOOGLE_CALENDAR_EVENT_CANCEL_FAILED",
          error_message: errorMessage,
          details: {
            calendar_id: context.calendarId,
            request_id: input.externalRequestId,
            event_id: input.googleCalendarEventId
          }
        });

        throw error instanceof Error ? error : new Error(errorMessage);
      }
    }
  };
}
