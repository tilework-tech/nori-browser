# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, window state transitions (resize, maximize), the nori CLI launch contract, the agent bridge CLI workflow, multi-tab operations, Chrome-like browser features (context menu, DevTools, find-in-page, zoom, downloads, print, fullscreen, status bar, permissions), Chrome profile loading, and omnibar autocomplete

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, `NORI_BROWSER_HEADLESS=1` to prevent visible Electron windows from appearing, and offset CDP/control ports to avoid collisions with a running dev instance
- The launch-folder suites use two additional seams: `NORI_BROWSER_LAUNCH_DIR` injects the chosen folder so the startup directory picker (a native dialog Playwright cannot drive) is skipped, and `NORI_BROWSER_STATE_FILE` redirects the remembered-folder persistence to a temp file for isolation from `~/.nori-browser/last-folder`
- All test suites set `NORI_BROWSER_PROFILE_DIR: ''` (empty string) to disable Chrome profile auto-detection and ensure isolation from the host system's Chrome data, except the profile and omnibar test suites which use temp directories with synthetic data
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`, `list-tabs`) that an agent would use in production
- Tests also verify keyboard shortcuts (Ctrl+J sidebar toggle) by simulating keypresses and asserting DOM visibility changes

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving test HTML pages. Eliminates external network dependencies. The Chrome Features suite extends the server with pages for links, images, searchable content, downloads, beforeunload, fullscreen, and hover-link testing
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for the renderer window and control socket to be ready
- **Terminal interaction**: Tests use a TCP control socket (`connectControl()` / `sendAndWait()`) to send commands and wait for marker strings in terminal output. This is more reliable than UI-based xterm interaction
- **Test suites**: The tests are split into `test.describe` blocks, each with its own Electron app instance and port offsets to avoid collisions:
  - `Nori Browser` -- core functionality: window elements, terminal I/O, URL navigation, CDP connectivity, env vars, bridge CLI commands
  - `Nori Browser Tabs` -- tab management: tab bar rendering, creating/closing/switching tabs, navigation isolation, keyboard accelerators, tab reordering, bridge CLI `list-tabs`, reopen closed tab, middle-click close, duplicate tab, close other/right tabs, tab pinning, and closing the last tab to close the window
  - `Nori Browser Tab Favicons & Loading` -- favicon display, loading spinners, getTabs API favicon fields, pinned tab favicons
  - `Nori Browser Search` -- omnibox URL-vs-search classification
  - `Nori Browser Chrome Features` -- Chrome-like browser features: context menu, DevTools, find-in-page, zoom, downloads, print, fullscreen, status bar, permissions
  - `Nori Browser Chrome Profile` -- verifies that `NORI_BROWSER_PROFILE_DIR` causes the app to store data in the specified directory
  - `Nori Browser Omnibar` -- creates a temp profile dir with a synthetic History SQLite database and Bookmarks JSON file, then tests: suggestions from history, bookmark star indicators, click-to-navigate, keyboard selection (ArrowDown + Enter), Escape to close, ranking by visit frequency, and prefix matching that strips common subdomain prefixes (e.g., `www.`) before comparing
  - `Nori Browser Omnibar No Data` -- verifies the omnibar gracefully handles an empty profile (no History or Bookmarks files) without crashing
  - `Nori CLI spawn contract` -- hermetic test that points `NORI_BROWSER_NORI_BIN` at a stub nori (a bash script that records its argv and env, then `exec`s `cat`). Asserts the launch command/flags (`-a claude-code`, `-C <cwd>`, the `--dangerously-bypass-approvals-and-sandbox`/`--skip-welcome`/`--skip-trust-directory` flags), that the cwd is the launch folder, that the browser instructions reach argv as the initial-prompt positional, and that `NORI_HOME` points at an isolated home (not `~/.nori/cli`) whose `config.toml` disables `auto_worktree`
  - `Nori terminal launch folder` -- injects a chosen folder via `NORI_BROWSER_LAUNCH_DIR` and uses the stub nori to assert the terminal process actually runs in that folder (recorded `CWD`) and that nori is told to operate there via `-C <chosen-folder>`, rather than wherever the browser process started
  - `Nori terminal remembers the launch folder` -- runs with `NORI_BROWSER_LAUNCH_DIR` plus `NORI_BROWSER_STATE_FILE` pointing at a temp path, then asserts the chosen folder is persisted to that state file so the next startup's directory picker can default to it
  - `Nori CLI live e2e` -- drives real nori -> claude-code end to end: loads a page with a known title, sends a prompt over the control socket asking the agent to run the bridge to set `document.title`, and polls until the title changes. Has an extended timeout because it boots a real agent
- **Bridge CLI tests**: Verify the real agent workflow -- send bridge commands via the control socket or `execSync`, wait for status markers (e.g., `NAVIGATE_OK`, `LIST_TABS_OK`), and cross-check browser state

### Things to Know

- Within each `test.describe` block, tests share one Electron app instance and test order matters -- later tests depend on browser/tab state from earlier tests
- Each suite uses its own CDP/control port offset (e.g. `CDP_PORT + 0`, `+ 10`, ... with the nori spawn-contract and live-e2e suites at `+ 90` and `+ 100`) so all suites can run independently without port collisions
- The "closing the last tab closes the window" test closes the Electron app and must run last within its suite. The `afterAll` handlers guard against a null `electronApp`
- **Bracketed-paste Enter caveat**: nori's TUI has bracketed-paste enabled, so when sending a prompt over the control socket the Enter (`\r`) must be a SEPARATE write from the message text. A trailing `\r` in the same write is swallowed as pasted content instead of submitting the turn (see the `Nori CLI live e2e` test)
- The spawn-contract test avoids booting a real agent by stubbing nori via `NORI_BROWSER_NORI_BIN`; the stub records argv/env to a file and the test polls for that file, so it asserts the launch contract without depending on a working claude-code backend
- Tab tests use `window.evaluate()` to click tab elements rather than direct Playwright selectors to avoid stale element handles after tab list re-renders
- The maximize test must temporarily call `win.show()` before `win.maximize()` because `maximize()` is a window-manager operation that requires the window to be mapped. The test re-hides the window in a `finally` block
- Menu accelerator tests (Ctrl+T, Ctrl+W, Ctrl+Shift+T) use `electronApp.evaluate(({ Menu }) => ...)` to invoke menu items from the main process rather than simulating keyboard shortcuts, because Electron menu accelerators are not reliably triggered by Playwright keypresses in CI
- The Chrome Features tests use CDP connections (`chromium.connectOverCDP`) to interact with web content for tests that need to trigger browser-internal events (e.g., hovering a link to trigger `update-target-url`, clicking a download link)
- The Omnibar test suite uses `sqlite3` CLI (via `execSync`) to create a synthetic Chrome History database with known test data. This avoids a dependency on `better-sqlite3` in the test setup itself

Created and maintained by Nori.
