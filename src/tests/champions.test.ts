import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CHAMPION_LIST,
  CHAMPION_REGISTRY,
  DEFAULT_CHAMPION_ID,
  getChampionConfig,
  isValidChampionId,
  normalizeChampionId
} from '../shared/champions/index.js';
import {
  LINE_BUFFER,
  PIT_RADIUS,
  SUMMONER_SPELLS,
  TICK_RATE,
  getSpellCooldown,
  parseBestOf,
  validateSpells
} from '../shared/constants.js';

const PROJECT_ROOT = path.resolve(process.cwd());

function assertPublicAssetExists(url: string | undefined, label: string): void {
  if (!url) return;
  const cleanUrl = url.split('?')[0];
  const diskPath = path.join(PROJECT_ROOT, 'public', cleanUrl.replace(/^\//, ''));
  assert.ok(fs.existsSync(diskPath), `missing asset (${label}): ${url}`);
}

test('champion registry validates defaults and lookups', () => {
  assert.equal(DEFAULT_CHAMPION_ID, 'drmundo');
  assert.ok(CHAMPION_LIST.length >= 2);
  assert.equal(isValidChampionId('drmundo'), true);
  assert.equal(isValidChampionId('chogath'), true);
  assert.equal(isValidChampionId('nonexistent'), false);
  assert.equal(normalizeChampionId('  DrMundo  '), 'drmundo');
  assert.equal(normalizeChampionId('CHOGATH'), 'chogath');
  assert.equal(normalizeChampionId('unknown'), DEFAULT_CHAMPION_ID);
  assert.equal(getChampionConfig('drmundo'), CHAMPION_REGISTRY.drmundo);
  assert.equal(getChampionConfig('chogath'), CHAMPION_REGISTRY.chogath);
});

test('every registered champion has valid stats, abilities, and existing asset files', () => {
  for (const champ of CHAMPION_LIST) {
    assert.ok(champ.stats.maxHp > 0, `${champ.id}: maxHp must be > 0`);
    assert.ok(champ.stats.baseMoveSpeed > 0, `${champ.id}: baseMoveSpeed must be > 0`);
    assert.ok(champ.stats.hitboxRadius > 0, `${champ.id}: hitboxRadius must be > 0`);
    assert.ok(champ.q.cooldown > 0, `${champ.id}: q.cooldown must be > 0`);
    assert.ok(champ.q.range > 0, `${champ.id}: q.range must be > 0`);
    assert.ok(champ.q.radius > 0, `${champ.id}: q.radius must be > 0`);

    for (const [slot, iconUrl] of Object.entries(champ.hud.icons)) {
      assertPublicAssetExists(iconUrl, `${champ.id}.hud.icons.${slot}`);
    }

    assertPublicAssetExists(champ.model.url, `${champ.id}.model.url`);

    if (champ.q.archetype === 'linear_projectile' && champ.q.projectileVisual.kind === 'obj_model') {
      assertPublicAssetExists(champ.q.projectileVisual.objUrl, `${champ.id}.q.projectileVisual.objUrl`);
      assertPublicAssetExists(
        champ.q.projectileVisual.textureUrl,
        `${champ.id}.q.projectileVisual.textureUrl`
      );
    }

    if (champ.q.archetype === 'delayed_ground_aoe') {
      const zv = champ.q.zoneVisual;
      assertPublicAssetExists(zv.meshUrl, `${champ.id}.q.zoneVisual.meshUrl`);
      assertPublicAssetExists(zv.meshTextureUrl, `${champ.id}.q.zoneVisual.meshTextureUrl`);
      assertPublicAssetExists(zv.crackTextureUrl, `${champ.id}.q.zoneVisual.crackTextureUrl`);
      assertPublicAssetExists(zv.indicatorTextureUrl, `${champ.id}.q.zoneVisual.indicatorTextureUrl`);
      assertPublicAssetExists(zv.smokeTextureUrl, `${champ.id}.q.zoneVisual.smokeTextureUrl`);
      assertPublicAssetExists(zv.auraTextureUrl, `${champ.id}.q.zoneVisual.auraTextureUrl`);
      assertPublicAssetExists(zv.rockTextureUrl, `${champ.id}.q.zoneVisual.rockTextureUrl`);
    }

    const audioGroups = [
      champ.audio.chooseVo,
      champ.audio.tauntVo,
      champ.audio.qCastSfx,
      champ.audio.qCastVo,
      champ.audio.qHitSfx,
      champ.audio.qMissSfx,
      champ.audio.zoneSpawnSfx,
      champ.audio.zoneEruptSfx
    ];
    for (const urls of audioGroups) {
      if (!urls) continue;
      for (const rawUrl of urls) {
        assertPublicAssetExists(rawUrl, `${champ.id}.audio`);
      }
    }
  }
});

test('shared summoner spell & room helpers behave consistently', () => {
  assert.deepEqual(validateSpells(['heal', 'flash']), ['heal', 'flash']);
  assert.deepEqual(validateSpells(['flash', 'flash']), ['flash', 'heal']);
  assert.deepEqual(validateSpells(null), ['flash', 'ghost']);
  assert.equal(getSpellCooldown('flash', true), SUMMONER_SPELLS.flash.cooldownFast);
  assert.equal(getSpellCooldown('flash', false), SUMMONER_SPELLS.flash.cooldownStandard);
  assert.equal(parseBestOf(5), 5);
  assert.equal(parseBestOf(99), 3);
});

test('exported shared/gameplay-config.json matches TypeScript constants and champion registry', () => {
  const cfgPath = path.join(PROJECT_ROOT, 'shared', 'gameplay-config.json');
  assert.ok(fs.existsSync(cfgPath), 'shared/gameplay-config.json must exist after build');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  assert.equal(cfg.tickRate, TICK_RATE);
  assert.equal(cfg.pitRadius, PIT_RADIUS);
  assert.equal(cfg.lineBuffer, LINE_BUFFER);
  assert.equal(cfg.defaultChampionId, DEFAULT_CHAMPION_ID);

  for (const [id, spell] of Object.entries(SUMMONER_SPELLS)) {
    const exported = cfg.summonerSpells[id];
    assert.ok(exported, `missing summoner spell ${id}`);
    assert.equal(exported.id, spell.id);
    assert.equal(exported.cooldownFast, spell.cooldownFast);
    assert.equal(exported.cooldownStandard, spell.cooldownStandard);
    if ('range' in spell) assert.equal(exported.range, spell.range);
    if ('healAmount' in spell) assert.equal(exported.healAmount, spell.healAmount);
    if ('speedBoost' in spell) assert.equal(exported.speedBoost, spell.speedBoost);
    if ('duration' in spell) assert.equal(exported.duration, spell.duration);
  }

  for (const [id, champ] of Object.entries(CHAMPION_REGISTRY)) {
    const exported = cfg.champions[id];
    assert.ok(exported, `missing champion ${id}`);
    assert.equal(exported.id, champ.id);
    assert.equal(exported.name, champ.name);
    assert.equal(exported.defaultPlayerName, champ.defaultPlayerName);
    assert.equal(exported.defaultBotName, champ.defaultBotName);
    assert.deepEqual(exported.stats, champ.stats);
    assert.equal(exported.q.archetype, champ.q.archetype);
    assert.equal(exported.q.hpCost, champ.q.hpCost);
    assert.equal(exported.q.refundOnHit, champ.q.refundOnHit);
    assert.equal(exported.q.cooldown, champ.q.cooldown);
    assert.equal(exported.q.castTime, champ.q.castTime);
    assert.equal(exported.q.range, champ.q.range);
    assert.equal(exported.q.radius, champ.q.radius);
    assert.deepEqual(exported.q.damage, champ.q.damage);
    assert.deepEqual(exported.q.slow, champ.q.slow);
    if (champ.q.archetype === 'linear_projectile') {
      assert.equal(exported.q.speed, champ.q.speed);
      assert.equal(exported.q.spawnOffset, champ.q.spawnOffset);
    } else {
      assert.equal(exported.q.delay, champ.q.delay);
      assert.equal(exported.q.knockupDuration, champ.q.knockupDuration);
    }
  }
});
