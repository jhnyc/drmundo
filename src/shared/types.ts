export type ChampionId = 'drmundo';

export type SummonerSpellId = 'flash' | 'heal' | 'ghost';

export type CooldownMode = 'fast' | 'standard';

export type BestOfFormat = 1 | 3 | 5;

export type RoomState = 'lobby' | 'countdown' | 'playing' | 'round_end' | 'gameover';

export type AnimKey =
  | 'idle'
  | 'run'
  | 'run_haste'
  | 'q_cast'
  | 'death'
  | 'taunt'
  | 'joke'
  | 'dance'
  | 'laugh'
  | 'recall';

export type EmoteKey = 'taunt' | 'joke' | 'dance' | 'laugh' | 'recall';

export interface RoomSettings {
  bestOf: BestOfFormat;
  cooldownMode: CooldownMode;
}

export interface PlayerMatchStats {
  abilitiesCast: number;
  abilitiesHit: number;
  damageDealt: number;
}

export interface LobbyPlayerInfo {
  slot: number;
  name: string;
  championId: ChampionId;
  isBot: boolean;
  ready: boolean;
  spells: [SummonerSpellId, SummonerSpellId];
  score: number;
  stats: PlayerMatchStats;
}

export interface RoomSummary {
  id: string;
  hostName: string;
  playerCount: number;
  hasPasscode: boolean;
  state: RoomState;
  bestOf: BestOfFormat;
}

export interface RoomLobbyPayload {
  type: 'room_update';
  roomId: string;
  hasPasscode: boolean;
  passcode: string;
  state: RoomState;
  round: number;
  settings: RoomSettings;
  botEnabled: boolean;
  botDifficulty: string;
  players: [LobbyPlayerInfo | null, LobbyPlayerInfo | null];
}

export interface PlayerSnapshot {
  slot: number;
  name: string;
  championId: ChampionId;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  anim: AnimKey;
  qCd: number;
  maxQCd: number;
  spellCd: [number, number];
  maxSpellCd: [number, number];
  spells: [SummonerSpellId, SummonerSpellId];
  slowTimer: number;
  slowPercent: number;
  knockupTimer: number;
  knockupDuration: number;
  ghostTimer: number;
  healSpeedTimer: number;
  score: number;
  stats: PlayerMatchStats;
}

export interface ProjectileSnapshot {
  id: number;
  ownerSlot: number;
  championId: ChampionId;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  radius: number;
}

export interface GroundZoneSnapshot {
  id: number;
  ownerSlot: number;
  championId: ChampionId;
  x: number;
  z: number;
  radius: number;
  remaining: number;
  duration: number;
}

export type GameEvent =
  | { type: 'round_countdown'; round: number }
  | { type: 'fight_start'; round: number }
  | {
      type: 'q_windup';
      slot: number;
      championId: ChampionId;
      x: number;
      z: number;
      targetX: number;
      targetZ: number;
      dirX: number;
      dirZ: number;
    }
  | {
      type: 'q_launch';
      slot: number;
      championId: ChampionId;
      projId: number;
      x: number;
      z: number;
      dirX: number;
      dirZ: number;
    }
  | {
      type: 'q_hit';
      projId?: number;
      zoneId?: number;
      attackerSlot: number;
      attackerChampionId: ChampionId;
      victimSlot: number;
      x: number;
      z: number;
      damage: number;
      refund: number;
      knockupDuration?: number;
    }
  | {
      type: 'q_miss';
      projId?: number;
      zoneId?: number;
      attackerSlot: number;
      attackerChampionId: ChampionId;
      x: number;
      z: number;
    }
  | {
      type: 'zone_spawn';
      zoneId: number;
      ownerSlot: number;
      championId: ChampionId;
      x: number;
      z: number;
      radius: number;
      duration: number;
    }
  | {
      type: 'zone_erupt';
      zoneId: number;
      ownerSlot: number;
      championId: ChampionId;
      x: number;
      z: number;
      radius: number;
      hitVictim: boolean;
    }
  | { type: 'spell_flash'; slot: number; fromX: number; fromZ: number; toX: number; toZ: number }
  | { type: 'spell_heal'; slot: number; x: number; z: number; amount: number }
  | { type: 'spell_ghost'; slot: number; x: number; z: number; duration: number }
  | {
      type: 'round_kill';
      winnerSlot: number;
      loserSlot: number;
      round: number;
      scores: [number, number];
      matchOver: boolean;
    };

export type ServerToClientMessage =
  | {
      type: 'room_check_result';
      exists: boolean;
      roomId: string;
      hasPasscode?: boolean;
      hostName?: string;
    }
  | {
      type: 'error_msg';
      code?: 'NOT_FOUND' | 'INVALID_PASSCODE' | 'ROOM_FULL';
      roomId?: string;
      message: string;
    }
  | {
      type: 'joined_room';
      roomId: string;
      slot: number;
      passcode: string;
      lobby: RoomLobbyPayload;
    }
  | RoomLobbyPayload
  | {
      type: 'game_events';
      events: GameEvent[];
    }
  | {
      type: 'pong';
      t: number;
    }
  | {
      type: 'state_snapshot';
      state: RoomState;
      round: number;
      countdownTimer: number;
      players: [PlayerSnapshot | null, PlayerSnapshot | null];
      projectiles: ProjectileSnapshot[];
      groundZones: GroundZoneSnapshot[];
      events: GameEvent[];
    };

export type ClientToServerMessage =
  | { type: 'check_room'; roomId?: string }
  | {
      type: 'create_room';
      customCode?: string;
      name?: string;
      championId?: string;
      botChampionId?: string;
      passcode?: string;
      bestOf?: number;
      cooldownMode?: CooldownMode;
      spells?: string[];
      withBot?: boolean;
    }
  | {
      type: 'join_room';
      roomId?: string;
      passcode?: string;
      name?: string;
      championId?: string;
      spells?: string[];
    }
  | { type: 'select_champion'; championId: string }
  | { type: 'select_bot_champion'; championId: string }
  | { type: 'select_spells'; spells?: string[] }
  | { type: 'update_name'; name?: string }
  | { type: 'toggle_bot' }
  | { type: 'update_settings'; bestOf?: number; cooldownMode?: CooldownMode }
  | { type: 'set_ready'; ready?: boolean }
  | { type: 'start_match' }
  | { type: 'rematch' }
  | { type: 'return_to_lobby' }
  | { type: 'move'; x: number; z: number }
  | { type: 'stop' }
  | { type: 'cast_q'; x: number; z: number }
  | { type: 'cast_spell'; spellIndex: number; x: number; z: number }
  | { type: 'emote'; emote: EmoteKey }
  | { type: 'ping'; t: number };
