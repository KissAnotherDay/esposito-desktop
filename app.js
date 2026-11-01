// app.js — Main application controller

import {
  apiFetch, getAlbum, getArtist, getArtistTopTracks, searchAll, searchTracks, searchAlbums, searchArtists,
  getFeatured, getPlaylist, getFavoriteTracks, getFavoriteAlbums, getUserInfo,
  getFavoriteArtists, getStreamUrl, downloadAlbum,
  coverUrl, formatDur, escHtml, sortByDate, partitionReleases, transformTrack as originalTransformTrack,
  qualityLabel, mapQuality, setApiBase,
  isAuthenticated, setCredentials, clearCredentials
} from './api.js';

// Intercetta tutti i brani e aggiunge la versione al titolo se presente
function transformTrack(t, options) {
  // 1. Elabora il brano normalmente con la funzione originale
  const track = originalTransformTrack(t, options);
  
  // 2. Se la risposta API contiene una "version" (es. RMX, Live, Acoustic...)
  if (t.version) {
    // Controllo di sicurezza: se la versione non è già scritta nel titolo, la aggiunge tra parentesi
    if (!track.title.toLowerCase().includes(t.version.toLowerCase())) {
      track.title = `${track.title} (${t.version})`;
    }
  }
  
  return track;
}

import { player } from './player.js';

import {
  fadeIn, staggerFadeIn, albumCard, artistCard, trackRow, albumHero, artistHero,
  showContextMenu, toast, modal, removeModal, progressDialog, skeletonGrid, skeletonList,
  checkMarquee, ripple, initSeekbar, initVolume
} from './ui.js';

import { getAppleAlbumId, getAnimatedArtwork, coverVideoManager, getAppleArtistImage } from './apple.js';

// --- GESTORE TESTI ---
import { LyricsManager } from './lyrics.js';

// --- METADATA TAGGER ---
import { embedMetadata } from './tagger.js';

//--- APPLE MUSIC ---
import { AppleImporter } from './apple_import.js';

