const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('stemlab', {
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  runSetup: (opts) => ipcRenderer.invoke('setup:run', opts),
  onSetupLog: (fn) => ipcRenderer.on('setup:log', (_e, line) => fn(line)),
  onSetupProgress: (fn) => ipcRenderer.on('setup:progress', (_e, p) => fn(p)),
  startEngine: () => ipcRenderer.invoke('engine:start'),
  onEngineDied: (fn) => ipcRenderer.on('engine:died', (_e, info) => fn(info)),
  pickAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
});
