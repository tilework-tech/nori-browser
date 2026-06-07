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

- **Tab system**: Each tab is a `WebContentsView` with its own `webContents` and process, managed via module-level `tabs` array, `activeTabId`, and `nextTabId` counter. Each tab object has `{ id, view, title, url, pinned, favicon, isLoading }` where `pinned` defaults to `false`, `favicon` defaults to `''`, and `isLoading` defaults to `false`. `createTab()` creates a view, adds it to `mainWindow.contentView`, wires navigation/title/favicon/loading events, and switches to it. `createTab()` accepts an optional `insertIndex` parameter for position-controlled insertion (used by reopen and duplicate). Tab switching uses `view.setVisible(true/false)` rather than add/remove to avoid flicker. Closing the last tab closes the window
- **Closed tab stack**: A module-level `closedTabStack` (LIFO, capped at `MAX_CLOSED_TABS` = 25) stores `{ url, title, index }` for each closed tab. `reopenClosedTab()` pops the most recent entry and calls `createTab()` at the saved position. The stack is session-scoped only -- cleared on app exit, not persisted
- **Tab pinning**: `pinTab(tabId)` sets `pinned = true` and splices the tab to the end of the pinned zone (just before the first unpinned tab). `unpinTab(tabId)` sets `pinned = false` and moves the tab to the first unpinned position. This maintains the ordering invariant: all pinned tabs always precede all unpinned tabs in the `tabs` array. Pinned tabs are preserved by `closeOtherTabs()` and `closeTabsToRight()` (which filter them out before closing), but can still be closed individually via `closeTab()` (Ctrl+W, middle-click). Pinned state is included in `sendTabsChanged()` and `get-tabs` serialization so the renderer can style them
- **Tab batch operations**: `duplicateTab(tabId)` creates a new tab with the same URL inserted after the source tab (duplicates of pinned tabs are unpinned since `createTab()` defaults `pinned: false`). `closeOtherTabs(tabId)` and `closeTabsToRight(tabId)` close multiple tabs in a single operation, skipping pinned tabs. These are exposed as IPC channels and also available from the right-click tab context menu
- **Tab context menu**: When the renderer sends a `tab-context-menu` IPC with a `tabId`, the main process builds a native `Menu` via `Menu.buildFromTemplate()` and shows it with `menu.popup()`. The menu offers: New Tab, Reload, Duplicate, Pin Tab / Unpin Tab (label toggles based on current pin state), Close Tab, Close Other Tabs, Close Tabs to the Right
- **Application lifecycle**: `app.whenReady()` calls `createWindow()`, which triggers `startTerminal()` via IPC. The first tab (loading `about:blank`) is created in the `did-finish-load` handler. URL navigation is driven either by the toolbar URL bar (through `resolveInput()` for omnibox-style URL-vs-search classification) or by an agent calling the bridge CLI
- **Layout**: Two height constants control the browser area -- `TOOLBAR_HEIGHT` (48px) for the URL bar and `TAB_BAR_HEIGHT` (36px) for the tab strip. `setTabBounds()` positions each `WebContentsView` below both bars and to the right of the sidebar. `updateAllTabBounds()` is called on window resize, maximize, and sidebar resize events
- **Keyboard shortcuts**: An Electron `Menu` with accelerators provides tab management: `Ctrl+T` (new tab), `Ctrl+W` (close tab), `Ctrl+Shift+T` (reopen closed tab), `Ctrl+Tab`/`Ctrl+Shift+Tab` (cycle tabs), `Ctrl+1-8` (jump to tab by position), `Ctrl+9` (last tab), `Ctrl+Shift+PageDown/PageUp` (reorder tabs)
- **Session isolation**: `createSessionDir()` writes a `system-prompt.txt` into a temp directory (`os.tmpdir()/nori-browser-*`). This prompt tells Claude Code how to connect to the browser (CDP port, bridge path, available commands), documents the `window.api` tab operations available via the renderer (e.g., `duplicateTab`, `closeOtherTabs`, `reopenClosedTab`), instructs it not to use MCP tools, create worktrees, or run `git init`, and includes network etiquette rules (random inter-request delays, exponential backoff with jitter, 429/Retry-After honoring, concurrency limits, robots.txt checks) that apply only to external services (not localhost/private networks). When Claude Code is detected, it is launched with `--setting-sources ''` (skips all file-based settings), `--settings '{"claudeMdExcludes":["**"]}'` (excludes all CLAUDE.md files), `--append-system-prompt-file` (injects the session prompt), and `--dangerously-skip-permissions` (no interactive permission prompts). This approach preserves OAuth/keychain authentication while isolating the session from user config — `--bare` is not used because it blocks all auth. The session directory is cleaned up in both `before-quit` and `window-all-closed` handlers
- **Browser-terminal integration flow**:
```
Agent types in terminal
  -> pty forwards to shell
  -> shell runs `node $NORI_BROWSER_DIR/playwright-bridge.js <cmd>`
  -> bridge connects via CDP to Electron's WebContentsView tabs
  -> bridge performs action, prints status marker (e.g. NAVIGATE_OK), disconnects
  -> terminal shows output to agent
```
- **Tab favicon & loading indicators**: Each tab's `webContents` listens for `page-favicon-updated` (stores the first favicon URL), `did-start-loading` / `did-stop-loading` (toggles `isLoading`), and `did-start-navigation` (clears `favicon` on main-frame cross-document navigations to avoid showing stale favicons). These fields are included in `sendTabsChanged()` and `get-tabs` serialization so the renderer can display favicons and loading spinners
- **IPC channels** in `preload.js` expose a `window.api` surface: terminal I/O (`terminal-input`, `terminal-data`, `terminal-exit`), navigation (`navigate`, `go-back`, `go-forward`, `reload`), layout (`sidebar-resize`, `toggle-sidebar`, `sidebar-toggled`), state sync (`url-changed`, `cdp-port`), and tab management (`create-tab`, `close-tab`, `switch-tab`, `reorder-tab`, `get-tabs`, `tabs-changed`, `reopen-closed-tab`, `duplicate-tab`, `close-other-tabs`, `close-tabs-to-right`, `tab-context-menu`, `pin-tab`, `unpin-tab`)
- **Sidebar toggle (Ctrl+J)**: The main process owns the toggle state (`sidebarVisible`, `savedSidebarWidth`). Pressing Ctrl+J triggers `handleToggleSidebar()`, which saves/restores the sidebar width, recalculates all tab view bounds, and notifies the renderer via `sidebar-toggled` IPC. The shortcut is intercepted at multiple levels: `before-input-event` on `mainWindow.webContents` and each tab's `webContents`, plus a renderer-side `keydown` listener and xterm custom key handler (see `@/renderer/renderer.js`)
- **Bridge CLI** (`playwright-bridge.js`) supports single-page commands (`status`, `navigate`, `snapshot`, `click`, `fill`, `eval`, `content`, `screenshot`) and tab management commands (`list-tabs`, `new-tab`, `close-tab`, `switch-tab`). It also exports `connectToBrowser()` for programmatic use
- **Build step**: `renderer/renderer.js` is bundled via esbuild into `renderer/bundle.js` before the app starts or tests run
- **`window.open()` interception**: Each tab's `webContents` has a `setWindowOpenHandler` that intercepts `window.open()` calls and opens them as new tabs instead of new windows

