import { MeetingRequestStatus } from "@prisma/client";
import { prisma } from "../db";
import { getMeetingSettings, MeetingSettings } from "../domain/app-settings";
import { BusyInterval, createGoogleCalendarAvailabilityProvider } from "../integrations/google-calendar";
import { logEvent } from "../logger";

export type AvailableSlot = {
  startAt: Date;
  endAt: Date;
  label: string;
};

const DURATION_OPTIONS = [15, 30, 45, 60, 90] as const;
const MOSCOW_UTC_OFFSET_MINUTES = 180;
const ACTIVE_SLOT_LOCK_STATUSES: MeetingRequestStatus[] = [
  MeetingRequestStatus.PENDING_APPROVAL,
  MeetingRequestStatus.APPROVED,
  MeetingRequestStatus.RESCHEDULE_REQUESTED,
  MeetingRequestStatus.RESCHEDULED
];

function toMoscowDate(date: Date): Date {
  return new Date(date.getTime() + MOSCOW_UTC_OFFSET_MINUTES * 60 * 1000);
}

function formatDateTimeMoscow(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60000) * 60000);
}

function roundUpToThirtyMinutes(date: Date): Date {
  const rounded = floorToMinute(date);
  const minute = rounded.getUTCMinutes();
  const remainder = minute % 30;
  if (remainder === 0) {
    return rounded;
  }
  return new Date(rounded.getTime() + (30 - remainder) * 60000);
}

function fromMoscowPartsToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - MOSCOW_UTC_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

function withSlotBuffer(startAt: Date, endAt: Date, settings: MeetingSettings): BusyInterval {
  return {
    startAt: new Date(startAt.getTime() - settings.slotBufferMinutes * 60 * 1000),
    endAt: new Date(endAt.getTime() + settings.slotBufferMinutes * 60 * 1000)
  };
}

function isSlotAvailable(slot: AvailableSlot, busyIntervals: BusyInterval[], settings: MeetingSettings): boolean {
  const bufferedSlot = withSlotBuffer(slot.startAt, slot.endAt, settings);
  return !busyIntervals.some((busy) => overlaps(bufferedSlot.startAt, bufferedSlot.endAt, busy.startAt, busy.endAt));
}

function buildCandidateSlots(durationMinutes: number, settings: MeetingSettings): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  const minStart = roundUpToThirtyMinutes(new Date(Date.now() + settings.slotMinLeadHours * 60 * 60 * 1000));

  const nowMoscow = toMoscowDate(new Date());
  const baseYear = nowMoscow.getUTCFullYear();
  const baseMonth = nowMoscow.getUTCMonth() + 1;
  const baseDay = nowMoscow.getUTCDate();

  for (let dayOffset = 0; dayOffset <= settings.slotHorizonDays; dayOffset += 1) {
    const dayStartUtc = fromMoscowPartsToUtcDate(baseYear, baseMonth, baseDay + dayOffset, 0, 0);
    const dayMoscow = toMoscowDate(dayStartUtc);
    const dayOfWeek = dayMoscow.getUTCDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }

    for (let hour = settings.workdayStartHour; hour < settings.workdayEndHour; hour += 1) {
      for (let minute = 0; minute < 60; minute += 30) {
        const startAt = fromMoscowPartsToUtcDate(
          dayMoscow.getUTCFullYear(),
          dayMoscow.getUTCMonth() + 1,
          dayMoscow.getUTCDate(),
          hour,
          minute
        );

        if (startAt.getTime() < minStart.getTime()) {
          continue;
        }

        const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);
        const endMoscow = toMoscowDate(endAt);

        if (
          endMoscow.getUTCFullYear() !== dayMoscow.getUTCFullYear() ||
          endMoscow.getUTCMonth() !== dayMoscow.getUTCMonth() ||
          endMoscow.getUTCDate() !== dayMoscow.getUTCDate()
        ) {
          continue;
        }

        const endTotalMinutes = endMoscow.getUTCHours() * 60 + endMoscow.getUTCMinutes();
        if (endTotalMinutes > settings.workdayEndHour * 60) {
          continue;
        }

        slots.push({
          startAt,
          endAt,
          label: formatDateTimeMoscow(startAt)
        });
      }
    }
  }

  return slots;
}

