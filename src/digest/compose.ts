// compose.ts — pure digest composer. No I/O: takes this week's weeklyinsight
// row, last week's row (or null), and the sync-health block; returns the
// email. Kept pure so every mode and edge is unit-testable.

export interface TopicCount {
  topic: string;
  total: number;
  answered: number;
  deflected: number;
  not_in_docs: number;
  escalated: number;
}

export interface GapCount {
  topic: string;
  unanswered: number;
  not_in_docs: number;
  deflected: number;
}

export interface WeekData {
  weekEnd: string; // YYYY-MM-DD
  taggedTurns: number;
  untaggedTurns: number;
  topTopics: TopicCount[];
  topGaps: GapCount[];
  escalationsByKind: Record<string, number>;
}

export interface SyncHealthLike {
  has_data: boolean;
  stale: boolean;
  last_success: string | null;
  age_minutes?: number | null;
  last_success_rows?: number;
  last_outcome?: string;
  last_reason?: string;
}

export interface DigestOptions {
  dashboardUrl: string; // e.g. https://www.mystudioagent.ai
  minSensitiveCount: number; // suppression floor, default 5
  sensitiveTopics?: string[];
}

export type DigestMode = "normal" | "pre-tagging" | "pipeline-dead";

export interface Digest {
  subject: string;
  html: string;
  text: string;
  mode: DigestMode;
}

const DEFAULT_SENSITIVE = ["conduct_grievance", "wellbeing"];

