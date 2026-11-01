const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  minimize:       ()      => ipcRenderer.send('win-minimize'),
  maximize:       ()      => ipcRenderer.send('win-maximize'),
  close:          ()      => ipcRenderer.send('win-close'),
  isMaximized:    ()      => ipcRenderer.invoke('win-is-maximized'),
  onMaximizeChange: (cb)  => ipcRenderer.on('win-maximized-changed', (_e, val) => cb(val)),
  resizeWindow:   (w, h)  => ipcRenderer.send('win-resize', w, h),
  
  // NUOVI PONTI: getBounds e centerWindow
  getBounds:      ()      => ipcRenderer.invoke('get-bounds'),
  centerWindow:   ()      => ipcRenderer.invoke('center-window'),

  //CACHE
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearHttpCache:  () => ipcRenderer.invoke('clear-http-cache'),
  
  platform: process.platform,
  
  
  //DiscordRPC
  updateDiscordRPC: (data) => ipcRenderer.send('update-discord-rpc', data),
  clearDiscordRPC:  ()     => ipcRenderer.send('clear-discord-rpc'),
  setDiscordRPC:    (v)    => ipcRenderer.send('set-discord-rpc', v),


  //miniplayer
  toggleMiniWindow: () => ipcRenderer.send('toggle-mini-window'),
  
  // Metodi per la Finestra Principale
  syncToMini: (data) => ipcRenderer.send('sync-to-mini', data),
  onMiniAction: (callback) => ipcRenderer.on('execute-mini-action', (_event, action, payload) => callback(action, payload)),
  
  // Metodi per la Finestra del Mini Player
  sendMiniAction: (action, payload) => ipcRenderer.send('action-from-mini', action, payload),
  onUpdateMiniUI: (callback) => ipcRenderer.on('update-mini-ui', (_event, data) => callback(data)),

  //MD5 FOR STREAM
  getMD5: (text) => ipcRenderer.invoke('generate-md5', text),

  //Apple Token
  getAppleToken: () => ipcRenderer.invoke('get-apple-token'),
  appleApiFetch: (url, token) => ipcRenderer.invoke('apple-api-fetch', url, token),
    
});
