# Noridoc: nori-browser

Path: @/

### Overview

- Electron desktop app that pairs a Chromium browser pane with a terminal sidebar, letting an AI agent (or human) control the browser via Playwright's CDP protocol
- The main process (`main.js`) orchestrates three subsystems: an Electron `BrowserView` for web content, a `node-pty` terminal, and IPC handlers for the renderer toolbar
- `playwright-bridge.js` is a stateless CLI tool that agents invoke from the terminal to read and manipulate the browser page

### How it fits into the larger codebase

- This is the top-level application directory; `renderer/` contains the frontend UI and `test/` contains end-to-end Playwright tests
- The terminal spawns whatever shell `NORI_BROWSER_SHELL` specifies, falling back to `nori` CLI, then `claude` CLI, then the user's default shell (see `resolveShell()` in `main.js`)
- The terminal environment is seeded with four env vars that form the agent-to-browser contract:

| Env Var | Purpose |
|---|---|
| `NORI_BROWSER_CDP_PORT` | Port Electron exposes for Chrome DevTools Protocol |
| `PLAYWRIGHT_CDP_URL` | Full CDP URL (`http://localhost:<port>`) |
| `NODE_PATH` | Points to project `node_modules` so `require('playwright')` resolves from any cwd |
| `NORI_BROWSER_DIR` | Project root, so agent can locate `playwright-bridge.js` |

- The renderer communicates with the main process exclusively through IPC channels defined in `preload.js` -- no direct Node access from the renderer
- `playwright-bridge.js` connects over CDP, acts, and disconnects on every invocation -- it holds no persistent state or connections

### Core Implementation

- **Application lifecycle**: `app.whenReady()` calls `createWindow()` then `startTerminal()`. The `BrowserView` loads `about:blank` initially. URL navigation is driven either by the user typing into the toolbar URL bar or by an agent calling the bridge CLI
- **Browser-terminal integration flow**:
```
Agent types in terminal
  -> pty forwards to shell
  -> shell runs `node $NORI_BROWSER_DIR/playwright-bridge.js <cmd>`
  -> bridge connects via CDP to Electron's BrowserView
  -> bridge performs action, prints status marker (e.g. NAVIGATE_OK), disconnects
  -> terminal shows output to agent
```
- **IPC channels** in `preload.js` expose a `window.api` surface: terminal I/O (`terminal-input`, `terminal-data`, `terminal-exit`), navigation (`navigate`, `go-back`, `go-forward`, `reload`), layout (`sidebar-resize`), and state sync (`url-changed`, `cdp-port`)
- **BrowserView bounds** are computed from `sidebarWidth` and `TOOLBAR_HEIGHT` constants. The sidebar is resizable via a drag divider in the renderer; resize events propagate through `sidebar-resize` IPC to recalculate bounds
- **Bridge CLI** (`playwright-bridge.js`) supports commands: `status`, `navigate`, `snapshot`, `click`, `fill`, `eval`, `content`, `screenshot`. It also exports `connectToBrowser()` for programmatic use
- **Build step**: `renderer/renderer.js` is bundled via esbuild into `renderer/bundle.js` before the app starts or tests run

### Things to Know

- The bridge CLI finds the correct page by filtering out `file://` URLs (the renderer's `index.html`) and picking the first `http`-prefixed page. If no HTTP page exists, it falls back to `pages[0]`
- `playwright` is a runtime dependency (not dev-only) because the bridge CLI needs it when invoked from the terminal
- The CDP port defaults to `19222` but is configurable via `NORI_BROWSER_CDP_PORT`. Tests use `19223` to avoid collisions with a running instance
- URL bar navigation auto-prepends `https://` if the URL lacks a protocol scheme (see `ipcMain.on('navigate', ...)` in `main.js`)
- The `resolveShell()` function uses synchronous `execSync('which ...')` calls at startup -- if both `nori` and `claude` are missing, it falls back silently to the default shell
- Each bridge CLI invocation opens and closes a full CDP connection. This is intentional -- statelessness means no zombie connections, but it adds latency per command

Created and maintained by Nori.
