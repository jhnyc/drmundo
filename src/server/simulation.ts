import { getChampionConfig } from '../shared/champions/index.js';
import type { QAbilityDamageConfig } from '../shared/champions/types.js';
import { PIT_RADIUS, SUMMONER_SPELLS } from '../shared/constants.js';
import type {
  ChampionId,
  GroundZoneSnapshot,
  PlayerSnapshot,
  ProjectileSnapshot,
  ServerToClientMessage
} from '../shared/types.js';
import { clampToBaronPitHalf } from './actions.js';
import { updateBotAI } from './bot.js';
import type { GameRoom, ServerPlayerState } from './types.js';

function computeAbilityDamage(targetHp: number, damage: QAbilityDamageConfig): number {
  const rawPctDmg = targetHp * damage.percentCurrentHp;
  return Math.round(Math.max(damage.flatMin, rawPctDmg));
}

function releasePendingCast(room: GameRoom, player: ServerPlayerState): void {
  if (!player.pendingCast) return;
  const { targetX, targetZ, dirX, dirZ } = player.pendingCast;
  player.pendingCast = null;

  const champ = getChampionConfig(player.championId);
  const q = champ.q;

  if (q.archetype === 'linear_projectile') {
    const projId = ++room.nextProjId;
    const spawnX = player.x + dirX * q.spawnOffset;
    const spawnZ = player.z + dirZ * q.spawnOffset;
    room.projectiles.push({
      id: projId,
      ownerSlot: player.slot,
      championId: player.championId,
      x: spawnX,
      z: spawnZ,
      startX: spawnX,
      startZ: spawnZ,
      dirX,
      dirZ,
      speed: q.speed,
      maxRange: q.range,
      radius: q.radius,
      damageFlatMin: q.damage.flatMin,
      damagePercentCurrentHp: q.damage.percentCurrentHp,
      slowPercent: q.slow?.percent ?? 0,
      slowDuration: q.slow?.duration ?? 0,
      refundOnHit: q.refundOnHit
    });
    room.events.push({
      type: 'q_launch',
      slot: player.slot,
      championId: player.championId,
      projId,
      x: spawnX,
      z: spawnZ,
      dirX,
      dirZ
    });
    return;
  }

  // Delayed ground AoE (e.g., Cho'Gath Rupture)
  const zoneId = ++room.nextZoneId;
  room.groundZones.push({
    id: zoneId,
    ownerSlot: player.slot,
    championId: player.championId,
    x: targetX,
    z: targetZ,
    radius: q.radius,
    remaining: q.delay,
    duration: q.delay,
    damageFlatMin: q.damage.flatMin,
    damagePercentCurrentHp: q.damage.percentCurrentHp,
    knockupDuration: q.knockupDuration,
    slowPercent: q.slow?.percent ?? 0,
    slowDuration: q.slow?.duration ?? 0,
    refundOnHit: q.refundOnHit
  });
  room.events.push({
    type: 'zone_spawn',
    zoneId,
    ownerSlot: player.slot,
    championId: player.championId,
    x: targetX,
    z: targetZ,
    radius: q.radius,
    duration: q.delay
  });
}

function applyHitAndCheckRoundEnd(
  room: GameRoom,
  params: {
    attackerSlot: number;
    attackerChampionId: ChampionId;
    victim: ServerPlayerState;
    projId?: number;
    zoneId?: number;
    damageFlatMin: number;
    damagePercentCurrentHp: number;
    slowPercent: number;
    slowDuration: number;
    knockupDuration?: number;
    refundOnHit: number;
  },
  onGameOver?: (room: GameRoom) => void
): void {
  const { victim } = params;
  const caster = room.players[params.attackerSlot];
  const dmg = computeAbilityDamage(victim.hp, {
    flatMin: params.damageFlatMin,
    percentCurrentHp: params.damagePercentCurrentHp
  });

  victim.hp = Math.max(0, victim.hp - dmg);

  if (params.slowDuration > 0 && params.slowPercent > 0) {
    if (victim.slowTimer <= 0 || params.slowPercent >= victim.slowPercent) {
      victim.slowPercent = params.slowPercent;
    }
    victim.slowTimer = Math.max(victim.slowTimer, params.slowDuration);
  }

  if (params.knockupDuration && params.knockupDuration > 0) {
    victim.knockupTimer = Math.max(victim.knockupTimer, params.knockupDuration);
    victim.knockupDuration = Math.max(victim.knockupDuration, params.knockupDuration);
    victim.targetX = victim.x;
    victim.targetZ = victim.z;
    victim.emoteTimer = 0;
  }

  if (caster && caster.alive) {
    if (params.refundOnHit > 0) {
      caster.hp = Math.min(caster.maxHp, caster.hp + params.refundOnHit);
    }
    caster.stats.abilitiesHit += 1;
    caster.stats.damageDealt += dmg;
  }

  room.events.push({
    type: 'q_hit',
    projId: params.projId,
    zoneId: params.zoneId,
    attackerSlot: params.attackerSlot,
    attackerChampionId: params.attackerChampionId,
    victimSlot: victim.slot,
    x: victim.x,
    z: victim.z,
    damage: dmg,
    refund: params.refundOnHit,
    knockupDuration: params.knockupDuration
  });

  if (victim.hp <= 0) {
    victim.alive = false;
    victim.anim = 'death';
    victim.knockupTimer = 0;
    victim.knockupDuration = 0;
    if (caster) caster.score += 1;

    const winsNeeded = Math.ceil((room.settings.bestOf || 3) / 2);
    const matchOver = Boolean(caster && caster.score >= winsNeeded);

    room.events.push({
      type: 'round_kill',
      winnerSlot: params.attackerSlot,
      loserSlot: victim.slot,
      round: room.round,
      scores: [room.players[0]?.score || 0, room.players[1]?.score || 0],
      matchOver
    });

    if (matchOver) {
      room.state = 'gameover';
      room.winnerSlot = params.attackerSlot;
      onGameOver?.(room);
    } else {
      room.state = 'round_end';
      room.roundEndTimer = 3.5;
    }
  }
}

