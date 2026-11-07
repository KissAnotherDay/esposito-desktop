// ui.js — Rendering helpers, animations, component builders

import { coverUrl, formatDur, escHtml, qualityLabel, sortByDate, partitionReleases } from './api.js';

// ── ANIMATIONS ───────────────────────────────────────────────
export function fadeIn(el, delay = 0) {
  el.style.opacity = '0';
  el.style.transform = 'translateY(12px)';
  el.style.transition = `opacity .35s ease ${delay}ms, transform .35s ease ${delay}ms`;
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
}

export function staggerFadeIn(parent, selector = '.card, .track-row', baseDelay = 0) {
  const els = parent.querySelectorAll(selector);
  els.forEach((el, i) => fadeIn(el, baseDelay + i * 35));
}

export function ripple(el, e) {
  const r = document.createElement('span');
  r.className = 'ripple-effect';
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  r.style.cssText = `
    position:absolute;border-radius:50%;pointer-events:none;
    width:${size}px;height:${size}px;
    left:${e.clientX - rect.left - size/2}px;
    top:${e.clientY - rect.top - size/2}px;
    background:rgba(232,213,176,.15);
    transform:scale(0);animation:rippleAnim .5s ease-out forwards;
  `;
  el.style.position = 'relative';
  el.style.overflow = 'hidden';
  el.appendChild(r);
  setTimeout(() => r.remove(), 500);
}

// ── SKELETON LOADER ──────────────────────────────────────────
export function skeletonGrid(n = 6) {
  return Array(n).fill(0).map(() => `
    <div class="skeleton-card">
      <div class="skeleton" style="aspect-ratio:1;border-radius:8px;margin-bottom:10px;"></div>
      <div class="skeleton" style="height:13px;border-radius:4px;margin-bottom:6px;"></div>
      <div class="skeleton" style="height:11px;border-radius:4px;width:65%;"></div>
    </div>`).join('');
}

export function skeletonList(n = 5) {
  return Array(n).fill(0).map(() => `
    <div class="track-row skeleton-row" style="pointer-events:none;">
      <div class="skeleton" style="width:32px;height:32px;border-radius:4px;flex-shrink:0;"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
        <div class="skeleton" style="height:13px;border-radius:4px;width:55%;"></div>
        <div class="skeleton" style="height:11px;border-radius:4px;width:35%;"></div>
      </div>
      <div class="skeleton" style="width:36px;height:11px;border-radius:4px;"></div>
    </div>`).join('');
}

// ── CARD COMPONENTS ──────────────────────────────────────────
export function albumCard(album, onClick, onPlay) {
  const img = coverUrl(album.image?.large || album.cover);
  const artist = album.artist?.name || '';
  const year = (album.release_date_original || album.release_date || '').slice(0,4);
  const type = (album.album_type || 'album').toLowerCase();
  const typeLabel = type === 'ep' ? 'EP' : type === 'single' ? 'Single' : '';

  // Hi-Res badge logic
  const depth = parseInt(album.maximum_bit_depth || album.bit_depth || 16, 10);
  const sr = parseFloat(album.maximum_sampling_rate || album.sampling_rate || 44.1);
  const isHiRes = album.hires || album.hires_streamable || (album.audioQuality?.includes('HI_RES')) || (depth >= 24 && sr >= 44.1);
  
  // Force "width: auto !important", "max-width: none" and "object-fit: contain"
  // so the global CSS does not stretch the badge image across the whole card
  const hiResBadge = isHiRes ? `<img src="hi_res_bdge.jpg" alt="Hi-Res" style="position: absolute; top: 8px; left: 8px; height: 32px; width: auto !important; max-width: none !important; object-fit: contain !important; border-radius: 0 !important; z-index: 10; pointer-events: none; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.6));">` : '';

  return `
    <div class="card" data-id="${album.id}" onclick="${onClick}">
      <div class="card-art" style="position: relative;">
        ${img
          ? `<img src="${img}" loading="lazy" alt="${escHtml(album.title)}" onerror="this.outerHTML='<div class=\\'card-placeholder\\'>◉</div>'">`
          : `<div class="card-placeholder">◉</div>`}
        
        <!-- IL BADGE VIENE INSERITO QUI -->
        ${hiResBadge}

        <button class="card-play-btn" onclick="event.stopPropagation();${onPlay}" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
        ${typeLabel ? `<span class="card-type-badge">${typeLabel}</span>` : ''}
      </div>
      <div class="card-title">${escHtml(album.title || '')}${album.version ? ` (${escHtml(album.version)})` : ''}</div>
      <div class="card-sub">${escHtml(artist)}${year ? ` · ${year}` : ''}</div>
    </div>`;
}

