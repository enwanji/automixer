const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, payload) => callback(payload));

contextBridge.exposeInMainWorld('dialld', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  listAudioDevices: () => ipcRenderer.invoke('audio:listDevices'),

  capture: (opts) => ipcRenderer.invoke('session:capture', opts),
  cancelCapture: () => ipcRenderer.invoke('session:cancel'),
  analyzeFiles: (opts) => ipcRenderer.invoke('session:analyzeFiles', opts),
  onCaptureLevels: on('capture:levels'),
  onCaptureDone: on('capture:done'),
  onChannelAnalyzed: on('analysis:channel'),

  connectConsole: (profileId, host, port) => ipcRenderer.invoke('console:connect', { profileId, host, port }),
  discoverConsoles: (profileId) => ipcRenderer.invoke('console:discover', { profileId }),
  disconnectConsole: () => ipcRenderer.invoke('console:disconnect'),
  readChannelNames: (profileId, channels) => ipcRenderer.invoke('console:channelNames', { profileId, channels }),
  apply: (profileId, items, dryRun = false) => ipcRenderer.invoke('console:apply', { profileId, items, dryRun }),
  audition: (profileId, items) => ipcRenderer.invoke('console:audition', { profileId, items }),
  undoAudition: () => ipcRenderer.invoke('console:auditionUndo'),
  keepAudition: () => ipcRenderer.invoke('console:auditionKeep'),
  onOscLog: on('osc:log'),
  onConsoleError: on('console:error'),
});
