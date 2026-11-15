import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import crypto from 'crypto';
import type {
  AnimKey,
  BestOfFormat,
  ClientToServerMessage,
  CooldownMode,
  EmoteKey,
  GameEvent,
  LobbyPlayerInfo,
  PlayerMatchStats,
  PlayerSnapshot,
  ProjectileSnapshot,
  RoomLobbyPayload,
  RoomSettings,
  RoomState,
  RoomSummary,
  ServerToClientMessage,
  SummonerSpellId
} from '../shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use('/three', express.static(path.join(PROJECT_ROOT, 'node_modules/three')));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// ============================================================================
// SERVER-SIDE TYPES & CONSTANTS (1 unit = 1 League of Legends unit)
// ============================================================================
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const INV_SQRT2 = Math.SQRT1_2;
const PIT_RADIUS = 820; // Walkable inner radius of Baron Pit
const LINE_BUFFER = 52; // Minimum distance from center ward line (champion hitbox barrier)

const MUNDO_STATS = {
  maxHp: 1850,
  hpRegenPerSec: 16,
  baseMoveSpeed: 385,
  hitboxRadius: 65,
  qCooldown: 4.0,
  qCost: 50,
  qCastTime: 0.22,
  qRange: 1050,
  qSpeed: 2000,
  qRadius: 60,
  qPercentCurrentHp: 0.22,
  qMinDamage: 215,
  qSlowPercent: 0.40,
  qSlowDuration: 2.0
} as const;

interface SummonerSpellBase {
  id: SummonerSpellId;
  name: string;
  cooldownFast: number;
  cooldownStandard: number;
}

interface FlashSpellDef extends SummonerSpellBase {
  id: 'flash';
  range: number;
}

interface HealSpellDef extends SummonerSpellBase {
  id: 'heal';
  healAmount: number;
  speedBoost: number;
  duration: number;
}

interface GhostSpellDef extends SummonerSpellBase {
  id: 'ghost';
  speedBoost: number;
  duration: number;
}

const SUMMONER_SPELLS: {
  flash: FlashSpellDef;
  heal: HealSpellDef;
  ghost: GhostSpellDef;
} = {
  flash: {
    id: 'flash',
    name: 'Flash',
    cooldownFast: 25,
    cooldownStandard: 120,
    range: 425
  },
  heal: {
    id: 'heal',
    name: 'Heal',
    cooldownFast: 30,
    cooldownStandard: 120,
    healAmount: 260,
    speedBoost: 0.30,
    duration: 1.5
  },
  ghost: {
    id: 'ghost',
    name: 'Ghost',
    cooldownFast: 30,
    cooldownStandard: 120,
    speedBoost: 0.38,
    duration: 7.0
  }
};

interface BotAIState {
  moveCooldown: number;
  strafeSign: number;
  qThinkCooldown: number;
}

interface PendingCast {
  dirX: number;
  dirZ: number;
}

interface ServerPlayerState {
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
}

interface ServerProjectile {
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

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  roomId: string | null;
  slot: number | null;
}

interface GameRoom {
  id: string;
  passcode: string;
  state: RoomState;
  round: number;
  matchTime: number;
  countdownTimer: number;
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
}

const rooms = new Map<string, GameRoom>();

app.get('/api/rooms', (_req: Request, res: Response) => {
  const list: RoomSummary[] = [];
  for (const [id, room] of rooms.entries()) {
    list.push({
      id,
      hostName: room.players[0]?.name || 'Dr. Mundo',
      playerCount: room.players.filter(Boolean).length,
      hasPasscode: Boolean(room.passcode && room.passcode.length > 0),
      state: room.state,
      bestOf: room.settings.bestOf
    });
  }
  res.json({ rooms: list });
});

app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(PROJECT_ROOT, 'public/index.html'));
});

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomId() : code;
}

function getSpawnTransform(slot: number): { x: number; z: number; angle: number } {
  // slot 0 = Blue Side (NW: x + z < 0), slot 1 = Red Side (SE: x + z > 0)
  if (slot === 0) {
    return { x: -300, z: -300, angle: Math.PI * 0.25 }; // Facing SE (+X, +Z)
  } else {
    return { x: 300, z: 300, angle: -Math.PI * 0.75 }; // Facing NW (-X, -Z)
  }
}

