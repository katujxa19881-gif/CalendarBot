import {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
  DraftStatus,
  JournalActionType,
  JournalActorRole,
  MeetingRequestStatus
} from "@prisma/client";
import { prisma } from "../db";
import { getApprovalConfig, getBackgroundJobsConfig, getTelegramConfig } from "../env";
import { createEmailProvider, EmailProvider, OutgoingEmail } from "../integrations/email";
import { logEvent } from "../logger";

type AdminNotifier = {
  sendMessage(input: {
    chatId: string;
    text: string;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  }): Promise<void>;
};

type WorkerDependencies = {
  emailProvider: EmailProvider | null;
  adminNotifier: AdminNotifier | null;
  adminTelegramId: string | null;
};

type ProcessOptions = {
  limit?: number;
  deps?: Partial<WorkerDependencies>;
};

const RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 10;

let timer: NodeJS.Timeout | null = null;
let processing = false;

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

function buildDependencies(input?: Partial<WorkerDependencies>): WorkerDependencies {
  const telegramConfig = getTelegramConfig();
  const approvalConfig = getApprovalConfig();

  return {
    emailProvider: input?.emailProvider ?? createEmailProvider(),
    adminNotifier: input?.adminNotifier ?? createTelegramAdminNotifier(telegramConfig.botToken),
    adminTelegramId: input?.adminTelegramId ?? approvalConfig.adminTelegramId
  };
}

function createTelegramAdminNotifier(botToken: string | null): AdminNotifier | null {
  if (!botToken) {
    return null;
  }

  return {
    async sendMessage(input: {
      chatId: string;
      text: string;
      replyMarkup?: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    }): Promise<void> {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: input.text,
          reply_markup: input.replyMarkup
        })
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 1000);
        throw new Error(`Telegram notifier error: HTTP ${response.status}. ${body}`);
      }

      const json = (await response.json()) as { ok?: boolean; description?: string };
      if (!json.ok) {
        throw new Error(`Telegram notifier error: ${json.description ?? "unknown error"}`);
      }
    }
  };
}

function parseMeetingRequestId(job: BackgroundJob): string {
  const payload = job.payload as Record<string, unknown>;
  const meetingRequestId = payload.meetingRequestId;
  if (typeof meetingRequestId !== "string" || meetingRequestId.length === 0) {
    throw new Error(`Job payload is missing meetingRequestId for job ${job.id}`);
  }
  return meetingRequestId;
}

async function completeJob(jobId: string): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: BackgroundJobStatus.COMPLETED,
      lockedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null
    }
  });
}

async function retryOrFailJob(job: BackgroundJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Unknown background job error";
  const reachedMaxAttempts = job.attempts >= job.maxAttempts;

  if (reachedMaxAttempts) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: BackgroundJobStatus.FAILED,
        lockedAt: null,
        lastErrorCode: "BACKGROUND_JOB_FAILED",
        lastErrorMessage: message
      }
    });
    return;
  }

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      status: BackgroundJobStatus.PENDING,
      lockedAt: null,
      runAt: new Date(Date.now() + RETRY_DELAY_MS),
      lastErrorCode: "BACKGROUND_JOB_RETRY_SCHEDULED",
      lastErrorMessage: message
    }
  });

  logEvent({
    operation: "retry_scheduled",
    status: "ok",
    entity_id: job.meetingRequestId,
    details: {
      job_id: job.id,
      job_type: job.jobType,
      next_attempt_in_ms: RETRY_DELAY_MS,
      attempts: job.attempts,
      max_attempts: job.maxAttempts
    }
  });
}

async function claimNextPendingJob(now: Date): Promise<BackgroundJob | null> {
  const nextJob = await prisma.backgroundJob.findFirst({
    where: {
      status: BackgroundJobStatus.PENDING,
      runAt: {
        lte: now
      }
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }]
  });

  if (!nextJob) {
    return null;
  }

  const claim = await prisma.backgroundJob.updateMany({
    where: {
      id: nextJob.id,
      status: BackgroundJobStatus.PENDING
    },
    data: {
      status: BackgroundJobStatus.PROCESSING,
      lockedAt: now,
      attempts: {
        increment: 1
      }
    }
  });

  if (claim.count === 0) {
    return null;
  }

  const claimedJob = await prisma.backgroundJob.findUnique({ where: { id: nextJob.id } });
  return claimedJob;
}

async function appendEmailActionLog(input: {
  meetingRequestId: string;
  userId: string;
  actionType: JournalActionType;
  details: Record<string, unknown>;
  result: "ok" | "error";
}): Promise<void> {
  await prisma.actionLog.create({
    data: {
      meetingRequestId: input.meetingRequestId,
      userId: input.userId,
      actorRole: JournalActorRole.SYSTEM,
      actorId: "email_service",
      actionType: input.actionType,
      details: input.details as never,
      result: input.result
    }
  });
}

