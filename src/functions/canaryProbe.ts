// canaryProbe.ts — timer, 01:00 UTC daily: enqueue one synthetic turn for the
// `queue-probe` tenant. Trigger it by hand with the admin API:
//   POST https://<host>/admin/functions/canaryProbe  (x-functions-key: master key)

import { app, InvocationContext } from "@azure/functions";
import { QueueClient } from "@azure/storage-queue";
import { sendCanary } from "../canary/canary";

const connectionString = process.env.TELEMETRY_QUEUE_CONNECTION_STRING || process.env.AzureWebJobsStorage || "";
const QUEUE = "bot-telemetry";

export async function canaryProbe(_timer: unknown, context: InvocationContext): Promise<void> {
  const queue = new QueueClient(connectionString, QUEUE);
  const env = await sendCanary(queue);
  context.log(`[Canary] enqueued ${env.correlation_id} for tenant ${env.tenant_id} at ${env.timestamp}`);
}

app.timer("canaryProbe", {
  schedule: "0 0 1 * * *",
  handler: canaryProbe,
});
