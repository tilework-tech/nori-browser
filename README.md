# Nori Browser

Agentic browser automation that actually works.

Nori Browser is an Electron-based web browser with an integrated AI terminal sidebar. It pairs a full-featured browser with the [nori CLI](https://www.npmjs.com/package/nori-ai-cli) driving a Claude Code agent that can script the browser in real time through Playwright over CDP. You browse the web normally; when you need the agent to do something, you tell it in the sidebar and it acts on the same browser session you're looking at.

## How It Works

```
┌─────────────────────────────────────────────────┐
│  Nori Browser (Electron)                        │
│ ┌──────────────┐  ┌───────────────────────────┐ │
│ │  AI Terminal  │  │      Web Content          │ │
│ │  (Sidebar)   │  │      (Chromium)           │ │
│ │              │  │                           │ │
│ │  nori +      │  │  ← controlled via CDP →   │ │
│ │  Claude Code │  │                           │ │
│ └──────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

1. **Electron app** renders a Chromium browser with tabs, omnibar, back/forward, find-in-page, zoom, downloads, and all standard browser chrome.
2. **Terminal sidebar** spawns the bundled `nori` CLI driving the `claude-code` agent (`nori -a claude-code -C <launch-folder> --dangerously-bypass-approvals-and-sandbox --skip-welcome --skip-trust-directory ...`). At startup the app asks you which folder to run in via a native directory picker, runs the terminal/agent there, and remembers it so the next launch defaults to the same folder. nori runs against an isolated config home (`~/.nori-browser`, with auto-worktree disabled) so it stays in the chosen folder and out of your personal `~/.nori` config. If no `nori` binary can be found it falls back to your system shell.
3. **CDP bridge** exposes the browser on a configurable port (default `19222`). The agent connects via Playwright's `connectOverCDP` and scripts the same pages you see.
4. **Browser instructions** are injected as nori's initial prompt at launch, with the CDP port, bridge commands, and network etiquette guidelines baked in. The agent knows how to drive the browser from the moment it starts.

The agent does not use MCP tools or structured tool calls. It scripts the browser directly with Playwright, the same way you'd write a test or automation script. This makes it transparent, composable, and debuggable.

## Getting Started

```bash
# Install dependencies
npm install

# Run the browser
npm start

# Run tests
npm test
```

### Requirements

- Node.js 18+
- A display server (or set `NORI_BROWSER_HEADLESS=1` for headless mode)
- The AI sidebar uses the [`nori-ai-cli`](https://www.npmjs.com/package/nori-ai-cli) package, installed automatically via `npm install`. It drives the `claude-code` agent, so a working Claude Code login/credential is needed for the agent to run.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NORI_BROWSER_CDP_PORT` | `19222` | Chrome DevTools Protocol port |
| `NORI_BROWSER_CONTROL_PORT` | `0` (disabled) | TCP port for external terminal control |
| `NORI_BROWSER_SHELL` | auto-detect | Override the sidebar command with a bare shell (e.g. `/bin/bash`), bypassing the nori launch |
| `NORI_BROWSER_NORI_BIN` | bundled `nori` | Override the path to the `nori` binary (test seam) |
| `NORI_BROWSER_HEADLESS` | unset | Set to `1` to hide the window (useful for testing) |
| `NORI_BROWSER_PROFILE_DIR` | Chrome's user data | Custom profile directory (empty string = no profile) |
| `NORI_BROWSER_LAUNCH_DIR` | startup picker | Folder to run the terminal/agent in, skipping the startup directory prompt |
| `NORI_BROWSER_STATE_FILE` | `~/.nori-browser/last-folder` | Where the last-chosen launch folder is remembered for the next startup |

## Example Uses

### Web scraping with human-in-the-loop

Browse to a page, log in with your real credentials, then tell the agent:

> "Extract all the product names and prices from this page into a JSON array"

The agent sees your authenticated session and scripts the DOM directly.

### Filling out forms

Navigate to a long form, then:

> "Fill out the shipping form with my address: 123 Main St, Springfield, IL 62701"

The agent uses `page.fill()` and `page.click()` on the live page.

### Debugging web apps

Open your local dev server, then:

> "Check the network tab for any failing API calls and tell me what's going wrong"

The agent can evaluate JavaScript, inspect the DOM, intercept network requests, and report back.

### Automated testing

> "Navigate to /signup, fill in test credentials, submit, and verify the welcome page appears"

The agent scripts a full user flow against your running app.

### Research and data collection

> "Open each of these 5 URLs in new tabs, extract the main article text from each, and summarize them"

The agent manages tabs, navigates, extracts content, and synthesizes results.

## The Playwright Bridge

A CLI tool (`playwright-bridge.js`) provides quick one-shot commands without writing full scripts:

```bash
# Get current page status
node playwright-bridge.js status

# Navigate to a URL
node playwright-bridge.js navigate https://example.com

# Get accessibility tree snapshot
node playwright-bridge.js snapshot

# Click an element
node playwright-bridge.js click "#submit-button"

# Fill an input
node playwright-bridge.js fill "#email" "user@example.com"

# Evaluate JavaScript
node playwright-bridge.js eval "document.title"

# Get page text content
node playwright-bridge.js content

# Take a screenshot
node playwright-bridge.js screenshot /tmp/page.png

# Tab management
node playwright-bridge.js list-tabs
node playwright-bridge.js new-tab https://example.com
node playwright-bridge.js switch-tab 2
node playwright-bridge.js close-tab 1
```

For more complex automation, the agent connects directly via Playwright:

```javascript
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://localhost:19222');
const page = browser.contexts()[0].pages()[0];

await page.goto('https://example.com');
await page.fill('#search', 'query');
await page.click('#submit');
await page.waitForSelector('.results');
const text = await page.textContent('.results');
```

## Browser Features

- Multi-tab browsing with keyboard shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab)
- Tab pinning, reordering, duplicate, close-others, reopen-closed
- Omnibar with Chrome history and bookmarks autocomplete
- Find in page (Ctrl+F)
- Zoom controls
- Download manager
- Context menus (open in new tab, copy link, inspect element, etc.)
- Chrome profile loading (uses your existing bookmarks/history when Chrome isn't running)
- Toggleable sidebar (Ctrl+J)
- Full-screen and HTML full-screen support

## Architecture

```
main.js              - Electron main process: window, tabs, IPC, terminal, CDP
preload.js           - Context bridge exposing IPC to renderer
renderer/            - UI: toolbar, tab bar, terminal (xterm.js), omnibar
playwright-bridge.js - CLI for one-shot browser commands over CDP
test/app.test.js     - End-to-end Playwright tests
```

## License

MIT
