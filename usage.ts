// Pure helpers shared by server.ts, app.tsx and the tests: ccusage JSON to
// plain rows, the cost split by token type, ranges, and quota projections.
// No Node or bb imports.

/** $ per million tokens at API list prices. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

// From the claude-api skill's model table (cached 2026-10-06). Cache reads are
// 0.1x input except Opus 5.5 (0.05x) and the Fable/Mythos 5.1 tier (0.025x).
// Only used to split a model's cost by token type; ccusage owns the totals.
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** `claude-haiku-4-5-20251001` and `claude-opus-5-5[1m]` price as their base model. */
export function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/** One model's usage in one row (a day or a session), as ccusage reports it. */
export interface Part {
  agent: string;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
}

export interface CostSplit {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** What the cache reads would have cost as uncached input, minus what they cost. */
  saved: number;
}

/**
 * A part's cost by token type, or null for a model without a known price.
 * ccusage gives one cost per model; input, cache read and output are priced
 * here and cache writes take the rest, because their price depends on the
 * cache TTL (1.25x input for 5 minutes, 2x for an hour), which ccusage does
 * not report.
 */
export function splitCost(part: Part): CostSplit | null {
  const price = PRICES[baseModel(part.model)];
  if (!price) return null;
  const m = 1 / 1_000_000;
  const input = part.input * price.input * m;
  const cacheRead = part.cacheRead * price.cacheRead * m;
  const output = part.output * price.output * m;
  return {
    input,
    cacheRead,
    output,
    cacheWrite: Math.max(0, part.cost - input - cacheRead - output),
    saved: part.cacheRead * (price.input - price.cacheRead) * m,
  };
}

export function tokensOf(p: Pick<Part, "input" | "cacheWrite" | "cacheRead" | "output">): number {
  return p.input + p.cacheWrite + p.cacheRead + p.output;
}

type Json = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function partOf(agent: string, b: Json): Part | null {
  const model = str(b.modelName);
  if (!model) return null;
  return {
    agent,
    model,
    input: num(b.inputTokens),
    cacheWrite: num(b.cacheCreationTokens),
    cacheRead: num(b.cacheReadTokens),
    output: num(b.outputTokens),
    cost: num(b.cost),
  };
}

function partsOfRow(row: Json, agent: string): Part[] {
  const breakdowns = Array.isArray(row.modelBreakdowns) ? (row.modelBreakdowns as Json[]) : [];
  return breakdowns.map((b) => partOf(agent, b)).filter((p): p is Part => p !== null);
}

export interface DayRow {
  date: string;
  parts: Part[];
}

export interface SessionRow {
  id: string;
  agent: string;
  lastActivity: number | null;
  parts: Part[];
}

/**
 * Days and sessions from `ccusage daily --json --sections daily,session --by-agent`.
 * A day's parts come from its per-agent breakdowns so each keeps its agent.
 */
export function readReport(json: unknown): { days: DayRow[]; sessions: SessionRow[] } {
  const root = (json ?? {}) as Json;
  const days: DayRow[] = [];
  for (const row of Array.isArray(root.daily) ? (root.daily as Json[]) : []) {
    const date = str(row.period);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const agents = Array.isArray(row.agents) ? (row.agents as Json[]) : [];
    const parts =
      agents.length > 0
        ? agents.flatMap((a) => partsOfRow(a, str(a.agent) ?? "unknown"))
        : partsOfRow(row, str(row.agent) ?? "unknown");
    days.push({ date, parts });
  }
  const sessions: SessionRow[] = [];
  for (const row of Array.isArray(root.session) ? (root.session as Json[]) : []) {
    const id = str(row.period);
    if (!id) continue;
    const agent = str(row.agent) ?? "unknown";
    const last = str(((row.metadata ?? {}) as Json).lastActivity);
    const at = last ? Date.parse(last) : NaN;
    sessions.push({ id, agent, lastActivity: Number.isFinite(at) ? at : null, parts: partsOfRow(row, agent) });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, sessions };
}

export const RANGES = ["today", "7d", "30d", "90d", "all"] as const;
export type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number | null> = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: null };

/** IANA zone names only: letters, digits and `/_+-`, e.g. Asia/Tokyo or Etc/GMT+5. */
export function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `at` in `tz`. */
export function localDate(at: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The first local day a range covers, as YYYYMMDD for `ccusage --since`, or null for all time. */
export function sinceOf(range: Range, now: number, tz: string): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  // Step back from local noon so a DST change never lands on the wrong day.
  const [y, m, d] = localDate(now, tz).split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, m - 1, d, 12) - (days - 1) * 86_400_000);
  return start.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Where a quota window lands at the current pace. `usedPercent` was spent
 * over `elapsedMs` of a `windowMs` window. Returns the percent at the reset,
 * and how long until 100% when that comes before the reset.
 */