function clampToBaronPitHalf(x: number, z: number, slot: number): { x: number; z: number } {
  // 1. Clamp to dividing line x + z = 0:
  // signedDist = (x + z) / sqrt(2).
  // For slot 0 (Blue Side), signedDist <= -LINE_BUFFER.
  // For slot 1 (Red Side), signedDist >= +LINE_BUFFER.
  let signedDist = (x + z) * INV_SQRT2;
  if (slot === 0 && signedDist > -LINE_BUFFER) {
    const correction = signedDist - (-LINE_BUFFER);
    x -= correction * INV_SQRT2;
    z -= correction * INV_SQRT2;
  } else if (slot === 1 && signedDist < LINE_BUFFER) {
    const correction = LINE_BUFFER - signedDist;
    x += correction * INV_SQRT2;
    z += correction * INV_SQRT2;
  }

  // 2. Clamp to circular Baron Pit inner wall:
  const distSq = x * x + z * z;
  const maxR = PIT_RADIUS - MUNDO_STATS.hitboxRadius;
  if (distSq > maxR * maxR) {
    const dist = Math.sqrt(distSq);
    x = (x / dist) * maxR;
    z = (z / dist) * maxR;
    // Re-verify dividing line after circular clamp
    signedDist = (x + z) * INV_SQRT2;
    if (slot === 0 && signedDist > -LINE_BUFFER) {
      const correction = signedDist - (-LINE_BUFFER);
      x -= correction * INV_SQRT2;
      z -= correction * INV_SQRT2;
    } else if (slot === 1 && signedDist < LINE_BUFFER) {
      const correction = LINE_BUFFER - signedDist;
      x += correction * INV_SQRT2;
      z += correction * INV_SQRT2;
    }
  }

  return { x, z };
}

function createPlayerState(
  slot: number,
  name: string,
  spells: [SummonerSpellId, SummonerSpellId] = ['flash', 'ghost'],
  isBot = false
): ServerPlayerState {
  const spawn = getSpawnTransform(slot);
  return {
    slot,
    name: name || (slot === 0 ? 'Blue Mundo' : 'Red Mundo'),
    isBot,
    ready: isBot ? true : false,
    spells: [spells[0], spells[1]],
    score: 0,
    x: spawn.x,
    z: spawn.z,
    targetX: spawn.x,
    targetZ: spawn.z,
    angle: spawn.angle,
    hp: MUNDO_STATS.maxHp,
    maxHp: MUNDO_STATS.maxHp,
    alive: true,
    anim: 'idle',
    qCd: 0,
    maxQCd: MUNDO_STATS.qCooldown,
    spellCd: [0, 0],
    maxSpellCd: [25, 30],
    castTimer: 0,
    pendingCast: null,
    slowTimer: 0,
    ghostTimer: 0,
    healSpeedTimer: 0,
    emoteTimer: 0,
    stats: {
      cleaversThrown: 0,
      cleaversHit: 0,
      damageDealt: 0
    },
    aiState: isBot
      ? {
          moveCooldown: 0,
          strafeSign: 1,
          qThinkCooldown: 0.6
        }
      : null
  };
}

function getSpellCooldown(spellId: SummonerSpellId, fastCd: boolean): number {
  const def = SUMMONER_SPELLS[spellId] || SUMMONER_SPELLS.flash;
  return fastCd ? def.cooldownFast : def.cooldownStandard;
}

function resetRoundState(room: GameRoom): void {
  room.projectiles = [];
  room.events = [];
  const fastCd = room.settings.cooldownMode !== 'standard';
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (!p) continue;
    const spawn = getSpawnTransform(i);
    p.x = spawn.x;
    p.z = spawn.z;
    p.targetX = spawn.x;
    p.targetZ = spawn.z;
    p.angle = spawn.angle;
    p.hp = MUNDO_STATS.maxHp;
    p.maxHp = MUNDO_STATS.maxHp;
    p.alive = true;
    p.anim = 'idle';
    p.qCd = 0;
    p.castTimer = 0;
    p.pendingCast = null;
    p.slowTimer = 0;
    p.ghostTimer = 0;
    p.healSpeedTimer = 0;
    p.emoteTimer = 0;
    p.spellCd = [0, 0];
    p.maxSpellCd = [
      getSpellCooldown(p.spells[0], fastCd),
      getSpellCooldown(p.spells[1], fastCd)
    ];
  }
}

function serializeLobbyPlayer(p: ServerPlayerState | null, idx: number): LobbyPlayerInfo | null {
  if (!p) return null;
  return {
    slot: idx,
    name: p.name,
    isBot: p.isBot,
    ready: p.ready,
    spells: p.spells,
    score: p.score,
    stats: p.stats
  };
}

function serializeRoomLobby(room: GameRoom): RoomLobbyPayload {
  return {
    type: 'room_update',
    roomId: room.id,
    hasPasscode: Boolean(room.passcode && room.passcode.length > 0),
    passcode: room.passcode || '',
    state: room.state,
    round: room.round,
    settings: room.settings,
    botEnabled: room.botEnabled,
    botDifficulty: room.botDifficulty,
    players: [
      serializeLobbyPlayer(room.players[0], 0),
      serializeLobbyPlayer(room.players[1], 1)
    ]
  };
}

