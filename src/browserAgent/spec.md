# MindStudio Browser Agent — original design spec

> **This is the pre-implementation design spec, kept for its rationale, not as a description of the
> code.** It is why the browser agent works the way it does: why an injected script rather than a
> headless browser, why a compact accessibility tree rather than screenshots, why the cursor is a
> feature. Those arguments still hold and are recorded nowhere else.
>
> Where it describes mechanics, prefer `README.md` in this directory. Two things named here were
> built differently or later removed:
>
> - **Transport.** The spec plans an HTTP command queue (`GET /commands`, `POST /results`). The
>   implementation uses a persistent WebSocket at `/__mindstudio_dev__/ws` — see
>   `commands/ws-client.ts`. The "Tunnel-side changes needed" section is a to-do list that was
>   completed and then superseded.
> - **Annotation notes.** Shipped, then removed. The user-facing annotation flow now captures the
>   viewport (`commands/screenshot.ts`) and the IDE renders the annotator outside the page.

A lightweight JavaScript library injected into MindStudio app previews that gives AI agents visibility into and control over the browser. Compiles to a single JS file served by the dev tunnel's proxy.

## Why

AI agents building MindStudio apps can test backend methods directly (`run-method`), but have no way to verify the frontend works — does the page render correctly? Does clicking "Create Board" open the modal? Does the list update after submitting? The agent wrote the code but can't see or interact with the result.

This library bridges that gap: the agent can snapshot the page, interact with it via text-based commands, and watch the results — all without a headless browser. The user also gets a visual show: a Figma-style cursor moving around the preview, clicking buttons, typing into fields, demonstrating the app live.

## How this is different from traditional browser automation

Most AI browser automation tools (Playwright, Puppeteer, Browserbase, Stagehand, etc.) are designed for a fundamentally different problem: an agent navigating an **unknown** website. The hard part is understanding what's on the page — parsing complex layouts, figuring out which button does what, dealing with dynamic content that could be anything. These tools throw heavyweight solutions at this: headless Chrome instances, CDP connections, computer vision, LLM-powered element detection.

**We don't have any of these problems.** Our agent is operating in local dev on an app it just built. It:

- **Wrote the code** — it knows every component, every selector, every handler. It doesn't need AI vision to figure out that the big blue rectangle is a "Submit" button — it literally just wrote `<Button onClick={handleSubmit}>Submit</Button>`.
- **Knows the data model** — it defined the tables, wrote the methods, seeded the test data. It knows exactly what the list should contain and what the API returns.
- **Knows the structure** — it scaffolded the page layout, the routing, the state management. It doesn't need to explore or discover — it has the full mental model.
- **Is running locally** — no network latency to a cloud browser, no screenshots-over-the-wire, no CDP overhead. The script runs in the same iframe the user is looking at.

This means we can take a radically lighter approach:

- **No headless browser needed.** An injected script in the existing page is sufficient — the browser is already open (either in the IDE's iframe or a user's tab).
- **Text-based element resolution works.** The agent knows element text/labels because it wrote them. We don't need computer vision or complex heuristics — `click "Create Board"` is unambiguous when you wrote the JSX.
- **DOM snapshots beat screenshots.** The agent can reason about a compact accessible tree far more effectively than a pixel screenshot, and it can cross-reference against its own code to understand what each element is.
- **The visible cursor is a feature, not a workaround.** Traditional automation hides the browser. We're showing it — the user watches the agent demo the app in real time. This is a UX feature, not a testing implementation detail.

The result is something much simpler, faster, and more reliable than general-purpose browser automation, because we're solving a much narrower (and easier) problem: **an agent verifying and demonstrating code it already understands.**

## Architecture

### Deployment

- Compiles to a single JS file (e.g. `browser-agent.js`)
- The dev tunnel's proxy serves it at `/__mindstudio_dev__/agent.js`
- Injected into every HTML response via `<script src="/__mindstudio_dev__/agent.js"></script>`
- Runs inside the app's iframe in the MindStudio web IDE (or in a standalone tab)

### Communication with the tunnel

The tunnel proxy is the relay between the AI agent (stdin/stdout) and this script (HTTP):

```
AI Agent ──stdin──▶ Tunnel ──queue──▶ Proxy endpoint
                                          │
Browser script ◀──GET /commands───────────┘
Browser script ──POST /results──▶ Proxy ──stdout──▶ AI Agent
Browser script ──POST /logs────▶ Proxy ──file──▶ .logs/browser.ndjson
```

