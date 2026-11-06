// bb-plugin-claude-usage: the Usage page. One ccusage report per range feeds
// every view; filters (providers, model) and the cost/tokens switch are applied
// here, so switching them never runs ccusage again.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Session } from "./contract";
import { localDate, projectWindow, RANGES, sinceOf, splitCost, tokensOf, type Part, type Range, type Window } from "./usage";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import "./tokens.css";

type Report = { generatedAt: number; days: { date: string; parts: Part[] }[]; sessions: Session[] };
type Limits = {
  source: "anthropic" | "bb" | null;
  plan: string | null;
  windows: Window[];
  burn: { costPerHour: number; blockCost: number; blockEndsAt: string } | null;
  error: string | null;
  observedAt: number;
};
type Metric = "cost" | "tokens";
type Tab = "sessions" | "days" | "models";

const RANGE_LABEL: Record<Range, string> = { today: "Today", "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };
const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  amp: "Amp",
  droid: "Droid",
  qwen: "Qwen",
  kimi: "Kimi",
  goose: "Goose",
  pi: "pi-agent",
  grok: "Grok Build",
  codebuff: "Codebuff",
  hermes: "Hermes Agent",
  kilo: "Kilo",
  antigravity: "Antigravity",
  openclaw: "OpenClaw",
  zcode: "ZCode",
};
/** Every agent ccusage 20.0.48 reads (`ccusage --help`), in its own order. */
const SUPPORTED_AGENTS = ["claude", "codex", "opencode", "amp", "droid", "codebuff", "hermes", "pi", "goose", "kilo", "copilot", "gemini", "antigravity", "kimi", "qwen", "openclaw", "grok", "zcode"];
const HIDDEN_KEY = "claude-usage:hidden-agents";

/** Providers the user switched off, kept across reloads. New providers start switched on. */
function useHiddenAgents(): [Set<string>, (next: Set<string>) => void] {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
    } catch {
      return new Set();
    }
  });
  const save = (next: Set<string>) => {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      // storage full or blocked: the choice still holds for this visit
    }
  };
  return [hidden, save];
}
/** Each provider's own colour when several are on the page (tokens.css --cu-p-*). */
const PROVIDER_COLORED = new Set(["claude", "codex", "gemini"]);
const providerColor = (agent: string) => `var(--cu-p-${PROVIDER_COLORED.has(agent) ? agent : "other"})`;
const agentName = (agent: string) => AGENT_LABEL[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Kept across visits to other pages.
const remembered = { range: "30d" as Range, metric: "cost" as Metric, tab: "sessions" as Tab };

// ---- formatting --------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdShort = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumSignificantDigits: 3 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const pct1 = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

const fmtCost = (v: number) => (v > 0 && v < 0.01 ? "<$0.01" : usd.format(v));
const fmtTokens = (v: number) => compact.format(v);
const fmtMetric = (metric: Metric, v: number) => (metric === "cost" ? fmtCost(v) : fmtTokens(v));
const fmtAxis = (metric: Metric, v: number) => (metric === "cost" ? usdShort.format(v) : compact.format(v));

function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function ago(at: number): string {
  const ms = Date.now() - at;
  if (ms < 60_000) return "just now";
  if (ms < 30 * 86_400_000) return `${fmtDuration(ms).split(" ")[0]} ago`;
  return new Date(at).toLocaleDateString();
}

function dayLabel(date: string, withWeekday = true): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(withWeekday ? { weekday: "short" } : {}) });
}

// ---- motion ---------------------------------------------------------------------
// From the validated interaction thesis; tokens.css holds the CSS side of the same values.

const MOVE_MS = 280;

/** cubic-bezier(x1, y1, x2, y2) as a function of progress, solved by Newton steps. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return (t) => {
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = ((ax * u + bx) * u + cx) * u - t;
      const slope = (3 * ax * u + 2 * bx) * u + cx;
      if (Math.abs(err) < 1e-5 || Math.abs(slope) < 1e-6) break;
      u -= err / slope;
    }
    u = Math.min(1, Math.max(0, u));
    return ((ay * u + by) * u + cy) * u;
  };
}
const moveEase = cubicBezier(0.2, 0, 0, 1);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Numbers that move from their previous values to `target` on the move curve.
 * The first render shows `target` as is; a change of length (or `snapKey`) jumps.
 */
function useTween(target: number[], snapKey = ""): number[] {
  const [shown, setShown] = useState(target);
  const live = useRef(target);
  const key = useRef(snapKey);
  const signature = target.join(",");
  useEffect(() => {
    const from = live.current;
    if (reducedMotion() || from.length !== target.length || key.current !== snapKey) {
      key.current = snapKey;
      live.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = moveEase(Math.min(1, (now - start) / MOVE_MS));
      const next = target.map((v, i) => from[i]! + (v - from[i]!) * k);
      live.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, snapKey]);
  return shown;
}

/** A figure that rolls to its new value. `unit` changing (cost vs tokens) jumps instead: a roll across units means nothing. */
function Rolling({ value, format, unit = "" }: { value: number; format: (v: number) => string; unit?: string }) {
  const [v] = useTween([value], unit);
  return <>{format(v ?? value)}</>;
}

/** Keeps a closing element mounted for its exit animation. */
function usePresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { mounted: open || mounted, closing: !open && mounted };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---- aggregation ------------------------------------------------------------

interface Totals {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  /** Cost by type over priced parts; `other` is the cost of models without a known price. */
  split: { input: number; cacheWrite: number; cacheRead: number; output: number; saved: number; other: number };
}

function emptyTotals(): Totals {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, split: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, saved: 0, other: 0 } };
}

