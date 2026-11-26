use axum::extract::ws::Utf8Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::protocol::{GameEvent, PlayerMatchStats, RoomSettings};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotAIState {
    pub move_cooldown: f64,
    pub strafe_sign: f64,
    pub q_think_cooldown: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCast {
    pub target_x: f64,
    pub target_z: f64,
    pub dir_x: f64,
    pub dir_z: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlayerState {
    pub slot: usize,
    pub name: String,
    pub champion_id: String,
    pub is_bot: bool,
    pub ready: bool,
    pub spells: [String; 2],
    pub score: i32,
    pub x: f64,
    pub z: f64,
    pub target_x: f64,
    pub target_z: f64,
    pub angle: f64,
    pub hp: f64,
    pub max_hp: f64,
    pub alive: bool,
    pub anim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emote_anim: Option<String>,
    pub q_cd: f64,
    pub max_q_cd: f64,
    pub spell_cd: [f64; 2],
    pub max_spell_cd: [f64; 2],
    pub cast_timer: f64,
    pub pending_cast: Option<PendingCast>,
    pub slow_timer: f64,
    pub slow_percent: f64,
    pub knockup_timer: f64,
    pub knockup_duration: f64,
    pub ghost_timer: f64,
    pub heal_speed_timer: f64,
    pub emote_timer: f64,
    pub stats: PlayerMatchStats,
    pub ai_state: Option<BotAIState>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub awaiting_reconnect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProjectile {
    pub id: i64,
    pub owner_slot: usize,
    pub champion_id: String,
    pub x: f64,
    pub z: f64,
    pub start_x: f64,
    pub start_z: f64,
    pub dir_x: f64,
    pub dir_z: f64,
    pub speed: f64,
    pub max_range: f64,
    pub radius: f64,
    pub damage_flat_min: f64,
    pub damage_percent_current_hp: f64,
    pub slow_percent: f64,
    pub slow_duration: f64,
    pub refund_on_hit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerGroundZone {
    pub id: i64,
    pub owner_slot: usize,
    pub champion_id: String,
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub remaining: f64,
    pub duration: f64,
    pub damage_flat_min: f64,
    pub damage_percent_current_hp: f64,
    pub knockup_duration: f64,
    pub slow_percent: f64,
    pub slow_duration: f64,
    pub refund_on_hit: f64,
}

#[derive(Debug, Clone)]
pub struct ConnectedClient {
    pub id: String,
    pub tx: mpsc::Sender<Utf8Bytes>,
    #[allow(dead_code)]
    pub room_id: Option<String>,
    pub slot: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRoom {
    pub id: String,
    pub passcode: String,
    pub champion_id: String,
    pub state: String,
    pub round: i32,
    pub match_time: f64,
    pub countdown_timer: f64,
    pub last_broadcast_countdown_sec: i32,
    pub round_end_timer: f64,
    pub next_proj_id: i64,
    pub next_zone_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winner_slot: Option<usize>,
    pub bot_enabled: bool,
    pub bot_difficulty: String,
    pub settings: RoomSettings,
    #[serde(skip)]
    pub clients: Vec<ConnectedClient>,
    pub players: [Option<ServerPlayerState>; 2],
    pub projectiles: Vec<ServerProjectile>,
    pub ground_zones: Vec<ServerGroundZone>,
    #[serde(skip)]
    pub events: Vec<GameEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_at: Option<u64>,
}