export function artistCard(artist, onClick) {
  const img = coverUrl(artist.image?.org || artist.image?.large || artist.picture);
  return `
    <div class="card artist-card" data-id="${artist.id}" onclick="${onClick}">
      <div class="card-art round-art">
        ${img
          ? `<img src="${img}" loading="lazy" alt="${escHtml(artist.name)}" onerror="this.parentNode.innerHTML='<div class=\\'card-placeholder\\'>♪</div>'">`
          : `<div class="card-placeholder">♪</div>`}
        <div class="card-art-shimmer"></div>
      </div>
      <div class="card-title">${escHtml(artist.name || '')}</div>
      <div class="card-sub">Artist</div>
    </div>`;
}

export function trackRow(track, idx, options = {}) {
  const { isPlaying = false, showAlbum = false, showCover = false, queueRef = '[]', onPlay = '' } = options;
  const dur = formatDur(track.duration);
  const artistName = track.artist?.name || track.performer?.name || '';
  const albumTitle = showAlbum ? (track.album?.title || '') : '';
  const img = showCover ? coverUrl(track.album?.image?.large || track.album?.cover) : null;
  
  // ── TRACK QUALITY & HI-RES BADGE LOGIC ───
  let ql = 'LOSSLESS';
  let qualityClass = 'lossless';
  
  const depth = track.maximum_bit_depth || (track.audioQuality?.includes('HI_RES') ? 24 : 16);
  const sr = track.maximum_sampling_rate || 44.1;

  if (track.audioQuality === 'MP3') {
    ql = 'MP3'; 
    qualityClass = 'lossless';
  } else if (depth >= 24) {
    // 24-bit: check the sampling rate
    if (sr >=44.1 || sr> 48.0) { 
      ql = 'HI-RES'; 
      qualityClass = 'hires'; 
    } 
  } else {
    // 16-bit
    ql = 'LOSSLESS'; 
    qualityClass = 'lossless';
  }

  // Create the image badge if the specs are Hi-Res
  const isHiResTrack = parseInt(depth, 10) >= 24 && parseFloat(sr) >= 44.1;
  const hiResBadge = ''; // Hi-Res badge for track rows (currently disabled)

  const explicitBadge = track.explicit ? '<span class="explicit-badge">E</span>' : '';

  return `
    <div class="track-row ${isPlaying ? 'is-playing' : ''}" 
         data-id="${track.id}" 
         onclick="${onPlay || `window.app.playFromList(${queueRef}, ${idx})`}">
      <div class="track-num-cell">
        ${showCover && img
          ? `<div class="track-mini-art">
              <img src="${img}" loading="lazy" onerror="this.style.display='none'">
              <button class="track-play-icon" onclick="event.stopPropagation();${onPlay || `window.app.playFromList(${queueRef}, ${idx})`}" title="Play">
                <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><polygon points="5,3 19,12 5,21"/></svg>
              </button>
            </div>`
    : `<div class="track-num-wrap">
        <span class="track-num">${idx + 1}</span>
        <button class="track-play-icon" onclick="event.stopPropagation();${onPlay || `window.app.playFromList(${queueRef}, ${idx})`}" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
      </div>`}
</div>
      <div class="track-info">
        <div class="track-title-row">
          <span class="track-title">${escHtml(track.title || '')}${hiResBadge}</span>
          ${explicitBadge}
        </div>
        <div class="track-artist-line">
          <span class="track-artist">${escHtml(artistName)}</span>
          ${albumTitle ? `<span class="track-album-name"> · ${escHtml(albumTitle)}</span>` : ''}
        </div>
      </div>
      <span class="track-quality-badge ${qualityClass}">${ql}</span>
      <span class="track-dur">${dur}</span>
      
      <div style="display: flex; align-items: center; gap: 4px;">
        <button class="track-more-btn" title="Add to Playlist" onclick="event.stopPropagation(); window.app.showAddToPlaylist(${JSON.stringify(track).replace(/"/g,'&quot;')})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button class="track-more-btn" onclick="event.stopPropagation();window.app.showTrackMenu(event, ${JSON.stringify(track).replace(/"/g,'&quot;')}, ${idx}, ${queueRef})" title="More">⋯</button>
      </div>
    </div>`;
}

