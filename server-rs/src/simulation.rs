use axum::extract::ws::Utf8Bytes;

use crate::actions::clamp_to_baron_pit_half;
use crate::bot::update_bot_ai;
use crate::config::GameplayConfig;
use crate::model::{GameRoom, ServerGroundZone, ServerPlayerState, ServerProjectile};
use crate::protocol::{
    GameEvent, GroundZoneSnapshotRef, PlayerSnapshotRef, ProjectileSnapshotRef, StateSnapshotRef,
};

#[inline]
fn round1(v: f64) -> f64 {
    let r = (v * 10.0).round() / 10.0;
    if r == 0.0 { 0.0 } else { r }
}

#[inline]
fn round2(v: f64) -> f64 {
    let r = (v * 100.0).round() / 100.0;
    if r == 0.0 { 0.0 } else { r }
}

#[inline]
fn round3(v: f64) -> f64 {
    let r = (v * 1000.0).round() / 1000.0;
    if r == 0.0 { 0.0 } else { r }
}

fn compute_ability_damage(target_hp: f64, flat_min: f64, pct_current_hp: f64) -> i64 {
    let raw_pct = target_hp * pct_current_hp;
    raw_pct.max(flat_min).round() as i64
}

fn release_pending_cast(cfg: &GameplayConfig, room: &mut GameRoom, slot: usize) {
    let Some(player) = room.players[slot].as_mut() else {
        return;
    };
    let Some(pc) = player.pending_cast.take() else {
        return;
    };

    let px = player.x;
    let pz = player.z;
    let p_slot = player.slot;
    let p_champ_id = player.champion_id.clone();

    let champ = cfg.get_champion(&p_champ_id);
    let q = &champ.q;
    let (slow_pct, slow_dur) = q.slow.as_ref().map(|s| (s.percent, s.duration)).unwrap_or((0.0, 0.0));

    if q.archetype == "linear_projectile" {
        room.next_proj_id += 1;
        let proj_id = room.next_proj_id;
        let spawn_x = px + pc.dir_x * q.spawn_offset;
        let spawn_z = pz + pc.dir_z * q.spawn_offset;
        room.projectiles.push(ServerProjectile {
            id: proj_id,
            owner_slot: p_slot,
            champion_id: p_champ_id.clone(),
            x: spawn_x,
            z: spawn_z,
            start_x: spawn_x,
            start_z: spawn_z,
            dir_x: pc.dir_x,
            dir_z: pc.dir_z,
            speed: q.speed,
            max_range: q.range,
            radius: q.radius,
            damage_flat_min: q.damage.flat_min,
            damage_percent_current_hp: q.damage.percent_current_hp,
            slow_percent: slow_pct,
            slow_duration: slow_dur,
            refund_on_hit: q.refund_on_hit,
        });
        room.events.push(GameEvent::QLaunch {
            slot: p_slot,
            champion_id: p_champ_id,
            proj_id,
            x: spawn_x,
            z: spawn_z,
            dir_x: pc.dir_x,
            dir_z: pc.dir_z,
        });
        return;
    }

    room.next_zone_id += 1;
    let zone_id = room.next_zone_id;
    room.ground_zones.push(ServerGroundZone {
        id: zone_id,
        owner_slot: p_slot,
        champion_id: p_champ_id.clone(),
        x: pc.target_x,
        z: pc.target_z,
        radius: q.radius,
        remaining: q.delay,
        duration: q.delay,
        damage_flat_min: q.damage.flat_min,
        damage_percent_current_hp: q.damage.percent_current_hp,
        knockup_duration: q.knockup_duration,
        slow_percent: slow_pct,
        slow_duration: slow_dur,
        refund_on_hit: q.refund_on_hit,
    });
    room.events.push(GameEvent::ZoneSpawn {
        zone_id,
        owner_slot: p_slot,
        champion_id: p_champ_id,
        x: pc.target_x,
        z: pc.target_z,
        radius: q.radius,
        duration: q.delay,
    });
}

struct HitParams {
    attacker_slot: usize,
    attacker_champion_id: String,
    victim_slot: usize,
    proj_id: Option<i64>,
    zone_id: Option<i64>,
    damage_flat_min: f64,
    damage_pct_hp: f64,
    slow_percent: f64,
    slow_duration: f64,
    knockup_duration: Option<f64>,
    refund_on_hit: f64,
}

