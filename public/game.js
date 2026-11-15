import { audio } from './audio.js';
import { loadCleaverProjectileTemplate, mundoRigs } from './champion.js';
import { bindSpellPickerEvents, getDropdownValue, initHexDropdowns, showToast, updateFloatingHealthBars } from './hud.js';
import { connectWebSocket, getShareableRoomUrl, sendWs } from './network.js';
import { buildBaronPitEnvironment, camera, groundRayPlane, loadVfxTextures, raycaster, renderer, scene, updateCameraTransform, voidParticles, wardMixers } from './scene.js';
import { getEl, state } from './state.js';
import { spawnGhostTrailStep, spawnMoveClickIndicator, syncProjectiles, updateSkillshotIndicator, updateTransientVfx } from './vfx.js';
// ============================================================================
// UI INITIALIZATION & LOBBY BUTTON BINDINGS
// ============================================================================
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
    sendWs({
        type: 'create_room',
        name: getEl('input-player-name').value.trim() || 'Dr. Mundo',
        passcode: getEl('input-create-passcode').value.trim(),
        bestOf: Number(getDropdownValue('dropdown-best-of') || 3),
        cooldownMode: (getDropdownValue('dropdown-cd-mode') || 'fast'),
        spells: state.mySpells,
        withBot: false
    });
});
getEl('btn-practice-bot').addEventListener('click', () => {
    audio.ensureContext();
    sendWs({
        type: 'create_room',
        name: getEl('input-player-name').value.trim() || 'Dr. Mundo',
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
    sendWs({
        type: 'join_room',
        roomId: code,
        passcode: getEl('input-join-passcode').value.trim(),
        name: getEl('input-player-name').value.trim() || 'Dr. Mundo',
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
    const text = `Baron Pit Dr. Mundo 1v1 — Room Code: ${state.roomId}${state.passcode ? ` | Passcode: ${state.passcode}` : ''} | Link: ${linkNoPass}`;
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
    if (state.roomState !== 'playing')
        return;
    audio.ensureContext();
    updateMouseWorldPosition(e.clientX, e.clientY);
    sendWs({
        type: 'move',
        x: state.mouseWorld.x,
        z: state.mouseWorld.z
    });
    spawnMoveClickIndicator(state.mouseWorld.x, state.mouseWorld.z);
    audio.playMoveClick();
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
        audio.playTauntVo();
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
    renderer.setSize(window.innerWidth, window.innerHeight);
});
// ============================================================================
// INITIALIZE ASSETS & MAIN 60FPS RENDER LOOP
// ============================================================================
async function initAllAssets() {
    try {
        await Promise.all([
            loadVfxTextures(),
            buildBaronPitEnvironment(),
            loadCleaverProjectileTemplate(),
            mundoRigs[0].load(),
            mundoRigs[1].load()
        ]);
        state.assetsLoaded = true;
    }
    catch (err) {
        console.error('Error loading 3D assets:', err);
    }
}
void initAllAssets();
connectWebSocket();
let lastFrameTime = performance.now();
function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    for (const m of wardMixers) {
        m.update(dt);
    }
    if (voidParticles) {
        const pos = voidParticles.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            let y = pos.getY(i) + dt * 14;
            if (y > 165)
                y = 10;
            pos.setY(i, y);
        }
        pos.needsUpdate = true;
        voidParticles.rotation.y += dt * 0.04;
    }
    if (state.roomState === 'lobby' && !state.serverPlayers[0] && !state.serverPlayers[1]) {
        mundoRigs[0].update(dt, {
            x: -300,
            z: -300,
            angle: Math.PI * 0.25,
            anim: 'idle',
            ghostTimer: 0,
            healSpeedTimer: 0,
            slowTimer: 0
        }, spawnGhostTrailStep);
        mundoRigs[1].update(dt, {
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
        mundoRigs[0].update(dt, state.serverPlayers[0], spawnGhostTrailStep);
        mundoRigs[1].update(dt, state.serverPlayers[1], spawnGhostTrailStep);
    }
    syncProjectiles(dt);
    updateTransientVfx(dt);
    updateSkillshotIndicator();
    updateCameraTransform(dt);
    updateFloatingHealthBars();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
