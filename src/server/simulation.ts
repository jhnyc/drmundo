import type {
  PlayerSnapshot,
  ProjectileSnapshot,
  ServerToClientMessage
} from '../shared/types.js';
import { clampToBaronPitHalf } from './actions.js';
import { updateBotAI } from './bot.js';
import { MUNDO_STATS, PIT_RADIUS, SUMMONER_SPELLS } from './constants.js';
import type { GameRoom, ServerPlayerState } from './types.js';

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

  // Update players
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (!p || !p.alive) continue;

    if (p.isBot) {
      const opp = room.players[1 - i];
      updateBotAI(room, p, opp, dt);
    }

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
      continue;
    }

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

    const targetSlot = 1 - proj.ownerSlot;
    const target = room.players[targetSlot];
    const caster = room.players[proj.ownerSlot];

    if (target && target.alive) {
      const hitDist = Math.hypot(target.x - proj.x, target.z - proj.z);
      if (hitDist <= MUNDO_STATS.hitboxRadius + proj.radius) {
        const rawPctDmg = target.hp * MUNDO_STATS.qPercentCurrentHp;
        const dmg = Math.round(Math.max(MUNDO_STATS.qMinDamage, rawPctDmg));
        target.hp = Math.max(0, target.hp - dmg);
        target.slowTimer = MUNDO_STATS.qSlowDuration;

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
            onGameOver?.(room);
          } else {
            room.state = 'round_end';
            room.roundEndTimer = 3.5;
          }
        }
        continue;
      }
    }

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

export function serializePlayerSnapshot(p: ServerPlayerState | null): PlayerSnapshot | null {
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

export function buildStateSnapshot(room: GameRoom): ServerToClientMessage {
  const projectiles: ProjectileSnapshot[] = room.projectiles.map((pr) => ({
    id: pr.id,
    ownerSlot: pr.ownerSlot,
    x: Math.round(pr.x * 10) / 10,
    z: Math.round(pr.z * 10) / 10,
    dirX: Math.round(pr.dirX * 1000) / 1000,
    dirZ: Math.round(pr.dirZ * 1000) / 1000
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
    events: room.events
  };
}
