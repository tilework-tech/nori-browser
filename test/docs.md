# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, session directory lifecycle, the agent bridge CLI workflow, and multi-tab operations

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, and offset CDP/control ports to avoid collisions with a running dev instance
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`, `list-tabs`) that an agent would use in production

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving test HTML pages. Eliminates external network dependencies
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for the renderer window and control socket to be ready
- **Terminal interaction**: Tests use a TCP control socket (`connectControl()` / `sendAndWait()`) to send commands and wait for marker strings in terminal output. This is more reliable than UI-based xterm interaction
- **Two test suites**: The tests are split into two `test.describe` blocks, each with its own Electron app instance:
  - `Nori Browser` -- core functionality: window elements, terminal I/O, URL navigation, CDP connectivity, env vars, bridge CLI commands, session directory lifecycle
  - `Nori Browser Tabs` -- tab management: tab bar rendering, creating/closing/switching tabs, navigation isolation between tabs, keyboard accelerators (Ctrl+T, Ctrl+W, next-tab), tab reordering via IPC, bridge CLI `list-tabs`, and closing the last tab to close the window
- **Bridge CLI tests**: Verify the real agent workflow -- send bridge commands via the control socket or `execSync`, wait for status markers (e.g., `NAVIGATE_OK`, `LIST_TABS_OK`), and cross-check browser state
- **Session directory tests**: Verify `NORI_SESSION_DIR` env var is set, `system-prompt.txt` exists with correct CDP port and bridge path, and that the session directory is removed when the app closes

### Things to Know

- Within each `test.describe` block, tests share one Electron app instance and test order matters -- later tests depend on browser/tab state from earlier tests
- The `Nori Browser Tabs` suite uses its own port offsets (`CDP_PORT + 10`, `CONTROL_PORT + 10`) separate from the core suite to allow independent operation
- The session cleanup test and the "closing the last tab closes the window" test both close the Electron app and must run last within their respective suites. The `afterAll` handlers guard against a null `electronApp`
- Tab tests use `window.evaluate()` to click tab elements rather than direct Playwright selectors to avoid stale element handles after tab list re-renders

Created and maintained by Nori.