// ── GESTORE DATABASE FILE LOCALI (IndexedDB) ───────────────────
window.LocalDB = {
  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("EspositoAudioDB", 1);
      request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore("files");
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e);
    });
  },
  async saveFile(id, file) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(file, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async getFile(id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const req = tx.objectStore("files").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

class App {
  constructor() {
    this.history = [];
    this.forwardHistory = [];
    this.currentView = 'home';
    this._currentAlbumTracks = [];
    this._currentArtistTracks = [];
    this._currentPlaylistTracks = [];
    this._currentSearchTracks = [];
    this._searchTab = 'all';
    this._searchQuery = '';
    this._searchDebounce = null;
    this._abortController = null;
    this._playlists = [];
    this._settings = this._loadSettings();

    // Carica le ricerche recenti
    this._recentSearches = JSON.parse(localStorage.getItem('recent_searches') || '[]');
    
    this._pendingRestoreTime = null;
      
    this._bindPlayer();
    this._bindKeyboard();
    this._initDragAndDrop();
    

    // FIX CACHE: Salva coda e minutaggio prima del Refresh
    const saveSession = () => {
      if (window.player && window.player.queue && window.player.queue.length > 0) {
        localStorage.setItem('saved_queue', JSON.stringify(window.player.queue));
        localStorage.setItem('saved_queue_idx', window.player.queueIdx);
        // Salva il tempo corrente reale se sta suonando o è in pausa
        const currentTime = window.player.audio ? window.player.audio.currentTime : (this._lastTrackTime || 0);
        localStorage.setItem('saved_track_time', currentTime);
      }

      if (window.player) {
        localStorage.setItem('saved_shuffle', window.player.shuffle);
        localStorage.setItem('saved_repeat', window.player.repeat);
      }

    };

    window.addEventListener('beforeunload', saveSession);
    window.addEventListener('pagehide', saveSession);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveSession();
    });
  }


  // ── INIT ────────────────────────────────────────────────────
  async init() {

    if (!isAuthenticated()) {
      document.getElementById('login-overlay').style.display = 'flex';
      return;
    }

    // 2. Se è loggato, nascondi il login e prosegui
    const loginOverlay = document.getElementById('login-overlay');
    if(loginOverlay) loginOverlay.style.display = 'none';

    initSeekbar(player);
    initVolume(player);
    this._initMobileTouchBars();

    initSeekbar(player);
    initVolume(player);
    this._initMobileTouchBars();
    this._applySettings();
    
    LyricsManager.init();
    
    const searchInput = document.getElementById('titlebar-search');
    if (searchInput) searchInput.value = '';
    
    //await detectCountry();

    // FIX SIDEBAR: Ripristina stato salvato
    const isSidebarCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    if (isSidebarCollapsed || window.innerWidth <= 767) {
      document.getElementById('sidebar').classList.add('collapsed');
    } else {
      document.getElementById('sidebar').classList.remove('collapsed');
    }

    // RIPRISTINO SESSIONE
    const savedQueue = JSON.parse(localStorage.getItem('saved_queue') || 'null');
    const savedIdx   = parseInt(localStorage.getItem('saved_queue_idx') || '0', 10);
    const savedTime  = parseFloat(localStorage.getItem('saved_track_time') || '0');

    // AGGIUNTA: Recupera stato Shuffle e Repeat
    const savedShuffle = localStorage.getItem('saved_shuffle') === 'true';
    const savedRepeat  = parseInt(localStorage.getItem('saved_repeat') || '0', 10);

    if (window.player) {
      window.player.shuffle = savedShuffle;
      window.player.repeat  = savedRepeat;
      
      // Aggiorna visivamente la UI all'avvio
      this._updatePlayerUI({
        isPlaying: false, // Di default all'avvio è in pausa
        shuffle: savedShuffle,
        repeat: savedRepeat
      });
    }

    if (savedQueue && savedQueue.length > 0) {
      // Ripristina stato interno del player
      window.player.queue        = savedQueue;
      window.player.queueIdx     = savedIdx;
      window.player.currentTrack = savedQueue[savedIdx];
      
      this._updateNowPlaying(window.player.currentTrack);
      this._renderQueue(savedQueue, savedIdx);
      
      // Aggiorna UI Seekbar visivamente
      const trackDur  = window.player.currentTrack.duration || 1;
      const pct       = Math.min(1, Math.max(0, savedTime / trackDur));
      const fill      = document.getElementById('seekbar-fill');
      const thumb     = document.getElementById('seekbar-thumb');
      const curTimeEl = document.getElementById('current-time');
      const fsCurTimeEl = document.getElementById('fs-current-time');
      
      if (fill)      fill.style.width   = (pct * 100) + '%';
      if (thumb)     thumb.style.left   = (pct * 100) + '%';
      if (curTimeEl) curTimeEl.textContent   = formatDur(savedTime);
      if (fsCurTimeEl) fsCurTimeEl.textContent = formatDur(savedTime);
	  
	  // FIX TESTI: Ripristina i testi della traccia ricaricata
      if (window.player.currentTrack) {
        const t = window.player.currentTrack;
        LyricsManager.load(
          t.artist?.name || t.performer?.name || '',
          t.title,
          t.album?.title || '',
          t.duration || 0
        );
      }

      // FIX LOOP INFINITO: Carica effettivamente lo stream audio
      if (window.player.currentTrack) {
        try {
          const track = window.player.currentTrack;
          const isLocal = track.is_local || String(track.id).startsWith('local_');
          let streamUrl = null;

          if (isLocal) {
            // È un file locale: recuperalo dal database permanente
            if (window.LocalDB) {
              const file = await window.LocalDB.getFile(track.id);
              if (file) {
                // Crea un nuovo link temporaneo per questa sessione
                streamUrl = URL.createObjectURL(file);
                // Salvalo nel player per poterlo ripulire in seguito ed evitare memory leak
                window.player._lastLocalUrl = streamUrl; 
              } else {
                console.warn("File locale non trovato nel database al ripristino.");
              }
            }
          } else {
            // È una traccia API: recupera URL fresco in base alla qualità
            const q = this._settings.quality;
            const data = await getStreamUrl(track.id || track.originalId, q);
            if (data && data.url) {
              streamUrl = data.url;
            }
          }
          
          if (streamUrl && window.player.audio) {
            window.player.audio.src = streamUrl;
            // Seek after the audio is seekable (currentTime set before loadedmetadata is ignored)
            this._pendingRestoreTime = savedTime;
            window.player.audio.addEventListener('loadedmetadata', () => {
              if (this._pendingRestoreTime !== null) {
                window.player.audio.currentTime = this._pendingRestoreTime;
                this._pendingRestoreTime = null;
              }
            }, { once: true });
            // Nota: Non invochiamo .play() automaticamente per evitare blocchi del browser,
            // ma ora il player è pronto ("Loaded") e non girerà a vuoto.
          }
        } catch (e) {
          console.error("Errore ripristino stream audio:", e);
        }
      }

    }

    
    const lastView = localStorage.getItem('last_view') || 'home';
    const lastData = localStorage.getItem('last_view_data') || null;
    await this.navigate(lastView, lastData !== 'null' ? lastData : null, false);
    
    await this._loadSidebarPlaylists();
  
  }

    doLogin() {
      const id = document.getElementById('login-app-id').value.trim();
      const secret = document.getElementById('login-app-secret').value.trim();
      const token = document.getElementById('login-user-token').value.trim();
      
      if (!id || !secret || !token) {
        toast('All fields are mandatory', 'error');
        return;
      }
      
      setCredentials(id, secret, token);
      document.getElementById('login-overlay').style.display = 'none';
      this.init(); // Fa ripartire l'app ora che ha i token
      toast('Login successful', 'success');
    }

    doLogout() {
      clearCredentials();
      location.reload(); // Ricarica la pagina per resettare gli stati e mostrare il login
    }

  // ── SETTINGS ────────────────────────────────────────────────
  _loadSettings() {
    const defaults = {
      quality: '27',
      //crossfade: false,
      //gapless: true,
      //autoplay: false,
      showTrackNumbers: true,
      explicitContent: true,
      notifications: true,
      animationsEnabled: true,
      animatedCovers: true,
      downloadPath: '~/Downloads',
      downloadQuality: '27',
      scrobble: false,
      theme: 'dark',
      dynamicColor: false,
	    discordRPC: true, //Discord function
    };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('settings') || '{}') };
    } catch { return defaults; }
  }

  _saveSettings() {
    localStorage.setItem('settings', JSON.stringify(this._settings));
  }

  _applySettings() {
    if (this._lastAppliedQuality !== this._settings.quality) {
      player.setQuality(this._settings.quality);
      this._lastAppliedQuality = this._settings.quality;
    }
    
    /*player.gapless   = !!this._settings.gapless;
    player.crossfade  = !!this._settings.crossfade;
    player.autoplay   = !!this._settings.autoplay;
    player.normalize  = !!this._settings.normalize;*/

    document.body.classList.toggle('hide-explicit',       !this._settings.explicitContent);
    document.body.classList.toggle('hide-track-nums',     !this._settings.showTrackNumbers);
    document.body.classList.toggle('disable-animations',  !this._settings.animationsEnabled);

    // FIX: Applica o rimuovi il Dynamic Color in tempo reale quando usi il toggle nelle impostazioni
    if (!this._settings.dynamicColor) {
      this._resetDynamicColor(); // Se lo spegni, resetta tutto istantaneamente
    } else {
      // Se lo riaccendi e c'è già una canzone in play, ri-calcola il colore subito
      if (window.player && window.player.currentTrack) {
        const cover = coverUrl(window.player.currentTrack.album?.image?.large || window.player.currentTrack.album?.cover);
        if (cover) this._extractColor(cover);
      }
    }

    document.querySelectorAll('.quality-btn-settings').forEach(b => {
      b.classList.toggle('active', b.dataset.q === String(this._settings.quality));
    });
    document.querySelectorAll('.quality-btn-dl').forEach(b => {
      b.classList.toggle('active', b.dataset.q === String(this._settings.downloadQuality));
    });

    const drop = document.getElementById('quality-picker-label');
    if (drop) {
      const labels = { '5': 'MP3', '6': 'LOSSLESS', '7': '24BIT', '27': 'HI-RES' };
      drop.textContent = labels[this._settings.quality] || 'HI-RES';
    }

    document.querySelectorAll('.settings-toggle').forEach(t => {
      const key = t.dataset.key;
      if (key in this._settings) t.classList.toggle('on', !!this._settings[key]);
    });

    if (window.player && window.player.currentTrack) {
      this._updateNowPlaying(window.player.currentTrack);
    }
	
	//Discord function
	if (window.electronAPI && typeof window.electronAPI.setDiscordRPC === 'function') {
      window.electronAPI.setDiscordRPC(!!this._settings.discordRPC);
    }
	
	
  }

  setSetting(key, value) {
    this._settings[key] = value;
    this._saveSettings();
    this._applySettings();
  }

  toggleSetting(key) {
    this._settings[key] = !this._settings[key];
    this._saveSettings();
    this._applySettings();
  }

  setQuality(q) {
    this.setSetting('quality', String(q));
  }

  _updateQualityBadge() {
    const labels = { '5': 'MP3', '6': 'LOSSLESS', '7': '24BIT', '27': 'HI-RES' };
    const badge  = labels[this._settings.quality] || '24BIT';
    document.querySelectorAll('.quality-indicator').forEach(el => el.textContent = badge);
  }

  // ── NAVIGATION ──────────────────────────────────────────────
  async navigate(view, data, pushHistory = true, restoreScroll = 0) {

    //reset the color
    this._resetDynamicColor();

    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();

    if (pushHistory && view !== this.currentView) {
      // --- SALVA LO SCROLL ---
      let currentScroll = 0;
      const currentViewEl = document.getElementById('view-' + this.currentView);
      const contentEl = document.getElementById('content');
      
      if (contentEl && contentEl.scrollTop > 0) {
          currentScroll = contentEl.scrollTop;
      } else if (currentViewEl) {
          currentScroll = currentViewEl.scrollTop;
      }

      this.history.push({ view: this.currentView, data: this._currentData, scroll: currentScroll });
      // -----------------------
      
      this.forwardHistory = [];
    }

    this.currentView  = view;
    this._currentData = data;

    const lyricsBtn = document.getElementById('player-lyrics-btn');
    if (lyricsBtn) lyricsBtn.classList.toggle('active', view === 'lyrics');

    localStorage.setItem('last_view',      view);
    localStorage.setItem('last_view_data', data || 'null');

    if (view !== 'search') {
      const searchInput = document.getElementById('titlebar-search');
      if (searchInput) searchInput.value = '';
      this._searchQuery = '';
      
      // AGGIUNTA: Nasconde il tasto X se non siamo nella vista ricerca
      const closeBtn = document.getElementById('close-search-btn');
      if (closeBtn) closeBtn.style.display = 'none';
    }

    // Update active state in sidebar using the helper function
    this._updateSidebarActiveState();

    // Update active state in sidebar using the helper function
    this._updateSidebarActiveState();

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById('view-' + view);
    if (viewEl) {
      viewEl.classList.add('active');
      //viewEl.scrollTop = 0;
	  
    //fix scrollbar in Album
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;
    //
    
    if (this._settings.animationsEnabled) fadeIn(viewEl);
    }

    const btnBack = document.getElementById('btn-back');
    if (btnBack) btnBack.disabled = this.history.length === 0;
    
    const btnFwd = document.getElementById('btn-forward');
    if (btnFwd) btnFwd.disabled = this.forwardHistory.length === 0;

    switch (view) {
      case 'home':         await this._loadHome();          break;
      case 'featured':     await this._loadFeatured();      break;
      case 'new-releases': await this._loadNewReleases();   break;
      case 'most-streamed': await this._loadMostStreamed(); break;
      case 'user-expire':   await this._loadUserInfo();     break; 
      case 'search':       this._renderSearchView();        break;
      case 'album':        await this._loadAlbum(data);     break;
      case 'artist':       await this._loadArtist(data);    break;
      case 'playlist':     await this._loadPlaylist(data);  break;
      case 'fav-tracks':   await this._loadFavTracks();     break;
      case 'fav-albums':   await this._loadFavAlbums();     break;
      case 'fav-artists':  await this._loadFavArtists();    break;
      case 'playlists':    await this._loadPlaylists();     break;
      case 'settings':     this._renderSettings();          break;
    }

    // --- RIPRISTINA LO SCROLL SE TORNI INDIETRO ---
    if (!pushHistory && restoreScroll > 0) {
      // Un piccolo timeout serve per dare il tempo al browser di stampare 
      // a schermo il nuovo HTML generato dallo switch qui sopra
      setTimeout(() => {
        const viewEl = document.getElementById('view-' + view);
        const contentEl = document.getElementById('content');
        
        // Controlla quale contenitore si occupa effettivamente dello scroll
        if (contentEl && contentEl.scrollHeight > contentEl.clientHeight) {
            contentEl.scrollTop = restoreScroll;
        } else if (viewEl) {
            viewEl.scrollTop = restoreScroll;
        }
      }, 5); 
    }

  }

  // Helper per mantenere attivo l'elemento corretto nella sidebar
  _updateSidebarActiveState() {
    const view = this.currentView;
    const data = this._currentData;
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.dataset.view === 'playlist') {
        const onclickAttr = n.getAttribute('onclick') || '';
        const matchesData = data && onclickAttr.includes(`'${data}'`);
        n.classList.toggle('active', view === 'playlist' && matchesData);
      } else {
        n.classList.toggle('active', n.dataset.view === view);
      }
    });
  }

  goBack() {
    if (!this.history.length) return;
    
    // Salva lo scroll attuale casomai volessimo fare "Avanti"
    let currentScroll = 0;
    const currentViewEl = document.getElementById('view-' + this.currentView);
    const contentEl = document.getElementById('content');
    if (contentEl && contentEl.scrollTop > 0) currentScroll = contentEl.scrollTop;
    else if (currentViewEl) currentScroll = currentViewEl.scrollTop;

    this.forwardHistory.push({ view: this.currentView, data: this._currentData, scroll: currentScroll });
    
    const prev = this.history.pop();
    // Passa lo scroll salvato a navigate (aggiungiamo il 4° parametro)
    this.navigate(prev.view, prev.data, false, prev.scroll || 0);
  }

  goForward() {
    if (!this.forwardHistory.length) return;
    
    // 1. Salva lo scroll attuale nella cronologia "indietro", casomai l'utente 
    // volesse tornare di nuovo indietro dopo essere andato avanti
    let currentScroll = 0;
    const currentViewEl = document.getElementById('view-' + this.currentView);
    const contentEl = document.getElementById('content');
    if (contentEl && contentEl.scrollTop > 0) currentScroll = contentEl.scrollTop;
    else if (currentViewEl) currentScroll = currentViewEl.scrollTop;

    this.history.push({ view: this.currentView, data: this._currentData, scroll: currentScroll });
    
    // 2. Recupera la vista successiva (che avevamo salvato premendo 'goBack')
    const next = this.forwardHistory.pop();
    
    // 3. Naviga verso la vista successiva, passando lo scroll salvato!
    this.navigate(next.view, next.data, false, 0);
  }


  toggleLyricsView() {
    if (this.currentView === 'lyrics') {
      // Se non c'è cronologia (es. hai appena aggiornato la pagina con Ctrl+R)
      if (this.history.length === 0) {
        this.navigate('home'); // Torna alla home come fallback
      } else {
        this.goBack(); // Altrimenti torna indietro normalmente
      }
    } else {
      // Altrimenti naviga verso i testi
      this.navigate('lyrics');
      
      // Forza lo scorrimento alla riga attiva quando si apre la visuale
      setTimeout(() => {
        const stdContainer = document.getElementById('standard-lyrics-container');
        if (stdContainer) {
          const activeLine = stdContainer.querySelector('.lyric-line.active');
          if (activeLine) activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }

  // FIX SIDEBAR: Salva lo stato in localStorage
  toggleSidebar() {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    localStorage.setItem('sidebar_collapsed', sb.classList.contains('collapsed'));
  }

  // ── HOME ────────────────────────────────────────────────────
  async _loadHome() {
    const sig   = this._abortController.signal;
    const nrEl  = document.getElementById('home-nr');
    const epEl  = document.getElementById('home-ep');
    const msEl  = document.getElementById('home-ms');
    const heroEl = document.getElementById('home-hero');

    nrEl.innerHTML = `<div class="grid">${skeletonGrid(6)}</div>`;
    epEl.innerHTML = `<div class="grid">${skeletonGrid(6)}</div>`;
    msEl.innerHTML = `<div class="grid">${skeletonGrid(4)}</div>`;

    try {
      const [nr, ep, ms] = await Promise.all([
        getFeatured('new-releases-full', 12, null, sig),
        getFeatured('editor-picks',      12, null, sig),
        getFeatured('most-streamed',      6, null, sig),
      ]);

      if (nr.length) {
        const hero = nr[0];
        const bg   = coverUrl(hero.image?.large);
        heroEl.innerHTML = `
          <div class="featured-hero" onclick="window.app.navigate('album','${hero.id}')">
            <div class="featured-hero-bg" style="background-image:url('${bg}')"></div>
            <div class="featured-hero-grain"></div>
            <div class="featured-hero-grad"></div>
            <div class="featured-hero-content">
              <div class="featured-tag">New Release</div>
              <div class="featured-title">${escHtml(hero.title)}</div>
              <div class="featured-sub">${escHtml(hero.artist?.name || '')}</div>
              <div class="featured-actions">
                <button class="btn-play-hero" onclick="event.stopPropagation();window.app.playAlbum('${hero.id}')">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"/></svg>
                  Play
                </button>
              </div>
            </div>
          </div>`;
        fadeIn(heroEl.firstElementChild);
      }

      nrEl.innerHTML = `<div class="grid">${nr.slice(1, 7).map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
      epEl.innerHTML = `<div class="grid">${ep.slice(0, 6).map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
      msEl.innerHTML = `<div class="grid">${ms.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;

      staggerFadeIn(nrEl);
      staggerFadeIn(epEl, '.card', 60);
      staggerFadeIn(msEl, '.card', 120);
    } catch (e) {
      if (e.name !== 'AbortError') {
        nrEl.innerHTML = '<div class="empty-state"><p>Could not reach the API. Check your connection settings.</p></div>';
        console.error(e);
      }
    }
  }

  // ── FEATURED ────────────────────────────────────────────────
  async _loadFeatured() {
    const sig = this._abortController.signal;
    const sections = [
      { id: 'feat-editor',      type: 'editor-picks',       label: "Editor's Picks" },
      { id: 'feat-bestsellers', type: 'best-sellers',        label: 'Best Sellers'   },
      //{ id: 'feat-press',       type: 'press-awards-full',   label: 'Press Awards'   },
      //{ id: 'feat-streamed',    type: 'most-streamed',       label: 'Most Streamed'  },
    ];
    sections.forEach(s => {
      document.getElementById(s.id).innerHTML = `<div class="grid">${skeletonGrid(4)}</div>`;
    });
    for (const s of sections) {
      try {
        const items = await getFeatured(s.type, 12, null, sig);
        const el    = document.getElementById(s.id);
        el.innerHTML = `<div class="grid">${items.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
        staggerFadeIn(el);
      } catch(e) { if (e.name !== 'AbortError') console.error(e); }
    }
  }

  // ── MOST STREAMED ────────────────────────────────────────────

  async _loadMostStreamed() {
    const sig = this._abortController.signal;
    const el  = document.getElementById('most-streamed-grid');
    el.innerHTML = `<div class="grid">${skeletonGrid(12)}</div>`;
    try {
      const items = await getFeatured('most-streamed', 20, null, sig);
      el.innerHTML = `<div class="grid">${items.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
      staggerFadeIn(el);
    } catch(e) {
      if (e.name !== 'AbortError')
        el.innerHTML = '<div class="empty-state"><p>Error loading</p></div>';
    }
  }
  

  // ── USER INFO ────────────────────────────────────────────

  async _loadUserInfo() {
    const sig = this._abortController.signal;
    const el = document.getElementById('user-expire');

    if (!el) {
      console.error('Element #user-expire not found');
      return;
    }

    el.innerHTML = `<div class="grid">${skeletonGrid(1)}</div>`;

    try {
      const user = await getUserInfo(sig);
      console.log('USER INFO:', user);

      if (!user) {
        el.innerHTML = '<div class="empty-state"><p>Nothing user data</p></div>';
        return;
      }

      el.innerHTML = `
        <div class="user-info-card">
          <p><strong>Country:</strong> ${user.country_code ?? '-'}</p>
          <p><strong>Language:</strong> ${user.language_code ?? '-'}</p>
          <p><strong>Subscription:</strong> ${user.subscription?.offer ?? '-'}</p>
          <p><strong>Periodicity:</strong> ${user.subscription?.periodicity ?? '-'}</p>
          <p><strong>Start date:</strong> ${user.subscription?.start_date ?? '-'}</p>
          <p><strong>End date:</strong> ${user.subscription?.end_date ?? '-'}</p>
          <p><strong>Cancelled:</strong> ${user.subscription?.is_canceled ? 'Yes' : 'No'}</p>
          <p><strong>Lossy streaming</strong> ${user.credential?.parameters?.lossy_streaming ? 'Yes' : 'No'}</p>
          <p><strong>Lossless Streaming</strong> ${user.credential?.parameters?.lossless_streaming ? 'Yes' : 'No'}</p> 
          <p><strong>Hires Streaming</strong> ${user.credential?.parameters?.hires_streaming ? 'Yes' : 'No'}</p> 
        </div>
      `;

      staggerFadeIn(el);
    } catch (e) {
      console.error('Errore _loadUserInfo:', e);
      if (e.name !== 'AbortError') {
        el.innerHTML = '<div class="empty-state"><p>Error loading</p></div>';
      }
    }
  }



  // ── NEW RELEASES ────────────────────────────────────────────
  async _loadNewReleases() {
    const sig = this._abortController.signal;
    const el  = document.getElementById('new-releases-grid');
    el.innerHTML = `<div class="grid">${skeletonGrid(12)}</div>`;
    try {
      const items = await getFeatured('new-releases-full', 50, null, sig);
      el.innerHTML = `<div class="grid">${items.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
      staggerFadeIn(el);
    } catch(e) {
      if (e.name !== 'AbortError')
        el.innerHTML = '<div class="empty-state"><p>Error loading</p></div>';
    }
  }

  // ── ALBUM ────────────────────────────────────────────────────
  async _loadAlbum(albumId) {
    if (!albumId) return;
    const sig      = this._abortController.signal;
    const heroEl   = document.getElementById('album-hero-wrap');
    const tracksEl = document.getElementById('album-tracks');
    const simEl    = document.getElementById('album-similar');
    heroEl.innerHTML   = '<div class="hero-skeleton"></div>';
    tracksEl.innerHTML = skeletonList(8);

    try {
      const album = await getAlbum(albumId, sig);
      if (!album) throw new Error('Not found');

      const rawTracks = album.tracks?.items || [];
      const tracks = rawTracks.map(t => transformTrack(t, {
        title: album.title, image: album.image, id: album.id, artist: album.artist,
        version: album.version || '',
      }));
      this._currentAlbumTracks = tracks;

      heroEl.innerHTML = albumHero(album, tracks);
      fadeIn(heroEl.firstElementChild);

      // --- ANIMATED COVERS (Apple Music) ---
      if (this._settings.animatedCovers) {
        const heroSection = heroEl.querySelector('.hero-section');
        const heroArtEl   = heroEl.querySelector('.hero-art');
        
        if (heroSection && heroArtEl) {
          heroArtEl.style.position = 'relative';
          
          if (!heroEl.querySelector('#hero-video-art')) {
            heroArtEl.insertAdjacentHTML('beforeend', `<video id="hero-video-art" autoplay loop muted playsinline crossorigin="anonymous" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; opacity:0; pointer-events:none; z-index: 2;"></video>`);
          }
          
          const staticBg = heroSection.querySelector('.hero-bg');
          const staticBgEnhanced = heroSection.querySelector('.hero-bg-enhanced');
          
          /*if (staticBg && !heroSection.querySelector('#hero-video-bg')) {
            staticBg.insertAdjacentHTML('afterend', `<video id="hero-video-bg" autoplay loop muted playsinline crossorigin="anonymous" style="position:absolute; inset:-10px; width:calc(100% + 20px); height:calc(100% + 20px); object-fit:cover; filter:none; opacity:0; pointer-events:none; z-index:0;"></video>`);
          }*/
          
          const videoArt = heroEl.querySelector('#hero-video-art');
          const videoBg  = heroEl.querySelector('#hero-video-bg');

          /*coverVideoManager.play(videoArt, album, 'square', () => {
             if (staticBg) staticBg.style.opacity = '0';
             if (staticBgEnhanced) staticBgEnhanced.style.opacity = '0';
          });*/

          // Fa partire solo il video quadrato, lasciando intatto lo sfondo statico!
          coverVideoManager.play(videoArt, album, 'square');
          
          if (videoBg) {
             coverVideoManager.play(videoBg, album, 'square');
          }
        }
      } else {
        // Ferma le riproduzioni pendenti se disattivato
        if(heroEl.querySelector('#hero-video-art')) coverVideoManager.stop(heroEl.querySelector('#hero-video-art'));
        if(heroEl.querySelector('#hero-video-bg')) coverVideoManager.stop(heroEl.querySelector('#hero-video-bg'));
      }

      // Render by disc
      const byDisc = {};
      tracks.forEach(t => {
        const d = t.volumeNumber || 1;
        if (!byDisc[d]) byDisc[d] = [];
        byDisc[d].push(t);
      });

      const discs = Object.keys(byDisc).sort();
      tracksEl.innerHTML = discs.map(d => `
        ${discs.length > 1 ? `<div class="disc-label">Disc ${d}</div>` : ''}
        ${byDisc[d].map((t) => trackRow(t, this._getAbsoluteIdx(tracks, t.id), {
          isPlaying: player.currentTrack?.id === t.id,
          queueRef:  'window.app._currentAlbumTracks',
          onPlay:    `window.app.playFromList(window.app._currentAlbumTracks, ${tracks.indexOf(t)})`,
        })).join('')}
      `).join('');

      staggerFadeIn(tracksEl, '.track-row');

      // Dynamic color dalla copertina dell'album
      if (this._settings.dynamicColor) {
        const albumCover = coverUrl(album.image?.large);
        if (albumCover) this._extractColor(albumCover);
      }
	  

    } catch(e) {
      if (e.name !== 'AbortError') {
        heroEl.innerHTML = '<div style="padding:32px;color:var(--text2);">Error loading album</div>';
        console.error(e);
      }
    }
  }

  

  _getAbsoluteIdx(tracks, id) {
    return tracks.findIndex(t => t.id === id);
  }

  // ── FIX IMMAGINI ARTISTI NELLE CARD ────────────────────────
  _fetchMissingArtistImages(container, searchedName = null) {
    if (!container) return;
    
    // Cerca tutte le card all'interno del contenitore
    const cards = container.querySelectorAll('.card');
    
    cards.forEach(card => {
      const art = card.querySelector('.card-art');
      const placeholder = card.querySelector('.card-placeholder');
      const titleEl = card.querySelector('.card-title');
      
      if (art && placeholder && titleEl) {
        const artistName = titleEl.textContent.trim();
        
        // Se stiamo filtrando per ricerca, salta la card se il nome non è identico
        if (searchedName && artistName.toLowerCase() !== searchedName.toLowerCase()) {
          return;
        }
        
        getAppleArtistImage(artistName).then(imgUrl => {
          if (imgUrl) {
            // Rimuove la nota musicale
            placeholder.remove();
            
            // Inserisce l'immagine
            art.insertAdjacentHTML('afterbegin', `<img src="${imgUrl}" alt="${escHtml(artistName)}" onerror="this.outerHTML='<div class=&quot;card-placeholder&quot;>♪</div>'" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.4s, transform 0.35s cubic-bezier(.4,0,.2,1);">`);
            
            // Trigger animazione CSS
            setTimeout(() => {
              const img = art.querySelector('img');
              if (img) img.style.opacity = '1';
            }, 50);
          }
        });
      }
    });
  }

  // ── ARTIST ───────────────────────────────────────────────────
  async _loadArtist(artistId) {
    if (!artistId) return;

    this._expandedArtistSections = this._expandedArtistSections || {};
    if (this._currentArtistId !== artistId) {
      this._expandedArtistSections = {};
      this._currentArtistId = artistId;
    }

    const sig       = this._abortController.signal;
    const heroEl    = document.getElementById('artist-hero-wrap');
    const topEl     = document.getElementById('artist-top-tracks');
    const albumsEl  = document.getElementById('artist-albums');
    const epsEl     = document.getElementById('artist-eps');
    const singlesEl = document.getElementById('artist-singles');
    const simEl     = document.getElementById('artist-similar');

    heroEl.innerHTML = '<div class="artist-hero-skeleton"></div>';
    topEl.innerHTML  = skeletonList(5);

    try {
      const raw = await getArtist(artistId, sig);
      if (!raw) throw new Error('Artist not found');

      const artist = raw.artist || raw;
      heroEl.innerHTML = artistHero(artist);
      fadeIn(heroEl.firstElementChild);

      // --- RECUPERO AVATAR E SFONDO MANCANTI DA APPLE MUSIC ---
      const avatarContainer = heroEl.querySelector('.artist-avatar');
      
      if (avatarContainer && !avatarContainer.querySelector('img')) {
        getAppleArtistImage(artist.name).then(imgUrl => {
          if (imgUrl) {
            
            // Inserisce l'avatar con fallback e transizione combinata
            avatarContainer.innerHTML = `<img src="${imgUrl}" alt="${escHtml(artist.name)}", draggable=false onerror="this.outerHTML='<div class=&quot;artist-avatar-placeholder&quot;>♪</div>'" style="width: 100%; height: 100%; object-fit: cover; object-position: center; opacity: 0; transition: opacity 0.5s, transform 0.35s ease;">`;
            
            
            
            // 2. Imposta l'immagine come background dell'Hero (se non c'è il video, si vedrà questa)
            const heroBg = heroEl.querySelector('.artist-hero-bg') || heroEl.querySelector('.hero-bg');
            if (heroBg) {
              heroBg.style.backgroundImage = `url('${imgUrl}')`;
            }

            // Trigger animazione
            setTimeout(() => {
              const newImg = avatarContainer.querySelector('img');
              if(newImg) newImg.style.opacity = '1';
            }, 50);
          }
        });
      }

      // --- ANIMATED BACKGROUND ARTIST (Posizionamento sovrapposto) ---
      if (this._settings.animatedCovers) {
        const heroSection = heroEl.firstElementChild; 
        const bgTarget = heroEl.querySelector('.hero-bg') || heroEl.querySelector('.artist-hero-bg') || heroSection;

        if (bgTarget && !heroEl.querySelector('#artist-video-bg')) {
          if (bgTarget.parentElement) {
            // Il contenitore deve essere relativo per ospitare il video assoluto
            bgTarget.parentElement.style.position = 'relative';
            // Lasciamo che l'altezza sia determinata dal video o dal contenuto
            bgTarget.parentElement.style.height = 'auto'; 
            bgTarget.parentElement.style.minHeight = '500px'; // Altezza minima dell'intestazione //da modificare per adattare il video
          }

          // Inseriamo il video con posizionamento assoluto per stare "sotto" i testi
          bgTarget.insertAdjacentHTML('afterend', `
            <video id="artist-video-bg" 
                  autoplay loop muted playsinline 
                  crossorigin="anonymous" 
                  style="position: absolute; top: 0; left: 0; width: 100%; height: auto; object-fit: cover; opacity: 0; pointer-events: none; z-index: 0;">
            </video>`);
        }

        const videoBg = heroEl.querySelector('#artist-video-bg');
        if (videoBg) {
          videoBg.addEventListener('loadedmetadata', () => {
            videoBg.style.opacity = '1';
            if (bgTarget) bgTarget.style.display = 'none'; 
          });

          coverVideoManager.playArtistVideo(videoBg, artist.name);
        }
      }

      // Top tracks
      const topTracksRaw = raw.top_tracks || [];
      if (topTracksRaw.length) {
        const topTracks = topTracksRaw.map(t => transformTrack(t));
        this._currentArtistTracks = topTracks;
        topEl.innerHTML = topTracks.slice(0, 10).map((t, i) =>
          trackRow(t, i, {
            showAlbum:  true,
            showCover:  true,
            isPlaying:  player.currentTrack?.id === t.id,
            onPlay:     `window.app.playFromList(window.app._currentArtistTracks, ${i})`,
          })
        ).join('');
        staggerFadeIn(topEl, '.track-row');
        document.getElementById('artist-top-section').style.display = '';
      } else {
          try {
            const topTracks = await getArtistTopTracks(artistId, 10, 0, sig);
            if (topTracks.length) {
              this._currentArtistTracks = topTracks;
              topEl.innerHTML = topTracks.slice(0, 10).map((t, i) =>
                trackRow(t, i, {
                  showAlbum: true, showCover: true,
                  isPlaying: player.currentTrack?.id === t.id,
                  onPlay:    `window.app.playFromList(window.app._currentArtistTracks, ${i})`,
                })
              ).join('');
              staggerFadeIn(topEl, '.track-row');
              document.getElementById('artist-top-section').style.display = '';
            } else {
              document.getElementById('artist-top-section').style.display = 'none';
            }
          } catch {
            document.getElementById('artist-top-section').style.display = 'none';
          }
        }

      let allReleases = [];
      if (Array.isArray(raw.releases)) {
        raw.releases.forEach(r => allReleases.push(...(r.items || [])));
      } else if (raw.albums?.items) {
        allReleases = raw.albums.items;
      }

      
      allReleases = sortByDate(allReleases);

      const { albums, eps, singles } = partitionReleases(allReleases);
      this._currentArtistAlbums      = albums;
      this._currentArtistEps         = eps;
      this._currentArtistSingles     = singles;
      this._currentArtistAppearances = sortByDate(raw.appearances || []);

      this._renderArtistSection(albumsEl,  'artist-albums-section',  albums,  'albums', this._expandedArtistSections['albums']);
      this._renderArtistSection(epsEl,     'artist-eps-section',     eps,     'eps',    this._expandedArtistSections['eps']);
      this._renderArtistSection(singlesEl, 'artist-singles-section', singles, 'singles',this._expandedArtistSections['singles']);

      const appEl = document.getElementById('artist-appearances');
      this._renderArtistSection(appEl, 'artist-appearances-section', this._currentArtistAppearances, 'appearances');

      //this._loadSimilarArtists(String(artist.id), simEl, sig);

    } catch(e) {
      if (e.name !== 'AbortError') {
        heroEl.innerHTML = '<div style="padding:32px;color:var(--text2);">Error loading artist</div>';
        console.error(e);
      }
    }
  }

  _renderArtistSection(el, sectionId, items, typeKey, expanded = false) {
    const section = document.getElementById(sectionId);
    if (!items || !items.length) {
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = '';

    const limit   = 6;
    const hasMore = items.length > limit;
    const displayed = (!expanded && hasMore) ? items.slice(0, limit) : items;

    let html = `<div class="grid">${displayed.map(a =>
      albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)
    ).join('')}</div>`;

    if (hasMore) {
      const label = typeKey === 'eps' ? 'EPs' : typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
      if (!expanded) {
        html += `
          <div style="display:flex; justify-content:center; margin-top:24px; margin-bottom:12px; width:100%;">
            <button class="btn btn-ghost" style="border-radius:24px; padding:10px 24px; border:1px solid var(--border);"
                    onclick="window.app.toggleArtistSection('${el.id}', '${sectionId}', '${typeKey}', true)">
              See all ${items.length} ${label} ↓
            </button>
          </div>`;
      } else {
        html += `
          <div style="display:flex; justify-content:center; margin-top:24px; margin-bottom:12px; width:100%;">
            <button class="btn btn-ghost" style="border-radius:24px; padding:10px 24px; border:1px solid var(--border);"
                    onclick="window.app.toggleArtistSection('${el.id}', '${sectionId}', '${typeKey}', false)">
              Show less ↑
            </button>
          </div>`;
      }
    }

    el.innerHTML = html;
    staggerFadeIn(el);
  }

  toggleArtistSection(containerId, sectionId, typeKey, expand) {

    this._expandedArtistSections = this._expandedArtistSections || {};
    this._expandedArtistSections[typeKey] = expand;

    const el = document.getElementById(containerId);
    let items = [];
    if (typeKey === 'albums')      items = this._currentArtistAlbums;
    if (typeKey === 'eps')         items = this._currentArtistEps;
    if (typeKey === 'singles')     items = this._currentArtistSingles;
    if (typeKey === 'appearances') items = this._currentArtistAppearances;
    
    if (el && items && items.length > 0) {
      this._renderArtistSection(el, sectionId, items, typeKey, expand);
      if (!expand) {
        const sectionEl = document.getElementById(sectionId);
        setTimeout(() => {
          if (sectionEl) sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      }
    }
  }

  

  playArtistTop() {
    if (this._currentArtistTracks.length) this.playFromList(this._currentArtistTracks, 0);
  }

  // ── PLAYLIST ─────────────────────────────────────────────────
  async _loadPlaylist(playlistId) {
    if (!playlistId) return;
    const sig      = this._abortController.signal;
    const heroEl   = document.getElementById('playlist-hero-wrap');
    const tracksEl = document.getElementById('playlist-tracks');
    heroEl.innerHTML   = '<div class="hero-skeleton"></div>';
    tracksEl.innerHTML = skeletonList(8);

    try {
      let pl, tracks;

      if (String(playlistId).startsWith('local_')) {
        const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
        pl = localPls.find(p => p.id === playlistId);
        if (!pl) throw new Error('Local playlist not found');
        tracks = pl.tracks || [];
      } else {
        pl     = await getPlaylist(playlistId, sig);
        if (!pl) throw new Error('Not found');
        tracks = (pl.tracks?.items || []).map(t => transformTrack(t));
      }

      this._currentPlaylistTracks = tracks;

      const img = coverUrl(pl.images?.[0]?.url || pl.image?.large);
      const isLocalPl = String(playlistId).startsWith('local_library');
      heroEl.innerHTML = `
        <div class="hero-section" style="--hero-img:url('${img || ''}')">
          <div class="hero-bg"></div>
          <div class="hero-overlay"></div>
          <div class="hero-content">
            <div class="hero-art" style="display:flex;align-items:center;justify-content:center;background:var(--bg2);font-size:56px;color:var(--text3);">
              ${img ? `<img src="${img}" alt="">` : '☰'}
            </div>
            <div class="hero-info">
              <div class="hero-type-label">PLAYLIST</div>
              <h1 class="hero-title">${escHtml(pl.name || 'Playlist')}</h1>
              <div class="hero-meta">
                <span>${tracks.length} tracks</span>
                ${pl.owner?.name ? `<span class="hero-dot">·</span><span>${escHtml(pl.owner.name)}</span>` : ''}
              </div>
              <div class="hero-actions">
                <button class="btn-play-hero" onclick="window.app.playFromList(window.app._currentPlaylistTracks, 0)">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>
                  Play
                </button>
                <button class="btn-shuffle-hero" onclick="window.app.shufflePlaylist()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                    <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                  </svg>
                  Shuffle
                </button>
                ${!isLocalPl ? `
                <button class="btn-ghost" style="border-radius: 24px; padding: 9px 18px;" onclick="window.app.downloadPlaylistUI('${pl.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Download
                </button> `:''}
                ${String(playlistId).startsWith('local_') ? `
                <button class="btn-ghost" style="border-radius:24px;padding:9px 18px;color:#e74c3c;border-color:#e74c3c;" onclick="window.app.deleteLocalPlaylist('${pl.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                  Delete
                </button>` : ''}
              </div>
            </div>
          </div>
        </div>`;
      fadeIn(heroEl.firstElementChild);

      tracksEl.innerHTML = tracks.map((t, i) =>
        trackRow(t, i, {
          showAlbum: true, showCover: true,
          isPlaying: player.currentTrack?.id === t.id,
          onPlay:    `window.app.playFromList(window.app._currentPlaylistTracks, ${i})`,
        })
      ).join('');
      staggerFadeIn(tracksEl, '.track-row');

    } catch(e) {
      if (e.name !== 'AbortError') {
        heroEl.innerHTML = '<div style="padding:32px;color:var(--text2);">Error loading playlist</div>';
        console.error(e);
      }
    }
  }

  shufflePlaylist() {
    if (!this._currentPlaylistTracks.length) return;
    const shuffled = [...this._currentPlaylistTracks].sort(() => Math.random() - .5);
    player.setQueue(shuffled, 0);
    toast('Playing shuffled playlist');
  }

  // ── FAVORITES ────────────────────────────────────────────────
  async _loadFavTracks() {
    const el = document.getElementById('fav-tracks-list');
    el.innerHTML = skeletonList(10);
    try {
      const items  = await getFavoriteTracks(200, this._abortController.signal);
      const tracks = items.map(t => transformTrack(t));
      this._currentFavTracks = tracks;
      el.innerHTML = tracks.length
        ? tracks.map((t, i) => trackRow(t, i, {
            showAlbum: true, showCover: true,
            isPlaying: player.currentTrack?.id === t.id,
            onPlay:    `window.app.playFromList(window.app._currentFavTracks, ${i})`,
          })).join('')
        : '<div class="empty-state"><p>No liked songs yet</p></div>';
      staggerFadeIn(el, '.track-row');
    } catch(e) {
      if (e.name !== 'AbortError') el.innerHTML = '<div class="empty-state"><p>Error</p></div>';
    }
  }

  async _loadFavAlbums() {
    const el = document.getElementById('fav-albums-grid');
    el.innerHTML = `<div class="grid">${skeletonGrid(8)}</div>`;
    try {
      const items = await getFavoriteAlbums(100, this._abortController.signal);
      el.innerHTML = items.length
        ? `<div class="grid">${items.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`
        : '<div class="empty-state"><p>No saved albums</p></div>';
      staggerFadeIn(el);
    } catch(e) {
      if (e.name !== 'AbortError') el.innerHTML = '<div class="empty-state"><p>Error</p></div>';
    }
  }

  async _loadFavArtists() {
    const el = document.getElementById('fav-artists-grid');
    el.innerHTML = `<div class="grid">${skeletonGrid(8)}</div>`;
    try {
      const items = await getFavoriteArtists(100, this._abortController.signal);
      el.innerHTML = items.length
        ? `<div class="grid">${items.map(a => artistCard(a, `window.app.navigate('artist','${a.id}')`)).join('')}</div>`
        : '<div class="empty-state"><p>No followed artists</p></div>';
      staggerFadeIn(el);

      this._fetchMissingArtistImages(el);

    } catch(e) {
      if (e.name !== 'AbortError') el.innerHTML = '<div class="empty-state"><p>Error</p></div>';
    }
  }

  // ── PLAYLISTS ────────────────────────────────────────────────
  async _loadPlaylists() {
    const el = document.getElementById('playlists-grid');
    el.innerHTML = `<div class="grid">${skeletonGrid(8)}</div>`;
    try {
      const items   = await getUserPlaylists(100, this._abortController.signal);
      this._playlists = items;
      el.innerHTML = items.length
        ? `<div class="grid">${items.map(pl => `
            <div class="card" onclick="window.app.navigate('playlist','${pl.id}')">
              <div class="card-art" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--bg2),var(--bg3));font-size:36px;color:var(--text3);">
                ☰
                <button class="card-play-btn" onclick="event.stopPropagation();window.app.playPlaylist('${pl.id}')">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>
                </button>
              </div>
              <div class="card-title">${escHtml(pl.name)}</div>
              <div class="card-sub">${pl.tracks_count || 0} tracks</div>
            </div>`).join('')}</div>`
        : '<div class="empty-state"><p>No playlists found</p></div>';
      staggerFadeIn(el);
    } catch(e) {
      if (e.name !== 'AbortError') el.innerHTML = '<div class="empty-state"><p>Error</p></div>';
    }
  }

  async _loadSidebarPlaylists() {
    const el = document.getElementById('sidebar-playlists');
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');

    let html = `
      <div class="nav-item" onclick="window.app.createLocalPlaylistEmpty()"
          data-no-close
          style="color:var(--text3); font-size:12px; gap:8px;">
        <span style="font-size:16px; line-height:1;">+</span>
        <span>New Playlist</span>
      </div>`;

    localPls.forEach(pl => {
      html += `<div class="nav-item" data-view="playlist" onclick="window.app.navigate('playlist','${pl.id}')">
        <span class="playlist-dot" style="background:var(--gold)"></span>
        <span>${escHtml(pl.name)}</span>
      </div>`;
    });

    el.innerHTML = html;
    // Ricalcola lo stato attivo qui perché l'HTML è stato sostituito
    this._updateSidebarActiveState();

    try {
      const qobuzPls = await getUserPlaylists(30);
      qobuzPls.forEach(pl => {
        html += `<div class="nav-item" data-view="playlist" onclick="window.app.navigate('playlist','${pl.id}')">
          <span class="playlist-dot" style="background:hsl(${(parseInt(pl.id, 10) % 360) || 0},40%,55%)"></span>
          <span>${escHtml(pl.name)}</span>
        </div>`;
      });
      el.innerHTML = html;
      // Ricalcola ancora lo stato attivo per le playlist caricate asincronamente
      this._updateSidebarActiveState();
    } catch {}
  }

  // Crea playlist vuota direttamente dalla sidebar
  createLocalPlaylistEmpty() {
    modal('New Playlist',
      `<input id="new-pl-name" type="text" placeholder="Playlist name…"
        style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text1);
               padding:10px 14px;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"
        onkeydown="if(event.key==='Enter') window.app._confirmNewPlaylist()">`,
      [
        { label: 'Cancel', class: 'btn-ghost',    action: 'window.ui.removeModal()' },
        { label: 'Create', class: 'btn-primary',  action: 'window.app._confirmNewPlaylist()' },
      ]
    );
    setTimeout(() => document.getElementById('new-pl-name')?.focus(), 80);
  }

  async _confirmNewPlaylist() {
    const input = document.getElementById('new-pl-name');
    const name  = input?.value?.trim();
    if (!name) { input?.focus(); return; }
    removeModal();
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    const newPl    = { id: 'local_' + Date.now(), name, tracks: [] };
    localPls.push(newPl);
    localStorage.setItem('local_playlists', JSON.stringify(localPls));
    await this._loadSidebarPlaylists();
    await this.navigate('playlist', newPl.id);
    toast(`Playlist "${name}" created`, 'success');
  }

  async playPlaylist(id) {
    try {
      const pl     = await getPlaylist(id);
      const tracks = (pl?.tracks?.items || []).map(t => transformTrack(t));
      if (tracks.length) { player.setQueue(tracks, 0); toast(`Playing: ${pl.name}`); }
    } catch(e) { toast('Could not load playlist', 'error'); }
  }

  // ── SEARCH ───────────────────────────────────────────────────
  _renderSearchView() {
    if (!this._searchQuery) {
      this._showRecentSearches();
    }
  }

  // NUOVO METODO: Gestisce il click (focus) sulla barra
  onSearchFocus() {
    const closeBtn = document.getElementById('close-search-btn');
    if (closeBtn) closeBtn.style.display = 'block';

    if (!this._searchQuery) {
      this._showRecentSearches();
    }
  }

  // NUOVO METODO: Chiude la ricerca e torna indietro
  closeSearch() {
    const input = document.getElementById('titlebar-search');
    if (input) {
      input.value = '';
      input.blur();
    }
    this._searchQuery = '';
    
    const closeBtn = document.getElementById('close-search-btn');
    if (closeBtn) closeBtn.style.display = 'none';

    if (this.currentView === 'search') {
      // Se c'è una cronologia, torna indietro. Altrimenti (dopo un refresh) vai alla Home.
      if (this.history.length > 0) {
        this.goBack();
      } else {
        this.navigate('home');
      }
    }
  }


  onSearchInput(q) {
    this._searchQuery = q.trim();
    clearTimeout(this._searchDebounce);
    if (this._searchQuery.length < 2) {
      this._showRecentSearches();
      return;
    }
    this._searchDebounce = setTimeout(() => this._doSearch(this._searchQuery), 380);
    if (this.currentView !== 'search') this.navigate('search');
  }

  _showRecentSearches() {
    if (this.currentView !== 'search') this.navigate('search');
    const el = document.getElementById('search-results');
    if (!this._recentSearches.length) {
      el.innerHTML = '<div class="empty-state"><p>Type to start searching...</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="section-hdr"><span class="section-title">Recent Searches</span></div>
      <div>
        ${this._recentSearches.map(term => `
          <div class="recent-search-item" onclick="document.getElementById('titlebar-search').value='${term}'; window.app._doSearch('${term}')">
            <span style="display:flex; align-items:center; gap:10px;"><span style="color:var(--text3);">⌕</span> ${escHtml(term)}</span>
            <button class="btn-ghost" style="border:none; padding:4px; font-size:12px;" onclick="event.stopPropagation(); window.app.removeRecentSearch('${term}')">✕</button>
          </div>
        `).join('')}
      </div>`;
  }

  _addRecentSearch(q) {
    this._recentSearches = this._recentSearches.filter(t => t.toLowerCase() !== q.toLowerCase());
    this._recentSearches.unshift(q);
    if (this._recentSearches.length > 8) this._recentSearches.pop();
    localStorage.setItem('recent_searches', JSON.stringify(this._recentSearches));
  }

  removeRecentSearch(q) {
    this._recentSearches = this._recentSearches.filter(t => t !== q);
    localStorage.setItem('recent_searches', JSON.stringify(this._recentSearches));
    this._showRecentSearches();
  }

  async _doSearch(q) {
    if (!q) return;
    this._searchQuery = q;
    this._addRecentSearch(q);
    const el = document.getElementById('search-results');
    el.innerHTML = `<div class="grid">${skeletonGrid(6)}</div>`;

    try {
      const sig = this._abortController.signal;
      const [tracks, albums, artists] = await Promise.all([
        this._searchTab !== 'albums' && this._searchTab !== 'artists' ? searchTracks(q,  20, 0, sig) : Promise.resolve([]),
        this._searchTab !== 'tracks' && this._searchTab !== 'artists' ? searchAlbums(q,  20, 0, sig) : Promise.resolve([]),
        this._searchTab !== 'tracks' && this._searchTab !== 'albums'  ? searchArtists(q,  20, 0, sig) : Promise.resolve([]),
      ]);

      const transformedTracks = tracks.map(t => transformTrack(t));
      this._currentSearchTracks = transformedTracks;

      let html = '';
      if (artists.length && this._searchTab !== 'tracks' && this._searchTab !== 'albums') {
        html += `<div class="section-hdr"><span class="section-title">Artists</span></div>
          <div class="grid">${artists.map(a => artistCard(a, `window.app.navigate('artist','${a.id}')`)).join('')}</div>`;
      }
      if (albums.length && this._searchTab !== 'tracks' && this._searchTab !== 'artists') {
        html += `<div class="section-hdr" style="margin-top:24px;"><span class="section-title">Albums</span></div>
          <div class="grid">${albums.map(a => albumCard(a, `window.app.navigate('album','${a.id}')`, `window.app.playAlbum('${a.id}')`)).join('')}</div>`;
      }
      if (transformedTracks.length && this._searchTab !== 'albums' && this._searchTab !== 'artists') {
        html += `<div class="section-hdr" style="margin-top:24px;"><span class="section-title">Tracks</span></div>
          <div class="tracklist">${transformedTracks.map((t, i) =>
            trackRow(t, i, {
              showAlbum: true, showCover: true,
              isPlaying: player.currentTrack?.id === t.id,
              onPlay:    `window.app.playFromList(window.app._currentSearchTracks, ${i})`,
            })
          ).join('')}</div>`;
      }

      el.innerHTML = html || `<div class="empty-state"><p>No results for "${escHtml(q)}"</p></div>`;
      staggerFadeIn(el, '.card, .track-row');

      this._fetchMissingArtistImages(el,q);

    } catch(e) {
      if (e.name !== 'AbortError')
        el.innerHTML = '<div class="empty-state"><p>Search failed</p></div>';
    }
  }

  setSearchTab(tab) {
    this._searchTab = tab;
    document.querySelectorAll('.search-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    if (this._searchQuery) this._doSearch(this._searchQuery);
  }

  // ── PLAYBACK ─────────────────────────────────────────────────
  playFromList(tracks, idx) {
    if (!tracks || !tracks.length) return;
    const track = tracks[idx];
    
    // FIX BUG PLAY/PAUSE
    const currentId = player.currentTrack?.id;
    const targetId  = track?.id;

    if (currentId && targetId && String(currentId) === String(targetId)) {
      player.togglePlay();
      return;
    }
    player.setQueue(tracks, idx);
  }

  async playAlbum(albumId) {
    try {
      const album  = await getAlbum(albumId);
      const tracks = (album?.tracks?.items || []).map(t =>
        transformTrack(t, { title: album.title, image: album.image, id: album.id, artist: album.artist, version: album.version || '' })
      );
      if (tracks.length) player.setQueue(tracks, 0);
    } catch(e) { toast('Could not load album', 'error'); }
  }

  async shuffleAlbum(albumId) {
    try {
      const album  = await getAlbum(albumId);
      const tracks = (album?.tracks?.items || []).map(t =>
        transformTrack(t, { title: album.title, image: album.image, id: album.id, artist: album.artist, version: album.version || '' })
      );
      if (tracks.length) {
        const shuffled = [...tracks].sort(() => Math.random() - .5);
        player.setQueue(shuffled, 0);
        toast('Shuffling album');
      }
    } catch(e) { toast('Could not load album', 'error'); }
  }

  followArtist(id) {
    toast('Follow feature requires Qobuz API extension', 'info');
  }

  // ── CONTEXT MENUS ────────────────────────────────────────────
  showTrackMenu(e, track, idx, list, isFullscreen=false) {
    e.preventDefault();
    
    const andClose = "; document.body.click(); window.app.closeFullscreen();";
    
    // Verifica se è un file locale
    const isLocal = track.is_local || String(track.id).startsWith('local_');

    // Voci base (sempre visibili)
    let menu = [
      { icon: '▶', label: 'Play now',       action: `window.app.playFromList(${JSON.stringify(list).replace(/"/g,'&quot;')}, ${idx}); document.body.click()` },
      { icon: '↓', label: 'Play next',      action: `window.app.playNext(${JSON.stringify(track).replace(/"/g,'&quot;')}); document.body.click()` },
      { icon: '+', label: 'Add to queue',   action: `window.app.addToQueue(${JSON.stringify(track).replace(/"/g,'&quot;')}); document.body.click()` }
    ];

    if (isFullscreen) {
      menu.push({ icon: '♡', label: 'Add to playlist', action: `window.app.showAddToPlaylist(${JSON.stringify(track).replace(/"/g,'&quot;')}); document.body.click()` });
    }

    // Mostra Album e Artista SOLO se non è un file locale
    if (!isLocal) {
      menu.push(
        { separator: true },
        { icon: '◉', label: 'Go to album',    action: `window.app.navigate('album','${track.album?.id || ''}')` + andClose},
        { icon: '♪', label: 'Go to artist',   action: `window.app.navigate('artist','${track.artist?.id || ''}')` + andClose }
      );
    }

    // Mostra il Download SOLO se non è un file locale
    if (!isLocal) {
      menu.push({ separator: true });
      menu.push({ icon: '⬇', label: 'Download track', action: `window.app.downloadTrack(${JSON.stringify(track).replace(/"/g,'&quot;')}); document.body.click()` });
    }

    // --- Logica per la rimozione dalle playlist (invariata) ---
    if (this.currentView === 'playlist' && String(this._currentData).startsWith('local_')) {
      menu.push({ separator: true });
      menu.push({ 
        icon: '✕', 
        label: 'Remove from playlist', 
        action: `window.app.removeTrackFromPlaylist('${this._currentData}', '${track.id}'); document.body.click()` 
      });
    }

    showContextMenu(e, menu);
  }

  showAlbumMenu(e, albumId) {
    showContextMenu(e, [
      { icon: '▶', label: 'Play album',    action: `window.app.playAlbum('${albumId}')` },
      { icon: '⇄', label: 'Shuffle album', action: `window.app.shuffleAlbum('${albumId}')` },
      { icon: '↓', label: 'Add to queue',  action: `window.app.addAlbumToQueue('${albumId}')` },
      { separator: true },
      //{ icon: '⬇', label: 'Download ZIP',  action: `window.app.downloadAlbumUI('${albumId}')` },
      { icon: '♡', label: 'Add to playlist', action: `window.app.showAddAlbumToPlaylist('${albumId}')` },
    ]);
  }

  playNext(track) {
    player.queue.splice(player.queueIdx + 1, 0, track);

    this._renderQueue(player.queue, player.queueIdx);

    toast(`"${track.title}" will play next`);
  }

  addToQueue(track) {
    player.addToQueue([track]);
    toast(`Added "${track.title}" to queue`);
  }

  async addAlbumToQueue(albumId) {
    try {
      const album  = await getAlbum(albumId);
      const tracks = (album?.tracks?.items || []).map(t =>
        transformTrack(t, { title: album.title, image: album.image, id: album.id, artist: album.artist, version: album.version || '' })
      );
      player.addToQueue(tracks);
      toast(`Added ${tracks.length} tracks to queue`);
    } catch { toast('Error', 'error'); }
  }

  // ── ADD TO PLAYLIST (LOCALE) ─────────────────────────────────
  showAddToPlaylist(track) {
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    modal('Add to Playlist',
      `<div style="margin-bottom:16px;">
        <button class="btn btn-primary" style="width:100%;justify-content:center;" onclick="window.app.createLocalPlaylist(${JSON.stringify(track).replace(/"/g,'&quot;')})">
          + Create New Playlist
        </button>
      </div>
      <div class="playlist-pick-list">
        ${localPls.length === 0 ? '<div style="text-align:center;color:var(--text3);padding:10px;font-size:12px;">No local playlists</div>' : ''}
        ${localPls.map(pl => `
          <div class="playlist-pick-item" onclick="window.app.addTrackToPlaylist('${pl.id}', ${JSON.stringify(track).replace(/"/g,'&quot;')})">
            <span class="playlist-dot" style="background:var(--gold)"></span>
            <span>${escHtml(pl.name)}</span>
            <span class="playlist-pick-count">${pl.tracks?.length || 0}</span>
          </div>`).join('')}
      </div>`
    );
  }

  createLocalPlaylist(track) {
    this._pendingPlaylistTrack = track;
    removeModal();
    modal('New Playlist',
      `<input id="new-pl-name" type="text" placeholder="Playlist name\u2026"
        style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text1);
               padding:10px 14px;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"
        onkeydown="if(event.key==='Enter') window.app._confirmNewPlaylistWithTrack()">`,
      [
        { label: 'Cancel', class: 'btn-ghost',   action: 'window.ui.removeModal()' },
        { label: 'Create', class: 'btn-primary', action: 'window.app._confirmNewPlaylistWithTrack()' },
      ]
    );
    setTimeout(() => document.getElementById('new-pl-name')?.focus(), 80);
  }

  _confirmNewPlaylistWithTrack() {
    const input = document.getElementById('new-pl-name');
    const name  = input?.value?.trim();
    if (!name) { input?.focus(); return; }
    removeModal();
    const track    = this._pendingPlaylistTrack;
    this._pendingPlaylistTrack = null;
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    const newPl    = { id: 'local_' + Date.now(), name, tracks: [] };
    localPls.push(newPl);
    localStorage.setItem('local_playlists', JSON.stringify(localPls));
    if (track) this.addTrackToPlaylist(newPl.id, track);
    this._loadSidebarPlaylists();
  }

  addTrackToPlaylist(playlistId, track) {
    removeModal();
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    const pl       = localPls.find(p => p.id === playlistId);
    if (pl) {
      if (!pl.tracks.find(t => t.id === track.id)) {
        const miniTrack = {
          id: track.id, title: track.title, duration: track.duration,
          artist: track.artist, album: track.album, audioQuality: track.audioQuality,
        };
        pl.tracks.push(miniTrack);
        localStorage.setItem('local_playlists', JSON.stringify(localPls));
        toast(`"${track.title}" added to ${pl.name}`, 'success');
      } else {
        toast(`Track already in ${pl.name}`, 'info');
      }
    }
  }

  async showAddAlbumToPlaylist(albumId) {
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    modal('Add Album to Playlist',
      `<div style="margin-bottom:16px;">
        <button class="btn btn-primary" style="width:100%;justify-content:center;" onclick="window.app.createLocalPlaylistFromAlbum('${albumId}')">
          + Create New Playlist
        </button>
      </div>
      <div class="playlist-pick-list">
        ${localPls.length === 0 ? '<div style="text-align:center;color:var(--text3);padding:10px;font-size:12px;">No local playlists</div>' : ''}
        ${localPls.map(pl => `
          <div class="playlist-pick-item" onclick="window.app.addAlbumToPlaylistId('${pl.id}', '${albumId}')">
            <span class="playlist-dot" style="background:var(--gold)"></span>
            <span>${escHtml(pl.name)}</span>
            <span class="playlist-pick-count">${pl.tracks?.length || 0}</span>
          </div>`).join('')}
      </div>`
    );
  }

  createLocalPlaylistFromAlbum(albumId) {
    this._pendingPlaylistAlbumId = albumId;
    removeModal();
    modal('New Playlist',
      `<input id="new-pl-name" type="text" placeholder="Playlist name\u2026"
        style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text1);
               padding:10px 14px;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"
        onkeydown="if(event.key==='Enter') window.app._confirmNewPlaylistFromAlbum()">`,
      [
        { label: 'Cancel', class: 'btn-ghost',   action: 'window.ui.removeModal()' },
        { label: 'Create', class: 'btn-primary', action: 'window.app._confirmNewPlaylistFromAlbum()' },
      ]
    );
    setTimeout(() => document.getElementById('new-pl-name')?.focus(), 80);
  }

  async _confirmNewPlaylistFromAlbum() {
    const input   = document.getElementById('new-pl-name');
    const name    = input?.value?.trim();
    if (!name) { input?.focus(); return; }
    removeModal();
    const albumId = this._pendingPlaylistAlbumId;
    this._pendingPlaylistAlbumId = null;
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    const newPl    = { id: 'local_' + Date.now(), name, tracks: [] };
    localPls.push(newPl);
    localStorage.setItem('local_playlists', JSON.stringify(localPls));
    await this.addAlbumToPlaylistId(newPl.id, albumId);
    this._loadSidebarPlaylists();
  }

  async addAlbumToPlaylistId(playlistId, albumId) {
    removeModal();
    try {
      const album  = await getAlbum(albumId);
      const tracks = (album?.tracks?.items || []).map(t =>
        transformTrack(t, { title: album.title, image: album.image, id: album.id, artist: album.artist })
      );
      const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
      const pl       = localPls.find(p => p.id === playlistId);
      if (!pl) return;
      let addedCount = 0;
      tracks.forEach(track => {
        if (!pl.tracks.find(t => t.id === track.id)) {
          pl.tracks.push({
            id: track.id, title: track.title, duration: track.duration,
            artist: track.artist, album: track.album, audioQuality: track.audioQuality,
          });
          addedCount++;
        }
      });
      localStorage.setItem('local_playlists', JSON.stringify(localPls));
      if (addedCount > 0) {
        toast(`Added ${addedCount} tracks to ${pl.name}`, 'success');
      } else {
        toast(`All tracks were already in ${pl.name}`, 'info');
      }
    } catch(e) {
      toast('Could not load album tracks', 'error');
    }
  }

  removeTrackFromPlaylist(playlistId, trackId) {
    const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    const pl       = localPls.find(p => p.id === playlistId);
    if (pl) {
      pl.tracks = pl.tracks.filter(t => String(t.id) !== String(trackId));
      localStorage.setItem('local_playlists', JSON.stringify(localPls));
      toast('Track removed', 'info');
      this._loadPlaylist(playlistId);
    }
  }

  deleteLocalPlaylist(playlistId) {
    modal('Delete Playlist',
      `<p style="color:var(--text2); font-size:13px; line-height:1.6;">
        Are you sure? This action cannot be undone.
      </p>`,
      [
        { label: 'Cancel', class: 'btn-ghost', action: 'window.ui.removeModal()' },
        { label: 'Delete', class: 'btn-primary', action: `window.app._doDeletePlaylist('${playlistId}')` },
      ]
    );
  }

  _doDeletePlaylist(playlistId) {
    removeModal();
    let localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    localPls     = localPls.filter(p => p.id !== playlistId);
    localStorage.setItem('local_playlists', JSON.stringify(localPls));
    toast('Playlist deleted', 'info');
    this._loadSidebarPlaylists();
    this.navigate('home');
  }


  // ── FILTRO RICERCA PLAYLIST ──────────────────────────────────
  filterPlaylist(query) {
    const term = query.toLowerCase();
    const tracks = document.querySelectorAll('#playlist-tracks .track-row');
    
    tracks.forEach(row => {
      // Estrae il testo del titolo e dell'artista
      const title = row.querySelector('.track-title')?.textContent.toLowerCase() || '';
      const artist = row.querySelector('.track-artist')?.textContent.toLowerCase() || '';
      
      // Mostra o nasconde la riga in base al match
      if (title.includes(term) || artist.includes(term)) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
  }

  // ── IMPORT FILE LOCALI (CON CALCOLO BITRATE MAGICO) ────────────────
  async importLocalFiles(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    //toast('Lettura metadati e analisi qualità in corso...', 'info');

    let localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
    let libraryPl = localPls.find(p => p.id === 'local_library');
    if (!libraryPl) {
      libraryPl = { id: 'local_library', name: 'Local Library', tracks: [] };
      localPls.push(libraryPl);
    }

    const parseTags = (file) => {
      return new Promise((resolve) => {
        if (!window.jsmediatags) return resolve(null);
        window.jsmediatags.read(file, {
          onSuccess: (tag) => resolve(tag.tags),
          onError: () => resolve(null)
        });
      });
    };

    const getDuration = (fileUrl) => {
      return new Promise((resolve) => {
        const audio = new Audio(fileUrl);
        audio.addEventListener('loadedmetadata', () => resolve(audio.duration));
        audio.addEventListener('error', () => resolve(0));
      });
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileUrl = URL.createObjectURL(file);
      
      let title = file.name.replace(/\.[^/.]+$/, "");
      let artistName = 'Unknown Artist';
      let albumTitle = 'Local Files';
      let coverUrl = null;

      // 1. Estrai i metadati dal file se presenti
      const tags = await parseTags(file);
      if (tags) {
        if (tags.title) title = tags.title;
        if (tags.artist) artistName = tags.artist;
        if (tags.album) albumTitle = tags.album;
        if (tags.picture) {
          const { data, format } = tags.picture;
          let base64String = "";
          for (let j = 0; j < data.length; j++) {
            base64String += String.fromCharCode(data[j]);
          }
          coverUrl = `data:${format};base64,${window.btoa(base64String)}`;
        }
      }

      // 2. Calcola la durata esatta
      const duration = await getDuration(fileUrl);

      // --- IL TRUCCO MAGICO: CALCOLO DEL BITRATE ---
      // Bitrate (kbps) = (Dimensione in byte * 8 bit) / secondi / 1000
      const bitrateKbps = duration > 0 ? (file.size * 8) / duration / 1000 : 0;
      
      const fname = file.name.toLowerCase();
      let quality = 'FLAC';
      let depth = 16;
      let sr = 44.1;

      if (fname.endsWith('.mp3') || file.type.includes('mp3')) {
        quality = 'MP3';
      } else if (fname.endsWith('.wav')) {
        // I file WAV non sono compressi, pesano di più
        if (bitrateKbps > 4000) { depth = 24; sr = 192.0; } // Hi-Res
        else if (bitrateKbps > 2000) { depth = 24; sr = 96.0; }  // Hi-Res
        else if (bitrateKbps > 1400) { depth = 24; sr = 44.1; }  // 24-bit Standard
      } else {
        // FLAC e ALAC (Compressi Lossless)
        if (bitrateKbps > 3000) { depth = 24; sr = 192.0; } // Hi-Res pesante
        else if (bitrateKbps > 1800) { depth = 24; sr = 96.0; }  // Hi-Res classico
        else if (bitrateKbps > 1100) { depth = 24; sr = 44.1; }  // 24-bit compresso
        // Sotto i 1100 kbps resterà FLAC 16-bit
      }

      const uniqueId = 'local_file_' + Date.now() + '_' + i;

      // Salva fisicamente il file nel Database Permanente
      await window.LocalDB.saveFile(uniqueId, file);

      libraryPl.tracks.push({
        id: uniqueId,
        title: title,
        artist: { name: artistName },
        album: { 
          title: albumTitle, 
          image: coverUrl ? { large: coverUrl, small: coverUrl } : null,
          cover: coverUrl 
        },
        duration: duration, 
        is_local: true,            
        audioQuality: quality,     
        maximum_bit_depth: depth,  
        maximum_sampling_rate: sr  
      });
    }

    localStorage.setItem('local_playlists', JSON.stringify(localPls));
    await this._loadSidebarPlaylists();
    toast(`Added ${files.length} file in Local Library!`, 'success');
    
    event.target.value = '';

    if (this.currentView === 'playlist' && this._currentData === 'local_library') {
      this._loadPlaylist('local_library');
    } else {
      this.navigate('playlist', 'local_library');
    }
  }

  // ── DOWNLOAD ─────────────────────────────────────────────────

  _trackCoverUrl(track) {
    const img = track.album?.image;
    if (!img) return null;
    if (typeof img === 'string') return img.replace(/_\d+\.jpg/, '_600.jpg');
    const url = img.large || img.small || img.thumbnail || null;
    return url ? url.replace(/_\d+\.jpg/, '_600.jpg') : null;
  }

  // Helper per concorrenza
  async _processConcurrency(items, limit, asyncFn, onProgress) {
    let index = 0;
    let completed = 0;
    const results = [];
    
    const worker = async () => {
        while (index < items.length) {
            const i = index++;
            try {
                const res = await asyncFn(items[i], i);
                results.push(res);
            } catch (e) {
                console.warn('Task failed', e);
            } finally {
                completed++;
                if (onProgress) onProgress(completed, items.length);
            }
        }
    };

    const threads = [];
    for (let i = 0; i < limit; i++) {
        threads.push(worker());
    }
    await Promise.all(threads);
    return results;
  }

  async downloadTrack(track) {
    try {
      toast('Fetching download URL...', 'info');
      const q    = this._settings.downloadQuality;
      const data = await getStreamUrl(track.id || track.originalId, q);

      toast(`Downloading: ${track.title}...`, 'info');

      const response = await fetch(data.url);
      if (!response.ok) throw new Error('Network error');
      const rawBlob = await response.blob();

      // ── EMBED METADATA ────────────────────────────────────────
      let finalBlob;
      try {
        finalBlob = await embedMetadata(rawBlob, track, this._trackCoverUrl(track));
      } catch (tagErr) {
        console.warn('Tagging failed, using raw file:', tagErr);
        finalBlob = rawBlob; 
      }
      
      let ext = (q === '5') ? 'mp3' : 'flac';
      if (data.url && data.url.includes('.mp3')) ext = 'mp3';

      const blobUrl = URL.createObjectURL(finalBlob);
      const a       = document.createElement('a');
      a.style.display = 'none';
      a.href     = blobUrl;
      a.download = `${track.artist?.name || 'Unknown'} - ${track.title}.${ext}`
                     .replace(/[/\\?%*:|"<>]/g, '-');

      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 200);

      toast(`Downloaded: ${track.title}`, 'success');
    } catch (e) {
      toast('Download failed: ' + e.message, 'error');
      if (e.message.includes('Failed to fetch')) {
        getStreamUrl(track.id || track.originalId, this._settings.downloadQuality)
          .then(d => window.open(d.url, '_blank'));
      }
    }
  }

  // DOWNLOAD ALBUM VELOCE (CONCORRENZA)
  async downloadAlbumUI(albumId) {
    let album, tracks;
    try {
      const data = await getAlbum(albumId);
      album  = data;
      tracks = (data?.tracks?.items || []).map(t => transformTrack(t));
    } catch { toast('Could not load album', 'error'); return; }

    if (!tracks.length) { toast('No tracks found', 'error'); return; }

    if (typeof JSZip === 'undefined') {
      // Fallback
      modal('Download Album',
        `<p style="color:var(--text2);margin-bottom:16px;">Download individual tracks (ZIP requires JSZip library):</p>
        <div style="max-height:300px;overflow-y:auto;">
          ${tracks.map((t, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
              <span style="font-size:13px;">${i+1}. ${escHtml(t.title)}</span>
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px;"
                onclick="window.app.downloadTrack(${JSON.stringify(t).replace(/"/g,'&quot;')})">DL</button>
            </div>`).join('')}
        </div>`
      );
      return;
    }

    const dlg = progressDialog(`Downloading: ${album.title}`);
    try {
      const zip = new JSZip();
      const q   = this._settings.downloadQuality;

      // Usiamo il worker concorrente per scaricare (3 alla volta)
      await this._processConcurrency(tracks, 3, async (track, idx) => {
         
         const data = await getStreamUrl(track.id || track.originalId, q);
         const resp = await fetch(data.url);
         const rawBlob = await resp.blob();

         // Embed Metadata
         let finalBlob;
         try {
            const enrichedTrack = {
              ...track,
              album: {
                title:                    album.title,
                image:                    album.image,
                id:                       album.id,
                release_date_original:    album.release_date_original,
                ...(track.album || {}),
              },
            };
            const coverImgUrl = enrichedTrack.album.image?.large || enrichedTrack.album.image?.small || null;
            finalBlob = await embedMetadata(rawBlob, enrichedTrack, coverImgUrl);
         } catch (tagErr) {
            finalBlob = rawBlob;
         }

         let ext = (q === '5') ? 'mp3' : 'flac';
         if (data.url && data.url.includes('.mp3')) ext = 'mp3';
         
         const trackNum = String(track.trackNumber || idx + 1).padStart(2, '0');
         const filename = `${trackNum} - ${track.title}.${ext}`.replace(/[/\\?%*:|"<>]/g, '-');
         
         zip.file(filename, finalBlob);

      }, (completed, total) => {
         // Aggiorna Dialog con calcolo preciso della percentuale
         dlg.update(completed, total); 
      });

      toast('Zipping files...', 'info');

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const a       = document.createElement('a');
      a.href        = URL.createObjectURL(zipBlob);
      a.download    = `${album.title}.zip`.replace(/[/\\?%*:|"<>]/g, '-');
      document.body.appendChild(a);
      a.click();
      a.remove();
      dlg.close();
      toast(`Downloaded: ${album.title}`, 'success');
    } catch(e) {
      dlg.close();
      toast('Download failed: ' + e.message, 'error');
    }
  }

  // DOWNLOAD PLAYLIST VELOCE (CONCORRENZA)
  async downloadPlaylistUI(playlistId) {
    if (!playlistId) return;

    let tracks = [];
    let plName = 'Playlist';

    if (String(playlistId).startsWith('local_')) {
      const localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
      const pl = localPls.find(p => p.id === playlistId);
      if (!pl) { toast('Playlist not found', 'error'); return; }
      tracks = pl.tracks || [];
      plName = pl.name;
    } else {
      try {
        const pl = await getPlaylist(playlistId);
        if (!pl) throw new Error('Not found');
        tracks = (pl.tracks?.items || []).map(t => transformTrack(t));
        plName = pl.name || 'Playlist';
      } catch { toast('Could not load playlist', 'error'); return; }
    }

    if (!tracks.length) { toast('No tracks to download', 'error'); return; }

    if (typeof JSZip === 'undefined') {
        // Fallback
      modal('Download Playlist',
        `<p style="color:var(--text2);margin-bottom:16px;">Download individual tracks (ZIP requires JSZip):</p>
        <div style="max-height:300px;overflow-y:auto;">
          ${tracks.map((t, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
              <span style="font-size:13px;">${i+1}. ${escHtml(t.title)}</span>
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px;"
                onclick="window.app.downloadTrack(${JSON.stringify(t).replace(/"/g,'&quot;')})">DL</button>
            </div>`).join('')}
        </div>`
      );
      return;
    }

    const dlg = progressDialog(`Downloading: ${plName}`);
    try {
      const zip = new JSZip();
      const q   = this._settings.downloadQuality;

      // Concorrenza: 3 download paralleli
      await this._processConcurrency(tracks, 3, async (track, idx) => {
          
          const data    = await getStreamUrl(track.id || track.originalId, q);
          const resp    = await fetch(data.url);
          const rawBlob = await resp.blob();

          let finalBlob;
          try {
            finalBlob = await embedMetadata(rawBlob, track, this._trackCoverUrl(track));
          } catch {
            finalBlob = rawBlob;
          }

          let ext = (q === '5') ? 'mp3' : 'flac';
          if (data.url && data.url.includes('.mp3')) ext = 'mp3';

          // Usa idx per dare un ordine se manca trackNumber
          const trackNum = String(track.trackNumber || idx + 1).padStart(2, '0');
          const filename = `${trackNum} - ${track.artist?.name || 'Unknown'} - ${track.title}.${ext}`
                            .replace(/[/\\?%*:|"<>]/g, '-');
          zip.file(filename, finalBlob);

      }, (completed, total) => {
          // Update progress
          dlg.update(completed, total);
      });

      toast('Zipping files...', 'info');

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const a       = document.createElement('a');
      a.href        = URL.createObjectURL(zipBlob);
      a.download    = `${plName}.zip`.replace(/[/\\?%*:|"<>]/g, '-');
      document.body.appendChild(a);
      a.click();
      a.remove();
      dlg.close();
      toast(`Downloaded: ${plName}`, 'success');
    } catch (e) {
      dlg.close();
      toast('Download failed: ' + e.message, 'error');
    }
  }

  // ── SETTINGS RENDER ──────────────────────────────────────────
  _renderSettings() {
    this._updateCacheBadge();
  }

  // ── CACHE BADGE ──────────────────────────────────────────
  async _updateCacheBadge() {
    const badgeNormal = document.getElementById('cache-normal-badge');
    const badgeMedia  = document.getElementById('cache-media-badge');

    if (badgeNormal) badgeNormal.textContent = '...';
    if (badgeMedia)  badgeMedia.textContent  = '...';

    const formatBytes = (bytes) => {
      if (!bytes || bytes === 0) return '0 B';
      const kb = bytes / 1024;
      const mb = kb / 1024;
      return mb < 1 ? `${kb.toFixed(1)} KB` : `${mb.toFixed(1)} MB`;
    };

    let localBytes = 0;
    let mediaBytes = 0;

    // Calcoliamo SOLO il peso delle stringhe testuali nel localStorage
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key  = localStorage.key(i) || '';
        const val  = localStorage.getItem(key) || '';
        const size = (key.length + val.length) * 2; // JS usa 2 byte per carattere
        
        // Se è un link testuale delle cover (o futuri link audio)
        if (key.startsWith('apple_cache_') || key.startsWith('audio_link_')) {
          mediaBytes += size;
        } else {
          localBytes += size;
        }
      }
    } catch {}

    if (badgeNormal) {
      badgeNormal.textContent = formatBytes(localBytes);
      badgeNormal.className   = 'cache-badge cache-badge-ok';
    }

    if (badgeMedia) {
      badgeMedia.textContent = formatBytes(mediaBytes);
      // Dato che ora sono solo pochi KB, il badge sarà sempre verde (ok)
      badgeMedia.className   = 'cache-badge cache-badge-ok';
    }
  }

  /*async toggleMiniMode() {
    const shell = document.getElementById('shell');
    if (!shell) return;

    const enteringMini = !shell.classList.contains('mini-mode');
    const api = window.electronAPI;

    if (enteringMini) {
      // 1. Salva le dimensioni attuali prima di rimpicciolire
      if (api?.getBounds) {
        const bounds = await api.getBounds();
        if (bounds && !this._isMiniMode) {
          this._prevBounds = { w: bounds.width, h: bounds.height };
        }
      }

      this._isMiniMode = true;

      // 2. Calcola le dimensioni del Mini Player
      const miniBounds = JSON.parse(localStorage.getItem('mini_player_bounds') || 'null');
      
      // FIX: Il Math.max adesso è 300, così rispetta il tuo 374 di default e 
      // ti permette di stringere la finestra salvando le dimensioni correttamente.
      const miniW = Math.max(300, Math.min(miniBounds?.w || 368, 520));
      const miniH = Math.max(300, Math.min(miniBounds?.h || 374, 860));

      // 3. Abbassa il limite del sistema operativo PRIMA di ridimensionare
      if (api?.setMinimumSize) api.setMinimumSize(300, 300);
      if (api?.setResizable) api.setResizable(true);

      // 4. Applica il ridimensionamento
      if (api?.resizeWindow) {
        api.resizeWindow(miniW, miniH);
        setTimeout(() => api.resizeWindow(miniW, miniH), 30);
      }

      shell.classList.add('mini-mode');
      document.getElementById('mini-mode-btn')?.classList.add('active');
      
    } else {
      
      // --- RITORNO AL PLAYER NORMALE ---
      this._isMiniMode = false;

      shell.classList.remove('mini-mode');
      document.getElementById('mini-mode-btn')?.classList.remove('active');

      // 1. Alza il limite del sistema operativo per la finestra grande
      if (api?.setMinimumSize) api.setMinimumSize(600, 600);
      if (api?.setResizable) api.setResizable(true);

      // 2. Recupera le dimensioni precedenti o usa il default
      const b = this._prevBounds || { w: 1090, h: 701 };
      
      if (api?.resizeWindow) {
        api.resizeWindow(b.w, b.h);
        
        // FIX: Inseriamo il centerWindow dentro il delay per assicurarci 
        // che il ridimensionamento sia completato prima di centrare
        setTimeout(() => {
          api.resizeWindow(b.w, b.h);
          if (api?.centerWindow) api.centerWindow();
        }, 30);
      }
    }
  }*/

  async toggleMiniMode() {
    // Comunica ad Electron di aprire o chiudere la seconda finestra
    if (window.electronAPI && window.electronAPI.toggleMiniWindow) {
      window.electronAPI.toggleMiniWindow();
      //document.getElementById('mini-mode-btn')?.classList.toggle('active');
    } else {
      console.warn('Error');
    }
  }

  toggleQualityPicker(e) {
    e.stopPropagation();
    const menu = document.getElementById('quality-picker-menu');
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    this.closeQualityPicker();
    if (!isOpen) {
      menu.classList.add('open');
      // close on outside click
      setTimeout(() => document.addEventListener('click', this._closeQPOnClick = () => {
        this.closeQualityPicker();
        document.removeEventListener('click', this._closeQPOnClick);
      }), 0);
    }
  }

  closeQualityPicker() {
    document.getElementById('quality-picker-menu')?.classList.remove('open');
  }

  updateApiUrl() {
    const input = document.getElementById('settings-api-input');
    if (!input) return;
    const url = input.value.trim();
    if (!url) return;
    setApiBase(url);
    document.getElementById('settings-api-url').textContent = url;
    toast('API URL updated', 'success');
  }

  // ── PLAYER BINDING ───────────────────────────────────────────
  _bindPlayer() {
    player.on('timeupdate', ({ current }) => {
      this._lastTrackTime = current;
      LyricsManager.sync(current);
    });

    player.on('trackchange', track => {
      this._updateNowPlaying(track);
      this._highlightPlayingTrack(track);
      if (track) {
        LyricsManager.load(
          track.artist?.name || track.performer?.name || '',
          track.title,
          track.album?.title || '',
          track.duration || 0
        );
        // FIX RESTORE TIME: Se c'era un tempo pendente dal restore sessione, applicalo ora
        if (this._pendingRestoreTime !== null) {
            if (window.player.audio) {
                window.player.audio.currentTime = this._pendingRestoreTime;
            }
            this._pendingRestoreTime = null;
        }
      }
    });

    player.on('state', state => {
      this._updatePlayerUI(state);

      localStorage.setItem('saved_shuffle', state.shuffle);
      localStorage.setItem('saved_repeat', state.repeat);

      if (state.isPlaying && 'mediaSession' in navigator && player.currentTrack) {
        navigator.mediaSession.metadata = navigator.mediaSession.metadata;
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      }
    });

    player.on('queuechange', ({ queue, idx }) => {
      this._renderQueue(queue, idx);
    });

    player.on('loading', loading => {
      document.getElementById('play-btn').classList.toggle('loading', loading);
      const fsPlayBtn = document.getElementById('fs-play-btn');
      if (fsPlayBtn) fsPlayBtn.classList.toggle('loading', loading);
    });

    player.on('error', e => {
      toast('Playback error: ' + (e.message || 'Unknown error'), 'error');
    });


    // Funzione principale che spedisce i dati e l'oggetto TRACK al Mini Player
    const syncToMini = () => {
      if (!window.electronAPI || !window.electronAPI.syncToMini) return;
      const t = player.currentTrack;
      
      // Estraiamo il testo
      let lyricsHtml = `<div class="mini-lyrics-empty">Testo non disponibile.</div>`;
      const fsLyrics = document.getElementById('fs-lyrics');
      if (fsLyrics) {
        const lines = Array.from(fsLyrics.querySelectorAll('.lyric-line'));
        if (lines.length > 0) {
          lyricsHtml = lines.map(line => {
            const text = (line.textContent || '').trim() || '♪';
            const active = line.classList.contains('active') ? ' active' : '';
            return `<div class="mini-lyrics-line${active}">${text}</div>`;
          }).join('');
        }
      }

      // Spediamo i dati assemblati via IPC
      window.electronAPI.syncToMini({
        isPlaying: window.player.audio && !window.player.audio.paused,
        title: t ? t.title : 'No track',
        artist: t ? (t.artist?.name || t.performer?.name) : '',
        cover: t ? coverUrl(t.album?.image?.large || t.album?.cover) : null,
        currentTime: window.player.audio ? window.player.audio.currentTime : 0,
        duration: t ? (t.duration || 1) : 1,
        lyricsHtml: lyricsHtml,
        track: t, // PASSAGGIO CHIAVE: inviamo l'intero oggetto traccia
        animatedCovers: this._settings.animatedCovers
      });
    };

    // Agganciamo i listener per aggiornare in tempo reale
    player.on('timeupdate', syncToMini);
    player.on('state', syncToMini);
    player.on('trackchange', syncToMini); // Richiama semplicemente il sync quando cambi brano

    // ASCOLTA I COMANDI IN ARRIVO DAL MINI PLAYER
    if (window.electronAPI && window.electronAPI.onMiniAction) {
      window.electronAPI.onMiniAction((action, payload) => {
        switch (action) {
          case 'togglePlay': player.togglePlay(); break;
          case 'next': player.next(); break;
          case 'prev': player.prev(); break;
          case 'request-sync': syncToMini(); break;
        }
      });
    }

  }

  _updateNowPlaying(track) {
    if (!track) return;

    // Identifica se è un file locale
    const isLocal = track.is_local || String(track.id).startsWith('local_');

    const title      = track.title || '—';
    const artistName = track.artist?.name || track.performer?.name || '—';
    const artistId   = track.artist?.id   || track.performer?.id;
    const cover      = coverUrl(track.album?.image?.large || track.album?.cover);

    const versionSuffix = track.album?.version ? ` · ${track.album.version}` : '';
    document.getElementById('now-title').textContent = title;

    const viewLyrics = document.getElementById('view-lyrics');
    if (viewLyrics) {
      viewLyrics.style.setProperty('--lyrics-bg', cover ? `url('${cover}')` : 'none');
    }

    // 1. PLAYER: Gestione click sull'artista
    const artistEl = document.getElementById('now-artist');
    if (artistId && !isLocal) {
      artistEl.innerHTML = `<span class="hero-artist-link" style="cursor:pointer;display:inline-block;" onclick="window.app.navigate('artist','${artistId}')">${escHtml(artistName)}</span>`;
    } else {
      artistEl.textContent = artistName;
    }

    /* 2. PLAYER: Nascondi i 3 puntini e "Aggiungi a playlist" per file locali
    document.querySelectorAll('.now-action-btn').forEach(btn => {
      if (btn.textContent.includes('⋯') || btn.title === 'More' || btn.title === 'Add to Playlist') {
        btn.style.display = isLocal ? 'none' : '';
      }
    });*/

    const artEl = document.getElementById('now-art');
    artEl.innerHTML = `
      ${cover ? `<img src="${cover}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;">` : `<div class="now-art-placeholder">♪</div>`}
      <div class="now-art-overlay">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      </div>`;
    
    const nowVideo = document.getElementById('now-video-art');
    const miniVideo  = document.getElementById('mini-video-art');

    if (this._settings.animatedCovers) {
      //if (nowVideo) coverVideoManager.play(nowVideo, track, 'square');
      //if (miniVideo) coverVideoManager.play(miniVideo, track, 'square');
    } else {
      if (nowVideo) coverVideoManager.stop(nowVideo);
      if (miniVideo) coverVideoManager.stop(miniVideo);
    }

    // Sync mini bar
    const miniTitle  = document.getElementById('mini-title');
    const miniArtist = document.getElementById('mini-artist');
    const miniArt    = document.getElementById('mini-art');
    if (miniTitle)  miniTitle.textContent  = title;
    if (miniArtist) miniArtist.textContent = artistName;
    if (miniArt)    miniArt.style.backgroundImage = cover ? `url(${cover.replace("_600.jpg","_org.jpg")})` : 'none';

    // ── Quality badge logic ──
    let maxQ     = 6;
    let badgeText = 'LOSSLESS';
    const depth  = parseInt(track.maximum_bit_depth || track.bit_depth || (track.audioQuality?.includes('HI_RES') ? 24 : 16), 10);
    const sr     = parseFloat(track.maximum_sampling_rate || track.sampling_rate || 44.1);

    const specsEl = document.getElementById('now-specs');
    if (specsEl) {
      if (track.audioQuality === 'MP3') {
        specsEl.textContent = 'MP3 • 320 KBPS';
        specsEl.style.color = 'var(--text3)';
      } else {
        const formatName = depth >= 24 && sr > 48.0 ? 'HI-RES' : 'FLAC';
        specsEl.textContent = `${formatName} • ${depth}-BIT / ${sr} kHz`;
        specsEl.style.color = depth >= 24 && sr > 48.0 ? 'var(--gold2)' : 'var(--text2)';
      }
    }

    if (track.audioQuality === 'MP3') {
      maxQ = 5; badgeText = 'MP3';
    } else if (depth >= 24) {
      if (sr > 48.0) { maxQ = 27; badgeText = 'HI-RES ✦'; }
      else           { maxQ = 7;  badgeText = '24BIT';    }
    } else {
      maxQ = 6; badgeText = 'LOSSLESS';
    }

    // 3. SELETTORE QUALITÀ
    const drop = document.getElementById('quality-picker-btn');
    if (drop) {
      let userQ   = parseInt(this._settings.quality || '27');
      let actualQ = userQ;
      if (userQ === 27 && maxQ < 27) actualQ = maxQ;
      if (userQ === 7  && maxQ < 7)  actualQ = maxQ;
      if (userQ === 6  && maxQ < 6)  actualQ = maxQ;

      const labels = { 5: 'MP3', 6: 'LOSSLESS', 7: '24BIT', 27: 'HI-RES' };
      const labelEl = document.getElementById('quality-picker-label');
      if (labelEl) labelEl.textContent = labels[actualQ] || 'HI-RES';

      drop.className = 'quality-picker-btn quality-dropdown';
      if      (actualQ === 27) drop.classList.add('q-hires');
      else if (actualQ === 7)  drop.classList.add('q-bit24');
      else if (actualQ === 6)  drop.classList.add('q-lossless');
      else                     drop.classList.add('q-mp3');

      // Blocca il selettore se il file è locale
      if (isLocal) {
        drop.style.pointerEvents = 'none';
        drop.style.opacity = '0.6';
      } else {
        drop.style.pointerEvents = '';
        drop.style.opacity = '1';
      }

      // Disable unavailable options
      document.querySelectorAll('.quality-picker-opt').forEach(btn => {
        const val = parseInt(btn.dataset.q);
        const allowed = val === 5 ||
                        (val === 6  && maxQ >= 6)  ||
                        (val === 7  && maxQ >= 7)  ||
                        (val === 27 && maxQ >= 27);
        btn.disabled = !allowed;
        btn.style.opacity = allowed ? '' : '0.3';
        btn.classList.toggle('active', val === actualQ);
      });
    }

    const albumId    = track.album?.id || track.album?.album_id || track.album_id || track.albumId || track.release?.id;
    const albumTitle = track.album?.title || track.album_title || '';

    const fsTitle = document.getElementById('fs-title');
    if (fsTitle) fsTitle.textContent = title;

    // 4. FULLSCREEN: Rimuovi click su Artista
    const fsArtist = document.getElementById('fs-artist');
    if (fsArtist) {
      fsArtist.innerHTML = (artistId && !isLocal)
        ? `<span class="fs-clickable" onclick="document.getElementById('fullscreen-overlay').classList.remove('open'); setTimeout(() => window.app.navigate('artist','${artistId}'), 150);">${escHtml(artistName)}</span>`
        : escHtml(artistName);
    }

    // 5. FULLSCREEN: Rimuovi click su Album
    const fsAlbum = document.getElementById('fs-album');
    const fsDot   = document.querySelector('.fs-dot');
    if (fsAlbum) {
      if (albumTitle) {
        if (isLocal) {
          fsAlbum.innerHTML = escHtml(albumTitle);
        } else if (albumId) {
          fsAlbum.innerHTML = `<span class="fs-clickable" onclick="document.getElementById('fullscreen-overlay').classList.remove('open'); setTimeout(() => window.app.navigate('album','${albumId}'), 150);">${escHtml(albumTitle)}</span>`;
        } else {
          const jsSafeTitle = albumTitle.replace(/'/g, "\\'").replace(/"/g, '\\"');
          fsAlbum.innerHTML = `<span class="fs-clickable" onclick="document.getElementById('fullscreen-overlay').classList.remove('open'); setTimeout(() => { const s = document.getElementById('titlebar-search'); if(s) s.value='${jsSafeTitle}'; window.app.onSearchInput('${jsSafeTitle}'); }, 150);">${escHtml(albumTitle)}</span>`;
        }
        if (fsDot) fsDot.style.display = 'inline';
      } else {
        fsAlbum.innerHTML = '';
        if (fsDot) fsDot.style.display = 'none';
      }
    }

    const fsSpecs = document.getElementById('fs-specs');
    if (fsSpecs) {
      if (track.audioQuality === 'MP3') fsSpecs.textContent = '320 kbps';
      else if (depth && sr)             fsSpecs.textContent = `${depth}-BIT / ${sr} kHz`;
      else                              fsSpecs.textContent = 'Standard Quality';
    }

    const fsQuality = document.getElementById('fs-quality-label');
    if (fsQuality) {
      fsQuality.textContent = badgeText;
      if (maxQ === 27) {
        fsQuality.style.color        = 'var(--gold)';
        fsQuality.style.background   = 'rgba(212,168,83,0.05)';
        fsQuality.style.borderColor  = 'rgba(212,168,83,0.3)';
      } else if (maxQ === 7) {
        fsQuality.style.color        = '#4FC3F7';
        fsQuality.style.background   = 'rgba(79,195,247,0.05)';
        fsQuality.style.borderColor  = 'rgba(79,195,247,0.3)';
      } else {
        fsQuality.style.color        = 'var(--text2)';
        fsQuality.style.background   = 'rgba(255,255,255,0.04)';
        fsQuality.style.borderColor  = 'rgba(255,255,255,0.1)';
      }
    }

    const fsBg = document.getElementById('fs-bg');
    if (fsBg) fsBg.style.backgroundImage = cover ? `url('${cover}')` : '';

    // FS art + animated cover (Apple Music)
    const fsArt = document.getElementById('fs-art');
    fsArt.style.position = 'relative';
    fsArt.style.overflow = 'hidden';

    // Prepara il nuovo tag immagine statica
    const newImgHtml = cover
      ? `<img src="${cover.replace("_600.jpg","_org.jpg")}" style="width:100%;height:100%;object-fit:cover;" draggable="false">`
      : `<div class="fs-art-placeholder">♪</div>`;

    let fsVideo = document.getElementById('fs-video-art');

    if (this._settings.animatedCovers) {
      // Chiediamo l'ID Apple del nuovo brano/album
      const artist = track.artist?.name || track.performer?.name || '';
      let albumTitle = track.album?.title || track.album_title || '';
      
      // Se non esiste ancora il video nel DOM, creiamolo
      if (!fsVideo) {
        fsArt.innerHTML = newImgHtml + `<video id="fs-video-art" autoplay loop muted playsinline crossorigin="anonymous" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;"></video>`;
        fsVideo = document.getElementById('fs-video-art');
      } else {
        // Aggiorna o inserisce l'immagine statica di sfondo
        const existingImg = fsArt.querySelector('img, .fs-art-placeholder');
        if (existingImg) existingImg.outerHTML = newImgHtml;
        else fsArt.insertAdjacentHTML('afterbegin', newImgHtml);
      }

      // Avvia la ricerca della cover animata per il nuovo brano
      getAppleAlbumId(artist, albumTitle).then(appleIds => {
        if (appleIds && appleIds.length > 0) {
          getAnimatedArtwork(appleIds, 'square').then(videoUrl => {
            if (videoUrl) {
              // Se il video trovato è diverso da quello attualmente in riproduzione, ricaricalo
              if (fsVideo.dataset.videoSrc !== videoUrl) {
                fsVideo.dataset.videoSrc = videoUrl;
                coverVideoManager.play(fsVideo, track, 'square');
              }
            } else {
              // Se la traccia nuova NON ha la cover animata, ferma e pulisci la precedente
              coverVideoManager.stop(fsVideo);
              fsVideo.dataset.videoSrc = '';
            }
          });
        } else {
          // Nessun riscontro su Apple Music, spegni il video animato precedente
          coverVideoManager.stop(fsVideo);
          fsVideo.dataset.videoSrc = '';
        }
      });

    } else {
      // Se le cover animate sono disattivate nelle impostazioni
      if (fsVideo) coverVideoManager.stop(fsVideo);
      fsArt.innerHTML = newImgHtml;
    }

    if ('mediaSession' in navigator) {
      let artworkUrl = cover || '';
      if (artworkUrl && !artworkUrl.startsWith('http')) {
        artworkUrl = new URL(artworkUrl, window.location.href).href;
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title:   title      || '—',
        artist:  artistName || '—',
        album:   albumTitle || '',
        artwork: artworkUrl ? [
          { src: artworkUrl, sizes: '96x96',  type: 'image/jpeg' },
          { src: artworkUrl, sizes: '128x128', type: 'image/jpeg' },
          { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
        ] : [],
      });
      navigator.mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play',          () => player.togglePlay());
      navigator.mediaSession.setActionHandler('pause',         () => player.togglePlay());
      navigator.mediaSession.setActionHandler('nexttrack',     () => player.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
      navigator.mediaSession.setActionHandler('seekto', details => {
        if (details.seekTime !== undefined && typeof player.endDragSeek === 'function') {
          player.endDragSeek(details.seekTime / (player.currentTrack?.duration || 1));
        }
      });
    }

    checkMarquee();
    document.title = `${title} — ${artistName}${versionSuffix}`;
	
	  //Discord
    if (this._settings.discordRPC && window.electronAPI?.updateDiscordRPC) {
      // Discord RPC non supporta URL base64 o blob. Usa un fallback se il file è locale.

      const defaultImage ="no-cover";

      let discordCover = cover || defaultImage;
      if (discordCover.startsWith('data:') || discordCover.startsWith('blob:')) {
        discordCover = defaultImage; // Sostituisci con l'icona di default della tua app
      }
      
      window.electronAPI.updateDiscordRPC({
        title:      title,
        artist:     artistName,
        albumTitle: albumTitle,
        cover:      discordCover,
        duration:   track.duration
      });
    }
	
    
    const fsMore = document.getElementById('fs-more-btn');
    if (fsMore) {
      fsMore.onclick = (e) => {
        e.stopPropagation();
        const t = player.currentTrack;
        if (!t) return;
        this.showTrackMenu(e, t, 
          this._currentAlbumTracks.indexOf(t) >= 0 ? this._currentAlbumTracks.indexOf(t) : 0,
          this._currentAlbumTracks.length ? this._currentAlbumTracks : [t],
          true
        );
      };
    }

  }


  _extractColor(imgUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // Parametro fittizio per forzare il bypass della cache CORS
    img.src = imgUrl + (imgUrl.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
    
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        // Aumentiamo leggermente la risoluzione per una precisione migliore
        c.width = c.height = 32; 
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 32, 32);
        const d = ctx.getImageData(0, 0, 32, 32).data;
        
        let colorMap = {};
        let bestScore = 0;
        let r = 0, g = 0, b = 0;

        for (let i = 0; i < d.length; i += 4) {
          let pr = d[i], pg = d[i+1], pb = d[i+2], pa = d[i+3];
          
          // Ignora pixel trasparenti
          if (pa < 128) continue; 

          let max = Math.max(pr, pg, pb);
          let min = Math.min(pr, pg, pb);
          let brightness = (max + min) / 2;
          let saturation = max - min; // Da 0 a 255

          // Ignora i neri assoluti e i bianchi sparati
          if (brightness < 20 || brightness > 235) continue;

          // Raggruppa colori simili (step di 24)
          let step = 24;
          let rBin = Math.floor(pr / step);
          let gBin = Math.floor(pg / step);
          let bBin = Math.floor(pb / step);
          let key = `${rBin}-${gBin}-${bBin}`;

          if (!colorMap[key]) colorMap[key] = { count: 0, r: 0, g: 0, b: 0, sat: 0 };
          
          colorMap[key].count++;
          colorMap[key].r += pr;
          colorMap[key].g += pg;
          colorMap[key].b += pb;
          colorMap[key].sat += saturation;
        }

        // Trova il colore vincitore
        for (let key in colorMap) {
          let bucket = colorMap[key];
          
          // La magia: diamo un punteggio basato su quanto è frequente MA ANCHE su quanto è saturo
          let avgSat = bucket.sat / bucket.count;
          let score = bucket.count * (avgSat + 15); // +15 evita di azzerare del tutto i grigi se l'album è in bianco e nero

          if (score > bestScore) {
            bestScore = score;
            r = Math.round(bucket.r / bucket.count);
            g = Math.round(bucket.g / bucket.count);
            b = Math.round(bucket.b / bucket.count);
          }
        }

        // Fallback di sicurezza se la copertina è 100% nera o bianca
        if (bestScore === 0) { r = 80; g = 80; b = 80; }
        
        const root = document.documentElement;
        root.style.setProperty('--dyn-r', r);
        root.style.setProperty('--dyn-g', g);
        root.style.setProperty('--dyn-b', b);
        
        // Calcolo della luminosità (YIQ)
        let brightness = (r * 299 + g * 587 + b * 114) / 1000;
        
        // Se la luminosità è alta (es. > 150), aggiungiamo la classe per testi scuri
        if (brightness > 154) {
          document.body.classList.add('dynamic-light-bg');
        } else {
          document.body.classList.remove('dynamic-light-bg');
        }

        document.body.classList.add('dynamic-color-active');

      } catch (err) {
        console.warn('Dynamic Color: Impossibile leggere i pixel (blocco CORS).', err);
      }
    };
  }

  _resetDynamicColor() {
    const root = document.documentElement;
    root.style.setProperty('--dyn-r', '232');
    root.style.setProperty('--dyn-g', '132');
    root.style.setProperty('--dyn-b', '58');
    
    // Rimuove ENTRAMBE le classi dal body per disattivare tutto all'istante
    document.body.classList.remove('dynamic-color-active');
    document.body.classList.remove('dynamic-light-bg');

    // Resetta anche l'hero
    const heroSection = document.querySelector('.hero-section');
    if (heroSection) heroSection.style.removeProperty('--hero-dyn-color');
  }

  _updatePlayerUI(state) {
    const playBtn   = document.getElementById('play-btn');
    const fsPlayBtn = document.getElementById('fs-play-btn');

    if (state.isPlaying) {
      playBtn.innerHTML   = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
      if (fsPlayBtn) fsPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } else {
      playBtn.innerHTML   = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>';
      if (fsPlayBtn) fsPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><polygon points="5,3 19,12 5,21"/></svg>';
    }

    const muteBtn   = document.querySelector('.vol-btn');
    const fsMuteBtn = document.querySelector('.fs-vol-btn');
    
    if (state.muted) {
      if (muteBtn) muteBtn.innerHTML     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
      if (fsMuteBtn) fsMuteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    } else {
      if (muteBtn) muteBtn.innerHTML     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      if (fsMuteBtn) fsMuteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    }

    const repeatIcons = ['↩', '↩', '↪¹'];
    document.getElementById('shuffle-btn').classList.toggle('active', state.shuffle);
    document.getElementById('fs-shuffle-btn').classList.toggle('active', state.shuffle);
    document.getElementById('repeat-btn').classList.toggle('active', state.repeat > 0);
    document.getElementById('repeat-btn').textContent = repeatIcons[state.repeat];
    document.getElementById('fs-repeat-btn').classList.toggle('active', state.repeat > 0);
    document.getElementById('fs-repeat-btn').textContent = repeatIcons[state.repeat];
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    }
  }

  _highlightPlayingTrack(track) {
    document.querySelectorAll('.track-row').forEach(row => {
      row.classList.toggle('is-playing', row.dataset.id == track?.id);
    });
  }

  _renderQueue(queue, idx) {
    const el = document.getElementById('queue-list');
    if (!queue.length) {
      el.innerHTML = '<div class="empty-state" style="padding:40px 16px;"><p>Queue is empty</p></div>';
      return;
    }
    el.innerHTML = queue.map((t, i) => {
      const cover    = coverUrl(t.album?.image?.large || t.album?.cover);
      const isActive = i === idx;
      return `
        <div class="queue-item ${isActive ? 'active' : ''}" ondblclick="window.app.playFromList(window.player.queue, ${i})" title="${escHtml(t.title)}">
          <div class="queue-item-num">${i === idx ? '▶' : i + 1}</div>
          <div class="queue-item-art">
            ${cover ? `<img src="${cover}" loading="lazy">` : `<div class="queue-art-placeholder">♪</div>`}
          </div>
          <div class="queue-item-info">
            <div class="queue-item-title">${escHtml(t.title || '')}</div>
            <div class="queue-item-artist">${escHtml(t.artist?.name || '')}</div>
          </div>
          <button class="queue-item-remove" onclick="window.player.removeFromQueue(${i})" title="Remove">✕</button>
        </div>`;
    }).join('');
    const active = el.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // ── KEYBOARD ─────────────────────────────────────────────────
  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch(e.key) {
        case ' ':          e.preventDefault(); player.togglePlay(); break;
        case 'ArrowRight': if (e.ctrlKey || e.metaKey) { e.preventDefault(); player.next(); } break;
        case 'ArrowLeft':  if (e.ctrlKey || e.metaKey) { e.preventDefault(); player.prev(); } break;
        case 'ArrowUp':    e.preventDefault(); player.setVolume(Math.min(1, player.volume + .05)); break;
        case 'ArrowDown':  e.preventDefault(); player.setVolume(Math.max(0, player.volume - .05)); break;
        case 'f': case 'F': if (!e.ctrlKey) this.toggleFullscreen(); break;
        case 'q': case 'Q': this.toggleQueue(); break;
        case 'Escape':      this.closeFullscreen(); break;
        case 'm': case 'M': player.toggleMute(); break;
        case 's': case 'S': if (!e.ctrlKey) player.toggleShuffle(); break;
        case 't': case 'T': this.toggleLyricsView(); break;
      }
    });
  }

  _initDragAndDrop() {
    document.addEventListener('dragstart', e => {
      if (e.target.classList.contains('queue-item')) {
        e.dataTransfer.setData('queueIdx', e.target.dataset.idx);
      }
    });
  }

  // ── TOUCH SUPPORT PER MOBILE ─────────────────────────────────
  _initMobileTouchBars() {
    const bindTouch = (trackId, fillId, thumbId, callback) => {
      const track = document.getElementById(trackId);
      const fill  = document.getElementById(fillId);
      const thumb = document.getElementById(thumbId);
      if (!track) return;

      let isDragging = false;

      const updateUI = (clientX) => {
        const rect    = track.getBoundingClientRect();
        let offsetX   = clientX - rect.left;
        offsetX       = Math.max(0, Math.min(offsetX, rect.width));
        const pct     = offsetX / rect.width;
        if (fill)  fill.style.width  = (pct * 100) + '%';
        if (thumb) thumb.style.left  = (pct * 100) + '%';
        return pct;
      };

      track.addEventListener('touchstart', (e) => {
        isDragging = true;
        updateUI(e.touches[0].clientX);
      }, { passive: false });

      track.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        updateUI(e.touches[0].clientX);
      }, { passive: false });

      track.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        isDragging = false;
        const finalPct = updateUI(e.changedTouches[0].clientX);
        if (callback) callback(finalPct);
      });
    };

    bindTouch('fs-seekbar-track', 'fs-seekbar-fill', 'fs-seekbar-thumb', (pct) => {
      if (window.player) {
        if (typeof window.player.endDragSeek === 'function') {
          window.player.endDragSeek(pct);
        } else if (typeof window.player.seek === 'function') {
          const dur = window.player.currentTrack?.duration || 0;
          window.player.seek(dur > 0 ? pct * dur : pct);
        }
      }
    });

    bindTouch('fs-vol-track', 'fs-vol-fill', 'fs-vol-thumb', (pct) => {
      if (window.player && typeof window.player.setVolume === 'function') {
        window.player.setVolume(pct);
      }
    });
  }

  // ── FULLSCREEN ───────────────────────────────────────────────
  toggleFullscreen() {
    const overlay = document.getElementById('fullscreen-overlay');
    
    if (overlay.classList.contains('open')) return; //se è aperto e si preme il tasto f nuovamente non lo chiude
    
    overlay.classList.toggle('open');
    if (overlay.classList.contains('open')) {
      const fsVideo = document.getElementById('fs-video-art');
      if (fsVideo && window.player && window.player.currentTrack && this._settings.animatedCovers) {
         const track = window.player.currentTrack;
         const currentAlbumId = track.album?.id || track.album?.album_id || track.album_id || 'unknown';
         
         // Avvia la riproduzione solo se il video è nuovo, se è un nuovo album o se non era visibile
         if (fsVideo.style.opacity === '0' || fsVideo.dataset.albumId !== String(currentAlbumId)) {
             fsVideo.dataset.albumId = String(currentAlbumId);
             coverVideoManager.play(fsVideo, track, 'square');
         } else if (fsVideo.paused) {
             fsVideo.play().catch(e => console.warn(e));
         }
      }
      checkMarquee();
    }
  }

  closeFullscreen() { 
    const overlay = document.getElementById('fullscreen-overlay');
    if (!overlay.classList.contains('open')) return;
    overlay.classList.add('closing'); 
    overlay.addEventListener('animationend', () => { overlay.classList.remove('open', 'closing'); }, { once: true }); 
  }

  // ── QUEUE PANEL ──────────────────────────────────────────────
  toggleQueue() {
    const isOpen = document.getElementById('queue-panel').classList.toggle('open');
    
    const queueBtn = document.getElementById('queue_btn');
    if (queueBtn) {
      queueBtn.classList.toggle('active', isOpen);
    }
  }

  async clearMediaCache() {
    modal('Clear Apple Music Cache',
      `<p style="color:var(--text2); font-size:13px; line-height:1.6;">
        This will force clears Animate covers and Apple items id.<br>Your settings and playlists will not be affected.
      </p>`,
      [
        { label: 'Cancel', class: 'btn-ghost', action: 'window.ui.removeModal()' },
        { label: 'Clear Now', class: 'btn-primary', action: 'window.app._doClearCache()' },
      ]
    );
  }

  async _doClearCache() {
    removeModal();
    try {
      // Elimina SOLO i link testuali salvati per le cover animate e gli stream
      const keysToDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('apple_cache_') || k.startsWith('audio_link_')) {
          keysToDelete.push(k);
        }
      }
      keysToDelete.forEach(k => localStorage.removeItem(k));

      await new Promise(r => setTimeout(r, 300));
      toast('Link cache cleared!', 'success');
      this._updateCacheBadge();
    } catch {
      toast('Failed to clear cache', 'error');
    }
  }
}

