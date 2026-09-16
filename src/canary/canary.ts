// canary.ts — a synthetic turn for the `queue-probe` tenant, enqueued once a
// night onto `bot-telemetry`. It travels the same path as a real bot turn
// (queue → trigger → telemetryevents → aggregation), so the probe key's
// health row proves the whole pipeline every day without real traffic.

export const CANARY_TENANT = "queue-probe";
export const CANARY_RESULT_CODE = "canary";

export interface CanaryEnvelope {
  event_type: "turn_completed";
  timestamp: string;
  correlation_id: string;
  tenant_id: string;
  user_hash: string;
  conversation_id: string;
  channel: string;
  agent_type: "employee";
  input_chars: number;
  response_chars: number;
  outcome: "success";
  latency_total_ms: number;
  relevance_duration_ms: number;
  relevance_result_code: string;
  tools_used: string[];
  answer_coverage: "answered";
  topic: "other";
}

export function buildCanaryEnvelope(now: Date): CanaryEnvelope {
  const id = `canary-${now.getTime()}`;
  return {
    event_type: "turn_completed",
    timestamp: now.toISOString(),
    correlation_id: id,
    tenant_id: CANARY_TENANT,
    user_hash: "canary",
    conversation_id: id,
    channel: "canary",
    agent_type: "employee",
    input_chars: 1,
    response_chars: 1,
    outcome: "success",
    latency_total_ms: 1,
    relevance_duration_ms: 0,
    relevance_result_code: CANARY_RESULT_CODE,
    tools_used: [],
    answer_coverage: "answered",
    topic: "other",
  };
}

/** Same wire format as the bot's telemetryQueue.ts: base64 of the JSON text. */
export function encodeQueueMessage(envelope: unknown): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export interface QueueSender {
  sendMessage(body: string): Promise<unknown>;
}

export async function sendCanary(queue: QueueSender, now: Date = new Date()): Promise<CanaryEnvelope> {
  const env = buildCanaryEnvelope(now);
  await queue.sendMessage(encodeQueueMessage(env));
  return env;
}
