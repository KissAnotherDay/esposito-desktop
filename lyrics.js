export const LyricsManager = {
    activeLyrics: [],
    currentIndex: -1,
    isEnabled: false,

    get fsContainer() { return document.getElementById('fs-lyrics'); },
    get stdContainer() { return document.getElementById('standard-lyrics-container'); },

    init() {},

    async load(artist, title, album, duration) {
        this.reset();
        
        const searchMsg = '<div class="lyric-line" style="opacity:0.5;">Searching lyrics...</div>';
        if (this.fsContainer) this.fsContainer.innerHTML = searchMsg;
        if (this.stdContainer) this.stdContainer.innerHTML = searchMsg;

        try {
            const cleanTitle = title.replace(/\s*[\(\[]?(feat\.?|ft\.?|featuring)\s+[^)\]]*[\)\]]?/ig, '').trim();
            const q = encodeURIComponent(artist + ' ' + cleanTitle);
            
            let syncedData = null;
            let plainData = null;
            let isInstrumental = false;

            // --- TENTATIVO 1: lrclib.net (Ricerca Esatta) ---
            const getParams = new URLSearchParams({ artist_name: artist, track_name: cleanTitle });
            try {
                const getRes = await fetch(`https://lrclib.net/api/get?${getParams.toString()}`);
                if (getRes.ok) {
                    const d = await getRes.json();
                    if (d.instrumental) isInstrumental = true;
                    if (d.syncedLyrics) syncedData = d.syncedLyrics;
                    else if (d.plainLyrics) plainData = d.plainLyrics;
                }
            } catch (err) { console.error("[Lyrics] lrclib get error:", err); }

            // --- TENTATIVO 2: lrc.red (Testi Sync Parola-Parola) ---
            if (!syncedData && !isInstrumental) {
                try {
                    const lrcRedRes = await fetch(`https://lrc.red/search.json?q=${q}`, {
                        headers: { 'X-Client-ID': 'Esposito-HIFI-App' }
                    });
                    if (lrcRedRes.ok) {
                        const lrcRedData = await lrcRedRes.json();
                        if (lrcRedData.hits && lrcRedData.hits.length > 0) {
                            let match = lrcRedData.hits.find(h => h.title.toLowerCase() === cleanTitle.toLowerCase());
                            const targetHit = match || lrcRedData.hits[0];
                            
                            if (targetHit && targetHit.isrc) {
                                const lrcRes = await fetch(`https://lrc.red/s/${targetHit.isrc}.lrc`, {
                                    headers: { 'X-Client-ID': 'Esposito-HIFI-App' }
                                });
                                if (lrcRes.ok) {
                                    const lrcText = await lrcRes.text();
                                    if (/\[\d{2}:\d{2}/.test(lrcText)) {
                                        syncedData = lrcText;
                                    } else if (!plainData) {
                                        plainData = lrcText;
                                    }
                                }
                            }
                        }
                    }
                } catch (err) { console.error("[Lyrics] lrc.red search error:", err); }
            }

            // --- TENTATIVO 3: lrclib.net (Ricerca Fuzzy) ---
            if (!syncedData && !isInstrumental) {
                try {
                    const searchRes = await fetch(`https://lrclib.net/api/search?q=${q}`);
                    if (searchRes.ok) {
                        const searchData = await searchRes.json();
                        if (Array.isArray(searchData) && searchData.length > 0) {
                            let match = searchData.find(item => item.trackName.toLowerCase() === cleanTitle.toLowerCase() && item.syncedLyrics);
                            if (!match) match = searchData.find(item => item.syncedLyrics);
                            
                            if (match) {
                                syncedData = match.syncedLyrics;
                            } else if (!plainData) {
                                let pMatch = searchData.find(item => item.trackName.toLowerCase() === cleanTitle.toLowerCase() && item.plainLyrics);
                                if (!pMatch) pMatch = searchData.find(item => item.plainLyrics);
                                if (pMatch) plainData = pMatch.plainLyrics;
                            }
                        }
                    }
                } catch (err) { console.error("[Lyrics] lrclib search error:", err); }
            }

            if (isInstrumental) {
                this.showMessage("♫ Instrumental ♫");
            } else if (syncedData) {
                this.parseAndRender(syncedData);
            } else if (plainData) {
                this.renderPlain(plainData);
            } else {
                throw new Error("No data found across all services");
            }

        } catch (err) {
            console.error("[Lyrics] Error:", err);
            this.showMessage("Lyrics not available");
        }
    },

    // --- 2. PARSING AVANZATO WORD-BY-WORD ---
    parseAndRender(lrcString) {
        this.activeLyrics = [];
        const lines = lrcString.split('\n');
        
        const timeReg = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;

        lines.forEach(line => {
            const match = line.match(timeReg);
            if (match) {
                const min = parseInt(match[1]);
                const sec = parseInt(match[2]);
                const msStr = match[3] || "0";
                let ms = parseInt(msStr);
                if (msStr.length === 1) ms *= 100;
                else if (msStr.length === 2) ms *= 10;
                
                const lineTime = min * 60 + sec + (ms / 1000);
                const restOfLine = line.replace(timeReg, '');

                // Cerca i tag parola per parola <mm:ss.xx>testo
                const wordMatches = [...restOfLine.matchAll(/<(\d{2}):(\d{2})(?:\.(\d{1,3}))?>([^<]*)/g)];

                if (wordMatches.length > 0) {
                    const words = wordMatches.map(wm => {
                        const wMin = parseInt(wm[1]);
                        const wSec = parseInt(wm[2]);
                        const wMsStr = wm[3] || "0";
                        let wMs = parseInt(wMsStr);
                        if (wMsStr.length === 1) wMs *= 100;
                        else if (wMsStr.length === 2) wMs *= 10;
                        const wTime = wMin * 60 + wSec + (wMs / 1000);
                        return { time: wTime, text: wm[4] };
                    });
                    const text = words.map(w => w.text).join('');
                    if (text.trim()) {
                        this.activeLyrics.push({ time: lineTime, text, words });
                    }
                } else {
                    // Fallback a riga singola se non ci sono tag parola
                    const text = restOfLine.replace(/<[^>]*>/g, '').trim();
                    if (text) {
                        this.activeLyrics.push({ time: lineTime, text, words: null });
                    }
                }
            }
        });

        if (this.activeLyrics.length > 0) {
            this.renderSynced();
        } else {
            this.renderPlain(lrcString);
        }
    },

    // --- 3. RENDERING ---
    renderSynced() {
        const html = this.activeLyrics.map((line) => {
            if (line.words) {
                const wordsHtml = line.words.map(w => `<span class="lyric-word" data-time="${w.time}">${w.text}</span>`).join('');
                return `<div class="lyric-line" data-time="${line.time}">${wordsHtml}</div>`;
            } else {
                return `<div class="lyric-line" data-time="${line.time}">${line.text}</div>`;
            }
        }).join('');

        const bindContainer = (container) => {
            if (!container) return;
            container.innerHTML = html;
            container.scrollTop = 0;
            
            Array.from(container.children).forEach((child, idx) => {
                child.onclick = () => {
                    if (window.player && window.player.audio) {
                        window.player.audio.currentTime = this.activeLyrics[idx].time;
                        if (window.player.audio.paused) window.player.audio.play();
                    }
                };
            });
        };

        bindContainer(this.fsContainer);
        bindContainer(this.stdContainer);
    },

    renderPlain(text) {
        this.activeLyrics = [];
        const cleanText = text.replace(/<[^>]*>/g, '').replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
        const html = cleanText.split('\n')
            .filter(line => !/^\[[a-z]+:.*\]$/i.test(line))
            .map(line => `<div class="lyric-line no-sync">${line}</div>`)
            .join('');
            
        if (this.fsContainer) { this.fsContainer.innerHTML = html; this.fsContainer.scrollTop = 0; }
        if (this.stdContainer) { this.stdContainer.innerHTML = html; this.stdContainer.scrollTop = 0; }
    },

    showMessage(msg) {
        const html = `<div class="lyric-line" style="opacity:0.5; cursor:default;">${msg}</div>`;
        this.activeLyrics = [];
        if (this.fsContainer) { this.fsContainer.innerHTML = html; this.fsContainer.scrollTop = 0; }
        if (this.stdContainer) { this.stdContainer.innerHTML = html; this.stdContainer.scrollTop = 0; }
    },

    reset() {
        this.activeLyrics = [];
        this.currentIndex = -1;
        if(this.fsContainer) { this.fsContainer.innerHTML = ''; this.fsContainer.scrollTop = 0; }
        if(this.stdContainer) { this.stdContainer.innerHTML = ''; this.stdContainer.scrollTop = 0; }
    },

    // --- 4. SYNC DINAMICO PAROLA PER PAROLA ---
    sync(currentTime) {
        if (!this.activeLyrics.length) return;

        // Ultima riga con time <= currentTime
        let activeIdx = -1;
        for (let i = 0; i < this.activeLyrics.length; i++) {
            if (this.activeLyrics[i].time <= currentTime) activeIdx = i;
            else break;
        }

        const containers = [this.fsContainer, this.stdContainer];

        // --- Cambio riga ---
        if (activeIdx !== this.currentIndex) {
            this.currentIndex = activeIdx;

            containers.forEach(container => {
                if (!container) return;

                // Pulisce riga attiva precedente e ogni parola rimasta accesa
                // (righe passate, o righe future dopo un seek all'indietro)
                container.querySelectorAll('.lyric-line.active')
                    .forEach(el => el.classList.remove('active'));
                container.querySelectorAll('.lyric-word.active')
                    .forEach(el => el.classList.remove('active'));

                const visible = container.offsetParent !== null;

                if (activeIdx === -1) {
                    if (visible) container.scrollTo({ top: 0, behavior: 'smooth' });
                    return;
                }

                const currentLine = container.children[activeIdx];
                if (!currentLine) return;
                currentLine.classList.add('active');
                if (visible) {
                    currentLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        }

        // --- Parole della riga attiva (ogni tick) ---
        if (activeIdx < 0) return;
        const lineObj = this.activeLyrics[activeIdx];
        if (!lineObj || !lineObj.words) return;

        containers.forEach(container => {
            const line = container && container.children[activeIdx];
            if (!line) return;
            const spans = line.querySelectorAll('.lyric-word');
            for (let i = 0; i < lineObj.words.length; i++) {
                const span = spans[i];
                if (!span) continue;
                span.classList.toggle('active', lineObj.words[i].time <= currentTime);
            }
        });
    }
};