fn apply_hit_and_check_round_end<F>(
    room: &mut GameRoom,
    params: HitParams,
    on_game_over: &mut F,
) where
    F: FnMut(&GameRoom),
{
    let dmg = {
        let Some(victim) = room.players[params.victim_slot].as_mut() else {
            return;
        };
        let d = compute_ability_damage(victim.hp, params.damage_flat_min, params.damage_pct_hp);
        victim.hp = (victim.hp - d as f64).max(0.0);

        if params.slow_duration > 0.0 && params.slow_percent > 0.0 {
            if victim.slow_timer <= 0.0 || params.slow_percent >= victim.slow_percent {
                victim.slow_percent = params.slow_percent;
            }
            victim.slow_timer = victim.slow_timer.max(params.slow_duration);
        }

        if let Some(ku) = params.knockup_duration {
            if ku > 0.0 {
                victim.knockup_timer = victim.knockup_timer.max(ku);
                victim.knockup_duration = victim.knockup_duration.max(ku);
                victim.target_x = victim.x;
                victim.target_z = victim.z;
                victim.emote_timer = 0.0;
            }
        }
        d
    };

    if let Some(caster) = room.players[params.attacker_slot].as_mut() {
        if caster.alive {
            if params.refund_on_hit > 0.0 {
                caster.hp = (caster.hp + params.refund_on_hit).min(caster.max_hp);
            }
            caster.stats.abilities_hit += 1;
            caster.stats.damage_dealt += dmg;
        }
    }

    let (vx, vz, victim_hp) = match room.players[params.victim_slot].as_ref() {
        Some(v) => (v.x, v.z, v.hp),
        None => return,
    };

    room.events.push(GameEvent::QHit {
        proj_id: params.proj_id,
        zone_id: params.zone_id,
        attacker_slot: params.attacker_slot,
        attacker_champion_id: params.attacker_champion_id,
        victim_slot: params.victim_slot,
        x: vx,
        z: vz,
        damage: dmg,
        refund: params.refund_on_hit.round() as i64,
        knockup_duration: params.knockup_duration,
    });

    if victim_hp <= 0.0 {
        if let Some(victim) = room.players[params.victim_slot].as_mut() {
            victim.alive = false;
            victim.anim = "death".to_string();
            victim.knockup_timer = 0.0;
            victim.knockup_duration = 0.0;
        }
        let mut caster_score = 0;
        if let Some(caster) = room.players[params.attacker_slot].as_mut() {
            caster.score += 1;
            caster_score = caster.score;
        }

        let best_of = if room.settings.best_of <= 0 { 3 } else { room.settings.best_of };
        let wins_needed = ((best_of as f64) / 2.0).ceil() as i32;
        let match_over = room.players[params.attacker_slot].is_some() && caster_score >= wins_needed;

        let s0 = room.players[0].as_ref().map(|p| p.score).unwrap_or(0);
        let s1 = room.players[1].as_ref().map(|p| p.score).unwrap_or(0);

        room.events.push(GameEvent::RoundKill {
            winner_slot: params.attacker_slot,
            loser_slot: params.victim_slot,
            round: room.round,
            scores: [s0, s1],
            match_over,
        });

        if match_over {
            room.state = "gameover".to_string();
            room.winner_slot = Some(params.attacker_slot);
            on_game_over(room);
        } else {
            room.state = "round_end".to_string();
            room.round_end_timer = 3.5;
        }
    }
}

