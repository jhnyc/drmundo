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
  SUMMONER_SPELLS,
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