function topicLabel(t: string): string {
  return t
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Counts 1..floor-1 on sensitive topics render as "under <floor>" — with a
 * 59-person company, exact small counts can identify individuals. */
function displayCount(topic: string, n: number, opts: DigestOptions): string {
  const sensitive = (opts.sensitiveTopics ?? DEFAULT_SENSITIVE).includes(topic);
  if (sensitive && n > 0 && n < opts.minSensitiveCount) return `under ${opts.minSensitiveCount}`;
  return String(n);
}

function arrow(delta: number): string {
  if (delta > 0) return `▲ +${delta}`;
  if (delta < 0) return `▼ ${delta}`;
  return "· 0";
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "–";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pickMode(current: WeekData): DigestMode {
  if (current.taggedTurns > 0) return "normal";
  if (current.untaggedTurns > 0) return "pre-tagging";
  return "pipeline-dead";
}

export function composeDigest(
  current: WeekData,
  previous: WeekData | null,
  sync: SyncHealthLike | null,
  opts: DigestOptions,
): Digest {
  const mode = pickMode(current);
  const subject = `Studio Agent — HR insight, week to ${current.weekEnd}`;

  if (mode === "pipeline-dead") {
    const text = [
      `Studio Agent weekly digest — week to ${current.weekEnd}`,
      ``,
      `NO TELEMETRY DATA was recorded this week. That usually means the`,
      `pipeline is broken, not that nobody used the bot. Silence is how the`,
      `last two outages went unnoticed — please investigate.`,
      ``,
      `Dashboard: ${opts.dashboardUrl}/dashboard`,
    ].join("\n");
    return {
      subject: `⚠️ ${subject} — no data recorded`,
      html: `<p><strong>No telemetry data was recorded this week</strong> (week to ${current.weekEnd}).</p>
<p>That usually means the pipeline is broken, not that nobody used the bot. Please investigate.</p>
<p><a href="${opts.dashboardUrl}/dashboard">Open the dashboard</a></p>`,
      text,
      mode,
    };
  }

  const totalTurns = current.taggedTurns + current.untaggedTurns;
  const prevTotal = previous ? previous.taggedTurns + previous.untaggedTurns : null;
  const answered = current.topTopics.reduce((s, t) => s + t.answered, 0);

  const lines: string[] = [];
  const rows: string[] = [];

  // Headline
  lines.push(`Turns this week: ${totalTurns}${prevTotal !== null ? ` (${arrow(totalTurns - prevTotal)})` : ""}`);
  if (mode === "normal") lines.push(`Answered rate: ${pct(answered, current.taggedTurns)}`);
  rows.push(
    `<tr><td style="padding:4px 12px 4px 0"><strong>Turns this week</strong></td><td>${totalTurns}${prevTotal !== null ? ` <span style="color:#888">${arrow(totalTurns - prevTotal)}</span>` : ""}</td></tr>`,
  );
  if (mode === "normal") {
    rows.push(`<tr><td style="padding:4px 12px 4px 0"><strong>Answered rate</strong></td><td>${pct(answered, current.taggedTurns)}</td></tr>`);
  }

  const sections: string[] = [];
  const textSections: string[] = [];

  if (mode === "pre-tagging") {
    sections.push(
      `<p style="color:#946200"><em>The bot build that classifies questions by topic is not deployed yet, so this digest shows usage numbers only. Topic and gap sections appear once that release ships.</em></p>`,
    );
    textSections.push(
      `NOTE: the bot build that classifies questions by topic is not deployed yet — usage numbers only this week.`,
    );
  }

  if (mode === "normal") {
    // What people asked
    const prevByTopic = new Map((previous?.topTopics ?? []).map((t) => [t.topic, t.total]));
    const topicRows = current.topTopics.slice(0, 5).map((t) => {
      const prev = prevByTopic.get(t.topic);
      const delta = prev !== undefined ? ` <span style="color:#888">${arrow(t.total - prev)}</span>` : "";
      const shown = displayCount(t.topic, t.total, opts);
      const suppressed = shown.startsWith("under");
      const split = suppressed ? "" : ` — answered ${t.answered}, unanswered ${t.deflected + t.not_in_docs}`;
      return `<li>${esc(topicLabel(t.topic))}: <strong>${shown}</strong>${suppressed ? "" : delta}${split}</li>`;
    });
    sections.push(`<h3 style="margin-bottom:4px">What people asked</h3><ul style="margin-top:4px">${topicRows.join("")}</ul>`);
    textSections.push(
      `WHAT PEOPLE ASKED:\n` +
        current.topTopics
          .slice(0, 5)
          .map((t) => `  ${topicLabel(t.topic)}: ${displayCount(t.topic, t.total, opts)}`)
          .join("\n"),
    );

    // Content gaps: NEW / PERSISTING / closed
    const prevGapTopics = new Set((previous?.topGaps ?? []).map((g) => g.topic));
    const currGapTopics = new Set(current.topGaps.map((g) => g.topic));
    const closed = [...prevGapTopics].filter((t) => !currGapTopics.has(t));

    const gapRows = current.topGaps.slice(0, 5).map((g) => {
      const badge = prevGapTopics.size
        ? prevGapTopics.has(g.topic)
          ? ` <span style="color:#b00">PERSISTING</span>`
          : ` <span style="color:#946200">NEW</span>`
        : "";
      return `<li>${esc(topicLabel(g.topic))}: <strong>${displayCount(g.topic, g.unanswered, opts)}</strong> unanswered (${g.not_in_docs} not in the documents)${badge}</li>`;
    });
    const closedLine = closed.length
      ? `<p style="color:#0a7d3b"><strong>Gaps closed since last week:</strong> ${closed.map((t) => esc(topicLabel(t))).join(", ")}.</p>`
      : "";
    sections.push(
      `<h3 style="margin-bottom:4px">Content gaps</h3>` +
        (current.topGaps.length
          ? `<ul style="margin-top:4px">${gapRows.join("")}</ul>`
          : `<p>No unanswered themes recorded this week.</p>`) +
        closedLine,
    );
    textSections.push(
      `CONTENT GAPS:\n` +
        (current.topGaps.length
          ? current.topGaps
              .slice(0, 5)
              .map((g) => `  ${topicLabel(g.topic)}: ${displayCount(g.topic, g.unanswered, opts)} unanswered`)
              .join("\n")
          : `  none recorded`) +
        (closed.length ? `\n  Gaps closed: ${closed.map(topicLabel).join(", ")}` : ""),
    );

    // Escalations
    const escEntries = Object.entries(current.escalationsByKind);
    if (escEntries.length) {
      sections.push(
        `<h3 style="margin-bottom:4px">Data-quality escalations</h3><ul style="margin-top:4px">${escEntries
          .map(([k, n]) => `<li>${esc(k)}: <strong>${n}</strong></li>`)
          .join("")}</ul>`,
      );
      textSections.push(`ESCALATIONS:\n` + escEntries.map(([k, n]) => `  ${k}: ${n}`).join("\n"));
    }
  }

  // Sync health
  if (sync) {
    const state = !sync.has_data
      ? "no runs recorded in the last 7 days"
      : sync.stale
        ? `STALE — last success ${sync.age_minutes != null ? Math.round(sync.age_minutes / 60) + "h ago" : "unknown"}`
        : `healthy — last success ${sync.age_minutes != null ? sync.age_minutes + " min ago" : "recent"}, ${sync.last_success_rows ?? 0} employee rows`;
    sections.push(`<h3 style="margin-bottom:4px">Holiday balance sync</h3><p style="margin-top:4px">${esc(state)}</p>`);
    textSections.push(`SYNC: ${state}`);
  }

  // Footer + data coverage
  const coverage =
    current.untaggedTurns > 0 && mode === "normal"
      ? `<p style="color:#888;font-size:12px">${current.untaggedTurns} of ${totalTurns} turns predate topic tagging and appear only in the totals.</p>`
      : "";
  const footer = `<p style="font-size:12px;color:#888">Drill down: <a href="${opts.dashboardUrl}/dashboard/demand">HR Demand</a> · <a href="${opts.dashboardUrl}/dashboard/gaps">Content Gaps</a>. Topics are metadata classified on the bot — no message text is stored. Reply to adjust what you see here.</p>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px">
<h2 style="margin-bottom:2px">Studio Agent — weekly HR insight</h2>
<p style="margin-top:0;color:#888">Week to ${current.weekEnd}</p>
<table style="border-collapse:collapse">${rows.join("")}</table>
${sections.join("\n")}
${coverage}
${footer}
</div>`;

  const text = [
    `Studio Agent — weekly HR insight (week to ${current.weekEnd})`,
    ``,
    ...lines,
    ``,
    ...textSections,
    ``,
    `Dashboard: ${opts.dashboardUrl}/dashboard/demand`,
  ].join("\n");

  return { subject, html, text, mode };
}