function stepPlayers(room: GameRoom, dt: number): void {
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (!p || !p.alive) continue;

    const champ = getChampionConfig(p.championId);

    if (p.isBot) {
      const opp = room.players[1 - i];
      updateBotAI(room, p, opp, dt);
    }

    if (p.qCd > 0) p.qCd = Math.max(0, p.qCd - dt);
    if (p.spellCd[0] > 0) p.spellCd[0] = Math.max(0, p.spellCd[0] - dt);
    if (p.spellCd[1] > 0) p.spellCd[1] = Math.max(0, p.spellCd[1] - dt);
    if (p.slowTimer > 0) {
      p.slowTimer = Math.max(0, p.slowTimer - dt);
      if (p.slowTimer === 0) p.slowPercent = 0;
    }
    if (p.knockupTimer > 0) {
      p.knockupTimer = Math.max(0, p.knockupTimer - dt);
      if (p.knockupTimer === 0) p.knockupDuration = 0;
    }
    if (p.ghostTimer > 0) p.ghostTimer = Math.max(0, p.ghostTimer - dt);
    if (p.healSpeedTimer > 0) p.healSpeedTimer = Math.max(0, p.healSpeedTimer - dt);
    if (p.emoteTimer > 0) p.emoteTimer = Math.max(0, p.emoteTimer - dt);

    p.hp = Math.min(p.maxHp, p.hp + champ.stats.hpRegenPerSec * dt);

    if (p.castTimer > 0) {
      p.castTimer -= dt;
      if (p.castTimer <= 0 && p.pendingCast) {
        releasePendingCast(room, p);
      }
      continue;
    }

    if (p.knockupTimer > 0) {
      p.anim = 'idle';
      continue;
    }

    const dx = p.targetX - p.x;
    const dz = p.targetZ - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4) {
      let speed = champ.stats.baseMoveSpeed;
      if (p.ghostTimer > 0) speed *= 1 + SUMMONER_SPELLS.ghost.speedBoost;
      if (p.healSpeedTimer > 0) speed *= 1 + SUMMONER_SPELLS.heal.speedBoost;
      if (p.slowTimer > 0 && p.slowPercent > 0) speed *= 1 - p.slowPercent;

      const step = Math.min(dist, speed * dt);
      const nx = p.x + (dx / dist) * step;
      const nz = p.z + (dz / dist) * step;
      const clamped = clampToBaronPitHalf(nx, nz, p.slot, champ.stats.hitboxRadius);
      p.x = clamped.x;
      p.z = clamped.z;
      p.angle = Math.atan2(dx, dz);
      p.anim = p.ghostTimer > 0 ? 'run_haste' : 'run';
      p.emoteTimer = 0;
    } else {
      p.anim = p.emoteTimer > 0 ? p.emoteAnim || 'taunt' : 'idle';
    }
  }
}

function stepProjectiles(room: GameRoom, dt: number, onGameOver?: (room: GameRoom) => void): void {
  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const proj = room.projectiles[i];
    proj.x += proj.dirX * proj.speed * dt;
    proj.z += proj.dirZ * proj.speed * dt;

    const targetSlot = 1 - proj.ownerSlot;
    const target = room.players[targetSlot];

    if (target && target.alive) {
      const targetChamp = getChampionConfig(target.championId);
      const hitDist = Math.hypot(target.x - proj.x, target.z - proj.z);
      if (hitDist <= targetChamp.stats.hitboxRadius + proj.radius) {
        room.projectiles.splice(i, 1);
        applyHitAndCheckRoundEnd(
          room,
          {
            attackerSlot: proj.ownerSlot,
            attackerChampionId: proj.championId,
            victim: target,
            projId: proj.id,
            damageFlatMin: proj.damageFlatMin,
            damagePercentCurrentHp: proj.damagePercentCurrentHp,
            slowPercent: proj.slowPercent,
            slowDuration: proj.slowDuration,
            refundOnHit: proj.refundOnHit
          },
          onGameOver
        );
        continue;
      }
    }

    const traveled = Math.hypot(proj.x - proj.startX, proj.z - proj.startZ);
    const distFromCenter = Math.hypot(proj.x, proj.z);
    if (traveled >= proj.maxRange || distFromCenter >= PIT_RADIUS + 65) {
      room.events.push({
        type: 'q_miss',
        projId: proj.id,
        attackerSlot: proj.ownerSlot,
        attackerChampionId: proj.championId,
        x: proj.x,
        z: proj.z
      });
      room.projectiles.splice(i, 1);
    }
  }
}

