import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { foldLine, lineOf, newState, titleOf } from "./sessions.ts";
import {
  baseModel,
  CCUSAGE_INTEGRITY,
  CCUSAGE_VERSION,
  isTimeZone,
  planLabel,
  projectWindow,
  readOauthUsage,
  readReport,
  sinceOf,
  splitCost,
  wholeLines,
  type Part,
} from "./usage.ts";

// Shaped like `ccusage daily --json --sections daily,session --by-agent` (sample numbers).
const REPORT = {
  daily: [
    {
      period: "2026-10-02",
      agent: "all",
      agents: [
        { agent: "claude", modelBreakdowns: [{ modelName: "claude-opus-5-5", inputTokens: 1200, cacheCreationTokens: 40_000, cacheReadTokens: 900_000, outputTokens: 5_300, cost: 0.4517 }] },
        { agent: "codex", modelBreakdowns: [{ modelName: "gpt-5.3-codex", inputTokens: 8_000, cacheCreationTokens: 0, cacheReadTokens: 20_000, outputTokens: 1_100, cost: 0.031 }] },
      ],
    },
    { period: "2026-10-01", agent: "all", agents: [{ agent: "claude", modelBreakdowns: [{ modelName: "claude-sonnet-5", inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 20, cost: 0.00022 }] }] },
    { period: "not-a-date", agents: [] },
  ],
  session: [
    {
      period: "0f6c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f",
      agent: "claude",
      metadata: { lastActivity: "2026-10-02T10:15:00.000Z" },
      modelBreakdowns: [{ modelName: "claude-opus-5-5", inputTokens: 1200, cacheCreationTokens: 40_000, cacheReadTokens: 900_000, outputTokens: 5_300, cost: 0.4517 }],
    },
    { period: "rollout-7", agent: "codex", metadata: {}, modelBreakdowns: [{ modelName: "gpt-5.3-codex", inputTokens: 8_000, cacheReadTokens: 20_000, outputTokens: 1_100, cost: 0.031 }] },
  ],
};

test("readReport keeps each day's agent, sorts days, and drops malformed rows", () => {
  const { days, sessions } = readReport(REPORT);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-10-01", "2026-10-02"],
  );
  assert.deepEqual(
    days[1]!.parts.map((p) => [p.agent, p.model]),
    [
      ["claude", "claude-opus-5-5"],
      ["codex", "gpt-5.3-codex"],
    ],
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]!.lastActivity, Date.parse("2026-10-02T10:15:00.000Z"));
  assert.equal(sessions[1]!.lastActivity, null);
  assert.equal(sessions[1]!.parts[0]!.cacheWrite, 0, "a missing field reads as zero");
  assert.deepEqual(readReport(null), { days: [], sessions: [] });
});

