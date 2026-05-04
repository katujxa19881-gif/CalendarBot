import {
  BackgroundJobStatus,
  BackgroundJobType,
  CalendarEventSyncStatus,
  JournalActionType,
  MeetingFormat,
  MeetingRequestStatus
} from "@prisma/client";
import { prisma, connectDatabase, disconnectDatabase } from "../db";
import { resolveDatabaseUrl } from "../env";
import {
  scheduleApprovalReminderJob,
  scheduleDecisionEmailJob,
  scheduleUpcomingReminderEmailJob
} from "../background/jobs";
import { processDueBackgroundJobs } from "../background/worker";
import { logEvent } from "../logger";

const MARKER = "stage6_verify";

async function cleanupTestData(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      telegramId: {
        startsWith: MARKER
      }
    },
    select: {
      id: true
    }
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
    await prisma.actionLog.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
    await prisma.calendarEvent.deleteMany({ where: { meetingRequestId: { in: requestIds } } });
  }

  await prisma.meetingRequest.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.meetingRequestDraft.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function plusMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function run(): Promise<void> {
  resolveDatabaseUrl();

  logEvent({
    operation: "background_job_processed",
    status: "ok",
    details: {
      stage: "6",
      mode: "verify_script_start"
    }
  });

  await connectDatabase();

  try {
    await cleanupTestData();

    const user = await prisma.user.create({
      data: {
        telegramId: `${MARKER}_user_1`,
        username: `${MARKER}_username`,
        firstName: "Stage",
        lastName: "Six",
        personalDataConsentGiven: true,
        personalDataConsentAt: new Date()
      }
    });

    const approvedRequest = await prisma.meetingRequest.create({
      data: {
        userId: user.id,
        durationMinutes: 30,
        format: MeetingFormat.ONLINE,
        startAt: plusMinutes(200),
        endAt: plusMinutes(230),
        topic: "Этап 6 подтвержденная",
        description: "Проверка email задач",
        email: "stage6-approved@example.com",
        firstName: "Stage",
        lastName: "Six",
        status: MeetingRequestStatus.APPROVED,
        submittedAt: plusMinutes(-30),
        resolvedAt: plusMinutes(-10)
      }
    });

    await prisma.calendarEvent.create({
      data: {
        meetingRequestId: approvedRequest.id,
        googleCalendarEventId: `stage6_event_${approvedRequest.id}`,
        googleCalendarId: "primary",
        syncStatus: CalendarEventSyncStatus.SYNCED,
        syncedAt: new Date()
      }
    });

    const pendingRequest = await prisma.meetingRequest.create({
      data: {
        userId: user.id,
        durationMinutes: 45,
        format: MeetingFormat.OFFLINE,
        startAt: plusMinutes(500),
        endAt: plusMinutes(545),
        topic: "Этап 6 без решения",
        description: "Проверка reminder администратору",
        location: "Офис",
        email: "stage6-pending@example.com",
        firstName: "Stage",
        lastName: "Six",
        status: MeetingRequestStatus.PENDING_APPROVAL,
        submittedAt: plusMinutes(-180),
        expiresAt: plusMinutes(1200)
      }
    });

    await scheduleDecisionEmailJob(approvedRequest.id);
    await scheduleUpcomingReminderEmailJob(approvedRequest);
    await scheduleApprovalReminderJob(pendingRequest);

    await prisma.backgroundJob.updateMany({
      where: {
        meetingRequestId: approvedRequest.id,
        jobType: BackgroundJobType.EMAIL_REMINDER
      },
      data: {
        runAt: plusMinutes(-1)
      }
    });

    const sentEmails: OutboxMessage[] = [];
    const sentAdminReminders: string[] = [];

    const processedCount = await processDueBackgroundJobs({
      limit: 20,
      deps: {
        emailProvider: {
          async send(email) {
            sentEmails.push({ to: email.toEmail, subject: email.subject });
            return { providerMessageId: `msg_${sentEmails.length}` };
          }
        },
        adminNotifier: {
          async sendMessage(input) {
            sentAdminReminders.push(`${input.chatId}:${input.text}`);
          }
        },
        adminTelegramId: "900099"
      }
    });

    if (processedCount < 3) {
      throw new Error(`Expected at least 3 processed jobs, got ${processedCount}`);
    }

    if (sentEmails.length < 2) {
      throw new Error(`Expected at least 2 sent emails, got ${sentEmails.length}`);
    }

    if (sentAdminReminders.length < 1) {
      throw new Error("Expected at least 1 admin reminder sent");
    }

    const remainingPendingJobs = await prisma.backgroundJob.count({
      where: {
        status: {
          in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.PROCESSING]
        },
        meetingRequestId: {
          in: [approvedRequest.id, pendingRequest.id]
        }
      }
    });

    if (remainingPendingJobs !== 0) {
      throw new Error(`Expected 0 pending/processing jobs, got ${remainingPendingJobs}`);
    }

    const emailSentLogs = await prisma.actionLog.count({
      where: {
        meetingRequestId: approvedRequest.id,
        actionType: JournalActionType.EMAIL_SENT
      }
    });

    if (emailSentLogs < 2) {
      throw new Error(`Expected at least 2 EMAIL_SENT action logs, got ${emailSentLogs}`);
    }

    logEvent({
      operation: "background_job_processed",
      status: "ok",
      details: {
        stage: "6",
        mode: "verify_script_completed",
        processed_jobs: processedCount,
        sent_emails: sentEmails.length,
        sent_admin_reminders: sentAdminReminders.length
      }
    });
  } finally {
    await disconnectDatabase();
  }
}

type OutboxMessage = {
  to: string;
  subject: string;
};

void run().catch(async (error) => {
  const message = error instanceof Error ? error.message : "Unknown stage6 verify error";

  logEvent({
    level: "error",
    operation: "background_job_processed",
    status: "error",
    error_code: "STAGE6_VERIFY_FAILED",
    error_message: message,
    details: {
      stage: "6"
    }
  });

  await disconnectDatabase();
  process.exit(1);
});
