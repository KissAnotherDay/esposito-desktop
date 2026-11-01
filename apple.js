// apple.js — Apple Music Animated Artwork Web Module (Direct Local Connection)

let appleTokenCache = null;
let appleTokenExp = 0;

// Keep only pending requests in memory to avoid overlapping them
const _pendingRequests = new Map();

// Add a prefix to recognize them in localStorage
const cacheKey = (...parts) => 'apple_cache_' + parts.join('||');

const cleanStr = (s) => (s || '').toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const cleanStrBase = (s) => (s || '').toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const albumScore = (appleAlbum, targetAlbum) => {
    if (appleAlbum === targetAlbum) return 100;
    const knownSuffixes = ['deluxe', 'deluxe edition', 'expanded edition', 'remastered', 'anniversary edition', 'bonus tracks', 'special edition'];
    for (const suffix of knownSuffixes) {
        if (appleAlbum === `${targetAlbum} ${suffix}`) return 55;
    }
    if (appleAlbum.startsWith(targetAlbum)) {
        const extra = appleAlbum.slice(targetAlbum.length).trim().split(/\s+/).length;
        return Math.max(1, 45 - extra * 10);
    }
    if (appleAlbum.includes(targetAlbum)) return 15;
    if (targetAlbum.includes(appleAlbum)) return 10;
    return 0;
};

// ── LOCAL APPLE TOKEN EXTRACTION (VIA ELECTRON BACKEND) ──
async function getAppleToken() {
    if (appleTokenCache && Date.now() < appleTokenExp) return appleTokenCache;
    
    try {
        // Ask main.js to scrape the token for us
        const token = await window.electronAPI.getAppleToken();
        
        if (token) {
            appleTokenCache = token;
            appleTokenExp = Date.now() + (3600 * 1000); // Expires in 1 hour
            return appleTokenCache;
        }
    } catch (e) { 
        console.error("IPC communication error for Apple Token:", e); 
    }
    return null;
}

// ── DIRECT APPLE API FETCH ──
async function appleApiFetch(url) {
    const token = await getAppleToken();
    if (!token) throw new Error("Apple Token not available");
    
    try {
        // Delegate the work to main.js to bypass CORS and Forbidden Header restrictions
        const data = await window.electronAPI.appleApiFetch(url, token);
        return data;
    } catch (e) {
        // If the error is 404, it just means Apple doesn't have the resource
        if (e.message.includes('404')) {
            console.log(`ℹ️ [Apple] No resource found (404) for: ${url}`);
            return null; // Return null without crashing the loop
        }
        // Throw normal exceptions for 500 or network issues
        throw e;
    }
}

export async function getAppleAlbumId(artistName, albumTitle) {
    const key = cacheKey('id', cleanStr(artistName), cleanStr(albumTitle));
    
    // 1. Search in Persistent Normal Cache
    const cached = localStorage.getItem(key);
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    if (_pendingRequests.has(key)) return _pendingRequests.get(key);

    const request = (async () => {
        try {
            const targetArtist = cleanStr(artistName);
            const targetAlbum  = cleanStr(albumTitle);

            const findBestMatch = (data) => {
                const albums = data?.results?.albums?.data || [];
                const allResources = [...albums]; // Removed songs to prevent track ID mismatch
                const specialEditionWords = ['deluxe', 'expanded', 'remastered', 'anniversary', 'special', 'bonus', 'atto'];
                let best = null;

                allResources.forEach(r => {
                    const attr        = r.attributes || {};
                    const appleArtist = cleanStr(attr.artistName || '');
                    const appleAlbumRaw   = cleanStrBase(attr.name || attr.collectionName || '');
                    const appleAlbumClean = cleanStr(attr.name || attr.collectionName || '');

                    const artistMatch = appleArtist.includes(targetArtist) || targetArtist.includes(appleArtist);
                    if (!artistMatch || !r.id) return;

                    let score = albumScore(appleAlbumClean, targetAlbum);
                    const targetHasSpecial = specialEditionWords.some(w => targetAlbum.includes(w));
                    const appleHasSpecial  = specialEditionWords.some(w => appleAlbumRaw.includes(w));
                    if (!targetHasSpecial && appleHasSpecial) score = Math.min(score, 5);

                    if (score > 0) {
                        const targetWords = targetAlbum.split(/\s+/).length;
                        const appleWords  = appleAlbumClean.split(/\s+/).length;
                        if (targetWords === appleWords) score += 20;
                    }
                    if (score > 0 && (!best || score > best.score)) {
                        best = { id: r.id, score };
                    }
                });
                return best ? [best.id] : [];
            };

            let query = encodeURIComponent(`${artistName} ${albumTitle}`);
            let data  = await appleApiFetch(`https://api.music.apple.com/v1/catalog/it/search?term=${query}&types=albums&limit=25`);
            let matches = data ? findBestMatch(data) : [];

            if (matches.length === 0) {
                query   = encodeURIComponent(albumTitle);
                data    = await appleApiFetch(`https://api.music.apple.com/v1/catalog/it/search?term=${query}&types=albums&limit=25`);
                matches = data ? findBestMatch(data) : [];
            }
            const result = matches.length > 0 ? matches : null;
            
            // 2. Save the result in Persistent Normal Cache
            if (result) localStorage.setItem(key, JSON.stringify(result));
            
            return result;
        } catch (e) {
            return null;
        } finally {
            _pendingRequests.delete(key);
        }
    })();
    _pendingRequests.set(key, request);
    return request;
}

