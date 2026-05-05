"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMeetingSettings = getMeetingSettings;
exports.patchMeetingSettings = patchMeetingSettings;
const db_1 = require("../db");
const SETTINGS_ID = 1;
function clampInt(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
}
function normalize(input) {
    const startHour = clampInt(input.workdayStartHour, 6, 21);
    const endHour = clampInt(input.workdayEndHour, startHour + 1, 23);
    const parsedWorkdays = String(input.workdays ?? "")
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7);
    const uniqueWorkdays = [...new Set(parsedWorkdays)].sort((a, b) => a - b);
    const workdays = uniqueWorkdays.length > 0 ? uniqueWorkdays : [1, 2, 3, 4, 5];
    return {
        workdayStartHour: startHour,
        workdayEndHour: endHour,
        workdays,
        slotLimit: clampInt(input.slotLimit, 1, 30),
        slotBufferMinutes: clampInt(input.slotBufferMinutes, 0, 120),
        slotMinLeadHours: clampInt(input.slotMinLeadHours, 0, 72),
        slotHorizonDays: clampInt(input.slotHorizonDays, 1, 180)
    };
}
async function getMeetingSettings() {
    const settings = await db_1.prisma.appSettings.upsert({
        where: { id: SETTINGS_ID },
        update: {},
        create: { id: SETTINGS_ID }
    });
    return normalize(settings);
}
async function patchMeetingSettings(patch) {
    const current = await getMeetingSettings();
    const merged = {
        ...current,
        ...patch
    };
    const normalized = {
        workdays: (() => {
            const normalizedDays = [...new Set((merged.workdays ?? []).map((d) => clampInt(d, 1, 7)))].sort((a, b) => a - b);
            const safeDays = normalizedDays.length > 0 ? normalizedDays : [1, 2, 3, 4, 5];
            return safeDays.join(",");
        })(),
        workdayStartHour: clampInt(merged.workdayStartHour, 6, 21),
        workdayEndHour: clampInt(merged.workdayEndHour, clampInt(merged.workdayStartHour, 6, 21) + 1, 23),
        slotLimit: clampInt(merged.slotLimit, 1, 30),
        slotBufferMinutes: clampInt(merged.slotBufferMinutes, 0, 120),
        slotMinLeadHours: clampInt(merged.slotMinLeadHours, 0, 72),
        slotHorizonDays: clampInt(merged.slotHorizonDays, 1, 180)
    };
    const updated = await db_1.prisma.appSettings.upsert({
        where: { id: SETTINGS_ID },
        update: normalized,
        create: {
            id: SETTINGS_ID,
            ...normalized
        }
    });
    return normalize(updated);
}
