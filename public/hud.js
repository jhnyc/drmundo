import * as THREE from 'three';
import { audio } from './audio.js';
import { mundoRigs } from './champion.js';
import { camera } from './scene.js';
import { PIT_RADIUS, SPELL_ICONS, getEl, state } from './state.js';
const combatTextLayer = getEl('combat-text-layer');
export function worldToScreen(x, y, z) {
    const vec = new THREE.Vector3(x, y, z);
    vec.project(camera);
    return {
        x: (vec.x * 0.5 + 0.5) * window.innerWidth,
        y: (-vec.y * 0.5 + 0.5) * window.innerHeight
    };
}
export function spawnFloatingCombatText(x, z, text, cssClass = 'magic-dmg') {
    const pos = worldToScreen(x, 195, z);
    const el = document.createElement('div');
    el.className = `floating-combat-text ${cssClass}`;
    el.textContent = text;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    combatTextLayer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
}
export function updateFloatingHealthBars() {
    const inMatch = state.roomState === 'playing' ||
        state.roomState === 'countdown' ||
        state.roomState === 'round_end';
    for (let i = 0; i < 2; i++) {
        const fhb = getEl(`fhb-${i}`);
        const p = state.serverPlayers[i];
        const rig = mundoRigs[i];
        if (!inMatch || !p || !p.alive) {
            fhb.style.display = 'none';
            continue;
        }
        fhb.style.display = 'block';
        fhb.className = `lol-floating-bar ${i === state.mySlot ? 'self' : 'enemy'}`;
        const screenPos = worldToScreen(rig.root.position.x, 225, rig.root.position.z);
        fhb.style.left = `${screenPos.x}px`;
        fhb.style.top = `${screenPos.y}px`;
        getEl(`fhb-name-${i}`).textContent = p.name;
        const pct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
        getEl(`fhb-fill-${i}`).style.width = `${pct}%`;
        getEl(`fhb-trail-${i}`).style.width = `${pct}%`;
    }
}
export function updateInGameHud() {
    const p0 = state.serverPlayers[0];
    const p1 = state.serverPlayers[1];
    const me = state.serverPlayers[state.mySlot];
    if (p0) {
        getEl('hud-blue-name').textContent = p0.name;
        getEl('hud-blue-score').textContent = String(p0.score || 0);
        const mx = 50 + (p0.x / PIT_RADIUS) * 20;
        const my = 50 + (p0.z / PIT_RADIUS) * 20;
        const dot0 = getEl('minimap-dot-0');
        dot0.style.left = `${mx}%`;
        dot0.style.top = `${my}%`;
    }
    if (p1) {
        getEl('hud-red-name').textContent = p1.name;
        getEl('hud-red-score').textContent = String(p1.score || 0);
        const mx = 50 + (p1.x / PIT_RADIUS) * 20;
        const my = 50 + (p1.z / PIT_RADIUS) * 20;
        const dot1 = getEl('minimap-dot-1');
        dot1.style.left = `${mx}%`;
        dot1.style.top = `${my}%`;
    }
    getEl('hud-round-label').textContent = `ROUND ${state.round} (BO${state.bestOf})`;
    if (!me)
        return;
    const thrown = me.stats?.cleaversThrown || 0;
    const hits = me.stats?.cleaversHit || 0;
    const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
    getEl('hud-accuracy-label').textContent = `Cleaver Acc: ${acc}% (${hits}/${thrown})`;
    getEl('hud-stat-hits').textContent = `${hits}`;
    let ms = 385;
    if (me.ghostTimer > 0)
        ms = Math.round(ms * 1.38);
    if (me.healSpeedTimer > 0)
        ms = Math.round(ms * 1.3);
    if (me.slowTimer > 0)
        ms = Math.round(ms * 0.6);
    getEl('hud-stat-ms').textContent = `${ms}`;
    const hpPct = Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100));
    getEl('hud-hp-bar-fill').style.width = `${hpPct}%`;
    getEl('hud-hp-bar-text').textContent = `${Math.round(me.hp)} / ${me.maxHp}`;
    getEl('hud-hp-regen').textContent = '+16.0';
    const cdQ = getEl('hud-cd-q');
    if (me.qCd > 0) {
        cdQ.classList.remove('hidden');
        cdQ.textContent = me.qCd.toFixed(1);
    }
    else {
        cdQ.classList.add('hidden');
    }
    const spD = me.spells?.[0] || 'flash';
    const spF = me.spells?.[1] || 'ghost';
    getEl('hud-img-d').src = SPELL_ICONS[spD] || SPELL_ICONS.flash;
    getEl('hud-img-f').src = SPELL_ICONS[spF] || SPELL_ICONS.ghost;
    const cdD = getEl('hud-cd-d');
    if (me.spellCd?.[0] > 0) {
        cdD.classList.remove('hidden');
        cdD.textContent = String(Math.ceil(me.spellCd[0]));
    }
    else {
        cdD.classList.add('hidden');
    }
    const cdF = getEl('hud-cd-f');
    if (me.spellCd?.[1] > 0) {
        cdF.classList.remove('hidden');
        cdF.textContent = String(Math.ceil(me.spellCd[1]));
    }
    else {
        cdF.classList.add('hidden');
    }
}
let announcerTimeout = null;
export function showAnnouncerBanner(title, subtitle = '', durationMs = 2000) {
    const banner = getEl('announcer-banner');
    getEl('announcer-title').textContent = title;
    getEl('announcer-sub').textContent = subtitle;
    banner.classList.remove('hidden');
    if (announcerTimeout)
        clearTimeout(announcerTimeout);
    announcerTimeout = setTimeout(() => {
        banner.classList.add('hidden');
    }, durationMs);
}
export function showToast(message) {
    const toastContainer = getEl('toast-container');
    const toast = document.createElement('div');
    toast.className = 'hex-toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}
export function renderSpellPickerUI(containerId, spellsArray) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl)
        return;
    const cards = containerEl.querySelectorAll('.spell-option-card');
    cards.forEach((card) => {
        const sp = card.getAttribute('data-spell');
        const badge = card.querySelector('.spell-key-badge');
        card.classList.remove('selected-d', 'selected-f');
        if (!badge)
            return;
        if (spellsArray[0] === sp) {
            card.classList.add('selected-d');
            badge.style.display = 'flex';
            badge.textContent = 'D';
        }
        else if (spellsArray[1] === sp) {
            card.classList.add('selected-f');
            badge.style.display = 'flex';
            badge.textContent = 'F';
        }
        else {
            badge.style.display = 'none';
        }
    });
}
export function bindSpellPickerEvents(containerId, onSpellsChanged) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl)
        return;
    containerEl.querySelectorAll('.spell-option-card').forEach((card) => {
        card.addEventListener('click', () => {
            const clickedSpell = (card.getAttribute('data-spell') || 'flash');
            if (state.mySpells[0] === clickedSpell || state.mySpells[1] === clickedSpell) {
                state.mySpells = [state.mySpells[1], state.mySpells[0]];
            }
            else {
                state.mySpells = [state.mySpells[0], clickedSpell];
            }
            renderSpellPickerUI('home-spell-picker', state.mySpells);
            renderSpellPickerUI('lobby-spell-picker', state.mySpells);
            onSpellsChanged(state.mySpells);
        });
    });
}
export function getDropdownValue(id) {
    const el = document.getElementById(id);
    return el?.getAttribute('data-value') || '';
}
export function initHexDropdowns() {
    const dropdowns = document.querySelectorAll('.hex-dropdown');
    const closeAllDropdowns = (except) => {
        dropdowns.forEach((dd) => {
            if (dd !== except) {
                dd.classList.remove('open');
                const trig = dd.querySelector('.hex-dropdown-trigger');
                if (trig)
                    trig.setAttribute('aria-expanded', 'false');
            }
        });
    };
    dropdowns.forEach((dd) => {
        const trigger = dd.querySelector('.hex-dropdown-trigger');
        const label = dd.querySelector('.hex-dropdown-label');
        const options = dd.querySelectorAll('.hex-dropdown-option');
        if (!trigger || !label)
            return;
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            audio.ensureContext();
            const isOpen = dd.classList.contains('open');
            closeAllDropdowns(dd);
            if (isOpen) {
                dd.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
            }
            else {
                dd.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            }
        });
        options.forEach((opt) => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = opt.getAttribute('data-value') || '';
                dd.setAttribute('data-value', val);
                label.textContent = opt.textContent || '';
                options.forEach((o) => o.classList.remove('selected'));
                opt.classList.add('selected');
                dd.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
            });
        });
    });
    window.addEventListener('click', () => {
        closeAllDropdowns();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAllDropdowns();
        }
    });
}