export async function getAnimatedArtwork(albumIds, type = 'tall') {
    if (!albumIds) return null;
    const ids = Array.isArray(albumIds) ? albumIds : [albumIds];
    const key = cacheKey('art', ids.join(','), type);
    
    // 1. Search in Persistent Normal Cache
    const cached = localStorage.getItem(key);
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    if (_pendingRequests.has(key)) return _pendingRequests.get(key);

    const request = (async () => {
        let result = null;
        try {
            for (const id of ids) {
                try {
                    const json = await appleApiFetch(`https://amp-api.music.apple.com/v1/catalog/it/albums/${id}?extend=editorialVideo`);
                    if (!json) continue; // Skip if 404
                    
                    const item  = json.data?.[0];
                    const editorialVideo = item?.attributes?.editorialVideo;
                    if (editorialVideo) {
                        const videoData = type === 'square'
                            ? (editorialVideo.motionDetailSquare || editorialVideo.motionSquareVideo1x1)
                            : (editorialVideo.motionDetailTall   || editorialVideo.motionArtistFullscreen16x9);
                        if (videoData?.video) {
                            const finalUrl = Array.isArray(videoData.video) ? videoData.video[0] : videoData.video;
                            result = finalUrl;
                            break;
                        }
                    }
                } catch (e) {}
            }
        } finally {
            // 2. Save the video link in Persistent Cache
            if (result) localStorage.setItem(key, JSON.stringify(result));
            _pendingRequests.delete(key);
        }
        return result;
    })();
    _pendingRequests.set(key, request);
    return request;
}

// --- NEW ARTIST FUNCTIONS ---

export async function getAppleArtistId(artistName) {
    const targetArtist = cleanStr(artistName);
    const key = cacheKey('artist_id', targetArtist);
    
    // 1. Search in Cache
    const cached = localStorage.getItem(key);
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    if (_pendingRequests.has(key)) return _pendingRequests.get(key);

    const request = (async () => {
        let result = null;
        try {
            const query = encodeURIComponent(artistName);
            const data = await appleApiFetch(`https://api.music.apple.com/v1/catalog/it/search?term=${query}&types=artists&limit=15`);
            if (!data) return null;
            
            const artists = data.results?.artists?.data || [];
            for (const r of artists) {
                // Verify that the type is actually "artists"
                if (r.type === 'artists') {
                    const appleArtistClean = cleanStr(r.attributes?.name || '');
                    // Verify if the name matches or is included
                    if (appleArtistClean === targetArtist || appleArtistClean.includes(targetArtist) || targetArtist.includes(appleArtistClean)) {
                        result = r.id;
                        break;
                    }
                }
            }
            if (result) localStorage.setItem(key, JSON.stringify(result));
        } catch (e) {
            console.warn("Apple artist search error:", e);
        } finally {
            _pendingRequests.delete(key);
        }
        return result;
    })();
    _pendingRequests.set(key, request);
    return request;
}

