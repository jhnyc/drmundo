// 1 unit = 1 League of Legends unit
export const LOL_SCALE = 1 / 0.0085; // Converts Khada 0.0085 scale back to 1:1 LoL units
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const INV_SQRT2 = Math.SQRT1_2;
export const PIT_RADIUS = 820; // Walkable inner radius of Baron Pit
export const LINE_BUFFER = 52; // Minimum distance from center ward line (champion hitbox barrier)
export const SUMMONER_SPELLS = {
    flash: {
        id: 'flash',
        name: 'Flash',
        icon: '/assets/icons/summoner_flash.png',
        cooldownFast: 25,
        cooldownStandard: 120,
        range: 425
    },
    heal: {
        id: 'heal',
        name: 'Heal',
        icon: '/assets/icons/summoner_heal.png',
        cooldownFast: 30,
        cooldownStandard: 120,
        healAmount: 260,
        speedBoost: 0.3,
        duration: 1.5
    },
    ghost: {
        id: 'ghost',
        name: 'Ghost',
        icon: '/assets/icons/summoner_ghost.png',
        cooldownFast: 30,
        cooldownStandard: 120,
        speedBoost: 0.38,
        duration: 7.0
    }
};
export const SPELL_ICONS = {
    flash: SUMMONER_SPELLS.flash.icon,
    heal: SUMMONER_SPELLS.heal.icon,
    ghost: SUMMONER_SPELLS.ghost.icon
};
export const SPELL_NAMES = {
    flash: SUMMONER_SPELLS.flash.name,
    heal: SUMMONER_SPELLS.heal.name,
    ghost: SUMMONER_SPELLS.ghost.name
};
export function getSpellCooldown(spellId, fastCd) {
    const def = SUMMONER_SPELLS[spellId] || SUMMONER_SPELLS.flash;
    return fastCd ? def.cooldownFast : def.cooldownStandard;
}
export function validateSpells(spells) {
    const valid = ['flash', 'heal', 'ghost'];
    if (!Array.isArray(spells))
        return ['flash', 'ghost'];
    const filtered = [];
    for (const s of spells) {
        const id = String(s).toLowerCase();
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
export function parseBestOf(val) {
    const num = Number(val);
    if (num === 1 || num === 3 || num === 5)
        return num;
    return 3;
}
