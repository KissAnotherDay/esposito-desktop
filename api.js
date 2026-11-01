// api.js — Direct connection to Qobuz API (No Cloudflare Worker)

// --- CREDENTIALS ---
export let QOBUZ_APP_ID = localStorage.getItem('qobuz_app_id') || "";
export let QOBUZ_APP_SECRET = localStorage.getItem('qobuz_app_secret') || "";
export let QOBUZ_USER_TOKEN = localStorage.getItem('qobuz_user_token') || "";
const QOBUZ_BASE = "https://www.qobuz.com/api.json/0.2";

export function setCredentials(id, secret, token) {
  QOBUZ_APP_ID = id;
  QOBUZ_APP_SECRET = secret;
  QOBUZ_USER_TOKEN = token;
  localStorage.setItem('qobuz_app_id', id);
  localStorage.setItem('qobuz_app_secret', secret);
  localStorage.setItem('qobuz_user_token', token);
}

export function clearCredentials() {
  QOBUZ_APP_ID = "";
  QOBUZ_APP_SECRET = "";
  QOBUZ_USER_TOKEN = "";
  localStorage.removeItem('qobuz_app_id');
  localStorage.removeItem('qobuz_app_secret');
  localStorage.removeItem('qobuz_user_token');
}

export function isAuthenticated() {
  return QOBUZ_APP_ID && QOBUZ_APP_SECRET && QOBUZ_USER_TOKEN;
}

// Obsolete variables kept to prevent import errors in app.js
export let API_BASE = 'direct_connection';
export function setApiBase(url) {}
export async function apiFetch() {}

