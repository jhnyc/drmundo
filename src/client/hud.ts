import * as THREE from 'three';
import {
  CHAMPION_LIST,
  getChampionConfig,
  normalizeChampionId
} from '../shared/champions/index.js';
import { SUMMONER_SPELLS } from '../shared/constants.js';
import type { ChampionId, SummonerSpellId } from '../shared/types.js';
import { audio } from './audio.js';
import { championRigs } from './champion.js';
import { camera } from './scene.js';
import { PIT_RADIUS, SPELL_ICONS, getEl, state } from './state.js';

const combatTextLayer = getEl<HTMLDivElement>('combat-text-layer');
const _projVec = new THREE.Vector3();

export function worldToScreen(x: number, y: number, z: number): { x: number; y: number } {
  _projVec.set(x, y, z).project(camera);
  return {
    x: (_projVec.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_projVec.y * 0.5 + 0.5) * window.innerHeight
  };
}

export function spawnFloatingCombatText(
  x: number,
  z: number,
  text: string,
  cssClass = 'magic-dmg',
  worldY = 195
): void {
  const pos = worldToScreen(x, worldY, z);
  const el = document.createElement('div');
  el.className = `floating-combat-text ${cssClass}`;
  el.textContent = text;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  combatTextLayer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

interface FloatingBarCache {
  root: HTMLElement;
  name: HTMLElement;
  level: HTMLElement;
  fill: HTMLElement;
  trail: HTMLElement;
  visible: boolean;
  lastClass: string;
  lastName: string;
  lastLevel: string;
  lastPct: string;
  lastX: number;
  lastY: number;
}

let fhbCache: [FloatingBarCache, FloatingBarCache] | null = null;

function getFloatingBarCache(): [FloatingBarCache, FloatingBarCache] {
  if (!fhbCache) {
    fhbCache = [0, 1].map((i) => {
      const root = getEl(`fhb-${i}`);
      return {
        root,
        name: getEl(`fhb-name-${i}`),
        level: root.querySelector('.fhb-level-box') as HTMLElement,
        fill: getEl(`fhb-fill-${i}`),
        trail: getEl(`fhb-trail-${i}`),
        visible: false,
        lastClass: '',
        lastName: '',
        lastLevel: '',
        lastPct: '',
        lastX: NaN,
        lastY: NaN
      };
    }) as [FloatingBarCache, FloatingBarCache];
  }
  return fhbCache;
}

export function updateFloatingHealthBars(): void {
  const inMatch =
    state.roomState === 'playing' ||
    state.roomState === 'countdown' ||
    state.roomState === 'round_end';

  const bars = getFloatingBarCache();
  for (let i = 0; i < 2; i++) {
    const bar = bars[i];
    const p = state.serverPlayers[i];
    const rig = championRigs[i];
    if (!inMatch || !p || !p.alive) {
      if (bar.visible) {
        bar.root.style.display = 'none';
        bar.visible = false;
      }
      continue;
    }

    if (!bar.visible) {
      bar.root.style.display = 'block';
      bar.visible = true;
    }

    const cls = `lol-floating-bar ${i === state.mySlot ? 'self' : 'enemy'}`;
    if (bar.lastClass !== cls) {
      bar.root.className = cls;
      bar.lastClass = cls;
    }

    const champ = getChampionConfig(p.championId);
    const levelStr = String(champ.hud.level);
    if (bar.lastLevel !== levelStr) {
      bar.level.textContent = levelStr;
      bar.lastLevel = levelStr;
    }

    const knockupOffset =
      p.knockupTimer > 0 && p.knockupDuration > 0
        ? Math.sin((1 - p.knockupTimer / p.knockupDuration) * Math.PI) * 155
        : 0;
    const screenPos = worldToScreen(rig.root.position.x, 225 + knockupOffset, rig.root.position.z);
    const sx = Math.round(screenPos.x * 2) / 2;
    const sy = Math.round(screenPos.y * 2) / 2;
    if (bar.lastX !== sx || bar.lastY !== sy) {
      bar.root.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -100%)`;
      bar.lastX = sx;
      bar.lastY = sy;
    }

    if (bar.lastName !== p.name) {
      bar.name.textContent = p.name;
      bar.lastName = p.name;
    }

    const pctStr = `${Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)).toFixed(2)}%`;
    if (bar.lastPct !== pctStr) {
      bar.fill.style.width = pctStr;
      bar.trail.style.width = pctStr;
      bar.lastPct = pctStr;
    }
  }
}

interface HudDomCache {
  blueName: HTMLElement;
  blueScore: HTMLElement;
  dot0: HTMLElement;
  redName: HTMLElement;
  redScore: HTMLElement;
  dot1: HTMLElement;
  roundLabel: HTMLElement;
  accLabel: HTMLElement;
  statAd: HTMLElement;
  statMr: HTMLElement;
  statArm: HTMLElement;
  statHits: HTMLElement;
  statRegen: HTMLElement;
  statMs: HTMLElement;
  champPortrait: HTMLImageElement;
  champLevel: HTMLElement;
  slotP: HTMLElement;
  imgP: HTMLImageElement;
  slotQ: HTMLElement;
  imgQ: HTMLImageElement;
  qCost: HTMLElement;
  slotW: HTMLElement;
  imgW: HTMLImageElement;
  slotE: HTMLElement;
  imgE: HTMLImageElement;
  slotR: HTMLElement;
  imgR: HTMLImageElement;
  hpFill: HTMLElement;
  hpText: HTMLElement;
  hpRegen: HTMLElement;
  resFill: HTMLElement;
  cdQ: HTMLElement;
  imgD: HTMLImageElement;
  imgF: HTMLImageElement;
  cdD: HTMLElement;
  cdF: HTMLElement;
  fpsValue: HTMLElement;
  pingValue: HTMLElement;
}

let hudDom: HudDomCache | null = null;
const hudPrev: Record<string, string> = {};

function setTextIfChanged(key: string, el: HTMLElement, val: string): void {
  if (hudPrev[key] !== val) {
    el.textContent = val;
    hudPrev[key] = val;
  }
}

function getHudDom(): HudDomCache {
  if (!hudDom) {
    hudDom = {
      blueName: getEl('hud-blue-name'),
      blueScore: getEl('hud-blue-score'),
      dot0: getEl('minimap-dot-0'),
      redName: getEl('hud-red-name'),
      redScore: getEl('hud-red-score'),
      dot1: getEl('minimap-dot-1'),
      roundLabel: getEl('hud-round-label'),
      accLabel: getEl('hud-accuracy-label'),
      statAd: getEl('hud-stat-ad'),
      statMr: getEl('hud-stat-mr'),
      statArm: getEl('hud-stat-arm'),
      statHits: getEl('hud-stat-hits'),
      statRegen: getEl('hud-stat-regen'),
      statMs: getEl('hud-stat-ms'),
      champPortrait: getEl<HTMLImageElement>('hud-champ-portrait'),
      champLevel: getEl('hud-champ-level'),
      slotP: getEl('hud-slot-p'),
      imgP: getEl<HTMLImageElement>('hud-img-p'),
      slotQ: getEl('hud-slot-q'),
      imgQ: getEl<HTMLImageElement>('hud-img-q'),
      qCost: getEl('hud-q-cost'),
      slotW: getEl('hud-slot-w'),
      imgW: getEl<HTMLImageElement>('hud-img-w'),
      slotE: getEl('hud-slot-e'),
      imgE: getEl<HTMLImageElement>('hud-img-e'),
      slotR: getEl('hud-slot-r'),
      imgR: getEl<HTMLImageElement>('hud-img-r'),
      hpFill: getEl('hud-hp-bar-fill'),
      hpText: getEl('hud-hp-bar-text'),
      hpRegen: getEl('hud-hp-regen'),
      resFill: getEl('hud-res-fill'),
      cdQ: getEl('hud-cd-q'),
      imgD: getEl<HTMLImageElement>('hud-img-d'),
      imgF: getEl<HTMLImageElement>('hud-img-f'),
      cdD: getEl('hud-cd-d'),
      cdF: getEl('hud-cd-f'),
      fpsValue: getEl('hud-fps-value'),
      pingValue: getEl('hud-ping-value')
    };
  }
  return hudDom;
}

function applyChampionHudChrome(dom: HudDomCache, champId: ChampionId): void {
  if (hudPrev.champChrome === champId) return;
  hudPrev.champChrome = champId;

  const champ = getChampionConfig(champId);
  dom.champPortrait.src = champ.hud.icons.circle;
  dom.champPortrait.alt = champ.name;
  dom.champLevel.textContent = String(champ.hud.level);

  dom.statAd.textContent = String(champ.hud.displayStats.ad);
  dom.statMr.textContent = String(champ.hud.displayStats.mr);
  dom.statArm.textContent = String(champ.hud.displayStats.armor);
  dom.statRegen.textContent = String(champ.stats.hpRegenPerSec);
  dom.hpRegen.textContent = `+${champ.stats.hpRegenPerSec.toFixed(1)}`;

  dom.imgP.src = champ.hud.icons.passive;
  dom.slotP.title = `Passive: ${champ.hud.passive.name} — ${champ.hud.passive.description}`;

  dom.imgQ.src = champ.hud.icons.q;
  dom.slotQ.title = `${champ.q.name} (Q): ${champ.q.description}`;
  dom.qCost.textContent = champ.q.costLabel;

  dom.imgW.src = champ.hud.icons.w;
  dom.slotW.title = `${champ.hud.disabledAbilities.w.name} (W) — ${champ.hud.disabledAbilities.w.description}`;
  dom.imgE.src = champ.hud.icons.e;
  dom.slotE.title = `${champ.hud.disabledAbilities.e.name} (E) — ${champ.hud.disabledAbilities.e.description}`;
  dom.imgR.src = champ.hud.icons.r;
  dom.slotR.title = `${champ.hud.disabledAbilities.r.name} (R) — ${champ.hud.disabledAbilities.r.description}`;

  dom.resFill.style.background = champ.hud.resource.barColor;
}

export function updateInGameHud(): void {
  const dom = getHudDom();
  const p0 = state.serverPlayers[0];
  const p1 = state.serverPlayers[1];
  const me = state.serverPlayers[state.mySlot];

  if (p0) {
    const c0 = getChampionConfig(p0.championId);
    setTextIfChanged('bName', dom.blueName, p0.name);
    setTextIfChanged('bScore', dom.blueScore, String(p0.score || 0));
    const dot0Img = `url("${c0.hud.icons.circle}")`;
    if (hudPrev.d0img !== dot0Img) {
      dom.dot0.style.backgroundImage = dot0Img;
      hudPrev.d0img = dot0Img;
    }
    const mx = `${(50 + (p0.x / PIT_RADIUS) * 20).toFixed(2)}%`;
    const my = `${(50 + (p0.z / PIT_RADIUS) * 20).toFixed(2)}%`;
    if (hudPrev.d0x !== mx) {
      dom.dot0.style.left = mx;
      hudPrev.d0x = mx;
    }
    if (hudPrev.d0y !== my) {
      dom.dot0.style.top = my;
      hudPrev.d0y = my;
    }
  }
  if (p1) {
    const c1 = getChampionConfig(p1.championId);
    setTextIfChanged('rName', dom.redName, p1.name);
    setTextIfChanged('rScore', dom.redScore, String(p1.score || 0));
    const dot1Img = `url("${c1.hud.icons.circle}")`;
    if (hudPrev.d1img !== dot1Img) {
      dom.dot1.style.backgroundImage = dot1Img;
      hudPrev.d1img = dot1Img;
    }
    const mx = `${(50 + (p1.x / PIT_RADIUS) * 20).toFixed(2)}%`;
    const my = `${(50 + (p1.z / PIT_RADIUS) * 20).toFixed(2)}%`;
    if (hudPrev.d1x !== mx) {
      dom.dot1.style.left = mx;
      hudPrev.d1x = mx;
    }
    if (hudPrev.d1y !== my) {
      dom.dot1.style.top = my;
      hudPrev.d1y = my;
    }
  }

  setTextIfChanged('round', dom.roundLabel, `ROUND ${state.round} (BO${state.bestOf})`);

  if (!me) return;

  const myChamp = getChampionConfig(me.championId);
  applyChampionHudChrome(dom, myChamp.id);

  const thrown = me.stats?.abilitiesCast || 0;
  const hits = me.stats?.abilitiesHit || 0;
  const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
  setTextIfChanged(
    'acc',
    dom.accLabel,
    `${myChamp.hud.accuracyLabel}: ${acc}% (${hits}/${thrown})`
  );
  setTextIfChanged('hits', dom.statHits, `${hits}`);

  let ms = myChamp.stats.baseMoveSpeed;
  if (me.ghostTimer > 0) ms = Math.round(ms * (1 + SUMMONER_SPELLS.ghost.speedBoost));
  if (me.healSpeedTimer > 0) ms = Math.round(ms * (1 + SUMMONER_SPELLS.heal.speedBoost));
  if (me.slowTimer > 0) ms = Math.round(ms * (1 - (me.slowPercent || 0.4)));
  setTextIfChanged('ms', dom.statMs, `${ms}`);

  const hpPct = `${Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100)).toFixed(2)}%`;
  if (hudPrev.hpPct !== hpPct) {
    dom.hpFill.style.width = hpPct;
    hudPrev.hpPct = hpPct;
  }
  setTextIfChanged('hpText', dom.hpText, `${Math.round(me.hp)} / ${me.maxHp}`);

  if (me.qCd > 0) {
    if (hudPrev.cdQVis !== '1') {
      dom.cdQ.classList.remove('hidden');
      hudPrev.cdQVis = '1';
    }
    setTextIfChanged('cdQ', dom.cdQ, me.qCd.toFixed(1));
  } else if (hudPrev.cdQVis !== '0') {
    dom.cdQ.classList.add('hidden');
    hudPrev.cdQVis = '0';
  }

  const spD: SummonerSpellId = me.spells?.[0] || 'flash';
  const spF: SummonerSpellId = me.spells?.[1] || 'ghost';
  const srcD = SPELL_ICONS[spD] || SPELL_ICONS.flash;
  const srcF = SPELL_ICONS[spF] || SPELL_ICONS.ghost;
  if (hudPrev.srcD !== srcD) {
    dom.imgD.src = srcD;
    hudPrev.srcD = srcD;
  }
  if (hudPrev.srcF !== srcF) {
    dom.imgF.src = srcF;
    hudPrev.srcF = srcF;
  }

  if (me.spellCd?.[0] > 0) {
    if (hudPrev.cdDVis !== '1') {
      dom.cdD.classList.remove('hidden');
      hudPrev.cdDVis = '1';
    }
    setTextIfChanged('cdD', dom.cdD, String(Math.ceil(me.spellCd[0])));
  } else if (hudPrev.cdDVis !== '0') {
    dom.cdD.classList.add('hidden');
    hudPrev.cdDVis = '0';
  }

  if (me.spellCd?.[1] > 0) {
    if (hudPrev.cdFVis !== '1') {
      dom.cdF.classList.remove('hidden');
      hudPrev.cdFVis = '1';
    }
    setTextIfChanged('cdF', dom.cdF, String(Math.ceil(me.spellCd[1])));
  } else if (hudPrev.cdFVis !== '0') {
    dom.cdF.classList.add('hidden');
    hudPrev.cdFVis = '0';
  }
}

function getPerfClass(kind: 'fps' | 'ping', value: number | null): string {
  if (value === null) return 'perf-value';
  if (kind === 'fps') {
    if (value >= 50) return 'perf-value perf-good';
    if (value >= 30) return 'perf-value perf-warn';
    return 'perf-value perf-bad';
  }
  if (value < 60) return 'perf-value perf-good';
  if (value < 120) return 'perf-value perf-warn';
  return 'perf-value perf-bad';
}

export function updatePerformanceHud(): void {
  const dom = getHudDom();
  const fpsText = state.fps === null ? '--' : `${state.fps}`;
  const pingText = state.pingMs === null ? '-- ms' : `${state.pingMs} ms`;
  const fpsClass = getPerfClass('fps', state.fps);
  const pingClass = getPerfClass('ping', state.pingMs);

  setTextIfChanged('perfFps', dom.fpsValue, fpsText);
  setTextIfChanged('perfPing', dom.pingValue, pingText);
  if (hudPrev.perfFpsCls !== fpsClass) {
    dom.fpsValue.className = fpsClass;
    hudPrev.perfFpsCls = fpsClass;
  }
  if (hudPrev.perfPingCls !== pingClass) {
    dom.pingValue.className = pingClass;
    hudPrev.perfPingCls = pingClass;
  }
}

let announcerTimeout: ReturnType<typeof setTimeout> | null = null;
export function showAnnouncerBanner(title: string, subtitle = '', durationMs = 2000): void {
  const banner = getEl('announcer-banner');
  getEl('announcer-title').textContent = title;
  getEl('announcer-sub').textContent = subtitle;
  banner.classList.remove('hidden');
  if (announcerTimeout) clearTimeout(announcerTimeout);
  announcerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

export function showToast(message: string): void {
  const toastContainer = getEl('toast-container');
  const toast = document.createElement('div');
  toast.className = 'hex-toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

export function renderChampionPickerUI(
  containerId: string,
  summaryId: string,
  selectedChampionId: ChampionId
): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  const selected = getChampionConfig(selectedChampionId);
  const summaryEl = document.getElementById(summaryId);
  if (summaryEl) {
    summaryEl.textContent = `${selected.name} — ${selected.q.name} (Q)`;
  }

  containerEl.querySelectorAll<HTMLElement>('.champion-option-card').forEach((card) => {
    const cid = card.getAttribute('data-champion');
    card.classList.toggle('selected', cid === selected.id);
  });
}

export function initChampionPicker(
  containerId: string,
  summaryId: string,
  onChampionSelected: (championId: ChampionId) => void
): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;

  containerEl.innerHTML = CHAMPION_LIST.map(
    (champ) => `
      <div class="champion-option-card clickable${champ.id === state.myChampionId ? ' selected' : ''}" data-champion="${champ.id}" title="${champ.q.description}">
        <img src="${champ.hud.icons.square}" alt="${champ.name}" />
        <div class="champion-option-info">
          <strong>${champ.name}</strong>
          <span>Q: ${champ.q.name}</span>
        </div>
      </div>
    `
  ).join('');

  renderChampionPickerUI(containerId, summaryId, state.myChampionId);

  containerEl.querySelectorAll<HTMLElement>('.champion-option-card').forEach((card) => {
    card.addEventListener('click', () => {
      audio.ensureContext();
      const cid = normalizeChampionId(card.getAttribute('data-champion'));
      state.myChampionId = cid;
      renderChampionPickerUI('home-champion-picker', 'home-champion-summary', cid);
      renderChampionPickerUI('lobby-champion-picker', 'lobby-champion-summary', cid);

      const brandAvatar = document.getElementById('brand-avatar-img') as HTMLImageElement | null;
      if (brandAvatar) {
        brandAvatar.src = getChampionConfig(cid).hud.icons.circle;
      }

      onChampionSelected(cid);
    });
  });
}

export function renderSpellPickerUI(
  containerId: string,
  spellsArray: [SummonerSpellId, SummonerSpellId]
): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  const cards = containerEl.querySelectorAll<HTMLElement>('.spell-option-card');
  cards.forEach((card) => {
    const sp = card.getAttribute('data-spell') as SummonerSpellId | null;
    const badge = card.querySelector<HTMLElement>('.spell-key-badge');
    card.classList.remove('selected-d', 'selected-f');
    if (!badge) return;
    if (spellsArray[0] === sp) {
      card.classList.add('selected-d');
      badge.style.display = 'flex';
      badge.textContent = 'D';
    } else if (spellsArray[1] === sp) {
      card.classList.add('selected-f');
      badge.style.display = 'flex';
      badge.textContent = 'F';
    } else {
      badge.style.display = 'none';
    }
  });
}

export function bindSpellPickerEvents(
  containerId: string,
  onSpellsChanged: (spells: [SummonerSpellId, SummonerSpellId]) => void
): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.querySelectorAll<HTMLElement>('.spell-option-card').forEach((card) => {
    card.addEventListener('click', () => {
      const clickedSpell = (card.getAttribute('data-spell') || 'flash') as SummonerSpellId;
      if (state.mySpells[0] === clickedSpell || state.mySpells[1] === clickedSpell) {
        state.mySpells = [state.mySpells[1], state.mySpells[0]];
      } else {
        state.mySpells = [state.mySpells[0], clickedSpell];
      }
      renderSpellPickerUI('home-spell-picker', state.mySpells);
      renderSpellPickerUI('lobby-spell-picker', state.mySpells);
      onSpellsChanged(state.mySpells);
    });
  });
}

export function getDropdownValue(id: string): string {
  const el = document.getElementById(id);
  return el?.getAttribute('data-value') || '';
}

export function initHexDropdowns(): void {
  const dropdowns = document.querySelectorAll<HTMLElement>('.hex-dropdown');

  const closeAllDropdowns = (except?: HTMLElement): void => {
    dropdowns.forEach((dd) => {
      if (dd !== except) {
        dd.classList.remove('open');
        const trig = dd.querySelector<HTMLElement>('.hex-dropdown-trigger');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      }
    });
  };

  dropdowns.forEach((dd) => {
    const trigger = dd.querySelector<HTMLButtonElement>('.hex-dropdown-trigger');
    const label = dd.querySelector<HTMLElement>('.hex-dropdown-label');
    const options = dd.querySelectorAll<HTMLElement>('.hex-dropdown-option');
    if (!trigger || !label) return;

    trigger.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      audio.ensureContext();
      const isOpen = dd.classList.contains('open');
      closeAllDropdowns(dd);
      if (isOpen) {
        dd.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        dd.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    options.forEach((opt) => {
      opt.addEventListener('click', (e: MouseEvent) => {
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

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });
}
