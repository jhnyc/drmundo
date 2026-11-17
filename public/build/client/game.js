import { CHAMPION_LIST, getChampionConfig } from '../shared/champions/index.js';
import { audio } from './audio.js';
import { championRigs, loadProjectileTemplate, loadZoneMeshTemplate } from './champion.js';
import { bindSpellPickerEvents, getDropdownValue, initChampionPicker, initHexDropdowns, showToast, updateFloatingHealthBars, updatePerformanceHud } from './hud.js';
import { connectWebSocket, getShareableRoomUrl, sendWs } from './network.js';
import { MAX_RENDER_PIXEL_RATIO, buildBaronPitEnvironment, camera, groundRayPlane, loadVfxTextures, raycaster, renderer, scene, updateCameraTransform, voidParticles, wardMixers } from './scene.js';
import { getEl, state } from './state.js';
import { loadChampionVfxTextures, prewarmAllVfxShaders, spawnGhostTrailStep, spawnMoveClickIndicator, syncGroundZones, syncProjectiles, updateSkillshotIndicator, updateTransientVfx } from './vfx.js';
// ============================================================================
// UI INITIALIZATION & LOBBY BUTTON BINDINGS
// ============================================================================
const onChampionSelected = (championId) => {
    const nameInput = getEl('input-player-name');
    const currentName = nameInput.value.trim();
    const isDefaultName = !currentName || CHAMPION_LIST.some((c) => c.defaultPlayerName === currentName || c.name === currentName);
    const nextChamp = getChampionConfig(championId);
    if (isDefaultName) {
        nameInput.value = nextChamp.defaultPlayerName;
    }
    audio.playChooseVo(championId);
    void championRigs[0].load(championId);
    void championRigs[1].load(championId);
    if (state.roomId && state.mySlot === 0) {
        sendWs({ type: 'select_champion', championId });
        if (isDefaultName) {
            sendWs({ type: 'update_name', name: nextChamp.defaultPlayerName });
        }
    }
};
initChampionPicker('home-champion-picker', 'home-champion-summary', onChampionSelected);
initChampionPicker('lobby-champion-picker', 'lobby-champion-summary', onChampionSelected);
const onSpellsChanged = (spells) => {
    if (state.roomId) {
        sendWs({ type: 'select_spells', spells });
    }
};
bindSpellPickerEvents('home-spell-picker', onSpellsChanged);
bindSpellPickerEvents('lobby-spell-picker', onSpellsChanged);
initHexDropdowns();
getEl('btn-create-room').addEventListener('click', () => {
    audio.ensureContext();
    const defaultName = getChampionConfig(state.myChampionId).defaultPlayerName;
    sendWs({
        type: 'create_room',
        name: getEl('input-player-name').value.trim() || defaultName,
        championId: state.myChampionId,
        passcode: getEl('input-create-passcode').value.trim(),
        bestOf: Number(getDropdownValue('dropdown-best-of') || 3),
        cooldownMode: (getDropdownValue('dropdown-cd-mode') || 'fast'),
        spells: state.mySpells,
        withBot: false
    });
});
getEl('btn-practice-bot').addEventListener('click', () => {
    audio.ensureContext();
    const defaultName = getChampionConfig(state.myChampionId).defaultPlayerName;
    sendWs({
        type: 'create_room',
        name: getEl('input-player-name').value.trim() || defaultName,
        championId: state.myChampionId,
        passcode: getEl('input-create-passcode').value.trim(),
        bestOf: Number(getDropdownValue('dropdown-best-of') || 3),
        cooldownMode: (getDropdownValue('dropdown-cd-mode') || 'fast'),
        spells: state.mySpells,
        withBot: true
    });
    setTimeout(() => {
        sendWs({ type: 'start_match' });
    }, 150);
});
getEl('btn-join-room').addEventListener('click', () => {
    audio.ensureContext();
    const code = getEl('input-join-code').value.trim().toUpperCase();
    if (!code) {
        showToast('Please enter a Room Code');
        return;
    }
    const defaultName = getChampionConfig(state.myChampionId).defaultPlayerName;
    sendWs({
        type: 'join_room',
        roomId: code,
        passcode: getEl('input-join-passcode').value.trim(),
        name: getEl('input-player-name').value.trim() || defaultName,
        spells: state.mySpells
    });
});
getEl('input-join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')
        getEl('btn-join-room').click();
});
getEl('input-join-passcode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')
        getEl('btn-join-room').click();
});
getEl('btn-copy-share-link').addEventListener('click', async () => {
    const link = getShareableRoomUrl(true);
    await navigator.clipboard.writeText(link).catch(() => { });
    showToast('Copied Shareable Room Link to clipboard!');
});
getEl('btn-copy-code-pass').addEventListener('click', async () => {
    const linkNoPass = getShareableRoomUrl(false);
    const text = `Baron Pit 1v1 — Room Code: ${state.roomId}${state.passcode ? ` | Passcode: ${state.passcode}` : ''} | Link: ${linkNoPass}`;
    await navigator.clipboard.writeText(text).catch(() => { });
    showToast('Copied Room Code & Passcode details!');
});
getEl('btn-toggle-bot').addEventListener('click', () => {
    sendWs({ type: 'toggle_bot' });
});
getEl('btn-start-match').addEventListener('click', () => {
    if (!state.serverPlayers[1] && !state.botEnabled) {
        sendWs({ type: 'toggle_bot' });
        setTimeout(() => sendWs({ type: 'start_match' }), 80);
    }
    else {
        sendWs({ type: 'start_match' });
    }
});
getEl('btn-leave-room').addEventListener('click', () => {
    window.location.href = window.location.pathname;
});
getEl('btn-rematch').addEventListener('click', () => {
    getEl('gameover-modal').classList.add('hidden');
    sendWs({ type: 'rematch' });
});
getEl('btn-back-lobby').addEventListener('click', () => {
    getEl('gameover-modal').classList.add('hidden');
    sendWs({ type: 'return_to_lobby' });
});
getEl('btn-mute-audio').addEventListener('click', (e) => {
    audio.muted = !audio.muted;
    const target = e.currentTarget;
    if (target) {
        target.textContent = audio.muted ? 'Sound: OFF' : 'Sound: ON';
    }
});
// ============================================================================
// IN-GAME HUD & LEAGUE OF LEGENDS INPUT CONTROLS
// ============================================================================
const hudSlotQ = getEl('hud-slot-q');
hudSlotQ.addEventListener('mouseenter', () => {
    state.showSkillshotIndicator = true;
});
hudSlotQ.addEventListener('mouseleave', () => {
    state.showSkillshotIndicator = false;
});
hudSlotQ.addEventListener('click', () => {
    sendWs({ type: 'cast_q', x: state.mouseWorld.x, z: state.mouseWorld.z });
});
getEl('hud-slot-d').addEventListener('click', () => {
    sendWs({ type: 'cast_spell', spellIndex: 0, x: state.mouseWorld.x, z: state.mouseWorld.z });
});
getEl('hud-slot-f').addEventListener('click', () => {
    sendWs({ type: 'cast_spell', spellIndex: 1, x: state.mouseWorld.x, z: state.mouseWorld.z });
});
function updateMouseWorldPosition(clientX, clientY) {
    state.mouseScreen.x = (clientX / window.innerWidth) * 2 - 1;
    state.mouseScreen.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(state.mouseScreen, camera);
    raycaster.ray.intersectPlane(groundRayPlane, state.mouseWorld);
}
window.addEventListener('mousemove', (e) => {
    updateMouseWorldPosition(e.clientX, e.clientY);
});
window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});
renderer.domElement.addEventListener('mousedown', (e) => {
    audio.ensureContext();
    if (e.button === 2) {
        updateMouseWorldPosition(e.clientX, e.clientY);
        if (state.roomState === 'playing') {
            sendWs({
                type: 'move',
                x: state.mouseWorld.x,
                z: state.mouseWorld.z
            });
            spawnMoveClickIndicator(state.mouseWorld.x, state.mouseWorld.z);
            audio.playMoveClick();
        }
    }
});
window.addEventListener('wheel', (e) => {
    if (!getEl('lobby-overlay').classList.contains('hidden'))
        return;
    state.cameraZoom = Math.max(0.68, Math.min(1.28, state.cameraZoom + e.deltaY * 0.0005));
}, { passive: true });
window.addEventListener('keydown', (e) => {
    if (document.activeElement &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        return;
    }
    const key = e.key.toLowerCase();
    if (key === 'q') {
        if (e.shiftKey) {
            state.showSkillshotIndicator = true;
        }
        sendWs({
            type: 'cast_q',
            x: state.mouseWorld.x,
            z: state.mouseWorld.z
        });
    }
    else if (key === 'd') {
        sendWs({
            type: 'cast_spell',
            spellIndex: 0,
            x: state.mouseWorld.x,
            z: state.mouseWorld.z
        });
    }
    else if (key === 'f') {
        sendWs({
            type: 'cast_spell',
            spellIndex: 1,
            x: state.mouseWorld.x,
            z: state.mouseWorld.z
        });
    }
    else if (key === 's') {
        sendWs({ type: 'stop' });
    }
    else if (key === 'y') {
        state.cameraLocked = !state.cameraLocked;
        showToast(`Camera Lock: ${state.cameraLocked ? 'ON' : 'OFF'}`);
    }
    else if (e.code === 'Space') {
        state.cameraLocked = true;
    }
    else if (key === '1') {
        sendWs({ type: 'emote', emote: 'joke' });
    }
    else if (key === '2') {
        sendWs({ type: 'emote', emote: 'taunt' });
        audio.playTauntVo(state.serverPlayers[state.mySlot]?.championId || state.myChampionId);
    }
    else if (key === '3') {
        sendWs({ type: 'emote', emote: 'dance' });
    }
    else if (key === '4') {
        sendWs({ type: 'emote', emote: 'laugh' });
    }
    else if (key === 'b') {
        sendWs({ type: 'emote', emote: 'recall' });
        audio.playRecall();
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        state.cameraLocked = false;
    }
    if (e.key.toLowerCase() === 'q') {
        state.showSkillshotIndicator = false;
    }
});
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
});
// ============================================================================
// INITIALIZE ASSETS & MAIN 60FPS RENDER LOOP
// ============================================================================
async function initAllAssets() {
    try {
        const projectileLoads = CHAMPION_LIST.filter((c) => c.q.archetype === 'linear_projectile' && c.q.projectileVisual.kind === 'obj_model').map((c) => {
            if (c.q.archetype !== 'linear_projectile')
                return Promise.resolve(null);
            return loadProjectileTemplate(c.q.projectileVisual);
        });
        const zoneMeshLoads = CHAMPION_LIST.filter((c) => c.q.archetype === 'delayed_ground_aoe' && c.q.zoneVisual.meshUrl).map((c) => {
            if (c.q.archetype !== 'delayed_ground_aoe')
                return Promise.resolve(null);
            return loadZoneMeshTemplate(c.q.zoneVisual);
        });
        await Promise.all([
            loadVfxTextures(),
            loadChampionVfxTextures(),
            buildBaronPitEnvironment(),
            ...projectileLoads,
            ...zoneMeshLoads,
            championRigs[0].load(state.myChampionId),
            championRigs[1].load(state.myChampionId)
        ]);
        prewarmAllVfxShaders();
        state.assetsLoaded = true;
    }
    catch (err) {
        console.error('Error loading 3D assets:', err);
    }
}
void initAllAssets();
connectWebSocket();
let lastFrameTime = performance.now();
let fpsWindowStart = lastFrameTime;
let fpsFrameCount = 0;
function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    fpsFrameCount += 1;
    const fpsElapsed = now - fpsWindowStart;
    if (fpsElapsed >= 500) {
        if (fpsElapsed <= 2000) {
            state.fps = Math.round((fpsFrameCount * 1000) / fpsElapsed);
            updatePerformanceHud();
        }
        fpsFrameCount = 0;
        fpsWindowStart = now;
    }
    for (const m of wardMixers) {
        m.update(dt);
    }
    if (voidParticles) {
        voidParticles.rotation.y += dt * 0.04;
        voidParticles.position.y = Math.sin(now * 0.0008) * 14;
    }
    if (state.roomState === 'lobby' && !state.serverPlayers[0] && !state.serverPlayers[1]) {
        championRigs[0].update(dt, {
            championId: state.myChampionId,
            x: -300,
            z: -300,
            angle: Math.PI * 0.25,
            anim: 'idle',
            ghostTimer: 0,
            healSpeedTimer: 0,
            slowTimer: 0
        }, spawnGhostTrailStep);
        championRigs[1].update(dt, {
            championId: state.myChampionId,
            x: 300,
            z: 300,
            angle: -Math.PI * 0.75,
            anim: 'idle',
            ghostTimer: 0,
            healSpeedTimer: 0,
            slowTimer: 0
        }, spawnGhostTrailStep);
    }
    else {
        championRigs[0].update(dt, state.serverPlayers[0], spawnGhostTrailStep);
        championRigs[1].update(dt, state.serverPlayers[1], spawnGhostTrailStep);
    }
    syncProjectiles(dt);
    syncGroundZones(dt);
    updateTransientVfx(dt);
    updateSkillshotIndicator();
    updateCameraTransform(dt);
    updateFloatingHealthBars();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