async function sendEmailThroughProvider(input: {
  deps: WorkerDependencies;
  email: OutgoingEmail;
  meetingRequestId: string;
  userId: string;
  template: string;
}): Promise<void> {
  if (!input.deps.emailProvider) {
    const errorMessage = "SendGrid provider is not configured";

    await appendEmailActionLog({
      meetingRequestId: input.meetingRequestId,
      userId: input.userId,
      actionType: JournalActionType.EMAIL_FAILED,
      details: {
        template: input.template,
        reason: errorMessage
      },
      result: "error"
    });

    logEvent({
      level: "error",
      operation: "email_failed",
      status: "error",
      user_id: input.userId,
      entity_id: input.meetingRequestId,
      error_code: "SENDGRID_NOT_CONFIGURED",
      error_message: errorMessage,
      details: {
        template: input.template
      }
    });

    throw new Error(errorMessage);
  }

  let sendResult: { providerMessageId: string | null };
  try {
    sendResult = await input.deps.emailProvider.send(input.email);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown SendGrid error";

    await appendEmailActionLog({
      meetingRequestId: input.meetingRequestId,
      userId: input.userId,
      actionType: JournalActionType.EMAIL_FAILED,
      details: {
        template: input.template,
        reason: errorMessage
      },
      result: "error"
    });

    logEvent({
      level: "error",
      operation: "email_failed",
      status: "error",
      user_id: input.userId,
      entity_id: input.meetingRequestId,
      error_code: "SENDGRID_SEND_FAILED",
      error_message: errorMessage,
      details: {
        template: input.template
      }
    });

    throw error;
  }

  await appendEmailActionLog({
    meetingRequestId: input.meetingRequestId,
    userId: input.userId,
    actionType: JournalActionType.EMAIL_SENT,
    details: {
      template: input.template,
      provider_message_id: sendResult.providerMessageId
    },
    result: "ok"
  });

  logEvent({
    operation: "email_sent",
    status: "ok",
    user_id: input.userId,
    entity_id: input.meetingRequestId,
    details: {
      template: input.template,
      provider_message_id: sendResult.providerMessageId
    }
  });
}

async function processEmailConfirmationJob(job: BackgroundJob, deps: WorkerDependencies): Promise<void> {
  const meetingRequestId = parseMeetingRequestId(job);
  const request = await prisma.meetingRequest.findUnique({
    where: { id: meetingRequestId },
    include: { user: true }
  });

  if (!request) {
    throw new Error(`Meeting request not found for email confirmation job: ${meetingRequestId}`);
  }

  if (request.status !== MeetingRequestStatus.APPROVED && request.status !== MeetingRequestStatus.REJECTED) {
    return;
  }

  const isApproved = request.status === MeetingRequestStatus.APPROVED;
  const subject = isApproved ? "Ваша встреча подтверждена" : "Ваша заявка отклонена";

  const lines: string[] = [isApproved ? "Встреча подтверждена." : "Заявка отклонена.", ""];
  lines.push(`Номер заявки: ${formatRequestCode(request.createdAt)}`);
  lines.push(`Тема: ${request.topic}`);
  lines.push(`Формат: ${request.format === "ONLINE" ? "онлайн" : "оффлайн"}`);
  lines.push(`Длительность: ${request.durationMinutes} мин.`);
  lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);

  if (request.format === "OFFLINE") {
    lines.push(`Место: ${request.location ?? "-"}`);
  }

  if (!isApproved && request.approverComment) {
    lines.push(`Комментарий: ${request.approverComment}`);
  }

  await sendEmailThroughProvider({
    deps,
    meetingRequestId: request.id,
    userId: request.userId,
    template: "decision",
    email: {
      toEmail: request.email,
      toName: [request.firstName ?? "", request.lastName ?? ""].join(" ").trim() || null,
      subject,
      text: lines.join("\n")
    }
  });
}

async function processEmailReminderJob(job: BackgroundJob, deps: WorkerDependencies): Promise<void> {
  const meetingRequestId = parseMeetingRequestId(job);
  const request = await prisma.meetingRequest.findUnique({
    where: { id: meetingRequestId }
  });

  if (!request) {
    throw new Error(`Meeting request not found for email reminder job: ${meetingRequestId}`);
  }

  if (request.status !== MeetingRequestStatus.APPROVED) {
    return;
  }

  const lines = [
    "Напоминание о встрече.",
    "",
    `Номер заявки: ${formatRequestCode(request.createdAt)}`,
    `Тема: ${request.topic}`,
    `Формат: ${request.format === "ONLINE" ? "онлайн" : "оффлайн"}`,
    `Длительность: ${request.durationMinutes} мин.`,
    `Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`
  ];

  if (request.format === "OFFLINE") {
    lines.push(`Место: ${request.location ?? "-"}`);
  }

  await sendEmailThroughProvider({
    deps,
    meetingRequestId: request.id,
    userId: request.userId,
    template: "reminder",
    email: {
      toEmail: request.email,
      toName: [request.firstName ?? "", request.lastName ?? ""].join(" ").trim() || null,
      subject: "Напоминание: встреча через 2 часа",
      text: lines.join("\n")
    }
  });

  logEvent({
    operation: "reminder_sent",
    status: "ok",
    user_id: request.userId,
    entity_id: request.id,
    details: {
      reminder_type: "email"
    }
  });
}

