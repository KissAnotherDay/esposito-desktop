const { app, BrowserWindow, ipcMain, shell, session, Menu, screen } = require('electron');
const path = require('path');

app.setAppUserModelId("com.esposito.hifi");

// DISABILITA CACHE: Impedisce a Chromium di salvare file su disco (JSON, immagini, stream)
// Questo risolve il problema dei MB accumulati inutilmente.
app.commandLine.appendSwitch('disable-http-cache');

let mainWindow;

const crypto = require('crypto');

// ── DISCORD RPC ──────────────────────────────────────────────
let rpc = null;
let rpcEnabled = false;
let rpcReady = false;

const DISCORD_CLIENT_ID = '1479960286885576955';

async function initDiscordRPC() {
  try {
    const DiscordRPC = require('discord-rpc');
    DiscordRPC.register(DISCORD_CLIENT_ID);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
      rpcReady = true;
      console.log('Discord RPC connesso');
    });
    await rpc.login({ clientId: DISCORD_CLIENT_ID });
  } catch (e) {
    console.warn('Discord RPC non disponibile:', e.message);
    rpc = null;
    rpcReady = false;
  }
}

function destroyDiscordRPC() {
  if (rpc) {
    try { rpc.destroy(); } catch (_) {}
    rpc = null;
    rpcReady = false;
  }
}

// ── FINESTRA PRINCIPALE ──────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1102,
    height: 721,
	  title: "Esposito HI-FI",
    minWidth: 300,
    minHeight: 300,
    //alwaysOnTop: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#080808',
    icon: path.join(__dirname, 'build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Menu contestuale (Ispeziona Elemento e Ricarica)
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Inspect Element', click: () => mainWindow.webContents.inspectElement(params.x, params.y) },
      { type: 'separator' },
      { label: 'Reload', role: 'reload' },
    ]);
    menu.popup({ window: mainWindow });
  });

  // Apri i link esterni (es. social o info) nel browser di sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    if (miniWindow) {
      miniWindow.close();
    }
    mainWindow = null;
  });

}

// ── EVENTI APP ───────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: CONTROLLI FINESTRA ──────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close',  () => mainWindow?.close());
ipcMain.on('win-resize', (_, w, h) => mainWindow?.setSize(w, h, true));

ipcMain.handle('get-bounds',       () => mainWindow?.getBounds() ?? null);
ipcMain.handle('center-window',    () => mainWindow?.center());
ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ── IPC: GESTIONE CACHE ───────────────────────────────────────
ipcMain.handle('get-cache-size', async () => {
  try { return await session.defaultSession.getCacheSize(); } catch { return 0; }
});
ipcMain.handle('clear-http-cache', async () => {
  try { await session.defaultSession.clearCache(); return true; } catch { return false; }
});

// ── IPC: DISCORD RPC ──────────────────────────────────────────
ipcMain.on('set-discord-rpc', async (_, enabled) => {
  rpcEnabled = enabled;
  if (enabled) {
    if (!rpc) await initDiscordRPC();
  } else {
    destroyDiscordRPC();
  }
});

ipcMain.on('update-discord-rpc', (_, data) => {
  if (!rpcEnabled || !rpc || !rpcReady) return;
  try {

    let imgKey = data.cover;
    if (!imgKey || imgKey.startsWith('data:') || imgKey.startsWith('blob:')) {
      imgKey = 'no-cover';
    }

    const start = Math.floor(Date.now() / 1000);
    rpc.setActivity({
      type: 2,
      details:        data.title,
      state:          `${data.artist}${data.albumTitle ? ' — ' + data.albumTitle : ''}`,
      largeImageKey:  imgKey,
      largeImageText: data.albumTitle || data.artist,
      smallImageKey:  'app_logo',
      smallImageText: 'Esposito Hi-Fi',
      startTimestamp: start,
      endTimestamp:   data.duration ? start + Math.floor(data.duration) : undefined,
      instance:       false,
    });
  } catch (e) {
    console.warn('Discord RPC error:', e.message);
  }
});

ipcMain.on('clear-discord-rpc', () => {
  if (!rpc || !rpcReady) return;
  try { rpc.clearActivity(); } catch (_) {}
});

