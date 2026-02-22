import { env } from "../config.ts";

interface MailOptions {
  from: string;
  to: string[];
  subject: string;
  body?: string;
  template?: string;
  variables?: Record<string, unknown>;
}

export async function sendMail(opts: MailOptions): Promise<void> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    console.warn("Mailgun not configured, skipping email");
    return;
  }

  const form = new FormData();
  form.append("from", opts.from);
  opts.to.forEach((t) => form.append("to", t));
  form.append("subject", opts.subject);

  if (opts.template) {
    form.append("template", opts.template);
    if (opts.variables) {
      form.append("h:X-Mailgun-Variables", JSON.stringify(opts.variables));
    }
  } else if (opts.body) {
    form.append("text", opts.body);
  }

  const response = await fetch(
    `${env.MAILGUN_API_BASE}/${env.MAILGUN_DOMAIN}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`,
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    console.error("Mailgun error:", response.status, await response.text());
  }
}
