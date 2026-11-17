import assert from 'node:assert/strict';
import test from 'node:test';
import { castPrimaryAbility, createPlayerState, resetRoundState } from '../server/actions.js';
import { buildStateSnapshot, stepRoomSimulation } from '../server/simulation.js';
import type { GameRoom } from '../server/types.js';
import { getChampionConfig } from '../shared/champions/index.js';
import { DT } from '../shared/constants.js';

function createPlayingRoom(): GameRoom {
  const room: GameRoom = {
    id: 'TEST01',
    passcode: '',
    state: 'playing',
    round: 1,
    matchTime: 0,
    countdownTimer: 0,
    lastBroadcastCountdownSec: -1,
    roundEndTimer: 0,
    nextProjId: 1,
    nextZoneId: 1,
    botEnabled: false,
    botDifficulty: 'challenger',
    settings: { bestOf: 3, cooldownMode: 'fast' },
    clients: [],
    players: [
      createPlayerState(0, 'Blue', ['flash', 'ghost'], false, 'drmundo'),
      createPlayerState(1, 'Red', ['flash', 'ghost'], false, 'drmundo')
    ],
    projectiles: [],
    groundZones: [],
    events: []
  };
  resetRoundState(room);
  return room;
}

test('Dr. Mundo Q windup, launch, hit, slow, HP refund, and kill parity', () => {
  const room = createPlayingRoom();
  const p0 = room.players[0]!;
  const p1 = room.players[1]!;
  const mundo = getChampionConfig('drmundo');

  assert.equal(p0.hp, mundo.stats.maxHp);
  assert.equal(p1.hp, mundo.stats.maxHp);

  // Cast Q straight toward p1
  castPrimaryAbility(room, p0, p1.x, p1.z);
  assert.equal(p0.stats.abilitiesCast, 1);
  assert.equal(p0.hp, mundo.stats.maxHp - mundo.q.hpCost);
  assert.equal(room.events.some((e) => e.type === 'q_windup'), true);

  // Step through windup + flight until hit
  let hitFound = false;
  for (let tick = 0; tick < 120; tick++) {
    stepRoomSimulation(room, DT);
    if (room.events.some((e) => e.type === 'q_hit')) {
      hitFound = true;
      break;
    }
  }

  assert.equal(hitFound, true, 'Cleaver should hit stationary opponent');
  assert.equal(p0.stats.abilitiesHit, 1);
  assert.ok(p1.hp < mundo.stats.maxHp, 'Victim HP should drop on hit');
  assert.ok(p1.slowTimer > 0, 'Victim should be slowed after hit');
  assert.ok(p0.hp >= mundo.stats.maxHp - 5, 'Attacker should be refunded 50 HP on hit');

  // Reduce victim HP below min damage and verify round win triggers
  p0.qCd = 0;
  p0.castTimer = 0;
  p1.hp = 100;
  room.events = [];
  castPrimaryAbility(room, p0, p1.x, p1.z);
  for (let tick = 0; tick < 120; tick++) {
    stepRoomSimulation(room, DT);
    if (room.events.some((e) => e.type === 'round_kill')) break;
  }

  assert.equal(p1.alive, false);
  assert.equal(p0.score, 1);
  assert.equal(room.state, 'round_end');
});

test('delayed ground AoE zone hits, applies knockup, and blocks movement while airborne', () => {
  const room = createPlayingRoom();
  const p1 = room.players[1]!;
  const startX = p1.x;
  const startZ = p1.z;

  // Inject a delayed ground zone directly on p1 (proves simulation engine primitive)
  room.groundZones.push({
    id: 1,
    ownerSlot: 0,
    championId: 'drmundo',
    x: startX,
    z: startZ,
    radius: 175,
    remaining: 0.5,
    duration: 0.5,
    damageFlatMin: 300,
    damagePercentCurrentHp: 0,
    knockupDuration: 0.85,
    slowPercent: 0.5,
    slowDuration: 1.5,
    refundOnHit: 0
  });

  // Step 0.6s so zone erupts
  for (let i = 0; i < 36; i++) {
    stepRoomSimulation(room, DT);
  }

  const eruptEv = room.events.find((e) => e.type === 'zone_erupt');
  assert.ok(eruptEv && eruptEv.type === 'zone_erupt');
  assert.equal(eruptEv.hitVictim, true);
  assert.ok(p1.knockupTimer > 0.5, 'Victim should be airborne');
  assert.ok(p1.slowTimer > 1.0, 'Victim should be slowed');

  // Trying to move while airborne should keep position pinned
  p1.targetX = startX - 200;
  p1.targetZ = startZ - 200;
  stepRoomSimulation(room, DT);
  assert.equal(p1.x, startX);
  assert.equal(p1.z, startZ);

  const snap = buildStateSnapshot(room);
  assert.equal(snap.type, 'state_snapshot');
  if (snap.type === 'state_snapshot') {
    assert.ok(snap.players[1]!.knockupTimer > 0);
  }
});
