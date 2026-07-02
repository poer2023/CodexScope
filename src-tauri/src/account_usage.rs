use crate::model::{RateLimitSnapshot, RateLimitWindow};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REFRESH_RETRY_MS: i64 = 2 * 60 * 1000;
const RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
static LAST_REFRESH_ATTEMPT_MS: AtomicI64 = AtomicI64::new(0);
static REFRESH_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSummary {
    pub lifetime_tokens: u64,
    pub peak_daily_tokens: u64,
    pub longest_running_turn_sec: u64,
    pub current_streak_days: u64,
    pub longest_streak_days: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageBucket {
    pub start_date: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub summary: AccountUsageSummary,
    pub daily_usage_buckets: Vec<DailyUsageBucket>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAccountUsage {
    fetched_at_ms: i64,
    usage: AccountUsage,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedRateLimits {
    fetched_at_ms: i64,
    rate_limits: RateLimitSnapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsReadResult {
    rate_limits: AppRateLimits,
    rate_limit_reset_credits: Option<RateLimitResetCredits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitResetCredits {
    available_count: Option<u64>,
}

#[derive(Deserialize)]
struct CodexAuth {
    tokens: Option<CodexAuthTokens>,
}

#[derive(Deserialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct WhamResetCredits {
    available_count: Option<u64>,
    credits: Option<Vec<WhamResetCredit>>,
}

#[derive(Deserialize)]
struct WhamResetCredit {
    status: Option<String>,
    expires_at: Option<String>,
}

struct ResetCreditDetails {
    available_count: Option<u64>,
    expires_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppRateLimits {
    limit_id: String,
    plan_type: String,
    primary: Option<AppRateLimitWindow>,
    secondary: Option<AppRateLimitWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppRateLimitWindow {
    used_percent: f64,
    window_duration_mins: u64,
    resets_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn cache_path() -> Option<PathBuf> {
    let d = dirs::cache_dir()?.join("codexscope");
    let _ = std::fs::create_dir_all(&d);
    Some(d.join("account_usage.json"))
}

fn rate_limits_cache_path() -> Option<PathBuf> {
    let d = dirs::cache_dir()?.join("codexscope");
    let _ = std::fs::create_dir_all(&d);
    Some(d.join("account_rate_limits.json"))
}

fn auth_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(home).join("auth.json"));
    }
    Some(dirs::home_dir()?.join(".codex").join("auth.json"))
}

pub fn load_cached() -> Option<AccountUsage> {
    let t = std::fs::read_to_string(cache_path()?).ok()?;
    serde_json::from_str::<CachedAccountUsage>(&t)
        .ok()
        .map(|c| c.usage)
}

pub fn load_cached_rate_limits() -> Option<RateLimitSnapshot> {
    let t = std::fs::read_to_string(rate_limits_cache_path()?).ok()?;
    serde_json::from_str::<CachedRateLimits>(&t)
        .ok()
        .map(|c| c.rate_limits)
}

fn save_cached(usage: &AccountUsage) {
    let Some(path) = cache_path() else {
        return;
    };
    let cached = CachedAccountUsage {
        fetched_at_ms: now_ms(),
        usage: usage.clone(),
    };
    if let Ok(t) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, t);
    }
}

fn save_cached_rate_limits(rate_limits: &RateLimitSnapshot) {
    let Some(path) = rate_limits_cache_path() else {
        return;
    };
    let cached = CachedRateLimits {
        fetched_at_ms: now_ms(),
        rate_limits: rate_limits.clone(),
    };
    if let Ok(t) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, t);
    }
}

fn codex_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("CODEX_BINARY") {
        return PathBuf::from(p);
    }
    let bundled = PathBuf::from("/Applications/Codex.app/Contents/Resources/codex");
    if bundled.exists() {
        return bundled;
    }
    PathBuf::from("codex")
}

fn wait_for_response(
    rx: &mpsc::Receiver<String>,
    id: u64,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("timed out waiting for app-server response {id}"))?;
        let line = rx
            .recv_timeout(remaining)
            .map_err(|_| format!("timed out waiting for app-server response {id}"))?;
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
            continue;
        }
        if let Some(err) = v.get("error") {
            return Err(format!("app-server response {id} failed: {err}"));
        }
        return v
            .get("result")
            .cloned()
            .ok_or_else(|| format!("app-server response {id} had no result"));
    }
}

