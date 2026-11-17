import type { WebSocket } from 'ws';
import type {
  AnimKey,
  ChampionId,
  EmoteKey,
  GameEvent,
  PlayerMatchStats,
  RoomSettings,
  RoomState,
  SummonerSpellId
} from '../shared/types.js';

export interface BotAIState {
  moveCooldown: number;
  strafeSign: number;
  qThinkCooldown: number;
}

export interface PendingCast {
  targetX: number;
  targetZ: number;
  dirX: number;
  dirZ: number;
}

export interface ServerPlayerState {
  slot: number;
  name: string;
  championId: ChampionId;
  isBot: boolean;
  ready: boolean;
  spells: [SummonerSpellId, SummonerSpellId];
  score: number;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  anim: AnimKey;
  emoteAnim?: EmoteKey;
  qCd: number;
  maxQCd: number;
  spellCd: [number, number];
  maxSpellCd: [number, number];
  castTimer: number;
  pendingCast: PendingCast | null;
  slowTimer: number;
  slowPercent: number;
  knockupTimer: number;
  knockupDuration: number;
  ghostTimer: number;
  healSpeedTimer: number;
  emoteTimer: number;
  stats: PlayerMatchStats;
  aiState: BotAIState | null;
  awaitingReconnect?: boolean;
}

export interface ServerProjectile {
  id: number;
  ownerSlot: number;
  championId: ChampionId;
  x: number;
  z: number;
  startX: number;
  startZ: number;
  dirX: number;
  dirZ: number;
  speed: number;
  maxRange: number;
  radius: number;
  damageFlatMin: number;
  damagePercentCurrentHp: number;
  slowPercent: number;
  slowDuration: number;
  refundOnHit: number;
}

export interface ServerGroundZone {
  id: number;
  ownerSlot: number;
  championId: ChampionId;
  x: number;
  z: number;
  radius: number;
  remaining: number;
  duration: number;
  damageFlatMin: number;
  damagePercentCurrentHp: number;
  knockupDuration: number;
  slowPercent: number;
  slowDuration: number;
  refundOnHit: number;
}

export interface ConnectedClient {
  id: string;
  ws: WebSocket;
  roomId: string | null;
  slot: number | null;
}

export interface GameRoom {
  id: string;
  passcode: string;
  championId: ChampionId;
  state: RoomState;
  round: number;
  matchTime: number;
  countdownTimer: number;
  lastBroadcastCountdownSec: number;
  roundEndTimer: number;
  nextProjId: number;
  nextZoneId: number;
  winnerSlot?: number;
  botEnabled: boolean;
  botDifficulty: string;
  settings: RoomSettings;
  clients: ConnectedClient[];
  players: [ServerPlayerState | null, ServerPlayerState | null];
  projectiles: ServerProjectile[];
  groundZones: ServerGroundZone[];
  events: GameEvent[];
  restoredAt?: number;
}
