// send.ts — thin ACS Email wrapper. Isolated so compose stays pure and tests
// never touch the network.

import { EmailClient } from "@azure/communication-email";
import type { Digest } from "./compose";

export interface SendConfig {
  connectionString: string;
  from: string; // e.g. donotreply@<guid>.azurecomm.net
  recipients: string[]; // parsed from DIGEST_RECIPIENTS (comma-separated)
}

let client: EmailClient | null = null;
function getClient(connectionString: string): EmailClient {
  if (!client) client = new EmailClient(connectionString);
  return client;
}

/** Sends one digest; resolves on a terminal state, throws on failure so the
 * caller can record sendError and leave the row unsent for the next retry. */
export async function sendDigest(digest: Digest, cfg: SendConfig): Promise<string> {
  const emailClient = getClient(cfg.connectionString);
  const poller = await emailClient.beginSend({
    senderAddress: cfg.from,
    content: {
      subject: digest.subject,
      html: digest.html,
      plainText: digest.text,
    },
    recipients: {
      to: cfg.recipients.map((address) => ({ address })),
    },
  });
  const result = await poller.pollUntilDone();
  if (result.status !== "Succeeded") {
    throw new Error(`ACS send status=${result.status} id=${result.id} error=${JSON.stringify(result.error ?? null)}`);
  }
  return result.id;
}

/** Reads digest config from the environment. Returns null when the digest is
 * disabled or not fully configured — the caller treats null as "inert". */
export function readSendConfig(): SendConfig | null {
  if (process.env.DIGEST_ENABLED !== "true") return null;
  const connectionString = process.env.ACS_EMAIL_CONNECTION_STRING || "";
  const from = process.env.DIGEST_FROM || "";
  const recipients = (process.env.DIGEST_RECIPIENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!connectionString || !from || recipients.length === 0) return null;
  return { connectionString, from, recipients };
}
