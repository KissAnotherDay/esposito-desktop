// apple_import.js — Gestisce l'importazione con controllo Album

import { searchTracks, transformTrack, API_BASE } from './api.js';
import { modal, removeModal, progressDialog, toast } from './ui.js';

/**
 * Normalizza stringhe per il confronto.
 * Rimuove: punteggiatura, "feat", anni, "remaster", "deluxe", "edition", "single".
 */
const normalize = (str = '') => {
  return str
    .toLowerCase()
    // STEP 1: Decomposizione accenti PRIMA di tutto
    // "Ge\u00f4lier" -> "Geolier", accenti vari -> base ASCII
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // STEP 2: Rimozione feat e varianti album
    .replace(/\(feat\..*?\)/gi, '')
    .replace(/\[feat\..*?\]/gi, '')
    .replace(/remaster(ed|ing)?.*$/gi, '')
    .replace(/\s(deluxe|edition|version|expanded|anniversary|tour|mix)\b.*/gi, '')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\s-\s(remaster|remix|live|acoustic|radio|edit|version|mix).*/gi, '')
    // STEP 3: Solo lettere, numeri e spazi
    .replace(/[^a-z0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Estrae solo il primo artista per la ricerca (migliora i risultati su Qobuz)
 */
const getSearchArtist = (str = '') => {
  return str.split(/,|&|feat\.|ft\.|featuring|\swith\s/i)[0].trim();
};

/**
 * Controlla se due stringhe si "sovrappongono" abbastanza.
 * Gestisce casi come "The Beatles" vs "Beatles" o titoli leggermente diversi.
 */
const isSimilar = (a = '', b = '') => {
  if (!a || !b) return false;
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
};

/**
 * Somiglianza titolo con penalità per sottostringa su titoli molto diversi in lunghezza.
 * Es: "hustle" (6 chars) dentro "nascono e muoiono hustle" (24 chars) → penalizzato.
 * Ritorna: 1.0 = match perfetto, 0.5 = sottostringa accettabile, 0 = non matcha.
 */
const titleSimilarity = (a = '', b = '') => {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (!na.includes(nb) && !nb.includes(na)) return 0;
  // È una sottostringa — penalizza in base alla differenza di lunghezza
  const longer  = Math.max(na.length, nb.length);
  const shorter = Math.min(na.length, nb.length);
  const ratio   = shorter / longer;
  // Se il titolo più corto è meno del 60% del più lungo → penalità severa
  return ratio >= 0.6 ? 0.8 : ratio >= 0.35 ? 0.4 : 0.1;
};

/**
 * Normalizzazione "leet speak": converte sostituzioni comuni di cifre con lettere.
 * "bl4ir" → "blair", "s3cr3t" → "secret", "l1l" → "lil"
 */
const normalizeLeet = (str = '') => {
  return str
    .replace(/4/g, 'a')
    .replace(/3/g, 'e')
    .replace(/1/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/7/g, 't');
};

/**
 * Estrae il nome artista da un campo Qobuz che può essere stringa o oggetto {id, name}
 */
const extractArtistName = (field) => {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.name || '';
};

/**
 * Controlla se l'artista Apple compare nel campo "performers" di Qobuz.
 * Il campo performers è una stringa lunga tipo:
 * "Geolier, MainArtist - Lazza, FeaturedArtist - ..."
 * Questo cattura i casi in cui l'artista è featured e non è in performer.name
 */
const artistInPerformers = (artistName, performersStr = '') => {
  if (!artistName || !performersStr) return false;
  return normalize(performersStr).includes(normalize(artistName));
};

/**
 * Calcola un punteggio di somiglianza.
 * Ritorna un numero (0 = scartato, >0 = candidato valido).
 *
 * Strategia:
 * - Titolo: OBBLIGATORIO
 * - Artista: controlla performer.name, album.artist.name E il campo performers (stringa lunga)
 *   per gestire i casi in cui l'artista Apple è featured su Qobuz
 */
const calculateScore = (appleTrack, qobuzRawTrack, debug = false) => {
  // Dati Apple
  const aTitle      = normalize(appleTrack.attributes?.name || '');
  const aArtistRaw  = getSearchArtist(appleTrack.attributes?.artistName || '');
  const aArtist     = normalize(aArtistRaw);
  const aAlbum      = normalize(appleTrack.attributes?.albumName || '');
  const aDurSec     = (appleTrack.attributes?.durationInMillis || 0) / 1000;

  // Dati Qobuz (raw, prima di transformTrack)
  const qTitle      = normalize(qobuzRawTrack.title || '');
  // performer.name = artista principale della traccia
  const qPerformer  = normalize(extractArtistName(qobuzRawTrack.performer));
  // album.artist.name = artista principale dell'album
  const qAlbumArtist = normalize(extractArtistName(qobuzRawTrack.album?.artist));
  // performers = stringa lunga con TUTTI gli artisti (main + featured)
  const qPerformersStr = qobuzRawTrack.performers || '';
  const qAlbum      = normalize(qobuzRawTrack.album?.title || '');
  const qDurSec     = qobuzRawTrack.duration || 0;

  if (debug) {
    console.log(`  [SCORE] Apple: "${aTitle}" / "${aArtist}" / album:"${aAlbum}" (${aDurSec}s)`);
    console.log(`  [SCORE] Qobuz: "${qTitle}" / performer:"${qPerformer}" / albumArtist:"${qAlbumArtist}" / album:"${qAlbum}" (${qDurSec}s)`);
  }

  // 1. CHECK OBBLIGATORIO: Titolo deve matchare
  const tSim = titleSimilarity(appleTrack.attributes?.name || '', qobuzRawTrack.title || '');
  if (tSim === 0) return 0;

  // Score base proporzionale alla qualità del match titolo:
  // 80 = match perfetto/buono, 32 = sottostringa accettabile, 8 = sottostringa dubbia
  let score = Math.round(80 * tSim);
  if (score < 10) return 0; // Sottostringa troppo debole: scarta

  // 2. Artista match — tre livelli:
  //    a) performer.name (artista principale traccia) — match diretto, massimo bonus
  //    b) album.artist.name — match su artista album
  //    c) performers (stringa lunga) — cattura i featured artist
  if (isSimilar(aArtist, qPerformer)) {
    score += 60; // Artista principale: pieno punteggio
  } else if (isSimilar(aArtist, qAlbumArtist)) {
    score += 50; // Artista album: quasi uguale
  } else if (artistInPerformers(aArtistRaw, qPerformersStr)) {
    score += 30; // Artista è featured: punteggio ridotto ma NON scartiamo
  } else {
    // L'artista non compare da nessuna parte: scarta
    if (debug) console.log(`  [SCORE] → DISCARDED: artist "${aArtist}" non trovato in nessun campo`);
    return 0;
  }

  // 3. Album match (bonus priorità alta)
  if (aAlbum && qAlbum && isSimilar(aAlbum, qAlbum)) {
    score += 50;
  }

  // 4. Durata simile (+/- 5 secondi)
  if (aDurSec > 0 && qDurSec > 0 && Math.abs(aDurSec - qDurSec) <= 5) {
    score += 20;
  } else if (aDurSec > 0 && qDurSec > 0 && Math.abs(aDurSec - qDurSec) > 30) {
    score -= 20;
  }

  if (debug) console.log(`  [SCORE] → final score: ${score}`);
  return score;
};


/**
 * Mostra un dialog per la selezione manuale di un brano.
 * Si attiva quando il match automatico fallisce.
 * Restituisce una Promise che risolve con il track scelto o null (salta).
 */
const showManualPicker = (appleTrack, initialResults) => {
  return new Promise((resolve) => {
    const aTitle   = appleTrack.attributes?.name || '—';
    const aArtist  = appleTrack.attributes?.artistName || '—';
    const aAlbum   = appleTrack.attributes?.albumName || '—';
    const aCover   = appleTrack.attributes?.artwork?.url
      ?.replace('{w}', '48').replace('{h}', '48') || '';

    const pickerId = 'manual-picker-' + Date.now();

    const renderResults = (tracks) => {
      const container = document.getElementById(pickerId + '-results');
      if (!container) return;
      if (!tracks || tracks.length === 0) {
        container.innerHTML = '<p style="color:var(--text2);font-size:13px;text-align:center;padding:16px 0;">No results found.</p>';
        return;
      }
      container.innerHTML = tracks.map((t, idx) => {
        const cover = t.album?.image?.small || t.album?.image?.thumbnail || '';
        const title  = t.title || '—';
        const artist = extractArtistName(t.performer) || extractArtistName(t.album?.artist) || '—';
        const album  = t.album?.title || '—';
        const dur    = t.duration ? `${Math.floor(t.duration/60)}:${String(t.duration%60).padStart(2,'0')}` : '';
        const qual   = (t.maximum_bit_depth >= 24) ? '·Hi-Res' : (t.maximum_bit_depth >= 16 ? '·FLAC' : '');
        return `
          <div data-idx="${idx}"
            style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;
                   cursor:pointer;transition:background .15s;"
            onmouseenter="this.style.background='var(--bg2)'"
            onmouseleave="this.style.background='transparent'"
            onclick="window._manualPickerSelect(${idx})">
            ${cover ? `<img src="${cover}" style="width:40px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0;">` : '<div style="width:40px;height:40px;border-radius:4px;background:var(--bg2);flex-shrink:0;"></div>'}
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:var(--text1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
              <div style="font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${artist} — ${album}</div>
            </div>
            <div style="font-size:11px;color:var(--text2);flex-shrink:0;">${dur}${qual}</div>
          </div>`;
      }).join('');
    };

    // Salva i risultati correnti in closure per la selezione
    let currentTracks = [...initialResults];

    // Esponi la funzione di selezione globalmente (viene ripulita dopo)
    window._manualPickerSelect = (idx) => {
      const chosen = currentTracks[idx];
      cleanup();
      resolve(chosen ? transformTrack(chosen) : null);
    };

    const cleanup = () => {
      delete window._manualPickerSelect;
      const el = document.getElementById(pickerId);
      if (el) el.remove();
    };

    // Costruisce il modal inline (non usa modal() per avere controllo totale)
    const overlay = document.createElement('div');
    overlay.id = pickerId;
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
      display:flex;align-items:center;justify-content:center;padding:16px;`;

    overlay.innerHTML = `
      <div style="background:var(--bg1);border:1px solid var(--border);border-radius:14px;
                  width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;">

        <!-- Header: brano Apple da trovare -->
        <div style="padding:16px 18px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">
            No automatic matches — select manually
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            ${aCover ? `<img src="${aCover}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : ''}
            <div style="min-width:0;">
              <div style="font-size:14px;font-weight:700;color:var(--text1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${aTitle}</div>
              <div style="font-size:12px;color:var(--text2);">${aArtist} · ${aAlbum}</div>
            </div>
          </div>
        </div>

        <!-- Search bar per ri-cercare -->
        <div style="padding:10px 18px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;">
          <input id="${pickerId}-input" type="text" value="${aTitle} ${aArtist}"
            placeholder="Search on Qobuz..."
            style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text1);
                   padding:8px 12px;border-radius:8px;font-size:13px;outline:none;"
            onkeydown="if(event.key==='Enter') window._manualPickerSearch()">
          <button onclick="window._manualPickerSearch()"
            style="background:var(--accent);color:#fff;border:none;border-radius:8px;
                   padding:8px 14px;font-size:13px;cursor:pointer;flex-shrink:0;">Search</button>
        </div>

        <!-- Lista risultati scrollabile -->
        <div id="${pickerId}-results"
          style="flex:1;overflow-y:auto;padding:8px 8px;min-height:120px;">
        </div>

        <!-- Footer -->
        <div style="padding:10px 18px;border-top:1px solid var(--border);flex-shrink:0;display:flex;justify-content:flex-end;gap:8px;">
          <button onclick="window._manualPickerSkip()"
            style="background:transparent;border:1px solid var(--border);color:var(--text2);
                   border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;">
            Skip this song
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    renderResults(currentTracks);

    // Funzione di ri-ricerca
    window._manualPickerSearch = async () => {
      const q = document.getElementById(pickerId + '-input')?.value?.trim();
      if (!q) return;
      const container = document.getElementById(pickerId + '-results');
      if (container) container.innerHTML = '<p style="color:var(--text2);font-size:13px;text-align:center;padding:16px 0;">Search in progress...</p>';
      try {
        const res = await searchTracks(q, 20, 0);
        currentTracks = res || [];
        renderResults(currentTracks);
      } catch {
        if (container) container.innerHTML = '<p style="color:var(--text2);font-size:13px;text-align:center;padding:16px 0;">Search error.</p>';
      }
    };

    window._manualPickerSkip = () => {
      cleanup();
      resolve(null);
    };

    // Focus sull'input
    setTimeout(() => document.getElementById(pickerId + '-input')?.select(), 80);
  });
};

export const AppleImporter = {

  showModal() {
    modal('Import from Apple Music',
      `<p style="color:var(--text2); font-size:13px; line-height:1.5; margin-bottom:16px;">
        Paste Apple Music link or Playlist ID.<br>
        V4 Algorithm: Match on Title, Artist, Album and Duration.
      </p>
      <input id="apple-link-input" type="text" placeholder="Link Apple Music..."
        style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text1);
               padding:10px 14px;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"
        onkeydown="if(event.key==='Enter') window.appleImporter.process()">`,
      [
        { label: 'Cancel', class: 'btn-ghost',   action: 'window.ui.removeModal()' },
        { label: 'Import', class: 'btn-primary', action: 'window.appleImporter.process()' },
      ]
    );
    setTimeout(() => document.getElementById('apple-link-input')?.focus(), 80);
  },

  async process() {
    const input = document.getElementById('apple-link-input');
    let link = input?.value?.trim();
    if (!link) return;

    let storefront = 'it';
    let playlistId = link;

    if (link.includes('apple.com')) {
      const match = link.match(/apple\.com\/([a-z]{2})\/playlist\/.*?([a-zA-Z0-9.\-]+)(\?|$)/);
      if (match) {
        storefront = match[1];
        playlistId = match[2];
      }
    } else if (link.includes('/')) {
      playlistId = link.split('?')[0].split('/').pop();
    }

    removeModal();
    const dlg = progressDialog('Apple Playlist Analysis...');

    const safeFetchApi = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        return await res.json();
      } catch (e) { return null; }
    };

    try {
      // 1. RECUPERO DATI APPLE
      let initialUrl = `${API_BASE}/apple/playlist?playlist_id=${playlistId}&country=${storefront}`;
      let plData = await safeFetchApi(initialUrl);

      if (!plData || !plData.data) throw new Error('Playlist not found.');

      const playlistName = plData.data[0].attributes.name;
      let appleTracks = plData.data[0].relationships.tracks.data || [];
      let nextUrl = plData.data[0].relationships.tracks.next;

      while (nextUrl) {
        if (document.getElementById('dl-progress-text'))
          document.getElementById('dl-progress-text').textContent = `read ${appleTracks.length} songs...`;

        const fullUrl = nextUrl.startsWith('http') ? nextUrl : `https://api.music.apple.com${nextUrl}`;
        const res = await safeFetchApi(`${API_BASE}/apple/playlist?playlist_id=_&next_url=${encodeURIComponent(fullUrl)}`);
        if (res && res.data) {
          appleTracks.push(...res.data);
          nextUrl = res.next;
        } else { nextUrl = null; }
      }

      // 2. SETUP PLAYLIST LOCALE
      let localPls = JSON.parse(localStorage.getItem('local_playlists') || '[]');
      let newPl = {
        id: 'local_' + Date.now(),
        name: playlistName,
        tracks: [],
      };
      localPls.push(newPl);

      const saveToDisk = () => {
        const current = JSON.parse(localStorage.getItem('local_playlists') || '[]');
        const idx = current.findIndex(p => p.id === newPl.id);
        if (idx !== -1) {
          current[idx] = newPl;
        } else {
          current.push(newPl);
        }
        localStorage.setItem('local_playlists', JSON.stringify(current));
      };
      saveToDisk();

      // 3. RICERCA CON PUNTEGGIO (ALBUM CHECK)
      let foundCount = 0;

      for (let i = 0; i < appleTracks.length; i++) {
        const aTrack = appleTracks[i];
        dlg.update(i + 1, appleTracks.length);

        const aTitle        = aTrack.attributes?.name || '';
        const aSearchArtist = getSearchArtist(aTrack.attributes?.artistName || '');
        const primaryQuery  = `${aTitle} ${aSearchArtist}`.trim();

        try {
          // STRATEGIA MULTI-QUERY:
          // 1. "Titolo Artista" — query principale
          // 2. "Titolo" solo — fallback se l'artista inquina i risultati
          // 3. "Artista Titolo" — ordine inverso, a volte Qobuz risponde meglio
          // Raccogliamo fino a 20 risultati unici, poi scorriamo tutti.

          // Versione "leet" dell'artista per nomi tipo "bl4ir" → "blair"
          const aSearchArtistLeet = normalizeLeet(aSearchArtist);
          const aTitleLeet        = normalizeLeet(aTitle);
          const hasLeet = aSearchArtistLeet !== aSearchArtist || aTitleLeet !== aTitle;

          const queries = [
            `${aTitle} ${aSearchArtist}`.trim(),                          // "hustle capo plaza"
            aTitle,                                                        // "hustle"
            `${aSearchArtist} ${aTitle}`.trim(),                          // "capo plaza hustle"
            ...(hasLeet ? [
              `${aTitleLeet} ${aSearchArtistLeet}`.trim(),                // "bl4ir" → "blair"
              aSearchArtistLeet,                                           // solo artista leet
            ] : []),
          ].filter((q, idx, arr) => q && arr.indexOf(q) === idx);         // rimuovi duplicati

          const seenIds = new Set();
          let rawResults = [];

          for (const q of queries) {
            if (rawResults.length >= 20) break;
            try {
              const res = await searchTracks(q, 20, 0);
              if (res && res.length > 0) {
                for (const r of res) {
                  if (!seenIds.has(r.id)) {
                    seenIds.add(r.id);
                    rawResults.push(r);
                  }
                }
              }
              // Piccola pausa tra query multiple per non hammering l'API
              await new Promise(r => setTimeout(r, 150));
            } catch { /* ignora errori su query singola */ }
          }

          if (rawResults.length > 0) {
            const scoredResults = rawResults
              .map(rawTrack => ({
                raw: rawTrack,
                score: calculateScore(aTrack, rawTrack, false),
              }))
              .filter(item => item.score > 0)
              .sort((a, b) => b.score - a.score);

            if (scoredResults.length > 0) {
              const topScore   = scoredResults[0].score;
              const secondScore = scoredResults[1]?.score || 0;
              // LOW CONFIDENCE: trigger manuale se
              //   a) punteggio basso (< 130 = titolo+artista ma nessun album match)
              //   b) oppure ci sono 2+ candidati con score molto vicini (ambiguità)
              const isAmbiguous = scoredResults.length > 1 && (topScore - secondScore) < 20;
              const isLowScore  = topScore < 130;

              if (isLowScore || isAmbiguous) {
                console.log(`[?] "${aTitle}" — ambiguous match (top:${topScore}, second:${secondScore}), ask for confirmation`);
                const allCandidates = scoredResults.map(s => s.raw);
                const chosen = await showManualPicker(aTrack, allCandidates);
                if (chosen) {
                  newPl.tracks.push(chosen);
                  foundCount++;
                  console.log(`[✓ manual] "${aTitle}" → "${chosen.title}"`);
                } else {
                  console.log(`[skip] "${aTitle}" skip from user`);
                }
              } else {
                const winner = transformTrack(scoredResults[0].raw);
                console.log(`[✓ auto] "${aTitle}" → "${winner.title}" by "${winner.artist?.name}" (score: ${topScore})`);
                newPl.tracks.push(winner);
                foundCount++;
              }
            } else {
              console.log(`[✗] "${aTitle}" — ${rawResults.length} results found, none valid`);
              // Nessun match automatico: pausa il dialogo e chiedi all'utente
              const chosen = await showManualPicker(aTrack, rawResults);
              if (chosen) {
                newPl.tracks.push(chosen);
                foundCount++;
                console.log(`[✓ manual] "${aTitle}" → "${chosen.title}"`);
              } else {
                console.log(`[skip] "${aTitle}" skip from user`);
              }
            }
          } else {
            console.log(`[✗] "${aTitle}" — no results from the API`);
            const chosen = await showManualPicker(aTrack, []);
            if (chosen) {
              newPl.tracks.push(chosen);
              foundCount++;
              console.log(`[✓ manual] "${aTitle}" → "${chosen.title}"`);
            }
          }
        } catch (e) {
          console.warn(`Error on "${aTitle}":`, e);
        }

        if (i % 5 === 0) saveToDisk();
        await new Promise(r => setTimeout(r, 200));
      }

      saveToDisk();
      dlg.close();
      toast(`Import completed: ${foundCount}/${appleTracks.length}.`, 'success');

      if (window.app && window.app._loadSidebarPlaylists) {
        await window.app._loadSidebarPlaylists();
        window.app.navigate('playlist', newPl.id);
      }

    } catch (e) {
      dlg.close();
      toast('Error: ' + e.message, 'error');
    }
  }
};