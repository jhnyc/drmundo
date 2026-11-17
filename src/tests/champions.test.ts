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

    const iconPaths = Object.values(champ.hud.icons);
    for (const iconUrl of iconPaths) {
      const diskPath = path.join(PROJECT_ROOT, 'public', iconUrl.replace(/^\//, ''));
      assert.ok(fs.existsSync(diskPath), `${champ.id}: missing icon asset ${iconUrl}`);
    }

    if (champ.model.kind === 'glb') {
      const modelDiskPath = path.join(PROJECT_ROOT, 'public', champ.model.url.replace(/^\//, ''));
      assert.ok(fs.existsSync(modelDiskPath), `${champ.id}: missing GLB ${champ.model.url}`);
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
        const cleanUrl = rawUrl.split('?')[0];
        const diskPath = path.join(PROJECT_ROOT, 'public', cleanUrl.replace(/^\//, ''));
        assert.ok(fs.existsSync(diskPath), `${champ.id}: missing audio asset ${rawUrl}`);
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