**Endpoints on the proxy:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/__mindstudio_dev__/agent.js` | GET | Serve the compiled script |
| `/__mindstudio_dev__/commands` | GET | Poll for pending commands (long-poll or short-poll) |
| `/__mindstudio_dev__/results` | POST | Return command execution results |
| `/__mindstudio_dev__/logs` | POST | Browser log entries (already implemented) |

### Idempotency

The script must handle being loaded multiple times (HMR, navigation, iframe reload). Guard with `window.__MINDSTUDIO_BROWSER_AGENT__` flag.

## Features

### 1. Browser Log Capture (already implemented in tunnel)

Captures and POSTs to `/__mindstudio_dev__/logs`:

- **Console:** `console.log/info/warn/error/debug` — override, call original, buffer entry
- **JS errors:** `window.addEventListener('error')` — message, stack, source, line, column
- **Unhandled rejections:** `window.addEventListener('unhandledrejection')`
- **Network failures:** Monkey-patch `fetch` — log non-ok responses (with body, up to 1000 chars) and network errors
- **User interactions:** Capture-phase click listener — target selector, text content

This is currently inlined in the tunnel's proxy. Should be moved into this project.

### 2. DOM Snapshot

Produces a compact, token-efficient accessibility-tree-style representation of the page. Modeled after [Vercel's agent-browser](https://github.com/vercel-labs/agent-browser) format.

**Output format:**

```
header
  h1 "My Boards" [ref=e1]
  button "Create Board" [ref=e2]
main
  section "Board List"
    article "Product Launch" [ref=e3]
      span "3 columns · 12 cards"
    article "Personal" [ref=e4]
      span "2 columns · 5 cards"
dialog [open] [ref=e5]
  h2 "Create Board"
  label "Board name"
    input [ref=e6] [value=""]
  label "Description"
    textarea [ref=e7] [value=""]
  button "Cancel" [ref=e8]
  button "Create" [ref=e9] [disabled]
div.toast.toast-error [visible] "Failed to save" [ref=e10]
```

**Design principles:**

- Semantic tags and ARIA roles, not CSS classes (styled-components classes are gibberish)
- Visible text content in quotes
- Form values shown (`[value="..."]`)
- State shown (`[open]`, `[disabled]`, `[checked]`, `[visible]` for elements that are display-toggled)
- Stable ref IDs (`[ref=eN]`) for targeting elements in commands
- Skip hidden elements (`display: none`, `visibility: hidden`, `aria-hidden="true"`)
- Skip empty structural wrappers (divs with no semantic meaning, no text, no role)
- Indentation shows nesting
- Target ~200-400 tokens for a typical page

**Implementation:** Walk the DOM, compute accessible role and name for each element. Use implicit role mapping (button, input, heading, link, etc.) and explicit `role`/`aria-label`/`aria-labelledby` attributes. Consider using `dom-accessibility-api` npm package for correct accessible name computation, or hardcode the common cases.

### 3. Element Resolution

Commands target elements by human-readable descriptors, not CSS selectors. Resolution order:

1. **By ref:** `e5` → look up the ref from the last snapshot
2. **By text:** `"Create Board"` → find element whose accessible name or visible text matches
3. **By role + text:** `button "Create Board"` → find element with matching role and name
4. **By label:** `"Board name"` → find input associated with a label containing that text
5. **By CSS selector (fallback):** `#my-id` or `[data-testid="..."]`

If multiple elements match, prefer visible/interactive ones. Return an error if zero or ambiguous matches.

### 4. Commands

#### `snapshot`

Returns the compact DOM tree described above.

#### `click`

Click an element. Dispatches the full realistic event sequence so React/Vue/Svelte handlers fire correctly:

```
pointerdown → mousedown → focus → pointerup → mouseup → click
```

Consider using `@testing-library/user-event` for robust cross-framework event dispatching.

#### `type`

Type text into an element. Must work with React's synthetic event system — use the native `HTMLInputElement.prototype.value` setter trick plus `input`/`change` events, or `user-event` for the full key-by-key sequence.

Characters are dispatched one at a time with realistic timing for visual effect.

#### `select`

Select an option from a `<select>` element, or click a listbox option.

#### `wait`

Wait for an element matching a descriptor to appear in the DOM (poll with timeout). Useful in batched sequences after actions that trigger async updates.

#### `evaluate`

Run arbitrary JavaScript and return the result. Escape hatch for anything the command set doesn't cover.

