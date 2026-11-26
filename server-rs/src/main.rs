mod actions;
mod analytics;
mod bot;
mod config;
mod model;
mod persistence;
mod protocol;
mod simulation;
mod static_files;

use axum::body::Body;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path as AxumPath, Request, State};
use axum::http::{HeaderMap, Method, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use tokio::time::MissedTickBehavior;

use actions::{
    cast_primary_ability, clamp_to_baron_pit_half, create_player_state, reset_round_state,
    set_player_champion, use_summoner_spell,
};
use analytics::{now_unix_ms, track_event};
use config::{load_gameplay_config, parse_best_of, resolve_project_root, validate_spells, GameplayConfig};
use model::{ConnectedClient, GameRoom, ServerPlayerState};
use persistence::{RoomPersistence, RESTORED_ROOM_TTL_MS};
use protocol::{
    ClientMessage, ErrorMsg, GameEvent, JoinedRoomMsg, LobbyPlayerInfo, PongMsg,
    RoomCheckResultMsg, RoomLobbyPayload, RoomSettings, RoomSummary,
};
use simulation::{serialize_state_snapshot_utf8, step_room_simulation};
use static_files::StaticFileServer;

const ROOM_CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

struct AppState {
    cfg: GameplayConfig,
    rooms: Mutex<HashMap<String, GameRoom>>,
    persistence: Mutex<RoomPersistence>,
    persistence_dirty: Mutex<bool>,
    tick_notify: Arc<Notify>,
    static_srv: StaticFileServer,
}

struct NoDelayListener(TcpListener);

impl axum::serve::Listener for NoDelayListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, addr) = axum::serve::Listener::accept(&mut self.0).await;
        let _ = stream.set_nodelay(true);
        (stream, addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

fn new_uuid() -> String {
    let a = fastrand::u32(..);
    let b = fastrand::u16(..);
    let c = (fastrand::u16(..) & 0x0fff) | 0x4000;
    let d = (fastrand::u16(..) & 0x3fff) | 0x8000;
    let e = fastrand::u64(..) & 0xffff_ffff_ffff;
    format!("{a:08x}-{b:04x}-{c:04x}-{d:04x}-{e:012x}")
}

fn generate_room_id(rooms: &HashMap<String, GameRoom>) -> String {
    loop {
        let mut code = String::with_capacity(6);
        for _ in 0..6 {
            let idx = fastrand::usize(..ROOM_CODE_CHARS.len());
            code.push(ROOM_CODE_CHARS[idx] as char);
        }
        if !rooms.contains_key(&code) {
            return code;
        }
    }
}

fn serialize_lobby_player(p: Option<&ServerPlayerState>, idx: usize) -> Option<LobbyPlayerInfo> {
    let p = p?;
    Some(LobbyPlayerInfo {
        slot: idx,
        name: p.name.clone(),
        champion_id: p.champion_id.clone(),
        is_bot: p.is_bot,
        ready: p.ready,
        spells: p.spells.clone(),
        score: p.score,
        stats: p.stats.clone(),
    })
}

fn serialize_room_lobby(room: &GameRoom) -> RoomLobbyPayload {
    RoomLobbyPayload {
        msg_type: "room_update",
        room_id: room.id.clone(),
        champion_id: room.champion_id.clone(),
        has_passcode: !room.passcode.is_empty(),
        passcode: room.passcode.clone(),
        state: room.state.clone(),
        round: room.round,
        settings: room.settings.clone(),
        bot_enabled: room.bot_enabled,
        bot_difficulty: room.bot_difficulty.clone(),
        players: [
            serialize_lobby_player(room.players[0].as_ref(), 0),
            serialize_lobby_player(room.players[1].as_ref(), 1),
        ],
    }
}

fn send_client_msg<T: serde::Serialize>(tx: &mpsc::Sender<Utf8Bytes>, payload: &T) {
    if let Ok(json_str) = serde_json::to_string(payload) {
        let _ = tx.try_send(Utf8Bytes::from(json_str));
    }
}

fn broadcast_to_room<T: serde::Serialize>(room: &GameRoom, payload: &T) {
    if let Ok(json_str) = serde_json::to_string(payload) {
        let bytes = Utf8Bytes::from(json_str);
        for c in &room.clients {
            let _ = c.tx.try_send(bytes.clone());
        }
    }
}

fn has_active_sim(rooms: &HashMap<String, GameRoom>) -> bool {
    rooms
        .values()
        .any(|r| !r.clients.is_empty() && r.state != "lobby" && r.state != "gameover")
}

fn mark_dirty(state: &AppState) {
    if let Ok(mut d) = state.persistence_dirty.lock() {
        *d = true;
    }
}

fn leave_current_room(
    state: &AppState,
    client_id: &str,
    client_room: &mut Option<String>,
    client_slot: &mut Option<usize>,
) {
    let Some(rid) = client_room.take() else {
        *client_slot = None;
        return;
    };
    let old_slot = client_slot.take();

    let mut rooms = state.rooms.lock().unwrap();
    let Some(room) = rooms.get_mut(&rid) else {
        return;
    };

    room.clients.retain(|c| c.id != client_id);
    if let Some(slot) = old_slot {
        if slot < 2 {
            room.players[slot] = None;
        }
    }

    if room.clients.is_empty() {
        rooms.remove(&rid);
        drop(rooms);
        mark_dirty(state);
        return;
    }

    if room.players[0].is_none() && room.players[1].as_ref().map(|p| !p.is_bot).unwrap_or(false) {
        let mut p1 = room.players[1].take().unwrap();
        p1.slot = 0;
        room.players[0] = Some(p1);
        let lobby = serialize_room_lobby(room);
        for c in &mut room.clients {
            if c.slot == Some(1) {
                c.slot = Some(0);
                let msg = JoinedRoomMsg {
                    msg_type: "joined_room",
                    room_id: room.id.clone(),
                    slot: 0,
                    passcode: room.passcode.clone(),
                    lobby: lobby.clone(),
                };
                send_client_msg(&c.tx, &msg);
            }
        }
    }

    room.state = "lobby".to_string();
    room.projectiles.clear();
    room.ground_zones.clear();
    let lobby = serialize_room_lobby(room);
    broadcast_to_room(room, &lobby);
    drop(rooms);
    mark_dirty(state);
}

fn sanitize_custom_code(raw: &str) -> String {
    raw.trim()
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect()
}

fn truncate_name(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

fn handle_ws_message(
    state: &AppState,
    client_id: &str,
    tx: &mpsc::Sender<Utf8Bytes>,
    client_room: &mut Option<String>,
    client_slot: &mut Option<usize>,
    raw: &str,
) {
    let Ok(msg) = serde_json::from_str::<ClientMessage>(raw) else {
        return;
    };

    if msg.msg_type == "ping" {
        if let Some(t) = msg.t.filter(|v| v.is_finite()) {
            send_client_msg(tx, &PongMsg { msg_type: "pong", t });
        }
        return;
    }

    match msg.msg_type.as_str() {
        "check_room" => {
            let code = msg.room_id.unwrap_or_default().trim().to_uppercase();
            let rooms = state.rooms.lock().unwrap();
            if let Some(room) = rooms.get(&code) {
                let host_name = room.players[0]
                    .as_ref()
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| "Dr. Mundo".to_string());
                send_client_msg(
                    tx,
                    &RoomCheckResultMsg {
                        msg_type: "room_check_result",
                        exists: true,
                        room_id: code,
                        has_passcode: Some(!room.passcode.is_empty()),
                        host_name: Some(host_name),
                    },
                );
            } else {
                send_client_msg(
                    tx,
                    &RoomCheckResultMsg {
                        msg_type: "room_check_result",
                        exists: false,
                        room_id: code,
                        has_passcode: None,
                        host_name: None,
                    },
                );
            }
            return;
        }
        "create_room" => {
            leave_current_room(state, client_id, client_room, client_slot);

            let custom = sanitize_custom_code(msg.custom_code.as_deref().unwrap_or(""));
            let mut rooms = state.rooms.lock().unwrap();
            let room_id = if custom.is_empty() {
                generate_room_id(&rooms)
            } else {
                custom
            };
            if rooms.contains_key(&room_id) {
                send_client_msg(
                    tx,
                    &ErrorMsg {
                        msg_type: "error_msg",
                        code: None,
                        room_id: None,
                        message: "Room code already exists. Try another code.".to_string(),
                    },
                );
                return;
            }

            let passcode = msg.passcode.unwrap_or_default().trim().to_string();
            let spells = validate_spells(msg.spells.as_deref());
            let champion_id = state.cfg.normalize_champion_id(
                msg.champion_id.as_deref().unwrap_or(""),
                &state.cfg.default_champion_id,
            );
            let champ = state.cfg.get_champion(&champion_id);
            let cooldown_mode = if msg.cooldown_mode.as_deref() == Some("standard") {
                "standard".to_string()
            } else {
                "fast".to_string()
            };
            let settings = RoomSettings {
                best_of: parse_best_of(msg.best_of),
                cooldown_mode: cooldown_mode.clone(),
            };

            let raw_name = msg.name.unwrap_or_default();
            let p0_name = truncate_name(
                if raw_name.is_empty() {
                    &champ.default_player_name
                } else {
                    &raw_name
                },
                20,
            );

            let p0 = create_player_state(&state.cfg, 0, p0_name, spells, false, &champion_id);
            let p1 = if msg.with_bot {
                Some(create_player_state(
                    &state.cfg,
                    1,
                    champ.default_bot_name.clone(),
                    ["flash".to_string(), "ghost".to_string()],
                    true,
                    &champion_id,
                ))
            } else {
                None
            };

            let client = ConnectedClient {
                id: client_id.to_string(),
                tx: tx.clone(),
                room_id: Some(room_id.clone()),
                slot: Some(0),
            };

            let room = GameRoom {
                id: room_id.clone(),
                passcode: passcode.clone(),
                champion_id,
                state: "lobby".to_string(),
                round: 1,
                match_time: 0.0,
                countdown_timer: 0.0,
                last_broadcast_countdown_sec: -1,
                round_end_timer: 0.0,
                next_proj_id: 1,
                next_zone_id: 1,
                winner_slot: None,
                bot_enabled: msg.with_bot,
                bot_difficulty: "challenger".to_string(),
                settings: settings.clone(),
                clients: vec![client],
                players: [Some(p0), p1],
                projectiles: Vec::new(),
                ground_zones: Vec::new(),
                events: Vec::new(),
                restored_at: None,
            };

            let lobby = serialize_room_lobby(&room);
            broadcast_to_room(&room, &lobby);
            rooms.insert(room_id.clone(), room);
            drop(rooms);

            *client_room = Some(room_id.clone());
            *client_slot = Some(0);
            mark_dirty(state);

            let mut props = Map::new();
            props.insert("roomId".to_string(), json!(room_id));
            props.insert("withBot".to_string(), json!(msg.with_bot));
            props.insert("bestOf".to_string(), json!(settings.best_of));
            props.insert("cooldownMode".to_string(), json!(cooldown_mode));
            props.insert("hasPasscode".to_string(), json!(!passcode.is_empty()));
            track_event("room_created", client_id, props);

            send_client_msg(
                tx,
                &JoinedRoomMsg {
                    msg_type: "joined_room",
                    room_id,
                    slot: 0,
                    passcode,
                    lobby,
                },
            );
            return;
        }
        "join_room" => {
            let room_id = msg.room_id.unwrap_or_default().trim().to_uppercase();
            {
                let rooms = state.rooms.lock().unwrap();
                let Some(room) = rooms.get(&room_id) else {
                    send_client_msg(
                        tx,
                        &ErrorMsg {
                            msg_type: "error_msg",
                            code: Some("NOT_FOUND"),
                            room_id: None,
                            message: format!("Room \"{room_id}\" was not found."),
                        },
                    );
                    return;
                };
                if !room.passcode.is_empty() {
                    let provided = msg.passcode.as_deref().unwrap_or("").trim();
                    if provided != room.passcode {
                        send_client_msg(
                            tx,
                            &ErrorMsg {
                                msg_type: "error_msg",
                                code: Some("INVALID_PASSCODE"),
                                room_id: Some(room_id),
                                message: if provided.is_empty() {
                                    "This room requires a passcode.".to_string()
                                } else {
                                    "Incorrect room passcode.".to_string()
                                },
                            },
                        );
                        return;
                    }
                }
            }

            leave_current_room(state, client_id, client_room, client_slot);

            let mut rooms = state.rooms.lock().unwrap();
            let Some(room) = rooms.get_mut(&room_id) else {
                send_client_msg(
                    tx,
                    &ErrorMsg {
                        msg_type: "error_msg",
                        code: Some("NOT_FOUND"),
                        room_id: None,
                        message: format!("Room \"{room_id}\" was not found."),
                    },
                );
                return;
            };

            let requested_name = truncate_name(msg.name.as_deref().unwrap_or("").trim(), 20);
            let mut reclaim_slot: Option<usize> = None;
            for s in 0..2 {
                if let Some(p) = room.players[s].as_ref() {
                    if !p.is_bot && p.awaiting_reconnect {
                        if !requested_name.is_empty() && p.name == requested_name {
                            reclaim_slot = Some(s);
                            break;
                        }
                        if reclaim_slot.is_none() {
                            reclaim_slot = Some(s);
                        }
                    }
                }
            }

            if let Some(slot) = reclaim_slot {
                if let Some(reclaimed) = room.players[slot].as_mut() {
                    reclaimed.awaiting_reconnect = false;
                    if !requested_name.is_empty() {
                        reclaimed.name = requested_name;
                    }
                }
                room.clients.push(ConnectedClient {
                    id: client_id.to_string(),
                    tx: tx.clone(),
                    room_id: Some(room_id.clone()),
                    slot: Some(slot),
                });
                room.restored_at = None;
                *client_room = Some(room_id.clone());
                *client_slot = Some(slot);

                let lobby = serialize_room_lobby(room);
                send_client_msg(
                    tx,
                    &JoinedRoomMsg {
                        msg_type: "joined_room",
                        room_id: room_id.clone(),
                        slot,
                        passcode: room.passcode.clone(),
                        lobby: lobby.clone(),
                    },
                );
                broadcast_to_room(room, &lobby);
                if room.state != "lobby" {
                    let mut snap_buf = Vec::with_capacity(1024);
                    if let Some(bytes) = serialize_state_snapshot_utf8(room, &mut snap_buf) {
                        let _ = tx.try_send(bytes);
                    }
                    state.tick_notify.notify_one();
                }
                drop(rooms);
                mark_dirty(state);

                let mut props = Map::new();
                props.insert("roomId".to_string(), json!(room_id));
                props.insert("slot".to_string(), json!(slot));
                props.insert("reclaimed".to_string(), json!(true));
                track_event("room_joined", client_id, props);
                return;
            }

            let assigned_slot = if room.players[0].is_none() {
                Some(0)
            } else if room.players[1].is_none()
                || room.players[1].as_ref().map(|p| p.is_bot).unwrap_or(false)
            {
                room.bot_enabled = false;
                Some(1)
            } else {
                None
            };

            let Some(slot) = assigned_slot else {
                send_client_msg(
                    tx,
                    &ErrorMsg {
                        msg_type: "error_msg",
                        code: Some("ROOM_FULL"),
                        room_id: None,
                        message: "This 1v1 room is already full (2/2 players).".to_string(),
                    },
                );
                return;
            };

            let spells = validate_spells(msg.spells.as_deref());
            let champ = state.cfg.get_champion(&room.champion_id);
            let raw_name = msg.name.unwrap_or_default();
            let fallback_name = format!("{} #{}", champ.name, slot + 1);
            let p_name = truncate_name(
                if raw_name.is_empty() {
                    &fallback_name
                } else {
                    &raw_name
                },
                20,
            );

            room.players[slot] = Some(create_player_state(
                &state.cfg,
                slot,
                p_name,
                spells,
                false,
                &room.champion_id,
            ));
            room.clients.push(ConnectedClient {
                id: client_id.to_string(),
                tx: tx.clone(),
                room_id: Some(room_id.clone()),
                slot: Some(slot),
            });
            *client_room = Some(room_id.clone());
            *client_slot = Some(slot);

            let lobby = serialize_room_lobby(room);
            send_client_msg(
                tx,
                &JoinedRoomMsg {
                    msg_type: "joined_room",
                    room_id: room_id.clone(),
                    slot,
                    passcode: room.passcode.clone(),
                    lobby: lobby.clone(),
                },
            );
            broadcast_to_room(room, &lobby);
            drop(rooms);
            mark_dirty(state);

            let mut props = Map::new();
            props.insert("roomId".to_string(), json!(room_id));
            props.insert("slot".to_string(), json!(slot));
            props.insert("reclaimed".to_string(), json!(false));
            track_event("room_joined", client_id, props);
            return;
        }
        _ => {}
    }

    let (Some(rid), Some(slot)) = (client_room.as_ref(), *client_slot) else {
        return;
    };
    if slot >= 2 {
        return;
    }

    let mut rooms = state.rooms.lock().unwrap();
    let Some(room) = rooms.get_mut(rid) else {
        return;
    };
    if room.players[slot].is_none() {
        return;
    }

    let mut dirty = false;
    let mut wake_ticker = false;

    match msg.msg_type.as_str() {
        "select_champion" => {
            if slot != 0 || room.state != "lobby" {
                return;
            }
            let next_champ = state.cfg.normalize_champion_id(
                msg.champion_id.as_deref().unwrap_or(""),
                &room.champion_id,
            );
            room.champion_id = next_champ.clone();
            for p in room.players.iter_mut().flatten() {
                set_player_champion(&state.cfg, p, &next_champ);
            }
            broadcast_to_room(room, &serialize_room_lobby(room));
            dirty = true;
        }
        "select_spells" => {
            if room.state != "lobby" {
                return;
            }
            let fast_cd = room.settings.cooldown_mode != "standard";
            if let Some(p) = room.players[slot].as_mut() {
                p.spells = validate_spells(msg.spells.as_deref());
                p.max_spell_cd = [
                    state.cfg.get_spell_cooldown(&p.spells[0], fast_cd),
                    state.cfg.get_spell_cooldown(&p.spells[1], fast_cd),
                ];
            }
            broadcast_to_room(room, &serialize_room_lobby(room));
            dirty = true;
        }
        "update_name" => {
            if let Some(raw_name) = msg.name.as_deref() {
                let trimmed = truncate_name(raw_name.trim(), 20);
                if !trimmed.is_empty() {
                    if let Some(p) = room.players[slot].as_mut() {
                        p.name = trimmed;
                    }
                    broadcast_to_room(room, &serialize_room_lobby(room));
                    dirty = true;
                }
            }
        }
        "toggle_bot" => {
            if slot != 0 || room.state != "lobby" {
                return;
            }
            if room.players[1].as_ref().map(|p| !p.is_bot).unwrap_or(false) {
                return;
            }
            room.bot_enabled = !room.bot_enabled;
            if room.bot_enabled {
                let bot_champ = state.cfg.get_champion(&room.champion_id);
                room.players[1] = Some(create_player_state(
                    &state.cfg,
                    1,
                    bot_champ.default_bot_name.clone(),
                    ["flash".to_string(), "ghost".to_string()],
                    true,
                    &bot_champ.id,
                ));
            } else {
                room.players[1] = None;
            }
            broadcast_to_room(room, &serialize_room_lobby(room));
            dirty = true;
        }
        "update_settings" => {
            if slot == 0 && room.state == "lobby" {
                if msg.best_of.is_some() {
                    room.settings.best_of = parse_best_of(msg.best_of);
                }
                if let Some(cm) = msg.cooldown_mode.as_deref() {
                    if cm == "fast" || cm == "standard" {
                        room.settings.cooldown_mode = cm.to_string();
                    }
                }
                broadcast_to_room(room, &serialize_room_lobby(room));
                dirty = true;
            }
        }
        "set_ready" => {
            if let Some(p) = room.players[slot].as_mut() {
                p.ready = msg.ready;
            }
            broadcast_to_room(room, &serialize_room_lobby(room));
            dirty = true;
        }
        "start_match" | "rematch" => {
            if msg.msg_type == "start_match" && (slot != 0 || room.state != "lobby") {
                return;
            }
            if msg.msg_type == "rematch" && room.state != "gameover" {
                return;
            }
            if room.players[0].is_none() || room.players[1].is_none() {
                send_client_msg(
                    tx,
                    &ErrorMsg {
                        msg_type: "error_msg",
                        code: None,
                        room_id: None,
                        message: "Waiting for opponent (or enable AI Bot to practice).".to_string(),
                    },
                );
                return;
            }
            room.round = 1;
            room.match_time = 0.0;
            room.winner_slot = None;
            for p in room.players.iter_mut().flatten() {
                p.score = 0;
                p.stats = Default::default();
            }
            reset_round_state(&state.cfg, room);
            room.state = "countdown".to_string();
            room.countdown_timer = 3.0;
            room.last_broadcast_countdown_sec = -1;
            room.events.push(GameEvent::RoundCountdown { round: 1 });

            broadcast_to_room(room, &serialize_room_lobby(room));

            let mut props = Map::new();
            props.insert("roomId".to_string(), json!(room.id));
            props.insert("isRematch".to_string(), json!(msg.msg_type == "rematch"));
            props.insert(
                "isBotMatch".to_string(),
                json!(room.players[1].as_ref().map(|p| p.is_bot).unwrap_or(false)),
            );
            props.insert("bestOf".to_string(), json!(room.settings.best_of));
            props.insert("cooldownMode".to_string(), json!(room.settings.cooldown_mode));
            if let (Some(p0), Some(p1)) = (room.players[0].as_ref(), room.players[1].as_ref()) {
                props.insert("p0Champion".to_string(), json!(p0.champion_id));
                props.insert("p1Champion".to_string(), json!(p1.champion_id));
                props.insert("p0Spells".to_string(), json!(p0.spells));
                props.insert("p1Spells".to_string(), json!(p1.spells));
            }
            track_event("match_started", &room.id, props);

            dirty = true;
            wake_ticker = true;
        }
        "return_to_lobby" => {
            if room.state != "gameover" && slot != 0 {
                return;
            }
            room.state = "lobby".to_string();
            room.winner_slot = None;
            room.projectiles.clear();
            room.ground_zones.clear();
            for p in room.players.iter_mut().flatten() {
                if !p.is_bot {
                    p.ready = false;
                }
            }
            broadcast_to_room(room, &serialize_room_lobby(room));
            dirty = true;
        }
        "move" => {
            if room.state != "playing" {
                return;
            }
            let Some(p) = room.players[slot].as_mut() else {
                return;
            };
            if !p.alive || p.knockup_timer > 0.0 {
                return;
            }
            if let (Some(tx_val), Some(tz_val)) = (msg.x, msg.z) {
                if tx_val.is_finite() && tz_val.is_finite() {
                    let champ = state.cfg.get_champion(&p.champion_id);
                    let (cx, cz) = clamp_to_baron_pit_half(
                        &state.cfg,
                        tx_val,
                        tz_val,
                        p.slot,
                        champ.stats.hitbox_radius,
                    );
                    p.target_x = cx;
                    p.target_z = cz;
                }
            }
        }
        "stop" => {
            if let Some(p) = room.players[slot].as_mut() {
                if p.alive {
                    p.target_x = p.x;
                    p.target_z = p.z;
                }
            }
        }
        "cast_q" => {
            if room.state != "playing" {
                return;
            }
            let (Some(tx_val), Some(tz_val)) = (msg.x, msg.z) else {
                return;
            };
            if !tx_val.is_finite() || !tz_val.is_finite() {
                return;
            }
            let [p0, p1] = &mut room.players;
            let p_opt = if slot == 0 { p0.as_mut() } else { p1.as_mut() };
            if let Some(p) = p_opt {
                if p.alive {
                    cast_primary_ability(&state.cfg, p, &mut room.events, tx_val, tz_val);
                }
            }
        }
        "cast_spell" => {
            if room.state != "playing" {
                return;
            }
            let Some(raw_idx) = msg.spell_index else {
                return;
            };
            if !raw_idx.is_finite() || raw_idx.fract() != 0.0 || raw_idx < 0.0 || raw_idx > 1.0 {
                return;
            }
            let idx = raw_idx as usize;
            let cooldown_mode = room.settings.cooldown_mode.clone();
            let [p0, p1] = &mut room.players;
            let p_opt = if slot == 0 { p0.as_mut() } else { p1.as_mut() };
            if let Some(p) = p_opt {
                if p.alive {
                    let tx_val = msg.x.filter(|v| v.is_finite()).unwrap_or(p.x);
                    let tz_val = msg.z.filter(|v| v.is_finite()).unwrap_or(p.z);
                    use_summoner_spell(
                        &state.cfg,
                        &cooldown_mode,
                        p,
                        &mut room.events,
                        idx,
                        tx_val,
                        tz_val,
                    );
                }
            }
        }
        "emote" => {
            if let Some(p) = room.players[slot].as_mut() {
                if !p.alive || p.cast_timer > 0.0 {
                    return;
                }
                let emote = match msg.emote.as_deref() {
                    Some("taunt" | "joke" | "dance" | "laugh" | "recall") => msg.emote.unwrap(),
                    _ => "taunt".to_string(),
                };
                p.target_x = p.x;
                p.target_z = p.z;
                p.emote_anim = Some(emote.clone());
                p.emote_timer = 4.0;
                p.anim = emote;
            }
        }
        _ => {}
    }

    drop(rooms);
    if dirty {
        mark_dirty(state);
    }
    if wake_ticker {
        state.tick_notify.notify_one();
    }
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let client_id = new_uuid();
    let (tx, mut rx) = mpsc::channel::<Utf8Bytes>(64);

    let mut client_room: Option<String> = None;
    let mut client_slot: Option<usize> = None;

    loop {
        tokio::select! {
            biased;
            maybe_out = rx.recv() => {
                let Some(text) = maybe_out else { break; };
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            maybe_in = socket.recv() => {
                match maybe_in {
                    Some(Ok(Message::Text(txt))) => {
                        handle_ws_message(
                            &state,
                            &client_id,
                            &tx,
                            &mut client_room,
                            &mut client_slot,
                            txt.as_str(),
                        );
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    leave_current_room(&state, &client_id, &mut client_room, &mut client_slot);
}

async fn root_handler(State(state): State<Arc<AppState>>, req: Request) -> Response<Body> {
    let (mut parts, _body) = req.into_parts();
    if let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        return ws
            .read_buffer_size(4096)
            .write_buffer_size(4096)
            .max_write_buffer_size(16384)
            .max_message_size(4096)
            .max_frame_size(4096)
            .on_upgrade(move |socket| handle_socket(socket, state));
    }

    let index_path = state.static_srv.public_root.join("index.html");
    state
        .static_srv
        .serve_file(&parts.method, &parts.headers, &index_path, "no-cache")
        .await
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

async fn healthz_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let count = state.rooms.lock().unwrap().len();
    Json(json!({ "ok": true, "rooms": count }))
}

async fn api_rooms_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rooms = state.rooms.lock().unwrap();
    let list: Vec<RoomSummary> = rooms
        .iter()
        .map(|(id, room)| RoomSummary {
            id: id.clone(),
            host_name: room.players[0]
                .as_ref()
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "Dr. Mundo".to_string()),
            player_count: room.players.iter().filter(|p| p.is_some()).count(),
            has_passcode: !room.passcode.is_empty(),
            state: room.state.clone(),
            best_of: room.settings.best_of,
        })
        .collect();
    Json(json!({ "rooms": list }))
}

async fn three_static_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    AxumPath(rel): AxumPath<String>,
) -> Response<Body> {
    if let Some(full) = StaticFileServer::safe_resolve(&state.static_srv.three_root, &rel) {
        if let Some(resp) = state
            .static_srv
            .serve_file(&method, &headers, &full, "public, max-age=604800, immutable")
            .await
        {
            return resp;
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn fallback_static_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let path = uri.path();
    if let Some(full) = StaticFileServer::safe_resolve(&state.static_srv.public_root, path) {
        let cc = if path.starts_with("/assets/") {
            "public, max-age=86400"
        } else {
            "no-cache"
        };
        if let Some(resp) = state.static_srv.serve_file(&method, &headers, &full, cc).await {
            return resp;
        }
    }
    let index_path = state.static_srv.public_root.join("index.html");
    state
        .static_srv
        .serve_file(&method, &headers, &index_path, "no-cache")
        .await
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

async fn run_tick_loop(state: Arc<AppState>) {
    let dt = 1.0 / (state.cfg.tick_rate as f64);
    let tick_dur = Duration::from_secs_f64(dt);
    let mut tick_counter: u8 = 0;
    let mut last_lag_log_ms: u64 = 0;
    let mut json_buf: Vec<u8> = Vec::with_capacity(2048);

    loop {
        let active = {
            let rooms = state.rooms.lock().unwrap();
            has_active_sim(&rooms)
        };
        if !active {
            state.tick_notify.notified().await;
            continue;
        }

        let mut interval = tokio::time::interval(tick_dur);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        interval.tick().await;

        loop {
            interval.tick().await;
            tick_counter = (tick_counter + 1) & 1;
            let is_snapshot_tick = tick_counter == 0;
            let tick_start = Instant::now();
            let mut stepped_any = false;

            let (still_active, room_count) = {
                let mut rooms = state.rooms.lock().unwrap();
                for room in rooms.values_mut() {
                    if room.clients.is_empty() {
                        continue;
                    }

                    if room.state == "round_end" {
                        stepped_any = true;
                        room.round_end_timer -= dt;
                        if room.round_end_timer <= 0.0 {
                            room.round += 1;
                            reset_round_state(&state.cfg, room);
                            room.state = "countdown".to_string();
                            room.countdown_timer = 3.0;
                            room.last_broadcast_countdown_sec = -1;
                            room.events.push(GameEvent::RoundCountdown { round: room.round });
                        }
                    }

                    if room.state == "countdown"
                        || room.state == "playing"
                        || room.state == "round_end"
                        || room.state == "gameover"
                    {
                        if room.state != "gameover" {
                            stepped_any = true;
                        }
                        step_room_simulation(&state.cfg, room, dt, |finished| {
                            let lobby = serialize_room_lobby(finished);
                            broadcast_to_room(finished, &lobby);
                            let mut props = Map::new();
                            props.insert("roomId".to_string(), json!(finished.id));
                            props.insert(
                                "winnerSlot".to_string(),
                                json!(finished.winner_slot.map(|s| s as i64).unwrap_or(-1)),
                            );
                            props.insert(
                                "isBotMatch".to_string(),
                                json!(finished.players[1].as_ref().map(|p| p.is_bot).unwrap_or(false)),
                            );
                            props.insert("rounds".to_string(), json!(finished.round));
                            props.insert("durationSec".to_string(), json!(finished.match_time.round()));
                            props.insert(
                                "scores".to_string(),
                                json!([
                                    finished.players[0].as_ref().map(|p| p.score).unwrap_or(0),
                                    finished.players[1].as_ref().map(|p| p.score).unwrap_or(0)
                                ]),
                            );
                            track_event("match_completed", &finished.id, props);
                        });

                        let countdown_sec = room.countdown_timer.max(0.0).ceil() as i32;
                        let countdown_changed =
                            room.state == "countdown" && countdown_sec != room.last_broadcast_countdown_sec;
                        let should_broadcast = (room.state == "playing" && is_snapshot_tick)
                            || !room.events.is_empty()
                            || countdown_changed;

                        if should_broadcast {
                            if room.state == "countdown" {
                                room.last_broadcast_countdown_sec = countdown_sec;
                            }
                            if let Some(bytes) = serialize_state_snapshot_utf8(room, &mut json_buf) {
                                for c in &room.clients {
                                    let _ = c.tx.try_send(bytes.clone());
                                }
                            }
                            room.events.clear();
                        }
                    }
                }
                (has_active_sim(&rooms), rooms.len())
            };

            if stepped_any {
                mark_dirty(&state);
            }

            let tick_ms = tick_start.elapsed().as_secs_f64() * 1000.0;
            let now_ms = now_unix_ms();
            if tick_ms > 25.0 && now_ms.saturating_sub(last_lag_log_ms) > 30_000 {
                last_lag_log_ms = now_ms;
                let mut props = Map::new();
                props.insert("tickMs".to_string(), json!((tick_ms * 10.0).round() / 10.0));
                props.insert("rooms".to_string(), json!(room_count));
                track_event("tick_lag", "server", props);
            }

            if !still_active {
                break;
            }
        }
    }
}

async fn run_persistence_loop(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        let payload = {
            let now = now_unix_ms();
            let mut rooms = state.rooms.lock().unwrap();
            let mut expired = false;
            rooms.retain(|_, room| {
                if room.clients.is_empty() {
                    if let Some(restored_at) = room.restored_at {
                        if now.saturating_sub(restored_at) > RESTORED_ROOM_TTL_MS {
                            expired = true;
                            return false;
                        }
                    }
                }
                true
            });

            let mut dirty = state.persistence_dirty.lock().unwrap();
            if expired {
                *dirty = true;
            }
            if *dirty {
                let p = state.persistence.lock().unwrap();
                let res = p
                    .serialize_rooms(&rooms)
                    .map(|(b, c)| (b, c, p.snapshot_path.clone()));
                if res.is_some() {
                    *dirty = false;
                }
                res
            } else {
                None
            }
        };

        if let Some((bytes, count, path)) = payload {
            if RoomPersistence::write_async(&path, bytes).await {
                if let Ok(mut p) = state.persistence.lock() {
                    p.last_saved_had_rooms = count > 0;
                }
            }
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let project_root = resolve_project_root().expect("Failed to locate project root");
    let cfg = load_gameplay_config(&project_root).expect("Failed to load gameplay-config.json");
    let snapshot_path = std::env::var("ROOMS_SNAPSHOT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root.join("data").join("rooms-snapshot.json"));

    let mut persistence = RoomPersistence::new(snapshot_path);
    let mut rooms = HashMap::new();
    let restored = persistence.load_into(&cfg, &mut rooms);

    let state = Arc::new(AppState {
        cfg,
        rooms: Mutex::new(rooms),
        persistence: Mutex::new(persistence),
        persistence_dirty: Mutex::new(false),
        tick_notify: Arc::new(Notify::new()),
        static_srv: StaticFileServer::new(&project_root),
    });

    tokio::spawn(run_tick_loop(state.clone()));
    tokio::spawn(run_persistence_loop(state.clone()));

    let app = Router::new()
        .route("/", get(root_handler))
        .route("/healthz", get(healthz_handler))
        .route("/api/rooms", get(api_rooms_handler))
        .route("/three/{*path}", get(three_static_handler))
        .fallback(fallback_static_handler)
        .with_state(state.clone());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let tcp = TcpListener::bind(addr).await.expect("Failed to bind port");
    let listener = NoDelayListener(tcp);

    let mut props = Map::new();
    props.insert("port".to_string(), json!(port));
    props.insert("restoredRooms".to_string(), json!(restored));
    props.insert("backend".to_string(), json!("rust"));
    track_event("server_started", "server", props);

    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let rooms = shutdown_state.rooms.lock().unwrap();
            let mut persistence = shutdown_state.persistence.lock().unwrap();
            if let Some((bytes, count)) = persistence.serialize_rooms(&rooms) {
                persistence.write_sync(&bytes, count);
            }
        })
        .await
        .expect("Server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> GameplayConfig {
        let root = resolve_project_root().expect("root");
        load_gameplay_config(&root).expect("cfg")
    }

    fn create_mirror_room(cfg: &GameplayConfig, champion_id: &str, p1_is_bot: bool) -> GameRoom {
        let mut room = GameRoom {
            id: "TEST01".to_string(),
            passcode: String::new(),
            champion_id: champion_id.to_string(),
            state: "playing".to_string(),
            round: 1,
            match_time: 0.0,
            countdown_timer: 0.0,
            last_broadcast_countdown_sec: -1,
            round_end_timer: 0.0,
            next_proj_id: 1,
            next_zone_id: 1,
            winner_slot: None,
            bot_enabled: p1_is_bot,
            bot_difficulty: "challenger".to_string(),
            settings: RoomSettings {
                best_of: 3,
                cooldown_mode: "fast".to_string(),
            },
            clients: Vec::new(),
            players: [
                Some(create_player_state(
                    cfg,
                    0,
                    "Blue".to_string(),
                    ["flash".to_string(), "ghost".to_string()],
                    false,
                    champion_id,
                )),
                Some(create_player_state(
                    cfg,
                    1,
                    "Red".to_string(),
                    ["flash".to_string(), "ghost".to_string()],
                    p1_is_bot,
                    champion_id,
                )),
            ],
            projectiles: Vec::new(),
            ground_zones: Vec::new(),
            events: Vec::new(),
            restored_at: None,
        };
        reset_round_state(cfg, &mut room);
        room
    }

    #[test]
    fn drmundo_q_mirror_hit_and_kill() {
        let cfg = test_cfg();
        let mut room = create_mirror_room(&cfg, "drmundo", false);
        let dt = 1.0 / (cfg.tick_rate as f64);
        let (p1x, p1z) = {
            let p1 = room.players[1].as_ref().unwrap();
            (p1.x, p1.z)
        };
        {
            let [p0, _] = &mut room.players;
            cast_primary_ability(&cfg, p0.as_mut().unwrap(), &mut room.events, p1x, p1z);
        }
        assert_eq!(room.players[0].as_ref().unwrap().stats.abilities_cast, 1);

        let mut hit = false;
        for _ in 0..120 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
            if room.events.iter().any(|e| matches!(e, GameEvent::QHit { .. })) {
                hit = true;
                break;
            }
        }
        assert!(hit, "cleaver should hit stationary opponent");
        assert_eq!(room.players[0].as_ref().unwrap().stats.abilities_hit, 1);
        assert!(room.players[1].as_ref().unwrap().slow_timer > 0.0);

        room.players[1].as_mut().unwrap().hp = 100.0;
        room.events.clear();
        {
            let [p0, _] = &mut room.players;
            let p0_mut = p0.as_mut().unwrap();
            p0_mut.q_cd = 0.0;
            p0_mut.cast_timer = 0.0;
            cast_primary_ability(&cfg, p0_mut, &mut room.events, p1x, p1z);
        }
        for _ in 0..120 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
        }
        assert!(!room.players[1].as_ref().unwrap().alive);
        assert_eq!(room.players[0].as_ref().unwrap().score, 1);
        assert_eq!(room.state, "round_end");
    }

    #[test]
    fn chogath_rupture_and_range_clamp() {
        let cfg = test_cfg();
        let mut room = create_mirror_room(&cfg, "chogath", false);
        let dt = 1.0 / (cfg.tick_rate as f64);
        let (p1x, p1z) = {
            let p1 = room.players[1].as_ref().unwrap();
            (p1.x, p1.z)
        };
        {
            let [p0, _] = &mut room.players;
            cast_primary_ability(&cfg, p0.as_mut().unwrap(), &mut room.events, p1x, p1z);
        }
        for _ in 0..18 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
        }
        assert_eq!(room.ground_zones.len(), 1);
        for _ in 0..45 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
        }
        assert!(room.players[1].as_ref().unwrap().knockup_timer > 0.5);
        assert!(room.players[1].as_ref().unwrap().slow_timer > 1.0);

        let p0x = room.players[0].as_ref().unwrap().x;
        let p0z = room.players[0].as_ref().unwrap().z;
        {
            let p0 = room.players[0].as_mut().unwrap();
            p0.q_cd = 0.0;
            p0.cast_timer = 0.0;
            room.events.clear();
            cast_primary_ability(&cfg, p0, &mut room.events, p0x + 5000.0, p0z);
        }
        for _ in 0..18 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
        }
        let z = &room.ground_zones[0];
        let dist = ((z.x - p0x).powi(2) + (z.z - p0z).powi(2)).sqrt();
        assert!(dist <= cfg.get_champion("chogath").q.range + 1.0);
    }

    #[test]
    fn bot_dodges_rupture_and_pit_clamping() {
        let cfg = test_cfg();
        let mut room = create_mirror_room(&cfg, "chogath", true);
        let dt = 1.0 / (cfg.tick_rate as f64);
        let (sx, sz) = {
            let bot = room.players[1].as_ref().unwrap();
            (bot.x, bot.z)
        };
        room.ground_zones.push(model::ServerGroundZone {
            id: 99,
            owner_slot: 0,
            champion_id: "chogath".to_string(),
            x: sx,
            z: sz,
            radius: 175.0,
            remaining: 0.625,
            duration: 0.625,
            damage_flat_min: 310.0,
            damage_percent_current_hp: 0.08,
            knockup_duration: 0.85,
            slow_percent: 0.5,
            slow_duration: 1.5,
            refund_on_hit: 0.0,
        });
        for _ in 0..40 {
            step_room_simulation(&cfg, &mut room, dt, |_| {});
        }
        let bot = room.players[1].as_ref().unwrap();
        let dist = ((bot.x - sx).powi(2) + (bot.z - sz).powi(2)).sqrt();
        assert!(dist > 100.0);

        let (cx, cz) = clamp_to_baron_pit_half(&cfg, 500.0, 500.0, 0, 65.0);
        assert!((cx + cz) * actions::INV_SQRT2 <= -cfg.line_buffer + 1e-6);
        assert!((cx * cx + cz * cz).sqrt() <= cfg.pit_radius - 65.0 + 1e-6);
    }
}
