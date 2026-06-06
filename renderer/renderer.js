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

term.attachCustomKeyEventHandler((ev) => {
  if (ev.ctrlKey && ev.key === 'j') return false;
  return true;
});

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

const terminalContainer = document.getElementById('terminal-container');
const resizeObserver = new ResizeObserver(() => {
  const rect = terminalContainer.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    fitAddon.fit();
    window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
  }
});
resizeObserver.observe(terminalContainer);

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

const divider = document.getElementById('divider');
const sidebar = document.getElementById('sidebar');

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'j') {
    e.preventDefault();
    window.api.toggleSidebar();
  }
});

window.api.onSidebarToggled((visible) => {
  if (visible) {
    sidebar.classList.remove('sidebar-hidden');
    divider.classList.remove('sidebar-hidden');
    requestAnimationFrame(() => {
      fitAddon.fit();
      window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
    });
  } else {
    sidebar.classList.add('sidebar-hidden');
    divider.classList.add('sidebar-hidden');
  }
});
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