function addPart(t: Totals, p: Part): Totals {
  t.input += p.input;
  t.cacheWrite += p.cacheWrite;
  t.cacheRead += p.cacheRead;
  t.output += p.output;
  t.cost += p.cost;
  const s = splitCost(p);
  if (s) {
    t.split.input += s.input;
    t.split.cacheWrite += s.cacheWrite;
    t.split.cacheRead += s.cacheRead;
    t.split.output += s.output;
    t.split.saved += s.saved;
  } else t.split.other += p.cost;
  return t;
}

const totalOf = (parts: Part[]) => parts.reduce(addPart, emptyTotals());
const valueOf = (metric: Metric, t: Pick<Totals, "cost" | "input" | "cacheWrite" | "cacheRead" | "output">) => (metric === "cost" ? t.cost : tokensOf(t));

/** Every date from `from` to `to` inclusive, YYYY-MM-DD. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T12:00:00Z`), end = Date.parse(`${to}T12:00:00Z`); at <= end && out.length < 4000; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

// ---- data hooks ---------------------------------------------------------------

function useReport(range: Range) {
  const rpc = useRpc<typeof rpcContract>();
  // The previous range's report stays on screen while the next one loads, so figures can roll to it.
  const [state, setState] = useState<{ reportRange: Range; report: Report | null; error: string | null; loading: boolean }>({ reportRange: range, report: null, error: null, loading: true });
  const load = useCallback(
    (refresh: boolean) => {
      let live = true;
      setState((s) => ({ ...s, loading: true, error: null }));
      rpc.call("report", { range, timeZone: TIME_ZONE, refresh }).then(
        (report) => live && setState({ reportRange: range, report, error: null, loading: false }),
        (cause: unknown) => live && setState((s) => ({ ...s, error: message(cause), loading: false })),
      );
      return () => {
        live = false;
      };
    },
    [rpc, range],
  );
  useEffect(() => load(false), [load]);
  return { ...state, reload: () => load(true) };
}

function useLimits() {
  const rpc = useRpc<typeof rpcContract>();
  const [limits, setLimits] = useState<Limits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh: boolean) => {
      rpc.call("limits", { refresh }).then(
        (next) => {
          setLimits(next);
          setError(null);
        },
        (cause: unknown) => setError(message(cause)),
      );
    },
    [rpc],
  );
  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), 120_000);
    return () => clearInterval(timer);
  }, [load]);
  return { limits, error, reload: () => load(true) };
}

/** A clock for countdowns, ticking every 30 seconds. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// ---- primitives ---------------------------------------------------------------

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="cu-seg inline-flex shrink-0 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "cu-hover rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]",
            o.value === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium text-foreground">{children}</h2>
      {aside}
    </div>
  );
}

function Notice({ children, tone = "muted", action }: { children: ReactNode; tone?: "muted" | "error"; action?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <div className="max-w-[60ch]">{children}</div>
      {action}
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}

/** A thin share line under a row's name, as long as its share of the largest row. */
function ShareLine({ share, color = "var(--cu-accent)" }: { share: number; color?: string }) {
  return (
    <div className="mt-1.5 h-[2px] w-full max-w-72 overflow-hidden rounded-full">
      <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, share * 100)}%`, background: color }} />
    </div>
  );
}

// ---- provider picker ----------------------------------------------------------

function ProviderPicker({ detected, shown, onChange, shareOf }: { detected: string[]; shown: string[]; onChange: (agent: string, on: boolean) => void; shareOf: (agent: string) => string }) {
  const missing = SUPPORTED_AGENTS.filter((a) => !detected.includes(a));
  const label =
    shown.length === detected.length ? (detected.length === 1 ? agentName(detected[0]!) : "All providers") : shown.length === 1 ? agentName(shown[0]!) : `${shown.length} of ${detected.length} providers`;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button variant="outline" size="sm" className="cu-pill h-7 gap-1.5 rounded-lg px-2.5 text-xs" aria-label={`Providers: ${label}`}>
          <span className="cu-num">{label}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="cu-menu z-50 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
          style={{ maxHeight: "min(30rem, var(--radix-dropdown-menu-content-available-height))" }}
        >
          <Menu.Label className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">Providers with usage in this range</Menu.Label>
          {detected.map((a) => {
            const on = shown.includes(a);
            const last = on && shown.length === 1;
            return (
              <Menu.CheckboxItem
                key={a}
                checked={on}
                disabled={last}
                onCheckedChange={(next) => onChange(a, next === true)}
                onSelect={(event) => event.preventDefault()}
                className="cu-hover flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors data-[disabled]:cursor-default data-[highlighted]:bg-state-hover"
                title={last ? "At least one provider stays on" : undefined}
              >
                <span
                  className={cn("flex size-4 shrink-0 items-center justify-center rounded-[5px] border", on ? "border-transparent text-background" : "border-border")}
                  style={on ? { background: providerColor(a) } : undefined}
                  aria-hidden
                >
                  <Menu.ItemIndicator>
                    <Icon name="Check" className="size-3" />
                  </Menu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{agentName(a)}</span>
                <span className="cu-num text-xs text-muted-foreground">{shareOf(a)}</span>
              </Menu.CheckboxItem>
            );
          })}
          {missing.length > 0 ? (
            <>
              <Menu.Separator className="mx-1 my-1 h-px bg-border" />
              <div className="px-2.5 pb-2 pt-1.5">
                <div className="mb-1.5 text-xs text-muted-foreground">No usage in this range</div>
                <div className="flex flex-wrap gap-1">
                  {missing.map((a) => (
                    <span key={a} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {agentName(a)}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

// ---- limits: the limits-first top (MASTER.md) ----------------------------------

type WindowRead = {
  w: Window;
  leftPct: number;
  leftMs: number | null;
  proj: { atReset: number; fullInMs: number | null } | null;
  state: "room" | "tight" | "out";
};

function readWindow(w: Window, now: number): WindowRead {
  const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  const leftMs = Number.isFinite(resetAt) ? resetAt - now : null;
  const elapsed = leftMs !== null ? w.windowMs - leftMs : null;
  const proj = elapsed !== null ? projectWindow(w.usedPercent, elapsed, w.windowMs) : null;
  const state = w.usedPercent >= 100 || proj?.fullInMs != null ? "out" : w.usedPercent >= 75 || (proj !== null && proj.atReset >= 90) ? "tight" : "room";
  return { w, leftPct: Math.max(0, 100 - w.usedPercent), leftMs, proj, state };
}

/** The decision a window answers, in plain words. */
function verdictOf(r: WindowRead): string {
  if (r.w.kind === "five-hour") {
    if (r.state === "out") return r.w.usedPercent >= 100 ? "Wait for the reset." : "Wrap up: this session is running out.";
    if (r.state === "tight") return "Finish small things first.";
    return "Room for a big task.";
  }
  if (r.w.usedPercent === 0) return "Untouched this week.";
  if (r.state === "out") return "You will run out before the week resets.";
  if (r.state === "tight") return "Ease off to last the week.";
  return "On pace for the week.";
}

/** The projection line kept from the classic meters. */
function projectionOf(r: WindowRead): string | null {
  if (r.w.usedPercent >= 100) return r.leftMs !== null ? `Limit reached. Back in ${fmtDuration(r.leftMs)}.` : "Limit reached.";
  if (r.proj?.fullInMs != null) return `At this pace the limit is hit in ${fmtDuration(r.proj.fullInMs)}.`;
  if (r.proj) return `On pace to use ${Math.round(Math.min(100, r.proj.atReset))}% before it resets.`;
  return null;
}

/** Today's and this week's spend for the chips, whatever range the page shows. */
function useGlance(filter: (parts: Part[]) => Part[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [reports, setReports] = useState<{ today: Report; week: Report } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([rpc.call("report", { range: "today", timeZone: TIME_ZONE, refresh: false }), rpc.call("report", { range: "7d", timeZone: TIME_ZONE, refresh: false })]).then(
        ([today, week]) => live && setReports({ today, week }),
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 120_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rpc]);
  return useMemo(() => {
    if (!reports) return null;
    const sum = (r: Report) => r.sessions.flatMap((s) => filter(s.parts)).reduce((a, p) => a + p.cost, 0);
    const byModel = new Map<string, number>();
    for (const s of reports.week.sessions) for (const p of filter(s.parts)) byModel.set(p.model, (byModel.get(p.model) ?? 0) + p.cost);
    const top = [...byModel].sort((a, b) => b[1] - a[1])[0];
    const week = sum(reports.week);
    return { today: sum(reports.today), week, top: top && week > 0 ? { model: top[0], share: top[1] / week } : null };
  }, [reports, filter]);
}

function WindowTile({ r, burn }: { r: WindowRead; burn: Limits["burn"] }) {
  const projection = projectionOf(r);
  return (
    <div key={r.state} className={cn("cu-tile min-w-56 flex-1 p-6", r.state !== "room" && "cu-wash")} data-state={r.state}>
      <div className="text-xs text-muted-foreground">{r.w.label}</div>
      <div className="cu-num mt-1 text-[40px] font-bold leading-none tracking-[-0.03em] text-foreground">
        <Rolling value={r.leftPct} format={(v) => `${Math.round(v)}%`} />
      </div>
      <div className="mt-2 text-sm text-foreground">{verdictOf(r)}</div>
      {projection ? <div className="mt-1 text-xs text-muted-foreground">{projection}</div> : null}
      {r.w.kind === "five-hour" && burn ? <div className="cu-num text-xs text-muted-foreground">{fmtCost(burn.blockCost)} so far this block</div> : null}
      {r.leftMs !== null ? <div className="cu-num mt-3 text-xs text-muted-foreground">Resets in {fmtDuration(r.leftMs)}</div> : null}
    </div>
  );
}

function AllClearTop({ limits, error, now, glance }: { limits: Limits | null; error: string | null; now: number; glance: ReturnType<typeof useGlance> }) {
  if (error) return <Notice tone="error">Limits could not be read: {error}</Notice>;
  if (!limits)
    return (
      <div className="space-y-6">
        <Skeleton className="h-14 w-96 max-w-full rounded-[var(--cu-r-row)]" />
        <div className="flex flex-wrap gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 min-w-56 flex-1 rounded-[var(--cu-r-tile)]" />
          ))}
        </div>
      </div>
    );
  const reads = limits.windows.map((w) => readWindow(w, now));
  const lead = reads.find((r) => r.state === "out") ?? reads.find((r) => r.state === "tight") ?? reads[0];
  const status = lead ? verdictOf(lead) : limits.error ? "Plan limits are unavailable." : "No limits reported.";
  const chips = [
    limits.burn ? `${usd.format(limits.burn.costPerHour)}/h right now` : "Idle right now",
    glance ? `${fmtCost(glance.today)} today` : null,
    glance ? `${fmtCost(glance.week)} this week` : null,
    glance?.top ? `${pct1.format(glance.top.share)} on ${glance.top.model}` : null,
  ].filter((c): c is string => c !== null);
  return (
    <section aria-label="Plan limits" className="space-y-8">
      <div>
        <h2 key={status} className="cu-status max-w-[18ch] text-[36px] font-bold leading-[1.05] tracking-[-0.03em] text-foreground md:text-[52px]">
          {status}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">{limits.plan ? `Claude ${limits.plan}` : limits.error ?? ""}</p>
      </div>
      {reads.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {reads.map((r) => (
            <WindowTile key={r.w.label} r={r} burn={limits.burn} />
          ))}
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-2 text-sm" aria-label="Spend at a glance">
        {chips.map((c) => (
          <li key={c} className="cu-chip cu-num px-3.5 py-1.5 text-foreground">
            {c}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- trend chart ----------------------------------------------------------------

/** A monotone cubic through the points (Fritsch-Carlson), so the curve never overshoots below zero. */
function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i]![0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i]![1]) / (dx[i] || 1));
  const t = pts.map((_, i) => (i === 0 ? m[0]! : i === n - 1 ? m[n - 2]! : m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i]!;
      t[i + 1] = tau * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${x0 + h},${y0 + t[i]! * h},${x1 - h},${y1 - t[i + 1]! * h},${x1},${y1}`;
  }
  return d;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

