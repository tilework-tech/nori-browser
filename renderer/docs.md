# Noridoc: renderer

Path: @/renderer

### Overview

- Frontend UI for the Nori Browser Electron app: a terminal sidebar on the left, a draggable divider, a browser toolbar with URL bar and omnibar autocomplete dropdown, a Chrome-like tab bar, and several overlay UI elements (find bar, download shelf, status bar, zoom indicator) on the right
- `renderer.js` is the source; it gets bundled by esbuild into `bundle.js` which is loaded by `index.html`
- All communication with the main process goes through `window.api` (exposed via `@/preload.js`)

### How it fits into the larger codebase

- Loaded by `mainWindow.loadFile()` in `@/main.js`; sits alongside (not inside) the `WebContentsView` instances which render actual web content in tabs
- Receives URL updates, CDP port info, tab state, find results, zoom changes, download progress/completion, status bar URLs, and fullscreen state from the main process via IPC listeners
- Sends user actions back to main process: terminal keystrokes (`sendTerminalInput`), URL bar navigation (`navigate`), toolbar buttons (`goBack`, `goForward`, `reload`), sidebar width changes (`resizeSidebar`), sidebar toggle (`toggleSidebar`), omnibar queries (`queryOmnibar`), tab operations (`createTab`, `closeTab`, `switchTab`, `reorderTab`, `reopenClosedTab`, `duplicateTab`, `closeOtherTabs`, `closeTabsToRight`, `showTabContextMenu`, `pinTab`, `unpinTab`), find-in-page commands (`findInPage`, `findNext`, `findClose`), and download actions (`downloadCancel`, `downloadOpen`, `downloadShow`)
- The terminal is rendered by xterm.js with the FitAddon; terminal sizing (`cols`/`rows`) is synced to the main process so `node-pty` can resize its pseudoterminal accordingly
- Each tab's `WebContentsView` occupies the area below the toolbar and tab bar, to the right of the sidebar. View bounds are managed entirely by the main process -- the renderer just reports sidebar width changes

### Core Implementation

- **Terminal setup**: xterm.js `Terminal` instance opens into `#terminal-container`, with `FitAddon` handling auto-resize. A `ResizeObserver` on the container triggers re-fit + PTY resize on layout changes (guarded against zero dimensions to avoid errors when the sidebar is hidden). A custom key event handler on xterm suppresses Ctrl+J so xterm does not consume it as a linefeed character
- **URL bar and omnibar autocomplete**: The `#url-bar` input is wrapped in a `#url-bar-wrapper` (positioned relative) that also contains `#omnibar-dropdown` (positioned absolute below the input). On every keystroke, a debounced handler (150ms) calls `window.api.queryOmnibar(query)` which returns ranked results from Chrome history and bookmarks (see `@/main.js`). The `renderOmnibar()` function builds the dropdown items -- each showing a title and URL, with bookmarks prefixed by a star indicator. Keyboard navigation: ArrowDown/ArrowUp moves selection (`.selected` class), Enter navigates to the selected item (or falls through to normal URL bar submit if nothing selected), Escape closes the dropdown. Clicking an item uses `mousedown` (not `click`) to fire before the input's `blur` event. The dropdown is hidden on blur with a 200ms delay to allow click events to register. The `onUrlChanged` IPC listener also dismisses the dropdown when navigation completes
- **Tab bar**: The `#tab-bar` contains a `#tab-list` (rendered dynamically from `tabs-changed` IPC events) and a `#new-tab-btn`. Each tab element has: a favicon or loading spinner, a title span, a click handler for switching, a close button (omitted for pinned tabs), middle-click to close, right-click for a native context menu via `window.api.showTabContextMenu()`, and drag-and-drop support for reordering. The `renderTabs()` function rebuilds the entire tab list on every `tabs-changed` event, marking the active tab with `.active` and pinned tabs with `.pinned`
- **Tab favicon & loading spinner**: `renderTabs()` renders a `.tab-spinner` (CSS-only spinning border animation) when `tab.isLoading` is true, or a `.tab-favicon` `<img>` when `tab.favicon` is a non-empty URL. The img has an `error` handler that hides it on broken URLs. Pinned tabs display as just the favicon (title and close button are hidden via CSS), matching Chrome's compact pinned tab appearance
- **Tab drag-and-drop reordering**: Tabs have `draggable=true`. Drag events track the source tab ID in a `dragTabId` closure variable. On drop, `window.api.reorderTab()` sends the dragged tab's ID and the drop target's index to the main process, which splices the tab array and emits `tabs-changed` back
- **Tab context menu**: Right-clicking a tab sends `tab-context-menu` IPC to the main process, which builds and displays a native Electron `Menu.popup()`. This is NOT a custom HTML menu -- it uses the OS-native context menu
- **Sidebar resize**: Mousedown on `#divider` starts a drag; mousemove updates `sidebar.style.width`, notifies main process via `resizeSidebar()`, and re-fits the terminal. Constrained to 200-800px
- **Sidebar toggle (Ctrl+J)**: A document-level `keydown` listener catches Ctrl+J and calls `window.api.toggleSidebar()`. The main process responds with a `sidebar-toggled` IPC event; the renderer handler toggles a `.sidebar-hidden` CSS class (`display: none !important` in `@/renderer/styles.css`) on both `#sidebar` and `#divider`. When the sidebar is shown, a `requestAnimationFrame` re-fits the terminal and syncs the PTY size
- **Find bar**: The `#find-bar` is a floating overlay (positioned absolutely at top-right of `#browser-area`) that starts hidden. Shown when the main process sends `show-find-bar` IPC (triggered by Ctrl+F or View menu). The input fires `findInPage` IPC on every keystroke. Enter advances forward, Shift+Enter advances backward. Match count is displayed as "N of M" via `onFindResults` IPC. Escape or the close button hides the bar and sends `findClose` IPC
- **Zoom indicator**: The `#zoom-indicator` is a centered overlay that briefly shows the zoom percentage (e.g., "110%") when the main process sends `zoom-changed` IPC. It auto-hides after 1.5 seconds via `setTimeout`. Uses `pointer-events: none` so it does not block clicks
- **Download shelf**: The `#download-shelf` is a bottom bar that appears when downloads are active. Download progress and completion events from the main process populate a renderer-local `activeDownloads` Map. Each download item shows the filename, a progress bar (during download) or open/show buttons (after completion). A close button on the shelf clears all downloads. The entire shelf DOM is rebuilt on every update via `renderDownloadShelf()`
- **Status bar**: The `#status-bar` is a bottom-left overlay that shows the URL of a hovered link. It is shown/hidden by the `onStatusBarUrl` IPC -- a non-empty URL shows the bar, an empty string hides it
- **Fullscreen**: The `onFullscreenChanged` IPC listener hides or shows `#toolbar` and `#tab-bar` by toggling the `.hidden` CSS class. This is triggered by HTML5 fullscreen events on the web content (`enter-html-full-screen`/`leave-html-full-screen` in `@/main.js`), not by window-level F11 fullscreen
- **CDP info display**: `#cdp-info` span in the sidebar header shows the CDP port once received from the main process

