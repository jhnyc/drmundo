import { audio } from './audio.js';
import { mundoRigs } from './champion.js';
import { showAnnouncerBanner, showToast, spawnFloatingCombatText, updateInGameHud } from './hud.js';
import { SPELL_ICONS, SPELL_NAMES, getEl, state } from './state.js';
import { spawnFlashVfx, spawnGhostVfx, spawnHealVfx, spawnRingBurstVfx } from './vfx.js';
export function getShareableRoomUrl(includePasscode = true) {
    const url = new URL(window.location.origin);
    url.searchParams.set('room', state.roomId || '');
    if (includePasscode && state.passcode) {
        url.searchParams.set('pass', state.passcode);
    }
    return url.toString();
}
export function sendWs(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(payload));
    }
}
export function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}`);
    state.ws = ws;
    ws.addEventListener('open', () => {
        state.connected = true;
        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room');
        const passParam = params.get('pass') || '';
        if (roomParam) {
            getEl('input-join-code').value = roomParam.toUpperCase();
            if (passParam) {
                getEl('input-join-passcode').value = passParam;
            }
            sendWs({
                type: 'join_room',
                roomId: roomParam.toUpperCase(),
                passcode: passParam,
                name: getEl('input-player-name').value || 'Mundo Challenger',
                spells: state.mySpells
            });
        }
    });
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        handleServerMessage(msg);
    });
    ws.addEventListener('close', () => {
        state.connected = false;
        setTimeout(connectWebSocket, 1500);
    });
}
function renderEquippedPairHtml(spells = ['flash', 'ghost']) {
    return spells
        .map((sp, i) => `
    <div class="equipped-spell-box">
      <img src="${SPELL_ICONS[sp] || SPELL_ICONS.flash}" alt="${sp}" />
      <span>[${i === 0 ? 'D' : 'F'}] ${SPELL_NAMES[sp] || 'Flash'}</span>
    </div>
  `)
        .join('');
}
function updateLobbyDOM(lobby) {
    state.roomState = lobby.state;
    state.bestOf = lobby.settings?.bestOf || 3;
    state.botEnabled = lobby.botEnabled;
    getEl('lobby-room-code').textContent = lobby.roomId;
    getEl('lobby-room-passcode').textContent = lobby.passcode ? lobby.passcode : 'NONE (OPEN)';
    getEl('lobby-share-url').textContent = getShareableRoomUrl(true);
    const p0 = lobby.players?.[0];
    const p1 = lobby.players?.[1];
    getEl('slot-0-name').textContent = p0
        ? `${p0.name}${state.mySlot === 0 ? ' (You)' : ''}`
        : 'Waiting...';
    getEl('slot-0-spells').innerHTML = renderEquippedPairHtml(p0?.spells || ['flash', 'ghost']);
    const btnBot = getEl('btn-toggle-bot');
    if (p1) {
        getEl('slot-1-name').textContent = `${p1.name}${state.mySlot === 1 ? ' (You)' : ''}`;
        getEl('slot-1-sub').textContent = p1.isBot
            ? 'AI Challenger Bot • Ready for 1v1'
            : 'Dr. Mundo — The Madman of Zaun';
        getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(p1.spells || ['flash', 'ghost']);
        if (p1.isBot && state.mySlot === 0) {
            btnBot.style.display = 'inline-block';
            btnBot.textContent = 'Remove AI Bot';
        }
        else {
            btnBot.style.display = 'none';
        }
    }
    else {
        getEl('slot-1-name').textContent = 'Waiting for Opponent...';
        getEl('slot-1-sub').textContent = 'Share room link above or click + Add AI Bot';
        getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(['flash', 'ghost']);
        btnBot.style.display = state.mySlot === 0 ? 'inline-block' : 'none';
        btnBot.textContent = '+ Add AI Bot';
    }
    const startBtn = getEl('btn-start-match');
    const statusHint = getEl('lobby-status-hint');
    if (p0 && p1) {
        startBtn.disabled = false;
        statusHint.textContent = 'Both Mundos ready in the Baron Pit!';
    }
    else {
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
    }
    else {
        lobbyOverlay.classList.add('hidden');
        ingameHud.classList.remove('hidden');
    }
}
let lastCountdownInt = -1;
function handleGameEvents(events = []) {
    for (const ev of events) {
        if (ev.type === 'round_countdown') {
            getEl('gameover-modal').classList.add('hidden');
            showAnnouncerBanner(`ROUND ${ev.round}`, 'GET READY IN BARON PIT', 2200);
            audio.playCountdownTick(false);
        }
        else if (ev.type === 'fight_start') {
            showAnnouncerBanner('FIGHT!', 'DODGE & THROW INFECTED BONESAWS', 1400);
            audio.playCountdownTick(true);
        }
        else if (ev.type === 'q_windup') {
            const rig = mundoRigs[ev.slot];
            if (rig)
                rig.triggerQThrowVisual();
            audio.playCleaverThrow();
        }
        else if (ev.type === 'q_hit') {
            audio.playCleaverHit();
            spawnRingBurstVfx(ev.x, ev.z, 0xd67eff, 25, 115, 0.35);
            spawnFloatingCombatText(ev.x, ev.z, `-${ev.damage}`, 'magic-dmg');
            const attacker = state.serverPlayers[ev.attackerSlot];
            if (attacker) {
                spawnFloatingCombatText(attacker.x, attacker.z, `+${ev.refund} HP`, 'heal-text');
            }
        }
        else if (ev.type === 'q_miss') {
            audio.playCleaverMiss();
            spawnRingBurstVfx(ev.x, ev.z, 0x95a5a6, 10, 45, 0.22);
        }
        else if (ev.type === 'spell_flash') {
            audio.playFlash();
            spawnFlashVfx(ev.slot, ev.fromX, ev.fromZ, ev.toX, ev.toZ);
        }
        else if (ev.type === 'spell_heal') {
            audio.playHeal();
            spawnHealVfx(ev.slot, ev.x, ev.z);
            spawnFloatingCombatText(ev.x, ev.z, `+${ev.amount} HP`, 'heal-text');
        }
        else if (ev.type === 'spell_ghost') {
            audio.playGhost(ev.duration);
            spawnGhostVfx(ev.slot, ev.x, ev.z);
        }
        else if (ev.type === 'round_kill') {
            const winnerName = state.serverPlayers[ev.winnerSlot]?.name || 'Dr. Mundo';
            audio.playTauntVo();
            if (ev.matchOver) {
                const iWon = ev.winnerSlot === state.mySlot;
                const modal = getEl('gameover-modal');
                const titleEl = getEl('gameover-title');
                const subEl = getEl('gameover-subtitle');
                const statsEl = getEl('gameover-stats');
                titleEl.textContent = iWon ? 'VICTORY' : 'DEFEAT';
                titleEl.className = iWon ? 'victory' : 'defeat';
                subEl.textContent = `${winnerName} wins the Baron Pit 1v1 (${ev.scores[0]} - ${ev.scores[1]})!`;
                const me = state.serverPlayers[state.mySlot];
                const thrown = me?.stats?.cleaversThrown || 0;
                const hits = me?.stats?.cleaversHit || 0;
                const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
                statsEl.innerHTML = `
          <div><b>Final Series Score:</b> ${ev.scores[0]} – ${ev.scores[1]}</div>
          <div><b>Your Bonesaw Accuracy:</b> ${acc}% (${hits} Hit / ${thrown} Thrown)</div>
          <div><b>Total Bonesaw Damage Dealt:</b> ${me?.stats?.damageDealt || 0}</div>
        `;
                setTimeout(() => modal.classList.remove('hidden'), 1100);
            }
            else {
                showAnnouncerBanner(ev.winnerSlot === state.mySlot ? 'ROUND WON!' : 'ROUND LOST', `${winnerName} scores! (${ev.scores[0]} - ${ev.scores[1]})`, 2800);
            }
        }
    }
}
export function handleServerMessage(msg) {
    if (msg.type === 'error_msg') {
        showToast(msg.message || 'Error');
        if (msg.code === 'INVALID_PASSCODE' && msg.roomId) {
            getEl('input-join-code').value = msg.roomId;
            getEl('input-join-passcode').focus();
        }
        return;
    }
    if (msg.type === 'joined_room') {
        state.roomId = msg.roomId;
        state.mySlot = msg.slot;
        state.passcode = msg.passcode || '';
        audio.playChooseVo();
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('room', state.roomId);
        if (state.passcode) {
            newUrl.searchParams.set('pass', state.passcode);
        }
        else {
            newUrl.searchParams.delete('pass');
        }
        window.history.replaceState({}, '', newUrl.toString());
        updateLobbyDOM(msg.lobby);
        return;
    }
    if (msg.type === 'room_update') {
        if (msg.passcode !== undefined)
            state.passcode = msg.passcode;
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
        if (msg.state === 'countdown') {
            const sec = Math.ceil(msg.countdownTimer);
            if (sec > 0 && sec !== lastCountdownInt) {
                lastCountdownInt = sec;
                showAnnouncerBanner(`${sec}`, `ROUND ${msg.round} STARTING`, 900);
                audio.playCountdownTick(false);
            }
        }
        else {
            lastCountdownInt = -1;
        }
        if (msg.events && msg.events.length > 0) {
            handleGameEvents(msg.events);
        }
        updateInGameHud();
    }
}
