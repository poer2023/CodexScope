// Parse Codex rollout JSONL, aggregate token_count events and tool calls into
// Day / Week / Month reports + a daily heatmap.
use crate::account_usage::AccountUsage;
use crate::model::*;
use crate::pricing::Pricing;
use crate::store::{RateLimitEvent, RawEvent, Store};
use chrono::{DateTime, Datelike, Duration, Local, Timelike};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

// Serializes dashboard builds so the background refresh thread and the command
// handler never touch the incremental cache files concurrently.
static BUILD_LOCK: Mutex<()> = Mutex::new(());

// One Codex usage or tool-call event, with pricing applied.
struct Event {
    ts: DateTime<Local>,
    session: String,
    model: String,
    input: f64,         // raw tokens, uncached new input only
    cache: f64,         // raw tokens, cache creation + read
    output: f64,        // raw tokens
    cost: f64,          // USD (differentiated by token type), 0 if unknown model
    priced: bool,       // whether a price was found for this model
    effort: String,     // Codex reasoning effort from turn_context, when present
    tools: Vec<String>, // Codex tool-call names
}

// Top-5 models keep the Codex-blue depth scale; everything beyond is uniform gray.
const PALETTE: &[&str] = &["#116DC4", "#238BEF", "#339CFF", "#8DCAFF", "#C5E4FF"];
const OVERFLOW_GRAY: &str = "#6E7F90";

/// Strip a trailing "-YYYYMMDD" date suffix so dated releases merge into
/// their base model (e.g. "gpt-5-codex-20260201" -> "gpt-5-codex").
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn normalize_model(name: &str) -> String {
    let name = name.trim();
    if name.eq_ignore_ascii_case("codex") {
        return "unknown".to_string();
    }
    if let Some(idx) = name.rfind('-') {
        let suffix = &name[idx + 1..];
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return name[..idx].to_string();
        }
    }
    name.to_string()
}

fn vendor_of(model: &str) -> &'static str {
    let m = model.to_lowercase();
    if m.contains("claude") {
        "Anthropic"
    } else if m.contains("gpt") || m.contains("o1") || m.contains("o3") || m.contains("codex") {
        "OpenAI"
    } else if m.contains("gemini") {
        "Google"
    } else if m.contains("llama") {
        "Local"
    } else if m.contains("glm") {
        "Zhipu"
    } else if m.contains("deepseek") {
        "DeepSeek"
    } else {
        "Other"
    }
}

pub fn build_dashboard() -> Dashboard {
    let _guard = BUILD_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // 1. Ingest incrementally (full scan only on first run; afterwards just the
    //    appended lines), prune events older than the heatmap window, and persist
    //    only when something actually changed — so an idle tick doesn't rewrite
    //    the entire events.json every 30s.
    let mut store = Store::load();
    let mut dirty = store.ingest();
    // Reports/heatmap span ~26 weeks (+ prev month); 210 days leaves margin.
    let cutoff = (Local::now() - Duration::days(210)).timestamp_millis();
    if store.prune_before(cutoff) {
        dirty = true;
    }
    if dirty {
        store.save();
    }

    // 2. Aggregate: apply current prices and slice by current time.
    // Memoized price table (cheap clone); loaded/refreshed off-thread elsewhere
    // so neither parsing nor the network runs while we hold BUILD_LOCK.
    let pricing = Pricing::shared();
    let events: Vec<Event> = store
        .events
        .iter()
        .map(|r| compute_event(r, &pricing))
        .collect();
    let account_usage = crate::account_usage::load_cached();
    let rate_limits = crate::account_usage::load_cached_rate_limits()
        .or_else(|| latest_rate_limits(&store.events));

    let now = Local::now();
    let today = now.date_naive();

    let day = report_day(&events, now);
    let week = report_week(&events, now);
    let month = report_month(&events, now);
    let heatmap = build_heatmap(&events, today, account_usage.as_ref());
    let profile = build_profile(&events, today, account_usage.as_ref());

    // today's displayed tokens (M) for the tray
    let local_today_tokens: f64 = events
        .iter()
        .filter(|e| e.ts.date_naive() == today)
        .map(|e| (e.input + e.cache + e.output) / 1e6)
        .sum();
    let today_tokens = account_usage
        .as_ref()
        .and_then(|u| account_tokens_for_day(u, today))
        .unwrap_or(local_today_tokens);

    Dashboard {
        day,
        week,
        month,
        heatmap,
        profile,
        today_tokens,
        generated_at: now.to_rfc3339(),
        rate_limits,
    }
}