test("splitCost prices input, cache reads and output, and gives cache writes the rest", () => {
  const part: Part = { agent: "claude", model: "claude-opus-5-5", input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000, cost: 0 };
  // Opus 5.5: $4 in, $0.20 cache read, $20 out; 1M one-hour cache writes at 2x = $8.
  const split = splitCost({ ...part, cost: 4 + 8 + 0.2 + 20 })!;
  assert.equal(split.input, 4);
  assert.equal(split.output, 20);
  assert.ok(Math.abs(split.cacheRead - 0.2) < 1e-9);
  assert.ok(Math.abs(split.cacheWrite - 8) < 1e-9);
  assert.ok(Math.abs(split.saved - 3.8) < 1e-9, "cache reads saved $4 - $0.20 per million");
  assert.equal(splitCost({ ...part, cost: 1 })!.cacheWrite, 0, "never below zero");
  assert.equal(splitCost({ ...part, model: "gpt-5.3-codex" }), null, "unknown model: no split");
  assert.equal(baseModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(baseModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
});

test("projectWindow", () => {
  const hour = 3_600_000;
  // 20% used after 1 of 5 hours: on pace for exactly 100% at the reset.
  assert.deepEqual(projectWindow(20, hour, 5 * hour), { atReset: 100, fullInMs: 4 * hour });
  // 50% after 1 hour: full in another hour, well before the reset.
  assert.deepEqual(projectWindow(50, hour, 5 * hour), { atReset: 250, fullInMs: hour });
  // 10% after 1 hour: 50% at the reset, never full.
  assert.deepEqual(projectWindow(10, hour, 5 * hour), { atReset: 50, fullInMs: null });
  assert.deepEqual(projectWindow(100, hour, 5 * hour), { atReset: 100, fullInMs: 0 });
  assert.equal(projectWindow(10, 0, 5 * hour), null);
  assert.equal(projectWindow(10, 6 * hour, 5 * hour), null);
});

test("isTimeZone accepts IANA names and rejects anything else", () => {
  assert.ok(isTimeZone("Asia/Tokyo"));
  assert.ok(isTimeZone("UTC"));
  assert.ok(isTimeZone("Etc/GMT+5"));
  assert.equal(isTimeZone("--since 2020"), false);
  assert.equal(isTimeZone("Asia/Tokyo; rm -rf /"), false);
  assert.equal(isTimeZone("Mars/Olympus"), false);
  assert.equal(isTimeZone(""), false);
});

test("sinceOf counts back whole local days", () => {
  const now = Date.parse("2026-11-05T21:30:00Z"); // already Nov 6 in Tokyo (UTC+9)
  assert.equal(sinceOf("today", now, "Asia/Tokyo"), "20261106");
  assert.equal(sinceOf("today", now, "UTC"), "20261105");
  assert.equal(sinceOf("7d", now, "Asia/Tokyo"), "20261031");
  assert.equal(sinceOf("90d", now, "Asia/Tokyo"), "20260809");
  assert.equal(sinceOf("all", now, "UTC"), null);
});

test("readOauthUsage reads the session, weekly and per-model windows", () => {
  const windows = readOauthUsage({
    five_hour: { utilization: 14, resets_at: "2026-11-05T21:20:00Z" },
    seven_day: { utilization: 20.5, resets_at: "2026-11-11T07:00:00Z" },
    seven_day_opus: null,
    limits: [
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 0, resets_at: "2026-11-11T07:00:00Z" },
      { kind: "weekly_scoped", scope: { model: { display_name: "fable" } }, percent: 3 },
      { kind: "other", percent: 50 },
      null,
    ],
  });
  assert.deepEqual(
    windows.map((w) => [w.kind, w.label, w.usedPercent]),
    [
      ["five-hour", "Session", 14],
      ["weekly", "Weekly", 20.5],
      ["weekly", "Weekly · Fable", 0],
    ],
  );
  assert.equal(windows[0]!.windowMs, 5 * 3_600_000);
  assert.deepEqual(readOauthUsage({ five_hour: { utilization: null } }), []);
});

test("planLabel", () => {
  assert.equal(planLabel("team", "default_claude_max_5x"), "Team (5x)");
  assert.equal(planLabel("pro", null), "Pro");
  assert.equal(planLabel(undefined, undefined), null);
});

test("a title survives a transcript read only by its two ends", () => {
  const head = [
    JSON.stringify({ type: "user", message: { content: "Fix the login redirect" }, cwd: "/w/app", timestamp: "2026-10-02T10:00:00Z" }),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"cut off mid-li',
  ].join("\n");
  const tail = ['ne"}]}}', JSON.stringify({ type: "ai-title", aiTitle: "Login redirect fix" }), ""].join("\n");
  const state = newState("s1", "-w-app");
  for (const line of [...wholeLines(head, false), ...wholeLines(tail, true)]) foldLine(state, lineOf(line));
  assert.equal(titleOf(state), "Login redirect fix");
  assert.equal(state.firstPrompt, "Fix the login redirect");
});

test("the pinned ccusage checksums are the ones package-lock.json installs", () => {
  const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const fromLock: Record<string, string> = {};
  for (const [path, pkg] of Object.entries(lock.packages)) {
    const m = /node_modules\/@ccusage\/ccusage-(.+)$/.exec(path);
    if (m && pkg.integrity) {
      assert.equal(pkg.version, CCUSAGE_VERSION, `${path} is ${pkg.version}`);
      fromLock[m[1]!] = pkg.integrity;
    }
  }
  assert.deepEqual(CCUSAGE_INTEGRITY, fromLock);
  assert.equal(lock.packages["node_modules/ccusage"]?.version, CCUSAGE_VERSION);
});
