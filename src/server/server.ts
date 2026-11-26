import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import crypto from 'crypto';
import {
  DEFAULT_CHAMPION_ID,
  getChampionConfig,
  normalizeChampionId
} from '../shared/champions/index.js';
import {
  DT,
  TICK_RATE,
  getSpellCooldown,
  parseBestOf,
  validateSpells
} from '../shared/constants.js';
import type {
  ClientToServerMessage,
  CooldownMode,
  EmoteKey,
  LobbyPlayerInfo,
  RoomLobbyPayload,
  RoomSettings,
  RoomSummary,
  ServerToClientMessage
} from '../shared/types.js';
import {
  castPrimaryAbility,
  clampToBaronPitHalf,
  createPlayerState,
  resetRoundState,
  setPlayerChampion,
  useSummonerSpell
} from './actions.js';
import { trackEvent } from './analytics.js';
import { RESTORED_ROOM_TTL_MS, RoomPersistence } from './persistence.js';
import { buildStateSnapshot, stepRoomSimulation } from './simulation.js';
import type { ConnectedClient, GameRoom, ServerPlayerState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'public', 'index.html'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '../..');
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  maxPayload: 4096
});

const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const THREE_ROOT = path.join(PROJECT_ROOT, 'node_modules', 'three');

const COMPRESSIBLE_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

interface CachedGzipAsset {
  mtimeMs: number;
  gzipped: Buffer;
  contentType: string;
}

const gzipCache = new Map<string, CachedGzipAsset>();

function getCacheControlForPublicPath(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=86400';
  return 'no-cache';
}

function tryServeGzipStatic(
  req: Request,
  res: Response,
  rootDir: string,
  relPath: string,
  cacheControl: string
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const acceptEncoding = req.headers['accept-encoding'];
  if (typeof acceptEncoding !== 'string' || !acceptEncoding.includes('gzip')) return false;

  const cleanRel = relPath.replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, cleanRel);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return false;

  const ext = path.extname(resolved).toLowerCase();
  const contentType = COMPRESSIBLE_MIME[ext];
  if (!contentType) return false;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  let cached = gzipCache.get(resolved);
  if (!cached || cached.mtimeMs !== stat.mtimeMs) {
    const raw = fs.readFileSync(resolved);
    cached = {
      mtimeMs: stat.mtimeMs,
      gzipped: zlib.gzipSync(raw, { level: 6 }),
      contentType
    };
    gzipCache.set(resolved, cached);
  }

  res.setHeader('Content-Type', cached.contentType);
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Length', String(cached.gzipped.length));
  if (req.method === 'HEAD') {
    res.status(200).end();
  } else {
    res.status(200).send(cached.gzipped);
  }
  return true;
}

app.use('/three', (req: Request, res: Response, next: NextFunction) => {
  if (tryServeGzipStatic(req, res, THREE_ROOT, req.path, 'public, max-age=604800, immutable')) {
    return;
  }
  next();
});
app.use(
  '/three',
  express.static(THREE_ROOT, {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  })
);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/healthz' || req.path.startsWith('/api/') || req.path.startsWith('/three/')) {
    next();
    return;
  }
  const relPath = req.path === '/' ? 'index.html' : req.path;
  if (tryServeGzipStatic(req, res, PUBLIC_ROOT, relPath, getCacheControlForPublicPath(req.path))) {
    return;
  }
  next();
});
app.use(
  express.static(PUBLIC_ROOT, {
    setHeaders: (res, filePath) => {
      const rel = '/' + path.relative(PUBLIC_ROOT, filePath).replace(/\\/g, '/');
      res.setHeader('Cache-Control', getCacheControlForPublicPath(rel));
    }
  })
);

const rooms = new Map<string, GameRoom>();
const snapshotPath =
  process.env.ROOMS_SNAPSHOT_PATH || path.join(PROJECT_ROOT, 'data', 'rooms-snapshot.json');
const persistence = new RoomPersistence(snapshotPath);

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, rooms: rooms.size });
});

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