function stepGroundZones(room: GameRoom, dt: number, onGameOver?: (room: GameRoom) => void): void {
  for (let i = room.groundZones.length - 1; i >= 0; i--) {
    const zone = room.groundZones[i];
    zone.remaining -= dt;
    if (zone.remaining > 0) continue;

    room.groundZones.splice(i, 1);

    const targetSlot = 1 - zone.ownerSlot;
    const target = room.players[targetSlot];
    let hitVictim = false;
    if (target && target.alive) {
      const targetChamp = getChampionConfig(target.championId);
      const dist = Math.hypot(target.x - zone.x, target.z - zone.z);
      hitVictim = dist <= targetChamp.stats.hitboxRadius + zone.radius;
    }

    room.events.push({
      type: 'zone_erupt',
      zoneId: zone.id,
      ownerSlot: zone.ownerSlot,
      championId: zone.championId,
      x: zone.x,
      z: zone.z,
      radius: zone.radius,
      hitVictim
    });

    if (hitVictim && target) {
      applyHitAndCheckRoundEnd(
        room,
        {
          attackerSlot: zone.ownerSlot,
          attackerChampionId: zone.championId,
          victim: target,
          zoneId: zone.id,
          damageFlatMin: zone.damageFlatMin,
          damagePercentCurrentHp: zone.damagePercentCurrentHp,
          slowPercent: zone.slowPercent,
          slowDuration: zone.slowDuration,
          knockupDuration: zone.knockupDuration,
          refundOnHit: zone.refundOnHit
        },
        onGameOver
      );
    } else {
      room.events.push({
        type: 'q_miss',
        zoneId: zone.id,
        attackerSlot: zone.ownerSlot,
        attackerChampionId: zone.championId,
        x: zone.x,
        z: zone.z
      });
    }
  }
}

export function stepRoomSimulation(
  room: GameRoom,
  dt: number,
  onGameOver?: (room: GameRoom) => void
): void {
  if (room.state === 'countdown') {
    room.countdownTimer -= dt;
    if (room.countdownTimer <= 0) {
      room.state = 'playing';
      room.events.push({ type: 'fight_start', round: room.round });
    }
  }

  if (room.state !== 'playing') {
    return;
  }

  room.matchTime += dt;
  stepPlayers(room, dt);
  stepProjectiles(room, dt, onGameOver);
  stepGroundZones(room, dt, onGameOver);
}

export function serializePlayerSnapshot(p: ServerPlayerState | null): PlayerSnapshot | null {
  if (!p) return null;
  return {
    slot: p.slot,
    name: p.name,
    championId: p.championId,
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
    slowPercent: Math.round(p.slowPercent * 100) / 100,
    knockupTimer: Math.round(p.knockupTimer * 100) / 100,
    knockupDuration: Math.round(p.knockupDuration * 100) / 100,
    ghostTimer: Math.round(p.ghostTimer * 100) / 100,
    healSpeedTimer: Math.round(p.healSpeedTimer * 100) / 100,
    score: p.score,
    stats: p.stats
  };
}

export function buildStateSnapshot(room: GameRoom): ServerToClientMessage {
  const projectiles: ProjectileSnapshot[] = room.projectiles.map((pr) => ({
    id: pr.id,
    ownerSlot: pr.ownerSlot,
    championId: pr.championId,
    x: Math.round(pr.x * 10) / 10,
    z: Math.round(pr.z * 10) / 10,
    dirX: Math.round(pr.dirX * 1000) / 1000,
    dirZ: Math.round(pr.dirZ * 1000) / 1000,
    speed: pr.speed,
    radius: pr.radius
  }));

  const groundZones: GroundZoneSnapshot[] = room.groundZones.map((zn) => ({
    id: zn.id,
    ownerSlot: zn.ownerSlot,
    championId: zn.championId,
    x: Math.round(zn.x * 10) / 10,
    z: Math.round(zn.z * 10) / 10,
    radius: zn.radius,
    remaining: Math.round(zn.remaining * 100) / 100,
    duration: zn.duration
  }));

  return {
    type: 'state_snapshot',
    state: room.state,
    round: room.round,
    countdownTimer: Math.max(0, room.countdownTimer || 0),
    players: [
      serializePlayerSnapshot(room.players[0]),
      serializePlayerSnapshot(room.players[1])
    ],
    projectiles,
    groundZones,
    events: room.events
  };
}
