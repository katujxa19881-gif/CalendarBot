export type LogStatus = "ok" | "error" | "received";

type LogPayload = {
  level?: "info" | "warn" | "error";
  operation: string;
  request_id?: string | null;
  user_id?: string | null;
  actor_id?: string | null;
  entity_id?: string | null;
  status?: LogStatus;
  error_code?: string | null;
  error_message?: string | null;
  details?: Record<string, unknown>;
};

export function logEvent(payload: LogPayload): void {
  const entry: Record<string, unknown> = {
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
