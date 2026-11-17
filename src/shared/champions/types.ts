import type { AnimKey, ChampionId } from '../types.js';

export interface ChampionClipConfig {
  clipName: string;
  fallbackClipName?: string;
  loop: 'repeat' | 'once';
  clampWhenFinished?: boolean;
  timeScale?: number;
}

export interface CastMeshHideConfig {
  materialName: string;
  materialHash?: number;
  totalDuration: number;
  visibleBeforeRemaining: number;
  lockAnimUntilRemaining: number;
}

export interface ChampionModelConfig {
  kind: 'glb';
  url: string;
  scale: number;
  pelvisBones: string[];
  pelvisRootMotionFactor: number;
  clips: Record<AnimKey, ChampionClipConfig>;
  /** How long q_cast animation locks before transitioning back to idle/run. */
  castAnimDuration?: number;
  castMeshHide?: CastMeshHideConfig;
}

export type ProjectileVisualConfig =
  | {
      kind: 'obj_model';
      objUrl: string;
      textureUrl: string;
      scale: number;
      spinAxis: 'x' | 'y' | 'z';
      spinSpeed: number;
      emissiveHex: number;
      emissiveIntensity: number;
      ringRadiusInner: number;
      ringRadiusOuter: number;
    }
  | {
      kind: 'energy_orb';
      radius: number;
      coreColorHex: number;
      glowColorHex: number;
    };

export interface GroundZoneVisualConfig {
  kind: 'void_rupture';
  telegraphColorHex: number;
  eruptColorHex: number;
  spikeColorHex: number;
  meshUrl?: string;
  meshTextureUrl?: string;
  /** Unscaled horizontal radius of meshUrl in raw OBJ units (used to scale to zone.radius). */
  meshBaseRadius?: number;
  crackTextureUrl?: string;
  indicatorTextureUrl?: string;
  smokeTextureUrl?: string;
  auraTextureUrl?: string;
  rockTextureUrl?: string;
}

export interface QAbilityDamageConfig {
  flatMin: number;
  percentCurrentHp: number;
}

export interface QAbilitySlowConfig {
  percent: number;
  duration: number;
}

export type LinearProjectileQConfig = {
  archetype: 'linear_projectile';
  name: string;
  description: string;
  costLabel: string;
  hpCost: number;
  refundOnHit: number;
  cooldown: number;
  castTime: number;
  range: number;
  speed: number;
  radius: number;
  spawnOffset: number;
  damage: QAbilityDamageConfig;
  slow?: QAbilitySlowConfig;
  indicator: {
    shape: 'line';
    width: number;
    range: number;
    colorHex: number;
  };
  projectileVisual: ProjectileVisualConfig;
  vfx: {
    hitColorHex: number;
    missColorHex: number;
  };
};

export type DelayedGroundAoeQConfig = {
  archetype: 'delayed_ground_aoe';
  name: string;
  description: string;
  costLabel: string;
  hpCost: number;
  refundOnHit: number;
  cooldown: number;
  castTime: number;
  /** Time in seconds from ground zone spawn until spike eruption. */
  delay: number;
  range: number;
  radius: number;
  damage: QAbilityDamageConfig;
  knockupDuration: number;
  slow?: QAbilitySlowConfig;
  indicator: {
    shape: 'circle';
    radius: number;
    range: number;
    colorHex: number;
  };
  zoneVisual: GroundZoneVisualConfig;
  vfx: {
    hitColorHex: number;
    missColorHex: number;
  };
};

export type QAbilityConfig = LinearProjectileQConfig | DelayedGroundAoeQConfig;

export interface ChampionAudioConfig {
  chooseVo?: readonly string[];
  tauntVo?: readonly string[];
  qCastSfx?: readonly string[];
  qCastVo?: readonly string[];
  qCastVoChance?: number;
  qCastSfxVolume?: number;
  qHitSfx?: readonly string[];
  qHitSfxVolume?: number;
  qMissSfx?: readonly string[];
  zoneSpawnSfx?: readonly string[];
  zoneEruptSfx?: readonly string[];
}

export interface ChampionConfig {
  id: ChampionId;
  name: string;
  title: string;
  defaultPlayerName: string;
  defaultBotName: string;
  roleTag: string;
  accentColor: string;
  accentHex: number;
  victoryLine: string;
  fightBannerSub: string;
  stats: {
    maxHp: number;
    hpRegenPerSec: number;
    baseMoveSpeed: number;
    hitboxRadius: number;
  };
  hud: {
    level: number;
    displayStats: {
      ad: number;
      armor: number;
      mr: number;
    };
    resource: {
      type: 'hp' | 'mana' | 'energy' | 'none';
      barColor: string;
      label: string;
    };
    accuracyLabel: string;
    hitsStatLabel: string;
    icons: {
      circle: string;
      square: string;
      passive: string;
      q: string;
      w: string;
      e: string;
      r: string;
    };
    passive: {
      name: string;
      description: string;
    };
    disabledAbilities: {
      w: { name: string; description: string };
      e: { name: string; description: string };
      r: { name: string; description: string };
    };
  };
  model: ChampionModelConfig;
  q: QAbilityConfig;
  audio: ChampionAudioConfig;
}