fn step_players(cfg: &GameplayConfig, room: &mut GameRoom, dt: f64) {
    let ghost_boost = cfg.summoner_spells.get("ghost").map(|s| s.speed_boost).unwrap_or(0.38);
    let heal_boost = cfg.summoner_spells.get("heal").map(|s| s.speed_boost).unwrap_or(0.3);

    for i in 0..2 {
        let alive = room.players[i].as_ref().map(|p| p.alive).unwrap_or(false);
        if !alive {
            continue;
        }

        let is_bot = room.players[i].as_ref().map(|p| p.is_bot).unwrap_or(false);
        if is_bot {
            let [p0, p1] = &mut room.players;
            if i == 0 {
                if let (Some(bot), Some(opp)) = (p0.as_mut(), p1.as_ref()) {
                    update_bot_ai(
                        cfg,
                        &room.settings.cooldown_mode,
                        &room.projectiles,
                        &room.ground_zones,
                        &mut room.events,
                        bot,
                        opp,
                        dt,
                    );
                }
            } else if let (Some(opp), Some(bot)) = (p0.as_ref(), p1.as_mut()) {
                update_bot_ai(
                    cfg,
                    &room.settings.cooldown_mode,
                    &room.projectiles,
                    &room.ground_zones,
                    &mut room.events,
                    bot,
                    opp,
                    dt,
                );
            }
        }

        let mut should_release = false;
        {
            let Some(p) = room.players[i].as_mut() else {
                continue;
            };
            let champ = cfg.get_champion(&p.champion_id);

            if p.q_cd > 0.0 {
                p.q_cd = (p.q_cd - dt).max(0.0);
            }
            if p.spell_cd[0] > 0.0 {
                p.spell_cd[0] = (p.spell_cd[0] - dt).max(0.0);
            }
            if p.spell_cd[1] > 0.0 {
                p.spell_cd[1] = (p.spell_cd[1] - dt).max(0.0);
            }
            if p.slow_timer > 0.0 {
                p.slow_timer = (p.slow_timer - dt).max(0.0);
                if p.slow_timer == 0.0 {
                    p.slow_percent = 0.0;
                }
            }
            if p.knockup_timer > 0.0 {
                p.knockup_timer = (p.knockup_timer - dt).max(0.0);
                if p.knockup_timer == 0.0 {
                    p.knockup_duration = 0.0;
                }
            }
            if p.ghost_timer > 0.0 {
                p.ghost_timer = (p.ghost_timer - dt).max(0.0);
            }
            if p.heal_speed_timer > 0.0 {
                p.heal_speed_timer = (p.heal_speed_timer - dt).max(0.0);
            }
            if p.emote_timer > 0.0 {
                p.emote_timer = (p.emote_timer - dt).max(0.0);
            }

            p.hp = p.max_hp.min(p.hp + champ.stats.hp_regen_per_sec * dt);

            if p.cast_timer > 0.0 {
                p.cast_timer -= dt;
                if p.cast_timer <= 0.0 && p.pending_cast.is_some() {
                    should_release = true;
                } else {
                    continue;
                }
            } else if p.knockup_timer > 0.0 {
                p.anim = "idle".to_string();
                continue;
            } else {
                let dx = p.target_x - p.x;
                let dz = p.target_z - p.z;
                let dist_sq = dx * dx + dz * dz;
                if dist_sq > 16.0 {
                    let dist = dist_sq.sqrt();
                    let mut speed = champ.stats.base_move_speed;
                    if p.ghost_timer > 0.0 {
                        speed *= 1.0 + ghost_boost;
                    }
                    if p.heal_speed_timer > 0.0 {
                        speed *= 1.0 + heal_boost;
                    }
                    if p.slow_timer > 0.0 && p.slow_percent > 0.0 {
                        speed *= 1.0 - p.slow_percent;
                    }

                    let step = dist.min(speed * dt);
                    let nx = p.x + (dx / dist) * step;
                    let nz = p.z + (dz / dist) * step;
                    let (cx, cz) = clamp_to_baron_pit_half(cfg, nx, nz, p.slot, champ.stats.hitbox_radius);
                    p.x = cx;
                    p.z = cz;
                    p.angle = dx.atan2(dz);
                    p.anim = if p.ghost_timer > 0.0 {
                        "run_haste".to_string()
                    } else {
                        "run".to_string()
                    };
                    p.emote_timer = 0.0;
                } else if p.emote_timer > 0.0 {
                    p.anim = p.emote_anim.clone().unwrap_or_else(|| "taunt".to_string());
                } else {
                    p.anim = "idle".to_string();
                }
            }
        }

        if should_release {
            release_pending_cast(cfg, room, i);
        }
    }
}

