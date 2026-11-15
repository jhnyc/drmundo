import type { BestOfFormat, SummonerSpellId } from '../shared/types.js';

// 1 unit = 1 League of Legends unit
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const INV_SQRT2 = Math.SQRT1_2;
export const PIT_RADIUS = 820; // Walkable inner radius of Baron Pit
export const LINE_BUFFER = 52; // Minimum distance from center ward line (champion hitbox barrier)

export const MUNDO_STATS = {
  maxHp: 1850,
  hpRegenPerSec: 16,
  baseMoveSpeed: 385,
  hitboxRadius: 65,
  qCooldown: 4.0,
  qCost: 50,
  qCastTime: 0.22,
  qRange: 1050,
  qSpeed: 2000,
  qRadius: 60,
  qPercentCurrentHp: 0.22,
  qMinDamage: 215,
  qSlowPercent: 0.4,
  qSlowDuration: 2.0
} as const;

interface SummonerSpellBase {
  id: SummonerSpellId;
  name: string;
  cooldownFast: number;
  cooldownStandard: number;
}

interface FlashSpellDef extends SummonerSpellBase {
  id: 'flash';
  range: number;
}

interface HealSpellDef extends SummonerSpellBase {
  id: 'heal';
  healAmount: number;
  speedBoost: number;
  duration: number;
}

interface GhostSpellDef extends SummonerSpellBase {
  id: 'ghost';
  speedBoost: number;
  duration: number;
}

export const SUMMONER_SPELLS: {
  flash: FlashSpellDef;
  heal: HealSpellDef;
  ghost: GhostSpellDef;
} = {
  flash: {
    id: 'flash',
    name: 'Flash',
    cooldownFast: 25,
    cooldownStandard: 120,
    range: 425
  },
  heal: {
    id: 'heal',
    name: 'Heal',
    cooldownFast: 30,
    cooldownStandard: 120,
    healAmount: 260,
    speedBoost: 0.3,
    duration: 1.5
  },
  ghost: {
    id: 'ghost',
    name: 'Ghost',
    cooldownFast: 30,
    cooldownStandard: 120,
    speedBoost: 0.38,
    duration: 7.0
  }
};

export function getSpellCooldown(spellId: SummonerSpellId, fastCd: boolean): number {
  const def = SUMMONER_SPELLS[spellId] || SUMMONER_SPELLS.flash;
  return fastCd ? def.cooldownFast : def.cooldownStandard;
}

export function validateSpells(spells: unknown): [SummonerSpellId, SummonerSpellId] {
  const valid: SummonerSpellId[] = ['flash', 'heal', 'ghost'];
  if (!Array.isArray(spells)) return ['flash', 'ghost'];
  const filtered: SummonerSpellId[] = [];
  for (const s of spells) {
    const id = String(s).toLowerCase() as SummonerSpellId;
    if (valid.includes(id) && !filtered.includes(id)) {
      filtered.push(id);
    }
  }
  for (const fallback of valid) {
    if (filtered.length < 2 && !filtered.includes(fallback)) {
      filtered.push(fallback);
    }
  }
  return [filtered[0] || 'flash', filtered[1] || 'ghost'];
}

export function parseBestOf(val: unknown): BestOfFormat {
  const num = Number(val);
  if (num === 1 || num === 3 || num === 5) return num;
  return 3;
}