// ── HERO COMPONENTS ──────────────────────────────────────────
export function albumHero(album, tracks) {
  const img = coverUrl(album.image?.large);
  const artist = album.artist;
  const year = (album.release_date_original || album.release_date || '');
  const totalDur = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const type = (album.album_type || 'album').toUpperCase();
  
  const labelName = album.label?.name || album.copyright || '';

  // Hi-Res badge for the hero title (larger: 32px)
  const depth = parseInt(album.maximum_bit_depth || album.bit_depth || (album.audioQuality?.includes('HI_RES') ? 24 : 16), 10);
  const sr = parseFloat(album.maximum_sampling_rate || album.sampling_rate || 44.1);
  const isHiRes = depth >= 24 && sr >= 44.1;
  const hiResBadge = isHiRes ? `<img src="hi_res_bdge.jpg" alt="Hi-Res" title="Hi-Res Audio" style="height: 32px; margin-left: 12px; vertical-align: middle; transform: translateY(-4px);">` : '';

  return `
    <div class="hero-section">
      <div class="hero-bg"></div>
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <div class="hero-art">
          ${img ? `<img src="${img}" alt="${escHtml(album.title)}", draggable=false>` : `<div class="hero-art-placeholder">◉</div>`}
          <div class="hero-art-glow"></div>
        </div>
        <div class="hero-info">
          <!--div class="hero-type-label">${type}</div-->
          
          <h1 class="hero-title">${escHtml(album.title || '')}${album.version ? ` (${escHtml(album.version)})` : ''}${hiResBadge}</h1>
          
          <div class="hero-meta">
            ${artist ? `<span class="hero-artist-link" onclick="window.app.navigate('artist','${artist.id}')">${escHtml(artist.name)}</span>` : ''}
            ${year ? `<span class="hero-dot">·</span><span>${year}</span>` : ''}
            <span class="hero-dot">·</span><span>${tracks.length} tracks</span>
            <span class="hero-dot">·</span><span>${formatDur(totalDur)}</span>
          </div>
          
          ${labelName ? `<div class="hero-record-label" style="font-size: 11px; margin-top: -10px; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 0.05em;">℗ ${escHtml(labelName)}</div>` : ''}

          <div class="hero-actions">
            <button class="btn-play-hero" onclick="window.app.playAlbum('${album.id}')">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>
              Play
            </button>
            <button class="btn-shuffle-hero" onclick="window.app.shuffleAlbum('${album.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
              </svg>
              Shuffle
            </button>
            <button class="btn-icon-hero" onclick="window.app.downloadAlbumUI('${album.id}')" title="Download ZIP">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
            <button class="btn-icon-hero" onclick="window.app.showAlbumMenu(event,'${album.id}')" title="More">⋯</button>
          </div>
        </div>
      </div>
    </div>`;
}

