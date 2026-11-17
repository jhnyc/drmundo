import { CHAMPION_LIST, getChampionConfig } from '../shared/champions/index.js';
import type {
  ClientToServerMessage,
  GameEvent,
  RoomLobbyPayload,
  ServerToClientMessage,
  SummonerSpellId
} from '../shared/types.js';
import { audio } from './audio.js';
import { championRigs } from './champion.js';
import {
  renderChampionPickerUI,
  showAnnouncerBanner,
  showToast,
  spawnFloatingCombatText,
  updateInGameHud,
  updatePerformanceHud
} from './hud.js';
import { SPELL_ICONS, SPELL_NAMES, getEl, state } from './state.js';
import {
  spawnFlashVfx,
  spawnGhostVfx,
  spawnHealVfx,
  spawnRingBurstVfx,
  spawnZoneEruptionVfx
} from './vfx.js';

export function getShareableRoomUrl(includePasscode = true): string {
  const url = new URL(window.location.origin);
  url.searchParams.set('room', state.roomId || '');
  if (includePasscode && state.passcode) {
    url.searchParams.set('pass', state.passcode);
  }
  return url.toString();
}

export function sendWs(payload: ClientToServerMessage): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

const PING_INTERVAL_MS = 1000;
let pingIntervalId: ReturnType<typeof setInterval> | null = null;

function sendPing(): void {
  if (!document.hidden && state.connected) {
    sendWs({ type: 'ping', t: performance.now() });
  }
}

function stopPingLoop(): void {
  if (pingIntervalId !== null) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
}

function startPingLoop(): void {
  stopPingLoop();
  sendPing();
  pingIntervalId = setInterval(sendPing, PING_INTERVAL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.connected) {
    sendPing();
  }
});

export function connectWebSocket(): void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    startPingLoop();

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const passParam = params.get('pass') || '';
    if (roomParam) {
      getEl<HTMLInputElement>('input-join-code').value = roomParam.toUpperCase();
      if (passParam) {
        getEl<HTMLInputElement>('input-join-passcode').value = passParam;
      }
      const defaultName = getChampionConfig(state.myChampionId).defaultPlayerName;
      sendWs({
        type: 'join_room',
        roomId: roomParam.toUpperCase(),
        passcode: passParam,
        name: getEl<HTMLInputElement>('input-player-name').value || defaultName,
        championId: state.myChampionId,
        spells: state.mySpells
      });
    }
  });

  ws.addEventListener('message', (ev: MessageEvent<string>) => {
    const msg = JSON.parse(ev.data) as ServerToClientMessage;
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    state.connected = false;
    state.pingMs = null;
    stopPingLoop();
    updatePerformanceHud();
    setTimeout(connectWebSocket, 1500);
  });
}

function renderEquippedPairHtml(
  spells: [SummonerSpellId, SummonerSpellId] = ['flash', 'ghost']
): string {
  return spells
    .map(
      (sp, i) => `
    <div class="equipped-spell-box">
      <img src="${SPELL_ICONS[sp] || SPELL_ICONS.flash}" alt="${sp}" />
      <span>[${i === 0 ? 'D' : 'F'}] ${SPELL_NAMES[sp] || 'Flash'}</span>
    </div>
  `
    )
    .join('');
}