// ── CORE FETCH ──────────────────────────────────────────────
export async function qobuzGet(endpoint, params = {}, signal) {
  const url = new URL(`${QOBUZ_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { 
    if (v != null) url.searchParams.append(k, v); 
  });

  const headers = {
    "X-App-Id": QOBUZ_APP_ID,
    "X-User-Auth-Token": QOBUZ_USER_TOKEN,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115.0.0.0 Safari/537.36"
  };

  const r = await fetch(url.toString(), { headers, signal });
  if (!r.ok) {
    throw Object.assign(new Error(`Qobuz Error ${r.status}`), { status: r.status });
  }
  return r.json();
}

// ── SEARCH ──────────────────────────────────────────────────
export async function searchTracks(q, limit = 20, offset = 0, signal) {
  const d = await qobuzGet("catalog/search", { query: q, type: "tracks", limit, offset }, signal);
  return d?.tracks?.items || [];
}

export async function searchAlbums(q, limit = 20, offset = 0, signal) {
  const d = await qobuzGet("catalog/search", { query: q, type: "albums", limit, offset }, signal);
  return d?.albums?.items || [];
}

export async function searchArtists(q, limit = 10, offset = 0, signal) {
  const d = await qobuzGet("catalog/search", { query: q, type: "artists", limit, offset }, signal);
  return d?.artists?.items || [];
}

export async function searchAll(q, signal) {
  const [tracks, albums, artists] = await Promise.allSettled([
    searchTracks(q, 20, 0, signal),
    searchAlbums(q, 15, 0, signal),
    searchArtists(q, 15, 0, signal),
  ]);
  return {
    tracks: tracks.value || [],
    albums: albums.value || [],
    artists: artists.value || [],
  };
}

// ── ALBUM ───────────────────────────────────────────────────
export async function getAlbum(id, signal) {
  const cleanId = String(id).replace(/^q:/, '');
  return await qobuzGet("album/get", { album_id: cleanId }, signal);
}

// ── ARTIST ──────────────────────────────────────────────────
export async function getArtist(id, signal) {
  let cleanId = String(id).replace(/^q:/, '');
  
  // Slug resolution: if it's not a numeric ID
  if (!/^\d+$/.test(cleanId)) {
    const trailingId = cleanId.match(/[-_](\d+)$/);
    if (trailingId) {
      cleanId = trailingId[1];
    } else {
      const decoded = decodeURIComponent(cleanId).replace(/-/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const artists = await searchArtists(decoded, 1, 0, signal);
      if (!artists[0]?.id) throw new Error('Artist not found');
      cleanId = String(artists[0].id);
    }
  }

  // Fetch artist and full discography (lowered limit to 150 to avoid timeouts on direct client)
  const data = await qobuzGet("artist/get", { artist_id: cleanId, extra: "albums", limit: 500 }, signal);

  // Separate primary releases from appearances (feat., collabs, etc.)
  if (data?.albums?.items) {
    const artistId = String(data.id);
    const own = [];
    const appearances = [];

    for (const album of data.albums.items) {
      const primaryId = String(album.artist?.id ?? '');
      if (primaryId === artistId) {
        own.push(album);
      } else {
        appearances.push(album);
      }
    }

    data.albums.items = own;           // Main discography
    data.appearances = appearances;    // Feat. / Collabs
  }

  return data;
}

// TOP TRACKS

export async function getArtistTopTracks(artistId, limit = 10, offset = 0, signal) {
  const cleanId = String(artistId).replace(/^q:/, '');
  const d = await qobuzGet("artist/page", { artist_id: cleanId, limit, offset }, signal);
  const items = (d?.top_tracks || []).slice(offset, offset + limit);

  return items.map(t => {
    const normalizedArtist = t.artist ? {
      ...t.artist,
      name: t.artist.name?.display || t.artist.name || '',
    } : null;

    return transformTrack({
      ...t,
      artist: normalizedArtist,
      performer: normalizedArtist,
      maximum_bit_depth: t.audio_info?.maximum_bit_depth,
      maximum_sampling_rate: t.audio_info?.maximum_sampling_rate,
      track_number: t.physical_support?.track_number,
      media_number: t.physical_support?.media_number,
      album: t.album ? {
        ...t.album,
        version: t.album.version || '',
      } : null,
    });
  });
}

// ── TRACK / STREAM ──────────────────────────────────────────
export async function getTrackInfo(id, signal) {
  const cleanId = String(id).replace(/^q:/, '');
  return await qobuzGet("track/get", { track_id: cleanId }, signal);
}

export async function getStreamUrl(trackId, qualityId = '7', signal) {
  const cleanId = String(trackId).replace(/^q:/, '');
  const unixTs = Math.floor(Date.now() / 1000);
  
  // Exact string required to generate Qobuz's signature
  const secretStr = `trackgetFileUrlformat_id${qualityId}intentstreamtrack_id${cleanId}${unixTs}${QOBUZ_APP_SECRET}`;
  
  // IPC call to main.js to get the MD5 hash natively
  const requestSig = await window.electronAPI.getMD5(secretStr);

  const d = await qobuzGet("track/getFileUrl", {
    track_id: cleanId,
    format_id: qualityId,
    intent: "stream",
    request_ts: unixTs,
    request_sig: requestSig
  }, signal);

  if (!d?.url) throw new Error('No stream URL available');
  return d;
}

// ── FAVORITES ───────────────────────────────────────────────
export async function getFavoriteTracks(limit = 200, signal) {
  const d = await qobuzGet("favorite/getUserFavorites", { type: "tracks", limit }, signal);
  return d?.tracks?.items || [];
}

export async function getFavoriteAlbums(limit = 100, signal) {
  const d = await qobuzGet("favorite/getUserFavorites", { type: "albums", limit }, signal);
  return d?.albums?.items || [];
}

export async function getFavoriteArtists(limit = 100, signal) {
  const d = await qobuzGet("favorite/getUserFavorites", { type: "artists", limit }, signal);
  return d?.artists?.items || [];
}

// ── PLAYLISTS ────────────────────────────────────────────────
export async function getPlaylist(id, signal) {
  return await qobuzGet("playlist/get", { playlist_id: id, limit: 500, extra: "tracks" }, signal);
}

// ── FEATURED ────────────────────────────────────────────────
export async function getFeatured(type = 'new-releases-full', limit = 12, country = null, signal) {
  try {
    const d = await qobuzGet("album/getFeatured", { type, limit }, signal);
    return d?.albums?.items || [];
  } catch (e) {
    console.warn("Featured load error:", e);
    return [];
  }
}

// ── RECOMMENDED TRACKS ──────────────────────────────────────
export async function getRecommendedTracks(limit = 12, country = null, signal) {
  try {
    // 1. Fetch the most streamed albums
    const d = await qobuzGet("album/getFeatured", { type: "most-streamed", limit }, signal);
    const albums = d?.albums?.items || [];
    if (!albums.length) return [];
    
    // 2. Fetch album details in parallel
    const promises = albums.slice(0, limit).map(a => getAlbum(a.id, signal));
    const fullAlbums = await Promise.all(promises);
    
    // 3. Extract the top track from each album for the recommendations playlist
    const tracks = [];
    for (const fa of fullAlbums) {
       if (fa && fa.tracks && fa.tracks.items && fa.tracks.items.length > 0) {
         tracks.push(transformTrack(fa.tracks.items[0], { 
           title: fa.title, image: fa.image, id: fa.id, artist: fa.artist 
         }));
       }
    }
    return tracks;
  } catch (e) {
    console.warn("Could not load recommended tracks:", e);
    return [];
  }
}

// ── GENRES ──────────────────────────────────────────────────
export async function getGenres(signal) {
  const d = await qobuzGet("genre/list", {}, signal);
  return d?.genres?.items || [];
}

// ── DOWNLOAD ────────────────────────────────────────────────
// Returns all stream URLs for an album then triggers zip download via JSZip
export async function downloadAlbum(album, tracks, qualityId = '7', onProgress) {
  const results = [];
  for (let i = 0; i < tracks.length; i++) {
    try {
      const data = await getStreamUrl(tracks[i].id || tracks[i].originalId, qualityId);
      results.push({ track: tracks[i], url: data.url, idx: i });
      if (onProgress) onProgress(i + 1, tracks.length);
    } catch(e) {
      console.warn('Skipped track', tracks[i].id, e);
    }
  }
  return results;
}

// ── USER INFO ────────────────────────────────────────────────
export async function getUserInfo(signal) {
  return await qobuzGet("user/get", {}, signal);
}

// ── UTILS ────────────────────────────────────────────────────
export function coverUrl(url, size = '600') {
  if (!url) return null;
  if (url.startsWith('http')) return url.replace(/_\d+\.jpg$/, `_${size}.jpg`);
  return url;
}

export function formatDur(s) {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

export function mapQuality(track) {
  if (!track) return 'LOSSLESS';
  const sr = track.maximum_sampling_rate;
  const bd = track.maximum_bit_depth;
  if (sr > 96 || bd > 24) return 'HI_RES_LOSSLESS';
  if (bd >= 24) return 'HI_RES_LOSSLESS';
  if (bd >= 16) return 'LOSSLESS';
  return 'HIGH';
}

export function qualityLabel(q) {
  return { HI_RES_LOSSLESS:'Hi-Res', LOSSLESS:'FLAC', HIGH:'MP3', LOW:'MP3' }[q] || 'FLAC';
}

export function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function sortByDate(items) {
  return [...items].sort((a, b) => {
    // 1. Primary criterion: Release date
    const da = a.release_date_original || a.release_date || '0000-00-00';
    const db = b.release_date_original || b.release_date || '0000-00-00';
    
    const dateCompare = db.localeCompare(da);
    
    // 2. If release dates are identical (e.g., both 2024)
    if (dateCompare === 0) {
      const idA = a.qobuz_id || 0;
      const idB = b.qobuz_id || 0;
      
      // Compare by ID to reverse order if needed
      if (idB > idA) {
        return 1;  // Places newer album (higher ID) first
      } else if (idA > idB) {
        return -1; // Keeps older album afterwards
      }
      return 0;
    }
    
    return dateCompare;
  });
}

export function partitionReleases(items) {
  const albums = [], eps = [], singles = [];
  
  for (const item of items) {
    const type = (item.album_type || '').toLowerCase();
    const count = item.tracks_count || 0;

    // Apply rule based on track count (if available)
    if (count >= 1 && count <= 3) {
      singles.push(item); // 1-3 tracks: Singles
    } else if (count >= 4 && count <= 6) {
      eps.push(item);     // 4-6 tracks: EPs
    } else if (count > 6) {
      albums.push(item);  // 6+ tracks: Albums
    } else {
      // Safety fallback: if track count is missing, use Qobuz metadata
      if (type === 'ep') eps.push(item);
      else if (type === 'single') singles.push(item);
      else albums.push(item);
    }
  }
  
  return { 
    albums: sortByDate(albums), 
    eps: sortByDate(eps), 
    singles: sortByDate(singles) 
  };
}

export function transformTrack(t, albumOverride = null) {
  const albumData = albumOverride || t.album || null;
  
  return {
    id: t.id,
    title: t.title,
    duration: t.duration,
    artist: t.performer || t.artist,
    artists: t.artists || [],
    album: albumData ? {
      ...albumData,
      version: albumData.version || t.album?.version || '',
    } : null,
    audioQuality: mapQuality(t),
    explicit: t.parental_warning || false,
    trackNumber: t.track_number,
    volumeNumber: t.media_number || 1,
    isrc: t.isrc,
    originalId: t.id,
    provider: 'qobuz',
    _raw: t,
    maximum_bit_depth: t.maximum_bit_depth || t.bit_depth,
    maximum_sampling_rate: t.maximum_sampling_rate || t.sampling_rate,
  };
}