export function artistHero(artist) {
  const img = coverUrl(artist.image?.org || artist.image?.large || artist.picture);
  const name = typeof artist.name === 'string' ? artist.name : artist.name?.display || 'Unknown';

  return `
    <div class="artist-hero-section" style="--hero-img:url('${img || ''}')">
      <div class="artist-hero-bg"></div>
      <div class="artist-hero-overlay"></div>
      <div class="artist-hero-content">
        <div class="artist-avatar">
          ${img ? `<img src="${img}" alt="${escHtml(name)}", draggable=false>` : `<div class="artist-avatar-placeholder", draggable=false>♪</div>`}
        </div>
        <div class="artist-hero-info">
          <!--div class="artist-hero-label">Artist</div-->
          <h1 class="artist-hero-name">${escHtml(name)}</h1>
          <div class="artist-hero-actions">
            <button class="btn-play-hero" onclick="window.app.playArtistTop()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>
              Play Top
            </button>
            <!--button class="btn-ghost-hero" onclick="window.app.followArtist('${artist.id}')">Follow</button-->
          </div>
        </div>
      </div>
    </div>`;
}

// ── CONTEXT MENU ─────────────────────────────────────────────
export function showContextMenu(e, items) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = items.map(item =>
    item.separator
      ? '<div class="ctx-separator"></div>'
      : `<button class="ctx-item ${item.danger ? 'danger' : ''}" onclick="${item.action}">${item.icon ? `<span class="ctx-icon">${item.icon}</span>` : ''}${escHtml(item.label)}</button>`
  ).join('');

  document.body.appendChild(menu);

  // Position
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 16);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  requestAnimationFrame(() => menu.classList.add('open'));

  const close = (ev) => {
    if (!menu.contains(ev.target)) { removeContextMenu(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 50);
}

export function removeContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
}

// ── TOAST ────────────────────────────────────────────────────
export function toast(msg, type = 'info', duration = 3000) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, duration);
}

