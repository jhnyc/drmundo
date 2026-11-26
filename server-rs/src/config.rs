use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellDef {
    #[allow(dead_code)]
    pub id: String,
    pub cooldown_fast: f64,
    pub cooldown_standard: f64,
    #[serde(default)]
    pub range: f64,
    #[serde(default)]
    pub heal_amount: f64,
    #[serde(default)]
    pub speed_boost: f64,
    #[serde(default)]
    pub duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageConfig {
    pub flat_min: f64,
    pub percent_current_hp: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowConfig {
    pub percent: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionStats {
    pub max_hp: f64,
    pub hp_regen_per_sec: f64,
    pub base_move_speed: f64,
    pub hitbox_radius: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QAbilityConfig {
    pub archetype: String,
    pub hp_cost: f64,
    pub refund_on_hit: f64,
    pub cooldown: f64,
    pub cast_time: f64,
    #[serde(default)]
    pub delay: f64,
    pub range: f64,
    #[serde(default)]
    pub speed: f64,
    pub radius: f64,
    #[serde(default)]
    pub spawn_offset: f64,
    pub damage: DamageConfig,
    #[serde(default)]
    pub knockup_duration: f64,
    #[serde(default)]
    pub slow: Option<SlowConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionConfig {
    pub id: String,
    pub name: String,
    pub default_player_name: String,
    pub default_bot_name: String,
    pub stats: ChampionStats,
    pub q: QAbilityConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameplayConfig {
    pub tick_rate: u32,
    pub pit_radius: f64,
    pub line_buffer: f64,
    pub default_champion_id: String,
    pub summoner_spells: HashMap<String, SpellDef>,
    pub champions: HashMap<String, ChampionConfig>,
}

pub fn resolve_project_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    for start in candidates {
        let mut dir: &Path = &start;
        for _ in 0..6 {
            let index_path = dir.join("public").join("index.html");
            let cfg_path = dir.join("shared").join("gameplay-config.json");
            if index_path.is_file() && cfg_path.is_file() {
                return Ok(dir.to_path_buf());
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => break,
            }
        }
    }
    Err("Could not locate project root containing public/index.html and shared/gameplay-config.json".to_string())
}

pub fn load_gameplay_config(project_root: &Path) -> Result<GameplayConfig, String> {
    let raw = std::fs::read_to_string(project_root.join("shared").join("gameplay-config.json"))
        .map_err(|e| format!("Failed reading gameplay-config.json: {e}"))?;
    let mut cfg: GameplayConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid gameplay-config.json: {e}"))?;
    if cfg.tick_rate == 0 {
        cfg.tick_rate = 60;
    }
    if cfg.default_champion_id.is_empty() {
        cfg.default_champion_id = "drmundo".to_string();
    }
    Ok(cfg)
}

impl GameplayConfig {
    pub fn normalize_champion_id(&self, value: &str, fallback: &str) -> String {
        let norm = value.trim().to_lowercase();
        if self.champions.contains_key(&norm) {
            return norm;
        }
        if self.champions.contains_key(fallback) {
            return fallback.to_string();
        }
        self.default_champion_id.clone()
    }

    pub fn get_champion(&self, id: &str) -> &ChampionConfig {
        let norm = self.normalize_champion_id(id, &self.default_champion_id);
        self.champions
            .get(&norm)
            .or_else(|| self.champions.get(&self.default_champion_id))
            .expect("default champion missing in config")
    }

    pub fn get_spell_cooldown(&self, spell_id: &str, fast_cd: bool) -> f64 {
        let spell = self
            .summoner_spells
            .get(spell_id)
            .or_else(|| self.summoner_spells.get("flash"))
            .expect("flash spell missing in config");
        if fast_cd {
            spell.cooldown_fast
        } else {
            spell.cooldown_standard
        }
    }
}

const VALID_SPELLS: [&str; 3] = ["flash", "heal", "ghost"];

pub fn validate_spells(raw: Option<&[String]>) -> [String; 2] {
    let Some(list) = raw else {
        return ["flash".to_string(), "ghost".to_string()];
    };
    let mut filtered: Vec<String> = Vec::with_capacity(2);
    for s in list {
        let id = s.trim().to_lowercase();
        if VALID_SPELLS.contains(&id.as_str()) && !filtered.contains(&id) {
            filtered.push(id);
            if filtered.len() == 2 {
                break;
            }
        }
    }
    for fb in VALID_SPELLS {
        if filtered.len() >= 2 {
            break;
        }
        let fb_s = fb.to_string();
        if !filtered.contains(&fb_s) {
            filtered.push(fb_s);
        }
    }
    let s0 = filtered.first().cloned().unwrap_or_else(|| "flash".to_string());
    let s1 = filtered.get(1).cloned().unwrap_or_else(|| "ghost".to_string());
    [s0, s1]
}

pub fn parse_best_of(val: Option<f64>) -> i32 {
    match val {
        Some(v) if v == 1.0 => 1,
        Some(v) if v == 3.0 => 3,
        Some(v) if v == 5.0 => 5,
        _ => 3,
    }
}