### Things to Know

- The bridge CLI finds the correct page by filtering out `file://` URLs (the renderer's `index.html`) and picking the first `http`-prefixed page. If no HTTP page exists, it falls back to `pages[0]`
- `playwright` is a runtime dependency (not dev-only) because the bridge CLI needs it when invoked from the terminal
- The CDP port defaults to `19222` but is configurable via `NORI_BROWSER_CDP_PORT`. Tests use offset ports (`19223`, `19233`) to avoid collisions
- URL bar input goes through `resolveInput()` in `main.js`, which classifies text as either a URL or a search query. URLs (detected by explicit scheme, dots, IP addresses, `localhost`, or port patterns) get navigated directly with an appropriate protocol prefix. Everything else becomes a Google search via `https://www.google.com/search?q=<encoded_query>`. The classification uses a priority-ordered heuristic chain -- whitespace triggers search early, dots trigger URL treatment, and single words without dots fall through to search. Google is hardcoded as the search engine
- The `resolveShell()` function uses synchronous `execSync('which ...')` calls at startup -- if `claude` is missing, it falls back silently to the default shell. The function takes a `sessionDir` parameter so it can reference the session prompt file when constructing Claude Code args
- On Linux, the `maximize` and `unmaximize` window events fire before the window manager has updated `mainWindow.getContentSize()`. A single bounds update call reads stale dimensions. The workaround is a deferred second call via `setTimeout(fn, 100)` that runs after the WM has settled. The `resize` event (manual drag) does not need this because the WM updates dimensions synchronously for drag operations
- Each bridge CLI invocation opens and closes a full CDP connection. This is intentional -- statelessness means no zombie connections, but it adds latency per command
- Session directory cleanup happens in both `before-quit` and `window-all-closed` handlers. The `cleanupSessionDir()` function is idempotent -- it nulls the reference after removal
- Tab IDs are stringified integers from a monotonically increasing counter (`nextTabId`). They are not reused, so a tab with ID "3" may exist while tabs "1" and "2" are already closed
- `reorderTab()` clamps target indices to respect the pinned/unpinned boundary: pinned tabs can only move within indices `[0, pinnedCount-1]`, unpinned tabs within `[pinnedCount, tabs.length-1]`. `moveTabLeft()`/`moveTabRight()` enforce the same boundary by refusing to move a tab across the pin zone edge
- Navigation events (`did-navigate`, `did-navigate-in-page`) and title events (`page-title-updated`) on each tab's `webContents` keep the tab metadata, URL bar, and window title in sync only for the active tab

Created and maintained by Nori.
