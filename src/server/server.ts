import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import crypto from 'crypto';
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
  castInfectedBonesaw,
  clampToBaronPitHalf,
  createPlayerState,
  resetRoundState,
  useSummonerSpell
} from './actions.js';
import {
  DT,
  TICK_RATE,
  getSpellCooldown,
  parseBestOf,
  validateSpells
} from './constants.js';
import { RESTORED_ROOM_TTL_MS, RoomPersistence } from './persistence.js';
import { buildStateSnapshot, stepRoomSimulation } from './simulation.js';
import type { ConnectedClient, GameRoom, ServerPlayerState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use('/three', express.static(path.join(PROJECT_ROOT, 'node_modules/three')));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

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
// AUTHORITATIVE 60HZ GAME LOOP
// ============================================================================
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.length === 0) continue;

    if (room.state === 'round_end') {
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
      stepRoomSimulation(room, DT, (finishedRoom) => {
        broadcastToRoom(finishedRoom, serializeRoomLobby(finishedRoom));
      });

      const countdownSec = Math.ceil(Math.max(0, room.countdownTimer || 0));
      const countdownChanged =
        room.state === 'countdown' && countdownSec !== room.lastBroadcastCountdownSec;
      const shouldBroadcast =
        room.state === 'playing' || room.events.length > 0 || countdownChanged;

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
}, 1000 / TICK_RATE);

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
  broadcastToRoom(room, serializeRoomLobby(room));
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
        lastBroadcastCountdownSec: -1,
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
        }
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
      if (room.state !== 'lobby') return;
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
      if (client.slot !== 0 || room.state !== 'lobby') return;
      if (room.players[1] && !room.players[1].isBot) return;
      room.botEnabled = !room.botEnabled;
      room.players[1] = room.botEnabled
        ? createPlayerState(1, 'Dr. Mundo Bot', ['flash', 'ghost'], true)
        : null;
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
      room.players[0].stats = { cleaversThrown: 0, cleaversHit: 0, damageDealt: 0 };
      room.players[1].stats = { cleaversThrown: 0, cleaversHit: 0, damageDealt: 0 };
      resetRoundState(room);
      room.state = 'countdown';
      room.countdownTimer = 3.0;
      room.lastBroadcastCountdownSec = -1;
      room.events.push({ type: 'round_countdown', round: 1 });
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

    if (msg.type === 'return_to_lobby') {
      if (room.state !== 'gameover' && client.slot !== 0) return;
      room.state = 'lobby';
      room.winnerSlot = undefined;
      room.projectiles = [];
      for (const p of room.players) {
        if (p && !p.isBot) p.ready = false;
      }
      broadcastToRoom(room, serializeRoomLobby(room));
      return;
    }

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
  void persistence.save(rooms);
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.clients.length === 0 && room.restoredAt && now - room.restoredAt > RESTORED_ROOM_TTL_MS) {
      rooms.delete(id);
    }
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
  console.log(`Baron Pit Dr. Mundo 1v1 server running at http://localhost:${PORT}`);
});
