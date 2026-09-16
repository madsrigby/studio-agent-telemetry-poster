// retentionSweep.ts — timer, Sundays 03:00 UTC: delete telemetryevents rows
// older than RETENTION_MONTHS (default 13). Dry-run by default; set
// RETENTION_DRY_RUN=false to delete. Trigger by hand:
//   POST https://<host>/admin/functions/retentionSweep  (x-functions-key: master key)

import { app, InvocationContext } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { readRetentionConfig, sweep } from "../retention/retention";
import { tableRetentionStore } from "../bi/store";

const connectionString = process.env.TELEMETRY_QUEUE_CONNECTION_STRING || process.env.AzureWebJobsStorage || "";

export async function retentionSweep(_timer: unknown, context: InvocationContext): Promise<void> {
  const cfg = readRetentionConfig();
  const store = tableRetentionStore(TableClient.fromConnectionString(connectionString, "telemetryevents"));
  const r = await sweep(store, cfg, (m) => (m.includes("Error") ? context.error(m) : context.log(m)));
  context.log(`[Retention] result ${JSON.stringify(r)}`);
}

app.timer("retentionSweep", {
  schedule: "0 0 3 * * 0",
  handler: retentionSweep,
});
