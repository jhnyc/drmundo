import { LOL_SCALE } from '../constants.js';
export const CHO_GATH_CONFIG = {
    id: 'chogath',
    name: "Cho'Gath",
    title: 'The Terror of the Void',
    defaultPlayerName: "Cho'Gath",
    defaultBotName: "Gentleman Cho'Gath (Bot)",
    roleTag: 'Void Rupture',
    accentColor: '#b84dff',
    accentHex: 0xb84dff,
    victoryLine: 'Nom nom nom! The Void devours the Baron Pit!',
    fightBannerSub: 'RUPTURE THE EARTH & DODGE INCOMING RUPTURES',
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
            circle: '/assets/icons/chogath_circle.png',
            square: '/assets/icons/chogath_square.png',
            passive: '/assets/icons/chogath_p.png',
            q: '/assets/icons/chogath_q.png',
            w: '/assets/icons/chogath_w.png',
            e: '/assets/icons/chogath_e.png',
            r: '/assets/icons/chogath_r.png'
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
    model: {
        kind: 'glb',
        url: '/assets/models/chogath.glb',
        scale: LOL_SCALE * 0.9,
        pelvisBones: ['pelvis', 'root'],
        pelvisRootMotionFactor: 0.85,
        castAnimDuration: 0.62,
        clips: {
            idle: { clipName: 'Idle1', fallbackClipName: 'Idle2', loop: 'repeat', timeScale: 1.0 },
            run: { clipName: 'Run', loop: 'repeat', timeScale: 1.08 },
            run_haste: { clipName: 'Run', loop: 'repeat', timeScale: 1.38 },
            q_cast: {
                clipName: 'Spell1',
                loop: 'once',
                clampWhenFinished: true,
                timeScale: 1.45
            },
            death: { clipName: 'Death', loop: 'once', clampWhenFinished: true, timeScale: 1.0 },
            taunt: { clipName: 'Taunt', loop: 'repeat', timeScale: 1.0 },
            joke: { clipName: 'Taunt', fallbackClipName: 'Idle2', loop: 'repeat', timeScale: 1.0 },
            dance: { clipName: 'Dance', loop: 'repeat', timeScale: 1.0 },
            laugh: { clipName: 'Laugh', loop: 'repeat', timeScale: 1.0 },
            recall: { clipName: 'Channel', fallbackClipName: 'Channel_Wndup', loop: 'repeat', timeScale: 1.0 }
        }
    },
    q: {
        archetype: 'delayed_ground_aoe',
        name: 'Rupture',
        description: 'Ruptures the ground at the target location after a 0.625s delay, launching enemies airborne for 0.85s and slowing them by 50%.',
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
            eruptColorHex: 0x9b3dff,
            spikeColorHex: 0xf2e9ff,
            meshUrl: '/assets/models/chogath_q_spikes.obj',
            meshTextureUrl: '/assets/vfx/chogath_q_spike_tx.png',
            meshBaseRadius: 116.5,
            crackTextureUrl: '/assets/vfx/chogath_q_crack.png',
            indicatorTextureUrl: '/assets/vfx/chogath_q_indicator.png',
            smokeTextureUrl: '/assets/vfx/chogath_q_smokeray.png',
            auraTextureUrl: '/assets/vfx/chogath_q_auraself.png',
            rockTextureUrl: '/assets/vfx/chogath_q_rockshards.png'
        },
        vfx: {
            hitColorHex: 0xc44dff,
            missColorHex: 0x6b4b8a
        }
    },
    audio: {
        chooseVo: ['/assets/audio/chogath_choose_vo.ogg'],
        tauntVo: ['/assets/audio/chogath_ban_vo.ogg'],
        qCastSfx: ['/assets/audio/chogath_q_cast_sfx.ogg'],
        qCastSfxVolume: 0.95,
        zoneSpawnSfx: ['/assets/audio/chogath_q_zone_0.ogg'],
        zoneEruptSfx: ['/assets/audio/chogath_q_erupt_0.ogg', '/assets/audio/chogath_q_erupt_1.ogg']
    }
};
