// Pure parsing for Claude Code transcripts (~/.claude/projects/<folder>/<id>.jsonl).
// No Node or bb imports, so server.ts and the tests share it.

/** How Claude Code names a project folder: every non-alphanumeric character becomes "-". */
export function encodeCwd(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

export type Place =
  | { kind: "bb"; threadId: string }
  | { kind: "desktop" }
  | { kind: "project"; name: string; worktree: string | null };

/**
 * Where a session ran, from its folder name and (when known) the cwd that
 * encodes to that folder. The folder alone is lossy ("/", ".", "_" and " "
 * all became "-"), so the project name comes from the cwd when there is one.
 */
export function placeOf(folder: string, cwd: string | null, home: string): Place {
  const thread = /-environment-personal-workspace-host-data-workspaces-thr-([a-z0-9]+)$/.exec(folder);
  if (thread) return { kind: "bb", threadId: `thr_${thread[1]}` };
  if (folder.startsWith(encodeCwd(`${home}/Library/Application Support/Claude/`))) return { kind: "desktop" };
  const worktree = /--claude-worktrees-(.+)$/.exec(folder)?.[1] ?? null;
  if (cwd !== null && encodeCwd(cwd) === folder) {
    const root = cwd.replace(/\/\.claude\/worktrees\/[^/]+\/?$/, "");
    return { kind: "project", name: root === home ? "~" : root.split("/").filter(Boolean).pop() ?? root, worktree };
  }
  const rest = worktree === null ? folder : folder.slice(0, folder.length - worktree.length - "--claude-worktrees-".length);
  const homeKey = encodeCwd(home);
  const name = rest === homeKey ? "~" : rest.startsWith(`${homeKey}-`) ? rest.slice(homeKey.length + 1) : rest.replace(/^-+/, "");
  return { kind: "project", name: name || "~", worktree };
}

export interface SessionState {
  sessionId: string;
  folder: string;
  /** The cwd that encodes to the folder (where `claude --resume` works); else the first one seen. */
  cwd: string | null;
  branch: string | null;
  entrypoint: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
  /** The newest prompts, oldest first. */
  lastPrompts: string[];
  prompts: number;
  lastAt: string | null;
  /** Lowercased prompt text for search. */
  search: string;
}

export function newState(sessionId: string, folder: string): SessionState {
  return {
    sessionId,
    folder,
    cwd: null,
    branch: null,
    entrypoint: null,
    customTitle: null,
    aiTitle: null,
    summary: null,
    firstPrompt: null,
    lastPrompts: [],
    prompts: 0,
    lastAt: null,
    search: "",
  };
}

const LAST_PROMPTS = 5;
/** shortcut: search covers the first 20KB of a session's prompts, raise it if long sessions miss matches. */
const SEARCH_CAP = 20_000;
/** Lines up to this size are parsed whole; bigger ones are tool output or request bodies, read by their ends only. */
export const PARSE_ALL_BYTES = 64 * 1024;
export const HEAD_BYTES = 400;
export const TAIL_BYTES = 800;

/** A transcript line as the reader hands it over: its size, its two ends, and the full text on demand. */
export interface Line {
  size: number;
  head: string;
  tail: string;
  text(): string;
}

export function lineOf(text: string): Line {
  return { size: text.length, head: text.slice(0, HEAD_BYTES), tail: text.slice(-TAIL_BYTES), text: () => text };
}

type Json = Record<string, unknown>;

function parse(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

/** A top-level string field read from a line's tail without parsing the line. */
function field(tail: string, name: string): string | undefined {
  const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(tail);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function isToolResultHead(head: string): boolean {
  return head.includes('"tool_use_id"') || head.includes('"type":"tool_result"');
}

/** The event a line carries, or null when it cannot matter (tool output, request bodies, attachments). */
export function eventOf(line: Line, { assistantText = false } = {}): Json | null {
  if (line.size <= PARSE_ALL_BYTES) return parse(line.text());
  if (line.head.includes('"type":"user"')) return isToolResultHead(line.head) ? null : parse(line.text());
  if (!line.tail.includes('"type":"assistant"')) return null;
  if (assistantText) return parse(line.text());
  // The index needs only an assistant turn's metadata, which sits at the end of the line.
  return {
    type: "assistant",
    isSidechain: line.head.includes('"isSidechain":true'),
    timestamp: field(line.tail, "timestamp"),
    cwd: field(line.tail, "cwd"),
    gitBranch: field(line.tail, "gitBranch"),
    entrypoint: field(line.tail, "entrypoint"),
  };
}

const DROPPED_BLOCKS = /<(system-reminder|artifact-view-context|side-sessions-event)\b[^>]*>[\s\S]*?<\/\1>/g;
const NOT_PROMPTS = [
  "[Request interrupted",
  "<task-notification",
  "<local-command-",
  "<bash-stdout",
  "<bash-stderr",
  "<artifact-view-context",
  "<side-sessions-event",
  "Caveat: The messages below",
];

/** What the person typed, or null for tool results, meta entries, and app-injected text. */
export function promptOf(event: Json): string | null {
  if (event.type !== "user" || event.isMeta || event.isSidechain || event.isCompactSummary || event.isVisibleInTranscriptOnly) return null;
  const message = event.message as Json | undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content as Json[];
    if (parts.some((part) => part?.type === "tool_result")) return null;
    text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  } else return null;
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const name = command[1]!.startsWith("/") ? command[1]! : `/${command[1]}`;
    return args ? `${name} ${args}` : name;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return `! ${bash[1]!.trim()}`;
  const cleaned = text.replace(DROPPED_BLOCKS, "").trim();
  if (cleaned === "" || NOT_PROMPTS.some((prefix) => cleaned.startsWith(prefix))) return null;
  return cleaned;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Folds one transcript line into the session's summary. Lines must arrive in file order. */
export function foldLine(state: SessionState, line: Line): void {
  const event = eventOf(line);
  if (event === null) return;
  switch (event.type) {
    case "custom-title":
      state.customTitle = str(event.customTitle) ?? state.customTitle;
      return;
    case "ai-title":
      state.aiTitle = str(event.aiTitle) ?? state.aiTitle;
      return;
    case "summary":
      state.summary = str(event.summary) ?? state.summary;
      return;
    case "user":
    case "assistant":
      break;
    default:
      return;
  }
  if (event.isSidechain) return;
  const cwd = str(event.cwd);
  if (cwd !== null && (state.cwd === null || (encodeCwd(state.cwd) !== state.folder && encodeCwd(cwd) === state.folder))) state.cwd = cwd;
  const branch = str(event.gitBranch);
  if (branch !== null && branch !== "HEAD") state.branch = branch;
  state.entrypoint ??= str(event.entrypoint);
  const at = str(event.timestamp);
  if (at !== null && (state.lastAt === null || at > state.lastAt)) state.lastAt = at;
  const prompt = promptOf(event);
  if (prompt === null) return;
  state.prompts += 1;
  state.firstPrompt ??= prompt.slice(0, 2000);
  state.lastPrompts = [...state.lastPrompts, prompt.slice(0, 2000)].slice(-LAST_PROMPTS);
  if (state.search.length < SEARCH_CAP) state.search += ` ${prompt.slice(0, 2000).toLowerCase()}`;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function titleOf(state: SessionState): string {
  return state.customTitle ?? state.aiTitle ?? state.summary ?? (state.firstPrompt ? oneLine(state.firstPrompt, 120) : "Untitled session");
}

export type Source = "desktop" | "cli" | "sdk" | null;

export function sourceOf(entrypoint: string | null): Source {
  if (entrypoint === "claude-desktop") return "desktop";
  if (entrypoint === "cli") return "cli";
  return entrypoint?.startsWith("sdk") ? "sdk" : null;
}

/** Every term must appear in the title or the prompts. */
export function matches(state: SessionState, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${titleOf(state).toLowerCase()} ${state.search}`;
  return terms.every((term) => haystack.includes(term));
}

export type TranscriptItem = { kind: "user" | "assistant" | "tool"; text: string; at: string | null };

/** shortcut: one message shows at most this much, enough to read; open the JSONL for the rest. */
export const ITEM_CHARS = 12_000;

function clip(text: string): string {
  return text.length > ITEM_CHARS ? `${text.slice(0, ITEM_CHARS)}\n\n… (truncated)` : text;
}

const TOOL_HINTS = ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "skill"];

/** A tool call as one line: its name and the input that says what it did. */
export function toolLine(name: string, input: unknown): string {
  const fields = input !== null && typeof input === "object" ? (input as Json) : {};
  const hint = TOOL_HINTS.map((key) => fields[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return hint ? `${name}: ${oneLine(hint, 140)}` : name;
}

/** The readable items one transcript line contributes: prompts, assistant text, and tool calls. */
export function itemsOf(line: Line): TranscriptItem[] {
  const event = eventOf(line, { assistantText: true });
  if (event === null || event.isSidechain) return [];
  const at = str(event.timestamp);
  if (event.type === "user") {
    const prompt = promptOf(event);
    return prompt === null ? [] : [{ kind: "user", text: clip(prompt), at }];
  }
  if (event.type !== "assistant") return [];
  const content = (event.message as Json | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const items: TranscriptItem[] = [];
  for (const part of content as Json[]) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") items.push({ kind: "assistant", text: clip(part.text), at });
    else if (part?.type === "tool_use" && typeof part.name === "string") items.push({ kind: "tool", text: toolLine(part.name, part.input), at });
  }
  return items;
}