fn compute_event(r: &RawEvent, pricing: &Pricing) -> Event {
    let ts = DateTime::from_timestamp_millis(r.ts_ms)
        .unwrap_or_default()
        .with_timezone(&Local);
    let model = normalize_model(&r.model);
    // price lookup uses the raw (possibly dated) id, then the normalized one
    let cost_opt = pricing
        .cost(&r.model, r.in_tok, r.out_tok, r.cc, r.cr)
        .or_else(|| pricing.cost(&model, r.in_tok, r.out_tok, r.cc, r.cr));
    Event {
        ts,
        session: r.session.clone(),
        model,
        input: r.in_tok,
        cache: r.cc + r.cr,
        output: r.out_tok,
        cost: cost_opt.unwrap_or(0.0),
        priced: cost_opt.is_some(),
        effort: r.effort.clone(),
        tools: r.tools.clone(),
    }
}

fn latest_rate_limits(events: &[RawEvent]) -> Option<RateLimitSnapshot> {
    let mut latest_codex: Option<(i64, &RateLimitEvent)> = None;
    let mut latest_any: Option<(i64, &RateLimitEvent)> = None;

    for e in events {
        let Some(r) = e.rate_limit.as_ref() else {
            continue;
        };
        let item = (e.ts_ms, r);
        if latest_any.map(|(ts, _)| e.ts_ms > ts).unwrap_or(true) {
            latest_any = Some(item);
        }
        if r.limit_id == "codex" && latest_codex.map(|(ts, _)| e.ts_ms > ts).unwrap_or(true) {
            latest_codex = Some(item);
        }
    }

    let (_, r) = latest_codex.or(latest_any)?;
    Some(rate_snapshot(r))
}

