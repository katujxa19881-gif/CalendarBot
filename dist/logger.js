"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logEvent = logEvent;
function logEvent(payload) {
    const entry = {
        timestamp: new Date().toISOString(),
        level: payload.level ?? "info",
        operation: payload.operation,
        request_id: payload.request_id ?? null,
        user_id: payload.user_id ?? null,
        actor_id: payload.actor_id ?? null,
        entity_id: payload.entity_id ?? null,
        status: payload.status ?? null,
        error_code: payload.error_code ?? null,
        error_message: payload.error_message ?? null,
        ...payload.details
    };
    console.log(JSON.stringify(entry));
}
