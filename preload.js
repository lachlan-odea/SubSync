const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: (opts) => ipcRenderer.invoke('open-file-dialog', opts),
  saveFileDialog: (opts) => ipcRenderer.invoke('save-file-dialog', opts),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getTempPath: (ext) => ipcRenderer.invoke('get-temp-path', ext),

  update: {
    check:   () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onChecking:   (cb) => ipcRenderer.on('update:checking',  () => cb()),
    onAvailable:  (cb) => ipcRenderer.on('update:available',  (_, d) => cb(d)),
    onNone:       (cb) => ipcRenderer.on('update:none',       () => cb()),
    onProgress:   (cb) => ipcRenderer.on('update:progress',   (_, d) => cb(d)),
    onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, d) => cb(d)),
    onError:      (cb) => ipcRenderer.on('update:error',      (_, d) => cb(d)),
  },
});
