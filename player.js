// player.js — Audio playback engine

import { getStreamUrl, formatDur } from './api.js';

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.queueIdx = -1;
    this.currentTrack = null;
    this.isPlaying = false;
    this.shuffle = false;
    this.repeat = 0; // 0=off 1=all 2=one
    this.volume = parseFloat(localStorage.getItem('volume') || '1.0');
    this.muted = false;
    this.quality = localStorage.getItem('quality') || '7';
    this._listeners = {};
    
    // Gestione migliorata dello storico shuffle
    this._shuffleHistory = [];
    this._historyIdx = -1; 
    
    this._dragSeeking = false;

    this.audio.volume = this.volume;
    this._bind();
  }

  _bind() {
    this.audio.addEventListener('timeupdate', () => {
      if (!this._dragSeeking) this._emit('timeupdate', {
        current: this.audio.currentTime,
        duration: this.audio.duration || 0,
        pct: this.audio.duration ? this.audio.currentTime / this.audio.duration : 0,
      });
    });
    this.audio.addEventListener('ended', () => this._onEnded());
    this.audio.addEventListener('play', () => { this.isPlaying = true; this._emit('state', this._state()); });
    this.audio.addEventListener('pause', () => { this.isPlaying = false; this._emit('state', this._state()); });
    this.audio.addEventListener('waiting', () => this._emit('loading', true));
    this.audio.addEventListener('canplay', () => this._emit('loading', false));
    this.audio.addEventListener('error', (e) => this._emit('error', e));
    this.audio.addEventListener('durationchange', () => this._emit('duration', this.audio.duration));

  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => { this._listeners[event] = this._listeners[event].filter(f => f !== fn); };
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }

  _state() {
    return {
      track: this.currentTrack,
      isPlaying: this.isPlaying,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      muted: this.muted,
      quality: this.quality,
      queueIdx: this.queueIdx,
      queueLen: this.queue.length,
    };
  }

  setQuality(q) {
    this.quality = q;
    localStorage.setItem('quality', q);
    this._emit('qualitychange', q);
    // Se sta riproducendo, ricarica alla nuova qualità mantenendo la posizione
    if (this.currentTrack && this.isPlaying) {
      const pos = this.audio.currentTime;
      this._loadAndPlay(this.currentTrack, pos);
    }
  }

  async play(track, fromPosition = 0) {
    this.currentTrack = track;
    this._emit('trackchange', track);
    this._emit('loading', true);
    await this._loadAndPlay(track, fromPosition);
  }

  async _loadAndPlay(track, fromPosition = 0) {
    try {
      let streamUrl = '';
      let streamInfo = null;

      if (this._lastLocalUrl) {
        URL.revokeObjectURL(this._lastLocalUrl);
        this._lastLocalUrl = null;
      }

      // LA FIX È QUI: Usiamo is_local invece di audioQuality === 'LOCAL'
      if (track.is_local || String(track.id).startsWith('local_')) {
        const file = await window.LocalDB.getFile(track.id);
        if (!file) throw new Error("File locale non trovato nel database.");
        
        streamUrl = URL.createObjectURL(file);
        this._lastLocalUrl = streamUrl; 
        streamInfo = { url: streamUrl, quality: 'LOCAL' };
      } else {
        const trackId = track.id || track.originalId;
        const data = await getStreamUrl(trackId, this.quality);
        streamUrl = data.url;
        streamInfo = data;
      }

      const waitForReady = new Promise((resolve) => {
        const onReady = () => {
          this.audio.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          this.audio.removeEventListener('loadedmetadata', onReady);
          resolve(); 
        };
        this.audio.addEventListener('loadedmetadata', onReady, { once: true });
        this.audio.addEventListener('error', onError, { once: true });
      });

      this.audio.src = streamUrl;
      this.audio.load();

      if (this.audio.readyState < 1) {
        await waitForReady;
      }

      if (fromPosition > 0) {
        this.audio.currentTime = fromPosition;
      }
      
      this.audio.volume = this.muted ? 0 : this.volume;

      try {
        await this.audio.play();
      } catch (playError) {
        // Ignoriamo l'errore se l'utente cambia canzone rapidamente (AbortError)
        // o se il browser blocca l'autoplay al refresh della pagina (NotAllowedError)
        if (playError.name !== 'AbortError' && playError.name !== 'NotAllowedError') {
          throw playError;
        } else if (playError.name === 'NotAllowedError') {
          // Se il browser ha bloccato l'audio, assicuriamoci che l'interfaccia si metta in Pausa
          this.isPlaying = false;
          this._emit('state', this._state());
        }
      }
      
      this._emit('loading', false);
      this._emit('streaminfo', streamInfo);
    } catch(e) {
      this._emit('loading', false);
      this._emit('error', e);
      console.error('Player error:', e);
    }
  }

  setQueue(tracks, startIdx = 0) {
    this.queue = tracks;
    this.queueIdx = startIdx;
    
    // Inizializza lo storico shuffle
    this._shuffleHistory = [startIdx];
    this._historyIdx = 0;
    
    this.play(tracks[startIdx]);
    this._emit('queuechange', { queue: this.queue, idx: this.queueIdx });
  }

  async togglePlay() {
    if (!this.currentTrack) return;
    if (this.isPlaying) this.audio.pause();
    else {
        try { await this.audio.play(); } 
        catch (e) { if (e.name !== 'AbortError') console.error(e); }
    }
  }

  next() {
    if (!this.queue.length) return;
    
    // Se repeat è 2 (Ripeti uno), fai ripartire la stessa traccia
    if (this.repeat === 2) { 
        this.audio.currentTime = 0; 
        this.audio.play(); 
        return; 
    }
    
    let nextIdx;
    
    // FIX 3: Gestione intelligente dello Shuffle con storico
    if (this.shuffle) {
      if (this._historyIdx < this._shuffleHistory.length - 1) {
        // Stiamo navigando in avanti nello storico esistente
        this._historyIdx++;
        nextIdx = this._shuffleHistory[this._historyIdx];
      } else {
        // Genera una nuova traccia casuale che non sia stata suonata di recente
        let remaining = this.queue.map((_,i)=>i).filter(i => !this._shuffleHistory.includes(i));
        
        // Se le abbiamo suonate tutte, resetta lo storico
        if (remaining.length === 0) {
          this._shuffleHistory = [this.queueIdx];
          remaining = this.queue.map((_,i)=>i).filter(i => i !== this.queueIdx);
        }
        
        nextIdx = remaining.length ? remaining[Math.floor(Math.random() * remaining.length)] : 0;
        this._shuffleHistory.push(nextIdx);
        this._historyIdx = this._shuffleHistory.length - 1;
      }
    } else {
      nextIdx = this.queueIdx + 1;
      if (nextIdx >= this.queue.length) {
        if (this.repeat === 1) nextIdx = 0;
        else { this.audio.pause(); return; } // Fine coda
      }
    }
    
    this.queueIdx = nextIdx;
    this.play(this.queue[nextIdx]);
    this._emit('queuechange', { queue: this.queue, idx: this.queueIdx });
  }

  prev() {
    // Comportamento standard: se sono passati più di 3 secondi, riavvia la traccia
    if (this.audio.currentTime > 3) { 
        this.seek(0); 
        return; 
    }
    
    if (!this.queue.length) return;
    let prevIdx;

    if (this.shuffle && this._historyIdx > 0) {
      // Torna indietro nello storico dello shuffle
      this._historyIdx--;
      prevIdx = this._shuffleHistory[this._historyIdx];
    } else {
      // Normale navigazione indietro
      prevIdx = this.queueIdx - 1;
      if (prevIdx < 0) {
        prevIdx = this.repeat === 1 ? this.queue.length - 1 : 0;
      }
    }
    
    this.queueIdx = prevIdx;
    this.play(this.queue[prevIdx]);
    this._emit('queuechange', { queue: this.queue, idx: this.queueIdx });
  }

  seek(pct) {
    if (!this.audio.duration) return;
    this.audio.currentTime = pct * this.audio.duration;
  }

  seekSeconds(s) {
    this.audio.currentTime = Math.max(0, Math.min(this.audio.duration || 0, s));
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.muted = false;
    this.audio.volume = this.volume;
    localStorage.setItem('volume', this.volume);
    this._emit('volumechange', this.volume);

    this._emit('state', this._state());
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.volume = this.muted ? 0 : this.volume;
    this._emit('mutechange', this.muted);

    this._emit('state', this._state());
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    // Se attiviamo lo shuffle, iniziamo un nuovo storico dalla traccia corrente
    if (this.shuffle) {
      this._shuffleHistory = [this.queueIdx];
      this._historyIdx = 0;
    }
    this._emit('state', this._state());
  }

  toggleRepeat() {
    this.repeat = (this.repeat + 1) % 3;
    this._emit('state', this._state());
  }

  addToQueue(tracks) {
    this.queue = [...this.queue, ...tracks];
    this._emit('queuechange', { queue: this.queue, idx: this.queueIdx });
  }

  removeFromQueue(idx) {
    this.queue.splice(idx, 1);
    if (idx < this.queueIdx) this.queueIdx--;
    
    // Pulizia base dello storico per evitare indici sballati
    if (this.shuffle) {
        this._shuffleHistory = [this.queueIdx];
        this._historyIdx = 0;
    }
    
    this._emit('queuechange', { queue: this.queue, idx: this.queueIdx });
  }

  clearQueue() {
    this.queue = [];
    this.queueIdx = -1;
    this._shuffleHistory = [];
    this._historyIdx = -1;
    this._emit('queuechange', { queue: [], idx: -1 });
  }

  _onEnded() {
    this._emit('ended', this.currentTrack);
    this.next();
  }

  startDragSeek() { this._dragSeeking = true; }
  endDragSeek(pct) {
    this._dragSeeking = false;
    this.seek(pct);
  }

  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration || 0; }
}

export const player = new Player();