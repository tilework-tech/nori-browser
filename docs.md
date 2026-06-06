# Noridoc: nori-browser

Path: @/

### Overview

- Electron desktop app that pairs a tabbed Chromium browser with a terminal sidebar, letting an AI agent (or human) control the browser via Playwright's CDP protocol
- The main process (`main.js`) orchestrates a multi-tab `WebContentsView` system, a `node-pty` terminal, an Electron `Menu` with keyboard accelerators, and IPC handlers for the renderer toolbar and tab bar
- `playwright-bridge.js` is a stateless CLI tool that agents invoke from the terminal to read and manipulate browser pages and tabs

### How it fits into the larger codebase

- This is the top-level application directory; `@/renderer` contains the frontend UI and `@/test` contains end-to-end Playwright tests
- The terminal spawns whatever shell `NORI_BROWSER_SHELL` specifies, falling back to Claude Code CLI (launched with isolated settings and a session-specific system prompt), then the user's default shell (see `resolveShell()` in `main.js`)
- The terminal environment is seeded with env vars that form the agent-to-browser contract:

| Env Var | Purpose |
|---|---|
| `NORI_BROWSER_CDP_PORT` | Port Electron exposes for Chrome DevTools Protocol |
| `PLAYWRIGHT_CDP_URL` | Full CDP URL (`http://localhost:<port>`) |
| `NODE_PATH` | Points to project `node_modules` so `require('playwright')` resolves from any cwd |
| `NORI_BROWSER_DIR` | Project root, so agent can locate `playwright-bridge.js` |
| `NORI_SESSION_DIR` | Temp directory containing `system-prompt.txt` with browser connection instructions |

- The renderer communicates with the main process exclusively through IPC channels defined in `preload.js` -- no direct Node access from the renderer
- `playwright-bridge.js` connects over CDP, acts, and disconnects on every invocation -- it holds no persistent state or connections

### Core Implementation

- **Tab system**: Each tab is a `WebContentsView` with its own `webContents` and process, managed via module-level `tabs` array, `activeTabId`, and `nextTabId` counter. `createTab()` creates a view, adds it to `mainWindow.contentView`, wires navigation/title events, and switches to it. Tab switching uses `view.setVisible(true/false)` rather than add/remove to avoid flicker. Closing the last tab closes the window
- **Application lifecycle**: `app.whenReady()` calls `createWindow()`, which triggers `startTerminal()` via IPC. The first tab (loading `about:blank`) is created in the `did-finish-load` handler. URL navigation is driven either by the toolbar URL bar or by an agent calling the bridge CLI
- **Layout**: Two height constants control the browser area -- `TOOLBAR_HEIGHT` (48px) for the URL bar and `TAB_BAR_HEIGHT` (36px) for the tab strip. `setTabBounds()` positions each `WebContentsView` below both bars and to the right of the sidebar. `updateAllTabBounds()` is called on window resize, maximize, and sidebar resize events
- **Keyboard shortcuts**: An Electron `Menu` with accelerators provides tab management: `Ctrl+T` (new tab), `Ctrl+W` (close tab), `Ctrl+Tab`/`Ctrl+Shift+Tab` (cycle tabs), `Ctrl+1-8` (jump to tab by position), `Ctrl+9` (last tab), `Ctrl+Shift+PageDown/PageUp` (reorder tabs)
- **Session isolation**: `createSessionDir()` writes a `system-prompt.txt` into a temp directory. When Claude Code is detected, it is launched with `--setting-sources ''`, `--settings '{"claudeMdExcludes":["**"]}'`, `--append-system-prompt-file`, and `--dangerously-skip-permissions`. This preserves OAuth/keychain auth while isolating the session from user config
- **Browser-terminal integration flow**:
```
Agent types in terminal
  -> pty forwards to shell
  -> shell runs `node $NORI_BROWSER_DIR/playwright-bridge.js <cmd>`
  -> bridge connects via CDP to Electron's WebContentsView tabs
  -> bridge performs action, prints status marker (e.g. NAVIGATE_OK), disconnects
  -> terminal shows output to agent
```
- **IPC channels** in `preload.js` expose a `window.api` surface: terminal I/O, navigation, layout, state sync (`url-changed`, `cdp-port`), and tab management (`create-tab`, `close-tab`, `switch-tab`, `reorder-tab`, `get-tabs`, `tabs-changed`)
- **Bridge CLI** (`playwright-bridge.js`) supports single-page commands (`status`, `navigate`, `snapshot`, `click`, `fill`, `eval`, `content`, `screenshot`) and tab management commands (`list-tabs`, `new-tab`, `close-tab`, `switch-tab`). It also exports `connectToBrowser()` for programmatic use
- **Build step**: `renderer/renderer.js` is bundled via esbuild into `renderer/bundle.js` before the app starts or tests run
- **`window.open()` interception**: Each tab's `webContents` has a `setWindowOpenHandler` that intercepts `window.open()` calls and opens them as new tabs instead of new windows

### Things to Know

- The bridge CLI finds the correct page by filtering out `file://` URLs (the renderer's `index.html`) and picking the first `http`-prefixed page. If no HTTP page exists, it falls back to `pages[0]`
- `playwright` is a runtime dependency (not dev-only) because the bridge CLI needs it when invoked from the terminal
- The CDP port defaults to `19222` but is configurable via `NORI_BROWSER_CDP_PORT`. Tests use offset ports (`19223`, `19233`) to avoid collisions
- URL bar navigation auto-prepends `https://` if the URL lacks a protocol scheme (see `ipcMain.on('navigate', ...)` in `main.js`)
- Each bridge CLI invocation opens and closes a full CDP connection. This is intentional -- statelessness means no zombie connections, but it adds latency per command
- Session directory cleanup happens in both `before-quit` and `window-all-closed` handlers. The `cleanupSessionDir()` function is idempotent -- it nulls the reference after removal
- Tab IDs are stringified integers from a monotonically increasing counter (`nextTabId`). They are not reused, so a tab with ID "3" may exist while tabs "1" and "2" are already closed
- Navigation events (`did-navigate`, `did-navigate-in-page`) and title events (`page-title-updated`) on each tab's `webContents` keep the tab metadata, URL bar, and window title in sync only for the active tab

Created and maintained by Nori.
