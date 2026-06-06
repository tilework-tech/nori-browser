# Noridoc: renderer

Path: @/renderer

### Overview

- Frontend UI for the Electron app: xterm.js terminal in the left sidebar, URL toolbar, and drag-to-resize divider
- `renderer.js` is the source; `bundle.js` is the esbuild output loaded by `index.html`
- Communicates with the main process exclusively through the `window.api` bridge defined in `@/preload.js`

### How it fits into the larger codebase

- The renderer is loaded by the BrowserWindow created in `@/main.js` via `mainWindow.loadFile('renderer/index.html')`
- All terminal I/O passes through `window.api`: keystrokes go out via `sendTerminalInput()`, PTY output arrives via `onTerminalData()` callback
- After xterm.js initializes and fits, the renderer sends a `terminalReady()` signal that triggers PTY spawn in the main process -- this is a hard dependency in the startup sequence
- Navigation controls (back/forward/reload/URL bar) send IPC messages that the main process forwards to the BrowserView
- Sidebar resize events (`resizeSidebar()`) update the main process's layout state, which repositions the BrowserView
- The BrowserView itself is not part of this renderer -- it is a separate Electron BrowserView managed by the main process and overlaid on the right side of the window

### Core Implementation

- **xterm.js setup**: creates a Terminal instance with FitAddon, opens it in `#terminal-container`, then calls `fitAddon.fit()` inside `requestAnimationFrame` to ensure the DOM has laid out
- **Readiness signal**: after the initial fit, calls `window.api.terminalReady()` to tell the main process it is safe to spawn the PTY. This prevents output from being lost before the terminal is rendered.
- **Resize handling**: a `ResizeObserver` on `#terminal-container` re-fits the terminal and sends updated dimensions to the main process on every container size change
- **Sidebar drag**: mousedown on `#divider` starts a drag that updates `#sidebar` width, notifies the main process via `resizeSidebar()`, and re-fits the terminal

### Things to Know

- The `terminalReady` signal is sent exactly once, inside `requestAnimationFrame` after the first fit. If the terminal container has zero dimensions at that point (e.g., CSS issue), the fit may produce incorrect cols/rows.
- `bundle.js` must be rebuilt (`npm run build`) after any change to `renderer.js`. The build step uses esbuild in IIFE format for browser compatibility.
- The URL bar updates reactively via the `onUrlChanged` callback, which fires when the BrowserView navigates (including in-page navigation). The URL bar and the BrowserView are not in the same renderer context.

Created and maintained by Nori.
