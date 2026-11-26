use std::f64::consts::{FRAC_1_SQRT_2, PI};

use crate::config::GameplayConfig;
use crate::model::{BotAIState, GameRoom, PendingCast, ServerPlayerState};
use crate::protocol::{GameEvent, PlayerMatchStats};

pub const INV_SQRT2: f64 = FRAC_1_SQRT_2;

pub fn get_spawn_transform(slot: usize) -> (f64, f64, f64) {
    if slot == 0 {
        (-300.0, -300.0, PI * 0.25)
    } else {
        (300.0, 300.0, -PI * 0.75)
    }
}

pub fn clamp_to_baron_pit_half(
    cfg: &GameplayConfig,
    mut x: f64,
    mut z: f64,
    slot: usize,
    hitbox_radius: f64,
) -> (f64, f64) {
    let mut signed_dist = (x + z) * INV_SQRT2;
    if slot == 0 && signed_dist > -cfg.line_buffer {
        let correction = signed_dist - -cfg.line_buffer;
        x -= correction * INV_SQRT2;
        z -= correction * INV_SQRT2;
    } else if slot == 1 && signed_dist < cfg.line_buffer {
        let correction = cfg.line_buffer - signed_dist;
        x += correction * INV_SQRT2;
        z += correction * INV_SQRT2;
    }

    let dist_sq = x * x + z * z;
    let max_r = cfg.pit_radius - hitbox_radius;
    if dist_sq > max_r * max_r {
        let dist = dist_sq.sqrt();
        x = (x / dist) * max_r;
        z = (z / dist) * max_r;
        signed_dist = (x + z) * INV_SQRT2;
        if slot == 0 && signed_dist > -cfg.line_buffer {
            let correction = signed_dist - -cfg.line_buffer;
            x -= correction * INV_SQRT2;
            z -= correction * INV_SQRT2;
        } else if slot == 1 && signed_dist < cfg.line_buffer {
            let correction = cfg.line_buffer - signed_dist;
            x += correction * INV_SQRT2;
            z += correction * INV_SQRT2;
        }
    }

    (x, z)
}

pub fn clamp_to_baron_pit(x: f64, z: f64, max_radius: f64) -> (f64, f64) {
    let dist_sq = x * x + z * z;
    if dist_sq <= max_radius * max_radius {
        return (x, z);
    }
    let dist = dist_sq.sqrt();
    ((x / dist) * max_radius, (z / dist) * max_radius)
}

pub fn create_player_state(
    cfg: &GameplayConfig,
    slot: usize,
    name: String,
    spells: [String; 2],
    is_bot: bool,
    champion_id: &str,
) -> ServerPlayerState {
    let champ = cfg.get_champion(champion_id);
    let (sx, sz, angle) = get_spawn_transform(slot);
    let resolved_name = if name.is_empty() {
        if is_bot {
            champ.default_bot_name.clone()
        } else if slot == 0 {
            format!("Blue {}", champ.name)
        } else {
            format!("Red {}", champ.name)
        }
    } else {
        name
    };

    ServerPlayerState {
        slot,
        name: resolved_name,
        champion_id: champ.id.clone(),
        is_bot,
        ready: is_bot,
        spells,
        score: 0,
        x: sx,
        z: sz,
        target_x: sx,
        target_z: sz,
        angle,
        hp: champ.stats.max_hp,
        max_hp: champ.stats.max_hp,
        alive: true,
        anim: "idle".to_string(),
        emote_anim: None,
        q_cd: 0.0,
        max_q_cd: champ.q.cooldown,
        spell_cd: [0.0, 0.0],
        max_spell_cd: [25.0, 30.0],
        cast_timer: 0.0,
        pending_cast: None,
        slow_timer: 0.0,
        slow_percent: 0.0,
        knockup_timer: 0.0,
        knockup_duration: 0.0,
        ghost_timer: 0.0,
        heal_speed_timer: 0.0,
        emote_timer: 0.0,
        stats: PlayerMatchStats::default(),
        ai_state: if is_bot {
            Some(BotAIState {
                move_cooldown: 0.0,
                strafe_sign: 1.0,
                q_think_cooldown: 0.6,
            })
        } else {
            None
        },
        awaiting_reconnect: false,
    }
}

pub fn set_player_champion(cfg: &GameplayConfig, player: &mut ServerPlayerState, champion_id: &str) {
    let prev_champ = cfg.get_champion(&player.champion_id);
    let next_champ = cfg.get_champion(champion_id);
    player.champion_id = next_champ.id.clone();
    player.hp = next_champ.stats.max_hp;
    player.max_hp = next_champ.stats.max_hp;
    player.max_q_cd = next_champ.q.cooldown;

    if player.is_bot {
        player.name = next_champ.default_bot_name.clone();
    } else if player.name == prev_champ.default_player_name || player.name == prev_champ.name {
        player.name = next_champ.default_player_name.clone();
    }
}

