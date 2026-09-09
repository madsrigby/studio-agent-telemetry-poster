import { describe, expect, it } from "vitest";
import { composeDigest, pickMode, type WeekData } from "../src/digest/compose";

const OPTS = { dashboardUrl: "https://www.mystudioagent.ai", minSensitiveCount: 5 };

function week(overrides: Partial<WeekData> = {}): WeekData {
  return {
    weekEnd: "2026-09-14",
    taggedTurns: 40,
    untaggedTurns: 3,
    topTopics: [
      { topic: "holiday", total: 20, answered: 18, deflected: 1, not_in_docs: 1, escalated: 0 },
      { topic: "pension", total: 12, answered: 11, deflected: 0, not_in_docs: 1, escalated: 0 },
    ],
    topGaps: [{ topic: "holiday", unanswered: 2, not_in_docs: 1, deflected: 1 }],
    escalationsByKind: { doc_conflict: 2 },
    ...overrides,
  };
}

describe("pickMode", () => {
  it("normal when tagged turns exist", () => {
    expect(pickMode(week())).toBe("normal");
  });
  it("pre-tagging when only untagged turns exist", () => {
    expect(pickMode(week({ taggedTurns: 0, untaggedTurns: 9, topTopics: [], topGaps: [] }))).toBe("pre-tagging");
  });
  it("pipeline-dead when nothing was ingested", () => {
    expect(pickMode(week({ taggedTurns: 0, untaggedTurns: 0, topTopics: [], topGaps: [] }))).toBe("pipeline-dead");
  });
});

describe("composeDigest — normal mode", () => {
  it("carries subject with week end and the topic counts", () => {
    const d = composeDigest(week(), null, null, OPTS);
    expect(d.subject).toBe("Studio Agent — HR insight, week to 2026-09-14");
    expect(d.mode).toBe("normal");
    expect(d.html).toContain("Holiday");
    expect(d.html).toContain("<strong>20</strong>");
    expect(d.text).toContain("WHAT PEOPLE ASKED");
  });

  it("computes week-over-week deltas against the previous row", () => {
    const prev = week({ weekEnd: "2026-09-07", taggedTurns: 30, untaggedTurns: 1 });
    const d = composeDigest(week(), prev, null, OPTS);
    // total turns 43 vs 31 → ▲ +12
    expect(d.html).toContain("▲ +12");
  });

  it("marks persisting and new gaps and celebrates closed ones", () => {
    const prev = week({
      weekEnd: "2026-09-07",
      topGaps: [
        { topic: "holiday", unanswered: 3, not_in_docs: 2, deflected: 1 },
        { topic: "pension", unanswered: 1, not_in_docs: 1, deflected: 0 },
      ],
    });
    const cur = week({
      topGaps: [
        { topic: "holiday", unanswered: 2, not_in_docs: 1, deflected: 1 },
        { topic: "it_systems", unanswered: 1, not_in_docs: 1, deflected: 0 },
      ],
    });
    const d = composeDigest(cur, prev, null, OPTS);
    expect(d.html).toContain("PERSISTING");
    expect(d.html).toContain("NEW");
    expect(d.html).toContain("Gaps closed since last week");
    expect(d.html).toContain("Pension");
  });
});

describe("sensitive suppression", () => {
  const withGrievance = (n: number) =>
    week({
      topTopics: [{ topic: "conduct_grievance", total: n, answered: n, deflected: 0, not_in_docs: 0, escalated: 0 }],
      topGaps: [],
    });

  it("suppresses counts 1-4 on sensitive topics", () => {
    const d = composeDigest(withGrievance(4), null, null, OPTS);
    expect(d.html).toContain("under 5");
    expect(d.html).not.toContain("<strong>4</strong>");
  });
  it("shows exact counts at or above the floor", () => {
    const d = composeDigest(withGrievance(5), null, null, OPTS);
    expect(d.html).toContain("<strong>5</strong>");
  });
  it("zero is not suppressed (nothing to hide)", () => {
    const d = composeDigest(withGrievance(0), null, null, OPTS);
    expect(d.html).toContain("<strong>0</strong>");
  });
  it("non-sensitive topics always show exact counts", () => {
    const d = composeDigest(week(), null, null, OPTS);
    expect(d.html).toContain("<strong>12</strong>"); // pension: 12
  });
});

describe("honest modes", () => {
  it("pre-tagging explains the missing topic data", () => {
    const d = composeDigest(week({ taggedTurns: 0, untaggedTurns: 9, topTopics: [], topGaps: [] }), null, null, OPTS);
    expect(d.mode).toBe("pre-tagging");
    expect(d.html).toContain("not deployed yet");
    expect(d.html).not.toContain("Content gaps");
  });
  it("pipeline-dead is an alert, not a report of zeros", () => {
    const d = composeDigest(week({ taggedTurns: 0, untaggedTurns: 0, topTopics: [], topGaps: [] }), null, null, OPTS);
    expect(d.mode).toBe("pipeline-dead");
    expect(d.subject).toContain("no data recorded");
    expect(d.text).toContain("pipeline is broken");
  });
});

describe("sync health section", () => {
  it("renders healthy state with rows", () => {
    const d = composeDigest(week(), null, { has_data: true, stale: false, last_success: "x", age_minutes: 12, last_success_rows: 50 }, OPTS);
    expect(d.html).toContain("healthy");
    expect(d.html).toContain("50 employee rows");
  });
  it("flags stale sync", () => {
    const d = composeDigest(week(), null, { has_data: true, stale: true, last_success: "x", age_minutes: 600 }, OPTS);
    expect(d.html).toContain("STALE");
  });
});