function sendClientMessage(ws: WebSocket, payload: ServerToClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(room: GameRoom, payload: ServerToClientMessage): void {
  const msg = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

// ============================================================================
// AUTHORITATIVE 60HZ GAME SIMULATION
// ============================================================================
function castInfectedBonesaw(
  room: GameRoom,
  player: ServerPlayerState,
  targetX: number,
  targetZ: number
): void {
  if (!player.alive || player.qCd > 0 || player.castTimer > 0) return;
  const dx = targetX - player.x;
  const dz = targetZ - player.z;
  const len = Math.hypot(dx, dz);
  const dirX = len > 1e-3 ? dx / len : Math.sin(player.angle);
  const dirZ = len > 1e-3 ? dz / len : Math.cos(player.angle);

  player.angle = Math.atan2(dirX, dirZ);
  player.qCd = MUNDO_STATS.qCooldown;
  player.castTimer = MUNDO_STATS.qCastTime;
  player.emoteTimer = 0;
  player.anim = 'q_cast';
  // Cost 50 current HP (cannot reduce below 1 HP)
  player.hp = Math.max(1, player.hp - MUNDO_STATS.qCost);
  player.stats.cleaversThrown += 1;

  player.pendingCast = {
    dirX,
    dirZ
  };

  room.events.push({
    type: 'q_windup',
    slot: player.slot,
    x: player.x,
    z: player.z,
    dirX,
    dirZ
  });
}

function useSummonerSpell(
  room: GameRoom,
  player: ServerPlayerState,
  spellIndex: number,
  targetX: number,
  targetZ: number
): void {
  if (!player.alive) return;
  if (spellIndex !== 0 && spellIndex !== 1) return;
  if (player.spellCd[spellIndex] > 0) return;

  const spellId = player.spells[spellIndex];
  const def = SUMMONER_SPELLS[spellId];
  if (!def) return;

  const fastCd = room.settings.cooldownMode !== 'standard';
  const cd = fastCd ? def.cooldownFast : def.cooldownStandard;
  player.spellCd[spellIndex] = cd;
  player.maxSpellCd[spellIndex] = cd;

  if (spellId === 'flash') {
    const flashDef = SUMMONER_SPELLS.flash;
    const oldX = player.x;
    const oldZ = player.z;
    const dx = targetX - player.x;
    const dz = targetZ - player.z;
    const dist = Math.hypot(dx, dz);
    const actualDist = Math.min(dist, flashDef.range);
    const dirX = dist > 1e-3 ? dx / dist : Math.sin(player.angle);
    const dirZ = dist > 1e-3 ? dz / dist : Math.cos(player.angle);

    const clamped = clampToBaronPitHalf(
      player.x + dirX * actualDist,
      player.z + dirZ * actualDist,
      player.slot
    );
    player.x = clamped.x;
    player.z = clamped.z;
    player.targetX = clamped.x;
    player.targetZ = clamped.z;
    player.angle = Math.atan2(dirX, dirZ);

    room.events.push({
      type: 'spell_flash',
      slot: player.slot,
      fromX: oldX,
      fromZ: oldZ,
      toX: player.x,
      toZ: player.z
    });
  } else if (spellId === 'heal') {
    const healDef = SUMMONER_SPELLS.heal;
    const prevHp = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + healDef.healAmount);
    const healed = Math.round(player.hp - prevHp);
    player.healSpeedTimer = healDef.duration;

    room.events.push({
      type: 'spell_heal',
      slot: player.slot,
      x: player.x,
      z: player.z,
      amount: healed || healDef.healAmount
    });
  } else if (spellId === 'ghost') {
    const ghostDef = SUMMONER_SPELLS.ghost;
    player.ghostTimer = ghostDef.duration;
    room.events.push({
      type: 'spell_ghost',
      slot: player.slot,
      x: player.x,
      z: player.z,
      duration: ghostDef.duration
    });
  }
}

function updateBotAI(
  room: GameRoom,
  bot: ServerPlayerState,
  opponent: ServerPlayerState | null,
  dt: number
): void {
  if (!bot.alive || !opponent || !opponent.alive || !bot.aiState) return;
  const ai = bot.aiState;
  ai.moveCooldown -= dt;
  ai.qThinkCooldown -= dt;

  // Check if any enemy projectile is heading toward bot -> dodge perpendicular!
  let dangerProj: ServerProjectile | null = null;
  for (const proj of room.projectiles) {
    if (proj.ownerSlot !== bot.slot) {
      const toBotX = bot.x - proj.x;
      const toBotZ = bot.z - proj.z;
      const forwardDot = toBotX * proj.dirX + toBotZ * proj.dirZ;
      if (forwardDot > -40 && forwardDot < 700) {
        const perpDist = Math.abs(toBotX * -proj.dirZ + toBotZ * proj.dirX);
        if (perpDist < MUNDO_STATS.hitboxRadius + MUNDO_STATS.qRadius + 85) {
          dangerProj = proj;
          break;
        }
      }
    }
  }

  if (dangerProj) {
    // Sidestep perpendicular to projectile trajectory
    const perpX = -dangerProj.dirZ;
    const perpZ = dangerProj.dirX;
    const side = (bot.x - dangerProj.x) * perpX + (bot.z - dangerProj.z) * perpZ >= 0 ? 1 : -1;
    const dodgeX = bot.x + perpX * side * 260;
    const dodgeZ = bot.z + perpZ * side * 260;
    const clamped = clampToBaronPitHalf(dodgeX, dodgeZ, bot.slot);
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;

    // If low HP and Flash is available and projectile is super close, Flash dodge!
    const distToProj = Math.hypot(bot.x - dangerProj.x, bot.z - dangerProj.z);
    const flashIdx = bot.spells.indexOf('flash');
    if (flashIdx !== -1 && bot.spellCd[flashIdx] <= 0 && distToProj < 260 && bot.hp < 650) {
      useSummonerSpell(room, bot, flashIdx, clamped.x, clamped.z);
    }
  } else if (ai.moveCooldown <= 0) {
    ai.moveCooldown = 0.38 + Math.random() * 0.45;
    if (Math.random() < 0.45) ai.strafeSign *= -1;
    // Strafe along the pit parallel to the dividing line (-1/sqrt2, +1/sqrt2)
    // while maintaining optimal distance (~260..460 units from center line)
    const alongPit = (Math.random() - 0.5) * 750;
    const distFromLine = 170 + Math.random() * 290;
    const sign = bot.slot === 0 ? -1 : 1;
    const desiredX = sign * distFromLine * INV_SQRT2 - alongPit * INV_SQRT2;
    const desiredZ = sign * distFromLine * INV_SQRT2 + alongPit * INV_SQRT2;
    const clamped = clampToBaronPitHalf(desiredX, desiredZ, bot.slot);
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;
  }

  // Cast Heal if below 42% HP
  const healIdx = bot.spells.indexOf('heal');
  if (healIdx !== -1 && bot.spellCd[healIdx] <= 0 && bot.hp < bot.maxHp * 0.42) {
    useSummonerSpell(room, bot, healIdx, bot.x, bot.z);
  }

  // Cast Ghost occasionally when engaging
  const ghostIdx = bot.spells.indexOf('ghost');
  if (ghostIdx !== -1 && bot.spellCd[ghostIdx] <= 0 && Math.random() < 0.008) {
    useSummonerSpell(room, bot, ghostIdx, bot.x, bot.z);
  }

  // Throw Q cleaver with predictive lead on opponent movement
  if (bot.qCd <= 0 && bot.castTimer <= 0 && ai.qThinkCooldown <= 0) {
    const dist = Math.hypot(opponent.x - bot.x, opponent.z - bot.z);
    if (dist <= MUNDO_STATS.qRange - 35) {
      const travelTime = dist / MUNDO_STATS.qSpeed;
      const oppDx = opponent.targetX - opponent.x;
      const oppDz = opponent.targetZ - opponent.z;
      const oppMoveDist = Math.hypot(oppDx, oppDz);
      let aimX = opponent.x;
      let aimZ = opponent.z;
      if (oppMoveDist > 15) {
        const leadFactor = 0.65 + Math.random() * 0.35;
        aimX += (oppDx / oppMoveDist) * MUNDO_STATS.baseMoveSpeed * travelTime * leadFactor;
        aimZ += (oppDz / oppMoveDist) * MUNDO_STATS.baseMoveSpeed * travelTime * leadFactor;
      }
      // Small human-like aim jitter
      aimX += (Math.random() - 0.5) * 55;
      aimZ += (Math.random() - 0.5) * 55;
      castInfectedBonesaw(room, bot, aimX, aimZ);
      ai.qThinkCooldown = 0.25 + Math.random() * 0.35;
    }
  }
}

function stepRoomSimulation(room: GameRoom, dt: number): void {
  if (room.state === 'countdown') {
    room.countdownTimer -= dt;
    if (room.countdownTimer <= 0) {
      room.state = 'playing';
      room.events.push({ type: 'fight_start', round: room.round });
    }
  }

  if (room.state !== 'playing') {
    if (room.events.length > 0) {
      broadcastToRoom(room, { type: 'game_events', events: room.events });
      room.events = [];
    }
    return;
  }

  room.matchTime += dt;

  // Update players
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (!p || !p.alive) continue;

    if (p.isBot) {
      const opp = room.players[1 - i];
      updateBotAI(room, p, opp, dt);
    }

    // Cooldowns & buffs
    if (p.qCd > 0) p.qCd = Math.max(0, p.qCd - dt);
    if (p.spellCd[0] > 0) p.spellCd[0] = Math.max(0, p.spellCd[0] - dt);
    if (p.spellCd[1] > 0) p.spellCd[1] = Math.max(0, p.spellCd[1] - dt);
    if (p.slowTimer > 0) p.slowTimer = Math.max(0, p.slowTimer - dt);
    if (p.ghostTimer > 0) p.ghostTimer = Math.max(0, p.ghostTimer - dt);
    if (p.healSpeedTimer > 0) p.healSpeedTimer = Math.max(0, p.healSpeedTimer - dt);
    if (p.emoteTimer > 0) p.emoteTimer = Math.max(0, p.emoteTimer - dt);

    // Passive HP Regen (Goes Where He Pleases)
    p.hp = Math.min(p.maxHp, p.hp + MUNDO_STATS.hpRegenPerSec * dt);

    // Cast timer (Infected Bonesaw windup)
    if (p.castTimer > 0) {
      p.castTimer -= dt;
      if (p.castTimer <= 0 && p.pendingCast) {
        const { dirX, dirZ } = p.pendingCast;
        p.pendingCast = null;
        const projId = ++room.nextProjId;
        const spawnX = p.x + dirX * 55;
        const spawnZ = p.z + dirZ * 55;
        room.projectiles.push({
          id: projId,
          ownerSlot: p.slot,
          x: spawnX,
          z: spawnZ,
          startX: spawnX,
          startZ: spawnZ,
          dirX,
          dirZ,
          speed: MUNDO_STATS.qSpeed,
          maxRange: MUNDO_STATS.qRange,
          radius: MUNDO_STATS.qRadius
        });
        room.events.push({
          type: 'q_launch',
          slot: p.slot,
          projId,
          x: spawnX,
          z: spawnZ,
          dirX,
          dirZ
        });
      }
      continue; // Rooted during 0.22s Q cast windup, matching League of Legends
    }

    // Movement toward targetX, targetZ
    const dx = p.targetX - p.x;
    const dz = p.targetZ - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4) {
      let speed: number = MUNDO_STATS.baseMoveSpeed;
      if (p.ghostTimer > 0) speed *= 1 + SUMMONER_SPELLS.ghost.speedBoost;
      if (p.healSpeedTimer > 0) speed *= 1 + SUMMONER_SPELLS.heal.speedBoost;
      if (p.slowTimer > 0) speed *= 1 - MUNDO_STATS.qSlowPercent;

      const step = Math.min(dist, speed * dt);
      const nx = p.x + (dx / dist) * step;
      const nz = p.z + (dz / dist) * step;
      const clamped = clampToBaronPitHalf(nx, nz, p.slot);
      p.x = clamped.x;
      p.z = clamped.z;
      p.angle = Math.atan2(dx, dz);
      p.anim = p.ghostTimer > 0 ? 'run_haste' : 'run';
      p.emoteTimer = 0;
    } else {
      p.anim = p.emoteTimer > 0 ? p.emoteAnim || 'taunt' : 'idle';
    }
  }

  // Update flying Infected Bonesaw (Q) projectiles
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const proj = room.projectiles[i];
    proj.x += proj.dirX * proj.speed * dt;
    proj.z += proj.dirZ * proj.speed * dt;

    // Check collision against enemy Dr. Mundo
    const targetSlot = 1 - proj.ownerSlot;
    const target = room.players[targetSlot];
    const caster = room.players[proj.ownerSlot];

    if (target && target.alive) {
      const hitDist = Math.hypot(target.x - proj.x, target.z - proj.z);
      if (hitDist <= MUNDO_STATS.hitboxRadius + proj.radius) {
        // HIT!
        const rawPctDmg = target.hp * MUNDO_STATS.qPercentCurrentHp;
        const dmg = Math.round(Math.max(MUNDO_STATS.qMinDamage, rawPctDmg));
        target.hp = Math.max(0, target.hp - dmg);
        target.slowTimer = MUNDO_STATS.qSlowDuration;

        // Refund 100% HP cost to caster
        if (caster && caster.alive) {
          caster.hp = Math.min(caster.maxHp, caster.hp + MUNDO_STATS.qCost);
          caster.stats.cleaversHit += 1;
          caster.stats.damageDealt += dmg;
        }

        room.events.push({
          type: 'q_hit',
          projId: proj.id,
          attackerSlot: proj.ownerSlot,
          victimSlot: targetSlot,
          x: target.x,
          z: target.z,
          damage: dmg,
          refund: MUNDO_STATS.qCost
        });

        room.projectiles.splice(i, 1);

        // Check if target died!
        if (target.hp <= 0) {
          target.alive = false;
          target.anim = 'death';
          if (caster) caster.score += 1;

          const winsNeeded = Math.ceil((room.settings.bestOf || 3) / 2);
          const matchOver = Boolean(caster && caster.score >= winsNeeded);

          room.events.push({
            type: 'round_kill',
            winnerSlot: proj.ownerSlot,
            loserSlot: targetSlot,
            round: room.round,
            scores: [room.players[0]?.score || 0, room.players[1]?.score || 0],
            matchOver
          });

          if (matchOver) {
            room.state = 'gameover';
            room.winnerSlot = proj.ownerSlot;
            broadcastToRoom(room, serializeRoomLobby(room));
          } else {
            room.state = 'round_end';
            room.roundEndTimer = 3.5;
          }
        }
        continue;
      }
    }

    // Check max range or Baron Pit rock wall collision (horseshoe back wall blocks cleavers!)
    const traveled = Math.hypot(proj.x - proj.startX, proj.z - proj.startZ);
    const distFromCenter = Math.hypot(proj.x, proj.z);
    if (traveled >= proj.maxRange || distFromCenter >= PIT_RADIUS + 65) {
      room.events.push({
        type: 'q_miss',
        projId: proj.id,
        x: proj.x,
        z: proj.z
      });
      room.projectiles.splice(i, 1);
    }
  }
}

