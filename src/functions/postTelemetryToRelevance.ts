import { app, InvocationContext } from "@azure/functions";
import { writeEventToTable } from "./Analyticsfunction";

// Queue ingest — the bot enqueues base64-encoded JSON envelopes onto
// `bot-telemetry` (telemetryQueue.ts). host.json sets messageEncoding=base64,
// so the runtime normally hands us the decoded, parsed object; the string
// fallbacks below cover messages that arrive un-decoded or double-encoded.
// writeEventToTable is idempotent (rowKey dedup → 409 skipped), so replays
// and overlap with the HTTP webhook path cannot double-count.

function decodeQueueItem(queueItem: unknown): any | null {
  if (queueItem && typeof queueItem === "object") return queueItem;
  if (typeof queueItem !== "string") return null;
  try {
    return JSON.parse(queueItem);
  } catch {}
  try {
    return JSON.parse(Buffer.from(queueItem, "base64").toString("utf8"));
  } catch {}
  return null;
}

export async function postTelemetryToRelevance(queueItem: unknown, context: InvocationContext): Promise<void> {
  const event = decodeQueueItem(queueItem);
  if (!event || typeof event.event_type !== "string") {
    // Log and swallow: a malformed message must not poison-loop the queue.
    context.log("[QueueIngest] Skipped undecodable message");
    return;
  }
  await writeEventToTable(event, context);
}

app.storageQueue('postTelemetryToRelevance', {
    queueName: 'bot-telemetry',
    connection: 'rgstudioagenttelemetry01_STORAGE',
    handler: postTelemetryToRelevance
});
