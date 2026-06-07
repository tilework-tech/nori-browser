# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, window state transitions (resize, maximize), session directory lifecycle, the agent bridge CLI workflow, multi-tab operations, Chrome-like browser features (context menu, DevTools, find-in-page, zoom, downloads, print, fullscreen, status bar, permissions), Chrome profile loading, and omnibar autocomplete

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, `NORI_BROWSER_HEADLESS=1` to prevent visible Electron windows from appearing, and offset CDP/control ports to avoid collisions with a running dev instance
- All test suites set `NORI_BROWSER_PROFILE_DIR: ''` (empty string) to disable Chrome profile auto-detection and ensure isolation from the host system's Chrome data, except the profile and omnibar test suites which use temp directories with synthetic data
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`, `list-tabs`) that an agent would use in production
- Tests also verify keyboard shortcuts (Ctrl+J sidebar toggle) by simulating keypresses and asserting DOM visibility changes

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving test HTML pages. Eliminates external network dependencies. The Chrome Features suite extends the server with pages for links, images, searchable content, downloads, beforeunload, fullscreen, and hover-link testing
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for the renderer window and control socket to be ready
- **Terminal interaction**: Tests use a TCP control socket (`connectControl()` / `sendAndWait()`) to send commands and wait for marker strings in terminal output. This is more reliable than UI-based xterm interaction
- **Test suites**: The tests are split into `test.describe` blocks, each with its own Electron app instance and port offsets to avoid collisions:
  - `Nori Browser` -- core functionality: window elements, terminal I/O, URL navigation, CDP connectivity, env vars, bridge CLI commands, session directory lifecycle
  - `Nori Browser Tabs` -- tab management: tab bar rendering, creating/closing/switching tabs, navigation isolation, keyboard accelerators, tab reordering, bridge CLI `list-tabs`, reopen closed tab, middle-click close, duplicate tab, close other/right tabs, tab pinning, and closing the last tab to close the window
  - `Nori Browser Tab Favicons & Loading` -- favicon display, loading spinners, getTabs API favicon fields, pinned tab favicons
  - `Nori Browser Search` -- omnibox URL-vs-search classification
  - `Nori Browser Chrome Features` -- Chrome-like browser features: context menu, DevTools, find-in-page, zoom, downloads, print, fullscreen, status bar, permissions
  - `Nori Browser Chrome Profile` -- verifies that `NORI_BROWSER_PROFILE_DIR` causes the app to store data in the specified directory
  - `Nori Browser Omnibar` -- creates a temp profile dir with a synthetic History SQLite database and Bookmarks JSON file, then tests: suggestions from history, bookmark star indicators, click-to-navigate, keyboard selection (ArrowDown + Enter), Escape to close, and ranking by visit frequency
  - `Nori Browser Omnibar No Data` -- verifies the omnibar gracefully handles an empty profile (no History or Bookmarks files) without crashing
- **Bridge CLI tests**: Verify the real agent workflow -- send bridge commands via the control socket or `execSync`, wait for status markers (e.g., `NAVIGATE_OK`, `LIST_TABS_OK`), and cross-check browser state
- **Session directory tests**: Verify `NORI_SESSION_DIR` env var is set, `system-prompt.txt` exists with correct CDP port and bridge path, system prompt contains network etiquette instructions (random delays, exponential backoff, robots.txt), and that the session directory is removed when the app closes

### Things to Know

- Within each `test.describe` block, tests share one Electron app instance and test order matters -- later tests depend on browser/tab state from earlier tests
- Each suite uses its own port offsets (`CDP_PORT + 0`, `+ 10`, `+ 20`, `+ 30`, `+ 40`, `+ 50`, `+ 60`, `+ 70`, `+ 80`) so all suites can run independently without port collisions
- The session cleanup test and the "closing the last tab closes the window" test both close the Electron app and must run last within their respective suites. The `afterAll` handlers guard against a null `electronApp`
- Tab tests use `window.evaluate()` to click tab elements rather than direct Playwright selectors to avoid stale element handles after tab list re-renders
- The maximize test must temporarily call `win.show()` before `win.maximize()` because `maximize()` is a window-manager operation that requires the window to be mapped. The test re-hides the window in a `finally` block
- Menu accelerator tests (Ctrl+T, Ctrl+W, Ctrl+Shift+T) use `electronApp.evaluate(({ Menu }) => ...)` to invoke menu items from the main process rather than simulating keyboard shortcuts, because Electron menu accelerators are not reliably triggered by Playwright keypresses in CI
- The Chrome Features tests use CDP connections (`chromium.connectOverCDP`) to interact with web content for tests that need to trigger browser-internal events (e.g., hovering a link to trigger `update-target-url`, clicking a download link)
- The Omnibar test suite uses `sqlite3` CLI (via `execSync`) to create a synthetic Chrome History database with known test data. This avoids a dependency on `better-sqlite3` in the test setup itself

Created and maintained by Nori.
