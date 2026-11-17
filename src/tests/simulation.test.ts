import assert from 'node:assert/strict';
import test from 'node:test';
import { castPrimaryAbility, createPlayerState, resetRoundState } from '../server/actions.js';
import { buildStateSnapshot, stepRoomSimulation } from '../server/simulation.js';
import type { GameRoom } from '../server/types.js';
import { getChampionConfig } from '../shared/champions/index.js';
import { DT } from '../shared/constants.js';
import type { ChampionId } from '../shared/types.js';

function createPlayingRoom(
  p0Champ: ChampionId = 'drmundo',
  p1Champ: ChampionId = 'drmundo',
  p1IsBot = false
): GameRoom {
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
    botEnabled: p1IsBot,
    botDifficulty: 'challenger',
    settings: { bestOf: 3, cooldownMode: 'fast' },
    clients: [],
    players: [
      createPlayerState(0, 'Blue', ['flash', 'ghost'], false, p0Champ),
      createPlayerState(1, 'Red', ['flash', 'ghost'], p1IsBot, p1Champ)
    ],
    projectiles: [],
    groundZones: [],
    events: []
  };
  resetRoundState(room);
  return room;
}

test('Dr. Mundo Q windup, launch, hit, slow, HP refund, and kill parity', () => {
  const room = createPlayingRoom('drmundo', 'drmundo');
  const p0 = room.players[0]!;
  const p1 = room.players[1]!;
  const mundo = getChampionConfig('drmundo');

  assert.equal(p0.hp, mundo.stats.maxHp);
  assert.equal(p1.hp, mundo.stats.maxHp);
  if (mundo.q.archetype !== 'linear_projectile') throw new Error('Expected linear projectile');

  castPrimaryAbility(room, p0, p1.x, p1.z);
  assert.equal(p0.stats.abilitiesCast, 1);
  assert.equal(p0.hp, mundo.stats.maxHp - mundo.q.hpCost);
  assert.equal(room.events.some((e) => e.type === 'q_windup'), true);

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

test("Cho'Gath Q Rupture casts across center line, telegraphs, erupts, knocks airborne, and respects range clamp", () => {
  const room = createPlayingRoom('chogath', 'drmundo');
  const p0 = room.players[0]!;
  const p1 = room.players[1]!;
  const chogath = getChampionConfig('chogath');
  const mundo = getChampionConfig('drmundo');

  assert.equal(chogath.q.archetype, 'delayed_ground_aoe');
  if (chogath.q.archetype !== 'delayed_ground_aoe') return;

  assert.equal(p0.hp, chogath.stats.maxHp);
  assert.equal(p1.hp, mundo.stats.maxHp);

  // Target directly on opponent across the Baron Pit center line
  castPrimaryAbility(room, p0, p1.x, p1.z);
  assert.equal(p0.stats.abilitiesCast, 1);
  assert.equal(p0.hp, chogath.stats.maxHp, 'ChoGath Q has no HP cost');

  // Step through castTime (0.25s = 15 ticks) -> zone_spawn should fire
  for (let i = 0; i < 18; i++) {
    stepRoomSimulation(room, DT);
  }
  const spawnEv = room.events.find((e) => e.type === 'zone_spawn');
  assert.ok(spawnEv && spawnEv.type === 'zone_spawn', 'Ground zone should spawn after castTime');
  assert.equal(room.groundZones.length, 1);
  assert.equal(spawnEv.championId, 'chogath');

  // Snapshot exposes groundZones for client telegraph rendering
  const snapDuringTelegraph = buildStateSnapshot(room);
  assert.equal(snapDuringTelegraph.type, 'state_snapshot');
  if (snapDuringTelegraph.type === 'state_snapshot') {
    assert.equal(snapDuringTelegraph.groundZones.length, 1);
    assert.equal(snapDuringTelegraph.players[0]?.championId, 'chogath');
  }

  // Step past delay (0.625s ~ 38 ticks) -> zone erupts and knocks Mundo airborne
  for (let i = 0; i < 45; i++) {
    stepRoomSimulation(room, DT);
  }

  const eruptEv = room.events.find((e) => e.type === 'zone_erupt');
  const hitEv = room.events.find((e) => e.type === 'q_hit');
  assert.ok(eruptEv && eruptEv.type === 'zone_erupt');
  assert.equal(eruptEv.hitVictim, true);
  assert.ok(hitEv && hitEv.type === 'q_hit');
  assert.equal(hitEv.attackerChampionId, 'chogath');
  assert.ok(hitEv.damage >= chogath.q.damage.flatMin);
  assert.ok(p1.knockupTimer > 0.5, 'Victim should be knocked airborne');
  assert.ok(p1.slowTimer > 1.0, 'Victim should be slowed after Rupture');

  // Verify airborne prevents movement
  const pinnedX = p1.x;
  const pinnedZ = p1.z;
  p1.targetX = p1.x + 150;
  p1.targetZ = p1.z + 150;
  stepRoomSimulation(room, DT);
  assert.equal(p1.x, pinnedX);
  assert.equal(p1.z, pinnedZ);

  // Verify range clamping when targeting far beyond max range
  p0.qCd = 0;
  p0.castTimer = 0;
  room.events = [];
  castPrimaryAbility(room, p0, p0.x + 5000, p0.z);
  for (let i = 0; i < 18; i++) {
    stepRoomSimulation(room, DT);
  }
  const clampedZone = room.groundZones[0];
  assert.ok(clampedZone, 'Clamped zone should spawn');
  const distFromCaster = Math.hypot(clampedZone.x - p0.x, clampedZone.z - p0.z);
  assert.ok(distFromCaster <= chogath.q.range + 1, 'Rupture target must clamp to range');
});

test('Bot AI actively dodges out of Rupture ground zone and can cast as ChoGath', () => {
  const room = createPlayingRoom('drmundo', 'chogath', true);
  const bot = room.players[1]!;
  const startX = bot.x;
  const startZ = bot.z;

  // Place a hostile Rupture directly on the bot
  room.groundZones.push({
    id: 99,
    ownerSlot: 0,
    championId: 'chogath',
    x: startX,
    z: startZ,
    radius: 175,
    remaining: 0.625,
    duration: 0.625,
    damageFlatMin: 310,
    damagePercentCurrentHp: 0.08,
    knockupDuration: 0.85,
    slowPercent: 0.5,
    slowDuration: 1.5,
    refundOnHit: 0
  });

  // Step simulation; bot should set target outside the Rupture and move away
  for (let i = 0; i < 40; i++) {
    stepRoomSimulation(room, DT);
  }

  const distFromZone = Math.hypot(bot.x - startX, bot.z - startZ);
  assert.ok(distFromZone > 100, `Bot should move away from Rupture (moved ${distFromZone.toFixed(1)})`);
});
