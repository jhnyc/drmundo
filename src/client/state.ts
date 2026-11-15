import * as THREE from 'three';
import type {
  BestOfFormat,
  PlayerSnapshot,
  ProjectileSnapshot,
  RoomState,
  SummonerSpellId
} from '../shared/types.js';

// 1 Three.js World Unit = 1 League of Legends Unit
export const LOL_SCALE = 1 / 0.0085; // converts Khada 0.0085 scale back to 1:1 LoL units
export const PIT_RADIUS = 820;
export const Q_RANGE = 1050;
export const Q_RADIUS = 60;
export const INV_SQRT2 = Math.SQRT1_2;

export const SPELL_ICONS: Record<SummonerSpellId, string> = {
  flash: '/assets/icons/summoner_flash.png',
  heal: '/assets/icons/summoner_heal.png',
  ghost: '/assets/icons/summoner_ghost.png'
};

export const SPELL_NAMES: Record<SummonerSpellId, string> = {
  flash: 'Flash',
  heal: 'Heal',
  ghost: 'Ghost'
};

export interface ClientState {
  ws: WebSocket | null;
  connected: boolean;
  roomId: string | null;
  passcode: string;
  mySlot: number;
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
  assetsLoaded: boolean;
}

export const state: ClientState = {
  ws: null,
  connected: false,
  roomId: null,
  passcode: '',
  mySlot: 0,
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
  assetsLoaded: false
};

export function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