// Expose globally
window.app    = new App();
window.player = player;

//Apple music
window.appleImporter = AppleImporter;

// ── Mini Player ───────────────────────────────────────────────
(function initMiniPlayer() {
  const SVG_PLAY  = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"/></svg>`;
  const SVG_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  const SVG_LYRICS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/></svg>`;
  const SVG_EXPAND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M15 4h5v5"/><path d="M20 4l-6 6"/><path d="M9 20H4v-5"/><path d="M4 20l6-6"/></svg>`;

  function esc(s = '') {
    return String(s).replace(/[&<>"]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[m]));
  }

  function ensureMiniUi() {
    const miniBar = document.getElementById('mini-bar');
    if (!miniBar) return;

    if (!document.getElementById('mini-top-actions')) {
      const top = document.createElement('div');
      top.id = 'mini-top-actions';
      top.innerHTML = `
        <button id="mini-lyrics-btn" class="mini-top-btn" type="button" title="Lyric">${SVG_LYRICS}</button>
        <button id="mini-expand-btn-top" class="mini-top-btn" type="button" title="Normal screen">${SVG_EXPAND}</button>
      `;
      //miniBar.appendChild(top);
      miniBar.insertBefore(top, miniBar.firstChild);
    }

    if (!document.getElementById('mini-lyrics-panel')) {
      const panel = document.createElement('div');
      panel.id = 'mini-lyrics-panel';
      panel.innerHTML = `
        <div id="mini-lyrics-scroll">
          <div id="mini-lyrics-content">
            <div class="mini-lyrics-empty">Testo non disponibile.</div>
          </div>
        </div>
      `;
      miniBar.appendChild(panel);
    }
  }

  function syncMiniTrackInfo() {
    const track = window.player?.currentTrack;
    const titleEl = document.getElementById('mini-title');
    const artistEl = document.getElementById('mini-artist');
    if (!titleEl || !artistEl) return;

    titleEl.textContent = track?.title || 'No song playing';
    artistEl.textContent = track?.artist?.name || track?.performer?.name || '';
  }

  function syncMiniPlayBtns() {
    const paused = window.player?.audio?.paused !== false;

    const btnA = document.getElementById('mini-play-btn');
    const btnB = document.getElementById('mini-play-btn-bar');

    if (btnA) btnA.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
    if (btnB) btnB.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
  }

  function copyLyricsFromFullscreenDom() {
    const src = document.getElementById('fs-lyrics');
    const dst = document.getElementById('mini-lyrics-content');
    if (!dst) return;

    const lines = src ? Array.from(src.querySelectorAll('.lyric-line')) : [];
    if (!lines.length) {
      dst.innerHTML = `<div class="mini-lyrics-empty">Testo non disponibile.</div>`;
      return;
    }

    dst.innerHTML = lines.map(line => {
      const text = (line.textContent || '').trim() || '♪';
      const active = line.classList.contains('active') ? ' active' : '';
      return `<div class="mini-lyrics-line${active}">${esc(text)}</div>`;
    }).join('');
  }

  function centerActiveMiniLyric() {
    const scroll = document.getElementById('mini-lyrics-scroll');
    const active = document.querySelector('#mini-lyrics-content .mini-lyrics-line.active');
    if (!scroll || !active) return;

    const top = active.offsetTop - (scroll.clientHeight / 2) + (active.clientHeight / 2);
    scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function syncMiniLyrics() {
    copyLyricsFromFullscreenDom();

    const btn = document.getElementById('mini-lyrics-btn');
    const miniBar = document.getElementById('mini-bar');
    if (!btn || !miniBar) return;

    const open = miniBar.classList.contains('show-mini-lyrics');
    btn.classList.toggle('active', open);

    if (open) {
      requestAnimationFrame(centerActiveMiniLyric);
    }
  }

  function toggleMiniLyrics(force) {
    const miniBar = document.getElementById('mini-bar');
    const btn = document.getElementById('mini-lyrics-btn');
    if (!miniBar || !btn) return;

    const next = typeof force === 'boolean'
      ? force
      : !miniBar.classList.contains('show-mini-lyrics');

    miniBar.classList.toggle('show-mini-lyrics', next);
    btn.classList.toggle('active', next);

    if (next) {
      syncMiniLyrics();
    }
  }

  function syncMiniBounds() {
    if (!document.getElementById('shell')?.classList.contains('mini-mode')) return;
    const api = window.electronAPI;
    if (!api?.getBounds) return;

    api.getBounds().then(bounds => {
      if (!bounds) return;
      localStorage.setItem('mini_player_bounds', JSON.stringify({
        w: bounds.width,
        h: bounds.height
      }));
    }).catch(() => {});
  }

  function bindMiniEvents() {
    document.getElementById('mini-lyrics-btn')?.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleMiniLyrics();
    });

    document.getElementById('mini-expand-btn-top')?.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleMiniLyrics(false);
      window.app?.toggleMiniMode?.();
    });

    const miniInfo = document.getElementById('mini-info');
    if (miniInfo) {
      miniInfo.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    window.addEventListener('resize', () => {
      syncMiniBounds();
    });

    if (window.player?.audio) {
      window.player.audio.addEventListener('play', syncMiniPlayBtns);
      window.player.audio.addEventListener('pause', syncMiniPlayBtns);
      window.player.audio.addEventListener('timeupdate', () => {
        if (document.getElementById('mini-bar')?.classList.contains('show-mini-lyrics')) {
          copyLyricsFromFullscreenDom();
        }
      });
    }
  }

  function observeLyricsDom() {
    const fsLyrics = document.getElementById('fs-lyrics');
    if (fsLyrics) {
      const mo = new MutationObserver(() => {
        if (document.getElementById('mini-bar')?.classList.contains('show-mini-lyrics')) {
          syncMiniLyrics();
        }
      });
      mo.observe(fsLyrics, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }

  function boot() {
    ensureMiniUi();
    bindMiniEvents();
    observeLyricsDom();
    syncMiniTrackInfo();
    syncMiniPlayBtns();
    syncMiniLyrics();

    document.addEventListener('player:play', syncMiniPlayBtns);
    document.addEventListener('player:pause', syncMiniPlayBtns);

    const originalUpdateNowPlaying = window.app?._updateNowPlaying?.bind(window.app);
    if (originalUpdateNowPlaying && !window.app._miniPatchedNowPlaying) {
      window.app._miniPatchedNowPlaying = true;
      window.app._updateNowPlaying = function(track) {
        const result = originalUpdateNowPlaying(track);
        syncMiniTrackInfo();
        syncMiniPlayBtns();
        if (document.getElementById('mini-bar')?.classList.contains('show-mini-lyrics')) {
          syncMiniLyrics();
        }
        return result;
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();


export { App };