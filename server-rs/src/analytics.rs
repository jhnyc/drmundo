use serde_json::{json, Map, Value};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn track_event(event: &str, distinct_id: &str, properties: Map<String, Value>) {
    let ts_ms = now_unix_ms();
    let ts = format!("{ts_ms}");
    let mut entry = properties.clone();
    entry.insert("ts".to_string(), Value::String(ts.clone()));
    entry.insert("event".to_string(), Value::String(event.to_string()));
    entry.insert("distinctId".to_string(), Value::String(distinct_id.to_string()));

    if let Ok(line) = serde_json::to_string(&Value::Object(entry)) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    if let Ok(api_key) = std::env::var("POSTHOG_API_KEY") {
        if api_key.is_empty() {
            return;
        }
        let host = std::env::var("POSTHOG_HOST")
            .unwrap_or_else(|_| "https://us.i.posthog.com".to_string())
            .trim_end_matches('/')
            .to_string();
        let body = json!({
            "api_key": api_key,
            "event": event,
            "distinct_id": distinct_id,
            "properties": properties,
            "timestamp": ts
        })
        .to_string();

        tokio::spawn(async move {
            let _ = tokio::process::Command::new("curl")
                .args([
                    "-sS",
                    "-m",
                    "3",
                    "-X",
                    "POST",
                    "-H",
                    "Content-Type: application/json",
                    "-d",
                    &body,
                    &format!("{host}/capture/"),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        });
    }
}
