import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { domToPng } from "modern-screenshot";
import {
  Dashboard, PeriodReport, ModelStat, Theme, TH,
  fetchDashboard, fmtInt, fmtTokens,
} from "./data";
import {
  TokenGlyph, Segmented, BarChart, Sparkline, CostDonut, BarList, Heatmap,
} from "./charts";

// Count up to `target`. Restarts from 0 whenever `resetKey` changes (popover
// open / period switch); on a live value change it eases from the current
// value to the new one instead of snapping back to 0.
function useCountUp(target: number, resetKey: string, active: boolean, duration = 850): number {
  const [val, setVal] = useState(0);
  const valRef = useRef(0);
  const keyRef = useRef<string | null>(null);
  const rafRef = useRef(0);
  // useLayoutEffect so the reset-to-0 is committed *before* the browser paints
  // (otherwise the old/final value flashes for a frame before counting up).
  useLayoutEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const set = (v: number) => { valRef.current = v; setVal(v); };
    // while the popover is hidden, hold at 0 so the next open starts clean
    if (!active) { keyRef.current = null; set(0); return; }
    const reset = keyRef.current !== resetKey;
    keyRef.current = resetKey;
    // open / period switch → start from 0 (paint it now); live update → ease
    // from the current value to the new one.
    let from = valRef.current;
    if (reset) { from = 0; set(0); }
    const start = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      set(from + (target - from) * ease(p));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [resetKey, target, active, duration]);
  return val;
}

function Delta({ v, theme }: { v: number; theme: Theme }) {
  const up = v >= 0;
  // Usage/cost going up is "bad" → red; going down is "good" → theme accent.
  const col = up ? "#e0795f" : theme.accent;
  return (
    <span style={{ font: `600 10px ${theme.mono}`, color: col, display: "inline-flex", alignItems: "center", gap: 2,
      padding: "1.5px 5px", borderRadius: 5, background: up ? "rgba(224,121,95,0.16)" : "rgba(51,156,255,0.14)" }}>
      {up ? "▲" : "▼"}{Math.abs(Math.round(v))}%
    </span>
  );
}

// Round each value's share to 1 decimal (%) via largest-remainder apportionment,
// so the displayed percentages sum to exactly 100.0% (plain rounding wouldn't).
function sharePcts(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const UNITS = 1000; // work in 0.1% units; target is 100.0%
  const raw = values.map((v) => (v / total) * UNITS);
  const units = raw.map(Math.floor);
  const left = Math.round(UNITS - units.reduce((s, f) => s + f, 0));
  raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, left)
    .forEach(({ i }) => (units[i] += 1));
  return units.map((u) => u / 10);
}

function ModelRow({ m, max, theme, share }: { m: ModelStat; max: number; theme: Theme; share: number }) {
  // 1-decimal share; whole numbers drop the ".0" (100% not 100.0%).
  const pctStr = share % 1 === 0 ? share.toFixed(0) : share.toFixed(1);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: m.color, flex: "0 0 auto" }} />
      <div style={{ minWidth: 0, flex: "0 0 118px" }}>
        <div style={{ font: `500 11.5px ${theme.ui}`, color: theme.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</div>
      </div>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: theme.gridLine, overflow: "hidden" }}>
        <div style={{ width: `${(m.tokens / max) * 100}%`, height: "100%", background: m.color, borderRadius: 3 }} />
      </div>
      <span style={{ font: `500 10.5px ${theme.mono}`, color: theme.dim, flex: "0 0 auto", width: 42, textAlign: "right" }}>{fmtTokens(m.tokens)}</span>
      <span style={{ font: `600 10.5px ${theme.mono}`, color: theme.text, flex: "0 0 auto", width: 40, textAlign: "right" }}>{pctStr}%</span>
    </div>
  );
}