pub fn reset_round_state(cfg: &GameplayConfig, room: &mut GameRoom) {
    room.projectiles.clear();
    room.ground_zones.clear();
    room.events.clear();
    let fast_cd = room.settings.cooldown_mode != "standard";
    for i in 0..2 {
        let Some(p) = room.players[i].as_mut() else {
            continue;
        };
        let champ = cfg.get_champion(&p.champion_id);
        let (sx, sz, angle) = get_spawn_transform(i);
        p.x = sx;
        p.z = sz;
        p.target_x = sx;
        p.target_z = sz;
        p.angle = angle;
        p.hp = champ.stats.max_hp;
        p.max_hp = champ.stats.max_hp;
        p.alive = true;
        p.anim = "idle".to_string();
        p.q_cd = 0.0;
        p.max_q_cd = champ.q.cooldown;
        p.cast_timer = 0.0;
        p.pending_cast = None;
        p.slow_timer = 0.0;
        p.slow_percent = 0.0;
        p.knockup_timer = 0.0;
        p.knockup_duration = 0.0;
        p.ghost_timer = 0.0;
        p.heal_speed_timer = 0.0;
        p.emote_timer = 0.0;
        p.spell_cd = [0.0, 0.0];
        p.max_spell_cd = [
            cfg.get_spell_cooldown(&p.spells[0], fast_cd),
            cfg.get_spell_cooldown(&p.spells[1], fast_cd),
        ];
    }
}

pub fn cast_primary_ability(
    cfg: &GameplayConfig,
    player: &mut ServerPlayerState,
    events: &mut Vec<GameEvent>,
    raw_target_x: f64,
    raw_target_z: f64,
) {
    if !player.alive || player.q_cd > 0.0 || player.cast_timer > 0.0 || player.knockup_timer > 0.0 {
        return;
    }

    let champ = cfg.get_champion(&player.champion_id);
    let q = &champ.q;
    let dx = raw_target_x - player.x;
    let dz = raw_target_z - player.z;
    let len = (dx * dx + dz * dz).sqrt();
    let (dir_x, dir_z) = if len > 1e-3 {
        (dx / len, dz / len)
    } else {
        (player.angle.sin(), player.angle.cos())
    };

    let (target_x, target_z) = if q.archetype == "delayed_ground_aoe" {
        let clamped_dist = len.min(q.range);
        let desired_x = player.x + dir_x * clamped_dist;
        let desired_z = player.z + dir_z * clamped_dist;
        clamp_to_baron_pit(desired_x, desired_z, cfg.pit_radius - 15.0)
    } else {
        (raw_target_x, raw_target_z)
    };

    player.angle = dir_x.atan2(dir_z);
    player.q_cd = q.cooldown;
    player.cast_timer = q.cast_time;
    player.emote_timer = 0.0;
    player.anim = "q_cast".to_string();
    if q.hp_cost > 0.0 {
        player.hp = (player.hp - q.hp_cost).max(1.0);
    }
    player.stats.abilities_cast += 1;

    player.pending_cast = Some(PendingCast {
        target_x,
        target_z,
        dir_x,
        dir_z,
    });

    events.push(GameEvent::QWindup {
        slot: player.slot,
        champion_id: player.champion_id.clone(),
        x: player.x,
        z: player.z,
        target_x,
        target_z,
        dir_x,
        dir_z,
    });
}

pub fn use_summoner_spell(
    cfg: &GameplayConfig,
    cooldown_mode: &str,
    player: &mut ServerPlayerState,
    events: &mut Vec<GameEvent>,
    spell_index: usize,
    target_x: f64,
    target_z: f64,
) {
    if !player.alive || player.knockup_timer > 0.0 || spell_index > 1 || player.spell_cd[spell_index] > 0.0 {
        return;
    }

    let spell_id = player.spells[spell_index].clone();
    let Some(def) = cfg.summoner_spells.get(&spell_id) else {
        return;
    };

    let fast_cd = cooldown_mode != "standard";
    let cd = if fast_cd {
        def.cooldown_fast
    } else {
        def.cooldown_standard
    };
    player.spell_cd[spell_index] = cd;
    player.max_spell_cd[spell_index] = cd;

    match spell_id.as_str() {
        "flash" => {
            let champ = cfg.get_champion(&player.champion_id);
            let old_x = player.x;
            let old_z = player.z;
            let dx = target_x - player.x;
            let dz = target_z - player.z;
            let dist = (dx * dx + dz * dz).sqrt();
            let actual_dist = dist.min(def.range);
            let (dir_x, dir_z) = if dist > 1e-3 {
                (dx / dist, dz / dist)
            } else {
                (player.angle.sin(), player.angle.cos())
            };
            let (cx, cz) = clamp_to_baron_pit_half(
                cfg,
                player.x + dir_x * actual_dist,
                player.z + dir_z * actual_dist,
                player.slot,
                champ.stats.hitbox_radius,
            );
            player.x = cx;
            player.z = cz;
            player.target_x = cx;
            player.target_z = cz;
            player.angle = dir_x.atan2(dir_z);

            events.push(GameEvent::SpellFlash {
                slot: player.slot,
                from_x: old_x,
                from_z: old_z,
                to_x: player.x,
                to_z: player.z,
            });
        }
        "heal" => {
            let prev_hp = player.hp;
            player.hp = (player.hp + def.heal_amount).min(player.max_hp);
            let healed = (player.hp - prev_hp).round() as i64;
            let amount = if healed == 0 {
                def.heal_amount.round() as i64
            } else {
                healed
            };
            player.heal_speed_timer = def.duration;

            events.push(GameEvent::SpellHeal {
                slot: player.slot,
                x: player.x,
                z: player.z,
                amount,
            });
        }
        "ghost" => {
            player.ghost_timer = def.duration;
            events.push(GameEvent::SpellGhost {
                slot: player.slot,
                x: player.x,
                z: player.z,
                duration: def.duration,
            });
        }
        _ => {}
    }
}
