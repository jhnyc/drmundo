import type { ChampionId } from '../types.js';
import { DR_MUNDO_CONFIG } from './drmundo.js';
import type { ChampionConfig } from './types.js';

export const DEFAULT_CHAMPION_ID: ChampionId = 'drmundo';

export const CHAMPION_REGISTRY: Record<ChampionId, ChampionConfig> = {
  drmundo: DR_MUNDO_CONFIG
};

export const CHAMPION_LIST: readonly ChampionConfig[] = Object.values(CHAMPION_REGISTRY);

export function isValidChampionId(value: unknown): value is ChampionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAMPION_REGISTRY, value);
}

export function normalizeChampionId(value: unknown, fallback: ChampionId = DEFAULT_CHAMPION_ID): ChampionId {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (isValidChampionId(normalized)) {
      return normalized;
    }
  }
  return fallback;
}

export function getChampionConfig(championId?: ChampionId | string | null): ChampionConfig {
  return CHAMPION_REGISTRY[normalizeChampionId(championId)];
}