// ARTIST IMAGE FROM APPLE
export async function getAppleArtistImage(artistName) {
    if (!artistName) return null;
    const targetArtist = cleanStr(artistName);
    const key = cacheKey('artist_image', targetArtist);
    
    // 1. Search in Cache
    const cached = localStorage.getItem(key);
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    if (_pendingRequests.has(key)) return _pendingRequests.get(key);

    const request = (async () => {
        let result = null;
        try {
            const query = encodeURIComponent(artistName);
            const data = await appleApiFetch(`https://api.music.apple.com/v1/catalog/it/search?term=${query}&types=artists&limit=15`);
            if (data) {
                const artists = data.results?.artists?.data || [];
                
                for (const r of artists) {
                    if (r.type === 'artists') {
                        const appleArtistClean = cleanStr(r.attributes?.name || '');
                        if (appleArtistClean === targetArtist || appleArtistClean.includes(targetArtist) || targetArtist.includes(appleArtistClean)) {
                            const artwork = r.attributes?.artwork;
                            if (artwork && artwork.url) {
                                // Replaces Apple Music width and height parameters
                                let finalUrl = artwork.url.replace('{w}', '600').replace('{h}', '600');
                                finalUrl = finalUrl.replace('bb.jpg', '.jpg').replace('ac.jpg', '.jpg').replace('bb.webp', '.jpg').replace('ac.webp','.jpg');
                                result = finalUrl;
                                break;
                            }
                        }
                    }
                }
            }
            if (result) localStorage.setItem(key, JSON.stringify(result));
        } catch (e) {
            console.warn("Error fetching Apple artist image:", e);
        } finally {
            _pendingRequests.delete(key);
        }
        return result;
    })();
    _pendingRequests.set(key, request);
    return request;
}

export async function getAppleArtistVideo(artistId) {
    if (!artistId) return null;
    const key = cacheKey('artist_video', artistId);
    
    const cached = localStorage.getItem(key);
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    if (_pendingRequests.has(key)) return _pendingRequests.get(key);

    const request = (async () => {
        let result = null;
        try {
            const json = await appleApiFetch(`https://amp-api.music.apple.com/v1/catalog/it/artists/${artistId}?extend=editorialVideo`);
            if (!json) return null;
            
            const item = json.data?.[0];
            const editorialVideo = item?.attributes?.editorialVideo;
            
            // Search for the video parameter among the various formats available for artists
            if (editorialVideo) {
                const videoData = editorialVideo.motionArtistFullscreen16x9 || editorialVideo.motionDetailTall || editorialVideo.motionDetailSquare;
                if (videoData?.video) {
                    result = Array.isArray(videoData.video) ? videoData.video[0] : videoData.video;
                }
            }
            if (result) localStorage.setItem(key, JSON.stringify(result));
        } catch (e) {
            console.warn("Error fetching Apple artist video:", e);
        } finally {
            _pendingRequests.delete(key);
        }
        return result;
    })();
    _pendingRequests.set(key, request);
    return request;
}

function attachSmoothCanvas(video) {
  if (video._smooth || !video.parentElement) return;
  video._smooth = true;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = video.style.cssText;           // stessa posizione/dimensione del video
  canvas.style.zIndex = String((parseInt(video.style.zIndex) || 0) + 1);
  canvas.style.pointerEvents = 'none';
  video.after(canvas);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // il canvas segue l'opacity che il manager imposta sul video (play/stop)
  const syncOpacity = () => { canvas.style.opacity = video.style.opacity; };
  new MutationObserver(syncOpacity).observe(video, { attributes: true, attributeFilter: ['style'] });
  syncOpacity();

  const tmpA = document.createElement('canvas');
  const tmpB = document.createElement('canvas');

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!W || !H || !vw || !vh) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.imageSmoothingQuality = 'high';

    // crop "cover"
    const scale = Math.max(W / vw, H / vh);
    let sw = W / scale, sh = H / scale;
    let sx = (vw - sw) / 2, sy = (vh - sh) / 2;

    // riduzione a gradini (max 2x per passo)
    let src = video, tmps = [tmpA, tmpB], t = 0;
    let curW = sw, curH = sh;
    while (curW / 2 > W) {
      const dst = tmps[t++ % 2];
      const nw = Math.ceil(curW / 2), nh = Math.ceil(curH / 2);
      dst.width = nw; dst.height = nh;
      const c = dst.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, sx, sy, curW, curH, 0, 0, nw, nh);
      src = dst; sx = 0; sy = 0; curW = nw; curH = nh;
    }
    ctx.drawImage(src, sx, sy, curW, curH, 0, 0, W, H);
  };

  let running = false;
  const loop = () => {
    if (!video.isConnected) { running = false; return; }
    draw();
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };
  video.addEventListener('playing', () => {
    if (running) return;
    running = true;
    loop();
  });
  video.addEventListener('emptied', () => { running = false; });
}

class CoverVideoManager {
  constructor() {
    this.players = new Map();
  }