function serializePlayerSnapshot(p: ServerPlayerState | null): PlayerSnapshot | null {
  if (!p) return null;
  return {
    slot: p.slot,
    name: p.name,
    x: Math.round(p.x * 10) / 10,
    z: Math.round(p.z * 10) / 10,
    targetX: Math.round(p.targetX * 10) / 10,
    targetZ: Math.round(p.targetZ * 10) / 10,
    angle: Math.round(p.angle * 1000) / 1000,
    hp: Math.round(p.hp),
    maxHp: p.maxHp,
    alive: p.alive,
    anim: p.anim,
    qCd: Math.round(p.qCd * 100) / 100,
    maxQCd: p.maxQCd,
    spellCd: [Math.round(p.spellCd[0] * 100) / 100, Math.round(p.spellCd[1] * 100) / 100],
    maxSpellCd: p.maxSpellCd,
    spells: p.spells,
    slowTimer: Math.round(p.slowTimer * 100) / 100,
    ghostTimer: Math.round(p.ghostTimer * 100) / 100,
    healSpeedTimer: Math.round(p.healSpeedTimer * 100) / 100,
    score: p.score,
    stats: p.stats
  };
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state === 'round_end') {
      room.roundEndTimer -= DT;
      if (room.roundEndTimer <= 0) {
        room.round += 1;
        resetRoundState(room);
        room.state = 'countdown';
        room.countdownTimer = 3.0;
        room.events.push({ type: 'round_countdown', round: room.round });
      }
    }

    if (
      room.state === 'countdown' ||
      room.state === 'playing' ||
      room.state === 'round_end' ||
      room.state === 'gameover'
    ) {
      stepRoomSimulation(room, DT);

      const projectiles: ProjectileSnapshot[] = room.projectiles.map((pr) => ({
        id: pr.id,
        ownerSlot: pr.ownerSlot,
        x: Math.round(pr.x * 10) / 10,
        z: Math.round(pr.z * 10) / 10,
        dirX: Math.round(pr.dirX * 1000) / 1000,
        dirZ: Math.round(pr.dirZ * 1000) / 1000
      }));

      const snapshot: ServerToClientMessage = {
        type: 'state_snapshot',
        state: room.state,
        round: room.round,
        countdownTimer: Math.max(0, room.countdownTimer || 0),
        players: [
          serializePlayerSnapshot(room.players[0]),
          serializePlayerSnapshot(room.players[1])
        ],
        projectiles,
        events: room.events
      };
      room.events = [];
      broadcastToRoom(room, snapshot);
    }
  }
}, 1000 / TICK_RATE);