#### `screenshot` (future)

Capture the viewport via `html2canvas` or similar. Returns base64 image. Lower priority — DOM snapshots are more useful for AI agents, but screenshots help with visual/layout debugging.

### 5. Batched Execution

Commands can be sent as a sequence that executes in order with visible animation between steps:

```json
{
  "steps": [
    {"command": "snapshot"},
    {"command": "click", "text": "Create Board"},
    {"command": "wait", "role": "dialog", "timeout": 3000},
    {"command": "type", "label": "Board name", "text": "My New Board"},
    {"command": "click", "text": "Create"},
    {"command": "wait", "text": "My New Board", "timeout": 3000},
    {"command": "snapshot"}
  ]
}
```

**Response:**

```json
{
  "steps": [
    {"index": 0, "command": "snapshot", "result": "header\n  h1 \"My Boards\"..."},
    {"index": 1, "command": "click", "result": "ok", "matched": "button \"Create Board\" [ref=e2]"},
    {"index": 2, "command": "wait", "result": "ok", "elapsed": 120},
    {"index": 3, "command": "type", "result": "ok", "matched": "input [ref=e6] via label \"Board name\""},
    {"index": 4, "command": "click", "result": "ok", "matched": "button \"Create\" [ref=e9]"},
    {"index": 5, "command": "wait", "result": "ok", "elapsed": 450},
    {"index": 6, "command": "snapshot", "result": "header\n  h1 \"My Boards\"...\n  article \"My New Board\"..."}
  ],
  "errors": [],
  "duration": 2105
}
```

Execution stops on failure (element not found, wait timeout) and returns the steps completed so far plus the error.

### 6. Visible Cursor

A Figma-style cursor rendered as an overlay on the page. High z-index, absolutely positioned, pointer-events: none.

**Cursor behavior:**

- **Movement:** Smooth CSS transition or `requestAnimationFrame` animation to the target element's center (~300-500ms, ease-out)
- **Click:** Cursor "presses down" (scale/translate animation), brief pause, then the real events dispatch
- **Type:** Cursor moves to input, click to focus, characters appear one at a time with natural timing (~50-80ms per char)
- **Idle:** Cursor rests at last position, subtle idle animation (gentle bob or glow)
- **Appearance:** Clean pointer SVG, maybe with a subtle label showing the agent's name or "AI Agent". Should be visually distinct from the user's real cursor.

The cursor makes the experience feel alive — the user watches the AI agent demonstrate the app it just built.

## Integration with the Tunnel

### Tunnel-side changes needed

The dev tunnel proxy (now `src/devTunnel/proxy/proxy.ts`, a sibling in this repo) needs:

1. **Serve the script:** `GET /__mindstudio_dev__/agent.js` → serve the compiled file
2. **Command queue:** Hold pending commands, serve via `GET /__mindstudio_dev__/commands`
3. **Result relay:** Receive `POST /__mindstudio_dev__/results`, emit as stdout JSON event to the AI agent
4. **Stdin command:** Accept `{"action": "browser", "steps": [...]}` on stdin, queue for the script

### Stdin/stdout protocol

**Agent sends:**
```json
{"action": "browser", "steps": [{"command": "snapshot"}]}
```

**Agent receives:**
```json
{"event": "browser-completed", "steps": [...], "errors": [], "duration": 150}
```

## Build

- TypeScript source
- Bundled to a single IIFE JS file (esbuild or rollup)
- No runtime dependencies in the output (everything bundled)
- `@testing-library/user-event` and `dom-accessibility-api` as build-time dependencies, bundled into the output
- Output file copied to or referenced by the tunnel at build time

## Milestones

### M1: Command channel + snapshot
- Project scaffolding (TypeScript, bundler)
- Command polling and result posting
- DOM snapshot (compact accessible tree with refs)
- Tunnel-side: serve script, command queue, result relay, stdin integration
- Move existing browser log capture from tunnel into this project

### M2: Click + type + wait
- Element resolution (text, role, label, ref, selector)
- Click with realistic event sequence
- Type with character-by-character dispatch
- Wait with polling and timeout
- Batched execution

### M3: Visible cursor
- Cursor element rendering
- Smooth movement animation
- Click and type visual effects
- Idle state

### M4: Polish
- Screenshot via html2canvas (optional)
- Select/dropdown support
- Scroll into view before interactions
- Better error messages when elements aren't found
- Configurable animation speed (fast for testing, slow for demos)
