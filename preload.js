const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendTerminalInput: (data) => ipcRenderer.send('terminal-input', data),
  resizeTerminal: (size) => ipcRenderer.send('terminal-resize', size),
  onTerminalData: (cb) => ipcRenderer.on('terminal-data', (_, data) => cb(data)),
  onTerminalExit: (cb) => ipcRenderer.on('terminal-exit', (_, code) => cb(code)),
  navigate: (url) => ipcRenderer.send('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  onUrlChanged: (cb) => ipcRenderer.on('url-changed', (_, url) => cb(url)),
  resizeSidebar: (width) => ipcRenderer.send('sidebar-resize', width),
  onCdpPort: (cb) => ipcRenderer.on('cdp-port', (_, port) => cb(port)),
});