async function processApprovalReminderJob(job: BackgroundJob, deps: WorkerDependencies): Promise<void> {
  const meetingRequestId = parseMeetingRequestId(job);

  if (!deps.adminTelegramId || !deps.adminNotifier) {
    throw new Error("Admin reminder notifier is not configured");
  }

  const request = await prisma.meetingRequest.findUnique({
    where: { id: meetingRequestId },
    include: { user: true }
  });

  if (!request || request.status !== MeetingRequestStatus.PENDING_APPROVAL) {
    return;
  }

  const requesterName = [request.firstName ?? request.user.firstName ?? "", request.lastName ?? request.user.lastName ?? ""]
    .join(" ")
    .trim();

  const lines: string[] = ["⏰ Напоминание: есть необработанная заявка.", ""];
  lines.push(`Номер заявки: ${formatRequestCode(request.createdAt)}`);
  lines.push(`Тема: ${request.topic}`);
  lines.push(`Пользователь: ${requesterName || "-"}`);
  lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);

  await deps.adminNotifier.sendMessage({
    chatId: deps.adminTelegramId,
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "Подтвердить", callback_data: `approval:confirm:${request.id}` },
          { text: "Отклонить", callback_data: `approval:reject:${request.id}` }
        ]
      ]
    }
  });

  logEvent({
    operation: "reminder_sent",
    status: "ok",
    entity_id: request.id,
    details: {
      reminder_type: "approval"
    }
  });
}

async function processTtlCleanupJob(): Promise<void> {
  const now = new Date();

  const expiredDraftsResult = await prisma.meetingRequestDraft.updateMany({
    where: {
      status: DraftStatus.ACTIVE,
      expiresAt: {
        lt: now
      }
    },
    data: {
      status: DraftStatus.EXPIRED
    }
  });

  logEvent({
    operation: "background_job_processed",
    status: "ok",
    details: {
      job_type: BackgroundJobType.TTL_CLEANUP,
      expired_drafts: expiredDraftsResult.count
    }
  });
}

async function processJob(job: BackgroundJob, deps: WorkerDependencies): Promise<void> {
  switch (job.jobType) {
    case BackgroundJobType.EMAIL_CONFIRMATION:
      await processEmailConfirmationJob(job, deps);
      return;
    case BackgroundJobType.EMAIL_REMINDER:
      await processEmailReminderJob(job, deps);
      return;
    case BackgroundJobType.APPROVAL_REMINDER:
      await processApprovalReminderJob(job, deps);
      return;
    case BackgroundJobType.TTL_CLEANUP:
      await processTtlCleanupJob();
      return;
    case BackgroundJobType.RETRY_INTEGRATION:
      return;
    default:
      return;
  }
}

export async function processDueBackgroundJobs(options?: ProcessOptions): Promise<number> {
  const deps = buildDependencies(options?.deps);
  const limit = options?.limit ?? DEFAULT_LIMIT;

  let processed = 0;

  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const job = await claimNextPendingJob(now);
    if (!job) {
      break;
    }

    try {
      await processJob(job, deps);
      await completeJob(job.id);

      logEvent({
        operation: "background_job_processed",
        status: "ok",
        entity_id: job.meetingRequestId,
        details: {
          job_id: job.id,
          job_type: job.jobType
        }
      });

      processed += 1;
    } catch (error) {
      await retryOrFailJob(job, error);

      logEvent({
        level: "error",
        operation: "background_job_processed",
        status: "error",
        entity_id: job.meetingRequestId,
        error_code: "BACKGROUND_JOB_PROCESSING_FAILED",
        error_message: error instanceof Error ? error.message : "Unknown background job error",
        details: {
          job_id: job.id,
          job_type: job.jobType,
          attempts: job.attempts,
          max_attempts: job.maxAttempts
        }
      });

      processed += 1;
    }
  }

  return processed;
}

export function startBackgroundWorker(): void {
  const config = getBackgroundJobsConfig();
  if (!config.enabled || timer) {
    return;
  }

  timer = setInterval(async () => {
    if (processing) {
      return;
    }

    processing = true;
    try {
      await processDueBackgroundJobs({ limit: config.batchSize });
    } catch (error) {
      logEvent({
        level: "error",
        operation: "background_job_processed",
        status: "error",
        error_code: "BACKGROUND_WORKER_TICK_FAILED",
        error_message: error instanceof Error ? error.message : "Unknown worker error"
      });
    } finally {
      processing = false;
    }
  }, config.pollIntervalMs);

  logEvent({
    operation: "background_worker_started",
    status: "ok",
    details: {
      poll_interval_ms: config.pollIntervalMs,
      batch_size: config.batchSize
    }
  });
}

export function stopBackgroundWorker(): void {
  if (!timer) {
    return;
  }

  clearInterval(timer);
  timer = null;
  processing = false;

  logEvent({
    operation: "background_worker_stopped",
    status: "ok"
  });
}
