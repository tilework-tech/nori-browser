import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

const term = new Terminal({
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  },
  cursorBlink: true,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));

requestAnimationFrame(() => {
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
  window.api.signalTerminalReady();
});

term.onData((data) => {
  window.api.sendTerminalInput(data);
});

window.api.onTerminalData((data) => {
  term.write(data);
});

window.api.onTerminalExit((code) => {
  term.write(`\r\n[Process exited with code ${code}]\r\n`);
});

const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
});
resizeObserver.observe(document.getElementById('terminal-container'));

const urlBar = document.getElementById('url-bar');
urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.api.navigate(urlBar.value);
  }
});

window.api.onUrlChanged((url) => {
  urlBar.value = url;
});

document.getElementById('btn-back').addEventListener('click', () => window.api.goBack());
document.getElementById('btn-forward').addEventListener('click', () => window.api.goForward());
document.getElementById('btn-reload').addEventListener('click', () => window.api.reload());

window.api.onCdpPort((port) => {
  document.getElementById('cdp-info').textContent = `CDP :${port}`;
});

// Tab bar
const tabList = document.getElementById('tab-list');
const newTabBtn = document.getElementById('new-tab-btn');

newTabBtn.addEventListener('click', () => {
  window.api.createTab();
});

let dragTabId = null;

function renderTabs(data) {
  tabList.innerHTML = '';
  for (const tab of data.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === data.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.draggable = true;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => {
      window.api.switchTab(tab.id);
    });

    el.addEventListener('dragstart', (e) => {
      dragTabId = tab.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragTabId = null;
      tabList.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragTabId && dragTabId !== tab.id) {
        el.classList.add('drag-over');
      }
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (dragTabId && dragTabId !== tab.id) {
        const dropIndex = data.tabs.findIndex(t => t.id === tab.id);
        window.api.reorderTab(dragTabId, dropIndex);
      }
    });

    tabList.appendChild(el);
  }
}

window.api.onTabsChanged((data) => {
  renderTabs(data);
});

// Sidebar divider
const divider = document.getElementById('divider');
const sidebar = document.getElementById('sidebar');
let isDragging = false;

divider.addEventListener('mousedown', (e) => {
  isDragging = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const newWidth = Math.max(200, Math.min(800, e.clientX));
  sidebar.style.width = `${newWidth}px`;
  window.api.resizeSidebar(newWidth);
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});