  async play(videoEl, trackOrAlbum, type = 'square', onPlayCb = null) {
    if (!videoEl || !videoEl.id) return;
    const token = Symbol();
    this.stop(videoEl);
    this.players.set(videoEl.id, { hls: null, token });
    if (type === 'square') attachSmoothCanvas(videoEl);
    if (!trackOrAlbum) return;

    try {
      const artist = trackOrAlbum.artistName || trackOrAlbum.artist?.name || trackOrAlbum.performer?.name || '';
      let title = trackOrAlbum.albumTitle || trackOrAlbum.album?.title || trackOrAlbum.album_title || trackOrAlbum.title || '';
      const version = trackOrAlbum.albumVersion || trackOrAlbum.album?.version || trackOrAlbum.version || '';
      if (version && !title.includes(version)) {
         title = `${title} ${version}`;
      }
      const appleId = await getAppleAlbumId(artist, title);
      if (!appleId || this.players.get(videoEl.id)?.token !== token) return;
      const videoUrl = await getAnimatedArtwork(appleId, type);
      if (!videoUrl || this.players.get(videoEl.id)?.token !== token) return;

      const startPlay = () => {
         if (this.players.get(videoEl.id)?.token !== token) return;
         videoEl.muted = true;
         videoEl.play().catch(e => console.warn('Autoplay interrupted:', e));
         videoEl.style.opacity = '1';
         if (onPlayCb) onPlayCb();
      };

      if (videoUrl.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({ 
            debug: false,
            // Prevents the library from limiting the resolution based on the physical size of the div on screen
            capLevelToPlayerSize: false,
            autoStartLoad: false
            });
            
            this.players.get(videoEl.id).hls = hls;
            hls.loadSource(videoUrl);
            hls.attachMedia(videoEl);
        
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                if (data.levels && data.levels.length > 0) {
                    // Cerca il livello Full HD (1080p) o il massimo disponibile fino a 1080
                    let targetIndex = data.levels.length - 1; // Di base, il massimo
                    let bestMatch = -1;
                    
                    for (let i = 0; i < data.levels.length; i++) {
                        // Seleziona la risoluzione più alta che sia minore o uguale a 1080
                        if (data.levels[i].height <= 1080) {
                            bestMatch = i;
                        }
                    }
                    
                    if (bestMatch !== -1) {
                        targetIndex = bestMatch;
                    }
                    
                    // Forza il livello bloccandolo (currentLevel)
                    hls.startLevel = targetIndex;
                    hls.currentLevel = targetIndex;
                }
                hls.startLoad();
                startPlay();
            });
        } else {
            videoEl.src = videoUrl;
            videoEl.addEventListener('loadedmetadata', startPlay, { once: true });
        }
    } catch (err) {
      console.warn('[CoverVideoManager] Error:', err);
    }
  }

  // ARTIST PLAY

  async playArtistVideo(videoEl, artistName, onPlayCb = null) {
    if (!videoEl || !videoEl.id) return;
    const token = Symbol();
    this.stop(videoEl);
    this.players.set(videoEl.id, { hls: null, token });
    if (!artistName) return;

    try {
      const appleId = await getAppleArtistId(artistName);
      if (!appleId || this.players.get(videoEl.id)?.token !== token) return;
      const videoUrl = await getAppleArtistVideo(appleId);
      if (!videoUrl || this.players.get(videoEl.id)?.token !== token) return;

      const startPlay = () => {
         if (this.players.get(videoEl.id)?.token !== token) return;
         videoEl.muted = true;
         videoEl.play().catch(e => console.warn('Autoplay interrupted:', e));
         videoEl.style.opacity = '1';
         if (onPlayCb) onPlayCb();
      };

      if (videoUrl.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({ debug: false, capLevelToPlayerSize: false });
            this.players.get(videoEl.id).hls = hls;
            hls.loadSource(videoUrl);
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                /*if (data.levels && data.levels.length > 0) {
                    hls.nextLevel = data.levels.length - 1;
                }*/
                startPlay();
            });
            
        } else {
            videoEl.src = videoUrl;
            videoEl.addEventListener('loadedmetadata', startPlay, { once: true });
        }
    } catch (err) {
      console.warn('[CoverVideoManager] Artist Video Error:', err);
    }
  }

  stop(videoEl) {
    if (!videoEl || !videoEl.id) return;
    const state = this.players.get(videoEl.id);
    if (state) {
      if (state.hls) state.hls.destroy();
      this.players.delete(videoEl.id);
    }
    videoEl.style.opacity = '0';
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }
}
export const coverVideoManager = new CoverVideoManager();