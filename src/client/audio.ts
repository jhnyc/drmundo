// ============================================================================
// DATA-DRIVEN CHAMPION & SUMMONER SPELL AUDIO ENGINE
// Preloads & plays official Riot Games .ogg files configured per champion
// ============================================================================

import { getChampionConfig } from '../shared/champions/index.js';
import type { ChampionId } from '../shared/types.js';

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

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
} as const;

export class GameAudioEngine {
  public ctx: AudioContext | null = null;
  public muted = false;
  private bufferCache = new Map<string, AudioBuffer>();
  private loadingPromises = new Map<string, Promise<AudioBuffer | null>>();
  private activeGhostTimers = new Set<ReturnType<typeof setTimeout>>();
  private warmedSummoners = false;
  private warmedChampions = new Set<ChampionId>();
  private pendingChampionId: ChampionId | null = null;

  constructor() {}

  public warmChampionAudio(championId: ChampionId): void {
    this.pendingChampionId = championId;
    if (!this.ctx) return;

    if (!this.warmedSummoners) {
      this.warmedSummoners = true;
      for (const list of Object.values(SUMMONER_SOUND_PATHS)) {
        for (const url of list) {
          void this.getDecodedBuffer(url);
        }
      }
    }

    if (!this.warmedChampions.has(championId)) {
      this.warmedChampions.add(championId);
      const champ = getChampionConfig(championId);
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
        if (!list) continue;
        for (const url of list) {
          void this.getDecodedBuffer(url);
        }
      }
    }
  }

  public ensureContext(): AudioContext | null {
    if (!this.ctx) {
      const win = window as WindowWithWebkitAudio;
      const AudioCtx = window.AudioContext || win.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.ctx && this.pendingChampionId) {
      this.warmChampionAudio(this.pendingChampionId);
    }
    return this.ctx;
  }

  private async getDecodedBuffer(url: string): Promise<AudioBuffer | null> {
    const cached = this.bufferCache.get(url);
    if (cached) return cached;

    const existingPromise = this.loadingPromises.get(url);
    if (existingPromise) return existingPromise;

    const promise = (async (): Promise<AudioBuffer | null> => {
      try {
        const ctx = this.ensureContext();
        if (!ctx) return null;
        const res = await fetch(url);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        this.bufferCache.set(url, audioBuf);
        return audioBuf;
      } catch {
        return null;
      } finally {
        this.loadingPromises.delete(url);
      }
    })();

    this.loadingPromises.set(url, promise);
    return promise;
  }

  private playBuffer(
    ctx: AudioContext,
    buf: AudioBuffer,
    volume: number,
    playbackRate: number
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
    src.start(0);
  }

  private playSample(url: string, volume = 0.75, playbackRate = 1.0): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (ctx) {
      const cached = this.bufferCache.get(url);
      if (cached) {
        this.playBuffer(ctx, cached, volume, playbackRate);
        return;
      }
      void this.getDecodedBuffer(url).then((buf) => {
        if (buf && !this.muted) {
          this.playBuffer(ctx, buf, volume, playbackRate);
        } else if (!buf && !this.muted) {
          this.playFallbackHtmlAudio(url, volume);
        }
      });
    } else {
      this.playFallbackHtmlAudio(url, volume);
    }
  }

  private playFallbackHtmlAudio(url: string, volume: number): void {
    try {
      const el = new Audio(url);
      el.volume = Math.max(0, Math.min(1, volume));
      el.play().catch(() => {});
    } catch {}
  }

  private pickRandom<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private playSynthTone(
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    durationSec: number,
    peakGain: number
  ): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + durationSec);
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  public playChooseVo(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.chooseVo && champ.audio.chooseVo.length > 0) {
      this.playSample(this.pickRandom(champ.audio.chooseVo), 0.6);
    }
  }

  public playTauntVo(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.tauntVo && champ.audio.tauntVo.length > 0) {
      this.playSample(this.pickRandom(champ.audio.tauntVo), 0.6);
    }
  }

  public playMoveClick(): void {
    this.playSynthTone('triangle', 520, 220, 0.045, 0.05);
  }

  public playAbilityCast(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.qCastSfx && champ.audio.qCastSfx.length > 0) {
      this.playSample(this.pickRandom(champ.audio.qCastSfx), champ.audio.qCastSfxVolume ?? 1.0);
    }
    if (champ.audio.qCastVo && champ.audio.qCastVo.length > 0) {
      const chance = champ.audio.qCastVoChance ?? 0.45;
      if (Math.random() < chance) {
        this.playSample(this.pickRandom(champ.audio.qCastVo), 0.65);
      }
    }
  }

  public playAbilityHit(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.qHitSfx && champ.audio.qHitSfx.length > 0) {
      this.playSample(this.pickRandom(champ.audio.qHitSfx), champ.audio.qHitSfxVolume ?? 1.2);
    }
  }

  public playAbilityMiss(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.qMissSfx && champ.audio.qMissSfx.length > 0) {
      this.playSample(this.pickRandom(champ.audio.qMissSfx), 0.75);
      return;
    }
    this.playSynthTone('triangle', 170, 65, 0.08, 0.09);
  }

  public playZoneSpawn(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.zoneSpawnSfx && champ.audio.zoneSpawnSfx.length > 0) {
      this.playSample(this.pickRandom(champ.audio.zoneSpawnSfx), 0.9);
    }
  }

  public playZoneErupt(championId?: ChampionId): void {
    const champ = getChampionConfig(championId);
    if (champ.audio.zoneEruptSfx && champ.audio.zoneEruptSfx.length > 0) {
      this.playSample(this.pickRandom(champ.audio.zoneEruptSfx), 1.05);
    }
  }

  public playFlash(): void {
    this.playSample(this.pickRandom(SUMMONER_SOUND_PATHS.flash), 0.88);
  }

  public playHeal(): void {
    this.playSample(this.pickRandom(SUMMONER_SOUND_PATHS.heal), 0.88);
  }

  public playGhost(durationSec = 7.0): void {
    this.playSample(SUMMONER_SOUND_PATHS.ghostStart[0], 0.88);

    const loopTimer = setTimeout(() => {
      this.activeGhostTimers.delete(loopTimer);
      this.playSample(SUMMONER_SOUND_PATHS.ghostLoop[0], 0.65);
    }, 450);

    const endDelayMs = Math.max(1500, (durationSec - 1.2) * 1000);
    const endTimer = setTimeout(() => {
      this.activeGhostTimers.delete(endTimer);
      this.playSample(SUMMONER_SOUND_PATHS.ghostEnd[0], 0.75);
    }, endDelayMs);

    this.activeGhostTimers.add(loopTimer);
    this.activeGhostTimers.add(endTimer);
  }

  public playRecall(): void {
    this.playSample(SUMMONER_SOUND_PATHS.recall[0], 0.72);
  }

  public playCountdownTick(isFight = false): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
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
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + (isFight ? 0.4 : 0.2));
  }
}

export const audio = new GameAudioEngine();
