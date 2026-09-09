// preview-digest.ts — renders the weekly digest locally so a human can vet
// tone and numbers before any real send. Run AFTER `npm run build`:
//
//   node dist/scripts/preview-digest.js                → writes 3 sample HTML files
//   node dist/scripts/preview-digest.js --real         → also renders from the live weeklyinsight table
//   node dist/scripts/preview-digest.js --send-test    → sends the sample "normal" digest via ACS
//                                                        (needs DIGEST_* + ACS_EMAIL_CONNECTION_STRING env)

import * as fs from "fs";
import * as path from "path";
import { composeDigest, type WeekData } from "../src/digest/compose";
import { readSendConfig, sendDigest } from "../src/digest/send";

const OUT = path.join(__dirname, "..", "..", "digest-preview");

const SAMPLE: WeekData = {
  weekEnd: new Date().toISOString().split("T")[0],
  taggedTurns: 287,
  untaggedTurns: 25,
  topTopics: [
    { topic: "holiday", total: 96, answered: 88, deflected: 2, not_in_docs: 4, escalated: 2 },
    { topic: "sickness", total: 44, answered: 40, deflected: 1, not_in_docs: 2, escalated: 1 },
    { topic: "pay_payroll", total: 38, answered: 33, deflected: 0, not_in_docs: 3, escalated: 2 },
    { topic: "conduct_grievance", total: 3, answered: 3, deflected: 0, not_in_docs: 0, escalated: 0 },
    { topic: "pension", total: 29, answered: 27, deflected: 0, not_in_docs: 1, escalated: 1 },
  ],
  topGaps: [
    { topic: "holiday", unanswered: 6, not_in_docs: 4, deflected: 2 },
    { topic: "pay_payroll", unanswered: 3, not_in_docs: 3, deflected: 0 },
  ],
  escalationsByKind: { doc_conflict: 2, identity_gap: 1 },
};

const SAMPLE_PREV: WeekData = {
  ...SAMPLE,
  weekEnd: "prev",
  taggedTurns: 240,
  untaggedTurns: 30,
  topGaps: [
    { topic: "holiday", unanswered: 8, not_in_docs: 5, deflected: 3 },
    { topic: "pension", unanswered: 2, not_in_docs: 2, deflected: 0 },
  ],
};

const SYNC = { has_data: true, stale: false, last_success: new Date().toISOString(), age_minutes: 14, last_success_rows: 50 };
const OPTS = { dashboardUrl: process.env.DASHBOARD_URL || "https://www.mystudioagent.ai", minSensitiveCount: 5 };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const variants: Array<[string, WeekData, WeekData | null]> = [
    ["normal", SAMPLE, SAMPLE_PREV],
    ["pre-tagging", { ...SAMPLE, taggedTurns: 0, untaggedTurns: 42, topTopics: [], topGaps: [] }, null],
    ["pipeline-dead", { ...SAMPLE, taggedTurns: 0, untaggedTurns: 0, topTopics: [], topGaps: [] }, null],
  ];
  for (const [name, cur, prev] of variants) {
    const d = composeDigest(cur, prev, name === "normal" ? SYNC : { has_data: false, stale: true, last_success: null }, OPTS);
    fs.writeFileSync(path.join(OUT, `digest-${name}.html`), d.html);
    fs.writeFileSync(path.join(OUT, `digest-${name}.txt`), `${d.subject}\n\n${d.text}`);
    console.log(`wrote digest-${name}.html (subject: ${d.subject})`);
  }

  if (process.argv.includes("--send-test")) {
    const cfg = readSendConfig();
    if (!cfg) {
      console.error("send-test: DIGEST_ENABLED/DIGEST_RECIPIENTS/DIGEST_FROM/ACS_EMAIL_CONNECTION_STRING not all set");
      process.exit(1);
    }
    const d = composeDigest(SAMPLE, SAMPLE_PREV, SYNC, OPTS);
    d.subject = `[TEST] ${d.subject}`;
    const id = await sendDigest(d, cfg);
    console.log(`send-test: delivered, ACS operation id ${id}`);
  }
  console.log(`preview files in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