function renderBotChampionControls(activeChampionId: string): void {
  const el = getEl('bot-champion-controls');
  if (state.mySlot !== 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="bot-champion-label">Bot Champion</span>
    <div class="bot-champion-pills">
      ${CHAMPION_LIST.map(
        (c) => `
        <button type="button" class="bot-champ-pill clickable${c.id === activeChampionId ? ' active' : ''}" data-bot-champion="${c.id}">
          ${c.name}
        </button>
      `
      ).join('')}
    </div>
  `;

  el.querySelectorAll<HTMLElement>('[data-bot-champion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.getAttribute('data-bot-champion');
      if (cid) {
        sendWs({ type: 'select_bot_champion', championId: cid });
      }
    });
  });
}

function updateLobbyDOM(lobby: RoomLobbyPayload): void {
  state.roomState = lobby.state;
  state.bestOf = lobby.settings?.bestOf || 3;
  state.botEnabled = lobby.botEnabled;

  getEl('lobby-room-code').textContent = lobby.roomId;
  getEl('lobby-room-passcode').textContent = lobby.passcode ? lobby.passcode : 'NONE (OPEN)';
  getEl('lobby-share-url').textContent = getShareableRoomUrl(true);

  const p0 = lobby.players?.[0];
  const p1 = lobby.players?.[1];
  const myLobbyPlayer = lobby.players?.[state.mySlot];
  if (myLobbyPlayer) {
    state.myChampionId = myLobbyPlayer.championId;
    renderChampionPickerUI('lobby-champion-picker', 'lobby-champion-summary', myLobbyPlayer.championId);
    renderChampionPickerUI('home-champion-picker', 'home-champion-summary', myLobbyPlayer.championId);
  }

  const c0 = getChampionConfig(p0?.championId);
  getEl<HTMLImageElement>('slot-0-portrait-img').src = c0.hud.icons.square;
  getEl('slot-0-name').textContent = p0
    ? `${p0.name}${state.mySlot === 0 ? ' (You)' : ''}`
    : 'Waiting...';
  getEl('slot-0-champ-sub').textContent = p0 ? `${c0.name} — ${c0.title}` : c0.name;
  getEl('slot-0-spells').innerHTML = renderEquippedPairHtml(p0?.spells || ['flash', 'ghost']);
  if (p0) {
    void championRigs[0].load(p0.championId);
  }

  const btnBot = getEl<HTMLButtonElement>('btn-toggle-bot');
  const botControls = getEl('bot-champion-controls');
  if (p1) {
    const c1 = getChampionConfig(p1.championId);
    if (p1.isBot) state.botChampionId = p1.championId;
    getEl<HTMLImageElement>('slot-1-portrait-img').src = c1.hud.icons.square;
    getEl('slot-1-name').textContent = `${p1.name}${state.mySlot === 1 ? ' (You)' : ''}`;
    getEl('slot-1-sub').textContent = p1.isBot
      ? `AI Challenger (${c1.name}) • Ready for 1v1`
      : `${c1.name} — ${c1.title}`;
    getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(p1.spells || ['flash', 'ghost']);
    void championRigs[1].load(p1.championId);

    if (p1.isBot && state.mySlot === 0) {
      btnBot.style.display = 'inline-block';
      btnBot.textContent = 'Remove AI Bot';
      renderBotChampionControls(p1.championId);
    } else {
      btnBot.style.display = 'none';
      botControls.classList.add('hidden');
    }
  } else {
    const defaultChamp = getChampionConfig(state.botChampionId);
    getEl<HTMLImageElement>('slot-1-portrait-img').src = defaultChamp.hud.icons.square;
    getEl('slot-1-name').textContent = 'Waiting for Opponent...';
    getEl('slot-1-sub').textContent = 'Share room link above or click + Add AI Bot';
    getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(['flash', 'ghost']);
    btnBot.style.display = state.mySlot === 0 ? 'inline-block' : 'none';
    btnBot.textContent = '+ Add AI Bot';
    botControls.classList.add('hidden');
  }

  const startBtn = getEl<HTMLButtonElement>('btn-start-match');
  const statusHint = getEl('lobby-status-hint');
  if (p0 && p1) {
    startBtn.disabled = false;
    statusHint.textContent = 'Both challengers ready in the Baron Pit!';
  } else {
    startBtn.disabled = false;
    statusHint.textContent = 'Waiting for Player 2 (or click + Add AI Bot to start now)';
  }

  const lobbyOverlay = getEl('lobby-overlay');
  const ingameHud = getEl('ingame-hud');
  const gameoverModal = getEl('gameover-modal');

  if (lobby.state === 'lobby') {
    lobbyOverlay.classList.remove('hidden');
    getEl('home-view').classList.add('hidden');
    getEl('room-view').classList.remove('hidden');
    ingameHud.classList.add('hidden');
    gameoverModal.classList.add('hidden');
  } else {
    lobbyOverlay.classList.add('hidden');
    ingameHud.classList.remove('hidden');
  }
}

let lastCountdownInt = -1;

function handleGameEvents(events: GameEvent[] = []): void {
  for (const ev of events) {
    if (ev.type === 'round_countdown') {
      getEl('gameover-modal').classList.add('hidden');
      showAnnouncerBanner(`ROUND ${ev.round}`, 'GET READY IN BARON PIT', 2200);
      audio.playCountdownTick(false);
    } else if (ev.type === 'fight_start') {
      const myChamp = getChampionConfig(state.serverPlayers[state.mySlot]?.championId || state.myChampionId);
      showAnnouncerBanner('FIGHT!', myChamp.fightBannerSub, 1400);
      audio.playCountdownTick(true);
    } else if (ev.type === 'q_windup') {
      const rig = championRigs[ev.slot];
      if (rig) rig.triggerCastVisual();
      audio.playAbilityCast(ev.championId);
    } else if (ev.type === 'zone_spawn') {
      audio.playZoneSpawn(ev.championId);
    } else if (ev.type === 'zone_erupt') {
      audio.playZoneErupt(ev.championId);
      spawnZoneEruptionVfx(ev.championId, ev.x, ev.z, ev.radius);
    } else if (ev.type === 'q_hit') {
      const attackerChamp = getChampionConfig(ev.attackerChampionId);
      audio.playAbilityHit(ev.attackerChampionId);
      spawnRingBurstVfx(ev.x, ev.z, attackerChamp.q.vfx.hitColorHex, 25, 115, 0.35);
      spawnFloatingCombatText(ev.x, ev.z, `-${ev.damage}`, 'magic-dmg');
      if (ev.knockupDuration && ev.knockupDuration > 0) {
        spawnFloatingCombatText(ev.x, ev.z, 'AIRBORNE!', 'cc-text', 235);
      }
      if (ev.refund > 0) {
        const attacker = state.serverPlayers[ev.attackerSlot];
        if (attacker) {
          spawnFloatingCombatText(attacker.x, attacker.z, `+${ev.refund} HP`, 'heal-text');
        }
      }
    } else if (ev.type === 'q_miss') {
      // Delayed ground zones already play zone_erupt visuals/audio
      if (ev.projId !== undefined) {
        const champ = getChampionConfig(ev.attackerChampionId);
        audio.playAbilityMiss(ev.attackerChampionId);
        spawnRingBurstVfx(ev.x, ev.z, champ.q.vfx.missColorHex, 10, 45, 0.22);
      }
    } else if (ev.type === 'spell_flash') {
      audio.playFlash();
      spawnFlashVfx(ev.slot, ev.fromX, ev.fromZ, ev.toX, ev.toZ);
    } else if (ev.type === 'spell_heal') {
      audio.playHeal();
      spawnHealVfx(ev.slot, ev.x, ev.z);
      spawnFloatingCombatText(ev.x, ev.z, `+${ev.amount} HP`, 'heal-text');
    } else if (ev.type === 'spell_ghost') {
      audio.playGhost(ev.duration);
      spawnGhostVfx(ev.slot, ev.x, ev.z);
    } else if (ev.type === 'round_kill') {
      const winnerPlayer = state.serverPlayers[ev.winnerSlot];
      const winnerChamp = getChampionConfig(winnerPlayer?.championId);
      const winnerName = winnerPlayer?.name || winnerChamp.name;
      audio.playTauntVo(winnerPlayer?.championId);
      if (ev.matchOver) {
        const iWon = ev.winnerSlot === state.mySlot;
        const modal = getEl('gameover-modal');
        const titleEl = getEl('gameover-title');
        const subEl = getEl('gameover-subtitle');
        const statsEl = getEl('gameover-stats');

        titleEl.textContent = iWon ? 'VICTORY' : 'DEFEAT';
        titleEl.className = iWon ? 'victory' : 'defeat';
        subEl.textContent = `${winnerName} wins the Baron Pit 1v1 (${ev.scores[0]} - ${ev.scores[1]}) — ${winnerChamp.victoryLine}`;

        const me = state.serverPlayers[state.mySlot];
        const myChamp = getChampionConfig(me?.championId);
        const thrown = me?.stats?.abilitiesCast || 0;
        const hits = me?.stats?.abilitiesHit || 0;
        const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
        statsEl.innerHTML = `
          <div><b>Final Series Score:</b> ${ev.scores[0]} – ${ev.scores[1]}</div>
          <div><b>${myChamp.hud.accuracyLabel}:</b> ${acc}% (${hits} Hit / ${thrown} Cast)</div>
          <div><b>Total ${myChamp.q.name} Damage Dealt:</b> ${me?.stats?.damageDealt || 0}</div>
        `;
        setTimeout(() => modal.classList.remove('hidden'), 1100);
      } else {
        showAnnouncerBanner(
          ev.winnerSlot === state.mySlot ? 'ROUND WON!' : 'ROUND LOST',
          `${winnerName} scores! (${ev.scores[0]} - ${ev.scores[1]})`,
          2800
        );
      }
    }
  }
}

export function handleServerMessage(msg: ServerToClientMessage): void {
  if (msg.type === 'pong') {
    if (typeof msg.t === 'number' && Number.isFinite(msg.t)) {
      state.pingMs = Math.max(0, Math.round(performance.now() - msg.t));
      updatePerformanceHud();
    }
    return;
  }

  if (msg.type === 'error_msg') {
    showToast(msg.message || 'Error');
    if (msg.code === 'INVALID_PASSCODE' && msg.roomId) {
      getEl<HTMLInputElement>('input-join-code').value = msg.roomId;
      getEl<HTMLInputElement>('input-join-passcode').focus();
    }
    return;
  }

  if (msg.type === 'joined_room') {
    state.roomId = msg.roomId;
    state.mySlot = msg.slot;
    state.passcode = msg.passcode || '';
    const joinedChampId = msg.lobby.players[msg.slot]?.championId || state.myChampionId;
    audio.playChooseVo(joinedChampId);

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', state.roomId);
    if (state.passcode) {
      newUrl.searchParams.set('pass', state.passcode);
    } else {
      newUrl.searchParams.delete('pass');
    }
    window.history.replaceState({}, '', newUrl.toString());

    updateLobbyDOM(msg.lobby);
    return;
  }

  if (msg.type === 'room_update') {
    if (msg.passcode !== undefined) state.passcode = msg.passcode;
    updateLobbyDOM(msg);
    return;
  }

  if (msg.type === 'game_events') {
    handleGameEvents(msg.events);
    return;
  }

  if (msg.type === 'state_snapshot') {
    state.roomState = msg.state;
    state.round = msg.round;
    state.serverPlayers = msg.players;
    state.serverProjectiles = msg.projectiles || [];
    state.serverGroundZones = msg.groundZones || [];

    if (msg.state === 'countdown') {
      const sec = Math.ceil(msg.countdownTimer);
      if (sec > 0 && sec !== lastCountdownInt) {
        lastCountdownInt = sec;
        showAnnouncerBanner(`${sec}`, `ROUND ${msg.round} STARTING`, 900);
        audio.playCountdownTick(false);
      }
    } else {
      lastCountdownInt = -1;
    }

    if (msg.events && msg.events.length > 0) {
      handleGameEvents(msg.events);
    }

    updateInGameHud();
  }
}