// ============================================================================
// WEBSOCKET CONNECTION & ROOM SIGNALING
// ============================================================================
function parseBestOf(val: unknown): BestOfFormat {
  const num = Number(val);
  if (num === 1 || num === 3 || num === 5) return num;
  return 3;
}

wss.on('connection', (ws: WebSocket) => {
  const client: ConnectedClient = {
    id: crypto.randomUUID(),
    ws,
    roomId: null,
    slot: null
  };

  ws.on('message', (raw: RawData) => {
    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientToServerMessage;
    } catch {
      return;
    }

    if (msg.type === 'check_room') {
      const code = (msg.roomId || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendClientMessage(ws, { type: 'room_check_result', exists: false, roomId: code });
      } else {
        sendClientMessage(ws, {
          type: 'room_check_result',
          exists: true,
          roomId: code,
          hasPasscode: Boolean(room.passcode && room.passcode.length > 0),
          hostName: room.players[0]?.name || 'Dr. Mundo'
        });
      }
      return;
    }

    if (msg.type === 'create_room') {
      leaveCurrentRoom(client);
      const roomId = (msg.customCode || '').trim().toUpperCase() || generateRoomId();
      if (rooms.has(roomId)) {
        sendClientMessage(ws, {
          type: 'error_msg',
          message: 'Room code already exists. Try another code.'
        });
        return;
      }

      const passcode = (msg.passcode || '').trim();
      const spells = validateSpells(msg.spells);
      const cooldownMode: CooldownMode = msg.cooldownMode === 'standard' ? 'standard' : 'fast';
      const settings: RoomSettings = {
        bestOf: parseBestOf(msg.bestOf),
        cooldownMode
      };

      const room: GameRoom = {
        id: roomId,
        passcode,
        state: 'lobby',
        round: 1,
        matchTime: 0,
        countdownTimer: 0,
        roundEndTimer: 0,
        nextProjId: 1,
        botEnabled: Boolean(msg.withBot),
        botDifficulty: 'challenger',
        settings,
        clients: [client],
        players: [
          createPlayerState(0, (msg.name || 'Mundo #1').slice(0, 20), spells, false),
          msg.withBot
            ? createPlayerState(1, 'Corporate Mundo (Bot)', ['flash', 'ghost'], true)
            : null
        ],
        projectiles: [],
        events: []
      };

      client.roomId = roomId;
      client.slot = 0;
      rooms.set(roomId, room);

      sendClientMessage(ws, {
        type: 'joined_room',
        roomId,
        slot: 0,
        passcode,
        lobby: serializeRoomLobby(room)
      });
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'join_room') {
      const roomId = (msg.roomId || '').trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        sendClientMessage(ws, {
          type: 'error_msg',
          code: 'NOT_FOUND',
          message: `Room "${roomId}" was not found.`
        });
        return;
      }

      // Passcode verification
      if (room.passcode && room.passcode.length > 0) {
        const provided = (msg.passcode || '').trim();
        if (provided !== room.passcode) {
          sendClientMessage(ws, {
            type: 'error_msg',
            code: 'INVALID_PASSCODE',
            roomId,
            message: provided ? 'Incorrect room passcode.' : 'This room requires a passcode.'
          });
          return;
        }
      }

      leaveCurrentRoom(client);

      // Assign open slot (if slot 1 was a Bot, replace the Bot with the human joiner!)
      let assignedSlot: 0 | 1 | -1 = -1;
      if (!room.players[0]) {
        assignedSlot = 0;
      } else if (!room.players[1] || room.players[1].isBot) {
        assignedSlot = 1;
        room.botEnabled = false;
      }

      if (assignedSlot === -1) {
        sendClientMessage(ws, {
          type: 'error_msg',
          code: 'ROOM_FULL',
          message: 'This 1v1 room is already full (2/2 players).'
        });
        return;
      }

      const spells = validateSpells(msg.spells);
      room.players[assignedSlot] = createPlayerState(
        assignedSlot,
        (msg.name || `Mundo #${assignedSlot + 1}`).slice(0, 20),
        spells,
        false
      );

      client.roomId = roomId;
      client.slot = assignedSlot;
      room.clients.push(client);

      sendClientMessage(ws, {
        type: 'joined_room',
        roomId,
        slot: assignedSlot,
        passcode: room.passcode,
        lobby: serializeRoomLobby(room)
      });
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    // All subsequent actions require being in a room
    const room = client.roomId ? rooms.get(client.roomId) : undefined;
    if (!room || client.slot === null) return;
    const player = room.players[client.slot];
    if (!player) return;

    if (msg.type === 'select_spells') {
      player.spells = validateSpells(msg.spells);
      const fastCd = room.settings.cooldownMode !== 'standard';
      player.maxSpellCd = [
        getSpellCooldown(player.spells[0], fastCd),
        getSpellCooldown(player.spells[1], fastCd)
      ];
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'update_name') {
      if (msg.name && typeof msg.name === 'string') {
        player.name = msg.name.trim().slice(0, 20) || player.name;
        broadcastToRoom(room, serializeRoomLobby(room));
      }
      return;
    }

    if (msg.type === 'toggle_bot') {
      // Only when slot 1 has no human player
      if (room.players[1] && !room.players[1].isBot) return;
      room.botEnabled = !room.botEnabled;
      if (room.botEnabled) {
        room.players[1] = createPlayerState(1, 'Dr. Mundo Bot', ['flash', 'ghost'], true);
      } else {
        room.players[1] = null;
      }
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'update_settings') {
      if (client.slot === 0 && room.state === 'lobby') {
        if (msg.bestOf !== undefined) {
          room.settings.bestOf = parseBestOf(msg.bestOf);
        }
        if (msg.cooldownMode === 'fast' || msg.cooldownMode === 'standard') {
          room.settings.cooldownMode = msg.cooldownMode;
        }
        broadcastToRoom(room, serializeRoomLobby(room));
      }
      return;
    }

    if (msg.type === 'set_ready') {
      player.ready = Boolean(msg.ready);
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'start_match' || msg.type === 'rematch') {
      if (!room.players[0] || !room.players[1]) {
        sendClientMessage(ws, {
          type: 'error_msg',
          message: 'Waiting for opponent (or enable AI Bot to practice).'
        });
        return;
      }
      room.round = 1;
      room.matchTime = 0;
      room.players[0].score = 0;
      room.players[1].score = 0;
      room.players[0].stats = { cleaversThrown: 0, cleaversHit: 0, damageDealt: 0 };
      room.players[1].stats = { cleaversThrown: 0, cleaversHit: 0, damageDealt: 0 };
      resetRoundState(room);
      room.state = 'countdown';
      room.countdownTimer = 3.0;
      room.events.push({ type: 'round_countdown', round: 1 });
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'return_to_lobby') {
      room.state = 'lobby';
      room.projectiles = [];
      for (const p of room.players) {
        if (p && !p.isBot) p.ready = false;
      }
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    // In-game player commands
    if (msg.type === 'move') {
      if (room.state !== 'playing' || !player.alive) return;
      const tx = Number(msg.x);
      const tz = Number(msg.z);
      if (Number.isFinite(tx) && Number.isFinite(tz)) {
        const clamped = clampToBaronPitHalf(tx, tz, player.slot);
        player.targetX = clamped.x;
        player.targetZ = clamped.z;
      }
      return;
    }

    if (msg.type === 'stop') {
      if (!player.alive) return;
      player.targetX = player.x;
      player.targetZ = player.z;
      return;
    }

    if (msg.type === 'cast_q') {
      if (room.state !== 'playing' || !player.alive) return;
      const tx = Number(msg.x);
      const tz = Number(msg.z);
      if (Number.isFinite(tx) && Number.isFinite(tz)) {
        castInfectedBonesaw(room, player, tx, tz);
      }
      return;
    }

    if (msg.type === 'cast_spell') {
      if (room.state !== 'playing' || !player.alive) return;
      const spellIndex = Number(msg.spellIndex);
      const tx = Number(msg.x) || player.x;
      const tz = Number(msg.z) || player.z;
      useSummonerSpell(room, player, spellIndex, tx, tz);
      return;
    }

    if (msg.type === 'emote') {
      if (!player.alive || player.castTimer > 0) return;
      const allowed: EmoteKey[] = ['taunt', 'joke', 'dance', 'laugh', 'recall'];
      const emote: EmoteKey = allowed.includes(msg.emote) ? msg.emote : 'taunt';
      player.targetX = player.x;
      player.targetZ = player.z;
      player.emoteAnim = emote;
      player.emoteTimer = 4.0;
      player.anim = emote;
      return;
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(client);
  });
});

function validateSpells(spells: unknown): [SummonerSpellId, SummonerSpellId] {
  const valid: SummonerSpellId[] = ['flash', 'heal', 'ghost'];
  if (!Array.isArray(spells)) return ['flash', 'ghost'];
  const filtered: SummonerSpellId[] = [];
  for (const s of spells) {
    const id = String(s).toLowerCase() as SummonerSpellId;
    if (valid.includes(id) && !filtered.includes(id)) {
      filtered.push(id);
    }
  }
  for (const fallback of valid) {
    if (filtered.length < 2 && !filtered.includes(fallback)) {
      filtered.push(fallback);
    }
  }
  return [filtered[0] || 'flash', filtered[1] || 'ghost'];
}

function leaveCurrentRoom(client: ConnectedClient): void {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  client.roomId = null;
  const oldSlot = client.slot;
  client.slot = null;
  if (!room) return;

  room.clients = room.clients.filter((c) => c !== client);
  if (oldSlot !== null && room.players[oldSlot]) {
    room.players[oldSlot] = null;
  }

  // If no human clients remain, delete room
  if (room.clients.length === 0) {
    rooms.delete(room.id);
    return;
  }

  // If host (slot 0) left and slot 1 is human, promote slot 1 to slot 0
  if (!room.players[0] && room.players[1] && !room.players[1].isBot) {
    room.players[0] = room.players[1];
    room.players[0].slot = 0;
    room.players[1] = null;
    for (const c of room.clients) {
      if (c.slot === 1) {
        c.slot = 0;
        sendClientMessage(c.ws, {
          type: 'joined_room',
          roomId: room.id,
          slot: 0,
          passcode: room.passcode,
          lobby: serializeRoomLobby(room)
        });
      }
    }
  }

  room.state = 'lobby';
  room.projectiles = [];
  broadcastToRoom(room, serializeRoomLobby(room));
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Baron Pit Dr. Mundo 1v1 server running at http://localhost:${PORT}`);
});
