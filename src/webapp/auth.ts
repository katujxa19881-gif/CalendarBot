import { createHmac, timingSafeEqual } from "node:crypto";
import { User } from "@prisma/client";
import { prisma } from "../db";
import { getApprovalConfig, getMiniAppConfig, getTelegramConfig } from "../env";

type ParsedTelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type VerifiedInitData = {
  telegramUser: ParsedTelegramUser;
  authDate: Date;
};

type MiniAppSessionPayload = {
  telegramId: string;
  role: "user" | "admin";
  exp: number;
};

export class MiniAppAuthError extends Error {
  public readonly code:
    | "MINI_APP_DISABLED"
    | "BOT_TOKEN_MISSING"
    | "INIT_DATA_INVALID"
    | "INIT_DATA_HASH_INVALID"
    | "INIT_DATA_EXPIRED"
    | "SESSION_SECRET_MISSING"
    | "SESSION_INVALID"
    | "SESSION_EXPIRED";

  public constructor(
    code:
      | "MINI_APP_DISABLED"
      | "BOT_TOKEN_MISSING"
      | "INIT_DATA_INVALID"
      | "INIT_DATA_HASH_INVALID"
      | "INIT_DATA_EXPIRED"
      | "SESSION_SECRET_MISSING"
      | "SESSION_INVALID"
      | "SESSION_EXPIRED",
    message: string
  ) {
    super(message);
    this.name = "MiniAppAuthError";
    this.code = code;
  }
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function buildRole(telegramId: string): "user" | "admin" {
  const { adminTelegramId } = getApprovalConfig();
  return adminTelegramId && telegramId === adminTelegramId ? "admin" : "user";
}

function parseInitData(initDataRaw: string): URLSearchParams {
  const parsed = new URLSearchParams(initDataRaw);
  if (!parsed.get("hash")) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData hash is missing");
  }
  if (!parsed.get("user")) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData user is missing");
  }
  if (!parsed.get("auth_date")) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData auth_date is missing");
  }
  return parsed;
}

function assertFeatureEnabled(): void {
  const miniAppConfig = getMiniAppConfig();
  if (!miniAppConfig.enabled) {
    throw new MiniAppAuthError("MINI_APP_DISABLED", "Mini app is disabled");
  }
}

function verifyInitData(initDataRaw: string): VerifiedInitData {
  assertFeatureEnabled();

  const { botToken } = getTelegramConfig();
  if (!botToken) {
    throw new MiniAppAuthError("BOT_TOKEN_MISSING", "TELEGRAM_BOT_TOKEN is required");
  }

  const miniAppConfig = getMiniAppConfig();
  const parsed = parseInitData(initDataRaw);
  const receivedHash = parsed.get("hash");
  if (!receivedHash) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData hash is missing");
  }

  const entries: string[] = [];
  parsed.forEach((value, key) => {
    if (key !== "hash") {
      entries.push(`${key}=${value}`);
    }
  });
  entries.sort((a, b) => a.localeCompare(b));
  const dataCheckString = entries.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const calculatedBuffer = Buffer.from(calculatedHash, "hex");
  const receivedBuffer = Buffer.from(receivedHash, "hex");

  if (calculatedBuffer.length !== receivedBuffer.length || !timingSafeEqual(calculatedBuffer, receivedBuffer)) {
    throw new MiniAppAuthError("INIT_DATA_HASH_INVALID", "initData hash mismatch");
  }

  const authDateRaw = parsed.get("auth_date");
  const authDateSeconds = Number(authDateRaw);
  if (!Number.isFinite(authDateSeconds)) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData auth_date is invalid");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDateSeconds > miniAppConfig.authMaxAgeSeconds) {
    throw new MiniAppAuthError("INIT_DATA_EXPIRED", "initData expired");
  }

  let telegramUser: ParsedTelegramUser;
  try {
    telegramUser = JSON.parse(parsed.get("user") ?? "{}") as ParsedTelegramUser;
  } catch {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData user payload is invalid JSON");
  }

  if (!telegramUser || !Number.isFinite(telegramUser.id)) {
    throw new MiniAppAuthError("INIT_DATA_INVALID", "initData user id is invalid");
  }

  return {
    telegramUser,
    authDate: new Date(authDateSeconds * 1000)
  };
}

function getSessionSecret(): string {
  const miniAppConfig = getMiniAppConfig();
  if (!miniAppConfig.sessionSecret) {
    throw new MiniAppAuthError("SESSION_SECRET_MISSING", "Mini app session secret is not configured");
  }
  return miniAppConfig.sessionSecret;
}

function signTokenPart(payloadBase64: string): string {
  const secret = getSessionSecret();
  return createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

function createSessionToken(payload: MiniAppSessionPayload): string {
  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = signTokenPart(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

function parseSessionToken(token: string): MiniAppSessionPayload {
  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) {
    throw new MiniAppAuthError("SESSION_INVALID", "Session token format is invalid");
  }

  const expectedSignature = signTokenPart(payloadBase64);
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new MiniAppAuthError("SESSION_INVALID", "Session token signature is invalid");
  }

  let payload: MiniAppSessionPayload;
  try {
    payload = JSON.parse(fromBase64Url(payloadBase64)) as MiniAppSessionPayload;
  } catch {
    throw new MiniAppAuthError("SESSION_INVALID", "Session payload JSON is invalid");
  }

  if (!payload.telegramId || !payload.role || !payload.exp) {
    throw new MiniAppAuthError("SESSION_INVALID", "Session payload fields are missing");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new MiniAppAuthError("SESSION_EXPIRED", "Session token expired");
  }

  return payload;
}

async function upsertUserFromWebApp(input: ParsedTelegramUser): Promise<User> {
  const telegramId = String(input.id);
  return prisma.user.upsert({
    where: { telegramId },
    update: {
      username: input.username ?? null,
      firstName: input.first_name ?? null,
      lastName: input.last_name ?? null
    },
    create: {
      telegramId,
      username: input.username ?? null,
      firstName: input.first_name ?? null,
      lastName: input.last_name ?? null
    }
  });
}

export async function authenticateMiniApp(initDataRaw: string): Promise<{
  token: string;
  expiresAt: string;
  role: "user" | "admin";
  user: User;
}> {
  const verified = verifyInitData(initDataRaw);
  const user = await upsertUserFromWebApp(verified.telegramUser);
  const miniAppConfig = getMiniAppConfig();
  const role = buildRole(user.telegramId);

  if (role === "admin" && !miniAppConfig.adminEnabled) {
    throw new MiniAppAuthError("MINI_APP_DISABLED", "Mini app admin mode is disabled");
  }

  const exp = Math.floor(Date.now() / 1000) + miniAppConfig.sessionTtlSeconds;
  const token = createSessionToken({
    telegramId: user.telegramId,
    role,
    exp
  });

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    role,
    user
  };
}

export async function verifyMiniAppSessionToken(token: string): Promise<{
  user: User;
  role: "user" | "admin";
}> {
  assertFeatureEnabled();
  const payload = parseSessionToken(token);
  const user = await prisma.user.findUnique({
    where: {
      telegramId: payload.telegramId
    }
  });

  if (!user) {
    throw new MiniAppAuthError("SESSION_INVALID", "Session user was not found");
  }

  const role = buildRole(user.telegramId);
  if (payload.role !== role) {
    throw new MiniAppAuthError("SESSION_INVALID", "Session role is no longer valid");
  }

  return {
    user,
    role
  };
}
