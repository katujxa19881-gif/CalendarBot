-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "lastUsedEmail" TEXT,
    "personalDataConsentGiven" BOOLEAN NOT NULL DEFAULT false,
    "personalDataConsentAt" DATETIME,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MeetingRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "topic" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "approverId" TEXT,
    "approverComment" TEXT,
    "submittedAt" DATETIME,
    "resolvedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MeetingRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MeetingRequestDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MeetingRequestDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meetingRequestId" TEXT NOT NULL,
    "googleCalendarEventId" TEXT NOT NULL,
    "googleCalendarId" TEXT,
    "googleMeetLink" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CalendarEvent_meetingRequestId_fkey" FOREIGN KEY ("meetingRequestId") REFERENCES "MeetingRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meetingRequestId" TEXT,
    "userId" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "details" JSONB,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActionLog_meetingRequestId_fkey" FOREIGN KEY ("meetingRequestId") REFERENCES "MeetingRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meetingRequestId" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "runAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackgroundJob_meetingRequestId_fkey" FOREIGN KEY ("meetingRequestId") REFERENCES "MeetingRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "MeetingRequest_userId_createdAt_idx" ON "MeetingRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingRequest_status_createdAt_idx" ON "MeetingRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingRequest_startAt_endAt_idx" ON "MeetingRequest"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "MeetingRequestDraft_userId_expiresAt_idx" ON "MeetingRequestDraft"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "MeetingRequestDraft_status_expiresAt_idx" ON "MeetingRequestDraft"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_meetingRequestId_key" ON "CalendarEvent"("meetingRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_googleCalendarEventId_key" ON "CalendarEvent"("googleCalendarEventId");

-- CreateIndex
CREATE INDEX "CalendarEvent_syncStatus_createdAt_idx" ON "CalendarEvent"("syncStatus", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_meetingRequestId_createdAt_idx" ON "ActionLog"("meetingRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_userId_createdAt_idx" ON "ActionLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_actionType_createdAt_idx" ON "ActionLog"("actionType", "createdAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_jobType_runAt_idx" ON "BackgroundJob"("jobType", "runAt");
