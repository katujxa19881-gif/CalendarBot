import { JournalActorRole, MeetingRequestStatus, User } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { getMeetingSettings } from "../domain/app-settings";
import { MeetingRequestStatusTransitionError } from "../domain/meeting-request-status";
import { getMiniAppConfig } from "../env";
import { logEvent } from "../logger";
import { ensureWizardStateForUser } from "../telegram/bot";
import { buildAvailableSlots, ensureSlotStillAvailable, isSupportedDuration } from "../application/slots";
import { getGoogleOAuthStatus } from "../integrations/google-calendar";
import {
  authenticateMiniApp,
  authenticateMiniAppBrowserDev,
  MiniAppAuthError,
  verifyMiniAppSessionToken
} from "./auth";
import {
  approveMeetingRequestByAdmin,
  cancelMeetingRequest,
  listAdminRequests,
  patchMeetingSettingsByAdmin,
  rejectMeetingRequestByAdmin,
  rescheduleMeetingRequest,
  submitMeetingRequestFromWebApp,
  WebAppOperationError
} from "./operations";
import { renderMiniAppHtml } from "./ui";

type SessionContext = {
  user: User;
  role: "user" | "admin";
};

const authBodySchema = z.object({
  initData: z.string().min(1)
});
const browserAuthBodySchema = z
  .object({
    telegram_id: z.string().trim().min(1).optional(),
    username: z.string().trim().min(1).optional(),
    first_name: z.string().trim().min(1).optional(),
    last_name: z.string().trim().min(1).optional()
  })
  .strict();