### Things to Know

- `index.html` has a Content-Security-Policy: `default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `script-src 'self'`, `img-src 'self' http: https: data:`. The `img-src` directive was added to allow loading external site favicons in tab elements
- `bundle.js` is a build artifact checked into the repo. It must be rebuilt (`npm run build`) after any change to `renderer.js`
- xterm.css is loaded directly from `node_modules` via a relative path in `index.html` -- this works because Electron loads files from the filesystem, not a web server
- The `renderTabs()` function is destructive -- it clears `tabList.innerHTML` and rebuilds the entire DOM on every `tabs-changed` event. All event listeners are re-attached each render cycle. This means no stale listener issues, but no DOM state (e.g., scroll position within the tab bar) survives a re-render
- The same destructive rebuild pattern is used by `renderDownloadShelf()` for the download shelf
- The URL bar `value` is populated by the `onUrlChanged` IPC event whenever the active tab navigates or the user switches tabs
- The omnibar dropdown uses `mousedown` instead of `click` for item selection because `blur` fires before `click` but after `mousedown`. The 200ms delay on the blur handler is a safety net for edge cases where `mousedown` does not fire (e.g., touch events)
- Tab styling in `styles.css` uses Chrome-like conventions: rounded top corners on tabs, a distinct background on the active tab, a visible drag-over indicator (left blue border), and opacity reduction during drag. Pinned tabs (`.tab.pinned`) are fixed at 36px width with the title and close button hidden via `display: none`, matching Chrome's compact pinned tab appearance
- Ctrl+J is intercepted at three layers: xterm's custom key handler (returns `false` to prevent linefeed), a document `keydown` listener (sends `toggle-sidebar` IPC), and the main process `before-input-event` on both webContents (see `@/main.js`). All three are needed because focus can be in xterm, the renderer document, or the WebContentsView
- The `#browser-area` has `position: relative` so that the find bar, download shelf, status bar, and zoom indicator can be positioned absolutely within it. The find bar and zoom indicator have `z-index: 100`; the status bar has `z-index: 99` (so it renders below the download shelf when both are visible)

Created and maintained by Nori.
