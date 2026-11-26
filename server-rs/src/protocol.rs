use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    pub best_of: i32,
    pub cooldown_mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMatchStats {
    #[serde(default, alias = "cleaversThrown")]
    pub abilities_cast: i32,
    #[serde(default, alias = "cleaversHit")]
    pub abilities_hit: i32,
    #[serde(default)]
    pub damage_dealt: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyPlayerInfo {
    pub slot: usize,
    pub name: String,
    pub champion_id: String,
    pub is_bot: bool,
    pub ready: bool,
    pub spells: [String; 2],
    pub score: i32,
    pub stats: PlayerMatchStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    pub id: String,
    pub host_name: String,
    pub player_count: usize,
    pub has_passcode: bool,
    pub state: String,
    pub best_of: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLobbyPayload {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub room_id: String,
    pub champion_id: String,
    pub has_passcode: bool,
    pub passcode: String,
    pub state: String,
    pub round: i32,
    pub settings: RoomSettings,
    pub bot_enabled: bool,
    pub bot_difficulty: String,
    pub players: [Option<LobbyPlayerInfo>; 2],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshotRef<'a> {
    pub slot: usize,
    pub name: &'a str,
    pub champion_id: &'a str,
    pub x: f64,
    pub z: f64,
    pub target_x: f64,
    pub target_z: f64,
    pub angle: f64,
    pub hp: f64,
    pub max_hp: f64,
    pub alive: bool,
    pub anim: &'a str,
    pub q_cd: f64,
    pub max_q_cd: f64,
    pub spell_cd: [f64; 2],
    pub max_spell_cd: [f64; 2],
    pub spells: [&'a str; 2],
    pub slow_timer: f64,
    pub slow_percent: f64,
    pub knockup_timer: f64,
    pub knockup_duration: f64,
    pub ghost_timer: f64,
    pub heal_speed_timer: f64,
    pub score: i32,
    pub stats: &'a PlayerMatchStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectileSnapshotRef<'a> {
    pub id: i64,
    pub owner_slot: usize,
    pub champion_id: &'a str,
    pub x: f64,
    pub z: f64,
    pub dir_x: f64,
    pub dir_z: f64,
    pub speed: f64,
    pub radius: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundZoneSnapshotRef<'a> {
    pub id: i64,
    pub owner_slot: usize,
    pub champion_id: &'a str,
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub remaining: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GameEvent {
    RoundCountdown {
        round: i32,
    },
    FightStart {
        round: i32,
    },
    QWindup {
        slot: usize,
        #[serde(rename = "championId")]
        champion_id: String,
        x: f64,
        z: f64,
        #[serde(rename = "targetX")]
        target_x: f64,
        #[serde(rename = "targetZ")]
        target_z: f64,
        #[serde(rename = "dirX")]
        dir_x: f64,
        #[serde(rename = "dirZ")]
        dir_z: f64,
    },
    QLaunch {
        slot: usize,
        #[serde(rename = "championId")]
        champion_id: String,
        #[serde(rename = "projId")]
        proj_id: i64,
        x: f64,
        z: f64,
        #[serde(rename = "dirX")]
        dir_x: f64,
        #[serde(rename = "dirZ")]
        dir_z: f64,
    },
    QHit {
        #[serde(rename = "projId", skip_serializing_if = "Option::is_none")]
        proj_id: Option<i64>,
        #[serde(rename = "zoneId", skip_serializing_if = "Option::is_none")]
        zone_id: Option<i64>,
        #[serde(rename = "attackerSlot")]
        attacker_slot: usize,
        #[serde(rename = "attackerChampionId")]
        attacker_champion_id: String,
        #[serde(rename = "victimSlot")]
        victim_slot: usize,
        x: f64,
        z: f64,
        damage: i64,
        refund: i64,
        #[serde(rename = "knockupDuration", skip_serializing_if = "Option::is_none")]
        knockup_duration: Option<f64>,
    },
    QMiss {
        #[serde(rename = "projId", skip_serializing_if = "Option::is_none")]
        proj_id: Option<i64>,
        #[serde(rename = "zoneId", skip_serializing_if = "Option::is_none")]
        zone_id: Option<i64>,
        #[serde(rename = "attackerSlot")]
        attacker_slot: usize,
        #[serde(rename = "attackerChampionId")]
        attacker_champion_id: String,
        x: f64,
        z: f64,
    },
    ZoneSpawn {
        #[serde(rename = "zoneId")]
        zone_id: i64,
        #[serde(rename = "ownerSlot")]
        owner_slot: usize,
        #[serde(rename = "championId")]
        champion_id: String,
        x: f64,
        z: f64,
        radius: f64,
        duration: f64,
    },
    ZoneErupt {
        #[serde(rename = "zoneId")]
        zone_id: i64,
        #[serde(rename = "ownerSlot")]
        owner_slot: usize,
        #[serde(rename = "championId")]
        champion_id: String,
        x: f64,
        z: f64,
        radius: f64,
        #[serde(rename = "hitVictim")]
        hit_victim: bool,
    },
    SpellFlash {
        slot: usize,
        #[serde(rename = "fromX")]
        from_x: f64,
        #[serde(rename = "fromZ")]
        from_z: f64,
        #[serde(rename = "toX")]
        to_x: f64,
        #[serde(rename = "toZ")]
        to_z: f64,
    },
    SpellHeal {
        slot: usize,
        x: f64,
        z: f64,
        amount: i64,
    },
    SpellGhost {
        slot: usize,
        x: f64,
        z: f64,
        duration: f64,
    },
    RoundKill {
        #[serde(rename = "winnerSlot")]
        winner_slot: usize,
        #[serde(rename = "loserSlot")]
        loser_slot: usize,
        round: i32,
        scores: [i32; 2],
        #[serde(rename = "matchOver")]
        match_over: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshotRef<'a> {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub state: &'a str,
    pub round: i32,
    pub countdown_timer: f64,
    pub players: [Option<PlayerSnapshotRef<'a>>; 2],
    pub projectiles: Vec<ProjectileSnapshotRef<'a>>,
    pub ground_zones: Vec<GroundZoneSnapshotRef<'a>>,
    pub events: &'a [GameEvent],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedRoomMsg {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub room_id: String,
    pub slot: usize,
    pub passcode: String,
    pub lobby: RoomLobbyPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorMsg {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCheckResultMsg {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub exists: bool,
    pub room_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_passcode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PongMsg {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub t: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub room_id: Option<String>,
    pub custom_code: Option<String>,
    pub name: Option<String>,
    pub champion_id: Option<String>,
    pub passcode: Option<String>,
    pub best_of: Option<f64>,
    pub cooldown_mode: Option<String>,
    pub spells: Option<Vec<String>>,
    #[serde(default)]
    pub with_bot: bool,
    #[serde(default)]
    pub ready: bool,
    pub x: Option<f64>,
    pub z: Option<f64>,
    pub spell_index: Option<f64>,
    pub emote: Option<String>,
    pub t: Option<f64>,
}
