# Current Progress

## Completed
- Initial Electron app with WebContentsView for web content (migrated from deprecated BrowserView)
- Terminal sidebar with node-pty integration (xterm.js)
- Sidebar/divider resizing
- URL bar with navigation (back/forward/reload)
- CDP (Chrome DevTools Protocol) exposure on configurable port
- playwright-bridge.js CLI for agent-driven browser scripting
- Control socket server for external terminal I/O
- Session directory with system prompt for Claude Code integration
- Multi-tab support with Chrome-like behavior:
  - Tab bar UI with tab titles, close buttons, active tab highlighting
  - Tab creation, closing, switching via UI buttons and IPC
  - Tab reordering via drag-and-drop and IPC
  - Chrome keyboard shortcuts via Electron Menu accelerators (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1-9, Ctrl+Shift+PgUp/PgDn)
  - Scriptable tab management via playwright-bridge (list-tabs, new-tab, close-tab, switch-tab)
  - Closing last tab closes the window
  - window.open() intercepted to create new tabs
- Full e2e test suite (23 tests passing: 12 core + 11 tab tests)

## In Progress
- (nothing currently in progress)

## Not Started
- (nothing else planned)