type Point = { date: string; value: number; top: string | null; by: Record<string, number> };
type Series = { agent: string; color: string };

/** One line for the total, or one line per provider when `series` holds several. */
function TrendChart({ points, metric, series }: { points: Point[]; metric: Metric; series: Series[] }) {
  const multi = series.length > 1;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { top: 12, right: 8, bottom: 24, left: 52 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(0, ...(multi ? points.flatMap((p) => series.map((s) => p.by[s.agent] ?? 0)) : points.map((p) => p.value)));
  const step = niceStep(max / 3);
  const top = Math.max(step * 3, step);
  const x = (i: number) => pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  // Same days: the line reshapes from its old positions. New days: it draws in (drawKey).
  const drawKey = `${points.length}:${points[0]?.date ?? ""}`;
  const valuesOf = (s: Series | null) => points.map((p) => (s ? (p.by[s.agent] ?? 0) : p.value));
  const lines = multi ? series : [null];
  const target = lines.flatMap((s) => valuesOf(s).map(y));
  const ys = useTween(target, `${drawKey}:${width}:${series.map((s) => s.agent).join(",")}`);
  const pathOf = (k: number) => monotonePath(points.map((_, i) => [x(i), ys[k * points.length + i] ?? target[k * points.length + i]!] as [number, number]));
  const line = pathOf(0);
  const pts = points.map((_, i) => [x(i), ys[i] ?? target[i]!] as [number, number]);
  const area = pts.length > 1 ? `${line}L${pts[pts.length - 1]![0]},${pad.top + innerH}L${pts[0]![0]},${pad.top + innerH}Z` : "";
  const ticks = [0, 1, 2, 3].map((i) => i * step);
  const labelAt = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);
  const h = hover !== null ? points[hover] : undefined;
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (points.length === 0 || innerW <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = (event.clientX - rect.left - pad.left) / innerW;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(rel * (points.length - 1)))));
  };
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} className="block touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`Daily ${metric} chart`}>
          <defs>
            <linearGradient id="cu-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--cu-line)", stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: "var(--cu-line)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
              <text x={pad.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="cu-num fill-muted-foreground text-[10px]">
                {fmtAxis(metric, v)}
              </text>
            </g>
          ))}
          {labelAt.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 && points.length > 1 ? "start" : i === points.length - 1 && points.length > 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[10px] uppercase"
            >
              {dayLabel(points[i]!.date, false)}
            </text>
          ))}
          <g key={`${drawKey}:${multi}`}>
            {!multi && area ? <path d={area} fill="url(#cu-area)" className="cu-draw-area" /> : null}
            {lines.map((s, k) => (
              <path
                key={s?.agent ?? "total"}
                d={pathOf(k)}
                pathLength={1}
                fill="none"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="cu-draw"
                style={{ stroke: s ? s.color : "var(--cu-line)" }}
              />
            ))}
          </g>
          {h && hover !== null ? (
            <g pointerEvents="none">
              <line x1={0} x2={0} y1={pad.top} y2={pad.top + innerH} className="cu-cross stroke-foreground/30" strokeWidth={1} style={{ transform: `translateX(${x(hover)}px)` }} />
              {lines.map((s) => (
                <circle
                  key={s?.agent ?? "total"}
                  cx={0}
                  cy={0}
                  r={4}
                  className="cu-cross fill-background"
                  strokeWidth={2}
                  style={{ stroke: s ? s.color : "var(--cu-line)", transform: `translate(${x(hover)}px, ${y(s ? (h.by[s.agent] ?? 0) : h.value)}px)` }}
                />
              ))}
            </g>
          ) : null}
        </svg>
      ) : null}
      {h && hover !== null ? (
        <div
          className="cu-cross pointer-events-none absolute left-0 top-0 z-10 min-w-36 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
          style={{ transform: `translateX(${Math.min(Math.max(0, x(hover) - 72), Math.max(0, width - 150))}px)` }}
        >
          <div className="text-muted-foreground">{dayLabel(h.date)}</div>
          <div className="cu-num text-sm font-medium text-foreground">{fmtMetric(metric, h.value)}</div>
          {multi
            ? series.map((s) => (
                <div key={s.agent} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
                  <span className="flex-1">{agentName(s.agent)}</span>
                  <span className="cu-num text-foreground">{fmtMetric(metric, h.by[s.agent] ?? 0)}</span>
                </div>
              ))
            : h.top
              ? <div className="truncate text-muted-foreground">Mostly {h.top}</div>
              : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- type split -------------------------------------------------------------------

function TypeBar({ totals, metric }: { totals: Totals; metric: Metric }) {
  const parts =
    metric === "cost"
      ? [
          { label: "Input", value: totals.split.input, color: "var(--cu-t-input)" },
          { label: "Cache write", value: totals.split.cacheWrite, color: "var(--cu-t-write)" },
          { label: "Cache read", value: totals.split.cacheRead, color: "var(--cu-t-read)" },
          { label: "Output", value: totals.split.output, color: "var(--cu-t-output)" },
          ...(totals.split.other > 0 ? [{ label: "Unpriced models", value: totals.split.other, color: "var(--muted-foreground)" }] : []),
        ]
      : [
          { label: "Input", value: totals.input, color: "var(--cu-t-input)" },
          { label: "Cache write", value: totals.cacheWrite, color: "var(--cu-t-write)" },
          { label: "Cache read", value: totals.cacheRead, color: "var(--cu-t-read)" },
          { label: "Output", value: totals.output, color: "var(--cu-t-output)" },
        ];
  const sum = parts.reduce((s, p) => s + p.value, 0);
  if (sum <= 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div key={p.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.value / sum, flexBasis: 0, minWidth: 3, background: p.color }} title={`${p.label}: ${fmtMetric(metric, p.value)}`} />
          ))}
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[3px]" style={{ background: p.color }} aria-hidden />
            <dt className="text-muted-foreground">{p.label}</dt>
            <dd className="cu-num text-foreground">
              {fmtMetric(metric, p.value)} <span className="text-muted-foreground">{pct1.format(p.value / sum)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---- calendar heatmap -----------------------------------------------------------------

function Heatmap({ points, metric, onPick }: { points: Point[]; metric: Metric; onPick: (date: string) => void }) {
  const shown = points.slice(-371); // at most 53 weeks
  if (shown.length < 14) return null;
  const firstDow = (new Date(`${shown[0]!.date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const values = shown.map((p) => p.value).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f: number) => values[Math.min(values.length - 1, Math.floor(f * values.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0]! ? 1 : v <= cuts[1]! ? 2 : v <= cuts[2]! ? 3 : 4);
  const weeks = Math.ceil((shown.length + firstDow) / 7);
  const active = shown.filter((p) => p.value > 0).length;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <div className="grid w-max grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7, 12px)", gridTemplateColumns: `repeat(${weeks}, 12px)` }}>
          {Array.from({ length: firstDow }, (_, i) => (
            <div key={`pad${i}`} />
          ))}
          {shown.map((p) => (
            <button
              key={p.date}
              type="button"
              onClick={() => onPick(p.date)}
              title={`${dayLabel(p.date)}: ${fmtMetric(metric, p.value)}`}
              aria-label={`${dayLabel(p.date)}: ${fmtMetric(metric, p.value)}`}
              className="cu-hover size-3 rounded-[3px] outline-none transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ background: `var(--cu-h${level(p.value)})` }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Active on {active} of {shown.length} days
        </span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className="size-2.5 rounded-[2px]" style={{ background: `var(--cu-h${l})` }} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

// ---- breakdown rows -----------------------------------------------------------------

function ModelSplit({ parts, metric, colorOf }: { parts: Part[]; metric: Metric; colorOf: (model: string) => string }) {
  const byModel = new Map<string, Totals>();
  for (const p of parts) byModel.set(p.model, addPart(byModel.get(p.model) ?? emptyTotals(), p));
  const rows = [...byModel].sort((a, b) => valueOf(metric, b[1]) - valueOf(metric, a[1]));
  return (
    <ul className="space-y-1.5">
      {rows.map(([model, t]) => (
        <li key={model} className="flex items-center gap-2 text-xs">
          <span className="size-2 shrink-0 rounded-[3px]" style={{ background: colorOf(model) }} aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">{model}</span>
          <span className="cu-num text-muted-foreground">{fmtTokens(tokensOf(t))} tokens</span>
          <span className="cu-num w-20 text-right text-foreground">{fmtCost(t.cost)}</span>
        </li>
      ))}
    </ul>
  );
}

function StackBar({ parts, metric, colorOf, share }: { parts: Part[]; metric: Metric; colorOf: (model: string) => string; share: number }) {
  const byModel = new Map<string, number>();
  for (const p of parts) byModel.set(p.model, (byModel.get(p.model) ?? 0) + (metric === "cost" ? p.cost : tokensOf(p)));
  const sum = [...byModel.values()].reduce((s, v) => s + v, 0);
  return (
    <div className="mt-1.5 flex h-[3px] w-full max-w-72 overflow-hidden rounded-full">
      <div className="flex h-full gap-px" style={{ width: `${Math.max(1.5, share * 100)}%` }}>
        {[...byModel]
          .sort((a, b) => b[1] - a[1])
          .map(([model, v]) => (
            <div key={model} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: sum > 0 ? v / sum : 1, flexBasis: 0, background: colorOf(model) }} />
          ))}
      </div>
    </div>
  );
}

function Row({ open, onToggle, main, value, sub, children, rowRef }: { open: boolean; onToggle: () => void; main: ReactNode; value: ReactNode; sub: ReactNode; children?: ReactNode; rowRef?: React.Ref<HTMLLIElement> }) {
  const detail = usePresence(open, 120);
  return (
    <li ref={rowRef} className={cn("cu-hover transition-colors", open && "cu-open bg-state-hover/60")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="cu-hover flex w-full min-w-0 items-start gap-4 px-4 py-3 text-left outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">{main}</div>
        <div className="shrink-0 text-right">
          <div className="cu-num text-sm text-foreground">{value}</div>
          <div className="cu-num text-xs text-muted-foreground">{sub}</div>
        </div>
        {children ? <Icon name="ChevronDown" className={cn("cu-chevron mt-0.5 size-4 shrink-0 text-muted-foreground", open && "rotate-180")} aria-hidden /> : null}
      </button>
      {detail.mounted && children ? (
        <div className="cu-detail px-4 pb-4" data-closing={detail.closing ? "" : undefined}>
          {children}
        </div>
      ) : null}
    </li>
  );
}

const PAGE = 60;

function SessionsList({ sessions, metric, colorOf, partsOf }: { sessions: Session[]; metric: Metric; colorOf: (m: string) => string; partsOf: (parts: Part[]) => Part[] }) {
  const nav = useBbNavigate();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"top" | "recent">("top");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return sessions
      .map((s) => ({ s, parts: partsOf(s.parts) }))
      .map((r) => ({ ...r, t: totalOf(r.parts) }))
      .filter((r) => r.parts.length > 0 && tokensOf(r.t) > 0)
      .filter((r) => {
        if (terms.length === 0) return true;
        const hay = `${r.s.title ?? ""} ${r.s.project ?? ""} ${r.s.id} ${r.parts.map((p) => p.model).join(" ")}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .sort((a, b) => (sort === "top" ? valueOf(metric, b.t) - valueOf(metric, a.t) : (b.s.lastActivity ?? 0) - (a.s.lastActivity ?? 0)));
  }, [sessions, partsOf, query, sort, metric]);
  const max = Math.max(0, ...rows.map((r) => valueOf(metric, r.t)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input className="cu-pill" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, projects and models" aria-label="Search sessions" />
        </div>
        <Segmented
          label="Sort sessions"
          value={sort}
          onChange={setSort}
          options={[
            { value: "top", label: metric === "cost" ? "Costliest" : "Largest" },
            { value: "recent", label: "Recent" },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <Notice>{query ? "No session matches that search." : "No sessions in this range."}</Notice>
      ) : (
        <ul className="cu-list divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.slice(0, shown).map(({ s, parts, t }) => (
            <Row
              key={`${s.agent}:${s.id}`}
              open={open === s.id}
              onToggle={() => setOpen(open === s.id ? null : s.id)}
              value={fmtMetric(metric, valueOf(metric, t))}
              sub={metric === "cost" ? `${fmtTokens(tokensOf(t))} tokens` : fmtCost(t.cost)}
              main={
                <>
                  <div className="truncate text-sm text-foreground">{s.title ?? <span className="font-mono text-muted-foreground">{s.id}</span>}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {s.project ? <span className="truncate">{s.project}</span> : null}
                    {s.lastActivity ? <span>{ago(s.lastActivity)}</span> : null}
                    {s.agent !== "claude" ? (
                      <span className="inline-flex items-center gap-1 rounded border border-border px-1">
                        <span className="size-1.5 rounded-full" style={{ background: providerColor(s.agent) }} aria-hidden />
                        {agentName(s.agent)}
                      </span>
                    ) : null}
                  </div>
                  <StackBar parts={parts} metric={metric} colorOf={colorOf} share={max > 0 ? valueOf(metric, t) / max : 0} />
                </>
              }
            >
              <div className="cu-panel space-y-4 rounded-lg border border-border bg-background p-3">
                <ModelSplit parts={parts} metric={metric} colorOf={colorOf} />
                <TypeBar totals={t} metric={metric} />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{s.id}</span>
                  {s.threadId ? (
                    <Button size="sm" variant="outline" onClick={() => nav.toThread(s.threadId!)}>
                      <Icon name="MessageSquare" className="size-4" />
                      Open thread
                    </Button>
                  ) : null}
                </div>
              </div>
            </Row>
          ))}
        </ul>
      )}
      {rows.length > shown ? (
        <Button variant="ghost" size="sm" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
        </Button>
      ) : null}
    </div>
  );
}

