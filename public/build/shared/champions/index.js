import { CHO_GATH_CONFIG } from './chogath.js';
import { DR_MUNDO_CONFIG } from './drmundo.js';
export const DEFAULT_CHAMPION_ID = 'drmundo';
export const CHAMPION_REGISTRY = {
    drmundo: DR_MUNDO_CONFIG,
    chogath: CHO_GATH_CONFIG
};
export const CHAMPION_LIST = Object.values(CHAMPION_REGISTRY);
export function isValidChampionId(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAMPION_REGISTRY, value);
}
export function normalizeChampionId(value, fallback = DEFAULT_CHAMPION_ID) {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (isValidChampionId(normalized)) {
            return normalized;
        }
    }
    return fallback;
}
export function getChampionConfig(championId) {
    return CHAMPION_REGISTRY[normalizeChampionId(championId)];
}
