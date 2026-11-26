use crate::actions::{cast_primary_ability, clamp_to_baron_pit_half, use_summoner_spell, INV_SQRT2};
use crate::config::GameplayConfig;
use crate::model::{ServerGroundZone, ServerPlayerState, ServerProjectile};
use crate::protocol::GameEvent;

pub fn update_bot_ai(
    cfg: &GameplayConfig,
    cooldown_mode: &str,
    projectiles: &[ServerProjectile],
    ground_zones: &[ServerGroundZone],
    events: &mut Vec<GameEvent>,
    bot: &mut ServerPlayerState,
    opponent: &ServerPlayerState,
    dt: f64,
) {
    if !bot.alive || !opponent.alive {
        return;
    }
    let Some(ai) = bot.ai_state.as_mut() else {
        return;
    };

    ai.move_cooldown -= dt;
    ai.q_think_cooldown -= dt;

    let bot_champ = cfg.get_champion(&bot.champion_id);
    let opp_champ = cfg.get_champion(&opponent.champion_id);

    // 1. Check incoming projectiles -> dodge perpendicular
    let mut danger_proj: Option<&ServerProjectile> = None;
    for proj in projectiles {
        if proj.owner_slot != bot.slot {
            let to_bot_x = bot.x - proj.x;
            let to_bot_z = bot.z - proj.z;
            let forward_dot = to_bot_x * proj.dir_x + to_bot_z * proj.dir_z;
            if forward_dot > -40.0 && forward_dot < 700.0 {
                let perp_dist = (to_bot_x * -proj.dir_z + to_bot_z * proj.dir_x).abs();
                if perp_dist < bot_champ.stats.hitbox_radius + proj.radius + 85.0 {
                    danger_proj = Some(proj);
                    break;
                }
            }
        }
    }

    // 2. Check delayed ground AoE zones under the bot -> move radially out
    let mut danger_zone: Option<&ServerGroundZone> = None;
    for zone in ground_zones {
        if zone.owner_slot == bot.slot {
            continue;
        }
        let dx = bot.x - zone.x;
        let dz = bot.z - zone.z;
        let danger_r = bot_champ.stats.hitbox_radius + zone.radius + 60.0;
        if dx * dx + dz * dz < danger_r * danger_r {
            danger_zone = Some(zone);
            break;
        }
    }

    let find_spell = |spells: &[String; 2], id: &str| -> Option<usize> {
        if spells[0] == id {
            Some(0)
        } else if spells[1] == id {
            Some(1)
        } else {
            None
        }
    };

    if let Some(proj) = danger_proj.filter(|_| bot.knockup_timer <= 0.0) {
        let perp_x = -proj.dir_z;
        let perp_z = proj.dir_x;
        let side = if (bot.x - proj.x) * perp_x + (bot.z - proj.z) * perp_z >= 0.0 {
            1.0
        } else {
            -1.0
        };
        let dodge_x = bot.x + perp_x * side * 260.0;
        let dodge_z = bot.z + perp_z * side * 260.0;
        let (cx, cz) = clamp_to_baron_pit_half(cfg, dodge_x, dodge_z, bot.slot, bot_champ.stats.hitbox_radius);
        bot.target_x = cx;
        bot.target_z = cz;

        let proj_dx = bot.x - proj.x;
        let proj_dz = bot.z - proj.z;
        if let Some(flash_idx) = find_spell(&bot.spells, "flash") {
            if bot.spell_cd[flash_idx] <= 0.0
                && proj_dx * proj_dx + proj_dz * proj_dz < 260.0 * 260.0
                && bot.hp < 650.0
            {
                use_summoner_spell(cfg, cooldown_mode, bot, events, flash_idx, cx, cz);
            }
        }
    } else if let Some(zone) = danger_zone.filter(|_| bot.knockup_timer <= 0.0) {
        let dx = bot.x - zone.x;
        let dz = bot.z - zone.z;
        let len = (dx * dx + dz * dz).sqrt();
        let (escape_dir_x, escape_dir_z) = if len > 1e-3 {
            (dx / len, dz / len)
        } else if bot.slot == 0 {
            (-INV_SQRT2, -INV_SQRT2)
        } else {
            (INV_SQRT2, INV_SQRT2)
        };
        let escape_dist = zone.radius + bot_champ.stats.hitbox_radius + 110.0;
        let (cx, cz) = clamp_to_baron_pit_half(
            cfg,
            zone.x + escape_dir_x * escape_dist,
            zone.z + escape_dir_z * escape_dist,
            bot.slot,
            bot_champ.stats.hitbox_radius,
        );
        bot.target_x = cx;
        bot.target_z = cz;

        if let Some(flash_idx) = find_spell(&bot.spells, "flash") {
            if bot.spell_cd[flash_idx] <= 0.0 && zone.remaining < 0.25 && bot.hp < 700.0 {
                use_summoner_spell(cfg, cooldown_mode, bot, events, flash_idx, cx, cz);
            }
        }
    } else if ai.move_cooldown <= 0.0 && bot.knockup_timer <= 0.0 {
        ai.move_cooldown = 0.38 + fastrand::f64() * 0.45;
        if fastrand::f64() < 0.45 {
            ai.strafe_sign *= -1.0;
        }
        let along_pit = (fastrand::f64() - 0.5) * 750.0;
        let dist_from_line = 170.0 + fastrand::f64() * 290.0;
        let sign = if bot.slot == 0 { -1.0 } else { 1.0 };
        let desired_x = sign * dist_from_line * INV_SQRT2 - along_pit * INV_SQRT2;
        let desired_z = sign * dist_from_line * INV_SQRT2 + along_pit * INV_SQRT2;
        let (cx, cz) = clamp_to_baron_pit_half(cfg, desired_x, desired_z, bot.slot, bot_champ.stats.hitbox_radius);
        bot.target_x = cx;
        bot.target_z = cz;
    }

    if let Some(heal_idx) = find_spell(&bot.spells, "heal") {
        if bot.spell_cd[heal_idx] <= 0.0 && bot.hp < bot.max_hp * 0.42 {
            let (bx, bz) = (bot.x, bot.z);
            use_summoner_spell(cfg, cooldown_mode, bot, events, heal_idx, bx, bz);
        }
    }

    if let Some(ghost_idx) = find_spell(&bot.spells, "ghost") {
        if bot.spell_cd[ghost_idx] <= 0.0 && fastrand::f64() < 0.008 {
            let (bx, bz) = (bot.x, bot.z);
            use_summoner_spell(cfg, cooldown_mode, bot, events, ghost_idx, bx, bz);
        }
    }

    let q_think_cd = bot.ai_state.as_ref().map(|s| s.q_think_cooldown).unwrap_or(1.0);
    if bot.q_cd <= 0.0 && bot.cast_timer <= 0.0 && bot.knockup_timer <= 0.0 && q_think_cd <= 0.0 {
        let q = &bot_champ.q;
        let dx_opp = opponent.x - bot.x;
        let dz_opp = opponent.z - bot.z;
        let dist_sq = dx_opp * dx_opp + dz_opp * dz_opp;
        let max_cast_range = q.range - 35.0;
        if dist_sq <= max_cast_range * max_cast_range {
            let dist = dist_sq.sqrt();
            let opp_dx = opponent.target_x - opponent.x;
            let opp_dz = opponent.target_z - opponent.z;
            let opp_move_dist_sq = opp_dx * opp_dx + opp_dz * opp_dz;

            let mut aim_x = opponent.x;
            let mut aim_z = opponent.z;

            if q.archetype == "linear_projectile" {
                let travel_time = dist / q.speed;
                if opp_move_dist_sq > 225.0 {
                    let opp_move_dist = opp_move_dist_sq.sqrt();
                    let lead_factor = 0.65 + fastrand::f64() * 0.35;
                    aim_x += (opp_dx / opp_move_dist) * opp_champ.stats.base_move_speed * travel_time * lead_factor;
                    aim_z += (opp_dz / opp_move_dist) * opp_champ.stats.base_move_speed * travel_time * lead_factor;
                }
                aim_x += (fastrand::f64() - 0.5) * 55.0;
                aim_z += (fastrand::f64() - 0.5) * 55.0;
            } else {
                let lead_time = q.cast_time + q.delay;
                if opp_move_dist_sq > 225.0 {
                    let opp_move_dist = opp_move_dist_sq.sqrt();
                    let lead_factor = 0.6 + fastrand::f64() * 0.3;
                    let lead_dist = opp_move_dist.min(opp_champ.stats.base_move_speed * lead_time * lead_factor);
                    aim_x += (opp_dx / opp_move_dist) * lead_dist;
                    aim_z += (opp_dz / opp_move_dist) * lead_dist;
                }
                aim_x += (fastrand::f64() - 0.5) * 40.0;
                aim_z += (fastrand::f64() - 0.5) * 40.0;
            }

            cast_primary_ability(cfg, bot, events, aim_x, aim_z);
            if let Some(ai_mut) = bot.ai_state.as_mut() {
                ai_mut.q_think_cooldown = 0.25 + fastrand::f64() * 0.35;
            }
        }
    }
}
