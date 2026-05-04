"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramBotRuntime = createTelegramBotRuntime;
exports.getTelegramRuntime = getTelegramRuntime;
exports.ensureWizardStateForUser = ensureWizardStateForUser;
const client_1 = require("@prisma/client");
const grammy_1 = require("grammy");
const zod_1 = require("zod");
const db_1 = require("../db");
const slots_1 = require("../application/slots");
const jobs_1 = require("../background/jobs");
const app_settings_1 = require("../domain/app-settings");
const meeting_request_status_1 = require("../domain/meeting-request-status");
const env_1 = require("../env");
const google_calendar_1 = require("../integrations/google-calendar");
const logger_1 = require("../logger");
const DURATION_OPTIONS = [15, 30, 45, 60, 90];
const DRAFT_TTL_HOURS = 24;
const PROCESSED_UPDATE_TTL_MS = 10 * 60 * 1000;
const EMAIL_SCHEMA = zod_1.z.string().email();
const ACTION = {
    MENU_NEW: "menu:new",
    MENU_HISTORY: "menu:history",
    MENU_ADMIN_ALL: "menu:admin:all",
    MENU_RESUME: "menu:resume",
    MENU_RESTART: "menu:restart",
    CONSENT_ACCEPT: "consent:accept",
    NAV_BACK: "nav:back",
    NAV_CANCEL: "nav:cancel",
    REVIEW_SUBMIT: "review:submit"
};
const APPROVAL_ACTION_PATTERN = /^approval:(confirm|reject):([a-z0-9]+)$/;
const REQUEST_ACTION_PATTERN = /^request:(reschedule|cancel):([a-z0-9]+)$/;
const RESCHEDULE_SLOT_PATTERN = /^reslot:([a-z0-9]+):(\d+)$/;
const ADMIN_SETTINGS_ACTION_PATTERN = /^admin:settings:(open|set):([a-z_]+):?(-?\d+)?$/;
const STEP_ORDER = [
    "duration",
    "format",
    "slot",
    "topic",
    "description",
    "email",
    "first_name",
    "last_name",
    "location",
    "review"
];
const BOT_BUILD_LABEL = "2026-05-03-stage7-reschedule-cancel";
const ACTION_LOCK_TTL_MS = 20 * 1000;
const ANTI_SPAM_SHORT_MS = 1200;
const ANTI_SPAM_SUBMIT_MS = 6000;
const ANTI_SPAM_ACTION_MS = 2500;
let runtimeCache = null;
let runtimeCacheToken = null;
let runtimeCalendarEventSyncProvider = (0, google_calendar_1.createGoogleCalendarEventSyncProvider)();
let runtimeAdminTelegramId = (0, env_1.getApprovalConfig)().adminTelegramId;
const pendingRejectionCommentByAdmin = new Map();
const processedUpdateIds = new Map();
const pendingRescheduleByUser = new Map();
const actionLocks = new Map();
const rateLimitMap = new Map();
let meetingSettingsCache = null;
const MEETING_SETTINGS_CACHE_TTL_MS = 15000;
function isDuplicateUpdate(updateId) {
    const now = Date.now();
    for (const [savedUpdateId, savedAt] of processedUpdateIds) {
        if (now - savedAt > PROCESSED_UPDATE_TTL_MS) {
            processedUpdateIds.delete(savedUpdateId);
        }
    }
    if (processedUpdateIds.has(updateId)) {
        return true;
    }
    processedUpdateIds.set(updateId, now);
    return false;
}
function acquireActionLock(key) {
    const now = Date.now();
    for (const [savedKey, savedAt] of actionLocks) {
        if (now - savedAt > ACTION_LOCK_TTL_MS) {
            actionLocks.delete(savedKey);
        }
    }
    if (actionLocks.has(key)) {
        return false;
    }
    actionLocks.set(key, now);
    return true;
}
function releaseActionLock(key) {
    actionLocks.delete(key);
}
function isRateLimited(userTelegramId, actionKey, intervalMs) {
    if (process.env.DISABLE_ANTI_SPAM === "true") {
        return false;
    }
    const now = Date.now();
    const key = `${userTelegramId}:${actionKey}`;
    const lastAt = rateLimitMap.get(key) ?? 0;
    if (now - lastAt < intervalMs) {
        return true;
    }
    rateLimitMap.set(key, now);
    return false;
}
async function getCachedMeetingSettings() {
    const now = Date.now();
    if (meetingSettingsCache && now - meetingSettingsCache.cachedAt < MEETING_SETTINGS_CACHE_TTL_MS) {
        return meetingSettingsCache.value;
    }
    const settings = await (0, app_settings_1.getMeetingSettings)();
    meetingSettingsCache = { value: settings, cachedAt: now };
    return settings;
}
function buildBotInfoFromToken(botToken) {
    const rawId = botToken.split(":")[0] ?? "1";
    const parsed = Number(rawId);
    return {
        id: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
        is_bot: true,
        first_name: "MeetingApprovalBot",
        username: "meeting_approval_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isIgnorableCallbackAnswerError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    const message = error.message.toLowerCase();
    return message.includes("query is too old") || message.includes("query id is invalid");
}
async function safeAnswerCallbackQuery(ctx) {
    try {
        await ctx.answerCallbackQuery();
    }
    catch (error) {
        if (!isIgnorableCallbackAnswerError(error)) {
            throw error;
        }
        const callbackId = isRecord(ctx.callbackQuery) && typeof ctx.callbackQuery.id === "string"
            ? ctx.callbackQuery.id
            : null;
        (0, logger_1.logEvent)({
            level: "warn",
            operation: "callback_answer_skipped",
            status: "error",
            user_id: ctx.state.appUser?.id ?? null,
            error_code: "CALLBACK_QUERY_STALE",
            error_message: error instanceof Error ? error.message : "Unknown callback query error",
            details: {
                callback_id: callbackId
            }
        });
    }
}
function parseDraftPayload(value) {
    if (!isRecord(value)) {
        return {};
    }
    const payload = {};
    if (typeof value.durationMinutes === "number") {
        const candidate = value.durationMinutes;
        if (DURATION_OPTIONS.includes(candidate)) {
            payload.durationMinutes = candidate;
        }
    }
    if (value.format === "ONLINE" || value.format === "OFFLINE") {
        payload.format = value.format;
    }
    if (typeof value.slotStartAt === "string") {
        payload.slotStartAt = value.slotStartAt;
    }
    if (typeof value.slotEndAt === "string") {
        payload.slotEndAt = value.slotEndAt;
    }
    if (typeof value.topic === "string") {
        payload.topic = value.topic;
    }
    if (typeof value.description === "string" || value.description === null) {
        payload.description = value.description;
    }
    if (typeof value.email === "string") {
        payload.email = value.email;
    }
    if (typeof value.firstName === "string") {
        payload.firstName = value.firstName;
    }
    if (typeof value.lastName === "string") {
        payload.lastName = value.lastName;
    }
    if (typeof value.location === "string") {
        payload.location = value.location;
    }
    return payload;
}
function nowPlusHours(hours) {
    return new Date(Date.now() + hours * 60 * 60 * 1000);
}
function formatDateTimeMoscow(date) {
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}
function formatDateMoscow(date) {
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "2-digit"
    }).format(date);
}
function formatTimeMoscow(date) {
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}
function formatDateRangeMoscow(startAt, endAt) {
    return `${formatDateMoscow(startAt)} ${formatTimeMoscow(startAt)} - ${formatTimeMoscow(endAt)} (МСК)`;
}
function formatRequestCode(meetingRequest) {
    const parts = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date(meetingRequest.createdAt));
    const hh = parts.find((part) => part.type === "hour")?.value ?? "00";
    const mm = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `#${hh}${mm}`;
}
function formatHistoryStatus(status) {
    switch (status) {
        case "NEW":
            return "Новая";
        case "PENDING_APPROVAL":
            return "На согласовании";
        case "APPROVED":
            return "Подтверждена";
        case "REJECTED":
            return "Отклонена";
        case "CANCELLED":
            return "Отменена";
        case "RESCHEDULE_REQUESTED":
            return "Перенос запрошен";
        case "RESCHEDULED":
            return "Перенесена";
        case "EXPIRED":
            return "Истекла";
        default:
            return status;
    }
}
function getStepTitle(step) {
    switch (step) {
        case "duration":
            return "Выбор длительности";
        case "format":
            return "Выбор формата";
        case "slot":
            return "Выбор времени";
        case "topic":
            return "Тема встречи";
        case "description":
            return "Описание встречи";
        case "email":
            return "Email гостя";
        case "first_name":
            return "Имя";
        case "last_name":
            return "Фамилия";
        case "location":
            return "Место встречи";
        case "review":
            return "Итоговая проверка";
        default:
            return step;
    }
}
function formatReview(payload) {
    const lines = ["Проверьте данные заявки:"];
    lines.push(`• Длительность: ${payload.durationMinutes ?? "-"} мин`);
    lines.push(`• Формат: ${payload.format === "ONLINE" ? "Онлайн" : payload.format === "OFFLINE" ? "Оффлайн" : "-"}`);
    if (payload.slotStartAt) {
        lines.push(`• Время: ${formatDateTimeMoscow(new Date(payload.slotStartAt))}`);
    }
    else {
        lines.push("• Время: -");
    }
    lines.push(`• Тема: ${payload.topic ?? "-"}`);
    lines.push(`• Описание: ${payload.description ?? "-"}`);
    lines.push(`• Email: ${payload.email ?? "-"}`);
    lines.push(`• Имя: ${payload.firstName ?? "-"}`);
    lines.push(`• Фамилия: ${payload.lastName ?? "-"}`);
    if (payload.format === "OFFLINE") {
        lines.push(`• Место: ${payload.location ?? "-"}`);
    }
    return lines.join("\n");
}
async function upsertUserFromContext(ctx) {
    if (!ctx.from) {
        return null;
    }
    const telegramId = String(ctx.from.id);
    const user = await db_1.prisma.user.upsert({
        where: { telegramId },
        update: {
            username: ctx.from.username ?? null,
            firstName: ctx.from.first_name ?? null,
            lastName: ctx.from.last_name ?? null
        },
        create: {
            telegramId,
            username: ctx.from.username ?? null,
            firstName: ctx.from.first_name ?? null,
            lastName: ctx.from.last_name ?? null
        }
    });
    if (!ctx.state) {
        ctx.state = {};
    }
    ctx.state.appUser = user;
    return user;
}
async function expireOldDrafts(userId) {
    await db_1.prisma.meetingRequestDraft.updateMany({
        where: {
            userId,
            status: client_1.DraftStatus.ACTIVE,
            expiresAt: { lt: new Date() }
        },
        data: { status: client_1.DraftStatus.EXPIRED }
    });
}
async function getActiveDraft(userId) {
    await expireOldDrafts(userId);
    return db_1.prisma.meetingRequestDraft.findFirst({
        where: {
            userId,
            status: client_1.DraftStatus.ACTIVE,
            expiresAt: { gt: new Date() }
        },
        orderBy: { updatedAt: "desc" }
    });
}
async function discardActiveDrafts(userId) {
    await db_1.prisma.meetingRequestDraft.updateMany({
        where: {
            userId,
            status: client_1.DraftStatus.ACTIVE
        },
        data: {
            status: client_1.DraftStatus.DISCARDED
        }
    });
}
async function createDraft(user) {
    const payload = {
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined
    };
    const draft = await db_1.prisma.meetingRequestDraft.create({
        data: {
            userId: user.id,
            currentStep: "duration",
            payload: payload,
            status: client_1.DraftStatus.ACTIVE,
            expiresAt: nowPlusHours(DRAFT_TTL_HOURS)
        }
    });
    (0, logger_1.logEvent)({
        operation: "wizard_started",
        status: "ok",
        user_id: user.id,
        entity_id: draft.id,
        details: {
            source: "new_draft"
        }
    });
    (0, logger_1.logEvent)({
        operation: "draft_saved",
        status: "ok",
        user_id: user.id,
        entity_id: draft.id,
        details: {
            step: "duration"
        }
    });
    return draft;
}
async function saveDraft(draft, userId, nextStep, payload) {
    const prevStep = draft.currentStep;
    const updated = await db_1.prisma.meetingRequestDraft.update({
        where: { id: draft.id },
        data: {
            currentStep: nextStep,
            payload: payload,
            expiresAt: nowPlusHours(DRAFT_TTL_HOURS)
        }
    });
    (0, logger_1.logEvent)({
        operation: "draft_saved",
        status: "ok",
        user_id: userId,
        entity_id: draft.id,
        details: {
            step: nextStep
        }
    });
    if (prevStep !== nextStep) {
        (0, logger_1.logEvent)({
            operation: "wizard_step_changed",
            status: "ok",
            user_id: userId,
            entity_id: draft.id,
            details: {
                from_step: prevStep,
                to_step: nextStep
            }
        });
    }
    return updated;
}
async function appendActionLog(input) {
    await db_1.prisma.actionLog.create({
        data: {
            meetingRequestId: input.meetingRequestId,
            userId: input.userId,
            actorRole: input.actorRole,
            actorId: input.actorId,
            actionType: input.actionType,
            details: input.details,
            result: input.result ?? "ok"
        }
    });
}
function getNextStep(payload) {
    if (!payload.durationMinutes) {
        return "duration";
    }
    if (!payload.format) {
        return "format";
    }
    if (!payload.slotStartAt || !payload.slotEndAt) {
        return "slot";
    }
    if (!payload.topic) {
        return "topic";
    }
    if (payload.description === undefined) {
        return "description";
    }
    if (!payload.email) {
        return "email";
    }
    if (!payload.firstName) {
        return "first_name";
    }
    if (!payload.lastName) {
        return "last_name";
    }
    if (payload.format === "OFFLINE" && !payload.location) {
        return "location";
    }
    return "review";
}
function getPreviousStep(currentStep, payload) {
    if (currentStep === "review") {
        if (payload.format === "OFFLINE") {
            return "location";
        }
        return "last_name";
    }
    if (currentStep === "location") {
        return "last_name";
    }
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (currentIndex <= 0) {
        return "duration";
    }
    const previous = STEP_ORDER[currentIndex - 1];
    if (previous === "location" && payload.format !== "OFFLINE") {
        return "last_name";
    }
    return previous;
}
function startMenuKeyboard(hasDraft) {
    const keyboard = new grammy_1.InlineKeyboard();
    const miniAppConfig = (0, env_1.getMiniAppConfig)();
    const webAppUrl = miniAppConfig.webAppUrl?.trim();
    if (hasDraft) {
        keyboard.text("Продолжить", ACTION.MENU_RESUME).text("Начать заново", ACTION.MENU_RESTART).row();
    }
    else {
        keyboard.text("Новая заявка", ACTION.MENU_NEW).row();
    }
    keyboard.text("Мои заявки", ACTION.MENU_HISTORY);
    if (miniAppConfig.enabled && webAppUrl) {
        keyboard.row().url("Mini App", webAppUrl);
    }
    return keyboard;
}
function myRequestsShortcutKeyboard() {
    return new grammy_1.InlineKeyboard().text("Мои заявки", ACTION.MENU_HISTORY);
}
function navKeyboard(includeBack) {
    const keyboard = new grammy_1.InlineKeyboard();
    if (includeBack) {
        keyboard.text("Назад", ACTION.NAV_BACK);
    }
    keyboard.text("Отменить", ACTION.NAV_CANCEL);
    return keyboard;
}
function durationKeyboard() {
    const keyboard = new grammy_1.InlineKeyboard();
    DURATION_OPTIONS.forEach((option, index) => {
        keyboard.text(`${option} мин`, `dur:${option}`);
        if (index % 2 === 1) {
            keyboard.row();
        }
    });
    keyboard.row().text("Отменить", ACTION.NAV_CANCEL);
    return keyboard;
}
function formatKeyboard() {
    return new grammy_1.InlineKeyboard()
        .text("Онлайн", "fmt:ONLINE")
        .text("Оффлайн", "fmt:OFFLINE")
        .row()
        .text("Назад", ACTION.NAV_BACK)
        .text("Отменить", ACTION.NAV_CANCEL);
}
function slotsKeyboard(slots) {
    const keyboard = new grammy_1.InlineKeyboard();
    slots.forEach((slot, index) => {
        keyboard.text(slot.label, `slot:${index}`).row();
    });
    keyboard.text("Назад", ACTION.NAV_BACK).text("Отменить", ACTION.NAV_CANCEL);
    return keyboard;
}
function reviewKeyboard(payload) {
    const keyboard = new grammy_1.InlineKeyboard()
        .text("Изменить длительность", "edit:duration")
        .row()
        .text("Изменить формат", "edit:format")
        .row()
        .text("Изменить время", "edit:slot")
        .row()
        .text("Изменить тему", "edit:topic")
        .row()
        .text("Изменить описание", "edit:description")
        .row()
        .text("Изменить email", "edit:email")
        .row()
        .text("Изменить имя", "edit:first_name")
        .row()
        .text("Изменить фамилию", "edit:last_name")
        .row();
    if (payload.format === "OFFLINE") {
        keyboard.text("Изменить место", "edit:location").row();
    }
    keyboard.text("Отправить заявку", ACTION.REVIEW_SUBMIT).row();
    keyboard.text("Назад", ACTION.NAV_BACK).text("Отменить", ACTION.NAV_CANCEL);
    return keyboard;
}
function approvalKeyboard(meetingRequestId) {
    return new grammy_1.InlineKeyboard()
        .text("Подтвердить", `approval:confirm:${meetingRequestId}`)
        .row()
        .text("Отклонить", `approval:reject:${meetingRequestId}`);
}
function requestActionsKeyboard(request) {
    if (request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL &&
        request.status !== client_1.MeetingRequestStatus.APPROVED &&
        request.status !== client_1.MeetingRequestStatus.RESCHEDULE_REQUESTED &&
        request.status !== client_1.MeetingRequestStatus.RESCHEDULED) {
        return null;
    }
    const keyboard = new grammy_1.InlineKeyboard();
    if (request.status === client_1.MeetingRequestStatus.APPROVED || request.status === client_1.MeetingRequestStatus.RESCHEDULED) {
        keyboard.text("Перенести", `request:reschedule:${request.id}`).row();
    }
    keyboard.text("Отменить", `request:cancel:${request.id}`);
    return keyboard;
}
function rescheduleSlotsKeyboard(meetingRequestId, slots) {
    const keyboard = new grammy_1.InlineKeyboard();
    slots.forEach((slot, index) => {
        keyboard.text(slot.label, `reslot:${meetingRequestId}:${index}`).row();
    });
    keyboard.text("Отменить", ACTION.NAV_CANCEL);
    return keyboard;
}
function formatApprovalCard(meetingRequest, requester) {
    const lines = ["🟡 Новая заявка на подтверждение."];
    const requesterName = [requester.firstName ?? "-", requester.lastName ?? ""].join(" ").trim();
    lines.push("");
    lines.push(`Номер заявки: ${formatRequestCode(meetingRequest)}`);
    lines.push(`Пользователь: @${requester.username ?? "-"} (${requesterName})`);
    lines.push(`Тема: ${meetingRequest.topic}`);
    lines.push(`Формат: ${meetingRequest.format === "ONLINE" ? "онлайн" : "оффлайн"}`);
    lines.push(`Длительность: ${meetingRequest.durationMinutes} мин.`);
    lines.push(`Дата и время: ${formatDateRangeMoscow(meetingRequest.startAt, meetingRequest.endAt)}`);
    lines.push(`Описание: ${meetingRequest.description ?? "-"}`);
    lines.push(`Email: ${meetingRequest.email}`);
    if (meetingRequest.format === "OFFLINE") {
        lines.push(`Место: ${meetingRequest.location ?? "-"}`);
    }
    return lines.join("\n");
}
function resolveAdminChatId() {
    const raw = runtimeAdminTelegramId?.trim();
    if (!raw) {
        return null;
    }
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) ? asNumber : raw;
}
function isAdminActor(ctx) {
    if (!ctx.from || !runtimeAdminTelegramId) {
        return false;
    }
    return String(ctx.from.id) === runtimeAdminTelegramId;
}
function adminSettingsKeyboard() {
    return new grammy_1.InlineKeyboard()
        .text("Начало дня -1", "admin:settings:set:workday_start_hour:-1")
        .text("Начало дня +1", "admin:settings:set:workday_start_hour:1")
        .row()
        .text("Конец дня -1", "admin:settings:set:workday_end_hour:-1")
        .text("Конец дня +1", "admin:settings:set:workday_end_hour:1")
        .row()
        .text("Буфер -5", "admin:settings:set:slot_buffer_minutes:-5")
        .text("Буфер +5", "admin:settings:set:slot_buffer_minutes:5")
        .row()
        .text("Лимит слотов -1", "admin:settings:set:slot_limit:-1")
        .text("Лимит слотов +1", "admin:settings:set:slot_limit:1")
        .row()
        .text("Горизонт -7д", "admin:settings:set:slot_horizon_days:-7")
        .text("Горизонт +7д", "admin:settings:set:slot_horizon_days:7")
        .row()
        .text("Опережение -1ч", "admin:settings:set:slot_min_lead_hours:-1")
        .text("Опережение +1ч", "admin:settings:set:slot_min_lead_hours:1")
        .row()
        .text("Все заявки", ACTION.MENU_ADMIN_ALL)
        .row()
        .text("Обновить", "admin:settings:open:refresh:0");
}
function formatAdminSettingsMessage(settings) {
    return [
        "Панель администратора",
        "",
        `Рабочий день: ${settings.workdayStartHour}:00 - ${settings.workdayEndHour}:00`,
        `Буфер: ${settings.slotBufferMinutes} мин`,
        `Лимит слотов: ${settings.slotLimit}`,
        `Горизонт: ${settings.slotHorizonDays} дней`,
        `Опережение: ${settings.slotMinLeadHours} ч`,
        "",
        "Изменяйте параметры кнопками ниже."
    ].join("\n");
}
async function showAdminSettingsPanel(ctx) {
    const settings = await getCachedMeetingSettings();
    await ctx.reply(formatAdminSettingsMessage(settings), {
        reply_markup: adminSettingsKeyboard()
    });
}
async function changeAdminSetting(ctx, key, delta) {
    const current = await getCachedMeetingSettings();
    let updated;
    switch (key) {
        case "workday_start_hour":
            updated = await (0, app_settings_1.patchMeetingSettings)({ workdayStartHour: current.workdayStartHour + delta });
            break;
        case "workday_end_hour":
            updated = await (0, app_settings_1.patchMeetingSettings)({ workdayEndHour: current.workdayEndHour + delta });
            break;
        case "slot_buffer_minutes":
            updated = await (0, app_settings_1.patchMeetingSettings)({ slotBufferMinutes: current.slotBufferMinutes + delta });
            break;
        case "slot_limit":
            updated = await (0, app_settings_1.patchMeetingSettings)({ slotLimit: current.slotLimit + delta });
            break;
        case "slot_horizon_days":
            updated = await (0, app_settings_1.patchMeetingSettings)({ slotHorizonDays: current.slotHorizonDays + delta });
            break;
        case "slot_min_lead_hours":
            updated = await (0, app_settings_1.patchMeetingSettings)({ slotMinLeadHours: current.slotMinLeadHours + delta });
            break;
        default:
            await ctx.reply("Неизвестный параметр настройки.");
            return;
    }
    meetingSettingsCache = { value: updated, cachedAt: Date.now() };
    (0, logger_1.logEvent)({
        operation: "admin_settings_updated",
        status: "ok",
        user_id: ctx.state.appUser?.id ?? null,
        actor_id: String(ctx.from?.id ?? ""),
        details: {
            setting: key,
            delta
        }
    });
    await ctx.reply(formatAdminSettingsMessage(updated), {
        reply_markup: adminSettingsKeyboard()
    });
}
async function showHistory(ctx, user) {
    const requests = await db_1.prisma.meetingRequest.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 4
    });
    if (requests.length === 0) {
        (0, logger_1.logEvent)({
            operation: "history_loaded",
            status: "ok",
            user_id: user.id,
            details: {
                requests_count: 0
            }
        });
        await ctx.reply("Заявок пока нет. Создайте первую через кнопку «Новая заявка».", {
            reply_markup: startMenuKeyboard(Boolean(await getActiveDraft(user.id)))
        });
        return;
    }
    (0, logger_1.logEvent)({
        operation: "history_loaded",
        status: "ok",
        user_id: user.id,
        details: {
            requests_count: requests.length
        }
    });
    await ctx.reply(`Последние заявки (${requests.length} из 4):`, {
        reply_markup: startMenuKeyboard(Boolean(await getActiveDraft(user.id)))
    });
    for (const request of requests) {
        const lines = [];
        lines.push(`Номер заявки: ${formatRequestCode(request)}`);
        lines.push(`Тема: ${request.topic}`);
        lines.push(`Статус: ${formatHistoryStatus(request.status)}`);
        lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);
        const keyboard = requestActionsKeyboard(request);
        await ctx.reply(lines.join("\n"), keyboard ? { reply_markup: keyboard } : undefined);
    }
}
async function showAllRequestsForAdmin(ctx, limit = 10) {
    const requests = await db_1.prisma.meetingRequest.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { user: true }
    });
    if (requests.length === 0) {
        await ctx.reply("Пока нет заявок.");
        return;
    }
    await ctx.reply(`Последние заявки (все пользователи, ${requests.length}):`);
    for (const request of requests) {
        const lines = [];
        lines.push(`Номер заявки: ${formatRequestCode(request)}`);
        lines.push(`Пользователь: @${request.user.username ?? "-"} (${request.user.telegramId})`);
        lines.push(`Тема: ${request.topic}`);
        lines.push(`Статус: ${formatHistoryStatus(request.status)}`);
        lines.push(`Дата и время: ${formatDateRangeMoscow(request.startAt, request.endAt)}`);
        await ctx.reply(lines.join("\n"));
    }
}
async function showConsent(ctx) {
    const keyboard = new grammy_1.InlineKeyboard().text("Согласен(на)", ACTION.CONSENT_ACCEPT);
    await ctx.reply("Перед записью нужно согласиться на обработку персональных данных. Нажмите кнопку ниже для продолжения.", {
        reply_markup: keyboard
    });
}
async function showStartMenu(ctx, user) {
    const draft = await getActiveDraft(user.id);
    const message = draft
        ? "У вас есть незавершенная заявка. Можно продолжить или начать заново."
        : "Выберите действие:";
    await ctx.reply(message, {
        reply_markup: startMenuKeyboard(Boolean(draft))
    });
}
async function showStepPrompt(ctx, step, payload) {
    if (step === "duration") {
        await ctx.reply("Шаг 1/9. Выберите длительность встречи:", {
            reply_markup: durationKeyboard()
        });
        return;
    }
    if (step === "format") {
        await ctx.reply("Шаг 2/9. Выберите формат встречи:", {
            reply_markup: formatKeyboard()
        });
        return;
    }
    if (step === "slot") {
        if (!payload.durationMinutes) {
            await ctx.reply("Сначала выберите длительность.");
            return;
        }
        let slots;
        try {
            slots = await (0, slots_1.buildAvailableSlots)({
                durationMinutes: payload.durationMinutes
            });
        }
        catch {
            await ctx.reply("Календарь сейчас недоступен. Попробуйте выбрать время немного позже.", {
                reply_markup: navKeyboard(true)
            });
            return;
        }
        if (slots.length === 0) {
            await ctx.reply("Свободные слоты не найдены в ближайшие 30 дней. Попробуйте другую длительность.", {
                reply_markup: navKeyboard(true)
            });
            return;
        }
        await ctx.reply("Шаг 3/9. Выберите доступный слот:", {
            reply_markup: slotsKeyboard(slots)
        });
        return;
    }
    if (step === "topic") {
        await ctx.reply("Шаг 4/9. Введите тему встречи:", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "description") {
        await ctx.reply("Шаг 5/9. Введите описание встречи (или отправьте «-», если без описания):", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "email") {
        await ctx.reply("Шаг 6/9. Введите email участника:", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "first_name") {
        await ctx.reply("Шаг 7/9. Введите имя (по умолчанию подставлено из Telegram, можно изменить):", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "last_name") {
        await ctx.reply("Шаг 8/9. Введите фамилию (по умолчанию подставлена из Telegram, можно изменить):", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "location") {
        await ctx.reply("Шаг 9/9. Введите место/адрес оффлайн-встречи:", {
            reply_markup: navKeyboard(true)
        });
        return;
    }
    if (step === "review") {
        await ctx.reply(formatReview(payload), {
            reply_markup: reviewKeyboard(payload)
        });
    }
}
async function transitionToStep(ctx, user, draft, payload, nextStep) {
    const updatedDraft = await saveDraft(draft, user.id, nextStep, payload);
    await showStepPrompt(ctx, nextStep, payload);
    return updatedDraft;
}
async function startWizard(ctx, user) {
    await discardActiveDrafts(user.id);
    const draft = await createDraft(user);
    const payload = parseDraftPayload(draft.payload);
    await showStepPrompt(ctx, "duration", payload);
}
async function restoreDraft(ctx, user, draft) {
    const payload = parseDraftPayload(draft.payload);
    const currentStep = draft.currentStep;
    (0, logger_1.logEvent)({
        operation: "draft_restored",
        status: "ok",
        user_id: user.id,
        entity_id: draft.id,
        details: {
            step: currentStep
        }
    });
    await appendActionLog({
        userId: user.id,
        actorRole: client_1.JournalActorRole.USER,
        actorId: user.telegramId,
        actionType: client_1.JournalActionType.DRAFT_RESTORED,
        details: {
            step: currentStep
        }
    });
    await showStepPrompt(ctx, currentStep, payload);
}
async function cancelWizard(ctx, user) {
    pendingRescheduleByUser.delete(user.telegramId);
    await discardActiveDrafts(user.id);
    await ctx.reply("Заявка отменена. Вы можете начать заново в любой момент.", {
        reply_markup: startMenuKeyboard(false)
    });
}
async function handleBackAction(ctx, user) {
    const draft = await getActiveDraft(user.id);
    if (!draft) {
        await showStartMenu(ctx, user);
        return;
    }
    const payload = parseDraftPayload(draft.payload);
    const currentStep = draft.currentStep;
    const previousStep = getPreviousStep(currentStep, payload);
    await transitionToStep(ctx, user, draft, payload, previousStep);
}
async function submitMeetingRequest(ctx, user, draft, payload) {
    if (!payload.durationMinutes ||
        !payload.format ||
        !payload.slotStartAt ||
        !payload.slotEndAt ||
        !payload.topic ||
        !payload.email ||
        !payload.firstName ||
        !payload.lastName ||
        (payload.format === "OFFLINE" && !payload.location)) {
        await ctx.reply("Не все данные заполнены. Проверьте форму еще раз.", {
            reply_markup: reviewKeyboard(payload)
        });
        return;
    }
    const slotStartAt = new Date(payload.slotStartAt);
    const slotEndAt = new Date(payload.slotEndAt);
    if (Number.isNaN(slotStartAt.getTime()) || Number.isNaN(slotEndAt.getTime())) {
        await ctx.reply("Не удалось проверить выбранный слот. Выберите время еще раз.", {
            reply_markup: navKeyboard(true)
        });
        await transitionToStep(ctx, user, draft, payload, "slot");
        return;
    }
    try {
        const slotStillAvailable = await (0, slots_1.ensureSlotStillAvailable)({
            startAt: slotStartAt,
            endAt: slotEndAt
        });
        if (!slotStillAvailable) {
            (0, logger_1.logEvent)({
                level: "warn",
                operation: "slot_conflict_detected",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "SLOT_CONFLICT",
                error_message: "Selected slot is no longer available",
                details: {
                    slot_start_at: slotStartAt.toISOString(),
                    slot_end_at: slotEndAt.toISOString()
                }
            });
            payload.slotStartAt = undefined;
            payload.slotEndAt = undefined;
            await ctx.reply("Этот слот уже заняли. Выберите другой доступный интервал.");
            await transitionToStep(ctx, user, draft, payload, "slot");
            return;
        }
    }
    catch {
        await ctx.reply("Не удалось перепроверить занятость календаря. Попробуйте отправить заявку позже.", {
            reply_markup: reviewKeyboard(payload)
        });
        return;
    }
    const meetingRequest = await db_1.prisma.meetingRequest.create({
        data: {
            userId: user.id,
            durationMinutes: payload.durationMinutes,
            format: payload.format,
            startAt: slotStartAt,
            endAt: slotEndAt,
            topic: payload.topic,
            description: payload.description ?? null,
            location: payload.format === "OFFLINE" ? payload.location ?? null : null,
            email: payload.email,
            firstName: payload.firstName,
            lastName: payload.lastName,
            status: client_1.MeetingRequestStatus.PENDING_APPROVAL,
            submittedAt: new Date(),
            expiresAt: nowPlusHours(24)
        }
    });
    await db_1.prisma.user.update({
        where: { id: user.id },
        data: {
            lastUsedEmail: payload.email,
            firstName: payload.firstName,
            lastName: payload.lastName
        }
    });
    await appendActionLog({
        meetingRequestId: meetingRequest.id,
        userId: user.id,
        actorRole: client_1.JournalActorRole.USER,
        actorId: user.telegramId,
        actionType: client_1.JournalActionType.MEETING_REQUEST_SUBMITTED,
        details: {
            draftId: draft.id,
            step: "review"
        }
    });
    await db_1.prisma.meetingRequestDraft.update({
        where: { id: draft.id },
        data: {
            status: client_1.DraftStatus.DISCARDED
        }
    });
    (0, logger_1.logEvent)({
        operation: "meeting_request_submitted",
        status: "ok",
        user_id: user.id,
        entity_id: meetingRequest.id,
        details: {
            meeting_status: meetingRequest.status
        }
    });
    try {
        await (0, jobs_1.scheduleApprovalReminderJob)(meetingRequest);
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "approval_reminder_schedule_failed",
            status: "error",
            user_id: user.id,
            entity_id: meetingRequest.id,
            error_code: "APPROVAL_REMINDER_JOB_CREATE_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to schedule approval reminder job"
        });
    }
    const submitLines = ["🟡 Заявка отправлена на подтверждение.", "Мы сообщим, как только администратор примет решение.", ""];
    submitLines.push(`Номер заявки: ${formatRequestCode(meetingRequest)}`);
    submitLines.push(`Тема: ${meetingRequest.topic}`);
    submitLines.push(`Формат: ${meetingRequest.format === "ONLINE" ? "онлайн" : "оффлайн"}`);
    submitLines.push(`Длительность: ${meetingRequest.durationMinutes} мин.`);
    submitLines.push(`Дата и время: ${formatDateRangeMoscow(meetingRequest.startAt, meetingRequest.endAt)}`);
    if (meetingRequest.format === "OFFLINE") {
        submitLines.push(`Место: ${meetingRequest.location ?? "-"}`);
    }
    await ctx.reply(submitLines.join("\n"), {
        reply_markup: startMenuKeyboard(false)
    });
    const adminChatId = resolveAdminChatId();
    if (!adminChatId) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "approval_requested",
            status: "error",
            user_id: user.id,
            entity_id: meetingRequest.id,
            error_code: "ADMIN_TELEGRAM_ID_MISSING",
            error_message: "ADMIN_TELEGRAM_ID is not configured"
        });
        return;
    }
    try {
        await ctx.api.sendMessage(adminChatId, formatApprovalCard(meetingRequest, user), {
            reply_markup: approvalKeyboard(meetingRequest.id)
        });
        (0, logger_1.logEvent)({
            operation: "approval_requested",
            status: "ok",
            user_id: user.id,
            entity_id: meetingRequest.id
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "approval_requested",
            status: "error",
            user_id: user.id,
            entity_id: meetingRequest.id,
            error_code: "APPROVAL_NOTIFICATION_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to send approval request"
        });
    }
}
async function notifyUserAboutApprovalResult(input) {
    const chatId = Number(input.requester.telegramId);
    const lines = input.approved ? ["✅ Встреча подтверждена.", ""] : ["❌ Заявка отклонена.", ""];
    lines.push(`Номер заявки: ${formatRequestCode(input.request)}`);
    lines.push(`Тема: ${input.request.topic}`);
    lines.push(`Формат: ${input.request.format === "ONLINE" ? "онлайн" : "оффлайн"}`);
    lines.push(`Длительность: ${input.request.durationMinutes} мин.`);
    lines.push(`Дата и время: ${formatDateRangeMoscow(input.request.startAt, input.request.endAt)}`);
    if (input.request.format === "OFFLINE") {
        lines.push(`Место: ${input.request.location ?? "-"}`);
    }
    if (!input.approved && input.comment) {
        lines.push(`Комментарий: ${input.comment}`);
    }
    if (input.approved) {
        lines.push("Если планы изменятся, откройте «Мои заявки» и выберите действие.");
    }
    try {
        await input.ctx.api.sendMessage(chatId, lines.join("\n"), {
            reply_markup: myRequestsShortcutKeyboard()
        });
        (0, logger_1.logEvent)({
            operation: "user_notified",
            status: "ok",
            user_id: input.requester.id,
            entity_id: input.request.id,
            details: {
                decision: input.approved ? "approved" : "rejected"
            }
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "user_notified",
            status: "error",
            user_id: input.requester.id,
            entity_id: input.request.id,
            error_code: "USER_NOTIFICATION_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to notify user"
        });
    }
}
async function createCalendarEventForMeetingRequest(request) {
    if (!runtimeCalendarEventSyncProvider) {
        throw new Error("Google Calendar event sync provider is not configured");
    }
    const result = await runtimeCalendarEventSyncProvider.createEvent({
        externalRequestId: request.id,
        topic: request.topic,
        description: request.description ?? null,
        format: request.format,
        location: request.location ?? null,
        startAt: request.startAt,
        endAt: request.endAt,
        attendeeEmail: request.email,
        attendeeFirstName: request.firstName ?? null,
        attendeeLastName: request.lastName ?? null
    });
    return result;
}
async function approveMeetingRequest(ctx, meetingRequestId, adminActorId) {
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { user: true }
    });
    if (!request) {
        await ctx.reply("Заявка не найдена.");
        return;
    }
    if (request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            details: {
                action: "approval_confirm",
                status: request.status
            }
        });
        await ctx.reply("Эта заявка уже обработана ранее.");
        return;
    }
    let calendarEventResult;
    try {
        calendarEventResult = await createCalendarEventForMeetingRequest(request);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to create calendar event";
        await appendActionLog({
            meetingRequestId: request.id,
            userId: request.userId,
            actorRole: client_1.JournalActorRole.SYSTEM,
            actorId: "calendar_sync",
            actionType: client_1.JournalActionType.INTEGRATION_ERROR,
            details: {
                stage: "approval",
                error: errorMessage
            },
            result: "error"
        });
        (0, logger_1.logEvent)({
            level: "error",
            operation: "calendar_event_creation_failed",
            status: "error",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            error_code: "CALENDAR_EVENT_CREATE_FAILED",
            error_message: errorMessage
        });
        await ctx.reply("Не удалось создать событие в Google Calendar. Заявка оставлена на согласовании.");
        return;
    }
    await db_1.prisma.$transaction(async (tx) => {
        await tx.meetingRequest.update({
            where: { id: request.id },
            data: {
                status: client_1.MeetingRequestStatus.APPROVED,
                approverId: adminActorId,
                approverComment: null,
                resolvedAt: new Date()
            }
        });
        await tx.calendarEvent.upsert({
            where: { meetingRequestId: request.id },
            update: {
                googleCalendarEventId: calendarEventResult.googleCalendarEventId,
                googleCalendarId: calendarEventResult.googleCalendarId,
                googleMeetLink: calendarEventResult.googleMeetLink,
                syncStatus: client_1.CalendarEventSyncStatus.SYNCED,
                syncedAt: new Date(),
                lastErrorCode: null,
                lastErrorMessage: null
            },
            create: {
                meetingRequestId: request.id,
                googleCalendarEventId: calendarEventResult.googleCalendarEventId,
                googleCalendarId: calendarEventResult.googleCalendarId,
                googleMeetLink: calendarEventResult.googleMeetLink,
                syncStatus: client_1.CalendarEventSyncStatus.SYNCED,
                syncedAt: new Date()
            }
        });
        await tx.actionLog.create({
            data: {
                meetingRequestId: request.id,
                userId: request.userId,
                actorRole: client_1.JournalActorRole.ADMIN,
                actorId: adminActorId,
                actionType: client_1.JournalActionType.APPROVAL_CONFIRMED,
                details: {
                    calendar_event_id: calendarEventResult.googleCalendarEventId
                },
                result: "ok"
            }
        });
        await tx.actionLog.create({
            data: {
                meetingRequestId: request.id,
                userId: request.userId,
                actorRole: client_1.JournalActorRole.SYSTEM,
                actorId: "calendar_sync",
                actionType: client_1.JournalActionType.CALENDAR_EVENT_CREATED,
                details: {
                    calendar_event_id: calendarEventResult.googleCalendarEventId
                },
                result: "ok"
            }
        });
    });
    (0, logger_1.logEvent)({
        operation: "approval_confirmed",
        status: "ok",
        user_id: request.userId,
        actor_id: adminActorId,
        entity_id: request.id
    });
    (0, logger_1.logEvent)({
        operation: "calendar_event_created",
        status: "ok",
        user_id: request.userId,
        actor_id: adminActorId,
        entity_id: request.id,
        details: {
            calendar_event_id: calendarEventResult.googleCalendarEventId
        }
    });
    try {
        const cancelledJobsCount = await (0, jobs_1.cancelPendingApprovalReminderJobs)(request.id);
        (0, logger_1.logEvent)({
            operation: "approval_reminder_jobs_cancelled",
            status: "ok",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            details: {
                cancelled_jobs_count: cancelledJobsCount
            }
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "approval_reminder_jobs_cancelled",
            status: "error",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            error_code: "APPROVAL_REMINDER_JOB_CANCEL_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to cancel approval reminder jobs"
        });
    }
    try {
        await (0, jobs_1.scheduleDecisionEmailJob)(request.id);
        await (0, jobs_1.scheduleUpcomingReminderEmailJob)({
            ...request,
            status: client_1.MeetingRequestStatus.APPROVED
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "email_job_schedule_failed",
            status: "error",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            error_code: "EMAIL_JOB_CREATE_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to schedule email job"
        });
    }
    await ctx.reply(`Заявка ${formatRequestCode(request)} подтверждена.`);
    await notifyUserAboutApprovalResult({
        ctx,
        request,
        requester: request.user,
        approved: true
    });
}
async function rejectMeetingRequest(ctx, meetingRequestId, adminActorId, comment) {
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { user: true }
    });
    if (!request) {
        await ctx.reply("Заявка не найдена.");
        return;
    }
    if (request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            details: {
                action: "approval_reject",
                status: request.status
            }
        });
        await ctx.reply("Эта заявка уже обработана ранее.");
        return;
    }
    await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
        meetingRequestId: request.id,
        toStatus: client_1.MeetingRequestStatus.REJECTED,
        actorId: adminActorId,
        actorRole: client_1.JournalActorRole.ADMIN,
        comment
    });
    await appendActionLog({
        meetingRequestId: request.id,
        userId: request.userId,
        actorRole: client_1.JournalActorRole.ADMIN,
        actorId: adminActorId,
        actionType: client_1.JournalActionType.APPROVAL_REJECTED,
        details: {
            comment: comment ?? null
        },
        result: "ok"
    });
    (0, logger_1.logEvent)({
        operation: "approval_rejected",
        status: "ok",
        user_id: request.userId,
        actor_id: adminActorId,
        entity_id: request.id
    });
    try {
        const cancelledJobsCount = await (0, jobs_1.cancelPendingApprovalReminderJobs)(request.id);
        (0, logger_1.logEvent)({
            operation: "approval_reminder_jobs_cancelled",
            status: "ok",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            details: {
                cancelled_jobs_count: cancelledJobsCount
            }
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "approval_reminder_jobs_cancelled",
            status: "error",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            error_code: "APPROVAL_REMINDER_JOB_CANCEL_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to cancel approval reminder jobs"
        });
    }
    try {
        await (0, jobs_1.scheduleDecisionEmailJob)(request.id);
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "email_job_schedule_failed",
            status: "error",
            user_id: request.userId,
            actor_id: adminActorId,
            entity_id: request.id,
            error_code: "EMAIL_JOB_CREATE_FAILED",
            error_message: error instanceof Error ? error.message : "Failed to schedule email job"
        });
    }
    await ctx.reply(`Заявка ${formatRequestCode(request)} отклонена.`);
    await notifyUserAboutApprovalResult({
        ctx,
        request,
        requester: request.user,
        approved: false,
        comment
    });
}
async function cancelMeetingRequestByUser(ctx, user, meetingRequestId) {
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { calendarEvent: true }
    });
    if (!request || request.userId !== user.id) {
        await ctx.reply("Заявка не найдена.");
        return;
    }
    if (request.status !== client_1.MeetingRequestStatus.APPROVED &&
        request.status !== client_1.MeetingRequestStatus.RESCHEDULED &&
        request.status !== client_1.MeetingRequestStatus.RESCHEDULE_REQUESTED &&
        request.status !== client_1.MeetingRequestStatus.PENDING_APPROVAL) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: user.id,
            entity_id: request.id,
            details: {
                action: "cancel",
                status: request.status
            }
        });
        await ctx.reply("Эта заявка уже не может быть отменена.");
        return;
    }
    const lockKey = `request:${meetingRequestId}:cancel`;
    if (!acquireActionLock(lockKey)) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: user.id,
            entity_id: meetingRequestId,
            details: {
                action: "cancel",
                reason: "lock_busy"
            }
        });
        await ctx.reply("Действие уже выполняется, подождите несколько секунд.");
        return;
    }
    try {
        if (request.calendarEvent?.googleCalendarEventId) {
            if (!runtimeCalendarEventSyncProvider) {
                throw new Error("Google Calendar provider is not configured");
            }
            await runtimeCalendarEventSyncProvider.cancelEvent({
                externalRequestId: request.id,
                googleCalendarEventId: request.calendarEvent.googleCalendarEventId
            });
        }
        await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
            meetingRequestId: request.id,
            toStatus: client_1.MeetingRequestStatus.CANCELLED,
            actorId: user.telegramId,
            actorRole: client_1.JournalActorRole.USER
        });
        await db_1.prisma.$transaction(async (tx) => {
            if (request.calendarEvent) {
                await tx.calendarEvent.update({
                    where: { meetingRequestId: request.id },
                    data: {
                        syncStatus: client_1.CalendarEventSyncStatus.CANCELLED,
                        syncedAt: new Date(),
                        lastErrorCode: null,
                        lastErrorMessage: null
                    }
                });
                await tx.actionLog.create({
                    data: {
                        meetingRequestId: request.id,
                        userId: request.userId,
                        actorRole: client_1.JournalActorRole.SYSTEM,
                        actorId: "calendar_sync",
                        actionType: client_1.JournalActionType.CALENDAR_EVENT_DELETED,
                        details: {
                            calendar_event_id: request.calendarEvent.googleCalendarEventId
                        },
                        result: "ok"
                    }
                });
            }
            await tx.actionLog.create({
                data: {
                    meetingRequestId: request.id,
                    userId: request.userId,
                    actorRole: client_1.JournalActorRole.USER,
                    actorId: user.telegramId,
                    actionType: client_1.JournalActionType.CANCELLATION_COMPLETED,
                    details: {
                        source: "telegram_user_action"
                    },
                    result: "ok"
                }
            });
        });
        await (0, jobs_1.cancelPendingBackgroundJobsByTypes)(request.id, [
            client_1.BackgroundJobType.APPROVAL_REMINDER,
            client_1.BackgroundJobType.EMAIL_REMINDER
        ]);
        (0, logger_1.logEvent)({
            operation: "cancellation_completed",
            status: "ok",
            user_id: user.id,
            entity_id: request.id
        });
        pendingRescheduleByUser.delete(user.telegramId);
        await ctx.reply(`Заявка ${formatRequestCode(request)} отменена.`, {
            reply_markup: myRequestsShortcutKeyboard()
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "integration_error",
            status: "error",
            user_id: user.id,
            entity_id: meetingRequestId,
            error_code: "CANCEL_FLOW_FAILED",
            error_message: error instanceof Error ? error.message : "Cancel flow failed"
        });
        await ctx.reply("Не удалось отменить заявку сейчас. Попробуйте еще раз позже.");
    }
    finally {
        releaseActionLock(lockKey);
    }
}
async function requestRescheduleByUser(ctx, user, meetingRequestId) {
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId }
    });
    if (!request || request.userId !== user.id) {
        await ctx.reply("Заявка не найдена.");
        return;
    }
    if (request.status !== client_1.MeetingRequestStatus.APPROVED && request.status !== client_1.MeetingRequestStatus.RESCHEDULED) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: user.id,
            entity_id: request.id,
            details: {
                action: "reschedule",
                status: request.status
            }
        });
        await ctx.reply("Перенос доступен только для подтвержденной встречи.");
        return;
    }
    const slots = await (0, slots_1.buildAvailableSlots)({
        durationMinutes: request.durationMinutes,
        excludeMeetingRequestId: request.id
    });
    if (slots.length === 0) {
        await ctx.reply("Свободные слоты для переноса не найдены в ближайшие 30 дней.");
        return;
    }
    pendingRescheduleByUser.set(user.telegramId, request.id);
    (0, logger_1.logEvent)({
        operation: "reschedule_requested",
        status: "ok",
        user_id: user.id,
        entity_id: request.id
    });
    await appendActionLog({
        meetingRequestId: request.id,
        userId: user.id,
        actorRole: client_1.JournalActorRole.USER,
        actorId: user.telegramId,
        actionType: client_1.JournalActionType.RESCHEDULE_REQUESTED,
        details: {
            source: "telegram_user_action"
        }
    });
    await ctx.reply("Выберите новый слот:", {
        reply_markup: rescheduleSlotsKeyboard(request.id, slots)
    });
}
async function completeRescheduleByUser(ctx, user, meetingRequestId, slotIndex) {
    const pendingId = pendingRescheduleByUser.get(user.telegramId);
    if (!pendingId || pendingId !== meetingRequestId) {
        await ctx.reply("Для переноса сначала нажмите «Перенести» в разделе «Мои заявки».");
        return;
    }
    const request = await db_1.prisma.meetingRequest.findUnique({
        where: { id: meetingRequestId },
        include: { calendarEvent: true }
    });
    if (!request || request.userId !== user.id) {
        pendingRescheduleByUser.delete(user.telegramId);
        await ctx.reply("Заявка не найдена.");
        return;
    }
    if (request.status !== client_1.MeetingRequestStatus.APPROVED && request.status !== client_1.MeetingRequestStatus.RESCHEDULED) {
        pendingRescheduleByUser.delete(user.telegramId);
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: user.id,
            entity_id: request.id,
            details: {
                action: "reschedule_complete",
                status: request.status
            }
        });
        await ctx.reply("Эта встреча сейчас не может быть перенесена.");
        return;
    }
    const lockKey = `request:${meetingRequestId}:reschedule`;
    if (!acquireActionLock(lockKey)) {
        (0, logger_1.logEvent)({
            operation: "duplicate_action_ignored",
            status: "ok",
            user_id: user.id,
            entity_id: meetingRequestId,
            details: {
                action: "reschedule_complete",
                reason: "lock_busy"
            }
        });
        await ctx.reply("Действие уже выполняется, подождите несколько секунд.");
        return;
    }
    try {
        const slots = await (0, slots_1.buildAvailableSlots)({
            durationMinutes: request.durationMinutes,
            excludeMeetingRequestId: request.id
        });
        const selectedSlot = slots[slotIndex];
        if (!selectedSlot) {
            await ctx.reply("Выбранный слот недоступен. Нажмите «Перенести» и выберите заново.");
            return;
        }
        const slotStillAvailable = await (0, slots_1.ensureSlotStillAvailable)({
            startAt: selectedSlot.startAt,
            endAt: selectedSlot.endAt,
            excludeMeetingRequestId: request.id
        });
        if (!slotStillAvailable) {
            await ctx.reply("Этот слот уже занят. Нажмите «Перенести» и выберите другой.");
            return;
        }
        if (!runtimeCalendarEventSyncProvider || !request.calendarEvent?.googleCalendarEventId) {
            throw new Error("Calendar event for reschedule is not configured");
        }
        const calendarEventResult = await runtimeCalendarEventSyncProvider.updateEvent({
            externalRequestId: request.id,
            googleCalendarEventId: request.calendarEvent.googleCalendarEventId,
            topic: request.topic,
            description: request.description ?? null,
            format: request.format,
            location: request.location ?? null,
            startAt: selectedSlot.startAt,
            endAt: selectedSlot.endAt,
            attendeeEmail: request.email,
            attendeeFirstName: request.firstName ?? null,
            attendeeLastName: request.lastName ?? null
        });
        await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
            meetingRequestId: request.id,
            toStatus: client_1.MeetingRequestStatus.RESCHEDULE_REQUESTED,
            actorId: user.telegramId,
            actorRole: client_1.JournalActorRole.USER
        });
        await db_1.prisma.meetingRequest.update({
            where: { id: request.id },
            data: {
                startAt: selectedSlot.startAt,
                endAt: selectedSlot.endAt
            }
        });
        await (0, meeting_request_status_1.transitionMeetingRequestStatus)({
            meetingRequestId: request.id,
            toStatus: client_1.MeetingRequestStatus.RESCHEDULED,
            actorId: user.telegramId,
            actorRole: client_1.JournalActorRole.USER
        });
        await db_1.prisma.$transaction(async (tx) => {
            await tx.calendarEvent.update({
                where: { meetingRequestId: request.id },
                data: {
                    googleCalendarEventId: calendarEventResult.googleCalendarEventId,
                    googleCalendarId: calendarEventResult.googleCalendarId,
                    googleMeetLink: calendarEventResult.googleMeetLink,
                    syncStatus: client_1.CalendarEventSyncStatus.UPDATED,
                    syncedAt: new Date(),
                    lastErrorCode: null,
                    lastErrorMessage: null
                }
            });
            await tx.actionLog.create({
                data: {
                    meetingRequestId: request.id,
                    userId: request.userId,
                    actorRole: client_1.JournalActorRole.SYSTEM,
                    actorId: "calendar_sync",
                    actionType: client_1.JournalActionType.CALENDAR_EVENT_UPDATED,
                    details: {
                        calendar_event_id: calendarEventResult.googleCalendarEventId
                    },
                    result: "ok"
                }
            });
            await tx.actionLog.create({
                data: {
                    meetingRequestId: request.id,
                    userId: request.userId,
                    actorRole: client_1.JournalActorRole.USER,
                    actorId: user.telegramId,
                    actionType: client_1.JournalActionType.RESCHEDULED,
                    details: {
                        old_start_at: request.startAt.toISOString(),
                        old_end_at: request.endAt.toISOString(),
                        new_start_at: selectedSlot.startAt.toISOString(),
                        new_end_at: selectedSlot.endAt.toISOString()
                    },
                    result: "ok"
                }
            });
        });
        await (0, jobs_1.cancelPendingBackgroundJobsByTypes)(request.id, [client_1.BackgroundJobType.EMAIL_REMINDER]);
        const updatedRequest = await db_1.prisma.meetingRequest.findUnique({
            where: { id: request.id }
        });
        if (updatedRequest) {
            await (0, jobs_1.scheduleUpcomingReminderEmailJob)(updatedRequest);
        }
        (0, logger_1.logEvent)({
            operation: "reschedule_completed",
            status: "ok",
            user_id: user.id,
            entity_id: request.id,
            details: {
                new_start_at: selectedSlot.startAt.toISOString(),
                new_end_at: selectedSlot.endAt.toISOString()
            }
        });
        pendingRescheduleByUser.delete(user.telegramId);
        await ctx.reply(`Встреча перенесена.\nНомер заявки: ${formatRequestCode(request)}\nНовое время: ${formatDateRangeMoscow(selectedSlot.startAt, selectedSlot.endAt)}`, {
            reply_markup: myRequestsShortcutKeyboard()
        });
    }
    catch (error) {
        (0, logger_1.logEvent)({
            level: "error",
            operation: "integration_error",
            status: "error",
            user_id: user.id,
            entity_id: meetingRequestId,
            error_code: "RESCHEDULE_FLOW_FAILED",
            error_message: error instanceof Error ? error.message : "Reschedule flow failed"
        });
        await ctx.reply("Не удалось перенести встречу сейчас. Попробуйте еще раз позже.");
    }
    finally {
        releaseActionLock(lockKey);
    }
}
async function tryHandlePendingRejectionComment(ctx, user) {
    const pendingRequestId = pendingRejectionCommentByAdmin.get(user.telegramId);
    if (!pendingRequestId) {
        return false;
    }
    if (!ctx.message || !("text" in ctx.message) || typeof ctx.message.text !== "string") {
        return false;
    }
    const text = ctx.message.text.trim();
    const comment = text === "-" ? null : text;
    pendingRejectionCommentByAdmin.delete(user.telegramId);
    await rejectMeetingRequest(ctx, pendingRequestId, user.telegramId, comment);
    return true;
}
async function handleTextInput(ctx, user) {
    if (!ctx.message || !("text" in ctx.message)) {
        return;
    }
    const messageText = ctx.message.text;
    if (typeof messageText !== "string") {
        return;
    }
    const text = messageText.trim();
    const draft = await getActiveDraft(user.id);
    if (!draft) {
        await showStartMenu(ctx, user);
        return;
    }
    const payload = parseDraftPayload(draft.payload);
    const currentStep = draft.currentStep;
    if (currentStep === "topic") {
        if (text.length < 3) {
            (0, logger_1.logEvent)({
                operation: "validation_failed",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "TOPIC_TOO_SHORT",
                error_message: "Topic must contain at least 3 symbols"
            });
            await ctx.reply("Тема слишком короткая. Введите минимум 3 символа.");
            return;
        }
        payload.topic = text;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    if (currentStep === "description") {
        payload.description = text === "-" ? null : text;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    if (currentStep === "email") {
        const parsed = EMAIL_SCHEMA.safeParse(text);
        if (!parsed.success) {
            (0, logger_1.logEvent)({
                operation: "validation_failed",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "INVALID_EMAIL",
                error_message: "Invalid email format"
            });
            await ctx.reply("Некорректный email. Введите email в формате name@example.com");
            return;
        }
        payload.email = parsed.data;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    if (currentStep === "first_name") {
        if (text.length < 2) {
            (0, logger_1.logEvent)({
                operation: "validation_failed",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "FIRST_NAME_TOO_SHORT",
                error_message: "First name must contain at least 2 symbols"
            });
            await ctx.reply("Имя слишком короткое. Введите минимум 2 символа.");
            return;
        }
        payload.firstName = text;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    if (currentStep === "last_name") {
        if (text.length < 2) {
            (0, logger_1.logEvent)({
                operation: "validation_failed",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "LAST_NAME_TOO_SHORT",
                error_message: "Last name must contain at least 2 symbols"
            });
            await ctx.reply("Фамилия слишком короткая. Введите минимум 2 символа.");
            return;
        }
        payload.lastName = text;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    if (currentStep === "location") {
        if (text.length < 3) {
            (0, logger_1.logEvent)({
                operation: "validation_failed",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "LOCATION_TOO_SHORT",
                error_message: "Location must contain at least 3 symbols"
            });
            await ctx.reply("Адрес слишком короткий. Введите минимум 3 символа.");
            return;
        }
        payload.location = text;
        await transitionToStep(ctx, user, draft, payload, getNextStep(payload));
        return;
    }
    await ctx.reply(`Сейчас активный шаг: ${getStepTitle(currentStep)}. Используйте кнопки ниже.`, {
        reply_markup: navKeyboard(currentStep !== "duration")
    });
}
function configureDryRunApi(bot) {
    let messageId = 1;
    const ok = (result) => ({ ok: true, result });
    bot.api.config.use(async (_prev, method, payload) => {
        if (method === "getMe") {
            return ok(bot.botInfo);
        }
        if (method === "answerCallbackQuery") {
            return ok(true);
        }
        if (method === "sendMessage" || method === "editMessageText") {
            const chatId = Number(payload.chat_id ?? 1);
            const text = String(payload.text ?? "");
            return ok({
                message_id: messageId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chatId, type: "private" },
                text
            });
        }
        return ok(true);
    });
}
function createTelegramBotRuntime(options) {
    runtimeCalendarEventSyncProvider =
        options.calendarEventSyncProvider === undefined
            ? (0, google_calendar_1.createGoogleCalendarEventSyncProvider)()
            : options.calendarEventSyncProvider;
    runtimeAdminTelegramId = options.adminTelegramId === undefined ? (0, env_1.getApprovalConfig)().adminTelegramId : options.adminTelegramId;
    pendingRejectionCommentByAdmin.clear();
    pendingRescheduleByUser.clear();
    actionLocks.clear();
    rateLimitMap.clear();
    const bot = new grammy_1.Bot(options.botToken, {
        botInfo: buildBotInfoFromToken(options.botToken)
    });
    if (options.dryRun) {
        configureDryRunApi(bot);
    }
    bot.catch((error) => {
        const nestedErrorMessage = isRecord(error) && isRecord(error.error) && typeof error.error.message === "string"
            ? error.error.message
            : null;
        const fallbackMessage = error instanceof Error ? error.message : "Unknown Telegram bot error";
        (0, logger_1.logEvent)({
            level: "error",
            operation: "startup_error",
            status: "error",
            error_code: "TELEGRAM_BOT_ERROR",
            error_message: nestedErrorMessage ?? fallbackMessage
        });
    });
    bot.use(async (ctx, next) => {
        const updateId = ctx.update?.update_id;
        if (typeof updateId === "number" && isDuplicateUpdate(updateId)) {
            (0, logger_1.logEvent)({
                operation: "duplicate_update_ignored",
                status: "ok",
                details: {
                    update_id: updateId
                }
            });
            return;
        }
        if (!ctx.state) {
            ctx.state = {};
        }
        const user = await upsertUserFromContext(ctx);
        if (user) {
            ctx.state.appUser = user;
        }
        await next();
    });
    bot.command("start", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "command:start", ANTI_SPAM_SHORT_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "command:start"
                }
            });
            return;
        }
        if (!user.personalDataConsentGiven) {
            await showConsent(ctx);
            return;
        }
        await showStartMenu(ctx, user);
    });
    bot.command("history", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "command:history", ANTI_SPAM_SHORT_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "command:history"
                }
            });
            return;
        }
        await showHistory(ctx, user);
    });
    bot.command("my", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "command:my", ANTI_SPAM_SHORT_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "command:my"
                }
            });
            return;
        }
        await showHistory(ctx, user);
    });
    bot.command("admin", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (!isAdminActor(ctx)) {
            await ctx.reply("Команда доступна только администратору.");
            return;
        }
        await showAdminSettingsPanel(ctx);
    });
    bot.command("all", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (!isAdminActor(ctx)) {
            await ctx.reply("Команда доступна только администратору.");
            return;
        }
        await showAllRequestsForAdmin(ctx);
    });
    bot.command("version", async (ctx) => {
        await ctx.reply(`Версия: ${BOT_BUILD_LABEL}\nPID: ${process.pid}`);
    });
    bot.command("app", async (ctx) => {
        const miniAppConfig = (0, env_1.getMiniAppConfig)();
        const webAppUrl = miniAppConfig.webAppUrl?.trim();
        if (!miniAppConfig.enabled || !webAppUrl) {
            await ctx.reply("Mini app пока не включен.");
            return;
        }
        await ctx.reply(`Открыть mini app: ${webAppUrl}`);
    });
    bot.callbackQuery(ACTION.CONSENT_ACCEPT, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const updatedUser = await db_1.prisma.user.update({
            where: { id: user.id },
            data: {
                personalDataConsentGiven: true,
                personalDataConsentAt: new Date()
            }
        });
        await ctx.reply("Согласие сохранено. Теперь можно оформить заявку.");
        await showStartMenu(ctx, updatedUser);
    });
    bot.callbackQuery(ACTION.MENU_NEW, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (!user.personalDataConsentGiven) {
            await showConsent(ctx);
            return;
        }
        await startWizard(ctx, user);
    });
    bot.callbackQuery(ACTION.MENU_HISTORY, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        await showHistory(ctx, user);
    });
    bot.callbackQuery(ACTION.MENU_ADMIN_ALL, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (!isAdminActor(ctx)) {
            await ctx.reply("Доступно только администратору.");
            return;
        }
        await showAllRequestsForAdmin(ctx);
    });
    bot.callbackQuery(ACTION.MENU_RESUME, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        await restoreDraft(ctx, user, draft);
    });
    bot.callbackQuery(ACTION.MENU_RESTART, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        await startWizard(ctx, user);
    });
    bot.callbackQuery(ACTION.NAV_CANCEL, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        await cancelWizard(ctx, user);
    });
    bot.callbackQuery(ACTION.NAV_BACK, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        await handleBackAction(ctx, user);
    });
    bot.callbackQuery(/^dur:(15|30|45|60|90)$/, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        const value = Number(ctx.match[1]);
        const payload = parseDraftPayload(draft.payload);
        payload.durationMinutes = value;
        payload.slotStartAt = undefined;
        payload.slotEndAt = undefined;
        const nextStep = payload.format ? "slot" : "format";
        await transitionToStep(ctx, user, draft, payload, nextStep);
    });
    bot.callbackQuery(/^fmt:(ONLINE|OFFLINE)$/, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        const value = ctx.match[1];
        const payload = parseDraftPayload(draft.payload);
        payload.format = value;
        if (value === "ONLINE") {
            payload.location = undefined;
        }
        await transitionToStep(ctx, user, draft, payload, "slot");
    });
    bot.callbackQuery(/^slot:(\d+)$/, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        const payload = parseDraftPayload(draft.payload);
        if (!payload.durationMinutes) {
            await transitionToStep(ctx, user, draft, payload, "duration");
            return;
        }
        let slots;
        try {
            slots = await (0, slots_1.buildAvailableSlots)({
                durationMinutes: payload.durationMinutes
            });
        }
        catch {
            await ctx.reply("Не удалось получить доступные слоты из календаря. Попробуйте позже.");
            return;
        }
        const index = Number(ctx.match[1]);
        const selected = slots[index];
        if (!selected) {
            (0, logger_1.logEvent)({
                level: "warn",
                operation: "slot_conflict_detected",
                status: "error",
                user_id: user.id,
                entity_id: draft.id,
                error_code: "SLOT_NOT_FOUND",
                error_message: "Selected slot is unavailable after refresh"
            });
            await ctx.reply("Выбранный слот уже недоступен. Выберите другой вариант.");
            await showStepPrompt(ctx, "slot", payload);
            return;
        }
        payload.slotStartAt = selected.startAt.toISOString();
        payload.slotEndAt = selected.endAt.toISOString();
        const nextStep = getNextStep(payload);
        await transitionToStep(ctx, user, draft, payload, nextStep);
    });
    bot.callbackQuery(/^edit:(duration|format|slot|topic|description|email|first_name|last_name|location)$/, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        const payload = parseDraftPayload(draft.payload);
        const step = ctx.match[1];
        await transitionToStep(ctx, user, draft, payload, step);
    });
    bot.callbackQuery(ACTION.REVIEW_SUBMIT, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "review_submit", ANTI_SPAM_SUBMIT_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "review_submit"
                }
            });
            await ctx.reply("Слишком частые отправки. Подождите несколько секунд и повторите.");
            return;
        }
        const draft = await getActiveDraft(user.id);
        if (!draft) {
            await showStartMenu(ctx, user);
            return;
        }
        const payload = parseDraftPayload(draft.payload);
        await submitMeetingRequest(ctx, user, draft, payload);
    });
    bot.callbackQuery(APPROVAL_ACTION_PATTERN, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        if (!isAdminActor(ctx)) {
            await ctx.reply("Это действие доступно только администратору.");
            return;
        }
        const decision = ctx.match[1];
        const meetingRequestId = ctx.match[2];
        const adminActorId = String(ctx.from?.id ?? "");
        if (!adminActorId) {
            await ctx.reply("Не удалось определить администратора.");
            return;
        }
        if (decision === "confirm") {
            pendingRejectionCommentByAdmin.delete(adminActorId);
            await approveMeetingRequest(ctx, meetingRequestId, adminActorId);
            return;
        }
        pendingRejectionCommentByAdmin.set(adminActorId, meetingRequestId);
        const meetingRequest = await db_1.prisma.meetingRequest.findUnique({
            where: { id: meetingRequestId },
            select: { createdAt: true }
        });
        const requestCode = meetingRequest ? formatRequestCode(meetingRequest) : meetingRequestId;
        await ctx.reply(`Введите комментарий к отклонению для заявки ${requestCode}.\nОтправьте «-», если без комментария.`);
    });
    bot.callbackQuery(REQUEST_ACTION_PATTERN, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "request_action", ANTI_SPAM_ACTION_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "request_action"
                }
            });
            await ctx.reply("Слишком частые нажатия. Подождите пару секунд.");
            return;
        }
        const action = ctx.match[1];
        const meetingRequestId = ctx.match[2];
        if (action === "cancel") {
            await cancelMeetingRequestByUser(ctx, user, meetingRequestId);
            return;
        }
        await requestRescheduleByUser(ctx, user, meetingRequestId);
    });
    bot.callbackQuery(RESCHEDULE_SLOT_PATTERN, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (isRateLimited(user.telegramId, "reschedule_slot", ANTI_SPAM_ACTION_MS)) {
            (0, logger_1.logEvent)({
                operation: "anti_spam_limit_reached",
                status: "ok",
                user_id: user.id,
                details: {
                    action: "reschedule_slot"
                }
            });
            await ctx.reply("Слишком частые нажатия. Подождите пару секунд.");
            return;
        }
        const meetingRequestId = ctx.match[1];
        const slotIndex = Number(ctx.match[2]);
        await completeRescheduleByUser(ctx, user, meetingRequestId, slotIndex);
    });
    bot.callbackQuery(ADMIN_SETTINGS_ACTION_PATTERN, async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
        if (!isAdminActor(ctx)) {
            await ctx.reply("Это действие доступно только администратору.");
            return;
        }
        const mode = ctx.match[1];
        const key = ctx.match[2];
        const delta = Number(ctx.match[3] ?? "0");
        if (mode === "open") {
            await showAdminSettingsPanel(ctx);
            return;
        }
        await changeAdminSetting(ctx, key, delta);
    });
    bot.on("message:text", async (ctx) => {
        const user = ctx.state.appUser;
        if (!user) {
            return;
        }
        if (ctx.message.text.startsWith("/start")) {
            return;
        }
        if (ctx.message.text.startsWith("/history")) {
            await showHistory(ctx, user);
            return;
        }
        if (ctx.message.text.startsWith("/my")) {
            await showHistory(ctx, user);
            return;
        }
        if (ctx.message.text.startsWith("/admin")) {
            if (!isAdminActor(ctx)) {
                await ctx.reply("Команда доступна только администратору.");
                return;
            }
            await showAdminSettingsPanel(ctx);
            return;
        }
        if (await tryHandlePendingRejectionComment(ctx, user)) {
            return;
        }
        await handleTextInput(ctx, user);
    });
    bot.on("callback_query:data", async (ctx) => {
        await safeAnswerCallbackQuery(ctx);
    });
    const webhookHandler = (0, grammy_1.webhookCallback)(bot, "fastify", {
        secretToken: options.webhookSecretToken ?? undefined,
        onTimeout: "return"
    });
    return {
        bot,
        webhookHandler
    };
}
function getTelegramRuntime() {
    const config = (0, env_1.getTelegramConfig)();
    if (!config.botToken) {
        return null;
    }
    if (runtimeCache && runtimeCacheToken === config.botToken) {
        return runtimeCache;
    }
    runtimeCache = createTelegramBotRuntime({
        botToken: config.botToken,
        webhookSecretToken: config.webhookSecretToken
    });
    runtimeCacheToken = config.botToken;
    return runtimeCache;
}
async function ensureWizardStateForUser(userTelegramId) {
    const user = await db_1.prisma.user.findUnique({ where: { telegramId: userTelegramId } });
    if (!user) {
        return { draft: null, requests: [] };
    }
    const draft = await getActiveDraft(user.id);
    const requests = await db_1.prisma.meetingRequest.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 4
    });
    return { draft, requests };
}
