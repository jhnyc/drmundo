import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { ServerToClientMessage } from '../shared/types.js';

const PORT = Number(process.env.TEST_SERVER_PORT) || 3297;
const SNAPSHOT_FILE = `/tmp/drmundo-e2e-snapshot-${process.pid}.json`;

function resolveServerSpawn(): { cmd: string; args: string[] } {
  const customCmd = process.env.TEST_SERVER_CMD?.trim();
  if (customCmd) {
    const rawArgs = process.env.TEST_SERVER_ARGS?.trim();
    let args: string[] = [];
    if (rawArgs) {
      args = rawArgs.startsWith('[') ? (JSON.parse(rawArgs) as string[]) : rawArgs.split(/\s+/);
    }
    return { cmd: customCmd, args };
  }
  const serverEntry = path.resolve(process.cwd(), 'dist', 'server.js');
  assert.ok(fs.existsSync(serverEntry), 'dist/server.js must be built before running E2E test');
  return { cmd: 'node', args: [serverEntry] };
}

function connectClient(url: string, inbox: ServerToClientMessage[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('message', (raw) => {
      inbox.push(JSON.parse(raw.toString()) as ServerToClientMessage);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMatching(
  messages: ServerToClientMessage[],
  predicate: (m: ServerToClientMessage) => boolean,
  ws: WebSocket,
  timeoutMs = 6000
): Promise<ServerToClientMessage> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMsg = () => {
      const match = messages.find(predicate);
      if (match) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(match);
      }
    };
    ws.on('message', onMsg);
  });
}

test('live server WS enforces same-champ vs same-champ mirror and executes ChoGath Rupture 1v1', async () => {
  const { cmd, args } = resolveServerSpawn();

  const proc = spawn(cmd, args, {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOMS_SNAPSHOT_PATH: SNAPSHOT_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let ws0: WebSocket | null = null;
  let ws1: WebSocket | null = null;
  const msgs0: ServerToClientMessage[] = [];
  const msgs1: ServerToClientMessage[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
      proc.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('server_started')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.stderr.on('data', (chunk) => {
        const errText = chunk.toString().trim();
        if (errText) {
          clearTimeout(timer);
          reject(new Error(`Server stderr: ${errText}`));
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}`));
      });
    });

    [ws0, ws1] = await Promise.all([
      connectClient(`ws://127.0.0.1:${PORT}`, msgs0),
      connectClient(`ws://127.0.0.1:${PORT}`, msgs1)
    ]);

    // Host creates room as Cho'Gath (mirror 1v1)
    ws0.send(
      JSON.stringify({
        type: 'create_room',
        name: 'VoidHost',
        championId: 'chogath',
        spells: ['flash', 'ghost'],
        withBot: false
      })
    );

    const joined0 = await nextMatching(msgs0, (m) => m.type === 'joined_room', ws0);
    assert.equal(joined0.type, 'joined_room');
    if (joined0.type !== 'joined_room') return;
    assert.equal(joined0.lobby.championId, 'chogath');
    assert.equal(joined0.lobby.players[0]?.championId, 'chogath');

    // Player 1 joins and automatically inherits room's champion (Cho'Gath)
    ws1.send(
      JSON.stringify({
        type: 'join_room',
        roomId: joined0.roomId,
        name: 'VoidChallenger',
        spells: ['flash', 'heal']
      })
    );

    const joined1 = await nextMatching(msgs1, (m) => m.type === 'joined_room', ws1);
    assert.equal(joined1.type, 'joined_room');
    if (joined1.type !== 'joined_room') return;
    assert.equal(joined1.lobby.championId, 'chogath');
    assert.equal(joined1.lobby.players[0]?.championId, 'chogath');
    assert.equal(joined1.lobby.players[1]?.championId, 'chogath');

    // Non-host trying select_champion cannot override room champion
    msgs0.length = 0;
    ws1.send(JSON.stringify({ type: 'select_champion', championId: 'drmundo' }));
    // Host toggles to drmundo then back to chogath -> both slots mirror
    ws0.send(JSON.stringify({ type: 'select_champion', championId: 'drmundo' }));
    const switchedToMundo = await nextMatching(
      msgs0,
      (m) => m.type === 'room_update' && m.championId === 'drmundo',
      ws0
    );
    assert.equal(switchedToMundo.type, 'room_update');
    if (switchedToMundo.type === 'room_update') {
      assert.equal(switchedToMundo.players[0]?.championId, 'drmundo');
      assert.equal(switchedToMundo.players[1]?.championId, 'drmundo');
    }

    msgs0.length = 0;
    ws0.send(JSON.stringify({ type: 'select_champion', championId: 'chogath' }));
    await nextMatching(
      msgs0,
      (m) => m.type === 'room_update' && m.championId === 'chogath',
      ws0
    );

    // Start Cho'Gath mirror match and wait for countdown -> playing
    msgs0.length = 0;
    ws0.send(JSON.stringify({ type: 'start_match' }));

    await nextMatching(
      msgs0,
      (m) => m.type === 'state_snapshot' && m.state === 'playing',
      ws0,
      5000
    );

    // Both Cho'Gaths cast Q Rupture
    msgs0.length = 0;
    ws0.send(JSON.stringify({ type: 'cast_q', x: 300, z: 300 }));
    ws1.send(JSON.stringify({ type: 'cast_q', x: -300, z: -300 }));

    const zoneSpawnEv = await nextMatching(
      msgs0,
      (m) =>
        m.type === 'state_snapshot' &&
        m.events.some((e) => e.type === 'zone_spawn' && e.championId === 'chogath'),
      ws0,
      2000
    );
    assert.equal(zoneSpawnEv.type, 'state_snapshot');

    const zoneEruptEv = await nextMatching(
      msgs0,
      (m) =>
        m.type === 'state_snapshot' &&
        m.events.some((e) => e.type === 'zone_erupt' && e.championId === 'chogath'),
      ws0,
      2000
    );
    assert.equal(zoneEruptEv.type, 'state_snapshot');

    // Verify HTTP endpoints: /healthz, /api/rooms, and gzip-compressed /three/build/three.module.js
    const healthRes = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { ok: boolean; rooms: number };
    assert.equal(healthBody.ok, true);
    assert.ok(healthBody.rooms >= 1);

    const roomsRes = await fetch(`http://127.0.0.1:${PORT}/api/rooms`);
    assert.equal(roomsRes.status, 200);
    const roomsBody = (await roomsRes.json()) as { rooms: Array<{ id: string }> };
    assert.ok(Array.isArray(roomsBody.rooms));
    assert.ok(roomsBody.rooms.some((r) => r.id === joined0.roomId));

    const threeRes = await fetch(`http://127.0.0.1:${PORT}/three/build/three.module.js`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(threeRes.status, 200);
    assert.equal(threeRes.headers.get('content-encoding'), 'gzip');
    const threeText = await threeRes.text();
    assert.ok(threeText.includes('WebGLRenderer'));
  } finally {
    ws0?.close();
    ws1?.close();
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
    if (fs.existsSync(SNAPSHOT_FILE)) fs.unlinkSync(SNAPSHOT_FILE);
  }
});
