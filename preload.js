const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  minimize:       ()      => ipcRenderer.send('win-minimize'),
  maximize:       ()      => ipcRenderer.send('win-maximize'),
  close:          ()      => ipcRenderer.send('win-close'),
  isMaximized:    ()      => ipcRenderer.invoke('win-is-maximized'),
  onMaximizeChange: (cb)  => ipcRenderer.on('win-maximized-changed', (_e, val) => cb(val)),
  resizeWindow:   (w, h)  => ipcRenderer.send('win-resize', w, h),
  
  // New bridges: getBounds and centerWindow
  getBounds:      ()      => ipcRenderer.invoke('get-bounds'),
  centerWindow:   ()      => ipcRenderer.invoke('center-window'),

  // Cache
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearHttpCache:  () => ipcRenderer.invoke('clear-http-cache'),
  
  platform: process.platform,
  
  
  // Discord RPC
  updateDiscordRPC: (data) => ipcRenderer.send('update-discord-rpc', data),
  clearDiscordRPC:  ()     => ipcRenderer.send('clear-discord-rpc'),
  setDiscordRPC:    (v)    => ipcRenderer.send('set-discord-rpc', v),


  // Mini player
  toggleMiniWindow: () => ipcRenderer.send('toggle-mini-window'),
  
  // Main window methods
  syncToMini: (data) => ipcRenderer.send('sync-to-mini', data),
  onMiniAction: (callback) => ipcRenderer.on('execute-mini-action', (_event, action, payload) => callback(action, payload)),
  
  // Mini player window methods
  sendMiniAction: (action, payload) => ipcRenderer.send('action-from-mini', action, payload),
  onUpdateMiniUI: (callback) => ipcRenderer.on('update-mini-ui', (_event, data) => callback(data)),
  onMiniHover: (callback) => ipcRenderer.on('mini-hover', (_event, inside) => callback(inside)),

  // MD5 for stream signing
  getMD5: (text) => ipcRenderer.invoke('generate-md5', text),

  // Apple token
  getAppleToken: () => ipcRenderer.invoke('get-apple-token'),
  appleApiFetch: (url, token) => ipcRenderer.invoke('apple-api-fetch', url, token),
    
});