function DaysList({ days, metric, colorOf, focus, onFocus }: { days: { date: string; parts: Part[] }[]; metric: Metric; colorOf: (m: string) => string; focus: string | null; onFocus: (d: string | null) => void }) {
  const rows = days
    .map((d) => ({ ...d, t: totalOf(d.parts) }))
    .filter((d) => tokensOf(d.t) > 0)
    .reverse();
  const max = Math.max(0, ...rows.map((r) => valueOf(metric, r.t)));
  const focused = useRef<HTMLLIElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focus]);
  if (rows.length === 0) return <Notice>No usage on any day in this range.</Notice>;
  return (
    <ul className="cu-list divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((d) => (
        <Row
          key={d.date}
          rowRef={d.date === focus ? focused : undefined}
          open={focus === d.date}
          onToggle={() => onFocus(focus === d.date ? null : d.date)}
          value={fmtMetric(metric, valueOf(metric, d.t))}
          sub={metric === "cost" ? `${fmtTokens(tokensOf(d.t))} tokens` : fmtCost(d.t.cost)}
          main={
            <>
              <div className="text-sm text-foreground">{dayLabel(d.date)}</div>
              <StackBar parts={d.parts} metric={metric} colorOf={colorOf} share={max > 0 ? valueOf(metric, d.t) / max : 0} />
            </>
          }
        >
          <div className="cu-panel space-y-4 rounded-lg border border-border bg-background p-3">
            <ModelSplit parts={d.parts} metric={metric} colorOf={colorOf} />
            <TypeBar totals={d.t} metric={metric} />
          </div>
        </Row>
      ))}
    </ul>
  );
}

