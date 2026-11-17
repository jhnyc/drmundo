import {
  DEFAULT_CHAMPION_ID,
  getChampionConfig,
  normalizeChampionId
} from '../shared/champions/index.js';
import {
  INV_SQRT2,
  LINE_BUFFER,
  PIT_RADIUS,
  SUMMONER_SPELLS,
  getSpellCooldown
} from '../shared/constants.js';
import type { ChampionId, SummonerSpellId } from '../shared/types.js';
import type { GameRoom, ServerPlayerState } from './types.js';

export function getSpawnTransform(slot: number): { x: number; z: number; angle: number } {
  // slot 0 = Blue Side (NW: x + z < 0), slot 1 = Red Side (SE: x + z > 0)
  if (slot === 0) {
    return { x: -300, z: -300, angle: Math.PI * 0.25 };
  }
  return { x: 300, z: 300, angle: -Math.PI * 0.75 };
}

export function clampToBaronPitHalf(
  x: number,
  z: number,
  slot: number,
  hitboxRadius = getChampionConfig(DEFAULT_CHAMPION_ID).stats.hitboxRadius
): { x: number; z: number } {
  let signedDist = (x + z) * INV_SQRT2;
  if (slot === 0 && signedDist > -LINE_BUFFER) {
    const correction = signedDist - -LINE_BUFFER;
    x -= correction * INV_SQRT2;
    z -= correction * INV_SQRT2;
  } else if (slot === 1 && signedDist < LINE_BUFFER) {
    const correction = LINE_BUFFER - signedDist;
    x += correction * INV_SQRT2;
    z += correction * INV_SQRT2;
  }

  const distSq = x * x + z * z;
  const maxR = PIT_RADIUS - hitboxRadius;
  if (distSq > maxR * maxR) {
    const dist = Math.sqrt(distSq);
    x = (x / dist) * maxR;
    z = (z / dist) * maxR;
    signedDist = (x + z) * INV_SQRT2;
    if (slot === 0 && signedDist > -LINE_BUFFER) {
      const correction = signedDist - -LINE_BUFFER;
      x -= correction * INV_SQRT2;
      z -= correction * INV_SQRT2;
    } else if (slot === 1 && signedDist < LINE_BUFFER) {
      const correction = LINE_BUFFER - signedDist;
      x += correction * INV_SQRT2;
      z += correction * INV_SQRT2;
    }
  }

  return { x, z };
}

export function clampToBaronPit(x: number, z: number, maxRadius = PIT_RADIUS): { x: number; z: number } {
  const distSq = x * x + z * z;
  if (distSq <= maxRadius * maxRadius) return { x, z };
  const dist = Math.sqrt(distSq);
  return {
    x: (x / dist) * maxRadius,
    z: (z / dist) * maxRadius
  };
}

export function createPlayerState(
  slot: number,
  name: string,
  spells: [SummonerSpellId, SummonerSpellId] = ['flash', 'ghost'],
  isBot = false,
  championId: ChampionId | string = DEFAULT_CHAMPION_ID
): ServerPlayerState {
  const champ = getChampionConfig(championId);
  const spawn = getSpawnTransform(slot);
  const resolvedName =
    name || (isBot ? champ.defaultBotName : slot === 0 ? `Blue ${champ.name}` : `Red ${champ.name}`);

  return {
    slot,
    name: resolvedName,
    championId: champ.id,
    isBot,
    ready: isBot,
    spells: [spells[0], spells[1]],
    score: 0,
    x: spawn.x,
    z: spawn.z,
    targetX: spawn.x,
    targetZ: spawn.z,
    angle: spawn.angle,
    hp: champ.stats.maxHp,
    maxHp: champ.stats.maxHp,
    alive: true,
    anim: 'idle',
    qCd: 0,
    maxQCd: champ.q.cooldown,
    spellCd: [0, 0],
    maxSpellCd: [25, 30],
    castTimer: 0,
    pendingCast: null,
    slowTimer: 0,
    slowPercent: 0,
    knockupTimer: 0,
    knockupDuration: 0,
    ghostTimer: 0,
    healSpeedTimer: 0,
    emoteTimer: 0,
    stats: {
      abilitiesCast: 0,
      abilitiesHit: 0,
      damageDealt: 0
    },
    aiState: isBot
      ? {
          moveCooldown: 0,
          strafeSign: 1,
          qThinkCooldown: 0.6
        }
      : null
  };
}

export function setPlayerChampion(player: ServerPlayerState, championId: string): void {
  const prevChamp = getChampionConfig(player.championId);
  const nextChamp = getChampionConfig(normalizeChampionId(championId));
  player.championId = nextChamp.id;
  player.hp = nextChamp.stats.maxHp;
  player.maxHp = nextChamp.stats.maxHp;
  player.maxQCd = nextChamp.q.cooldown;

  if (player.isBot) {
    player.name = nextChamp.defaultBotName;
  } else if (player.name === prevChamp.defaultPlayerName || player.name === prevChamp.name) {
    player.name = nextChamp.defaultPlayerName;
  }
}