// MD5
ipcMain.handle('generate-md5', (_, text) => {
  return crypto.createHash('md5').update(text).digest('hex');
});

// ── APPLE MUSIC API (TOKEN & FETCH DIRETTO) ──────────────────
let appleTokenCache = null;
let appleTokenExp = 0;

// Handler 1: Estrazione del Token
ipcMain.handle('get-apple-token', async () => {
  if (appleTokenCache && Date.now() < appleTokenExp) {
    return appleTokenCache;
  }

  try {
    const headers = { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36" 
    };
    
    const resHTML = await fetch("https://music.apple.com/it/new", { headers });
    const html = await resHTML.text();
    
    const jsMatch = html.match(/crossorigin src="(\/assets\/index.+?\.js)"/);
    if (!jsMatch) {
      console.error("[Main] Js file not found");
      return null;
    }
    
    const resJS = await fetch(`https://music.apple.com${jsMatch[1]}`, { headers });
    const js = await resJS.text();
    const tokenMatch = js.match(/="(eyJ[^"]+)"/);
    
    if (tokenMatch) {
        appleTokenCache = tokenMatch[1];
        appleTokenExp = Date.now() + (3600 * 1000);
        console.log("✅ [Main] New Apple Token successfully generated!");
        return appleTokenCache;
    } else {
        console.error("[Main] Token not found in Js file");
    }
  } catch (e) {
    console.error("❌ [Main] Critical error while fetching Apple Token:", e);
  }
  return null;
});

// Handler 2: Esecuzione richieste API bypassando CORS
ipcMain.handle('apple-api-fetch', async (_, url, token) => {
  try {
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Origin": "https://music.apple.com",
      "Referer": "https://music.apple.com/"
    };
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      if (response.status === 404) throw new Error("404");
      throw new Error(`Apple API Error: ${response.status}`);
    }
    
    return await response.json();
  } catch (e) {
    throw e;
  }
});

/*MINIPLAYER*/


let miniWindow = null;

// Funzione per creare la finestra del Mini Player
function createMiniWindow() {
  if (miniWindow) {
    miniWindow.focus();
    return;
  }

  miniWindow = new BrowserWindow({
    width: 368,
    height: 374,
    minWidth: 300,
    minHeight: 300,
    alwaysOnTop: true, // Spesso comodo per i mini player
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  // Caricheremo un file HTML separato per il mini player
  miniWindow.loadFile('mini.html');
  
  // Hover state for the mini player UI. :hover is lost over -webkit-app-region: drag areas,
  // so the main process tracks the cursor and tells the renderer when it is inside the window.
  let lastInside = null;
  const hoverTimer = setInterval(() => {
    if (!miniWindow || miniWindow.isDestroyed()) return clearInterval(hoverTimer);
    const p = screen.getCursorScreenPoint();
    const b = miniWindow.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== lastInside) {
      lastInside = inside;
      miniWindow.webContents.send('mini-hover', inside);
    }
  }, 80);
  // Re-send the state once the page has loaded (the first message could arrive too early)
  miniWindow.webContents.on('did-finish-load', () => { lastInside = null; });

  miniWindow.on('closed', () => {
	clearInterval(hoverTimer);
    miniWindow = null;
    // Avvisa la finestra principale che il mini player è stato chiuso
    if (mainWindow) mainWindow.webContents.send('mini-closed');
  });
}

// ── IPC: GESTIONE MINI PLAYER ──────────────────────────────────
// Apri o chiudi il mini player
ipcMain.on('toggle-mini-window', () => {
  if (miniWindow) {
    miniWindow.close();
  } else {
    createMiniWindow();
  }
});

// PONTE IPC: Dalla Finestra Principale al Mini Player (Aggiornamento UI)
ipcMain.on('sync-to-mini', (event, data) => {
  if (miniWindow) {
    miniWindow.webContents.send('update-mini-ui', data);
  }
});

// PONTE IPC: Dal Mini Player alla Finestra Principale (Comandi)
ipcMain.on('action-from-mini', (event, action, payload) => {
  if (mainWindow) {
    mainWindow.webContents.send('execute-mini-action', action, payload);
  }
});