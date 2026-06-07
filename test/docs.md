# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, window state transitions (resize, maximize), session directory lifecycle, the agent bridge CLI workflow, multi-tab operations, and Chrome-like browser features (context menu, DevTools, find-in-page, zoom, downloads, print, fullscreen, status bar, permissions)

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, and offset CDP/control ports to avoid collisions with a running dev instance
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`, `list-tabs`) that an agent would use in production
- Tests also verify keyboard shortcuts (Ctrl+J sidebar toggle) by simulating keypresses and asserting DOM visibility changes

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving test HTML pages. Eliminates external network dependencies. The Chrome Features suite extends the server with pages for links, images, searchable content, downloads, beforeunload, fullscreen, and hover-link testing
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for the renderer window and control socket to be ready
- **Terminal interaction**: Tests use a TCP control socket (`connectControl()` / `sendAndWait()`) to send commands and wait for marker strings in terminal output. This is more reliable than UI-based xterm interaction
- **Test suites**: The tests are split into `test.describe` blocks, each with its own Electron app instance and port offsets to avoid collisions:
  - `Nori Browser` -- core functionality: window elements, terminal I/O, URL navigation, CDP connectivity, env vars, bridge CLI commands, session directory lifecycle
  - `Nori Browser Tabs` -- tab management: tab bar rendering, creating/closing/switching tabs, navigation isolation, keyboard accelerators, tab reordering, bridge CLI `list-tabs`, reopen closed tab, middle-click close, duplicate tab, close other/right tabs, and closing the last tab to close the window
  - `Nori Browser Tab Pinning` -- pin/unpin rendering, ordering invariant, boundary-clamped reordering, interaction with close-other/close-right, duplicate-of-pinned, getTabs API pin state
  - `Nori Browser Tab Favicons & Loading` -- favicon display from test server pages, favicon updates on navigation, loading spinner visibility during page loads, getTabs API returning favicon fields, and pinned tab favicon display
  - `Nori Browser Search` -- omnibox URL-vs-search classification: single-word and multi-word Google searches, explicit URL passthrough, bare IP navigation, special character encoding in searches, and localhost detection
  - `Nori Browser Chrome Features` -- context menu (open link in new tab), DevTools toggle via View menu, find bar show/hide/search/next, zoom in/out/reset, download shelf visibility, print menu item existence, fullscreen toggle, status bar on link hover, and permission denial (geolocation)
- **Bridge CLI tests**: Verify the real agent workflow -- send bridge commands via the control socket or `execSync`, wait for status markers (e.g., `NAVIGATE_OK`, `LIST_TABS_OK`), and cross-check browser state
- **Session directory tests**: Verify `NORI_SESSION_DIR` env var is set, `system-prompt.txt` exists with correct CDP port and bridge path, system prompt contains network etiquette instructions (random delays, exponential backoff, robots.txt), and that the session directory is removed when the app closes

### Things to Know

- Within each `test.describe` block, tests share one Electron app instance and test order matters -- later tests depend on browser/tab state from earlier tests
- Each test suite uses its own port offsets (e.g., `CDP_PORT + 10`, `CDP_PORT + 20`, `CDP_PORT + 50`) separate from the core suite to allow independent operation
- The session cleanup test and the "closing the last tab closes the window" test both close the Electron app and must run last within their respective suites. The `afterAll` handlers guard against a null `electronApp`
- Tab tests use `window.evaluate()` to click tab elements rather than direct Playwright selectors to avoid stale element handles after tab list re-renders
- Menu accelerator tests (Ctrl+T, Ctrl+W, Ctrl+Shift+T) use `electronApp.evaluate(({ Menu }) => ...)` to invoke menu items from the main process rather than simulating keyboard shortcuts, because Electron menu accelerators are not reliably triggered by Playwright keypresses in CI
- The Chrome Features tests use CDP connections (`chromium.connectOverCDP`) to interact with web content for tests that need to trigger browser-internal events (e.g., hovering a link to trigger `update-target-url`, clicking a download link)

Created and maintained by Nori.
