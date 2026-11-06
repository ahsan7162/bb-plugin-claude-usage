
# Usage Explorer (bb-plugin-claude-usage)



https://github.com/user-attachments/assets/19212484-8d32-43a5-babe-1175f62005d7




<img width="2720" height="1800" alt="all-clear" src="https://github.com/user-attachments/assets/13ab5eba-d338-44aa-a640-2c7c403f12d3" />
<img width="2720" height="1800" alt="models" src="https://github.com/user-attachments/assets/44e27181-5fb7-4418-81a5-f76f324afea4" />
<img width="2720" height="1800" alt="providers" src="https://github.com/user-attachments/assets/937285fd-c7d9-404d-9051-a8962c5da507" />
<img width="2720" height="1800" alt="sessions" src="https://github.com/user-attachments/assets/ead46897-c7bf-4974-b58e-120652340452" />




A **Usage Explorer** page in bb: AI coding usage by session, day and model, plus Claude
plan limits with the pace you are spending them at.

```
npm install
npm test            # usage.test.ts: ccusage JSON mapping, cost split, ranges, limits, titles
bb plugin build
bb plugin install path:$PWD --yes
bb plugin logs claude-usage
```

## Where the numbers come from

- **Usage:** [ccusage](https://ccusage.com) `20.0.48`, pinned in `dependencies`, run as its
  native binary with `--offline` (no network). It reads local logs from Claude Code, Codex,
  Gemini CLI, OpenCode and the other agent CLIs it supports; an agent filter appears once a
  second agent shows up. One run per range, cached for a minute, one run at a time.
- **Session titles and projects** (Claude Code only): the first 64 KB and last 128 KB of each
  transcript, folded through `sessions.ts`.
- **Limits:** Anthropic's `/api/oauth/usage` with Claude Code's own sign-in (macOS Keychain,
  then `~/.claude/.credentials.json`), read on the server and never sent to the page or logged.
  If that fails, bb's built-in `bb--provider-usage` plugin. The 5-hour burn rate is ccusage's
  `blocks --active`.
- **Cost by type** is an estimate: ccusage gives one cost per model, so input, cache reads and
  output are priced from the table in `usage.ts` and cache writes take the rest.

## Layout

- `usage.ts`: pure helpers (ccusage JSON to rows, cost split, ranges, limit projection).
- `server.ts`: runs ccusage, reads titles, fetches limits; the `report` and `limits` RPCs.
- `contract.ts`: the RPC contract shared with the page.
- `app.tsx` + `tokens.css`: the page at `/plugins/claude-usage/usage`.

## Limits

- ccusage ships as a native binary through npm optional dependencies (macOS, Linux and Windows,
  arm64 and x64). bb's git installs omit optional dependencies, so there the server downloads the
  binary for its platform once from registry.npmjs.org into the plugin's data folder, checks it
  against the sha512 pinned in `usage.ts` (a test keeps it equal to `package-lock.json`), and
  unpacks it with the system `tar`. If that fails, it falls back to `npx -y ccusage@20.0.48`.
- Limits read Claude Code's own sign-in (macOS Keychain, then `~/.claude/.credentials.json`) on
  the server; the token is never sent to the page or logged, and never refreshed or written.
- Costs are API list prices. They include the 2x price of 1-hour cache writes, so they run higher
  than bb's own usage panel, which appears to charge every cache write at 1.25x.