fn step_projectiles<F>(cfg: &GameplayConfig, room: &mut GameRoom, dt: f64, on_game_over: &mut F)
where
    F: FnMut(&GameRoom),
{
    let max_edge = cfg.pit_radius + 65.0;
    let max_edge_sq = max_edge * max_edge;

    let mut i = room.projectiles.len();
    while i > 0 {
        i -= 1;
        room.projectiles[i].x += room.projectiles[i].dir_x * room.projectiles[i].speed * dt;
        room.projectiles[i].z += room.projectiles[i].dir_z * room.projectiles[i].speed * dt;

        let target_slot = 1 - room.projectiles[i].owner_slot;
        let hit = if let Some(target) = room.players[target_slot].as_ref().filter(|t| t.alive) {
            let target_champ = cfg.get_champion(&target.champion_id);
            let hit_dx = target.x - room.projectiles[i].x;
            let hit_dz = target.z - room.projectiles[i].z;
            let hit_r = target_champ.stats.hitbox_radius + room.projectiles[i].radius;
            hit_dx * hit_dx + hit_dz * hit_dz <= hit_r * hit_r
        } else {
            false
        };

        if hit {
            let p_copy = room.projectiles.remove(i);
            apply_hit_and_check_round_end(
                room,
                HitParams {
                    attacker_slot: p_copy.owner_slot,
                    attacker_champion_id: p_copy.champion_id,
                    victim_slot: target_slot,
                    proj_id: Some(p_copy.id),
                    zone_id: None,
                    damage_flat_min: p_copy.damage_flat_min,
                    damage_pct_hp: p_copy.damage_percent_current_hp,
                    slow_percent: p_copy.slow_percent,
                    slow_duration: p_copy.slow_duration,
                    knockup_duration: None,
                    refund_on_hit: p_copy.refund_on_hit,
                },
                on_game_over,
            );
            continue;
        }

        let trav_dx = room.projectiles[i].x - room.projectiles[i].start_x;
        let trav_dz = room.projectiles[i].z - room.projectiles[i].start_z;
        let dist_center_sq = room.projectiles[i].x * room.projectiles[i].x + room.projectiles[i].z * room.projectiles[i].z;
        if trav_dx * trav_dx + trav_dz * trav_dz >= room.projectiles[i].max_range * room.projectiles[i].max_range
            || dist_center_sq >= max_edge_sq
        {
            let p_copy = room.projectiles.remove(i);
            room.events.push(GameEvent::QMiss {
                proj_id: Some(p_copy.id),
                zone_id: None,
                attacker_slot: p_copy.owner_slot,
                attacker_champion_id: p_copy.champion_id,
                x: p_copy.x,
                z: p_copy.z,
            });
        }
    }
}

fn step_ground_zones<F>(cfg: &GameplayConfig, room: &mut GameRoom, dt: f64, on_game_over: &mut F)
where
    F: FnMut(&GameRoom),
{
    let mut i = room.ground_zones.len();
    while i > 0 {
        i -= 1;
        room.ground_zones[i].remaining -= dt;
        if room.ground_zones[i].remaining > 0.0 {
            continue;
        }

        let z_copy = room.ground_zones.remove(i);
        let target_slot = 1 - z_copy.owner_slot;
        let hit_victim = if let Some(target) = room.players[target_slot].as_ref().filter(|t| t.alive) {
            let target_champ = cfg.get_champion(&target.champion_id);
            let hit_dx = target.x - z_copy.x;
            let hit_dz = target.z - z_copy.z;
            let hit_r = target_champ.stats.hitbox_radius + z_copy.radius;
            hit_dx * hit_dx + hit_dz * hit_dz <= hit_r * hit_r
        } else {
            false
        };

        room.events.push(GameEvent::ZoneErupt {
            zone_id: z_copy.id,
            owner_slot: z_copy.owner_slot,
            champion_id: z_copy.champion_id.clone(),
            x: z_copy.x,
            z: z_copy.z,
            radius: z_copy.radius,
            hit_victim,
        });

        if hit_victim && room.players[target_slot].is_some() {
            apply_hit_and_check_round_end(
                room,
                HitParams {
                    attacker_slot: z_copy.owner_slot,
                    attacker_champion_id: z_copy.champion_id,
                    victim_slot: target_slot,
                    proj_id: None,
                    zone_id: Some(z_copy.id),
                    damage_flat_min: z_copy.damage_flat_min,
                    damage_pct_hp: z_copy.damage_percent_current_hp,
                    slow_percent: z_copy.slow_percent,
                    slow_duration: z_copy.slow_duration,
                    knockup_duration: Some(z_copy.knockup_duration),
                    refund_on_hit: z_copy.refund_on_hit,
                },
                on_game_over,
            );
        } else {
            room.events.push(GameEvent::QMiss {
                proj_id: None,
                zone_id: Some(z_copy.id),
                attacker_slot: z_copy.owner_slot,
                attacker_champion_id: z_copy.champion_id,
                x: z_copy.x,
                z: z_copy.z,
            });
        }
    }
}