app.get('*', (req: Request, res: Response) => {
  if (tryServeGzipStatic(req, res, PUBLIC_ROOT, 'index.html', 'no-cache')) {
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomId() : code;
}

function serializeLobbyPlayer(p: ServerPlayerState | null, idx: number): LobbyPlayerInfo | null {
  if (!p) return null;
  return {
    slot: idx,
    name: p.name,
    championId: p.championId,
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
    championId: room.championId,
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
// AUTHORITATIVE 60HZ GAME LOOP (IDLE-AWARE)
// ============================================================================
let lastLagLogAt = 0;
let tickCounter = 0;
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
let persistenceDirty = false;

function hasActiveSimulationRoom(): boolean {
  for (const room of rooms.values()) {
    if (room.clients.length > 0 && room.state !== 'lobby' && room.state !== 'gameover') {
      return true;
    }
  }
  return false;
}

function runSimulationTick(): void {
  tickCounter = (tickCounter + 1) % 2;
  const isSnapshotTick = tickCounter === 0;
  const tickStart = performance.now();
  let steppedAny = false;

  for (const room of rooms.values()) {
    if (room.clients.length === 0) continue;

    if (room.state === 'round_end') {
      steppedAny = true;
      room.roundEndTimer -= DT;
      if (room.roundEndTimer <= 0) {
        room.round += 1;
        resetRoundState(room);
        room.state = 'countdown';
        room.countdownTimer = 3.0;
        room.lastBroadcastCountdownSec = -1;
        room.events.push({ type: 'round_countdown', round: room.round });
      }
    }

    if (
      room.state === 'countdown' ||
      room.state === 'playing' ||
      room.state === 'round_end' ||
      room.state === 'gameover'
    ) {
      if (room.state !== 'gameover') steppedAny = true;
      stepRoomSimulation(room, DT, (finishedRoom) => {
        broadcastToRoom(finishedRoom, serializeRoomLobby(finishedRoom));
        trackEvent('match_completed', finishedRoom.id, {
          roomId: finishedRoom.id,
          winnerSlot: finishedRoom.winnerSlot ?? -1,
          isBotMatch: Boolean(finishedRoom.players[1]?.isBot),
          rounds: finishedRoom.round,
          durationSec: Math.round(finishedRoom.matchTime),
          scores: [finishedRoom.players[0]?.score || 0, finishedRoom.players[1]?.score || 0]
        });
      });

      const countdownSec = Math.ceil(Math.max(0, room.countdownTimer || 0));
      const countdownChanged =
        room.state === 'countdown' && countdownSec !== room.lastBroadcastCountdownSec;
      const shouldBroadcast =
        (room.state === 'playing' && isSnapshotTick) ||
        room.events.length > 0 ||
        countdownChanged;

      if (shouldBroadcast) {
        if (room.state === 'countdown') {
          room.lastBroadcastCountdownSec = countdownSec;
        }
        const snapshot = buildStateSnapshot(room);
        room.events = [];
        broadcastToRoom(room, snapshot);
      }
    }
  }

  if (steppedAny) {
    persistenceDirty = true;
  }

  if (!hasActiveSimulationRoom() && tickIntervalId !== null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }

  const tickMs = performance.now() - tickStart;
  if (tickMs > 25 && Date.now() - lastLagLogAt > 30_000) {
    lastLagLogAt = Date.now();
    trackEvent('tick_lag', 'server', { tickMs: Math.round(tickMs * 10) / 10, rooms: rooms.size });
  }
}

function ensureTickLoopRunning(): void {
  if (tickIntervalId === null && hasActiveSimulationRoom()) {
    tickIntervalId = setInterval(runSimulationTick, 1000 / TICK_RATE);
  }
}

// ============================================================================
// WEBSOCKET CONNECTION & ROOM SIGNALING
// ============================================================================
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

  if (room.clients.length === 0) {
    rooms.delete(room.id);
    persistenceDirty = true;
    return;
  }

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
  room.groundZones = [];
  persistenceDirty = true;
  broadcastToRoom(room, serializeRoomLobby(room));
}

wss.on('connection', (ws: WebSocket) => {
  (ws as unknown as { _socket?: { setNoDelay?: (noDelay?: boolean) => void } })._socket?.setNoDelay?.(
    true
  );
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

    if (msg.type === 'ping') {
      if (typeof msg.t === 'number' && Number.isFinite(msg.t)) {
        sendClientMessage(ws, { type: 'pong', t: msg.t });
      }
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
      const rawCustom = (msg.customCode || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12);
      const roomId = rawCustom || generateRoomId();
      if (rooms.has(roomId)) {
        sendClientMessage(ws, {
          type: 'error_msg',
          message: 'Room code already exists. Try another code.'
        });
        return;
      }

      const passcode = (msg.passcode || '').trim();
      const spells = validateSpells(msg.spells);
      const championId = normalizeChampionId(msg.championId, DEFAULT_CHAMPION_ID);
      const champ = getChampionConfig(championId);
      const cooldownMode: CooldownMode = msg.cooldownMode === 'standard' ? 'standard' : 'fast';
      const settings: RoomSettings = {
        bestOf: parseBestOf(msg.bestOf),
        cooldownMode
      };

      const room: GameRoom = {
        id: roomId,
        passcode,
        championId,
        state: 'lobby',
        round: 1,
        matchTime: 0,
        countdownTimer: 0,
        lastBroadcastCountdownSec: -1,
        roundEndTimer: 0,
        nextProjId: 1,
        nextZoneId: 1,
        botEnabled: Boolean(msg.withBot),
        botDifficulty: 'challenger',
        settings,
        clients: [client],
        players: [
          createPlayerState(
            0,
            (msg.name || champ.defaultPlayerName).slice(0, 20),
            spells,
            false,
            championId
          ),
          msg.withBot
            ? createPlayerState(1, champ.defaultBotName, ['flash', 'ghost'], true, championId)
            : null
        ],
        projectiles: [],
        groundZones: [],
        events: []
      };

      client.roomId = roomId;
      client.slot = 0;
      rooms.set(roomId, room);
      persistenceDirty = true;

      trackEvent('room_created', client.id, {
        roomId,
        withBot: room.botEnabled,
        bestOf: settings.bestOf,
        cooldownMode: settings.cooldownMode,
        hasPasscode: Boolean(passcode)
      });

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

      // Reclaim a disconnected slot from a server-restart snapshot if available
      const requestedName = (msg.name || '').trim().slice(0, 20);
      let reclaimSlot: 0 | 1 | -1 = -1;
      for (const s of [0, 1] as const) {
        const p = room.players[s];
        if (p && !p.isBot && p.awaitingReconnect) {
          if (requestedName && p.name === requestedName) {
            reclaimSlot = s;
            break;
          }
          if (reclaimSlot === -1) reclaimSlot = s;
        }
      }

      if (reclaimSlot !== -1) {
        const reclaimed = room.players[reclaimSlot]!;
        reclaimed.awaitingReconnect = false;
        if (requestedName) reclaimed.name = requestedName;
        client.roomId = roomId;
        client.slot = reclaimSlot;
        room.clients.push(client);
        room.restoredAt = undefined;

        sendClientMessage(ws, {
          type: 'joined_room',
          roomId,
          slot: reclaimSlot,
          passcode: room.passcode,
          lobby: serializeRoomLobby(room)
        });
        broadcastToRoom(room, serializeRoomLobby(room));
        if (room.state !== 'lobby') {
          sendClientMessage(ws, buildStateSnapshot(room));
          ensureTickLoopRunning();
        }
        persistenceDirty = true;
        trackEvent('room_joined', client.id, { roomId, slot: reclaimSlot, reclaimed: true });
        return;
      }

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
      const champ = getChampionConfig(room.championId);
      room.players[assignedSlot] = createPlayerState(
        assignedSlot,
        (msg.name || `${champ.name} #${assignedSlot + 1}`).slice(0, 20),
        spells,
        false,
        room.championId
      );

      client.roomId = roomId;
      client.slot = assignedSlot;
      room.clients.push(client);
      persistenceDirty = true;

      sendClientMessage(ws, {
        type: 'joined_room',
        roomId,
        slot: assignedSlot,
        passcode: room.passcode,
        lobby: serializeRoomLobby(room)
      });
      broadcastToRoom(room, serializeRoomLobby(room));
      trackEvent('room_joined', client.id, { roomId, slot: assignedSlot, reclaimed: false });
      return;
    }

    // All subsequent actions require being in a room
    const room = client.roomId ? rooms.get(client.roomId) : undefined;
    if (!room || client.slot === null) return;
    const player = room.players[client.slot];
    if (!player) return;

    if (msg.type === 'select_champion') {
      if (client.slot !== 0 || room.state !== 'lobby') return;
      const nextChampionId = normalizeChampionId(msg.championId, room.championId);
      room.championId = nextChampionId;
      for (const p of room.players) {
        if (p) setPlayerChampion(p, nextChampionId);
      }
      persistenceDirty = true;
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'select_spells') {
      if (room.state !== 'lobby') return;
      player.spells = validateSpells(msg.spells);
      const fastCd = room.settings.cooldownMode !== 'standard';
      player.maxSpellCd = [
        getSpellCooldown(player.spells[0], fastCd),
        getSpellCooldown(player.spells[1], fastCd)
      ];
      persistenceDirty = true;
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'update_name') {
      if (msg.name && typeof msg.name === 'string') {
        player.name = msg.name.trim().slice(0, 20) || player.name;
        persistenceDirty = true;
        broadcastToRoom(room, serializeRoomLobby(room));
      }
      return;
    }

    if (msg.type === 'toggle_bot') {
      if (client.slot !== 0 || room.state !== 'lobby') return;
      if (room.players[1] && !room.players[1].isBot) return;
      room.botEnabled = !room.botEnabled;
      const botChamp = getChampionConfig(room.championId);
      room.players[1] = room.botEnabled
        ? createPlayerState(1, botChamp.defaultBotName, ['flash', 'ghost'], true, botChamp.id)
        : null;
      persistenceDirty = true;
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
        persistenceDirty = true;
        broadcastToRoom(room, serializeRoomLobby(room));
      }
      return;
    }

    if (msg.type === 'set_ready') {
      player.ready = Boolean(msg.ready);
      persistenceDirty = true;
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'start_match' || msg.type === 'rematch') {
      if (msg.type === 'start_match' && (client.slot !== 0 || room.state !== 'lobby')) return;
      if (msg.type === 'rematch' && room.state !== 'gameover') return;
      if (!room.players[0] || !room.players[1]) {
        sendClientMessage(ws, {
          type: 'error_msg',
          message: 'Waiting for opponent (or enable AI Bot to practice).'
        });
        return;
      }
      room.round = 1;
      room.matchTime = 0;
      room.winnerSlot = undefined;
      room.players[0].score = 0;
      room.players[1].score = 0;
      room.players[0].stats = { abilitiesCast: 0, abilitiesHit: 0, damageDealt: 0 };
      room.players[1].stats = { abilitiesCast: 0, abilitiesHit: 0, damageDealt: 0 };
      resetRoundState(room);
      room.state = 'countdown';
      room.countdownTimer = 3.0;
      room.lastBroadcastCountdownSec = -1;
      room.events.push({ type: 'round_countdown', round: 1 });
      persistenceDirty = true;
      ensureTickLoopRunning();
      broadcastToRoom(room, serializeRoomLobby(room));
      trackEvent('match_started', room.id, {
        roomId: room.id,
        isRematch: msg.type === 'rematch',
        isBotMatch: Boolean(room.players[1]?.isBot),
        bestOf: room.settings.bestOf,
        cooldownMode: room.settings.cooldownMode,
        p0Champion: room.players[0].championId,
        p1Champion: room.players[1].championId,
        p0Spells: room.players[0].spells,
        p1Spells: room.players[1].spells
      });
      return;
    }

    if (msg.type === 'return_to_lobby') {
      if (room.state !== 'gameover' && client.slot !== 0) return;
      room.state = 'lobby';
      room.winnerSlot = undefined;
      room.projectiles = [];
      room.groundZones = [];
      for (const p of room.players) {
        if (p && !p.isBot) p.ready = false;
      }
      persistenceDirty = true;
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'move') {
      if (room.state !== 'playing' || !player.alive || player.knockupTimer > 0) return;
      const tx = Number(msg.x);
      const tz = Number(msg.z);
      if (Number.isFinite(tx) && Number.isFinite(tz)) {
        const champ = getChampionConfig(player.championId);
        const clamped = clampToBaronPitHalf(tx, tz, player.slot, champ.stats.hitboxRadius);
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
        castPrimaryAbility(room, player, tx, tz);
      }
      return;
    }

    if (msg.type === 'cast_spell') {
      if (room.state !== 'playing' || !player.alive) return;
      const spellIndex = Number(msg.spellIndex);
      const rawX = Number(msg.x);
      const rawZ = Number(msg.z);
      const tx = Number.isFinite(rawX) ? rawX : player.x;
      const tz = Number.isFinite(rawZ) ? rawZ : player.z;
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

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.clients.length === 0 && room.restoredAt && now - room.restoredAt > RESTORED_ROOM_TTL_MS) {
      rooms.delete(id);
      persistenceDirty = true;
    }
  }
  if (persistenceDirty) {
    persistenceDirty = false;
    void persistence.save(rooms);
  }
}, 2000);

function handleShutdown(): void {
  persistence.saveSync(rooms);
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

persistence.loadInto(rooms);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  trackEvent('server_started', 'server', { port: PORT, restoredRooms: rooms.size });
});