// ── MODAL ────────────────────────────────────────────────────
export function modal(title, contentHtml, actions = []) {
  removeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <span class="modal-title">${escHtml(title)}</span>
        <button class="modal-close" onclick="window.ui.removeModal()">✕</button>
      </div>
      <div class="modal-body">${contentHtml}</div>
      ${actions.length ? `<div class="modal-actions">${actions.map(a =>
        `<button class="btn ${a.class || 'btn-ghost'}" onclick="${a.action}">${escHtml(a.label)}</button>`
      ).join('')}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) removeModal(); });
}

export function removeModal() {
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.classList.remove('open');
    setTimeout(() => m.remove(), 250);
  });
}

// ── PROGRESS DIALOG ──────────────────────────────────────────
export function progressDialog(title) {
  removeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.id = 'progress-dialog';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:360px;">
      <div class="modal-header"><span class="modal-title">${escHtml(title)}</span></div>
      <div class="modal-body">
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="dl-progress-fill" style="width:0%"></div>
        </div>
        <div class="progress-text" id="dl-progress-text">Preparing...</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="window.ui.removeModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return {
    update(cur, total) {
      const pct = Math.round((cur / total) * 100);
      const fill = document.getElementById('dl-progress-fill');
      const text = document.getElementById('dl-progress-text');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = `${cur} / ${total} tracks (${pct}%)`;
    },
    close() { removeModal(); }
  };
}

// ── SEEKBAR WITH DRAG ────────────────────────────────────────
export function initSeekbar(player) {
  const track = document.getElementById('seekbar-track');
  const fill = document.getElementById('seekbar-fill');
  const thumb = document.getElementById('seekbar-thumb');
  const curTime = document.getElementById('current-time');
  const totTime = document.getElementById('total-time');
  if (!track) return;

  let dragging = false;
  const remaining = (cur, dur) => '-' + formatDur(Math.max(0, (dur || 0) - cur));

  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function updateVisual(pct) {
    fill.style.width = (pct * 100) + '%';
    thumb.style.left = (pct * 100) + '%';
  }

  track.addEventListener('mousedown', e => {
    dragging = true;
    player.startDragSeek();
    const pct = pctFromEvent(e);
    updateVisual(pct);
    curTime.textContent = formatDur(pct * player.duration);
    totTime.textContent = remaining(pct * player.duration, player.duration);
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const pct = pctFromEvent(e);
    updateVisual(pct);
    curTime.textContent = formatDur(pct * player.duration);
  });

  document.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const pct = pctFromEvent(e);
    player.endDragSeek(pct);
    document.body.style.userSelect = '';
  });

  // Update from player
  player.on('timeupdate', ({ current, duration, pct }) => {
    if (!dragging) {
      updateVisual(pct);
      curTime.textContent = formatDur(current);
      totTime.textContent = remaining(current, duration);
      // fullscreen sync
      const fp = document.getElementById('fs-seekbar-fill');
      const ft = document.getElementById('fs-current-time');
      if (fp) fp.style.width = (pct * 100) + '%';
      if (ft) ft.textContent = formatDur(current);
      const ftot = document.getElementById('fs-total-time');
      if (ftot) ftot.textContent = remaining(current, duration);
      const fthumb = document.getElementById('fs-seekbar-thumb');
      if (fthumb) fthumb.style.left = (pct * 100) + '%';
      // mini seek sync
      const mf = document.getElementById('mini-seek-fill');
      if (mf) mf.style.width = (pct * 100) + '%';
    }
  });

  // Fullscreen seekbar
  const fsTrack = document.getElementById('fs-seekbar-track');
  if (fsTrack) {
    let fsDragging = false;
    fsTrack.addEventListener('mousedown', e => {
      fsDragging = true; player.startDragSeek();
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!fsDragging) return;
      const rect = fsTrack.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      document.getElementById('fs-seekbar-fill').style.width = (pct*100)+'%';
      document.getElementById('fs-seekbar-thumb').style.left = (pct*100)+'%';
    });
    document.addEventListener('mouseup', e => {
      if (!fsDragging) return;
      fsDragging = false;
      const rect = fsTrack.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      player.endDragSeek(pct);
      document.body.style.userSelect = '';
    });
  }
}

// ── VOLUME SLIDER (standard player + fullscreen) ─────────────────────────────
export function initVolume(player) {
  // Include the fullscreen controls' IDs in the arrays
  const tracks = [document.getElementById('vol-track'), document.getElementById('fs-vol-track')];
  const fills = [document.getElementById('vol-fill'), document.getElementById('fs-vol-fill')];
  const thumbs = [document.getElementById('vol-thumb'), document.getElementById('fs-vol-thumb')];
  
  let dragging = false;
  let activeTrack = null;

  function update(v) {
    const pct = (v * 100) + '%';
    fills.forEach(f => { if(f) f.style.width = pct; });
    thumbs.forEach(t => { if(t) t.style.left = pct; });
  }

  function setVol(e, track) {
    if (!track) return;
    const rect = track.getBoundingClientRect();
    player.setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  }

  tracks.forEach(track => {
    if (!track) return;
    track.addEventListener('mousedown', e => {
      dragging = true; 
      activeTrack = track; 
      setVol(e, activeTrack);
      document.body.style.userSelect = 'none';
    });
  });

  document.addEventListener('mousemove', e => { 
    if(dragging) setVol(e, activeTrack); 
  });
  
  document.addEventListener('mouseup', () => { 
    dragging = false; 
    activeTrack = null; 
    document.body.style.userSelect = ''; 
  });

  player.on('volumechange', v => update(v));
  player.on('mutechange', () => update(player.volume));
  
  // Set the initial volume on both sliders
  update(player.volume);
}

// ── MARQUEE for long track titles ────────────────────────────
export function checkMarquee() {
  const processMarquee = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    
    const parent = el.parentElement;
    
    // If the text is wider than its container, enable scrolling
    if (el.scrollWidth > parent.clientWidth) {
      // Compute the exact distance to scroll (text width - container width + extra margin)
      const offset = parent.clientWidth - el.scrollWidth - 30;
      el.style.setProperty('--marquee-offset', `${offset}px`);
      el.classList.add('marquee');
    } else {
      // If everything fits, remove the animation and reset the position
      el.classList.remove('marquee');
      el.style.removeProperty('--marquee-offset');
    }
  };

  // Run the check for both players
  processMarquee('now-title');
  processMarquee('fs-title');
}

// Export for global access
window.ui = { removeModal, toast, removeContextMenu, showContextMenu };