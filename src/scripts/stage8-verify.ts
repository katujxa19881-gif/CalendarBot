import { execSync } from "node:child_process";
import {
  getApprovalConfig,
  getBackgroundJobsConfig,
  getEmailConfig,
  getGoogleCalendarConfig,
  getTelegramConfig,
  resolveDatabaseUrl
} from "../env";

type CheckResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function runCommand(command: string): void {
  execSync(command, {
    stdio: "pipe",
    env: {
      ...process.env,
      DISABLE_ANTI_SPAM: "true"
    }
  });
}

function validateProductionConfig(): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const telegram = getTelegramConfig();
  const google = getGoogleCalendarConfig();
  const email = getEmailConfig();
  const approval = getApprovalConfig();
  const jobs = getBackgroundJobsConfig();
  const transport = (process.env.TELEGRAM_TRANSPORT ?? "polling").trim().toLowerCase();

  if (!telegram.botToken) {
    errors.push("TELEGRAM_BOT_TOKEN is not configured");
  }

  if (!approval.adminTelegramId) {
    errors.push("ADMIN_TELEGRAM_ID is not configured");
  }

  if (!google.enabled) {
    errors.push("Google Calendar OAuth config is incomplete");
  }

  if (!email.enabled) {
    errors.push("SENDGRID_API_KEY is not configured");
  }

  if (!email.fromEmail || email.fromEmail === "no-reply@example.com") {
    errors.push("SENDGRID_FROM_EMAIL is not configured with a real sender");
  }

  if (!jobs.enabled) {
    errors.push("BACKGROUND_JOBS_ENABLED is disabled");
  }

  if (transport !== "polling" && transport !== "webhook" && transport !== "auto") {
    errors.push("TELEGRAM_TRANSPORT must be one of: polling, webhook, auto");
  }

  if (transport === "webhook" && !telegram.webhookSecretToken) {
    errors.push("TELEGRAM_WEBHOOK_SECRET must be configured for webhook transport");
  }

  if (transport === "polling") {
    warnings.push("TELEGRAM_TRANSPORT=polling (for production public webhook is recommended)");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

async function run(): Promise<void> {
  resolveDatabaseUrl();

  const executed: string[] = [];
  const scriptCommands = [
    "npm run build",
    "npm run stage3:verify",
    "npm run stage4:verify",
    "npm run stage5:verify",
    "npm run stage6:verify",
    "npm run stage7:verify",
    "npm run google:check"
  ];

  for (const command of scriptCommands) {
    runCommand(command);
    executed.push(command);
  }

  const config = validateProductionConfig();
  if (!config.ok) {
    throw new Error(`Production config check failed: ${config.errors.join("; ")}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        stage: 8,
        executed,
        warnings: config.warnings
      },
      null,
      2
    )
  );
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        ok: false,
        stage: 8,
        error: message
      },
      null,
      2
    )
  );
  process.exit(1);
});
