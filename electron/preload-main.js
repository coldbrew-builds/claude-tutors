const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  forwardToOverlay(eventName, data) {
    ipcRenderer.send('forward-to-overlay', eventName, data);
  },
  setSessionActive(active) {
    ipcRenderer.send('session-active', active);
  },
  onSelectDisplaySource(callback) {
    ipcRenderer.on('select-display-source', (_event, sources) => callback(sources));
  },
  selectDisplaySource(sourceId) {
    ipcRenderer.send('display-source-selected', sourceId);
  }
});