const durationQuerySchema = z.object({
  duration: z.coerce.number().int().positive(),
  exclude_request_id: z.string().min(1).optional()
});
const rescheduleBodySchema = z.object({
  start_at: z.string().datetime(),
  end_at: z.string().datetime()
});
const adminListQuerySchema = z.object({
  status: z.nativeEnum(MeetingRequestStatus).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const rejectBodySchema = z.object({
  comment: z.string().trim().max(1000).nullable().optional()
});
const actionCommentBodySchema = z.object({
  comment: z.string().trim().max(1000).nullable().optional()
});
const adminRescheduleBodySchema = z.object({
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  comment: z.string().trim().max(1000).nullable().optional()
});
const adminPinVerifyBodySchema = z.object({
  pin: z.string().trim().min(1).max(64)
});
const patchSettingsBodySchema = z
  .object({
    workday_start_hour: z.number().int().optional(),
    workday_end_hour: z.number().int().optional(),
    workdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    slot_limit: z.number().int().optional(),
    slot_buffer_minutes: z.number().int().optional(),
    slot_min_lead_hours: z.number().int().optional(),
    slot_horizon_days: z.number().int().optional()
  })
  .strict();
const adminCleanupBodySchema = z
  .object({
    mode: z.enum(["selected", "closed"]),
    ids: z.array(z.string().min(1)).max(500).optional(),
    older_than_days: z.number().min(0).max(365).optional()
  })
  .strict();
const submitRequestBodySchema = z.object({
  duration_minutes: z.number().int().positive(),
  format: z.enum(["ONLINE", "OFFLINE"]),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  topic: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  email: z.string().trim().email(),
  first_name: z.string().trim().min(2).max(100),
  last_name: z.string().trim().min(2).max(100),
  location: z.string().trim().min(3).max(400).nullable().optional()
});

const ACTIVE_ACTION_STATUSES: MeetingRequestStatus[] = [
  MeetingRequestStatus.PENDING_APPROVAL,
  MeetingRequestStatus.APPROVED,
  MeetingRequestStatus.RESCHEDULE_REQUESTED,
  MeetingRequestStatus.RESCHEDULED
];
const CLOSED_ACTION_STATUSES: MeetingRequestStatus[] = [
  MeetingRequestStatus.REJECTED,
  MeetingRequestStatus.CANCELLED,
  MeetingRequestStatus.EXPIRED
];

function isRescheduleAllowed(status: MeetingRequestStatus): boolean {
  return status === MeetingRequestStatus.APPROVED || status === MeetingRequestStatus.RESCHEDULED;
}

function isCancelAllowed(status: MeetingRequestStatus): boolean {
  return ACTIVE_ACTION_STATUSES.includes(status);
}

function getBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return null;
  }
  const [type, token] = authHeader.split(" ");
  if (!type || !token || type.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

function replyAuthError(reply: FastifyReply, error: unknown): void {
  if (error instanceof MiniAppAuthError) {
    const statusCode =
      error.code === "INIT_DATA_INVALID" ||
      error.code === "INIT_DATA_HASH_INVALID" ||
      error.code === "INIT_DATA_EXPIRED" ||
      error.code === "SESSION_INVALID" ||
      error.code === "SESSION_EXPIRED"
        ? 401
        : error.code === "MINI_APP_DISABLED"
          ? 404
          : 500;
    reply.code(statusCode).send({
      ok: false,
      error: error.code
    });
    return;
  }

  reply.code(500).send({
    ok: false,
    error: "UNKNOWN_AUTH_ERROR"
  });
}

function replyOperationError(reply: FastifyReply, error: unknown): void {
  if (error instanceof WebAppOperationError) {
    logEvent({
      level: "error",
      operation: "webapp_operation_failed",
      status: "error",
      error_code: error.code,
      error_message: error.message
    });
    const statusCode =
      error.code === "REQUEST_NOT_FOUND"
        ? 404
        : error.code === "REQUEST_STATUS_INVALID" ||
            error.code === "SLOT_NOT_AVAILABLE" ||
            error.code === "CALENDAR_SYNC_FAILED"
          ? 409
        : error.code === "SETTINGS_PATCH_INVALID"
            ? 400
            : 500;
    reply.code(statusCode).send({
      ok: false,
      error: error.code
    });
    return;
  }

  if (error instanceof MeetingRequestStatusTransitionError) {
    logEvent({
      level: "error",
      operation: "webapp_operation_failed",
      status: "error",
      error_code: error.code,
      error_message: error.message
    });
    reply.code(409).send({
      ok: false,
      error: error.code === "REQUEST_NOT_FOUND" ? "REQUEST_NOT_FOUND" : "REQUEST_STATUS_INVALID"
    });
    return;
  }

  logEvent({
    level: "error",
    operation: "webapp_operation_failed",
    status: "error",
    error_code: "UNKNOWN_OPERATION_ERROR",
    error_message: error instanceof Error ? error.message : "Unknown webapp operation error"
  });
  reply.code(500).send({
    ok: false,
    error: "UNKNOWN_OPERATION_ERROR"
  });
}

async function resolveSession(request: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null> {
  const token = getBearerToken(request);
  if (!token) {
    reply.code(401).send({
      ok: false,
      error: "AUTH_TOKEN_MISSING"
    });
    return null;
  }

  try {
    return await verifyMiniAppSessionToken(token);
  } catch (error) {
    replyAuthError(reply, error);
    return null;
  }
}

async function requireAdminSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionContext | null> {
  const session = await resolveSession(request, reply);
  if (!session) {
    return null;
  }

  if (session.role !== "admin") {
    reply.code(403).send({
      ok: false,
      error: "ADMIN_ACCESS_DENIED"
    });
    return null;
  }

  return session;
}

async function requireAdminAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionContext | null> {
  const session = await requireAdminSession(request, reply);
  if (!session) {
    return null;
  }

  return session;
}

function parseDateOrNull(input: string | undefined): Date | null {
  if (!input) {
    return null;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isLocalBrowserHost(host: string | undefined): boolean {
  const cleanHost = (host ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
  return cleanHost === "localhost" || cleanHost === "127.0.0.1" || cleanHost === "::1" || cleanHost === "[::1]";
}

export async function registerMiniAppRoutes(app: FastifyInstance): Promise<void> {
  app.get("/miniapp/assets/home-photo.jpeg", async (_request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send("Mini app is disabled");
      return;
    }

    const srcPath = join(process.cwd(), "src", "webapp", "assets", "home-photo.jpeg");
    const distPath = join(process.cwd(), "dist", "webapp", "assets", "home-photo.jpeg");
    let image: Buffer;
    try {
      image = await readFile(srcPath);
    } catch {
      image = await readFile(distPath);
    }
    reply.header("content-type", "image/jpeg");
    reply.header("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.code(200).send(image);
  });

  app.get("/miniapp", async (_request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send("Mini app is disabled");
      return;
    }

    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("pragma", "no-cache");
    reply.header("expires", "0");
    reply.code(200).send(renderMiniAppHtml());
  });

  app.post("/api/webapp/auth", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const parsedBody = authBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "AUTH_PAYLOAD_INVALID"
      });
      return;
    }

    try {
      const session = await authenticateMiniApp(parsedBody.data.initData);

      logEvent({
        operation: "mini_app_auth_success",
        status: "ok",
        user_id: session.user.id,
        details: {
          channel: "webapp",
          role: session.role
        }
      });

      reply.code(200).send({
        ok: true,
        token: session.token,
        expires_at: session.expiresAt,
        role: session.role,
        user: {
          telegram_id: session.user.telegramId,
          username: session.user.username,
          first_name: session.user.firstName,
          last_name: session.user.lastName
        }
      });
    } catch (error) {
      logEvent({
        level: "warn",
        operation: "mini_app_auth_failed",
        status: "error",
        error_code: error instanceof MiniAppAuthError ? error.code : "UNKNOWN_AUTH_ERROR",
        error_message: error instanceof Error ? error.message : "Mini app auth failed",
        details: {
          channel: "webapp"
        }
      });
      replyAuthError(reply, error);
    }
  });

  app.post("/api/webapp/auth/dev", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    if (!miniAppConfig.browserAuthEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_BROWSER_AUTH_DISABLED" });
      return;
    }

    if (!isLocalBrowserHost(request.hostname)) {
      reply.code(403).send({ ok: false, error: "MINI_APP_BROWSER_AUTH_FORBIDDEN" });
      return;
    }

    const parsedBody = browserAuthBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "AUTH_PAYLOAD_INVALID"
      });
      return;
    }

    try {
      const session = await authenticateMiniAppBrowserDev({
        telegramId: parsedBody.data.telegram_id,
        username: parsedBody.data.username,
        firstName: parsedBody.data.first_name,
        lastName: parsedBody.data.last_name
      });

      logEvent({
        operation: "mini_app_auth_success",
        status: "ok",
        user_id: session.user.id,
        details: {
          channel: "webapp",
          role: session.role,
          mode: "browser_dev"
        }
      });

      reply.code(200).send({
        ok: true,
        token: session.token,
        expires_at: session.expiresAt,
        role: session.role,
        user: {
          telegram_id: session.user.telegramId,
          username: session.user.username,
          first_name: session.user.firstName,
          last_name: session.user.lastName
        }
      });
    } catch (error) {
      logEvent({
        level: "warn",
        operation: "mini_app_auth_failed",
        status: "error",
        error_code: error instanceof MiniAppAuthError ? error.code : "UNKNOWN_AUTH_ERROR",
        error_message: error instanceof Error ? error.message : "Mini app dev auth failed",
        details: {
          channel: "webapp",
          mode: "browser_dev"
        }
      });
      replyAuthError(reply, error);
    }
  });

  app.get("/api/webapp/bootstrap", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const wizardState = await ensureWizardStateForUser(session.user.telegramId);

    reply.code(200).send({
      ok: true,
      role: session.role,
      onboarding_enabled: miniAppConfig.onboardingEnabled,
      user: {
        telegram_id: session.user.telegramId,
        username: session.user.username,
        first_name: session.user.firstName,
        last_name: session.user.lastName,
        personal_data_consent_given: session.user.personalDataConsentGiven
      },
      draft: wizardState.draft
        ? {
            id: wizardState.draft.id,
            current_step: wizardState.draft.currentStep,
            expires_at: wizardState.draft.expiresAt.toISOString()
          }
        : null,
      my_requests: wizardState.requests.map((requestItem) => ({
        id: requestItem.id,
        status: requestItem.status,
        topic: requestItem.topic,
        format: requestItem.format,
        duration_minutes: requestItem.durationMinutes,
        start_at: requestItem.startAt.toISOString(),
        end_at: requestItem.endAt.toISOString(),
        can_cancel: isCancelAllowed(requestItem.status),
        can_reschedule: isRescheduleAllowed(requestItem.status)
      }))
    });
  });

  app.get("/api/webapp/slots", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const parsedQuery = durationQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      reply.code(400).send({
        ok: false,
        error: "SLOTS_QUERY_INVALID"
      });
      return;
    }

    if (!isSupportedDuration(parsedQuery.data.duration)) {
      reply.code(400).send({
        ok: false,
        error: "UNSUPPORTED_DURATION"
      });
      return;
    }

    const slots = await buildAvailableSlots({
      durationMinutes: parsedQuery.data.duration,
      excludeMeetingRequestId: parsedQuery.data.exclude_request_id,
      channel: "webapp",
      limitOverride: 180
    });

    reply.code(200).send({
      ok: true,
      slots: slots.map((slot) => ({
        start_at: slot.startAt.toISOString(),
        end_at: slot.endAt.toISOString(),
        label: slot.label
      }))
    });
  });

  app.post("/api/webapp/requests/:id/cancel", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    const targetRequest = await prisma.meetingRequest.findUnique({
      where: {
        id: requestId
      },
      select: {
        id: true,
        userId: true
      }
    });

    if (!targetRequest) {
      reply.code(404).send({ ok: false, error: "REQUEST_NOT_FOUND" });
      return;
    }

    if (targetRequest.userId !== session.user.id) {
      reply.code(403).send({ ok: false, error: "REQUEST_ACCESS_DENIED" });
      return;
    }

    try {
      const updatedRequest = await cancelMeetingRequest({
        meetingRequestId: requestId,
        actorTelegramId: session.user.telegramId,
        actorRole: JournalActorRole.USER
      });

      logEvent({
        operation: "cancellation_completed",
        status: "ok",
        user_id: session.user.id,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.CANCELLED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.post("/api/webapp/requests", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = submitRequestBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "REQUEST_PAYLOAD_INVALID"
      });
      return;
    }

    if (!isSupportedDuration(parsedBody.data.duration_minutes)) {
      reply.code(400).send({
        ok: false,
        error: "UNSUPPORTED_DURATION"
      });
      return;
    }

    if (parsedBody.data.format === "OFFLINE" && !parsedBody.data.location) {
      reply.code(400).send({
        ok: false,
        error: "OFFLINE_LOCATION_REQUIRED"
      });
      return;
    }

    const startAt = new Date(parsedBody.data.start_at);
    const endAt = new Date(parsedBody.data.end_at);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || startAt >= endAt) {
      reply.code(400).send({
        ok: false,
        error: "REQUEST_TIME_INVALID"
      });
      return;
    }

    try {
      const meetingRequest = await submitMeetingRequestFromWebApp({
        userId: session.user.id,
        userTelegramId: session.user.telegramId,
        durationMinutes: parsedBody.data.duration_minutes,
        format: parsedBody.data.format,
        startAt,
        endAt,
        topic: parsedBody.data.topic,
        description: parsedBody.data.description ?? null,
        email: parsedBody.data.email,
        firstName: parsedBody.data.first_name,
        lastName: parsedBody.data.last_name,
        location: parsedBody.data.location ?? null
      });

      reply.code(201).send({
        ok: true,
        request: {
          id: meetingRequest.id,
          status: meetingRequest.status,
          start_at: meetingRequest.startAt.toISOString(),
          end_at: meetingRequest.endAt.toISOString()
        }
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.get("/api/webapp/requests/my", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const requests = await prisma.meetingRequest.findMany({
      where: {
        userId: session.user.id
      },
      include: {
        calendarEvent: {
          select: {
            googleMeetLink: true
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 20
    });

    reply.code(200).send({
      ok: true,
      requests: requests.map((requestItem) => ({
        id: requestItem.id,
        status: requestItem.status,
        topic: requestItem.topic,
        format: requestItem.format,
        duration_minutes: requestItem.durationMinutes,
        start_at: requestItem.startAt.toISOString(),
        end_at: requestItem.endAt.toISOString(),
        created_at: requestItem.createdAt.toISOString(),
        google_meet_link: requestItem.calendarEvent?.googleMeetLink ?? null,
        can_cancel: isCancelAllowed(requestItem.status),
        can_reschedule: isRescheduleAllowed(requestItem.status)
      }))
    });
  });

  app.get("/api/webapp/requests/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    const targetRequest = await prisma.meetingRequest.findUnique({
      where: {
        id: requestId
      },
      include: {
        calendarEvent: {
          select: {
            googleMeetLink: true
          }
        }
      }
    });

    if (!targetRequest) {
      reply.code(404).send({
        ok: false,
        error: "REQUEST_NOT_FOUND"
      });
      return;
    }

    if (targetRequest.userId !== session.user.id && session.role !== "admin") {
      reply.code(403).send({
        ok: false,
        error: "REQUEST_ACCESS_DENIED"
      });
      return;
    }

    reply.code(200).send({
      ok: true,
      request: {
        id: targetRequest.id,
        status: targetRequest.status,
        topic: targetRequest.topic,
        format: targetRequest.format,
        duration_minutes: targetRequest.durationMinutes,
        description: targetRequest.description,
        location: targetRequest.location,
        email: targetRequest.email,
        first_name: targetRequest.firstName,
        last_name: targetRequest.lastName,
        approver_comment: targetRequest.approverComment,
        start_at: targetRequest.startAt.toISOString(),
        end_at: targetRequest.endAt.toISOString(),
        created_at: targetRequest.createdAt.toISOString(),
        google_meet_link: targetRequest.calendarEvent?.googleMeetLink ?? null,
        can_cancel: isCancelAllowed(targetRequest.status),
        can_reschedule: isRescheduleAllowed(targetRequest.status)
      }
    });
  });

  app.post("/api/webapp/requests/:id/reschedule", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await resolveSession(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = rescheduleBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "RESCHEDULE_PAYLOAD_INVALID"
      });
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    const targetRequest = await prisma.meetingRequest.findUnique({
      where: {
        id: requestId
      },
      select: {
        id: true,
        userId: true
      }
    });

    if (!targetRequest) {
      reply.code(404).send({ ok: false, error: "REQUEST_NOT_FOUND" });
      return;
    }

    if (targetRequest.userId !== session.user.id) {
      reply.code(403).send({ ok: false, error: "REQUEST_ACCESS_DENIED" });
      return;
    }

    const newStartAt = new Date(parsedBody.data.start_at);
    const newEndAt = new Date(parsedBody.data.end_at);

    if (Number.isNaN(newStartAt.getTime()) || Number.isNaN(newEndAt.getTime()) || newStartAt >= newEndAt) {
      reply.code(400).send({
        ok: false,
        error: "RESCHEDULE_TIME_INVALID"
      });
      return;
    }

    const stillAvailable = await ensureSlotStillAvailable({
      startAt: newStartAt,
      endAt: newEndAt,
      excludeMeetingRequestId: requestId
    });
    if (!stillAvailable) {
      reply.code(409).send({
        ok: false,
        error: "SLOT_NOT_AVAILABLE"
      });
      return;
    }

    try {
      const updatedRequest = await rescheduleMeetingRequest({
        meetingRequestId: requestId,
        actorTelegramId: session.user.telegramId,
        actorRole: JournalActorRole.USER,
        newStartAt,
        newEndAt
      });

      logEvent({
        operation: "reschedule_completed",
        status: "ok",
        user_id: session.user.id,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.RESCHEDULED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.get("/api/webapp/admin/requests", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_ADMIN_DISABLED" });
      return;
    }

    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedQuery = adminListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      reply.code(400).send({
        ok: false,
        error: "ADMIN_LIST_QUERY_INVALID"
      });
      return;
    }

    const createdFrom = parseDateOrNull(parsedQuery.data.from);
    const createdTo = parseDateOrNull(parsedQuery.data.to);

    const requests = await listAdminRequests({
      status: parsedQuery.data.status,
      createdFrom: createdFrom ?? undefined,
      createdTo: createdTo ?? undefined,
      limit: parsedQuery.data.limit ?? 30
    });

    reply.code(200).send({
      ok: true,
      requests: requests.map((item) => ({
        id: item.id,
        status: item.status,
        topic: item.topic,
        format: item.format,
        duration_minutes: item.durationMinutes,
        start_at: item.startAt.toISOString(),
        end_at: item.endAt.toISOString(),
        created_at: item.createdAt.toISOString(),
        google_meet_link: item.calendarEvent?.googleMeetLink ?? null,
        email: item.email,
        first_name: item.firstName,
        last_name: item.lastName,
        user: {
          telegram_id: item.user.telegramId,
          username: item.user.username
        },
        can_cancel: isCancelAllowed(item.status),
        can_reschedule: isRescheduleAllowed(item.status)
      }))
    });
  });

  app.post("/api/webapp/admin/requests/:id/approve", async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = actionCommentBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "APPROVE_PAYLOAD_INVALID"
      });
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    try {
      const updatedRequest = await approveMeetingRequestByAdmin({
        meetingRequestId: requestId,
        adminTelegramId: session.user.telegramId,
        comment: parsedBody.data.comment ?? null
      });

      logEvent({
        operation: "approval_confirmed",
        status: "ok",
        user_id: updatedRequest.userId,
        actor_id: session.user.telegramId,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.APPROVED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.post("/api/webapp/admin/requests/:id/reject", async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = rejectBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "REJECT_PAYLOAD_INVALID"
      });
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    const comment = parsedBody.data.comment ?? null;

    try {
      const updatedRequest = await rejectMeetingRequestByAdmin({
        meetingRequestId: requestId,
        adminTelegramId: session.user.telegramId,
        comment
      });

      logEvent({
        operation: "approval_rejected",
        status: "ok",
        user_id: updatedRequest.userId,
        actor_id: session.user.telegramId,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.REJECTED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.post("/api/webapp/admin/requests/:id/cancel", async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = actionCommentBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "CANCEL_PAYLOAD_INVALID"
      });
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    try {
      const updatedRequest = await cancelMeetingRequest({
        meetingRequestId: requestId,
        actorTelegramId: session.user.telegramId,
        actorRole: JournalActorRole.ADMIN,
        comment: parsedBody.data.comment ?? null
      });

      logEvent({
        operation: "cancellation_completed",
        status: "ok",
        user_id: updatedRequest.userId,
        actor_id: session.user.telegramId,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.CANCELLED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.post("/api/webapp/admin/requests/:id/reschedule", async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = adminRescheduleBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "RESCHEDULE_PAYLOAD_INVALID"
      });
      return;
    }

    const requestId = String((request.params as { id?: string }).id ?? "");
    const newStartAt = new Date(parsedBody.data.start_at);
    const newEndAt = new Date(parsedBody.data.end_at);
    if (Number.isNaN(newStartAt.getTime()) || Number.isNaN(newEndAt.getTime()) || newStartAt >= newEndAt) {
      reply.code(400).send({
        ok: false,
        error: "RESCHEDULE_TIME_INVALID"
      });
      return;
    }

    try {
      const updatedRequest = await rescheduleMeetingRequest({
        meetingRequestId: requestId,
        actorTelegramId: session.user.telegramId,
        actorRole: JournalActorRole.ADMIN,
        newStartAt,
        newEndAt,
        comment: parsedBody.data.comment ?? null
      });

      logEvent({
        operation: "reschedule_completed",
        status: "ok",
        user_id: updatedRequest.userId,
        actor_id: session.user.telegramId,
        entity_id: updatedRequest.id,
        details: {
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        request_id: updatedRequest.id,
        status: MeetingRequestStatus.RESCHEDULED
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.get("/api/webapp/admin/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_ADMIN_DISABLED" });
      return;
    }

    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const settings = await getMeetingSettings();
    reply.code(200).send({
      ok: true,
      settings: {
        workday_start_hour: settings.workdayStartHour,
        workday_end_hour: settings.workdayEndHour,
        workdays: settings.workdays,
        slot_limit: settings.slotLimit,
        slot_buffer_minutes: settings.slotBufferMinutes,
        slot_min_lead_hours: settings.slotMinLeadHours,
        slot_horizon_days: settings.slotHorizonDays
      }
    });
  });

  app.patch("/api/webapp/admin/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_ADMIN_DISABLED" });
      return;
    }

    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = patchSettingsBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "SETTINGS_PATCH_INVALID"
      });
      return;
    }

    try {
      const updated = await patchMeetingSettingsByAdmin({
        adminTelegramId: session.user.telegramId,
        patch: {
          workdayStartHour: parsedBody.data.workday_start_hour,
          workdayEndHour: parsedBody.data.workday_end_hour,
          workdays: parsedBody.data.workdays,
          slotLimit: parsedBody.data.slot_limit,
          slotBufferMinutes: parsedBody.data.slot_buffer_minutes,
          slotMinLeadHours: parsedBody.data.slot_min_lead_hours,
          slotHorizonDays: parsedBody.data.slot_horizon_days
        }
      });

      reply.code(200).send({
        ok: true,
        settings: {
          workday_start_hour: updated.workdayStartHour,
          workday_end_hour: updated.workdayEndHour,
          workdays: updated.workdays,
          slot_limit: updated.slotLimit,
          slot_buffer_minutes: updated.slotBufferMinutes,
          slot_min_lead_hours: updated.slotMinLeadHours,
          slot_horizon_days: updated.slotHorizonDays
        }
      });
    } catch (error) {
      replyOperationError(reply, error);
    }
  });

  app.get("/api/webapp/admin/google/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_ADMIN_DISABLED" });
      return;
    }

    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const status = await getGoogleOAuthStatus();
    reply.code(200).send({
      ok: true,
      status: {
        connected: status.connected,
        calendar_id: status.calendarId,
        error_code: status.errorCode,
        error_message: status.errorMessage
      }
    });
  });

  app.post("/api/webapp/admin/requests/cleanup", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_ADMIN_DISABLED" });
      return;
    }

    const session = await requireAdminAccess(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = adminCleanupBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "CLEANUP_PAYLOAD_INVALID"
      });
      return;
    }

    const payload = parsedBody.data;

    if (payload.mode === "selected") {
      const ids = [...new Set(payload.ids ?? [])];
      if (!ids.length) {
        reply.code(400).send({ ok: false, error: "CLEANUP_IDS_REQUIRED" });
        return;
      }

      const deletable = await prisma.meetingRequest.findMany({
        where: {
          id: { in: ids },
          status: { in: CLOSED_ACTION_STATUSES }
        },
        select: { id: true }
      });
      const deletableIds = deletable.map((item) => item.id);

      const deleted = deletableIds.length
        ? await prisma.meetingRequest.deleteMany({
            where: { id: { in: deletableIds } }
          })
        : { count: 0 };

      logEvent({
        operation: "admin_cleanup_completed",
        status: "ok",
        actor_id: session.user.telegramId,
        details: {
          mode: "selected",
          requested_count: ids.length,
          deleted_count: deleted.count,
          channel: "webapp"
        }
      });

      reply.code(200).send({
        ok: true,
        mode: "selected",
        requested_count: ids.length,
        deleted_count: deleted.count
      });
      return;
    }

    const olderThanDays = payload.older_than_days ?? 7;
    const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const deleted = await prisma.meetingRequest.deleteMany({
      where: {
        status: { in: CLOSED_ACTION_STATUSES },
        endAt: { lt: threshold }
      }
    });

    logEvent({
      operation: "admin_cleanup_completed",
      status: "ok",
      actor_id: session.user.telegramId,
      details: {
        mode: "closed",
        older_than_days: olderThanDays,
        deleted_count: deleted.count,
        channel: "webapp"
      }
    });

    reply.code(200).send({
      ok: true,
      mode: "closed",
      older_than_days: olderThanDays,
      deleted_count: deleted.count
    });
  });

  app.post("/api/webapp/admin/pin/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    const miniAppConfig = getMiniAppConfig();
    if (!miniAppConfig.enabled || !miniAppConfig.adminEnabled) {
      reply.code(404).send({ ok: false, error: "MINI_APP_DISABLED" });
      return;
    }

    const session = await requireAdminSession(request, reply);
    if (!session) {
      return;
    }

    const parsedBody = adminPinVerifyBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        ok: false,
        error: "ADMIN_PIN_PAYLOAD_INVALID"
      });
      return;
    }

    if (!miniAppConfig.adminPin || parsedBody.data.pin === miniAppConfig.adminPin) {
      reply.code(200).send({ ok: true });
      return;
    }

    reply.code(403).send({
      ok: false,
      error: "ADMIN_PIN_INVALID"
    });
  });
}