fn rate_snapshot(r: &RateLimitEvent) -> RateLimitSnapshot {
    fn rate_window_snapshot(w: &crate::store::RateLimitWindowEvent) -> RateLimitWindow {
        RateLimitWindow {
            used_percent: w.used_percent,
            window_minutes: w.window_minutes,
            resets_at: w.resets_at,
        }
    }
    RateLimitSnapshot {
        limit_id: r.limit_id.clone(),
        plan_type: r.plan_type.clone(),
        primary: r.primary.as_ref().map(rate_window_snapshot),
        secondary: r.secondary.as_ref().map(rate_window_snapshot),
        reset_credits_available: None,
        reset_credits_expires_at: None,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn account_tokens_for_day(usage: &AccountUsage, day: chrono::NaiveDate) -> Option<f64> {
    let key = day.format("%Y-%m-%d").to_string();
    usage
        .daily_usage_buckets
        .iter()
        .find(|b| b.start_date == key)
        .map(|b| b.tokens as f64 / 1e6)
}

fn build_profile(
    events: &[Event],
    today: chrono::NaiveDate,
    account_usage: Option<&AccountUsage>,
) -> ProfileStats {
    let mut total_tokens = 0.0;
    let mut by_day: HashMap<chrono::NaiveDate, f64> = HashMap::new();
    let mut sessions: HashMap<String, (i64, i64)> = HashMap::new();
    let mut effort_counts: HashMap<String, u64> = HashMap::new();
    let mut effort_total = 0u64;
    let mut low_effort = 0u64;
    let mut tool_counts: HashMap<String, u64> = HashMap::new();

    for e in events {
        let tok = e.input + e.cache + e.output;
        if tok > 0.0 {
            total_tokens += tok;
            *by_day.entry(e.ts.date_naive()).or_default() += tok / 1e6;
            if !e.effort.is_empty() {
                effort_total += 1;
                *effort_counts.entry(e.effort.clone()).or_default() += 1;
                if matches!(e.effort.as_str(), "none" | "minimal" | "low") {
                    low_effort += 1;
                }
            }
        }
        if !e.session.is_empty() {
            let ts = e.ts.timestamp_millis();
            sessions
                .entry(e.session.clone())
                .and_modify(|(min_ts, max_ts)| {
                    *min_ts = (*min_ts).min(ts);
                    *max_ts = (*max_ts).max(ts);
                })
                .or_insert((ts, ts));
        }
        for tool in &e.tools {
            *tool_counts.entry(tool.clone()).or_default() += 1;
        }
    }

    let peak_day_tokens = by_day.values().copied().fold(0.0, f64::max);
    let active_days: HashSet<_> = by_day
        .iter()
        .filter_map(|(d, tok)| if *tok > 0.0 { Some(*d) } else { None })
        .collect();

    let mut current_streak = 0u64;
    let mut d = today;
    while active_days.contains(&d) {
        current_streak += 1;
        d -= Duration::days(1);
    }

    let mut days: Vec<_> = active_days.iter().copied().collect();
    days.sort_unstable();
    let mut longest_streak = 0u64;
    let mut run = 0u64;
    let mut prev = None;
    for d in days {
        run = if prev.map(|p| d == p + Duration::days(1)).unwrap_or(false) {
            run + 1
        } else {
            1
        };
        longest_streak = longest_streak.max(run);
        prev = Some(d);
    }

    let longest_task_minutes = sessions
        .values()
        .map(|(min_ts, max_ts)| ((*max_ts - *min_ts).max(0) / 60_000) as u64)
        .max()
        .unwrap_or(0);
    let top_effort = effort_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(effort, _)| effort)
        .unwrap_or_default();
    let (
        source,
        cumulative_tokens,
        peak_day_tokens,
        longest_task_minutes,
        current_streak_days,
        longest_streak_days,
    ) = if let Some(usage) = account_usage {
        (
            "account".to_string(),
            round2(usage.summary.lifetime_tokens as f64 / 1e6),
            round2(usage.summary.peak_daily_tokens as f64 / 1e6),
            (usage.summary.longest_running_turn_sec / 60) as u64,
            usage.summary.current_streak_days,
            usage.summary.longest_streak_days,
        )
    } else {
        (
            "logs".to_string(),
            round2(total_tokens / 1e6),
            round2(peak_day_tokens),
            longest_task_minutes,
            current_streak,
            longest_streak,
        )
    };

    ProfileStats {
        source,
        cumulative_tokens,
        peak_day_tokens,
        longest_task_minutes,
        current_streak_days,
        longest_streak_days,
        low_effort_percent: if effort_total > 0 {
            round2((low_effort as f64 / effort_total as f64) * 100.0)
        } else {
            0.0
        },
        top_effort,
        explored_tools: tool_counts.len() as u64,
        total_tool_runs: tool_counts.values().sum(),
        total_sessions: sessions.len() as u64,
        top_tools: Agg::named(&tool_counts).into_iter().take(5).collect(),
    }
}

// ── aggregation helpers ────────────────────────────────────────────
#[derive(Default)]
struct Agg {
    input: f64,
    cache: f64,
    output: f64,
    cost: f64,
    requests: u64,
    sessions: HashSet<String>,
    tool_calls: u64,
    model_tok: HashMap<String, f64>,
    model_cost: HashMap<String, f64>,
    model_priced: HashMap<String, bool>,
    tool_counts: HashMap<String, u64>,
}

impl Agg {
    fn add(&mut self, e: &Event) {
        self.input += e.input;
        self.cache += e.cache;
        self.output += e.output;
        self.cost += e.cost;
        if !e.session.is_empty() {
            self.sessions.insert(e.session.clone());
        }
        // Tool-only events carry no model (empty) — they're not LLM requests,
        // so they must not inflate request counts or the model split.
        if !e.model.is_empty() {
            self.requests += 1;
            // model totals keep all token types so shares sum to Total tokens
            *self.model_tok.entry(e.model.clone()).or_default() += e.input + e.cache + e.output;
            *self.model_cost.entry(e.model.clone()).or_default() += e.cost;
            // a model is "priced" if any of its messages had a known price
            *self.model_priced.entry(e.model.clone()).or_default() |= e.priced;
        }
        for s in &e.tools {
            self.tool_calls += 1;
            *self.tool_counts.entry(s.clone()).or_default() += 1;
        }
    }

    fn models(&self) -> Vec<ModelStat> {
        let mut v: Vec<(String, f64, f64)> = self
            .model_tok
            .iter()
            .map(|(k, t)| (k.clone(), *t, *self.model_cost.get(k).unwrap_or(&0.0)))
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter()
            .enumerate()
            .map(|(i, (name, tok, cost))| {
                let priced = *self.model_priced.get(&name).unwrap_or(&false);
                ModelStat {
                    vendor: vendor_of(&name).to_string(),
                    tokens: (tok / 1e6 * 100.0).round() / 100.0,
                    cost: (cost * 100.0).round() / 100.0,
                    color: if i < PALETTE.len() {
                        PALETTE[i]
                    } else {
                        OVERFLOW_GRAY
                    }
                    .to_string(),
                    priced,
                    name,
                }
            })
            .collect()
    }

    fn named(counts: &HashMap<String, u64>) -> Vec<NamedCount> {
        let mut v: Vec<NamedCount> = counts
            .iter()
            .map(|(k, c)| NamedCount {
                name: k.clone(),
                count: *c,
            })
            .collect();
        v.sort_by(|a, b| b.count.cmp(&a.count));
        v
    }

    fn metrics(&self, delta_tokens: f64, delta_cost: f64) -> Metrics {
        Metrics {
            total_tokens: ((self.input + self.cache + self.output) / 1e6 * 100.0).round() / 100.0,
            input_tokens: (self.input / 1e6 * 100.0).round() / 100.0,
            cache_tokens: (self.cache / 1e6 * 100.0).round() / 100.0,
            output_tokens: (self.output / 1e6 * 100.0).round() / 100.0,
            cost: (self.cost * 100.0).round() / 100.0,
            tool_calls: self.tool_calls,
            requests: self.requests,
            sessions: self.sessions.len() as u64,
            delta_tokens,
            delta_cost,
            unique_tools: self.tool_counts.len() as u64,
        }
    }
}

/// Percentage change of `cur` vs `prev`, e.g. +20.0 for a 20% increase,
/// rounded to 2 decimals. Returns 0 when there's no baseline to compare.
fn pct_delta(cur: f64, prev: f64) -> f64 {
    if prev <= 0.0 {
        return 0.0;
    }
    ((cur - prev) / prev * 10000.0).round() / 100.0
}

// ── Day report: today, 24 hourly buckets ───────────────────────────
fn report_day(events: &[Event], now: DateTime<Local>) -> PeriodReport {
    let today = now.date_naive();
    let yesterday = today - Duration::days(1);
    let mut agg = Agg::default();
    let mut prev = Agg::default();
    let mut buckets = vec![(0.0f64, 0.0f64, 0.0f64); 24]; // (input, cache, output) M
    let mut req_b = vec![0.0f64; 24];
    let mut cost_b = vec![0.0f64; 24];

    for e in events {
        let d = e.ts.date_naive();
        if d == today {
            agg.add(e);
            let h = e.ts.hour() as usize;
            buckets[h].0 += e.input / 1e6;
            buckets[h].1 += e.cache / 1e6;
            buckets[h].2 += e.output / 1e6;
            // Match Agg::add exactly: only the request COUNT excludes model-less
            // (slash-command) events; total cost accumulates unconditionally
            // (those events carry cost 0, so this is identical today).
            if !e.model.is_empty() {
                req_b[h] += 1.0;
            }
            cost_b[h] += e.cost;
        } else if d == yesterday {
            prev.add(e);
        }
    }

    let series = (0..24)
        .map(|h| SeriesPoint {
            // axis ticks every 4h, skipping the 00/24 endpoints
            label: if h % 4 == 0 && h != 0 {
                format!("{:02}", h)
            } else {
                String::new()
            },
            full: format!("{:02}:00", h),
            input: buckets[h].0,
            cache: buckets[h].1,
            output: buckets[h].2,
        })
        .collect();

    PeriodReport {
        metrics: agg.metrics(
            pct_delta(
                agg.input + agg.cache + agg.output,
                prev.input + prev.cache + prev.output,
            ),
            pct_delta(agg.cost, prev.cost),
        ),
        series,
        models: agg.models(),
        tools: Agg::named(&agg.tool_counts),
        req_trend: req_b,
        cost_trend: cost_b,
    }
}

// ── Week report: current calendar week (Mon-Sun) vs previous week ────
fn report_week(events: &[Event], now: DateTime<Local>) -> PeriodReport {
    let today = now.date_naive();
    // Monday of the current week (Mon=0 … Sun=6).
    let start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let next_start = start + Duration::days(7);
    let prev_start = start - Duration::days(7);

    let mut agg = Agg::default();
    let mut prev = Agg::default();
    let mut buckets = vec![(0.0f64, 0.0f64, 0.0f64); 7];
    let mut req_b = vec![0.0f64; 7];
    let mut cost_b = vec![0.0f64; 7];

    for e in events {
        let d = e.ts.date_naive();
        if d >= start && d < next_start {
            agg.add(e);
            let idx = (d - start).num_days() as usize;
            if idx < buckets.len() {
                buckets[idx].0 += e.input / 1e6;
                buckets[idx].1 += e.cache / 1e6;
                buckets[idx].2 += e.output / 1e6;
                // Match Agg::add: only the request COUNT excludes model-less
                // events; cost accumulates unconditionally (their cost is 0).
                if !e.model.is_empty() {
                    req_b[idx] += 1.0;
                }
                cost_b[idx] += e.cost;
            }
        } else if d >= prev_start && d < start {
            prev.add(e);
        }
    }

    let weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let series = (0..7usize)
        .map(|i| {
            let date = start + Duration::days(i as i64);
            let wd = weekday[i];
            SeriesPoint {
                label: wd.to_string(),
                full: format!(
                    "{} {} {}",
                    wd,
                    MONTHS[(date.month() - 1) as usize],
                    date.day()
                ),
                input: buckets[i].0,
                cache: buckets[i].1,
                output: buckets[i].2,
            }
        })
        .collect();

    PeriodReport {
        metrics: agg.metrics(
            pct_delta(
                agg.input + agg.cache + agg.output,
                prev.input + prev.cache + prev.output,
            ),
            pct_delta(agg.cost, prev.cost),
        ),
        series,
        models: agg.models(),
        tools: Agg::named(&agg.tool_counts),
        req_trend: req_b,
        cost_trend: cost_b,
    }
}

// ── Month report: current calendar month vs previous calendar month ──
fn report_month(events: &[Event], now: DateTime<Local>) -> PeriodReport {
    use chrono::NaiveDate;
    let today = now.date_naive();
    let (y, m) = (today.year(), today.month());
    let cur_first = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
    let next_first = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1).unwrap()
    };
    let (py, pm) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
    let prev_first = NaiveDate::from_ymd_opt(py, pm, 1).unwrap();
    let days_in_month = (next_first - cur_first).num_days() as usize;

    let mut agg = Agg::default();
    let mut prev = Agg::default();
    let mut buckets = vec![(0.0f64, 0.0f64, 0.0f64); days_in_month];
    let mut req_b = vec![0.0f64; days_in_month];
    let mut cost_b = vec![0.0f64; days_in_month];

    for e in events {
        let d = e.ts.date_naive();
        if d >= cur_first && d < next_first {
            agg.add(e);
            let idx = (d - cur_first).num_days() as usize;
            if idx < buckets.len() {
                buckets[idx].0 += e.input / 1e6;
                buckets[idx].1 += e.cache / 1e6;
                buckets[idx].2 += e.output / 1e6;
                // Match Agg::add: only the request COUNT excludes model-less
                // events; cost accumulates unconditionally (their cost is 0).
                if !e.model.is_empty() {
                    req_b[idx] += 1.0;
                }
                cost_b[idx] += e.cost;
            }
        } else if d >= prev_first && d < cur_first {
            prev.add(e);
        }
    }

    let series = (0..days_in_month)
        .map(|i| {
            let dn = (i + 1) as u32;
            let label = if i == 0 || dn % 5 == 0 {
                dn.to_string()
            } else {
                String::new()
            };
            SeriesPoint {
                label,
                full: format!("{} {}", MONTHS[(m - 1) as usize], dn),
                input: buckets[i].0,
                cache: buckets[i].1,
                output: buckets[i].2,
            }
        })
        .collect();

    PeriodReport {
        metrics: agg.metrics(
            pct_delta(
                agg.input + agg.cache + agg.output,
                prev.input + prev.cache + prev.output,
            ),
            pct_delta(agg.cost, prev.cost),
        ),
        series,
        models: agg.models(),
        tools: Agg::named(&agg.tool_counts),
        req_trend: req_b,
        cost_trend: cost_b,
    }
}

