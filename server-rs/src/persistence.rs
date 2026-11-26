use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::analytics::now_unix_ms;
use crate::config::GameplayConfig;
use crate::model::{GameRoom, ServerGroundZone, ServerPlayerState, ServerProjectile};
use crate::protocol::RoomSettings;

pub const RESTORED_ROOM_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRoom {
    id: String,
    #[serde(default)]
    passcode: String,
    champion_id: Option<String>,
    state: String,
    round: i32,
    #[serde(default)]
    match_time: f64,
    #[serde(default)]
    countdown_timer: f64,
    #[serde(default = "default_neg_one")]
    last_broadcast_countdown_sec: i32,
    #[serde(default)]
    round_end_timer: f64,
    #[serde(default)]
    next_proj_id: i64,
    #[serde(default)]
    next_zone_id: Option<i64>,
    winner_slot: Option<usize>,
    #[serde(default)]
    bot_enabled: bool,
    #[serde(default)]
    bot_difficulty: String,
    settings: RoomSettings,
    players: [Option<ServerPlayerState>; 2],
    #[serde(default)]
    projectiles: Vec<ServerProjectile>,
    #[serde(default)]
    ground_zones: Vec<ServerGroundZone>,
}

fn default_neg_one() -> i32 {
    -1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRoomsFile {
    saved_at: Option<u64>,
    rooms: Vec<PersistedRoom>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveRoomsPayload<'a> {
    saved_at: u64,
    rooms: Vec<&'a GameRoom>,
}

pub struct RoomPersistence {
    pub snapshot_path: PathBuf,
    pub last_saved_had_rooms: bool,
}

impl RoomPersistence {
    pub fn new(snapshot_path: PathBuf) -> Self {
        Self {
            snapshot_path,
            last_saved_had_rooms: false,
        }
    }

    pub fn serialize_rooms(&self, rooms: &HashMap<String, GameRoom>) -> Option<(Vec<u8>, usize)> {
        let list: Vec<&GameRoom> = rooms.values().collect();
        let count = list.len();
        let payload = SaveRoomsPayload {
            saved_at: now_unix_ms(),
            rooms: list,
        };
        serde_json::to_vec(&payload).ok().map(|b| (b, count))
    }

    pub fn write_sync(&mut self, data: &[u8], room_count: usize) {
        if let Some(parent) = self.snapshot_path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        let tmp_path = PathBuf::from(format!("{}.tmp", self.snapshot_path.display()));
        if std::fs::write(&tmp_path, data).is_err() {
            return;
        }
        if std::fs::rename(&tmp_path, &self.snapshot_path).is_ok() {
            self.last_saved_had_rooms = room_count > 0;
        }
    }

    pub async fn write_async(path: &Path, data: Vec<u8>) -> bool {
        if let Some(parent) = path.parent() {
            if tokio::fs::create_dir_all(parent).await.is_err() {
                return false;
            }
        }
        let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
        if tokio::fs::write(&tmp_path, &data).await.is_err() {
            return false;
        }
        tokio::fs::rename(&tmp_path, path).await.is_ok()
    }

    pub fn load_into(&mut self, cfg: &GameplayConfig, rooms: &mut HashMap<String, GameRoom>) -> usize {
        let Ok(raw) = std::fs::read_to_string(&self.snapshot_path) else {
            return 0;
        };
        let Ok(parsed) = serde_json::from_str::<PersistedRoomsFile>(&raw) else {
            return 0;
        };
        let now = now_unix_ms();
        let saved_at = parsed.saved_at.unwrap_or(0);
        if now.saturating_sub(saved_at) > RESTORED_ROOM_TTL_MS {
            return 0;
        }

        for saved in parsed.rooms {
            if saved.id.is_empty() {
                continue;
            }
            let fallback_champ = saved.players[0]
                .as_ref()
                .map(|p| p.champion_id.as_str())
                .unwrap_or(&cfg.default_champion_id);
            let room_champ_id = cfg.normalize_champion_id(
                saved.champion_id.as_deref().unwrap_or(fallback_champ),
                &cfg.default_champion_id,
            );

            let hydrate = |opt: Option<ServerPlayerState>| -> Option<ServerPlayerState> {
                let mut p = opt?;
                p.champion_id = room_champ_id.clone();
                if !p.is_bot {
                    p.awaiting_reconnect = true;
                }
                Some(p)
            };

            let [raw_p0, raw_p1] = saved.players;
            let players = [hydrate(raw_p0), hydrate(raw_p1)];
            rooms.insert(
                saved.id.clone(),
                GameRoom {
                    id: saved.id,
                    passcode: saved.passcode,
                    champion_id: room_champ_id,
                    state: saved.state,
                    round: saved.round,
                    match_time: saved.match_time,
                    countdown_timer: saved.countdown_timer,
                    last_broadcast_countdown_sec: saved.last_broadcast_countdown_sec,
                    round_end_timer: saved.round_end_timer,
                    next_proj_id: saved.next_proj_id,
                    next_zone_id: saved.next_zone_id.unwrap_or(1),
                    winner_slot: saved.winner_slot,
                    bot_enabled: saved.bot_enabled,
                    bot_difficulty: saved.bot_difficulty,
                    settings: saved.settings,
                    clients: Vec::new(),
                    players,
                    projectiles: saved.projectiles,
                    ground_zones: saved.ground_zones,
                    events: Vec::new(),
                    restored_at: Some(now),
                },
            );
        }

        if !rooms.is_empty() {
            self.last_saved_had_rooms = true;
        }
        rooms.len()
    }
}
