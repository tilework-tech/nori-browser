# Noridoc: nori-browser

Path: @/

### Overview

- Electron desktop app that pairs a Chromium browser pane with a terminal sidebar, letting an AI agent (or human) control the browser via Playwright's CDP protocol
- The main process (`main.js`) orchestrates three subsystems: an Electron `WebContentsView` for web content, a `node-pty` terminal, and IPC handlers for the renderer toolbar
- `playwright-bridge.js` is a stateless CLI tool that agents invoke from the terminal to read and manipulate the browser page

### How it fits into the larger codebase

- This is the top-level application directory; `renderer/` contains the frontend UI and `test/` contains end-to-end Playwright tests
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

- **Application lifecycle**: `app.whenReady()` calls `createWindow()`, which triggers `startTerminal()` via IPC. `startTerminal()` creates a session directory, resolves the shell, and spawns the pty. The `WebContentsView` loads `about:blank` initially. URL navigation is driven either by the user typing into the toolbar URL bar or by an agent calling the bridge CLI
- **Session isolation**: `createSessionDir()` writes a `system-prompt.txt` into a temp directory (`os.tmpdir()/nori-browser-*`). This prompt tells Claude Code how to connect to the browser (CDP port, bridge path, available commands) and instructs it not to use MCP tools, create worktrees, or run `git init`. When Claude Code is detected, it is launched with `--setting-sources ''` (skips all file-based settings), `--settings '{"claudeMdExcludes":["**"]}'` (excludes all CLAUDE.md files), `--append-system-prompt-file` (injects the session prompt), and `--dangerously-skip-permissions` (no interactive permission prompts). This approach preserves OAuth/keychain authentication while isolating the session from user config — `--bare` is not used because it blocks all auth. The session directory is cleaned up in both `before-quit` and `window-all-closed` handlers
- **Browser-terminal integration flow**:
```
Agent types in terminal
  -> pty forwards to shell
  -> shell runs `node $NORI_BROWSER_DIR/playwright-bridge.js <cmd>`
  -> bridge connects via CDP to Electron's WebContentsView
  -> bridge performs action, prints status marker (e.g. NAVIGATE_OK), disconnects
  -> terminal shows output to agent
```
- **IPC channels** in `preload.js` expose a `window.api` surface: terminal I/O (`terminal-input`, `terminal-data`, `terminal-exit`), navigation (`navigate`, `go-back`, `go-forward`, `reload`), layout (`sidebar-resize`, `toggle-sidebar`, `sidebar-toggled`), and state sync (`url-changed`, `cdp-port`)
- **Sidebar toggle (Ctrl+J)**: The main process owns the toggle state (`sidebarVisible`, `savedSidebarWidth`). Pressing Ctrl+J triggers `handleToggleSidebar()`, which saves/restores the sidebar width, recalculates `WebContentsView` bounds, and notifies the renderer via `sidebar-toggled` IPC. The shortcut is intercepted at two levels: `before-input-event` on both `mainWindow.webContents` and `browserView.webContents` (catches the key when either has focus), plus a renderer-side `keydown` listener and xterm custom key handler (see `@/renderer/renderer.js`)
- **WebContentsView bounds** are computed from `sidebarWidth`, `TOOLBAR_HEIGHT`, and `sidebarVisible`. The `WebContentsView` is added as a child of `mainWindow.contentView` via `addChildView()`. Bounds are recalculated on all window state transitions: `resize`, `maximize`, `unmaximize`, `enter-full-screen`, and `leave-full-screen`. The sidebar is also resizable via a drag divider in the renderer; resize events propagate through `sidebar-resize` IPC to recalculate bounds. When the sidebar is hidden, the 4px divider width is excluded from the offset calculation so the browser pane fills the full window width
- **Bridge CLI** (`playwright-bridge.js`) supports commands: `status`, `navigate`, `snapshot`, `click`, `fill`, `eval`, `content`, `screenshot`. It also exports `connectToBrowser()` for programmatic use
- **Build step**: `renderer/renderer.js` is bundled via esbuild into `renderer/bundle.js` before the app starts or tests run

### Things to Know

- The bridge CLI finds the correct page by filtering out `file://` URLs (the renderer's `index.html`) and picking the first `http`-prefixed page. If no HTTP page exists, it falls back to `pages[0]`
- `playwright` is a runtime dependency (not dev-only) because the bridge CLI needs it when invoked from the terminal
- The CDP port defaults to `19222` but is configurable via `NORI_BROWSER_CDP_PORT`. Tests use `19223` to avoid collisions with a running instance
- URL bar navigation auto-prepends `https://` if the URL lacks a protocol scheme (see `ipcMain.on('navigate', ...)` in `main.js`)
- The `resolveShell()` function uses synchronous `execSync('which ...')` calls at startup -- if `claude` is missing, it falls back silently to the default shell. The function takes a `sessionDir` parameter so it can reference the session prompt file when constructing Claude Code args
- Each bridge CLI invocation opens and closes a full CDP connection. This is intentional -- statelessness means no zombie connections, but it adds latency per command
- Session directory cleanup happens in two places (`before-quit` and `window-all-closed`) to handle both graceful quit and window-close scenarios. The `cleanupSessionDir()` function is idempotent -- it nulls the reference after removal

Created and maintained by Nori.
