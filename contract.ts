// RPC contract shared by server.ts and app.tsx. Kept free of Node imports so
// the app bundle can import it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RANGES } from "./usage";

const part = z.object({
  agent: z.string(),
  model: z.string(),
  input: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
  output: z.number(),
  cost: z.number(),
});

const session = z.object({
  id: z.string(),
  agent: z.string(),
  lastActivity: z.number().nullable(),
  parts: z.array(part),
  /** Claude Code sessions only: read from the transcript. */
  title: z.string().nullable(),
  project: z.string().nullable(),
  /** Set when the session is a bb thread's own Claude session. */
  threadId: z.string().nullable(),
});
export type Session = z.infer<typeof session>;

const window = z.object({
  kind: z.enum(["five-hour", "weekly"]),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  windowMs: z.number(),
});

export const rpcContract = defineRpcContract({
  /** Usage for a range, from ccusage. Cached for a minute unless `refresh`. */
  report: {
    input: z.object({ range: z.enum(RANGES), timeZone: z.string().max(64), refresh: z.boolean() }),
    output: z.object({
      generatedAt: z.number(),
      days: z.array(z.object({ date: z.string(), parts: z.array(part) })),
      sessions: z.array(session),
    }),
  },
  /** Claude plan limits: Anthropic first, bb's provider-usage as the fallback, plus ccusage's live burn rate. */
  limits: {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({
      source: z.enum(["anthropic", "bb"]).nullable(),
      plan: z.string().nullable(),
      windows: z.array(window),
      burn: z.object({ costPerHour: z.number(), blockCost: z.number(), blockEndsAt: z.string() }).nullable(),
      error: z.string().nullable(),
      observedAt: z.number(),
    }),
  },
});
