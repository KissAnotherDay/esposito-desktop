import { getTrackInfo } from './api.js';

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
            
            let bestLyrics = null;
            let syncLevel = 0; // 0 = test without sync, 1 = sync row, 2 = sync worad a word
            let isInstrumental = false;

            // rate lyric quality
            const evaluateText = (text) => {
                if (!text) return;
                
                // Checks for the presence of word-by-word tags (e.g., <00:12.34>)
                if (/<\d{1,3}:\d{2}/.test(text)) {
                    bestLyrics = text;
                    syncLevel = 2; // Max qaulity, stop the search
                } 
                // Check the tag presence row a row (e.g., [00:12.34])
                else if (syncLevel < 1 && /\[\d{1,3}:\d{2}/.test(text)) {
                    bestLyrics = text;
                    syncLevel = 1; // Let's save, but continue looking for a level 2
                } 
                // Lyric without sync
                else if (syncLevel === 0 && !bestLyrics) {
                    bestLyrics = text; // Let's save this as a last resource
                }
            };

            const track = window.player?.currentTrack;
            let isrc = track?.isrc || track?._raw?.isrc;

            // --- ATTEMPT 1: lrclib.net (Exact search)---
            try {
                const getParams = new URLSearchParams({ artist_name: artist, track_name: cleanTitle });
                const getRes = await fetch(`https://lrclib.net/api/get?${getParams.toString()}`);
                if (getRes.ok) {
                    const d = await getRes.json();
                    if (d.instrumental) isInstrumental = true;
                    if (d.syncedLyrics) evaluateText(d.syncedLyrics);
                    else if (d.plainLyrics) evaluateText(d.plainLyrics);
                }
            } catch (err) { console.error("[Lyrics] lrclib get error:", err); }

            // --- ATTEMPT 2: lrc.red (Exact search with ISRC) ---
            if (syncLevel < 2 && !isInstrumental && isrc) {
                try {
                    const lrcRedRes = await fetch(`https://lrc.red/s/${isrc}.json`, {
                        headers: { 'X-Client-ID': 'Esposito-HIFI-App' }
                    });
                    if (lrcRedRes.ok) {
                        const lrcRedData = await lrcRedRes.json();
                        if (lrcRedData.files && lrcRedData.files.lrc) {
                            const lrcFetch = await fetch(lrcRedData.files.lrc);
                            if (lrcFetch.ok) {
                                evaluateText(await lrcFetch.text());
                            }
                        }
                    }
                } catch (err) { console.error("[Lyrics] lrc.red isrc error:", err); }
            }

            // --- ATTEMPT 3: lrclib.net (Search textual fuzzy) ---
            if (syncLevel < 2 && !isInstrumental) {
                try {
                    const searchRes = await fetch(`https://lrclib.net/api/search?q=${q}`);
                    if (searchRes.ok) {
                        const searchData = await searchRes.json();
                        if (Array.isArray(searchData) && searchData.length > 0) {
                            let match = searchData.find(item => item.trackName.toLowerCase() === cleanTitle.toLowerCase() && item.syncedLyrics);
                            if (!match) match = searchData.find(item => item.syncedLyrics);
                            
                            if (match) {
                                evaluateText(match.syncedLyrics);
                            } else if (syncLevel === 0) {
                                let pMatch = searchData.find(item => item.trackName.toLowerCase() === cleanTitle.toLowerCase() && item.plainLyrics);
                                if (!pMatch) pMatch = searchData.find(item => item.plainLyrics);
                                if (pMatch) evaluateText(pMatch.plainLyrics);
                            }
                        }
                    }
                } catch (err) { console.error("[Lyrics] lrclib search error:", err); }
            }

            // --- ATTEMPT 4: lrc.red (Search textual fuzzy)) ---
            if (syncLevel < 2 && !isInstrumental) {
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
                                    evaluateText(await lrcRes.text());
                                }
                            }
                        }
                    }
                } catch (err) { console.error("[Lyrics] lrc.red search error:", err); }
            }

            // --- FINAL RENDERING ---
            if (isInstrumental) {
                this.showMessage("♫ Instrumental ♫");
            } else if (syncLevel >= 1 && bestLyrics) {
                this.parseAndRender(bestLyrics);
            } else if (syncLevel === 0 && bestLyrics) {
                this.renderPlain(bestLyrics);
            } else {
                throw new Error("No data found across all services");
            }

        } catch (err) {
            console.error("[Lyrics] Error:", err);
            this.showMessage("Lyrics not available");
        }
    },

    // --- 2. ADVANCED WORD-BY-WORD PARSING ---
    parseAndRender(lrcString) {
        this.activeLyrics = [];
        const lines = lrcString.split('\n');

        const toSec = (m, s, frac) => {
            const f = frac || '0';
            return parseInt(m) * 60 + parseInt(s) + parseInt(f) / Math.pow(10, f.length);
        };

        const timeReg = /\[(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?\]/;
        const wordReg = /<(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?>/g;

        lines.forEach(line => {
            const match = line.match(timeReg);
            if (!match) return;

            const lineTime = toSec(match[1], match[2], match[3]);
            const restOfLine = line.replace(timeReg, '');

            const words = [];
            let lastIndex = 0;
            let pendingTime = lineTime;
            let m;
            wordReg.lastIndex = 0;

            while ((m = wordReg.exec(restOfLine)) !== null) {
                const before = restOfLine.slice(lastIndex, m.index);
                if (before) words.push({ time: pendingTime, text: before });
                pendingTime = toSec(m[1], m[2], m[3]);
                lastIndex = wordReg.lastIndex;
            }
            const tail = restOfLine.slice(lastIndex);
            if (tail) words.push({ time: pendingTime, text: tail });

            const hasWordTags = restOfLine.search(/<\d{1,3}:\d{2}/) !== -1;
            const text = words.map(w => w.text).join('').replace(/<[^>]*>/g, '');

            if (!text.trim()) return;

            if (hasWordTags) {
                
                const merged = [];
                words.forEach(w => {
                    if (merged.length && !w.text.trim()) {
                        merged[merged.length - 1].text += w.text;
                    } else {
                        merged.push({ ...w });
                    }
                });
               
                for (let i = 1; i < merged.length; i++) {
                    if (merged[i].time < merged[i - 1].time) merged[i].time = merged[i - 1].time;
                }
                this.activeLyrics.push({ time: lineTime, text, words: merged });
            } else {
                this.activeLyrics.push({ time: lineTime, text: text.trim(), words: null });
            }
        });

        if (this.activeLyrics.length > 0) this.renderSynced();
        else this.renderPlain(lrcString);
    },

    // --- 3. RENDERING ---
    renderSynced() {
        const html = this.activeLyrics.map((line) => {
            if (line.words) {
                const wordsHtml = line.words.map(w => `<span class="lyric-word" style="white-space:pre-wrap" data-time="${w.time}">${w.text}</span>`).join('');
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

    // --- 4. DYNAMIC WORD-BY-WORD SYNC ---
    sync(currentTime) {
        if (!this.activeLyrics.length) return;

        // Last line with time <= currentTime
        let activeIdx = -1;
        for (let i = 0; i < this.activeLyrics.length; i++) {
            if (this.activeLyrics[i].time <= currentTime) activeIdx = i;
            else break;
        }

        const containers = [this.fsContainer, this.stdContainer];

        // --- Line change ---
        if (activeIdx !== this.currentIndex) {
            this.currentIndex = activeIdx;

            containers.forEach(container => {
                if (!container) return;

                // Clear the previously active line and any word left highlighted
                // (past lines, or future lines after seeking backwards)
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

        // --- Words of the active line (every tick) ---
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