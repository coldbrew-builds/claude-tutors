const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  onOverlayEvent(callback) {
    ipcRenderer.on('overlay-event', (_event, eventName, data) => {
      callback(eventName, data);
    });
  },
  setIgnoreMouseEvents(ignore, opts) {
    ipcRenderer.send('set-ignore-mouse-events', ignore, opts);
  }
});