export function resetRoundState(room: GameRoom): void {
  room.projectiles = [];
  room.groundZones = [];
  room.events = [];
  const fastCd = room.settings.cooldownMode !== 'standard';
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (!p) continue;
    const champ = getChampionConfig(p.championId);
    const spawn = getSpawnTransform(i);
    p.x = spawn.x;
    p.z = spawn.z;
    p.targetX = spawn.x;
    p.targetZ = spawn.z;
    p.angle = spawn.angle;
    p.hp = champ.stats.maxHp;
    p.maxHp = champ.stats.maxHp;
    p.alive = true;
    p.anim = 'idle';
    p.qCd = 0;
    p.maxQCd = champ.q.cooldown;
    p.castTimer = 0;
    p.pendingCast = null;
    p.slowTimer = 0;
    p.slowPercent = 0;
    p.knockupTimer = 0;
    p.knockupDuration = 0;
    p.ghostTimer = 0;
    p.healSpeedTimer = 0;
    p.emoteTimer = 0;
    p.spellCd = [0, 0];
    p.maxSpellCd = [
      getSpellCooldown(p.spells[0], fastCd),
      getSpellCooldown(p.spells[1], fastCd)
    ];
  }
}

export function castPrimaryAbility(
  room: GameRoom,
  player: ServerPlayerState,
  rawTargetX: number,
  rawTargetZ: number
): void {
  if (!player.alive || player.qCd > 0 || player.castTimer > 0 || player.knockupTimer > 0) return;

  const champ = getChampionConfig(player.championId);
  const q = champ.q;
  const dx = rawTargetX - player.x;
  const dz = rawTargetZ - player.z;
  const len = Math.hypot(dx, dz);
  const dirX = len > 1e-3 ? dx / len : Math.sin(player.angle);
  const dirZ = len > 1e-3 ? dz / len : Math.cos(player.angle);

  let targetX = rawTargetX;
  let targetZ = rawTargetZ;
  if (q.archetype === 'delayed_ground_aoe') {
    const clampedDist = Math.min(len, q.range);
    const desiredX = player.x + dirX * clampedDist;
    const desiredZ = player.z + dirZ * clampedDist;
    const inPit = clampToBaronPit(desiredX, desiredZ, PIT_RADIUS - 15);
    targetX = inPit.x;
    targetZ = inPit.z;
  }

  player.angle = Math.atan2(dirX, dirZ);
  player.qCd = q.cooldown;
  player.castTimer = q.castTime;
  player.emoteTimer = 0;
  player.anim = 'q_cast';
  if (q.hpCost > 0) {
    player.hp = Math.max(1, player.hp - q.hpCost);
  }
  player.stats.abilitiesCast += 1;

  player.pendingCast = { targetX, targetZ, dirX, dirZ };

  room.events.push({
    type: 'q_windup',
    slot: player.slot,
    championId: player.championId,
    x: player.x,
    z: player.z,
    targetX,
    targetZ,
    dirX,
    dirZ
  });
}

export function useSummonerSpell(
  room: GameRoom,
  player: ServerPlayerState,
  spellIndex: number,
  targetX: number,
  targetZ: number
): void {
  if (!player.alive || player.knockupTimer > 0) return;
  if (spellIndex !== 0 && spellIndex !== 1) return;
  if (player.spellCd[spellIndex] > 0) return;

  const spellId = player.spells[spellIndex];
  const def = SUMMONER_SPELLS[spellId];
  if (!def) return;

  const fastCd = room.settings.cooldownMode !== 'standard';
  const cd = fastCd ? def.cooldownFast : def.cooldownStandard;
  player.spellCd[spellIndex] = cd;
  player.maxSpellCd[spellIndex] = cd;

  if (spellId === 'flash') {
    const flashDef = SUMMONER_SPELLS.flash;
    const champ = getChampionConfig(player.championId);
    const oldX = player.x;
    const oldZ = player.z;
    const dx = targetX - player.x;
    const dz = targetZ - player.z;
    const dist = Math.hypot(dx, dz);
    const actualDist = Math.min(dist, flashDef.range);
    const dirX = dist > 1e-3 ? dx / dist : Math.sin(player.angle);
    const dirZ = dist > 1e-3 ? dz / dist : Math.cos(player.angle);

    const clamped = clampToBaronPitHalf(
      player.x + dirX * actualDist,
      player.z + dirZ * actualDist,
      player.slot,
      champ.stats.hitboxRadius
    );
    player.x = clamped.x;
    player.z = clamped.z;
    player.targetX = clamped.x;
    player.targetZ = clamped.z;
    player.angle = Math.atan2(dirX, dirZ);

    room.events.push({
      type: 'spell_flash',
      slot: player.slot,
      fromX: oldX,
      fromZ: oldZ,
      toX: player.x,
      toZ: player.z
    });
  } else if (spellId === 'heal') {
    const healDef = SUMMONER_SPELLS.heal;
    const prevHp = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + healDef.healAmount);
    const healed = Math.round(player.hp - prevHp);
    player.healSpeedTimer = healDef.duration;

    room.events.push({
      type: 'spell_heal',
      slot: player.slot,
      x: player.x,
      z: player.z,
      amount: healed || healDef.healAmount
    });
  } else if (spellId === 'ghost') {
    const ghostDef = SUMMONER_SPELLS.ghost;
    player.ghostTimer = ghostDef.duration;
    room.events.push({
      type: 'spell_ghost',
      slot: player.slot,
      x: player.x,
      z: player.z,
      duration: ghostDef.duration
    });
  }
}