pub fn step_room_simulation<F>(cfg: &GameplayConfig, room: &mut GameRoom, dt: f64, mut on_game_over: F)
where
    F: FnMut(&GameRoom),
{
    if room.state == "countdown" {
        room.countdown_timer -= dt;
        if room.countdown_timer <= 0.0 {
            room.state = "playing".to_string();
            room.events.push(GameEvent::FightStart { round: room.round });
        }
    }

    if room.state != "playing" {
        return;
    }

    room.match_time += dt;
    step_players(cfg, room, dt);
    step_projectiles(cfg, room, dt, &mut on_game_over);
    step_ground_zones(cfg, room, dt, &mut on_game_over);
}

fn serialize_player_snapshot_ref<'a>(p: Option<&'a ServerPlayerState>) -> Option<PlayerSnapshotRef<'a>> {
    let p = p?;
    Some(PlayerSnapshotRef {
        slot: p.slot,
        name: &p.name,
        champion_id: &p.champion_id,
        x: round1(p.x),
        z: round1(p.z),
        target_x: round1(p.target_x),
        target_z: round1(p.target_z),
        angle: round3(p.angle),
        hp: p.hp.round(),
        max_hp: p.max_hp,
        alive: p.alive,
        anim: &p.anim,
        q_cd: round2(p.q_cd),
        max_q_cd: p.max_q_cd,
        spell_cd: [round2(p.spell_cd[0]), round2(p.spell_cd[1])],
        max_spell_cd: p.max_spell_cd,
        spells: [&p.spells[0], &p.spells[1]],
        slow_timer: round2(p.slow_timer),
        slow_percent: round2(p.slow_percent),
        knockup_timer: round2(p.knockup_timer),
        knockup_duration: round2(p.knockup_duration),
        ghost_timer: round2(p.ghost_timer),
        heal_speed_timer: round2(p.heal_speed_timer),
        score: p.score,
        stats: &p.stats,
    })
}

pub fn serialize_state_snapshot_utf8(room: &GameRoom, buf: &mut Vec<u8>) -> Option<Utf8Bytes> {
    let projectiles = if room.projectiles.is_empty() {
        Vec::new()
    } else {
        room.projectiles
            .iter()
            .map(|pr| ProjectileSnapshotRef {
                id: pr.id,
                owner_slot: pr.owner_slot,
                champion_id: &pr.champion_id,
                x: round1(pr.x),
                z: round1(pr.z),
                dir_x: round3(pr.dir_x),
                dir_z: round3(pr.dir_z),
                speed: pr.speed,
                radius: pr.radius,
            })
            .collect()
    };

    let ground_zones = if room.ground_zones.is_empty() {
        Vec::new()
    } else {
        room.ground_zones
            .iter()
            .map(|zn| GroundZoneSnapshotRef {
                id: zn.id,
                owner_slot: zn.owner_slot,
                champion_id: &zn.champion_id,
                x: round1(zn.x),
                z: round1(zn.z),
                radius: zn.radius,
                remaining: round2(zn.remaining),
                duration: zn.duration,
            })
            .collect()
    };

    let snap = StateSnapshotRef {
        msg_type: "state_snapshot",
        state: &room.state,
        round: room.round,
        countdown_timer: room.countdown_timer.max(0.0),
        players: [
            serialize_player_snapshot_ref(room.players[0].as_ref()),
            serialize_player_snapshot_ref(room.players[1].as_ref()),
        ],
        projectiles,
        ground_zones,
        events: &room.events,
    };

    buf.clear();
    serde_json::to_writer(&mut *buf, &snap).ok()?;
    std::str::from_utf8(buf).ok().map(|s| Utf8Bytes::from(s.to_owned()))
}