// ── Heatmap: last ~26 weeks daily totals ────────────────────────────
fn build_heatmap(
    events: &[Event],
    today: chrono::NaiveDate,
    account_usage: Option<&AccountUsage>,
) -> Vec<HeatDay> {
    let start = today - Duration::days(25 * 7 + today.weekday().num_days_from_sunday() as i64);
    let mut by_day: HashMap<chrono::NaiveDate, f64> = HashMap::new();
    if let Some(usage) = account_usage {
        for bucket in &usage.daily_usage_buckets {
            let Ok(d) = chrono::NaiveDate::parse_from_str(&bucket.start_date, "%Y-%m-%d") else {
                continue;
            };
            if d >= start && d <= today {
                *by_day.entry(d).or_default() += bucket.tokens as f64 / 1e6;
            }
        }
    } else {
        for e in events {
            let d = e.ts.date_naive();
            if d >= start && d <= today {
                *by_day.entry(d).or_default() += (e.input + e.cache + e.output) / 1e6;
            }
        }
    }
    let mut days = Vec::new();
    let mut d = start;
    let mut maxv = 0.0f64;
    while d <= today {
        let t = *by_day.get(&d).unwrap_or(&0.0);
        maxv = maxv.max(t);
        days.push((d, t));
        d += Duration::days(1);
    }
    days.into_iter()
        .map(|(date, tokens)| {
            let f = if maxv > 0.0 { tokens / maxv } else { 0.0 };
            let level = if tokens == 0.0 {
                0
            } else if f < 0.25 {
                1
            } else if f < 0.5 {
                2
            } else if f < 0.75 {
                3
            } else {
                4
            };
            HeatDay {
                date: date.format("%Y-%m-%d").to_string(),
                tokens: (tokens * 100.0).round() / 100.0,
                level,
            }
        })
        .collect()
}
