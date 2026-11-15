import { castInfectedBonesaw, clampToBaronPitHalf, useSummonerSpell } from './actions.js';
import { INV_SQRT2, MUNDO_STATS } from './constants.js';
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
    const perpX = -dangerProj.dirZ;
    const perpZ = dangerProj.dirX;
    const side = (bot.x - dangerProj.x) * perpX + (bot.z - dangerProj.z) * perpZ >= 0 ? 1 : -1;
    const dodgeX = bot.x + perpX * side * 260;
    const dodgeZ = bot.z + perpZ * side * 260;
    const clamped = clampToBaronPitHalf(dodgeX, dodgeZ, bot.slot);
    bot.targetX = clamped.x;
    bot.targetZ = clamped.z;

    const distToProj = Math.hypot(bot.x - dangerProj.x, bot.z - dangerProj.z);
    const flashIdx = bot.spells.indexOf('flash');
    if (flashIdx !== -1 && bot.spellCd[flashIdx] <= 0 && distToProj < 260 && bot.hp < 650) {
      useSummonerSpell(room, bot, flashIdx, clamped.x, clamped.z);
    }
  } else if (ai.moveCooldown <= 0) {
    ai.moveCooldown = 0.38 + Math.random() * 0.45;
    if (Math.random() < 0.45) ai.strafeSign *= -1;
    const alongPit = (Math.random() - 0.5) * 750;
    const distFromLine = 170 + Math.random() * 290;
    const sign = bot.slot === 0 ? -1 : 1;
    const desiredX = sign * distFromLine * INV_SQRT2 - alongPit * INV_SQRT2;
    const desiredZ = sign * distFromLine * INV_SQRT2 + alongPit * INV_SQRT2;
    const clamped = clampToBaronPitHalf(desiredX, desiredZ, bot.slot);
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
      aimX += (Math.random() - 0.5) * 55;
      aimZ += (Math.random() - 0.5) * 55;
      castInfectedBonesaw(room, bot, aimX, aimZ);
      ai.qThinkCooldown = 0.25 + Math.random() * 0.35;
    }
  }
}
