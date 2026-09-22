const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File.path was removed in Electron 32; webUtils is the supported way to get a dropped file's path.
  pathForFile: (file) => webUtils.getPathForFile(file),
  listKeys: () => ipcRenderer.invoke('gpg:listKeys'),
  encrypt: (files, fingerprint) => ipcRenderer.invoke('gpg:encrypt', files, fingerprint),
  inspect: (paths) => ipcRenderer.invoke('fs:inspect', paths),
  encryptZip: (paths, fingerprint, name) => ipcRenderer.invoke('gpg:encryptZip', paths, fingerprint, name),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  onJobProgress: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('job:progress', h);
    return () => ipcRenderer.removeListener('job:progress', h);
  },
  deleteSources: (jobId) => ipcRenderer.invoke('sources:delete', jobId),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  // Files dropped on the Dock icon / opened via Finder "Open With".
  onFilesOpened: (cb) => ipcRenderer.on('files:opened', (_e, files) => cb(files)),
});
