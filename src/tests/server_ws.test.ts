import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { ServerToClientMessage } from '../shared/types.js';

const PORT = 3297;
const SNAPSHOT_FILE = `/tmp/drmundo-e2e-snapshot-${process.pid}.json`;

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

test('live server WS flow supports champion selection, ChoGath Rupture, and Mundo cleaver 1v1', async () => {
  const serverEntry = path.resolve(process.cwd(), 'dist', 'server.js');
  assert.ok(fs.existsSync(serverEntry), 'dist/server.js must be built before running E2E test');

  const proc = spawn('node', [serverEntry], {
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

    // Player 0 creates room as Cho'Gath
    ws0.send(
      JSON.stringify({
        type: 'create_room',
        name: 'VoidPlayer',
        championId: 'chogath',
        spells: ['flash', 'ghost'],
        withBot: false
      })
    );

    const joined0 = await nextMatching(msgs0, (m) => m.type === 'joined_room', ws0);
    assert.equal(joined0.type, 'joined_room');
    if (joined0.type !== 'joined_room') return;
    assert.equal(joined0.lobby.players[0]?.championId, 'chogath');

    // Player 1 joins as Dr. Mundo
    ws1.send(
      JSON.stringify({
        type: 'join_room',
        roomId: joined0.roomId,
        name: 'CleaverPlayer',
        championId: 'drmundo',
        spells: ['flash', 'heal']
      })
    );

    const joined1 = await nextMatching(msgs1, (m) => m.type === 'joined_room', ws1);
    assert.equal(joined1.type, 'joined_room');
    if (joined1.type !== 'joined_room') return;
    assert.equal(joined1.lobby.players[0]?.championId, 'chogath');
    assert.equal(joined1.lobby.players[1]?.championId, 'drmundo');

    // Start match and wait for countdown (3s) -> playing
    msgs0.length = 0;
    ws0.send(JSON.stringify({ type: 'start_match' }));

    await nextMatching(
      msgs0,
      (m) => m.type === 'state_snapshot' && m.state === 'playing',
      ws0,
      5000
    );

    // Cho'Gath casts Q toward Red side spawn (300, 300), Mundo casts Q toward Blue side (-300, -300)
    msgs0.length = 0;
    ws0.send(JSON.stringify({ type: 'cast_q', x: 300, z: 300 }));
    ws1.send(JSON.stringify({ type: 'cast_q', x: -300, z: -300 }));

    const launchEv = await nextMatching(
      msgs0,
      (m) =>
        m.type === 'state_snapshot' &&
        m.events.some((e) => e.type === 'q_launch' && e.championId === 'drmundo'),
      ws0,
      2000
    );
    assert.equal(launchEv.type, 'state_snapshot');

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
  } finally {
    ws0?.close();
    ws1?.close();
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
    if (fs.existsSync(SNAPSHOT_FILE)) fs.unlinkSync(SNAPSHOT_FILE);
  }
});
