# Live Activity Feed (issue #77)

Make the TUI show work as it happens instead of only finished tool results.
Four features, each independently toggleable, built in two phases.

## Features & toggles

Per-feature switches, runtime via `/live` and seeded from env:

| Feature   | What it adds                                              | Env default            | Default |
|-----------|----------------------------------------------------------|------------------------|---------|
| `tools`   | Show a tool the moment it starts (`⚙ write_file: x.py`), update the same line to `✓`/`✗` on completion | `SMALLCODE_LIVE_TOOLS`   | ON |
| `context` | Live context-usage meter in the footer, updated per action | `SMALLCODE_LIVE_CONTEXT` | ON |
| `stream`  | Stream the model reply token-by-token into the chat       | `SMALLCODE_LIVE_STREAM`  | OFF (opt-in) |
| `thinking`| Live dimmed preview of reasoning as it streams            | `SMALLCODE_LIVE_THINKING`| OFF (opt-in) |

`/live` prints state; `/live <feature> [on|off]` toggles/sets one.
`stream`/`thinking` default OFF because they change the model request path.

## Phase A — tool-start + context meter (no model-path change)

- **`bin/live_settings.js`** (new): pure module. `getLiveSettings()` seeds from
  env; `setLive(feature, value)`; `resolveLiveCommand(arg)` → `{ action, feature,
  value, text }` for the `/live` command. Unit-testable in isolation.
- **TUI** (`src/tui/fullscreen.js`):
  - `toolStart(name, detail)` → push an in-progress `⚙` line to chat + tool
    panel, store its indices, return a handle `{ chatIdx, toolIdx }`.
  - `toolEnd(handle, status, detail)` → rewrite that same line to `✓`/`✗`.
    Falls back to `addTool` if the handle is missing.
  - `setContextMeter(pct, used, window)` → footer indicator `ctx 42% (13k/32k)`.
- **TokenMonitor**: track `lastPromptTokens`; `contextMeter(window)` → `{ pct,
  used, window }`.
- **Agent loop** (`bin/smallcode.js`): at the tool-dispatch site, when
  `tools` on + fullscreen, `toolStart` before exec and `toolEnd` after — wired
  through the existing `console.log`/`stdout.write` overrides so there is no
  duplicate line. When off, the current behavior is unchanged. After each tool
  and each turn, update `setContextMeter` when `context` on.
- **`/live` command**: handler in `bin/commands.js` + TUI palette entry.

## Phase B — streaming + thinking (gated, isolated risk)

- In `chatCompletion` (`bin/smallcode.js`), when `stream` on: set
  `body.stream = true`, consume SSE incrementally (reuse the `model_client.js`
  pattern), call `streamToken(delta.content)` for visible text, route
  `reasoning_content`/`<think>` deltas to a dimmed area when `thinking` on,
  accumulate `tool_calls` deltas, then **reassemble the exact same `data`
  object** the function returns today so all downstream logic is untouched.
- Any streaming error falls back to the response so far. The non-streaming
  path (default) is left byte-for-byte unchanged.
- Extract SSE assembly into a testable helper.

## Testing

- `live_settings`: env parsing + `/live` resolution (pure unit tests).
- TUI: `toolStart`/`toolEnd` line mutation; `setContextMeter` formatting.
- Phase B: SSE-assembly helper fed canned chunks → assert assembled `data` +
  `streamToken` call sequence.

## Non-goals (YAGNI)

- Persisting toggle state across restarts (env default + runtime only).
- A separate scrollable "activity" pane — reuse the existing chat + tool panel.
