import * as THREE from 'three';
import { DEFAULT_CHAMPION_ID } from '../shared/champions/index.js';
import {
  INV_SQRT2,
  LOL_SCALE,
  PIT_RADIUS,
  SPELL_ICONS,
  SPELL_NAMES
} from '../shared/constants.js';
import type {
  BestOfFormat,
  ChampionId,
  GroundZoneSnapshot,
  PlayerSnapshot,
  ProjectileSnapshot,
  RoomState,
  SummonerSpellId
} from '../shared/types.js';

export { INV_SQRT2, LOL_SCALE, PIT_RADIUS, SPELL_ICONS, SPELL_NAMES };

export interface ClientState {
  ws: WebSocket | null;
  connected: boolean;
  roomId: string | null;
  passcode: string;
  mySlot: number;
  myChampionId: ChampionId;
  botChampionId: ChampionId;
  mySpells: [SummonerSpellId, SummonerSpellId];
  roomState: RoomState;
  round: number;
  bestOf: BestOfFormat;
  botEnabled: boolean;
  cameraLocked: boolean;
  cameraZoom: number;
  cameraFocus: THREE.Vector3;
  mouseScreen: THREE.Vector2;
  mouseWorld: THREE.Vector3;
  showSkillshotIndicator: boolean;
  serverPlayers: [PlayerSnapshot | null, PlayerSnapshot | null];
  serverProjectiles: ProjectileSnapshot[];
  serverGroundZones: GroundZoneSnapshot[];
  assetsLoaded: boolean;
  fps: number | null;
  pingMs: number | null;
}

export const state: ClientState = {
  ws: null,
  connected: false,
  roomId: null,
  passcode: '',
  mySlot: 0,
  myChampionId: DEFAULT_CHAMPION_ID,
  botChampionId: DEFAULT_CHAMPION_ID,
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

export function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