fn query_app_server(method: &str, timeout: Duration) -> Result<serde_json::Value, String> {
    let mut child = Command::new(codex_bin())
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start codex app-server: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open app-server stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open app-server stdout".to_string())?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });

    let init = json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "codexscope",
                "title": "CodexScope",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    writeln!(stdin, "{init}").map_err(|e| format!("failed to send initialize: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush initialize: {e}"))?;
    let _ = wait_for_response(&rx, 1, Duration::from_secs(15))?;

    let req = json!({ "id": 2, "method": method });
    writeln!(stdin, "{req}").map_err(|e| format!("failed to send {method} request: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush {method} request: {e}"))?;
    let result = wait_for_response(&rx, 2, timeout)?;

    let _ = child.kill();
    let _ = child.wait();
    Ok(result)
}

fn query_usage() -> Result<AccountUsage, String> {
    let result = query_app_server("account/usage/read", Duration::from_secs(45))?;
    serde_json::from_value::<AccountUsage>(result)
        .map_err(|e| format!("failed to decode usage response: {e}"))
}

fn app_window_to_model(w: AppRateLimitWindow) -> RateLimitWindow {
    RateLimitWindow {
        used_percent: w.used_percent,
        window_minutes: w.window_duration_mins,
        resets_at: w.resets_at,
    }
}

fn parse_rfc3339_unix_seconds(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
}

fn query_reset_credit_details() -> Result<ResetCreditDetails, String> {
    let auth_text = std::fs::read_to_string(
        auth_path().ok_or_else(|| "failed to resolve Codex auth path".to_string())?,
    )
    .map_err(|e| format!("failed to read Codex auth: {e}"))?;
    let auth = serde_json::from_str::<CodexAuth>(&auth_text)
        .map_err(|e| format!("failed to decode Codex auth: {e}"))?;
    let tokens = auth
        .tokens
        .ok_or_else(|| "Codex auth had no tokens".to_string())?;
    let access_token = tokens
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Codex auth had no access token".to_string())?;

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    let mut req = agent
        .get(RESET_CREDITS_URL)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Accept", "application/json")
        .set("originator", "Codex Desktop")
        .set("User-Agent", "CodexScope");
    if let Some(account_id) = tokens.account_id.filter(|s| !s.is_empty()) {
        req = req.set("ChatGPT-Account-ID", &account_id);
    }
    let response = req
        .call()
        .map_err(|e| format!("reset credits request failed: {e}"))?;
    let decoded = response
        .into_json::<WhamResetCredits>()
        .map_err(|e| format!("failed to decode reset credits response: {e}"))?;
    let expires_at = decoded
        .credits
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.status.as_deref() == Some("available"))
        .filter_map(|c| c.expires_at.as_deref().and_then(parse_rfc3339_unix_seconds))
        .min();

    Ok(ResetCreditDetails {
        available_count: decoded.available_count,
        expires_at,
    })
}

fn query_rate_limits() -> Result<RateLimitSnapshot, String> {
    let result = query_app_server("account/rateLimits/read", Duration::from_secs(15))?;
    let decoded = serde_json::from_value::<RateLimitsReadResult>(result)
        .map_err(|e| format!("failed to decode rate limits response: {e}"))?;
    let mut snapshot = RateLimitSnapshot {
        limit_id: decoded.rate_limits.limit_id,
        plan_type: decoded.rate_limits.plan_type,
        primary: decoded.rate_limits.primary.map(app_window_to_model),
        secondary: decoded.rate_limits.secondary.map(app_window_to_model),
        reset_credits_available: decoded
            .rate_limit_reset_credits
            .and_then(|r| r.available_count),
        reset_credits_expires_at: None,
    };
    if let Ok(details) = query_reset_credit_details() {
        snapshot.reset_credits_available =
            details.available_count.or(snapshot.reset_credits_available);
        snapshot.reset_credits_expires_at = details.expires_at;
    }
    Ok(snapshot)
}

pub fn refresh_cache() -> Option<AccountUsage> {
    let now = now_ms();
    if now - LAST_REFRESH_ATTEMPT_MS.load(Ordering::Relaxed) < REFRESH_RETRY_MS {
        return load_cached();
    }
    let Ok(_guard) = REFRESH_LOCK.try_lock() else {
        return load_cached();
    };
    LAST_REFRESH_ATTEMPT_MS.store(now, Ordering::Relaxed);
    match query_usage() {
        Ok(usage) => {
            save_cached(&usage);
            Some(usage)
        }
        Err(_) => load_cached(),
    }
}

pub fn refresh_rate_limits_cache() -> Option<RateLimitSnapshot> {
    match query_rate_limits() {
        Ok(rate_limits) => {
            save_cached_rate_limits(&rate_limits);
            Some(rate_limits)
        }
        Err(_) => load_cached_rate_limits(),
    }
}
