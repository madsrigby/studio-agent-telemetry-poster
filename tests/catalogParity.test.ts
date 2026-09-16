import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { TOOL_CATALOG } from "../src/toolCatalog";

// The bot repo owns the catalog; this file is a vendored copy. When the bot
// repo is checked out beside this one, fail loudly on drift instead of
// silently pricing a new tool at the 3-minute floor.
const botCatalog = path.resolve(__dirname, "../../studio-agent-v2/src/toolCatalog.ts");

describe("vendored tool catalog parity", () => {
  it("has the expected shape", () => {
    for (const [name, e] of Object.entries(TOOL_CATALOG)) {
      expect(["read", "write", "policy", "resolver"]).toContain(e.category);
      expect(e.baseline_minutes).toBeGreaterThan(0);
      expect(e.write).toBe(e.category === "write" || e.category === "policy");
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  it.skipIf(!fs.existsSync(botCatalog))("matches the bot repo's catalog entry for entry", () => {
    const src = fs.readFileSync(botCatalog, "utf8");
    const re = /^\s*([a-z_]+): \{ category: "(\w+)", baseline_minutes: (\d+), write: (true|false)(, estimated: true)? \},?$/gm;
    const bot: Record<string, any> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      bot[m[1]] = { category: m[2], baseline_minutes: Number(m[3]), write: m[4] === "true", ...(m[5] ? { estimated: true } : {}) };
    }
    expect(Object.keys(bot).length).toBeGreaterThan(20);
    expect(TOOL_CATALOG).toEqual(bot);
  });
});