async function getLocalBusyIntervals(
  timeMin: Date,
  timeMax: Date,
  excludeMeetingRequestId?: string
): Promise<BusyInterval[]> {
  const requests = await prisma.meetingRequest.findMany({
    where: {
      status: { in: ACTIVE_SLOT_LOCK_STATUSES },
      ...(excludeMeetingRequestId ? { id: { not: excludeMeetingRequestId } } : {}),
      startAt: { lt: timeMax },
      endAt: { gt: timeMin }
    },
    select: {
      startAt: true,
      endAt: true
    }
  });

  return requests.map((request) => ({
    startAt: request.startAt,
    endAt: request.endAt
  }));
}

async function getBusyIntervalsForRange(
  timeMin: Date,
  timeMax: Date,
  excludeMeetingRequestId?: string
): Promise<BusyInterval[]> {
  const localBusyPromise = getLocalBusyIntervals(timeMin, timeMax, excludeMeetingRequestId);
  const availabilityProvider = createGoogleCalendarAvailabilityProvider();
  const calendarBusyPromise = availabilityProvider
    ? availabilityProvider.getBusyIntervals({ timeMin, timeMax })
    : Promise.resolve<BusyInterval[]>([]);

  const [calendarBusy, localBusy] = await Promise.all([calendarBusyPromise, localBusyPromise]);
  return [...calendarBusy, ...localBusy];
}

export function isSupportedDuration(value: number): boolean {
  return DURATION_OPTIONS.includes(value as (typeof DURATION_OPTIONS)[number]);
}

export async function buildAvailableSlots(input: {
  durationMinutes: number;
  excludeMeetingRequestId?: string;
  channel?: "bot" | "webapp";
  limitOverride?: number;
}): Promise<AvailableSlot[]> {
  const settings = await getMeetingSettings();
  const candidates = buildCandidateSlots(input.durationMinutes, settings);

  if (candidates.length === 0) {
    return [];
  }

  const firstCandidate = candidates[0];
  const lastCandidate = candidates[candidates.length - 1];

  const rangeStart = new Date(firstCandidate.startAt.getTime() - settings.slotBufferMinutes * 60 * 1000);
  const rangeEnd = new Date(lastCandidate.endAt.getTime() + settings.slotBufferMinutes * 60 * 1000);
  const busyIntervals = await getBusyIntervalsForRange(rangeStart, rangeEnd, input.excludeMeetingRequestId);

  const limit = Number.isFinite(input.limitOverride) && (input.limitOverride ?? 0) > 0 ? input.limitOverride! : settings.slotLimit;
  const available = candidates.filter((slot) => isSlotAvailable(slot, busyIntervals, settings)).slice(0, limit);

  logEvent({
    operation: "slots_built",
    status: "ok",
    details: {
      duration_minutes: input.durationMinutes,
      candidates_count: candidates.length,
      busy_count: busyIntervals.length,
      slots_count: available.length,
      slot_limit: limit,
      channel: input.channel ?? "bot"
    }
  });

  return available;
}

export async function ensureSlotStillAvailable(input: {
  startAt: Date;
  endAt: Date;
  excludeMeetingRequestId?: string;
}): Promise<boolean> {
  const settings = await getMeetingSettings();
  const bufferedSlot = withSlotBuffer(input.startAt, input.endAt, settings);
  const busyIntervals = await getBusyIntervalsForRange(
    bufferedSlot.startAt,
    bufferedSlot.endAt,
    input.excludeMeetingRequestId
  );

  return !busyIntervals.some((busy) =>
    overlaps(bufferedSlot.startAt, bufferedSlot.endAt, busy.startAt, busy.endAt)
  );
}
