import type { WebSocket } from 'ws';
import type {
  AnimKey,
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
  dirX: number;
  dirZ: number;
}

export interface ServerPlayerState {
  slot: number;
  name: string;
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
  x: number;
  z: number;
  startX: number;
  startZ: number;
  dirX: number;
  dirZ: number;
  speed: number;
  maxRange: number;
  radius: number;
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
  state: RoomState;
  round: number;
  matchTime: number;
  countdownTimer: number;
  lastBroadcastCountdownSec: number;
  roundEndTimer: number;
  nextProjId: number;
  winnerSlot?: number;
  botEnabled: boolean;
  botDifficulty: string;
  settings: RoomSettings;
  clients: ConnectedClient[];
  players: [ServerPlayerState | null, ServerPlayerState | null];
  projectiles: ServerProjectile[];
  events: GameEvent[];
  restoredAt?: number;
}
