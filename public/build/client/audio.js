// ============================================================================
// AUTHENTIC LEAGUE OF LEGENDS DR. MUNDO & SUMMONER SPELL AUDIO ENGINE
// Uses official Riot Games / League of Legends .ogg sound effects
// ============================================================================
const SOUND_PATHS = {
    chooseVo: ['/assets/audio/drmundo_choose_vo.ogg'],
    banVo: ['/assets/audio/drmundo_ban_vo.ogg'],
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
    recall: ['/assets/audio/recall_sfx.ogg'],
    qThrowSfx: ['/assets/audio/mundo_q_throw_sfx.ogg?v=2'],
    qHitSfx: ['/assets/audio/mundo_q_hit_sfx.ogg?v=2'],
    qThrowVo: [
        '/assets/audio/mundo_q_vo_0.ogg',
        '/assets/audio/mundo_q_vo_1.ogg'
    ],
    qHitVo: ['/assets/audio/mundo_q_hit_vo_0.ogg']
};
export class MundoAudioEngine {
    ctx = null;
    muted = false;
    bufferCache = new Map();
    loadingPromises = new Map();
    activeGhostTimers = [];
    constructor() {
        // Pre-fetch all official League of Legends audio files so they play with zero latency
        this.preloadAll();
    }
    preloadAll() {
        const allUrls = new Set();
        for (const list of Object.values(SOUND_PATHS)) {
            for (const url of list) {
                allUrls.add(url);
            }
        }
        for (const url of allUrls) {
            // Warm browser HTTP cache immediately
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
            // Decode asynchronously & play immediately when ready
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
    playChooseVo() {
        this.playSample(SOUND_PATHS.chooseVo[0], 0.6);
    }
    playTauntVo() {
        this.playSample(SOUND_PATHS.banVo[0], 0.6);
    }
    playMoveClick() {
        if (this.muted)
            return;
        const ctx = this.ensureContext();
        if (!ctx)
            return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.045);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.05);
    }
    playCleaverThrow() {
        // Official Riot Games Dr. Mundo Q (Infected Bonesaw) cast SFX
        this.playSample(SOUND_PATHS.qThrowSfx[0], 1.15);
        // Play Dr. Mundo Q effort grunt on ~45% of throws, matching League of Legends
        if (Math.random() < 0.45) {
            this.playSample(this.pickRandom(SOUND_PATHS.qThrowVo), 0.65);
        }
    }
    playCleaverHit() {
        // Official Riot Games Dr. Mundo Q (Infected Bonesaw) impact cleave SFX
        this.playSample(SOUND_PATHS.qHitSfx[0], 1.45);
    }
    playCleaverMiss() {
        if (this.muted)
            return;
        const ctx = this.ensureContext();
        if (!ctx)
            return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(170, now);
        osc.frequency.exponentialRampToValueAtTime(65, now + 0.08);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
    }
    playFlash() {
        // Official League of Legends Summoner Spell Flash SFX
        const url = this.pickRandom(SOUND_PATHS.flash);
        this.playSample(url, 0.88);
    }
    playHeal() {
        // Official League of Legends Summoner Spell Heal SFX
        const url = this.pickRandom(SOUND_PATHS.heal);
        this.playSample(url, 0.88);
    }
    playGhost(durationSec = 7.0) {
        // Official League of Legends Summoner Spell Ghost activation + spectral wind + fadeout SFX
        this.playSample(SOUND_PATHS.ghostStart[0], 0.88);
        const loopTimer = setTimeout(() => {
            this.playSample(SOUND_PATHS.ghostLoop[0], 0.65);
        }, 450);
        const endDelayMs = Math.max(1500, (durationSec - 1.2) * 1000);
        const endTimer = setTimeout(() => {
            this.playSample(SOUND_PATHS.ghostEnd[0], 0.75);
        }, endDelayMs);
        this.activeGhostTimers.push(loopTimer, endTimer);
    }
    playRecall() {
        // Official League of Legends Recall channel SFX
        this.playSample(SOUND_PATHS.recall[0], 0.72);
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
export const audio = new MundoAudioEngine();
