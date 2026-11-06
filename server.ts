// bb-plugin-claude-usage: AI coding usage by session, day and model, from
// ccusage (every agent CLI it detects: Claude Code, Codex, Gemini CLI, ...),
// plus Claude plan limits.
//
// ccusage reads the local logs itself; this server runs its pinned native
// binary, caches the JSON, and adds what ccusage leaves out: Claude Code
// session titles (from the transcript's two ends) and the plan's quota windows.
import { execFile } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type Session } from "./contract";
import { foldLine, lineOf, newState, placeOf, titleOf } from "./sessions";
import { isTimeZone, planLabel, readOauthUsage, readReport, sinceOf, wholeLines, type Range, type Window } from "./usage";

const run = promisify(execFile);

const CCUSAGE_VERSION = "20.0.48";
/** A report or limits reading this fresh is served without running anything. */
const FRESH_MS = 60_000;
/** Claude Code rewrites the session title every few turns, so the newest sits near the end. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;

type Report = z.infer<(typeof rpcContract)["report"]["output"]>;
type Limits = z.infer<(typeof rpcContract)["limits"]["output"]>;

/** The native ccusage binary installed with this plugin, or npx as a last resort. */
function ccusageCommand(): { file: string; prefix: string[] } {
  const exe = process.platform === "win32" ? "ccusage.exe" : "ccusage";
  try {
    const pkg = createRequire(import.meta.url).resolve(`@ccusage/ccusage-${process.platform}-${process.arch}/package.json`);
    return { file: join(dirname(pkg), "bin", exe), prefix: [] };
  } catch {
    return { file: "npx", prefix: ["-y", `ccusage@${CCUSAGE_VERSION}`] };
  }
}

async function ends(path: string, size: number): Promise<string[]> {
  const fh = await open(path, "r");
  try {
    const read = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.toString("utf8", 0, bytesRead);
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) return wholeLines(`${await read(0, size)}\n`, false);
    return [...wholeLines(await read(0, HEAD_BYTES), false), ...wholeLines(await read(size - TAIL_BYTES, TAIL_BYTES), true)];
  } finally {
    await fh.close();
  }
}