function ModelsList({ models, metric, colorOf, selected, onSelect }: { models: [string, Totals][]; metric: Metric; colorOf: (m: string) => string; selected: string | null; onSelect: (m: string | null) => void }) {
  const sum = models.reduce((s, [, t]) => s + valueOf(metric, t), 0);
  const max = Math.max(0, ...models.map(([, t]) => valueOf(metric, t)));
  if (models.length === 0) return <Notice>No models in this range.</Notice>;
  return (
    <div className="cu-list overflow-hidden rounded-xl border border-border bg-card">
      <div className="cu-list-head grid grid-cols-[1.5rem_1fr_auto_auto_auto] gap-x-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>#</span>
        <span>Model</span>
        <span className="w-24 text-right">Cost</span>
        <span className="hidden w-14 text-right sm:block">Share</span>
        <span className="w-16 text-right">Tokens</span>
      </div>
      <ul className="cu-list divide-y divide-border">
        {models.map(([model, t], i) => {
          const isSelected = selected === model;
          return (
            <li key={model}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(isSelected ? null : model)}
                title={isSelected ? "Show every model again" : "Show only this model on the page"}
                className={cn(
                  "cu-hover grid w-full grid-cols-[1.5rem_1fr_auto_auto_auto] items-center gap-x-4 px-4 py-3 text-left outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isSelected && "bg-state-active",
                )}
              >
                <span className="cu-num text-xs text-muted-foreground">{i + 1}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-foreground">{model}</span>
                    {isSelected ? <Icon name="Check" className="size-3.5 shrink-0 text-foreground" /> : null}
                  </span>
                  <ShareLine share={max > 0 ? valueOf(metric, t) / max : 0} color={colorOf(model)} />
                </span>
                <span className="cu-num w-24 text-right text-sm text-foreground">{fmtCost(t.cost)}</span>
                <span className="cu-num hidden w-14 text-right text-sm text-muted-foreground sm:block">{sum > 0 ? pct1.format(valueOf(metric, t) / sum) : "0%"}</span>
                <span className="cu-num w-16 text-right text-sm text-muted-foreground">{fmtTokens(tokensOf(t))}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- page -------------------------------------------------------------------------------

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="cu-num mt-1 truncate text-lg font-medium text-foreground">{value}</div>
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-8" aria-busy>
      <div className="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          <Skeleton className="h-12 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-[220px]" />
      </div>
      <div className="grid grid-cols-2 gap-6 md:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function UsagePage() {
  const [range, setRange] = useState<Range>(remembered.range);
  const [metric, setMetric] = useState<Metric>(remembered.metric);
  const [tab, setTab] = useState<Tab>(remembered.tab);
  const [hiddenAgents, setHiddenAgents] = useHiddenAgents();
  const [model, setModel] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const { report, reportRange, error, loading, reload } = useReport(range);
  const limits = useLimits();
  const now = useNow();
  const breakdown = useRef<HTMLElement>(null);

  useEffect(() => {
    remembered.range = range;
    remembered.metric = metric;
    remembered.tab = tab;
  }, [range, metric, tab]);

  const agents = useMemo(
    () => [...new Set((report?.sessions ?? []).map((s) => s.agent))].sort((a, b) => SUPPORTED_AGENTS.indexOf(a) - SUPPORTED_AGENTS.indexOf(b)),
    [report],
  );
  // Switched-off providers are dropped, unless that would leave none.
  const shownAgents = useMemo(() => {
    const on = agents.filter((a) => !hiddenAgents.has(a));
    return on.length > 0 ? on : agents;
  }, [agents, hiddenAgents]);
  const byAgent = useCallback(
    (parts: Part[]) => (shownAgents.length === agents.length ? parts : parts.filter((p) => shownAgents.includes(p.agent))),
    [shownAgents, agents],
  );
  const partsOf = useCallback((parts: Part[]) => byAgent(parts).filter((p) => !model || p.model === model), [byAgent, model]);

  // Models ranked over the agent filter only, so the list stays whole while one model is picked.
  const models = useMemo(() => {
    const map = new Map<string, Totals>();
    for (const s of report?.sessions ?? []) for (const p of byAgent(s.parts)) map.set(p.model, addPart(map.get(p.model) ?? emptyTotals(), p));
    return [...map].sort((a, b) => valueOf(metric, b[1]) - valueOf(metric, a[1]));
  }, [report, byAgent, metric]);
  const multi = shownAgents.length > 1;
  // One provider: models in the terracotta rank steps. Several: each model in its provider's
  // colour, lighter for the provider's second and third models.
  const colorOf = useMemo(() => {
    const rank = new Map(models.map(([m], i) => [m, i]));
    if (!multi) return (m: string) => `var(--cu-m${Math.min(3, rank.get(m) ?? 3)})`;
    const agentOf = new Map<string, string>();
    for (const se of report?.sessions ?? []) for (const p of se.parts) if (!agentOf.has(p.model)) agentOf.set(p.model, p.agent);
    const step = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const [m] of models) {
      const a = agentOf.get(m) ?? "other";
      step.set(m, seen.get(a) ?? 0);
      seen.set(a, (seen.get(a) ?? 0) + 1);
    }
    const mix = [100, 62, 38];
    return (m: string) => {
      const c = providerColor(agentOf.get(m) ?? "other");
      const k = mix[Math.min(2, step.get(m) ?? 2)]!;
      return k === 100 ? c : `color-mix(in oklab, ${c} ${k}%, var(--background))`;
    };
  }, [models, multi, report]);
  const series: Series[] = multi ? shownAgents.map((a) => ({ agent: a, color: providerColor(a) })) : [];

  const sessionParts = useMemo(() => (report?.sessions ?? []).map((s) => partsOf(s.parts)), [report, partsOf]);
  const totals = useMemo(() => totalOf(sessionParts.flat()), [sessionParts]);
  const sessionCount = sessionParts.filter((parts) => parts.some((p) => tokensOf(p) > 0)).length;

  const days = useMemo(() => {
    if (!report) return [];
    const byDate = new Map(report.days.map((d) => [d.date, partsOf(d.parts)]));
    const today = localDate(now, TIME_ZONE);
    const since = sinceOf(reportRange, now, TIME_ZONE);
    const first = since ? `${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6)}` : report.days[0]?.date;
    if (!first) return [];
    return datesBetween(first, today).map((date) => ({ date, parts: byDate.get(date) ?? [] }));
  }, [report, partsOf, reportRange, now]);
  const points: Point[] = useMemo(
    () =>
      days.map((d) => {
        const t = totalOf(d.parts);
        const byModel = new Map<string, number>();
        for (const p of d.parts) byModel.set(p.model, (byModel.get(p.model) ?? 0) + (metric === "cost" ? p.cost : tokensOf(p)));
        const top = [...byModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const by: Record<string, number> = {};
        for (const p of d.parts) by[p.agent] = (by[p.agent] ?? 0) + (metric === "cost" ? p.cost : tokensOf(p));
        return { date: d.date, value: valueOf(metric, t), top, by };
      }),
    [days, metric],
  );

  const pickDay = (date: string) => {
    setTab("days");
    setFocusDay(date);
    breakdown.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const glance = useGlance(byAgent);
  const hero = valueOf(metric, totals);
  const agentTotal = (a: string) => totalOf((report?.sessions ?? []).filter((s) => s.agent === a).flatMap((s) => s.parts));
  const allAgentsValue = agents.reduce((sum, a) => sum + valueOf(metric, agentTotal(a)), 0);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="cu-ac cu-groups mx-auto box-border w-full max-w-5xl space-y-10 px-4 pb-12 pt-4 md:px-8 md:pt-6">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-base font-medium text-foreground">Usage Explorer</h1>
          {agents.length > 0 ? (
            <ProviderPicker
              detected={agents}
              shown={shownAgents}
              shareOf={(a) => (allAgentsValue > 0 ? pct1.format(valueOf(metric, agentTotal(a)) / allAgentsValue) : "0%")}
              onChange={(a, on) => {
                const next = new Set(hiddenAgents);
                if (on) next.delete(a);
                else next.add(a);
                setHiddenAgents(next);
                setModel(null);
              }}
            />
          ) : null}
          <Segmented label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />
          <Segmented
            label="Measure"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "cost", label: "Cost" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Read the logs again"
            disabled={loading}
            onClick={() => {
              reload();
              limits.reload();
            }}
          >
            <Icon name="RotateCcw" className={cn("size-4", loading && "motion-safe:animate-spin")} />
          </Button>
        </header>

        <AllClearTop limits={limits.limits} error={limits.error} now={now} glance={glance} />

        {error && !report ? (
          <Notice
            tone="error"
            action={
              <Button size="sm" variant="outline" onClick={reload}>
                Try again
              </Button>
            }
          >
            ccusage could not read your usage: {error}
          </Notice>
        ) : !report ? (
          <PageSkeleton />
        ) : report.sessions.length === 0 ? (
          <Notice>No usage in {RANGE_LABEL[reportRange].toLowerCase()}. ccusage reads local logs from Claude Code, Codex, Gemini CLI, OpenCode and the other agent CLIs it supports.</Notice>
        ) : (
          <div className="cu-groups space-y-10">

            <section aria-label="Overview" className="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="min-w-0 space-y-4">
                <div>
                  <div className="cu-num text-[40px] font-bold tracking-[-0.03em] text-foreground">
                    <Rolling value={hero} unit={metric} format={(v) => fmtMetric(metric, v)} />
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
                    {metric === "cost" ? ", API list-price estimate" : `, ${fmtCost(totals.cost)} at API prices`}
                  </div>
                </div>
                {model ? (
                  <button
                    type="button"
                    onClick={() => setModel(null)}
                    className="cu-hover inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-state-hover"
                  >
                    <span className="font-mono">{model}</span>
                    <Icon name="X" className="size-3" />
                  </button>
                ) : null}
                <ul className="space-y-2.5">
                  {shownAgents.map((a) => {
                    const t = totalOf(report.sessions.filter((s) => s.agent === a).flatMap((s) => partsOf(s.parts)));
                    return (
                      <li key={a} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex items-center gap-2 text-foreground">
                          {multi ? <span className="size-2 rounded-full" style={{ background: providerColor(a) }} aria-hidden /> : null}
                          {agentName(a)}
                        </span>
                        <span className="cu-num text-muted-foreground">
                          {hero > 0 ? pct1.format(valueOf(metric, t) / hero) : "0%"} of {metric}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Read by ccusage {ago(report.generatedAt)}
                  {loading ? ", refreshing" : ""}.
                </p>
              </div>
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground">
                  <span className="mr-auto">{metric === "cost" ? "Daily cost" : "Daily tokens"}</span>
                  {series.map((se) => (
                    <span key={se.agent} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-0.5 w-3 rounded-full" style={{ background: se.color }} aria-hidden />
                      {agentName(se.agent)}
                    </span>
                  ))}
                </div>
                {points.length > 1 ? <TrendChart points={points} metric={metric} series={series} /> : <Notice>One day in range. Pick a longer range to see the trend.</Notice>}
              </div>
            </section>

            <section aria-label="Totals" className="grid grid-cols-2 gap-6 md:grid-cols-5">
              <Stat label="Processed tokens" value={<Rolling value={tokensOf(totals)} format={fmtTokens} />} />
              <Stat label="Cached input" value={<Rolling value={totals.cacheRead} format={fmtTokens} />} />
              <Stat label="Uncached input" value={<Rolling value={totals.input} format={fmtTokens} />} />
              <Stat label="Output" value={<Rolling value={totals.output} format={fmtTokens} />} />
              <Stat label="Cache savings" value={<Rolling value={totals.split.saved} format={fmtCost} />} note="vs uncached input" />
            </section>

            <section aria-label="By type">
              <SectionTitle>{metric === "cost" ? "Cost by type" : "Tokens by type"}</SectionTitle>
              <TypeBar totals={totals} metric={metric} />
            </section>

            {points.length >= 14 ? (
              <section aria-label="Activity">
                <SectionTitle>Activity</SectionTitle>
                <Heatmap points={points} metric={metric} onPick={pickDay} />
              </section>
            ) : null}

            <section ref={breakdown} aria-label="Breakdown" className="scroll-mt-4">
              <SectionTitle
                aside={
                  <Segmented
                    label="Breakdown"
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "sessions", label: "Sessions" },
                      { value: "days", label: "Days" },
                      { value: "models", label: "Models" },
                    ]}
                  />
                }
              >
                Breakdown
              </SectionTitle>
              <div key={tab} className="cu-tab">
                {tab === "sessions" ? (
                  <SessionsList sessions={report.sessions} metric={metric} colorOf={colorOf} partsOf={partsOf} />
                ) : tab === "days" ? (
                  <DaysList days={days} metric={metric} colorOf={colorOf} focus={focusDay} onFocus={setFocusDay} />
                ) : (
                  <ModelsList models={models} metric={metric} colorOf={colorOf} selected={model} onSelect={setModel} />
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Lucide's "gauge" (ISC), which bb's built-in icon set does not include. */
function GaugeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "claude-usage/gauge", component: GaugeIcon });
  app.slots.navPanel({
    id: "usage",
    title: "Usage Explorer",
    icon: "claude-usage/gauge",
    path: "usage",
    component: UsagePage,
  });
});
