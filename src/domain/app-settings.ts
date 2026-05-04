import { AppSettings } from "@prisma/client";
import { prisma } from "../db";

export type MeetingSettings = {
  workdayStartHour: number;
  workdayEndHour: number;
  slotLimit: number;
  slotBufferMinutes: number;
  slotMinLeadHours: number;
  slotHorizonDays: number;
};

const SETTINGS_ID = 1;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalize(input: AppSettings): MeetingSettings {
  const startHour = clampInt(input.workdayStartHour, 6, 21);
  const endHour = clampInt(input.workdayEndHour, startHour + 1, 23);

  return {
    workdayStartHour: startHour,
    workdayEndHour: endHour,
    slotLimit: clampInt(input.slotLimit, 1, 30),
    slotBufferMinutes: clampInt(input.slotBufferMinutes, 0, 120),
    slotMinLeadHours: clampInt(input.slotMinLeadHours, 0, 72),
    slotHorizonDays: clampInt(input.slotHorizonDays, 1, 180)
  };
}

export async function getMeetingSettings(): Promise<MeetingSettings> {
  const settings = await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID }
  });

  return normalize(settings);
}

export async function patchMeetingSettings(patch: Partial<MeetingSettings>): Promise<MeetingSettings> {
  const current = await getMeetingSettings();
  const merged: MeetingSettings = {
    ...current,
    ...patch
  };

  const normalized = {
    workdayStartHour: clampInt(merged.workdayStartHour, 6, 21),
    workdayEndHour: clampInt(merged.workdayEndHour, clampInt(merged.workdayStartHour, 6, 21) + 1, 23),
    slotLimit: clampInt(merged.slotLimit, 1, 30),
    slotBufferMinutes: clampInt(merged.slotBufferMinutes, 0, 120),
    slotMinLeadHours: clampInt(merged.slotMinLeadHours, 0, 72),
    slotHorizonDays: clampInt(merged.slotHorizonDays, 1, 180)
  };

  const updated = await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: normalized,
    create: {
      id: SETTINGS_ID,
      ...normalized
    }
  });

  return normalize(updated);
}