export function projectWindow(usedPercent: number, elapsedMs: number, windowMs: number): { atReset: number; fullInMs: number | null } | null {
  if (elapsedMs <= 0 || windowMs <= 0 || elapsedMs > windowMs) return null;
  if (usedPercent >= 100) return { atReset: usedPercent, fullInMs: 0 };
  const rate = usedPercent / elapsedMs;
  const fullInMs = rate > 0 ? (100 - usedPercent) / rate : null;
  return { atReset: rate * windowMs, fullInMs: fullInMs !== null && fullInMs <= windowMs - elapsedMs ? fullInMs : null };
}

export const FIVE_HOURS = 5 * 3_600_000;
export const ONE_WEEK = 7 * 86_400_000;

export interface Window {
  kind: "five-hour" | "weekly";
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMs: number;
}

function pct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

/** Windows from Anthropic's `/api/oauth/usage` response. Unknown fields are ignored. */
export function readOauthUsage(json: unknown): Window[] {
  const root = (json ?? {}) as Json;
  const windows: Window[] = [];
  const add = (w: unknown, kind: Window["kind"], label: string) => {
    const o = (w ?? null) as Json | null;
    const used = pct(o?.utilization);
    if (o && used !== null) windows.push({ kind, label, usedPercent: used, resetsAt: str(o.resets_at), windowMs: kind === "five-hour" ? FIVE_HOURS : ONE_WEEK });
  };
  add(root.five_hour, "five-hour", "Session");
  add(root.seven_day, "weekly", "Weekly");
  const seen = new Set<string>();
  for (const l of Array.isArray(root.limits) ? (root.limits as Json[]) : []) {
    if (l?.kind !== "weekly_scoped") continue;
    const name = str(((((l.scope ?? {}) as Json).model ?? {}) as Json).display_name);
    const used = pct(l.percent);
    if (!name || used === null || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    windows.push({ kind: "weekly", label: `Weekly · ${name}`, usedPercent: used, resetsAt: str(l.resets_at), windowMs: ONE_WEEK });
  }
  return windows;
}

/** "Team (5x)" from Claude Code's stored subscription fields. */
export function planLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  const tier = typeof rateLimitTier === "string" ? /(\d+)x/.exec(rateLimitTier)?.[1] : undefined;
  const type = typeof subscriptionType === "string" && subscriptionType ? subscriptionType[0]!.toUpperCase() + subscriptionType.slice(1) : null;
  if (type && tier) return `${type} (${tier}x)`;
  return type ?? (tier ? `Max (${tier}x)` : null);
}

/** Complete lines of a chunk: drops a cut first line (tail chunks) and a cut last line. */
export function wholeLines(text: string, cutStart: boolean): string[] {
  const lines = text.split("\n");
  if (cutStart) lines.shift();
  lines.pop();
  return lines.filter((line) => line.trim() !== "");
}

/** The ccusage release this plugin runs; package.json pins the same version. */
export const CCUSAGE_VERSION = "20.0.48";

/** npm's sha512 integrity for each platform binary of ccusage 20.0.48, from package-lock.json. */
export const CCUSAGE_INTEGRITY: Record<string, string> = {
  "darwin-arm64": "sha512-5nF3wIFO6IfJsVI3mc0/8iZtcfN8TEN4Dw1JyhToPQVBLVoaxbnBpNR16RWLQvS1yNcVVQfjeCDblmHe/Wt6/A==",
  "darwin-x64": "sha512-7P4dV2jPb3jyzfRncDyAyEnix50trmXYBnHxzhNzao69Rw4MEPGwlU5mkjwYX3/kTACQ5MDoomxHhFQ9Y8+Avg==",
  "linux-arm64": "sha512-dSh53ih6BEZrHsk/Cywu7TEK2xF+NT266Dy+iarcqX/GF4/rhuNnukV4UZR+JgYZTbf1LGHGO8VDrELC//AP9w==",
  "linux-x64": "sha512-ThF2FNVmn8TnzTl94ns980AM2kcMUKBp0zS3LybXlPTV7qeIEhG5U9WbqrpuWvnSOOMM6fEV2Mw1dFoDRLyE9w==",
  "win32-arm64": "sha512-zwvHE6W/IelXp0/P2fNnZhH8FVJRicyOJJk/Q0XDqrIkzGlNPjStq316Nxz8ITVPGi2lpPVTi6Hn4mmP6OmEuA==",
  "win32-x64": "sha512-4PCIs0BWmy3Mj8J93r0pX6XVAZpXQOYO4FxtgXrJnB0NJJ2jgGlsKEzwYPxZEc62Qq+ZKyyGB6c/6QnGw30LjQ==",
};
