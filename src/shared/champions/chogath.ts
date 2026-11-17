import type { ChampionConfig } from './types.js';

export const CHO_GATH_CONFIG: ChampionConfig = {
  id: 'chogath',
  name: "Cho'Gath",
  title: 'The Terror of the Void',
  defaultPlayerName: "Cho'Gath",
  defaultBotName: "Gentleman Cho'Gath (Bot)",
  roleTag: 'Void Rupture',
  accentColor: '#b84dff',
  accentHex: 0xb84dff,
  victoryLine: 'Nom nom nom! The Void devours the Baron Pit!',
  fightBannerSub: 'RUPTURE THE EARTH & DODGE INCOMING SKILLSHOTS',
  stats: {
    maxHp: 1920,
    hpRegenPerSec: 9,
    baseMoveSpeed: 375,
    hitboxRadius: 72
  },
  hud: {
    level: 9,
    displayStats: {
      ad: 112,
      armor: 82,
      mr: 62
    },
    resource: {
      type: 'mana',
      barColor: '#2980b9',
      label: 'Mana'
    },
    accuracyLabel: 'Rupture Acc',
    hitsStatLabel: 'Rupture Hits',
    icons: {
      circle: '/assets/icons/chogath_circle.svg',
      square: '/assets/icons/chogath_square.svg',
      passive: '/assets/icons/chogath_p.svg',
      q: '/assets/icons/chogath_q.svg',
      w: '/assets/icons/chogath_w.svg',
      e: '/assets/icons/chogath_e.svg',
      r: '/assets/icons/chogath_r.svg'
    },
    passive: {
      name: 'Carnivore',
      description: 'Void vitality grants 9 HP/s regeneration and high base health.'
    },
    disabledAbilities: {
      w: { name: 'Feral Scream', description: 'Disabled in Baron Pit 1v1' },
      e: { name: 'Vorpal Spikes', description: 'Disabled in Baron Pit 1v1' },
      r: { name: 'Feast', description: 'Disabled in Baron Pit 1v1' }
    }
  },
  // Replace with { kind: 'glb', url: '/assets/models/chogath.glb', ... } when a Cho'Gath GLB is added.
  model: {
    kind: 'procedural',
    preset: 'chogath_void_beast',
    scale: 1.05
  },
  q: {
    archetype: 'delayed_ground_aoe',
    name: 'Rupture',
    description:
      'Ruptures the ground at the target location after a brief delay, launching enemies airborne for 0.85s and slowing them by 50%.',
    costLabel: 'CD',
    hpCost: 0,
    refundOnHit: 0,
    cooldown: 4.8,
    castTime: 0.25,
    delay: 0.625,
    range: 950,
    radius: 175,
    damage: {
      flatMin: 310,
      percentCurrentHp: 0.08
    },
    knockupDuration: 0.85,
    slow: {
      percent: 0.5,
      duration: 1.5
    },
    indicator: {
      shape: 'circle',
      radius: 175,
      range: 950,
      colorHex: 0xc052ff
    },
    zoneVisual: {
      kind: 'void_rupture',
      telegraphColorHex: 0xff2a55,
      eruptColorHex: 0xc44dff,
      spikeColorHex: 0x380f54
    },
    vfx: {
      hitColorHex: 0xc44dff,
      missColorHex: 0x6b4b8a
    }
  },
  audio: {
    synthProfile: 'void_beast'
  }
};