function MiniStat({ label, value, sub, theme, accent, children }:
  { label: string; value: string; sub?: string; theme: Theme; accent?: string; children?: React.ReactNode }) {
  return (
    <div style={{ background: theme.gridLine, borderRadius: 9, padding: "9px 10px", minWidth: 0 }}>
      <div style={{ font: `500 9.5px ${theme.ui}`, color: theme.dim, letterSpacing: ".04em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 3, gap: 6 }}>
        <span style={{ font: `600 17px/1 ${theme.mono}`, color: accent || theme.text, whiteSpace: "nowrap" }}>{value}</span>
        {children}
      </div>
      {sub && <div style={{ font: `500 9px ${theme.mono}`, color: theme.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function windowLabel(minutes: number) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function remainingPct(used?: number) {
  if (typeof used !== "number" || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, 100 - used));
}

function resetCreditExpiryLabel(unixSeconds?: number | null) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function durationLabel(minutes: number) {
  if (minutes <= 0) return "0m";
  const total = Math.round(minutes);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function fmtProfileTokens(m: number) {
  if (m >= 1000) {
    const b = m / 1000;
    return `${b >= 10 ? b.toFixed(1) : b.toFixed(2)}B`;
  }
  return fmtTokens(m);
}

function effortLabel(effort: string) {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Ultra",
  };
  return labels[effort] || (effort ? effort : "—");
}

// Input/Cached/Output legend: full words by default, abbreviated only
// when the row would otherwise overflow the available width.
function SplitLegend({ t, inputM, cacheM, outputM }:
  { t: Theme; inputM: number; cacheM: number; outputM: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const key = `${inputM}|${cacheM}|${outputM}`;
  const parts = [
    { label: "Input", compact: "In", color: t.accent, value: inputM },
    ...(cacheM > 0 ? [{ label: "Cached", compact: "Cache", color: t.cacheCol, value: cacheM }] : []),
    { label: "Output", compact: "Out", color: t.accentSoft, value: outputM },
  ];
  // reset to full labels whenever the numbers change, then re-measure
  useLayoutEffect(() => { setCompact(false); }, [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !compact && el.scrollWidth > el.clientWidth + 1) setCompact(true);
  });
  return (
    <div ref={ref} style={{
      display: "flex", alignItems: "center", gap: 10,
      font: `500 10px ${t.mono}`, color: t.dim, marginBottom: 14, whiteSpace: "nowrap", overflow: "hidden",
    }}>
      {parts.map((p) => (
        <span key={p.label}><span style={{ color: p.color }}>●</span> {compact ? p.compact : p.label} {p.value.toFixed(2)}M</span>
      ))}
    </div>
  );
}

const SectionRule = ({ t, m = "12px 0 10px" }: { t: Theme; m?: string }) => (
  <div style={{ height: 1, background: t.gridLine, margin: m }} />
);
const Label = ({ t, children }: { t: Theme; children: React.ReactNode }) => (
  <span style={{ font: `600 10px ${t.ui}`, color: t.dim, letterSpacing: ".05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>
);

function ThemeToggle({ pref, theme, onCycle }: { pref: "dark" | "light" | "system"; theme: Theme; onCycle: () => void }) {
  const t = theme;
  // Single button cycling Dark → Light → System; the icon shows the current mode.
  const label = pref === "system" ? "System" : pref === "dark" ? "Dark" : "Light";
  return (
    <button onClick={onCycle} title={`Theme: ${label} (click to change)`} aria-label={`theme: ${label}`} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 26, height: 26, borderRadius: 7, cursor: "pointer", padding: 0,
      background: t.segBg, border: `1px solid ${t.segBorder}`, color: t.dim,
    }}>
      {pref === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.dim} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6" />
        </svg>
      ) : pref === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill={t.dim} stroke="none">
          <path d="M21 12.9A9 9 0 1 1 11.1 3a7.2 7.2 0 0 0 9.9 9.9z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.dim} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="12.5" rx="1.6" />
          <path d="M8.5 20.5h7M12 17v3.5" />
        </svg>
      )}
    </button>
  );
}

function ScreenshotButton({ theme, busy, onClick }: { theme: Theme; busy: boolean; onClick: () => void }) {
  const t = theme;
  return (
    <button onClick={onClick} disabled={busy} title="Save screenshot to Desktop" aria-label="save screenshot" style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 26, height: 26, borderRadius: 7, cursor: busy ? "default" : "pointer", padding: 0,
      background: t.segBg, border: `1px solid ${t.segBorder}`, color: t.dim,
    }}>
      {busy ? (
        <svg className="om-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.dim} strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.dim} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.6A1.5 1.5 0 0 1 9.5 4h5a1.5 1.5 0 0 1 1.2.4L16.8 6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
          <circle cx="12" cy="12.2" r="3.4" />
        </svg>
      )}
    </button>
  );
}

function AppMenuButton({ theme, onRefresh, showToast }: {
  theme: Theme;
  onRefresh: () => Promise<void>;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const t = theme;
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!inTauri) {
      setAutostart(false);
      return;
    }
    invoke<boolean>("get_autostart_enabled")
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, [inTauri]);

  const itemStyle: CSSProperties = {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "8px 9px",
    border: 0,
    borderRadius: 7,
    background: "transparent",
    color: t.text,
    font: `600 11.5px ${t.ui}`,
    cursor: busy ? "default" : "pointer",
    textAlign: "left",
  };
  const checkStyle: CSSProperties = {
    width: 14,
    height: 14,
    borderRadius: 4,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${autostart ? t.accent : t.segBorder}`,
    background: autostart ? t.accent : t.segBg,
    color: "#fff",
    font: `700 10px ${t.ui}`,
    flex: "0 0 auto",
  };

  const doRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRefresh();
      setOpen(false);
      showToast("Refreshed", true);
    } catch {
      showToast("Refresh failed", false);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutostart = async () => {
    if (busy || !inTauri) return;
    const next = !(autostart ?? false);
    setBusy(true);
    try {
      const actual = await invoke<boolean>("set_autostart_enabled", { enabled: next });
      setAutostart(actual);
      showToast(actual ? "Launch at Login on" : "Launch at Login off", true);
    } catch {
      showToast("Launch setting failed", false);
    } finally {
      setBusy(false);
    }
  };

  const quit = () => {
    if (!inTauri) return;
    invoke("quit_app").catch(() => showToast("Quit failed", false));
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} title="Menu" aria-label="menu" aria-haspopup="menu" aria-expanded={open} style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, borderRadius: 7, cursor: "pointer", padding: 0,
        background: open ? t.segOnBg : t.segBg, border: `1px solid ${t.segBorder}`, color: t.dim,
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.dim} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="5" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="12" cy="19" r="1.4" />
        </svg>
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: 32, zIndex: 30,
          width: 184, padding: 5, borderRadius: 10,
          background: darkenMenuBg(t), border: `1px solid ${t.segBorder}`,
          boxShadow: "0 14px 36px rgba(0,0,0,0.28)",
        }}>
          <button role="menuitem" disabled={busy} onClick={doRefresh} style={itemStyle}>
            <span>Refresh</span>
            {busy && <span style={{ color: t.faint, font: `600 10px ${t.mono}` }}>...</span>}
          </button>
          <button role="menuitemcheckbox" aria-checked={!!autostart} disabled={busy || !inTauri} onClick={toggleAutostart} style={itemStyle}>
            <span>Launch at Login</span>
            <span style={checkStyle}>{autostart ? "✓" : ""}</span>
          </button>
          <div style={{ height: 1, background: t.gridLine, margin: "4px 3px" }} />
          <button role="menuitem" onClick={quit} style={{ ...itemStyle, color: "#e0795f" }}>
            <span>Quit</span>
          </button>
        </div>
      )}
    </div>
  );
}

function darkenMenuBg(t: Theme) {
  return t.card === "#181818" ? "rgba(28,28,28,0.98)" : "rgba(255,255,255,0.98)";
}

function Panel({ dash, dark, themePref, onToggleTheme, onRefresh, openGen, active }: {
  dash: Dashboard;
  dark: boolean;
  themePref: "dark" | "light" | "system";
  onToggleTheme: () => void;
  onRefresh: () => Promise<void>;
  openGen: number;
  active: boolean;
}) {
  const t = TH[dark ? "dark" : "light"];
  // Drag the popover by its body (Windows/Linux only — macOS uses the menu-bar
  // NSPanel and is gated out). A real OS window-drag begins only once the
  // pointer moves past a small threshold, so a plain click still clicks through
  // / dismisses and never arms the hide-suppression guard.
  const canDrag = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !navigator.userAgent.includes("Macintosh");
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [period, setPeriod] = useState<"Day" | "Week" | "Month">("Week");
  const P: PeriodReport = period === "Day" ? dash.day : period === "Month" ? dash.month : dash.week;
  const M = P.metrics;
  // animated Total tokens: counts up from 0 on each open / period switch;
  // held at 0 while the popover is hidden so it never flashes the final value.
  const animTotal = useCountUp(M.totalTokens, `${period}:${openGen}`, active);
  const models = P.models;
  // Hide noise: 0% token-share rows, and $0 entries in the cost donut.
  // Show models whose share is at least 0.1% when rounded to 1 decimal; below
  // that it'd render a meaningless "0.0%" (a negligible token share). Such a
  // model can still appear under Cost if it has a non-zero cost.
  const tokenModels = models.filter(
    (m) => Math.round((m.tokens / (M.totalTokens || 1)) * 1000) / 10 >= 0.1
  );
  const costModels = models.filter((m) => m.cost > 0);
  // models that were used but have no pricing entry (cost unknown, not $0)
  const unpricedModels = models.filter((m) => !m.priced && m.tokens > 0);
  const maxM = Math.max(...tokenModels.map((m) => m.tokens), 1e-9);
  const tokenShares = tokenModels.map(
    (m) => Math.round((m.tokens / (M.totalTokens || 1)) * 1000) / 10
  );
  const trendSub = { Day: "today 24h", Week: "this week", Month: "this month" }[period];
  const primaryLimit = dash.rateLimits?.primary || null;
  const secondaryLimit = dash.rateLimits?.secondary || null;
  const primaryRemaining = primaryLimit ? remainingPct(primaryLimit.usedPercent) : 0;
  const secondaryRemaining = secondaryLimit ? remainingPct(secondaryLimit.usedPercent) : 0;
  const quotaSub = primaryLimit
    ? `${windowLabel(primaryLimit.windowMinutes)}${secondaryLimit ? ` · week ${Math.round(secondaryRemaining)}%` : ""}`
    : dash.rateLimits?.planType || undefined;
  const resetCredits = dash.rateLimits?.resetCreditsAvailable ?? null;
  const resetCreditExpiry = dash.rateLimits?.resetCreditsExpiresAt ?? null;
  const resetSub = resetCredits !== null
    ? resetCredits > 0 && resetCreditExpiry
      ? `expires ${resetCreditExpiryLabel(resetCreditExpiry)}`
      : resetCredits > 0
        ? "available now"
        : "none available"
    : undefined;
  const globalTools = dash.profile?.topTools || [];
  const globalToolRuns = dash.profile?.totalToolRuns || 0;
  const globalToolUnique = dash.profile?.exploredTools || 0;

  // screenshot capture: rasterize the full panel card to a PNG and hand it to
  // the Rust `save_screenshot` command (browser preview falls back to a download).
  const [shotBusy, setShotBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string, ok: boolean) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };
  const captureScreenshot = async () => {
    if (shotBusy) return;
    const el = document.querySelector<HTMLElement>(".om-scroll");
    if (!el) { showToast("Nothing to capture", false); return; }
    setShotBusy(true);
    try {
      // explicit width/height = full scrollable content, not just the viewport;
      // filter drops the capture button itself (and its in-flight spinner) so
      // the saved image is a clean dashboard, not a shot of the button.
      const dataUrl = await domToPng(el, {
        scale: 2,
        backgroundColor: dark ? "#181818" : "#ffffff",
        width: el.scrollWidth,
        height: el.scrollHeight,
        filter: (n) => !(n instanceof HTMLElement && n.getAttribute("aria-label") === "save screenshot"),
      });
      const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (inTauri) {
        await invoke<string>("save_screenshot", { dataUrl });
        showToast("Saved to Desktop", true);
      } else {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = "codexscope.png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast("Downloaded", true);
      }
    } catch {
      showToast("Screenshot failed", false);
    } finally {
      setShotBusy(false);
    }
  };

  return (
    <div style={{
      width: "100%", height: "100vh", overflow: "hidden", boxSizing: "border-box",
      position: "relative",
      background: "transparent", padding: 0,
      fontFamily: t.ui,
    }}>
      <div className="om-scroll"
        onMouseDown={canDrag ? (e) => {
          // Record the press; the real drag only starts once the pointer moves
          // past the threshold (onMouseMove). Skip interactive controls
          // (data-no-drag) and non-left buttons so clicks still register.
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
          dragRef.current = { x: e.clientX, y: e.clientY };
        } : undefined}
        onMouseMove={canDrag ? (e) => {
          const s = dragRef.current;
          if (!s) return;
          const dx = e.clientX - s.x, dy = e.clientY - s.y;
          if (dx * dx + dy * dy >= 16) { // ~4px → a drag, not a click
            dragRef.current = null;
            invoke("begin_drag").catch(() => {});
          }
        } : undefined}
        onMouseUp={canDrag ? () => { dragRef.current = null; } : undefined}
        style={{
        width: "100%", height: "100%", overflowY: "auto",
        borderRadius: 12, background: dark ? "#181818" : "#ffffff",
        border: `1px solid ${dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)"}`,
        padding: 0, color: t.text, cursor: canDrag ? "grab" : undefined,
      }}>
        {/* sticky header — stays put while the body scrolls */}
        <div style={{
          position: "sticky", top: 0, zIndex: 10,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "15px 15px 12px",
          background: dark ? "#181818" : "#ffffff",
          borderBottom: `1px solid ${t.gridLine}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TokenGlyph color={t.accent} size={16} />
            <span style={{ font: `600 13px ${t.ui}`, color: t.text, letterSpacing: ".01em" }}>CodexScope</span>
          </div>
          <div data-no-drag="" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "default" }}>
            <Segmented value={period} theme={t} onSelect={(v) => setPeriod(v as any)} />
            <ThemeToggle pref={themePref} theme={t} onCycle={onToggleTheme} />
            <ScreenshotButton theme={t} busy={shotBusy} onClick={captureScreenshot} />
            <AppMenuButton theme={t} onRefresh={onRefresh} showToast={showToast} />
          </div>
        </div>
        {/* scrolling body */}
        <div style={{ padding: "14px 15px 15px" }}>
        {/* hero */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div style={{ font: `500 10px ${t.ui}`, color: t.dim, letterSpacing: ".04em", textTransform: "uppercase" }}>Total tokens</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 3 }}>
              <span style={{ font: `600 30px ${t.mono}`, color: t.text, letterSpacing: "-.01em" }}>{animTotal.toFixed(2)}<span style={{ font: `500 15px ${t.mono}`, color: t.dim, marginLeft: 2 }}>M</span></span>
              {Math.round(M.deltaTokens) !== 0 && <Delta v={M.deltaTokens} theme={t} />}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ font: `500 10px ${t.ui}`, color: t.dim }}>Est. API value</div>
            <div style={{ font: `600 18px ${t.mono}`, color: t.accent, marginTop: 2 }}>${M.cost.toFixed(2)}</div>
          </div>
        </div>
        {/* input / cached input / output split.
            When there's no usage the bar is just the empty track (no slivers). */}
        <div style={{ display: "flex", gap: 0, height: 7, borderRadius: 4, overflow: "hidden", marginBottom: 5, background: t.gridLine }}>
          {M.totalTokens > 0 && <>
            <div style={{ flexGrow: Math.max(M.inputTokens, 1e-6), flexBasis: 0, minWidth: 4, background: t.accent }} />
            {M.cacheTokens > 0 && <div style={{ flexGrow: Math.max(M.cacheTokens, 1e-6), flexBasis: 0, minWidth: 4, background: t.cacheCol }} />}
            <div style={{ flexGrow: Math.max(M.outputTokens, 1e-6), flexBasis: 0, minWidth: 4, background: t.accentSoft }} />
          </>}
        </div>
        <SplitLegend t={t} inputM={M.inputTokens} cacheM={M.cacheTokens} outputM={M.outputTokens} />
        {/* bar chart */}
        <BarChart data={P.series} theme={t} height={84} />
        <SectionRule t={t} m="14px 0 10px" />
        {/* models */}
        <div style={{ marginBottom: 4 }}><Label t={t}>Tokens by model</Label></div>
        {tokenModels.length === 0 && <div style={{ font: `500 10.5px ${t.mono}`, color: t.faint, padding: "4px 0" }}>No usage in this period</div>}
        {tokenModels.map((m, i) => <ModelRow key={i} m={m} max={maxM} theme={t} share={tokenShares[i]} />)}
        <SectionRule t={t} m="10px 0 10px" />
        {/* estimated API value donut */}
        <div style={{ marginBottom: 8 }}><Label t={t}>API value by model</Label></div>
        {costModels.length > 0
          ? <CostDonut models={costModels} theme={t} size={100} thickness={15} />
          : <div style={{ font: `500 10.5px ${t.mono}`, color: t.faint }}>—</div>}
        {unpricedModels.length > 0 && (
          <div style={{ marginTop: 9, font: `500 9.5px/1.5 ${t.mono}`, color: t.faint }}>
            {unpricedModels.length} model{unpricedModels.length > 1 ? "s" : ""} without pricing data (value not counted):{" "}
            <span style={{ color: t.dim }}>{unpricedModels.map((m) => m.name).join(", ")}</span>
          </div>
        )}
        <SectionRule t={t} m="12px 0 12px" />
        {/* footer stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <MiniStat label="Responses" value={fmtInt(M.requests)} sub={`${M.sessions} threads`} theme={t}>
            <Sparkline values={P.reqTrend.length ? P.reqTrend : [0, 0]} theme={t} width={52} height={20} accent={t.accent} />
          </MiniStat>
          <MiniStat label="API value" value={`$${M.cost.toFixed(2)}`} sub={trendSub} theme={t} accent={t.accent}>
            <Sparkline values={P.costTrend.length ? P.costTrend : [0, 0]} theme={t} width={52} height={20} accent={t.accent} />
          </MiniStat>
          {primaryLimit && (
            <MiniStat label="Usage left" value={`${Math.round(primaryRemaining)}%`} sub={quotaSub} theme={t} accent={primaryRemaining <= 20 ? "#e0795f" : t.accent} />
          )}
          {resetCredits !== null && (
            <MiniStat label="Resets" value={fmtInt(resetCredits)} sub={resetSub} theme={t} accent={t.accent} />
          )}
        </div>
        {/* Profile-like lifetime stats from retained Codex logs */}
        {dash.profile && (
          <>
            <SectionRule t={t} />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <Label t={t}>Profile stats</Label>
              <span style={{ font: `500 10px ${t.mono}`, color: t.faint, whiteSpace: "nowrap" }}>
                {dash.profile.source === "account" ? "account usage" : "retained logs"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <MiniStat label="All tokens" value={fmtProfileTokens(dash.profile.cumulativeTokens)} sub={dash.profile.source === "account" ? "account lifetime" : "retained logs"} theme={t} />
              <MiniStat label="Peak day" value={fmtProfileTokens(dash.profile.peakDayTokens)} sub="max tokens/day" theme={t} accent={t.accent} />
              <MiniStat label="Longest thread" value={durationLabel(dash.profile.longestTaskMinutes)} sub="observed span" theme={t} />
              <MiniStat label="Streak" value={`${dash.profile.currentStreakDays}d`} sub={`best ${dash.profile.longestStreakDays}d`} theme={t} />
              <MiniStat label="Top effort" value={effortLabel(dash.profile.topEffort)} sub={dash.profile.topEffort ? `${Math.round(dash.profile.lowEffortPercent)}% quick-mode` : "not in logs"} theme={t} />
              <MiniStat label="Threads" value={fmtInt(dash.profile.totalSessions)} sub={`${fmtInt(dash.profile.totalToolRuns)} tool runs`} theme={t} />
            </div>
            {dash.profile.topTools.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "10px 0 7px" }}>
                  <Label t={t}>Tool calls</Label>
                  <span style={{ font: `500 10px ${t.mono}`, color: t.faint, whiteSpace: "nowrap" }}><span style={{ color: t.text, fontWeight: 600 }}>{fmtInt(globalToolRuns)}</span> · {fmtInt(globalToolUnique)} unique</span>
                </div>
                <BarList items={globalTools} theme={t} accent={t.accent} />
              </>
            )}
          </>
        )}
        {/* heatmap */}
        <SectionRule t={t} />
        <div style={{ marginBottom: 9 }}><Label t={t}>Daily activity</Label></div>
        <Heatmap days={dash.heatmap} theme={t} accent={t.accent} />
        {/* footer note */}
        <div style={{ marginTop: 12, font: `500 8.5px ${t.mono}`, color: t.faint, textAlign: "center" }}>
          Est. API value via OpenAI API prices, then models.dev / LiteLLM · ChatGPT subscription billing may differ
        </div>
        </div>{/* /scrolling body */}
      </div>
      {toast && (
        <div className="om-toast" style={{
          position: "absolute", top: 58, left: "50%", transform: "translateX(-50%)",
          zIndex: 20, whiteSpace: "nowrap", pointerEvents: "none",
          font: `600 12px ${t.mono}`, color: "#fff",
          background: toast.ok ? t.accent : "#e0795f",
          padding: "7px 13px", borderRadius: 9,
          boxShadow: "0 8px 22px rgba(0,0,0,0.34)",
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openGen, setOpenGen] = useState(0);
  const [focused, setFocused] = useState(true); // browser preview: always "focused"
  // Theme preference: explicit Dark / Light, or System (follows the OS
  // appearance live on both macOS and Windows via prefers-color-scheme). First
  // run defaults to System.
  const [themePref, setThemePref] = useState<"dark" | "light" | "system">(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("codexscope-theme") : null;
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
    return "system";
  });
  const [systemDark, setSystemDark] = useState<boolean>(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  // Follow the OS appearance live while in System mode (and keep it current for
  // an instant switch back to System).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const dark = themePref === "system" ? systemDark : themePref === "dark";
  // Cycle Dark → Light → System on each click; persist the choice.
  const cycleTheme = () =>
    setThemePref((p) => {
      const n = p === "dark" ? "light" : p === "light" ? "system" : "dark";
      try { localStorage.setItem("codexscope-theme", n); } catch {}
      return n;
    });

  useEffect(() => {
    // Apply fresh data AND clear any stale error: a transient initial-load
    // failure must not pin the error page for the whole session — the next
    // successful fetch (focus refetch or the 30s background push) recovers it.
    const apply = (d: Dashboard) => {
      setDash(d);
      setErr(null);
    };
    // initial load (shows the Loading state only until the first data arrives)
    fetchDashboard().then(apply).catch((e) => setErr(String(e)));

    const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!inTauri) return;
    // Under StrictMode the effect mounts → cleans up → remounts; the async
    // listen()/onFocusChanged() promises can resolve after the first cleanup,
    // so unregister any late arrival immediately instead of leaking a duplicate.
    let dead = false;
    const unlisten: Array<() => void> = [];
    const track = (u: () => void) => {
      if (dead) u();
      else unlisten.push(u);
    };
    // live updates pushed from the background refresh thread — swaps the data in
    // place (no Loading), so values update without any flicker.
    listen<Dashboard>("dashboard-updated", (e) => apply(e.payload)).then(track);
    // System appearance pushed natively from Rust (macOS). The webview's
    // prefers-color-scheme is unreliable for our hidden, non-activating menu-bar
    // panel, so the native event is the source of truth for System mode there;
    // it fires once at startup (correcting any stale launch value) and on every
    // OS theme change. Harmlessly never fires on Windows, where matchMedia works.
    listen<boolean>("system-theme", (e) => setSystemDark(e.payload)).then(track);
    // refetch the instant the popover gains focus (i.e. is opened)
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        setFocused(focused);
        if (focused) {
          setOpenGen((g) => g + 1); // re-run the count-up on each open
          fetchDashboard().then(apply).catch(() => {});
        }
      })
      .then(track);
    return () => {
      dead = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  // window is transparent; the rounded card paints its own background
  useEffect(() => {
    document.body.style.background = "transparent";
  }, [dark]);

  // Suppress per-property CSS transitions across a theme flip so the panel
  // repaints in the new theme in one step instead of cross-fading each color
  // (see .ts-no-transition in main.tsx). A background light→dark switch lands
  // while the panel is hidden; rAF callbacks don't run while hidden, so the
  // class stays on until the popover is shown — the first painted frame is
  // already the new theme with no transition, then we strip it a couple of
  // frames later so live interactions (e.g. switching the period) animate as
  // before. Skipped on the very first render (no prior frame to cross-fade).
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) {
      firstThemeRun.current = false;
      return;
    }
    const el = document.documentElement;
    el.classList.add("ts-no-transition");
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => el.classList.remove("ts-no-transition"))
    );
    return () => cancelAnimationFrame(id);
  }, [dark]);

  const t = TH[dark ? "dark" : "light"];
  if (err) {
    return <div style={{ padding: 20, font: `500 12px ${t.mono}`, color: "#e0795f" }}>Failed to load: {err}</div>;
  }
  if (!dash) {
    return (
      <div style={{ height: "100vh", padding: 10, boxSizing: "border-box", background: "transparent" }}>
        <div style={{ height: "100%", borderRadius: 14, background: dark ? "#181818" : "#ffffff",
          display: "flex", alignItems: "center", justifyContent: "center",
          font: `500 12px ${t.mono}`, color: t.dim }}>Loading…</div>
      </div>
    );
  }
  const refreshDashboard = async () => {
    const d = await fetchDashboard();
    setDash(d);
    setErr(null);
  };

  return <Panel dash={dash} dark={dark} themePref={themePref} onToggleTheme={cycleTheme} onRefresh={refreshDashboard} openGen={openGen} active={focused} />;
}
