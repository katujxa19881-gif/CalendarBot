import { getEmailConfig } from "../env";

export type OutgoingEmail = {
  toEmail: string;
  toName?: string | null;
  subject: string;
  text: string;
  html?: string;
};

export type EmailSendResult = {
  providerMessageId: string | null;
};

export interface EmailProvider {
  send(email: OutgoingEmail): Promise<EmailSendResult>;
}

class SendGridEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string | null;

  public constructor(input: { apiKey: string; fromEmail: string; fromName: string | null }) {
    this.apiKey = input.apiKey;
    this.fromEmail = input.fromEmail;
    this.fromName = input.fromName;
  }

  public async send(email: OutgoingEmail): Promise<EmailSendResult> {
    const content: Array<{ type: string; value: string }> = [{ type: "text/plain", value: email.text }];
    if (email.html) {
      content.push({ type: "text/html", value: email.html });
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [
              {
                email: email.toEmail,
                name: email.toName ?? undefined
              }
            ]
          }
        ],
        from: {
          email: this.fromEmail,
          name: this.fromName ?? undefined
        },
        subject: email.subject,
        content
      })
    });

    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 1000);
      throw new Error(`SendGrid error: HTTP ${response.status}. ${errorBody}`);
    }

    return {
      providerMessageId: response.headers.get("x-message-id")
    };
  }
}

export function createEmailProvider(): EmailProvider | null {
  const config = getEmailConfig();

  if (!config.enabled || !config.sendGridApiKey) {
    return null;
  }

  return new SendGridEmailProvider({
    apiKey: config.sendGridApiKey,
    fromEmail: config.fromEmail,
    fromName: config.fromName
  });
}
