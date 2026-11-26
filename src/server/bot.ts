import { getChampionConfig } from '../shared/champions/index.js';
import { INV_SQRT2 } from '../shared/constants.js';
import { castPrimaryAbility, clampToBaronPitHalf, useSummonerSpell } from './actions.js';
import type { GameRoom, ServerPlayerState, ServerProjectile } from './types.js';

export function updateBotAI(
  room: GameRoom,
  bot: ServerPlayerState,
  opponent: ServerPlayerState | null,
  dt: number
): void {
  if (!bot.alive || !opponent || !opponent.alive || !bot.aiState) return;
  const ai = bot.aiState;
  ai.moveCooldown -= dt;
  ai.qThinkCooldown -= dt;

  const botChamp = getChampionConfig(bot.championId);
  const oppChamp = getChampionConfig(opponent.championId);

  // 1. Check incoming projectiles -> dodge perpendicular
  let dangerProj: ServerProjectile | null = null;
  for (const proj of room.projectiles) {
    if (proj.ownerSlot !== bot.slot) {
      const toBotX = bot.x - proj.x;
      const toBotZ = bot.z - proj.z;
      const forwardDot = toBotX * proj.dirX + toBotZ * proj.dirZ;
      if (forwardDot > -40 && forwardDot < 700) {
        const perpDist = Math.abs(toBotX * -proj.dirZ + toBotZ * proj.dirX);
        if (perpDist < botChamp.stats.hitboxRadius + proj.radius + 85) {
          dangerProj = proj;
          break;
        }
      }
    }
  }

  // 2. Check delayed ground AoE zones under the bot -> move radially out
  const dangerZone = room.groundZones.find((zone) => {
    if (zone.ownerSlot === bot.slot) return false;
    const dx = bot.x - zone.x;
    const dz = bot.z - zone.z;
    const dangerRadius = botChamp.stats.hitboxRadius + zone.radius + 60;
    return dx * dx + dz * dz < dangerRadius * dangerRadius;
  });

  if (dangerProj && bot.knockupTimer <= 0) {
    const perpX = -dangerProj.dirZ;
    const perpZ = dangerProj.dirX;
    const side = (bot.x - dangerProj.x) * perpX + (bot.z - dangerProj.z) * perpZ >= 0 ? 1 : -1;
    const dodgeX = bot.x + perpX * side * 260;
    const dodgeZ = bot.z + perpZ * side * 260;
    const clamped = clampToBaronPitHalf(dodgeX, dodgeZ, bot.slot, botChamp.stats.hitboxRadius);
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;

    const projDx = bot.x - dangerProj.x;
    const projDz = bot.z - dangerProj.z;
    const distSqToProj = projDx * projDx + projDz * projDz;
    const flashIdx = bot.spells.indexOf('flash');
    if (flashIdx !== -1 && bot.spellCd[flashIdx] <= 0 && distSqToProj < 260 * 260 && bot.hp < 650) {
      useSummonerSpell(room, bot, flashIdx, clamped.x, clamped.z);
    }
  } else if (dangerZone && bot.knockupTimer <= 0) {
    const dx = bot.x - dangerZone.x;
    const dz = bot.z - dangerZone.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const escapeDirX = len > 1e-3 ? dx / len : bot.slot === 0 ? -INV_SQRT2 : INV_SQRT2;
    const escapeDirZ = len > 1e-3 ? dz / len : bot.slot === 0 ? -INV_SQRT2 : INV_SQRT2;
    const escapeDist = dangerZone.radius + botChamp.stats.hitboxRadius + 110;
    const clamped = clampToBaronPitHalf(
      dangerZone.x + escapeDirX * escapeDist,
      dangerZone.z + escapeDirZ * escapeDist,
      bot.slot,
      botChamp.stats.hitboxRadius
    );
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;

    const flashIdx = bot.spells.indexOf('flash');
    if (flashIdx !== -1 && bot.spellCd[flashIdx] <= 0 && dangerZone.remaining < 0.25 && bot.hp < 700) {
      useSummonerSpell(room, bot, flashIdx, clamped.x, clamped.z);
    }
  } else if (ai.moveCooldown <= 0 && bot.knockupTimer <= 0) {
    ai.moveCooldown = 0.38 + Math.random() * 0.45;
    if (Math.random() < 0.45) ai.strafeSign *= -1;
    const alongPit = (Math.random() - 0.5) * 750;
    const distFromLine = 170 + Math.random() * 290;
    const sign = bot.slot === 0 ? -1 : 1;
    const desiredX = sign * distFromLine * INV_SQRT2 - alongPit * INV_SQRT2;
    const desiredZ = sign * distFromLine * INV_SQRT2 + alongPit * INV_SQRT2;
    const clamped = clampToBaronPitHalf(desiredX, desiredZ, bot.slot, botChamp.stats.hitboxRadius);
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;
  }

  const healIdx = bot.spells.indexOf('heal');
  if (healIdx !== -1 && bot.spellCd[healIdx] <= 0 && bot.hp < bot.maxHp * 0.42) {
    useSummonerSpell(room, bot, healIdx, bot.x, bot.z);
  }

  const ghostIdx = bot.spells.indexOf('ghost');
  if (ghostIdx !== -1 && bot.spellCd[ghostIdx] <= 0 && Math.random() < 0.008) {
    useSummonerSpell(room, bot, ghostIdx, bot.x, bot.z);
  }

  if (bot.qCd <= 0 && bot.castTimer <= 0 && bot.knockupTimer <= 0 && ai.qThinkCooldown <= 0) {
    const q = botChamp.q;
    const dxOpp = opponent.x - bot.x;
    const dzOpp = opponent.z - bot.z;
    const distSq = dxOpp * dxOpp + dzOpp * dzOpp;
    const maxCastRange = q.range - 35;
    if (distSq <= maxCastRange * maxCastRange) {
      const dist = Math.sqrt(distSq);
      const oppDx = opponent.targetX - opponent.x;
      const oppDz = opponent.targetZ - opponent.z;
      const oppMoveDistSq = oppDx * oppDx + oppDz * oppDz;
      const oppMoveDist = oppMoveDistSq > 225 ? Math.sqrt(oppMoveDistSq) : 0;

      let aimX = opponent.x;
      let aimZ = opponent.z;

      if (q.archetype === 'linear_projectile') {
        const travelTime = dist / q.speed;
        if (oppMoveDist > 15) {
          const leadFactor = 0.65 + Math.random() * 0.35;
          aimX += (oppDx / oppMoveDist) * oppChamp.stats.baseMoveSpeed * travelTime * leadFactor;
          aimZ += (oppDz / oppMoveDist) * oppChamp.stats.baseMoveSpeed * travelTime * leadFactor;
        }
        aimX += (Math.random() - 0.5) * 55;
        aimZ += (Math.random() - 0.5) * 55;
      } else {
        const leadTime = q.castTime + q.delay;
        if (oppMoveDist > 15) {
          const leadFactor = 0.6 + Math.random() * 0.3;
          const leadDist = Math.min(oppMoveDist, oppChamp.stats.baseMoveSpeed * leadTime * leadFactor);
          aimX += (oppDx / oppMoveDist) * leadDist;
          aimZ += (oppDz / oppMoveDist) * leadDist;
        }
        aimX += (Math.random() - 0.5) * 40;
        aimZ += (Math.random() - 0.5) * 40;
      }

      castPrimaryAbility(room, bot, aimX, aimZ);
      ai.qThinkCooldown = 0.25 + Math.random() * 0.35;
    }
  }
}
