const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  forwardToOverlay(eventName, data) {
    ipcRenderer.send('forward-to-overlay', eventName, data);
  },
  setSessionActive(active) {
    ipcRenderer.send('session-active', active);
  }
});
