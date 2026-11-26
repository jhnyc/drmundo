import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAMPION_REGISTRY, DEFAULT_CHAMPION_ID } from '../dist/shared/champions/index.js';
import { LINE_BUFFER, PIT_RADIUS, SUMMONER_SPELLS, TICK_RATE } from '../dist/shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'shared', 'gameplay-config.json');

function buildGameplayConfig() {
  const summonerSpells = {};
  for (const [id, spell] of Object.entries(SUMMONER_SPELLS)) {
    summonerSpells[id] = {
      id: spell.id,
      cooldownFast: spell.cooldownFast,
      cooldownStandard: spell.cooldownStandard,
      ...(spell.range !== undefined ? { range: spell.range } : {}),
      ...(spell.healAmount !== undefined ? { healAmount: spell.healAmount } : {}),
      ...(spell.speedBoost !== undefined ? { speedBoost: spell.speedBoost } : {}),
      ...(spell.duration !== undefined ? { duration: spell.duration } : {})
    };
  }

  const champions = {};
  for (const [id, champ] of Object.entries(CHAMPION_REGISTRY)) {
    const q = champ.q;
    champions[id] = {
      id: champ.id,
      name: champ.name,
      defaultPlayerName: champ.defaultPlayerName,
      defaultBotName: champ.defaultBotName,
      stats: {
        maxHp: champ.stats.maxHp,
        hpRegenPerSec: champ.stats.hpRegenPerSec,
        baseMoveSpeed: champ.stats.baseMoveSpeed,
        hitboxRadius: champ.stats.hitboxRadius
      },
      q: {
        archetype: q.archetype,
        hpCost: q.hpCost,
        refundOnHit: q.refundOnHit,
        cooldown: q.cooldown,
        castTime: q.castTime,
        ...(q.archetype === 'delayed_ground_aoe' ? { delay: q.delay } : {}),
        range: q.range,
        ...(q.archetype === 'linear_projectile' ? { speed: q.speed } : {}),
        radius: q.radius,
        ...(q.archetype === 'linear_projectile' ? { spawnOffset: q.spawnOffset } : {}),
        damage: {
          flatMin: q.damage.flatMin,
          percentCurrentHp: q.damage.percentCurrentHp
        },
        ...(q.archetype === 'delayed_ground_aoe' ? { knockupDuration: q.knockupDuration } : {}),
        ...(q.slow
          ? {
              slow: {
                percent: q.slow.percent,
                duration: q.slow.duration
              }
            }
          : {})
      }
    };
  }

  return {
    tickRate: TICK_RATE,
    pitRadius: PIT_RADIUS,
    lineBuffer: LINE_BUFFER,
    defaultChampionId: DEFAULT_CHAMPION_ID,
    summonerSpells,
    champions
  };
}

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(buildGameplayConfig(), null, 2)}\n`, 'utf8');