export default async function plugin(bb: BbPluginApi) {
  const home = homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const stop = new AbortController();
  bb.onDispose(() => stop.abort());
  const ccusage = ccusageCommand();
  // A bb launched from the Dock has a minimal PATH; npx (the fallback) lives in one of these.
  const env = { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"), NO_COLOR: "1" };

  // One ccusage run at a time: each reads every log on the machine.
  let queue: Promise<unknown> = Promise.resolve();
  function ccusageJson(args: string[]): Promise<unknown> {
    const next = queue.then(async () => {
      const { stdout } = await run(ccusage.file, [...ccusage.prefix, ...args, "--json", "--offline"], {
        env,
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
        signal: stop.signal,
      });
      return JSON.parse(stdout) as unknown;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  // Claude Code session id -> its transcript, found by one directory listing per report.
  async function transcripts(): Promise<Map<string, { path: string; folder: string }>> {
    const found = new Map<string, { path: string; folder: string }>();
    const root = join(claudeRoot, "projects");
    for (const folder of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!folder.isDirectory()) continue;
      for (const entry of await readdir(join(root, folder.name), { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          found.set(entry.name.slice(0, -".jsonl".length), { path: join(root, folder.name, entry.name), folder: folder.name });
        }
      }
    }
    return found;
  }

  type Meta = { title: string; project: string; threadId: string | null };
  const metas = new Map<string, Meta>(); // by path:size:mtime
  async function metaOf(id: string, file: { path: string; folder: string }): Promise<Meta | null> {
    const info = await stat(file.path).catch(() => null);
    if (!info) return null;
    const key = `${file.path}:${info.size}:${info.mtimeMs}`;
    const cached = metas.get(key);
    if (cached) return cached;
    const state = newState(id, file.folder);
    for (const line of await ends(file.path, info.size)) foldLine(state, lineOf(line));
    const place = placeOf(file.folder, state.cwd, home);
    const meta: Meta = {
      title: titleOf(state),
      project: place.kind === "bb" ? "bb thread" : place.kind === "desktop" ? "Claude desktop" : place.worktree ? `${place.name} · ${place.worktree}` : place.name,
      threadId: place.kind === "bb" ? place.threadId : null,
    };
    metas.set(key, meta);
    return meta;
  }

  const reports = new Map<string, { at: number; value: Promise<Report> }>();
  async function buildReport(range: Range, timeZone: string): Promise<Report> {
    const since = sinceOf(range, Date.now(), timeZone);
    const json = await ccusageJson(["daily", "--sections", "daily,session", "--by-agent", "-z", timeZone, ...(since ? ["--since", since] : [])]);
    const { days, sessions } = readReport(json);
    const files = await transcripts();
    const enriched: Session[] = [];
    for (const s of sessions) {
      const file = s.agent === "claude" ? files.get(s.id) : undefined;
      const meta = file ? await metaOf(s.id, file).catch(() => null) : null;
      enriched.push({ ...s, title: meta?.title ?? null, project: meta?.project ?? null, threadId: meta?.threadId ?? null });
    }
    return { generatedAt: Date.now(), days, sessions: enriched };
  }

  // ---- Limits ----------------------------------------------------------------

  /** Claude Code's OAuth login: the macOS Keychain first, then ~/.claude/.credentials.json. Never logged. */
  async function credentials(): Promise<{ accessToken: string; expiresAt: number | null; plan: string | null } | null> {
    const parse = (text: string) => {
      try {
        const oauth = (JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
        if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return null;
        return {
          accessToken: oauth.accessToken,
          expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
          plan: planLabel(oauth.subscriptionType, oauth.rateLimitTier),
        };
      } catch {
        return null;
      }
    };
    if (process.platform === "darwin") {
      const keychain = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 10_000 }).catch(() => null);
      const found = keychain ? parse(keychain.stdout.trim()) : null;
      if (found) return found;
    }
    const file = await readFile(join(claudeRoot, ".credentials.json"), "utf8").catch(() => null);
    return file ? parse(file) : null;
  }

  async function fromAnthropic(): Promise<{ plan: string | null; windows: Window[] }> {
    const creds = await credentials();
    if (!creds) throw new Error("Claude Code is not signed in on this machine.");
    if (creds.expiresAt !== null && Date.now() >= creds.expiresAt) throw new Error("Claude Code's sign-in expired. Run `claude` to refresh it.");
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(response.status === 429 ? "Anthropic is throttling usage checks right now." : `Anthropic answered ${response.status}.`);
    const windows = readOauthUsage(await response.json());
    if (windows.length === 0) throw new Error("Anthropic's usage response had no windows.");
    return { plan: creds.plan, windows };
  }

  const bbUsage = z.object({
    machines: z.array(
      z.object({
        providers: z.array(
          z.object({
            providerId: z.string(),
            usage: z
              .object({
                status: z.string(),
                planLabel: z.string().nullable().optional(),
                windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() })).optional(),
              })
              .nullable(),
          }),
        ),
      }),
    ),
  });

  /** The fallback: bb's own provider-usage plugin, which reads the same endpoint its own way. */
  async function fromBb(): Promise<{ plan: string | null; windows: Window[] }> {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "bb--provider-usage",
      method: "getUsage",
      input: { force: false, machineIds: null, providerIds: ["claude-code"], maxAgeMs: FRESH_MS },
      outputSchema: bbUsage,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]),
    });
    for (const machine of result.machines) {
      for (const p of machine.providers) {
        if (p.providerId !== "claude-code" || p.usage?.status !== "ok" || !p.usage.windows) continue;
        return {
          plan: p.usage.planLabel ?? null,
          windows: p.usage.windows.map((w) => {
            const fiveHour = /five|session/i.test(w.label);
            return {
              kind: fiveHour ? "five-hour" : "weekly",
              label: fiveHour ? "Session" : w.label.replace(/ limit$/i, ""),
              usedPercent: w.usedPercent,
              resetsAt: w.resetsAt,
              windowMs: fiveHour ? 5 * 3_600_000 : 7 * 86_400_000,
            };
          }),
        };
      }
    }
    throw new Error("bb has no Claude Code usage either.");
  }

  async function burn(): Promise<Limits["burn"]> {
    const json = (await ccusageJson(["blocks", "--active"]).catch(() => null)) as { blocks?: Record<string, unknown>[] } | null;
    const block = json?.blocks?.find((b) => b.isActive === true);
    const rate = (block?.burnRate as { costPerHour?: unknown } | undefined)?.costPerHour;
    if (!block || typeof rate !== "number" || typeof block.costUSD !== "number" || typeof block.endTime !== "string") return null;
    return { costPerHour: rate, blockCost: block.costUSD, blockEndsAt: block.endTime };
  }

  async function buildLimits(): Promise<Limits> {
    const [quota, live] = await Promise.all([
      fromAnthropic()
        .then((q) => ({ ...q, source: "anthropic" as const, error: null }))
        .catch((own: unknown) =>
          fromBb()
            .then((q) => ({ ...q, source: "bb" as const, error: null }))
            .catch(() => ({ plan: null, windows: [], source: null, error: own instanceof Error ? own.message : String(own) })),
        ),
      burn(),
    ]);
    return { ...quota, burn: live, observedAt: Date.now() };
  }

  let limits: { at: number; value: Promise<Limits> } | null = null;

  bb.rpc.register(rpcContract, {
    report: ({ range, timeZone, refresh }) => {
      if (!isTimeZone(timeZone)) throw new Error(`Unknown time zone ${JSON.stringify(timeZone)}`);
      const key = `${range}|${timeZone}`;
      const hit = reports.get(key);
      if (!refresh && hit && Date.now() - hit.at < FRESH_MS) return hit.value;
      const value = buildReport(range, timeZone);
      reports.set(key, { at: Date.now(), value });
      value.catch((cause: unknown) => {
        reports.delete(key);
        bb.log.warn(`ccusage report failed: ${String(cause)}`);
      });
      return value;
    },
    limits: ({ refresh }) => {
      if (!refresh && limits && Date.now() - limits.at < FRESH_MS) return limits.value;
      const value = buildLimits();
      limits = { at: Date.now(), value };
      value.catch(() => (limits = null));
      return value;
    },
  });
}
