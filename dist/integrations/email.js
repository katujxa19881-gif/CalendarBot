"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEmailProvider = createEmailProvider;
const env_1 = require("../env");
class SendGridEmailProvider {
    apiKey;
    fromEmail;
    fromName;
    constructor(input) {
        this.apiKey = input.apiKey;
        this.fromEmail = input.fromEmail;
        this.fromName = input.fromName;
    }
    async send(email) {
        const content = [{ type: "text/plain", value: email.text }];
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
function createEmailProvider() {
    const config = (0, env_1.getEmailConfig)();
    if (!config.enabled || !config.sendGridApiKey) {
        return null;
    }
    return new SendGridEmailProvider({
        apiKey: config.sendGridApiKey,
        fromEmail: config.fromEmail,
        fromName: config.fromName
    });
}
