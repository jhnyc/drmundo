import { LOL_SCALE } from '../constants.js';
import type { ChampionConfig } from './types.js';

export const DR_MUNDO_CONFIG: ChampionConfig = {
  id: 'drmundo',
  name: 'Dr. Mundo',
  title: 'The Madman of Zaun',
  defaultPlayerName: 'Dr. Mundo',
  defaultBotName: 'Corporate Mundo (Bot)',
  roleTag: 'Cleaver Dodgeball',
  accentColor: '#3bd16f',
  accentHex: 0x3bd16f,
  victoryLine: 'Dr. Mundo goes where he pleases!',
  fightBannerSub: 'DODGE & THROW INFECTED BONESAWS',
  stats: {
    maxHp: 1850,
    hpRegenPerSec: 16,
    baseMoveSpeed: 385,
    hitboxRadius: 65
  },
  hud: {
    level: 9,
    displayStats: {
      ad: 118,
      armor: 76,
      mr: 58
    },
    resource: {
      type: 'hp',
      barColor: '#2ecc71',
      label: 'Health'
    },
    accuracyLabel: 'Cleaver Acc',
    hitsStatLabel: 'Cleaver Hits',
    icons: {
      circle: '/assets/icons/drmundo_circle.png',
      square: '/assets/icons/drmundo_square.png',
      passive: '/assets/icons/drmundo_p.png',
      q: '/assets/icons/drmundo_q.png',
      w: '/assets/icons/drmundo_w.png',
      e: '/assets/icons/drmundo_e.png',
      r: '/assets/icons/drmundo_r.png'
    },
    passive: {
      name: 'Goes Where He Pleases',
      description: 'Regenerates 16 HP per second passively.'
    },
    disabledAbilities: {
      w: { name: 'Heart Zapper', description: 'Disabled in Baron Pit 1v1' },
      e: { name: 'Blunt Force Trauma', description: 'Disabled in Baron Pit 1v1' },
      r: { name: 'Maximum Dosage', description: 'Disabled in Baron Pit 1v1' }
    }
  },
  model: {
    kind: 'glb',
    url: '/assets/models/drmundo.glb',
    scale: LOL_SCALE,
    pelvisBones: ['Pelvis', 'Root'],
    pelvisRootMotionFactor: 0.85,
    clips: {
      idle: { clipName: 'DrMundo_Idle01.anm', loop: 'repeat', timeScale: 1.0 },
      run: { clipName: 'DrMundo_Run.anm', loop: 'repeat', timeScale: 1.12 },
      run_haste: { clipName: 'DrMundo_Run.anm', loop: 'repeat', timeScale: 1.38 },
      q_cast: {
        clipName: 'Spell1_0.anm',
        fallbackClipName: 'Spell1',
        loop: 'once',
        clampWhenFinished: true,
        timeScale: 1.65
      },
      death: { clipName: 'Death', loop: 'once', clampWhenFinished: true, timeScale: 1.0 },
      taunt: { clipName: 'Taunt', loop: 'repeat', timeScale: 1.0 },
      joke: { clipName: 'Joke', loop: 'repeat', timeScale: 1.0 },
      dance: { clipName: 'Dance_Loop', loop: 'repeat', timeScale: 1.0 },
      laugh: { clipName: 'Laugh', loop: 'repeat', timeScale: 1.0 },
      recall: { clipName: 'Recall', loop: 'repeat', timeScale: 1.0 }
    },
    castMeshHide: {
      materialName: 'Weapon',
      materialHash: 1865621569,
      totalDuration: 0.55,
      visibleBeforeRemaining: 0.35,
      lockAnimUntilRemaining: 0.1
    }
  },
  q: {
    archetype: 'linear_projectile',
    name: 'Infected Bonesaw',
    description: 'Hurls an infected bonesaw in a line, dealing % current HP magic damage, slowing, and refunding 50 HP on hit.',
    costLabel: '50 HP',
    hpCost: 50,
    refundOnHit: 50,
    cooldown: 4.0,
    castTime: 0.22,
    range: 1050,
    speed: 2000,
    radius: 60,
    spawnOffset: 55,
    damage: {
      flatMin: 215,
      percentCurrentHp: 0.22
    },
    slow: {
      percent: 0.4,
      duration: 2.0
    },
    indicator: {
      shape: 'line',
      width: 120,
      range: 1050,
      colorHex: 0x0ac8b9
    },
    projectileVisual: {
      kind: 'obj_model',
      objUrl: '/assets/models/Weapon.obj',
      textureUrl: '/assets/models/drmundo_base_weapon_tx_cm.png',
      scale: 1.45,
      spinAxis: 'x',
      spinSpeed: 24,
      emissiveHex: 0x1b4d2e,
      emissiveIntensity: 0.35,
      ringRadiusInner: 42,
      ringRadiusOuter: 56
    },
    vfx: {
      hitColorHex: 0xd67eff,
      missColorHex: 0x95a5a6
    }
  },
  audio: {
    chooseVo: ['/assets/audio/drmundo_choose_vo.ogg'],
    tauntVo: ['/assets/audio/drmundo_ban_vo.ogg'],
    qCastSfx: ['/assets/audio/mundo_q_throw_sfx.ogg?v=2'],
    qCastSfxVolume: 1.15,
    qCastVo: ['/assets/audio/mundo_q_vo_0.ogg', '/assets/audio/mundo_q_vo_1.ogg'],
    qCastVoChance: 0.45,
    qHitSfx: ['/assets/audio/mundo_q_hit_sfx.ogg?v=2'],
    qHitSfxVolume: 1.45,
    synthProfile: 'mundo'
  }
};
