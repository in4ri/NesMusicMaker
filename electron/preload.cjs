// Exposes a minimal, safe file API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nesApi', {
  openProject: () => ipcRenderer.invoke('open-project'),
  saveProject: (path, text) => ipcRenderer.invoke('save-project', path, text),
  saveBinary: (defaultName, filterName, extensions, bytes) =>
    ipcRenderer.invoke('save-binary', defaultName, filterName, extensions, bytes),
  saveFiles: (files, defaultFolder) => ipcRenderer.invoke('save-files', files, defaultFolder),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  loadLibrary: () => ipcRenderer.invoke('library-load'),
  saveLibrary: (text) => ipcRenderer.invoke('library-save', text),
  onMenu: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
