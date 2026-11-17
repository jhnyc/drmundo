import * as THREE from 'three';
import { DEFAULT_CHAMPION_ID } from '../shared/champions/index.js';
import { INV_SQRT2, LOL_SCALE, PIT_RADIUS, SPELL_ICONS, SPELL_NAMES } from '../shared/constants.js';
export { INV_SQRT2, LOL_SCALE, PIT_RADIUS, SPELL_ICONS, SPELL_NAMES };
export const state = {
    ws: null,
    connected: false,
    roomId: null,
    passcode: '',
    mySlot: 0,
    myChampionId: DEFAULT_CHAMPION_ID,
    mySpells: ['flash', 'ghost'],
    roomState: 'lobby',
    round: 1,
    bestOf: 3,
    botEnabled: false,
    cameraLocked: false,
    cameraZoom: 1.0,
    cameraFocus: new THREE.Vector3(0, 0, 0),
    mouseScreen: new THREE.Vector2(0, 0),
    mouseWorld: new THREE.Vector3(0, 0, 0),
    showSkillshotIndicator: false,
    serverPlayers: [null, null],
    serverProjectiles: [],
    serverGroundZones: [],
    assetsLoaded: false,
    fps: null,
    pingMs: null
};
export function getEl(id) {
    return document.getElementById(id);
}
