// ============================================================================
// DATA-DRIVEN CHAMPION & SUMMONER SPELL AUDIO ENGINE
// Plays official Riot .ogg files when configured, with WebAudio synth fallback
// ============================================================================
import { CHAMPION_LIST, getChampionConfig } from '../shared/champions/index.js';
const SUMMONER_SOUND_PATHS = {
    flash: [
        '/assets/audio/flash_sfx_1.ogg',
        '/assets/audio/flash_sfx_2.ogg',
        '/assets/audio/flash_sfx_3.ogg'
    ],
    heal: [
        '/assets/audio/heal_sfx_1.ogg',
        '/assets/audio/heal_sfx_2.ogg',
        '/assets/audio/heal_sfx_3.ogg'
    ],
    ghostStart: ['/assets/audio/ghost_sfx_1.ogg'],
    ghostLoop: ['/assets/audio/ghost_sfx_loop.ogg'],
    ghostEnd: ['/assets/audio/ghost_sfx_end.ogg'],
    recall: ['/assets/audio/recall_sfx.ogg']
};
export class GameAudioEngine {
    ctx = null;
    muted = false;
    bufferCache = new Map();
    loadingPromises = new Map();
    activeGhostTimers = [];
    constructor() {
        this.preloadAll();
    }
    preloadAll() {
        const allUrls = new Set();
        for (const list of Object.values(SUMMONER_SOUND_PATHS)) {
            for (const url of list) {
                allUrls.add(url);
            }
        }
        for (const champ of CHAMPION_LIST) {
            const lists = [
                champ.audio.chooseVo,
                champ.audio.tauntVo,
                champ.audio.qCastSfx,
                champ.audio.qCastVo,
                champ.audio.qHitSfx,
                champ.audio.qMissSfx,
                champ.audio.zoneSpawnSfx,
                champ.audio.zoneEruptSfx
            ];
            for (const list of lists) {
                if (!list)
                    continue;
                for (const url of list) {
                    allUrls.add(url);
                }
            }
        }
        for (const url of allUrls) {
            fetch(url).catch(() => { });
        }
    }
    ensureContext() {
        if (!this.ctx) {
            const win = window;
            const AudioCtx = window.AudioContext || win.webkitAudioContext;
            if (AudioCtx) {
                this.ctx = new AudioCtx();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => { });
        }
        return this.ctx;
    }
    async getDecodedBuffer(url) {
        const cached = this.bufferCache.get(url);
        if (cached)
            return cached;
        const existingPromise = this.loadingPromises.get(url);
        if (existingPromise)
            return existingPromise;
        const promise = (async () => {
            try {
                const ctx = this.ensureContext();
                if (!ctx)
                    return null;
                const res = await fetch(url);
                const arrayBuf = await res.arrayBuffer();
                const audioBuf = await ctx.decodeAudioData(arrayBuf);
                this.bufferCache.set(url, audioBuf);
                return audioBuf;
            }
            catch {
                return null;
            }
            finally {
                this.loadingPromises.delete(url);
            }
        })();
        this.loadingPromises.set(url, promise);
        return promise;
    }
    playSample(url, volume = 0.75, playbackRate = 1.0) {
        if (this.muted)
            return;
        const ctx = this.ensureContext();
        if (ctx) {
            const cached = this.bufferCache.get(url);
            if (cached) {
                const src = ctx.createBufferSource();
                src.buffer = cached;
                src.playbackRate.value = playbackRate;
                const gain = ctx.createGain();
                gain.gain.value = volume;
                src.connect(gain).connect(ctx.destination);
                src.start(0);
                return;
            }
            void this.getDecodedBuffer(url).then((buf) => {
                if (buf && !this.muted) {
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.playbackRate.value = playbackRate;
                    const gain = ctx.createGain();
                    gain.gain.value = volume;
                    src.connect(gain).connect(ctx.destination);
                    src.start(0);
                }
                else if (!buf && !this.muted) {
                    this.playFallbackHtmlAudio(url, volume);
                }
            });
        }
        else {
            this.playFallbackHtmlAudio(url, volume);
        }
    }
    playFallbackHtmlAudio(url, volume) {
        try {
            const el = new Audio(url);
            el.volume = Math.max(0, Math.min(1, volume));
            el.play().catch(() => { });
        }
        catch { }
    }
    pickRandom(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }
    playSynthTone(type, startFreq, endFreq, durationSec, peakGain) {
        if (this.muted)
            return;
        const ctx = this.ensureContext();
        if (!ctx)
            return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + durationSec);
        gain.gain.setValueAtTime(peakGain, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + durationSec + 0.02);
    }
    playChooseVo(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.chooseVo && champ.audio.chooseVo.length > 0) {
            this.playSample(this.pickRandom(champ.audio.chooseVo), 0.6);
            return;
        }
        if (champ.audio.synthProfile === 'void_beast') {
            this.playSynthTone('sawtooth', 125, 58, 0.38, 0.14);
            this.playSynthTone('triangle', 190, 82, 0.34, 0.12);
        }
    }
    playTauntVo(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.tauntVo && champ.audio.tauntVo.length > 0) {
            this.playSample(this.pickRandom(champ.audio.tauntVo), 0.6);
            return;
        }
        if (champ.audio.synthProfile === 'void_beast') {
            this.playSynthTone('sawtooth', 145, 52, 0.42, 0.16);
        }
    }
    playMoveClick() {
        this.playSynthTone('triangle', 520, 220, 0.045, 0.05);
    }
    playAbilityCast(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.qCastSfx && champ.audio.qCastSfx.length > 0) {
            this.playSample(this.pickRandom(champ.audio.qCastSfx), champ.audio.qCastSfxVolume ?? 1.0);
        }
        else if (champ.audio.synthProfile === 'void_beast') {
            // Deep Void stomp impact
            this.playSynthTone('sawtooth', 165, 42, 0.22, 0.18);
            this.playSynthTone('sine', 95, 36, 0.25, 0.2);
        }
        if (champ.audio.qCastVo && champ.audio.qCastVo.length > 0) {
            const chance = champ.audio.qCastVoChance ?? 0.45;
            if (Math.random() < chance) {
                this.playSample(this.pickRandom(champ.audio.qCastVo), 0.65);
            }
        }
    }
    playAbilityHit(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.qHitSfx && champ.audio.qHitSfx.length > 0) {
            this.playSample(this.pickRandom(champ.audio.qHitSfx), champ.audio.qHitSfxVolume ?? 1.2);
            return;
        }
        if (champ.audio.synthProfile === 'void_beast') {
            this.playSynthTone('square', 280, 75, 0.16, 0.15);
            this.playSynthTone('sawtooth', 150, 48, 0.24, 0.18);
        }
    }
    playAbilityMiss(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.qMissSfx && champ.audio.qMissSfx.length > 0) {
            this.playSample(this.pickRandom(champ.audio.qMissSfx), 0.75);
            return;
        }
        this.playSynthTone('triangle', 170, 65, 0.08, 0.09);
    }
    playZoneSpawn(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.zoneSpawnSfx && champ.audio.zoneSpawnSfx.length > 0) {
            this.playSample(this.pickRandom(champ.audio.zoneSpawnSfx), 0.85);
            return;
        }
        if (champ.audio.synthProfile === 'void_beast') {
            this.playSynthTone('sine', 78, 128, 0.45, 0.16);
        }
    }
    playZoneErupt(championId) {
        const champ = getChampionConfig(championId);
        if (champ.audio.zoneEruptSfx && champ.audio.zoneEruptSfx.length > 0) {
            this.playSample(this.pickRandom(champ.audio.zoneEruptSfx), 1.0);
            return;
        }
        if (champ.audio.synthProfile === 'void_beast') {
            this.playSynthTone('sawtooth', 240, 46, 0.26, 0.22);
            this.playSynthTone('triangle', 380, 90, 0.18, 0.16);
        }
    }
    playFlash() {
        this.playSample(this.pickRandom(SUMMONER_SOUND_PATHS.flash), 0.88);
    }
    playHeal() {
        this.playSample(this.pickRandom(SUMMONER_SOUND_PATHS.heal), 0.88);
    }
    playGhost(durationSec = 7.0) {
        this.playSample(SUMMONER_SOUND_PATHS.ghostStart[0], 0.88);
        const loopTimer = setTimeout(() => {
            this.playSample(SUMMONER_SOUND_PATHS.ghostLoop[0], 0.65);
        }, 450);
        const endDelayMs = Math.max(1500, (durationSec - 1.2) * 1000);
        const endTimer = setTimeout(() => {
            this.playSample(SUMMONER_SOUND_PATHS.ghostEnd[0], 0.75);
        }, endDelayMs);
        this.activeGhostTimers.push(loopTimer, endTimer);
    }
    playRecall() {
        this.playSample(SUMMONER_SOUND_PATHS.recall[0], 0.72);
    }
    playCountdownTick(isFight = false) {
        if (this.muted)
            return;
        const ctx = this.ensureContext();
        if (!ctx)
            return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = isFight ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(isFight ? 440 : 293.66, now);
        if (isFight) {
            osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.28);
        }
        gain.gain.setValueAtTime(isFight ? 0.22 : 0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (isFight ? 0.38 : 0.18));
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + (isFight ? 0.4 : 0.2));
    }
}
export const audio = new GameAudioEngine();
