"use strict";
// Bumparr operator dashboard. One script, no build step, no dependencies.
//
// Section order (kept stable so later slices land in a predictable place):
//   1  constants and state          7  Library
//   2  safe DOM helpers             8  Composer / playback preview
//   3  API, error and abort         9  Station
//   4  routing                     10  Operations and jobs
//   5  shared components           11  lifecycle, visibility, boot
//   6  Overview                    12  CommonJS exports for tests

// ---------------------------------------------------------------------------
// 1. Constants and state
// ---------------------------------------------------------------------------

const PAGE = 24;                    // rows per library page (UI maximum 100)
const API_TIMEOUT_MS = 15000;       // ordinary reads only; jobs opt out
const SEARCH_DEBOUNCE_MS = 250;
const REFRESH_MS = 20000;
const JOB_POLL_MS = 3000;
const JOB_BACKOFF_MS = 10000;
const MAX_NOTICES = 20;

// One explicit state object, divided by concern. The DOM is never the state:
// every render below can be repeated from this object alone.
//
// Beyond the shared shape, `library.generation` is the filter counter that
// lets a late answer be discarded, `*.updatedAt` is what a stale panel shows,
// and `library.source` records whether the grid is a filtered listing or a
// shuffle draw (they have different empty messages).
function initialState() {
  return {
    route: "overview",
    status: { value: null, loading: false, error: null, updatedAt: null },
    station: { value: null, loading: false, error: null, updatedAt: null },
    library: {
      filters: { q: "", kind: null, type: null, state: "all" },
      items: [], offset: 0, hasMore: false, loading: false, error: null,
      selectedId: null, generation: 0, updatedAt: null, source: "listing",
    },
    composer: {
      seconds: 30, tolerance: 1.5, maxItems: 8,
      placement: "any", types: [], result: null, loading: false, error: null,
      updatedAt: null, retry: null, loadingLabel: "",
    },
    jobs: { items: [], polling: new Map(), error: null },
    notices: [],
  };
}

const STATE = initialState();

let searchTimer = null;
let libraryAbort = null;
let refreshTimer = null;
// One counter per job surface: a superseded wait abandons its poll and stops
// writing, so it can neither overwrite newer feedback nor poll forever.
let askGeneration = 0;
let actionGeneration = 0;

// ---------------------------------------------------------------------------
// 2. Safe DOM helpers
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const makeEl = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

function setBusy(el, busy) {
  if (el && el.setAttribute) el.setAttribute("aria-busy", busy ? "true" : "false");
}

const now = () => Date.now();

// ---------------------------------------------------------------------------
// 3. API, error and abort helpers
// ---------------------------------------------------------------------------

// Normalized failure: `{status, message}` with a message safe to show a human.
// name is "AbortError" only for a caller's cancellation, so a superseded search
// can be told apart from a real failure.
function apiError(status, message, name) {
  const err = new Error(message);
  err.name = name || "ApiError";
  err.status = status;
  return err;
}

const isApiAbort = (err) => Boolean(err) && err.name === "AbortError";

// Server strings are untrusted: one line, bounded, never markup (callers put
// this through textContent, never innerHTML).
function humanMessage(value, fallback) {
  const text = typeof value === "string" ? value : "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return flat.length > 297 ? flat.slice(0, 297) + "…" : flat;
}

function httpMessage(status) {
  if (status === 404) return "Not found (404).";
  if (status === 409) return "Conflict (409).";
  if (status >= 500) return "Server error (" + status + ").";
  return "Request failed (" + status + ").";
}

// Works with a real Response and with a stub that only offers json().
async function readBody(response) {
  if (typeof response.text === "function") {
    let text = "";
    try { text = await response.text(); } catch (e) { return { ok: false, body: null }; }
    if (!text) return { ok: true, body: null };
    try { return { ok: true, body: JSON.parse(text) }; }
    catch (e) { return { ok: false, body: null }; }
  }
  if (typeof response.json === "function") {
    try { return { ok: true, body: await response.json() }; }
    catch (e) { return { ok: false, body: null }; }
  }
  return { ok: true, body: null };
}

// The single door to the API. `options.timeout` is milliseconds; 0 disables the
// clock, which is what job POSTs want — they return a job id immediately and
// polling owns the long wait.
async function api(path, options) {
  const opts = Object.assign({}, options || {});
  const timeout = opts.timeout === undefined ? API_TIMEOUT_MS : opts.timeout;
  const callerSignal = opts.signal || null;
  delete opts.timeout;

  const controller = new AbortController();
  opts.signal = controller.signal;
  let timedOut = false;
  let timer = null;
  const relay = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", relay);
  }
  if (timeout > 0) {
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  }

  let response;
  try {
    response = await fetch(path, opts);
  } catch (e) {
    if (timedOut) throw apiError(0, "The server did not answer in time.");
    if (callerSignal && callerSignal.aborted) {
      throw apiError(0, "Request cancelled.", "AbortError");
    }
    throw apiError(0, "Bumparr could not be reached.");
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", relay);
  }

  const parsed = await readBody(response);
  if (!response.ok) {
    const served = parsed.body && typeof parsed.body === "object" ? parsed.body.error : "";
    throw apiError(response.status, humanMessage(served, httpMessage(response.status)));
  }
  if (!parsed.ok) {
    throw apiError(response.status || 0,
      "The server sent an answer Bumparr could not read.");
  }
  return parsed.body;
}

// ---------------------------------------------------------------------------
// 4. Routing
// ---------------------------------------------------------------------------
// The dashboard is one page today; STATE.route names the only view. Hash
// routing, aria-current and per-route teardown arrive in the routing slice.

// ---------------------------------------------------------------------------
// 5. Shared components: badges, panel states, notices, cards
// ---------------------------------------------------------------------------

// Icon and word first, colour last: a status must survive a monochrome screen.
const STATUS_LEVELS = {
  healthy: { icon: "✓", word: "Healthy" },
  working: { icon: "◐", word: "Working" },
  attention: { icon: "▲", word: "Attention" },
  failed: { icon: "✕", word: "Failed" },
  offline: { icon: "⌁", word: "Offline" },
};

function statusBadge(level, detail) {
  const spec = STATUS_LEVELS[level] || STATUS_LEVELS.attention;
  const root = makeEl("span", "badge badge-" + (STATUS_LEVELS[level] ? level : "attention"));
  const icon = makeEl("span", "badge-icon", spec.icon);
  icon.setAttribute("aria-hidden", "true");
  root.append(icon, makeEl("span", "badge-word", spec.word));
  if (detail !== undefined && detail !== null && detail !== "") {
    root.append(makeEl("span", "badge-detail", detail));
  }
  return root;
}

// A job surface: one badge plus whatever escape controls the poller offers.
// `dataset.state` carries the job's level here rather than a panel data state
// (loading/populated/…); the caller hands the region back to renderPanelState
// once the job ends.
function renderJobState(el, level, message, actions) {
  if (!el) return null;
  const nodes = [statusBadge(level, message)];
  (actions || []).forEach((action) => {
    const button = makeEl("button", "mini", action.label);
    button.addEventListener("click", action.onClick);
    nodes.push(button);
  });
  el.className = "panel-state";
  el.dataset.state = level;
  el.hidden = false;
  setBusy(el, level === "working");
  el.replaceChildren(...nodes);
  return el;
}

function formatAge(then, at) {
  if (typeof then !== "number" || !isFinite(then)) return "an unknown time ago";
  const seconds = Math.max(0, Math.round(((at === undefined ? now() : at) - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
  return Math.round(seconds / 86400) + "d ago";
}

function formatDuration(seconds) {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!isFinite(n) || n < 0 || seconds === null || seconds === undefined || seconds === "") {
    return "unknown length";
  }
  const whole = Math.round(n);
  if (whole < 60) return whole + "s";
  const mins = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return mins + "m " + rest + "s";
}

const PANEL_STATES = ["loading", "populated", "empty", "error", "stale"];

// One region, one state. `el` is a panel's status strip; the panel's own
// content is left alone, so last-known-good rows survive a failed refresh.
function renderPanelState(el, options) {
  if (!el) return null;
  const opts = options || {};
  const state = PANEL_STATES.indexOf(opts.state) === -1 ? "loading" : opts.state;
  el.replaceChildren();
  el.className = "panel-state panel-state-" + state;
  el.dataset.state = state;
  el.hidden = state === "populated";
  setBusy(el, state === "loading");
  if (state === "populated") return el;

  if (state === "loading") {
    el.append(statusBadge("working", opts.message || "Loading…"));
    return el;
  }
  if (state === "empty") {
    el.append(makeEl("p", "panel-state-msg", opts.message || "Nothing here yet."));
  } else if (state === "error") {
    el.append(statusBadge("failed", opts.message || "Something went wrong."));
  } else {
    el.append(statusBadge("attention",
      "Showing the last known data from " + formatAge(opts.updatedAt, opts.now) + "."));
    if (opts.message) el.append(makeEl("p", "panel-state-msg", opts.message));
  }
  if (typeof opts.onAction === "function") {
    const button = makeEl("button", "panel-retry", opts.actionLabel || "Retry");
    button.addEventListener("click", opts.onAction);
    el.append(button);
  }
  return el;
}

// The tail of the last action, kept for scrollback.
function log(message) {
  const el = $("#log");
  if (!el) return;
  el.textContent = (message + "\n" + el.textContent).slice(0, 4000);
}

// Short results go to assistive technology first and the scrollback second.
function announce(message) {
  const text = String(message);
  STATE.notices.push({ text, at: now() });
  if (STATE.notices.length > MAX_NOTICES) STATE.notices.shift();
  const live = $("#live-region");
  if (live) live.textContent = text;
  log(text);
}

function provenanceLine(b) {
  const p = b.payload || {};
  const bits = [];
  [b.source, p.source, p.bg_creator, p.bg_title].forEach((value) => {
    const text = value == null ? "" : String(value);
    if (text && bits.indexOf(text) === -1) bits.push(text);
  });
  return bits.join(" · ");
}

function freshnessLine(b) {
  const p = b.payload || {};
  if (!p || typeof p !== "object") return "";
  const bits = [];
  if (p.channel != null && String(p.channel)) bits.push(String(p.channel));
  if (p.generated_at != null && p.generated_at !== "") {
    bits.push("generated " + String(p.generated_at));
  }
  if (p.valid_until != null && p.valid_until !== "") {
    bits.push("valid until " + String(p.valid_until));
  } else if (p.generated_at != null && p.generated_at !== "") {
    bits.push("no expiry");
  }
  if (b.enabled === 0 || b.enabled === false) bits.push("parked");
  return bits.join(" · ");
}

function creditsLine(b) {
  const c = b.music_credits || (b.payload && b.payload.music_credits) || {};
  if (!c || typeof c !== "object") return "";
  const bits = [];
  [c.title, c.creator, c.license].forEach((value) => {
    const text = value == null ? "" : String(value);
    if (text && bits.indexOf(text) === -1) bits.push(text);
  });
  if (!bits.length && c.id) bits.push(String(c.id));
  return bits.join(" · ");
}

function creativeLine(b) {
  const cr = b.creative || {};
  const bits = [cr.family, cr.template, cr.brand_mode, cr.energy, cr.audio]
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (cr.text_heavy) bits.push("text-heavy");
  return bits.join(" · ");
}

function factorsLine(b) {
  const f = b.selection && b.selection.factors;
  if (!f) return "";
  const parts = ["base", "season", "daypart", "recency", "affinity", "fatigue"]
    .filter((key) => f[key] !== undefined)
    .map((key) => key + " " + f[key]);
  if (f.score !== undefined) parts.push("score " + f.score);
  return parts.join(" · ");
}

const rowLabel = (b) => String(b.title || b.kind || b.id || "this bumper").slice(0, 60);

function decorateCard(card, b) {
  const cr = creativeLine(b);
  if (cr) card.append(makeEl("div", "pv-creative", cr));
  const cred = creditsLine(b);
  if (cred) card.append(makeEl("div", "pv-credits", cred));
  const prov = provenanceLine(b);
  if (prov) card.append(makeEl("div", "pv-meta", prov));
  const fac = factorsLine(b);
  if (fac) card.append(makeEl("div", "pv-factors", fac));
  const fresh = freshnessLine(b);
  if (fresh) card.append(makeEl("div", "pv-freshness", fresh));
}

// Destructive, so it is a named button and always visible: a control that only
// exists on hover is no control at all by keyboard or on a touch screen.
function addDelete(el, b) {
  const x = makeEl("button", "pv-del", "✕");
  x.setAttribute("aria-label", "Delete " + rowLabel(b));
  x.title = "Delete " + rowLabel(b);
  x.addEventListener("click", (ev) => { ev.stopPropagation(); deleteBumper(b, el); });
  el.appendChild(x);
}

// Only a row KNOWN to be parked gets the control. /api/bumpers returns `enabled`
// as 0/1, so falsy is the parked test — but only when the key is actually there.
// /api/bumpers/random (the shuffle preview) omits it entirely and returns none
// but live rows, so a missing value must mean "no button", not "parked": an
// action control appears on evidence of a park, never on the absence of data.
function addEnable(el, b) {
  if (b.enabled === undefined || b.enabled === null || b.enabled) return;
  const x = makeEl("button", "fchip pv-enable", "✓ enable");
  x.setAttribute("aria-label", "Turn " + rowLabel(b) + " back on");
  x.title = "Parked — turn this bumper back on";
  x.addEventListener("click", (ev) => { ev.stopPropagation(); enableBumper(b); });
  el.appendChild(x);
}

function cardEl(b) {
  const card = makeEl("div", "pv-card");
  if (b.type === "video") {
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "metadata";
    v.src = String(b.media_url || "") + "#t=2";
    const body = makeEl("div", "pv-body");
    body.append(makeEl("div", "pv-kind", b.kind || ""),
                makeEl("div", "pv-title", b.title || ""),
                makeEl("div", "pv-meta", formatDuration(b.duration) + " · video"));
    card.append(v, body);
    card.addEventListener("mouseenter", () => v.play().catch(() => {}));
    card.addEventListener("mouseleave", () => { v.pause(); });
  } else if (b.type === "stream") {
    const body = makeEl("div", "pv-body");
    body.append(makeEl("div", "pv-kind", b.kind || ""),
                makeEl("div", "pv-title", b.title || ""),
                makeEl("div", "pv-meta", "live stream"));
    card.append(makeEl("div", "pv-stream", "◉ LIVE"), body);
  } else {
    const p = b.payload || {};
    const txt = p.lines ? p.lines.join("\n") : (p.number || p.text || b.title || "");
    card.className = "pv-card pv-textcard";
    card.append(makeEl("div", "pv-kind", b.kind || ""), makeEl("div", "tc", txt));
  }
  decorateCard(card, b);
  addDelete(card, b);
  addEnable(card, b);
  return card;
}

// ---------------------------------------------------------------------------
// 6. Overview
// ---------------------------------------------------------------------------

const TYPE_COLOR = { video: "var(--accent)", stream: "var(--warning)",
                     card: "var(--info)", image: "var(--accent-strong)" };

function renderStatusPill() {
  const pill = $("#status-pill");
  if (!pill) return;
  const s = STATE.status.value;
  if (STATE.status.error && !s) {
    pill.replaceChildren(statusBadge("offline", STATE.status.error));
    return;
  }
  if (STATE.status.error) {
    pill.replaceChildren(statusBadge("offline",
      "last read " + formatAge(STATE.status.updatedAt)));
    return;
  }
  if (!s) {
    pill.replaceChildren(statusBadge("working", "reading the pool…"));
    return;
  }
  const detail = s.total + " bumpers · " + s.playable_now + " live";
  pill.replaceChildren(statusBadge(s.total > 0 ? "healthy" : "attention", detail));
}

function renderTotals(s) {
  const totals = $("#totals");
  if (!totals) return;
  totals.replaceChildren();
  [[s.total, "total"], [s.playable_now, "playable now"],
   [Object.keys(s.by_kind || {}).length, "kinds"]].forEach(([n, label]) => {
    const box = makeEl("div", "num", n);
    box.appendChild(makeEl("small", "", label));
    totals.appendChild(box);
  });
}

function renderByType(s) {
  const typeBox = $("#by-type");
  if (!typeBox) return;
  typeBox.replaceChildren();
  const byType = s.by_type || {};
  const max = Math.max(1, ...Object.values(byType));
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    const bar = makeEl("div", "bar"), track = makeEl("span", "track"), fill = makeEl("span", "fill");
    fill.style.width = (100 * n / max) + "%";
    fill.style.background = TYPE_COLOR[t] || "var(--accent)";
    track.appendChild(fill);
    bar.append(makeEl("span", "name", t), track, makeEl("span", "n", n));
    typeBox.appendChild(bar);
  });
}

function renderMemory(s) {
  const memEl = $("#memory-status");
  if (!memEl) return;
  memEl.replaceChildren();
  const mem = s.memory;
  if (!mem || typeof mem !== "object") {
    memEl.appendChild(makeEl("div", "", "memory · Not available in this version."));
    return;
  }
  const kinds = Array.isArray(mem.enabled_kinds) ? mem.enabled_kinds : [];
  const msgs = mem.messages && typeof mem.messages === "object" ? mem.messages : {};
  const refresh = mem.refresh_seconds === 0 ? "refresh off"
    : ("refresh " + String(mem.refresh_seconds) + "s");
  const kindText = kinds.length ? kinds.join(", ") : "no kinds";
  const msgState = msgs.valid === false ? "messages invalid" : "messages ok";
  const disabled = kinds.length ? "" : " · disabled";
  memEl.appendChild(makeEl("div", "",
    "memory · " + refresh + " · " + kindText + " · " + msgState + disabled));
}

function renderOverviewState() {
  const el = $("#pool-state");
  const s = STATE.status;
  // Guarded on `!value` so the 20-second refresh does not blink "Working" over
  // counts that are already on screen and still correct.
  if (s.loading && !s.value) return renderPanelState(el, { state: "loading" });
  if (s.error && s.value) {
    return renderPanelState(el, {
      state: "stale", message: s.error, updatedAt: s.updatedAt,
      onAction: () => { loadStatus(); },
    });
  }
  if (s.error) {
    return renderPanelState(el, {
      state: "error", message: s.error, onAction: () => { loadStatus(); },
    });
  }
  if (!s.value) return renderPanelState(el, { state: "loading" });
  return renderPanelState(el, { state: "populated" });
}

function renderOverview() {
  const s = STATE.status.value;
  if (s) { renderTotals(s); renderByType(s); renderMemory(s); }
  renderStatusPill();
  renderOverviewState();
}

async function loadStatus() {
  STATE.status.loading = true;
  renderOverviewState();
  let s;
  try {
    s = await api("/api/status");
  } catch (err) {
    if (isApiAbort(err)) return null;
    STATE.status.loading = false;
    STATE.status.error = err.message;
    renderOverview();
    return null;
  }
  STATE.status.loading = false;
  STATE.status.error = null;
  STATE.status.value = s && typeof s === "object" ? s : {};
  STATE.status.updatedAt = now();
  renderOverview();
  renderFilters();
  return s;
}

// ---------------------------------------------------------------------------
// 7. Library
// ---------------------------------------------------------------------------

const poolKinds = () => (STATE.status.value && STATE.status.value.by_kind) || {};
const filtersActive = () => Boolean(STATE.library.filters.kind) ||
  Boolean(STATE.library.filters.q) || STATE.library.filters.state === "parked";

function clearFilters() {
  STATE.library.filters.kind = null;
  STATE.library.filters.q = "";
  STATE.library.filters.state = "all";
  const search = $("#search");
  if (search) search.value = "";
  renderFilters();
  loadGrid(true);
}

function renderFilters() {
  const filters = $("#filters");
  if (!filters) return;
  const kinds = Object.entries(poolKinds()).sort((a, b) => b[1] - a[1]);
  const total = Object.values(poolKinds()).reduce((a, b) => a + b, 0);
  filters.replaceChildren();
  const chip = (k, label, n) => {
    const b = makeEl("button", "fchip" + (STATE.library.filters.kind === k ? " on" : ""), label);
    b.dataset.kind = k === null ? "" : k;
    if (STATE.library.filters.kind === k) b.setAttribute("aria-pressed", "true");
    else b.setAttribute("aria-pressed", "false");
    b.appendChild(makeEl("b", "", n));
    filters.appendChild(b);
  };
  chip(null, "all", total);
  kinds.forEach(([k, n]) => chip(k, k, n));
  // The other half of ?enabled=false. A parked row is the one thing you cannot
  // find by scrolling — the pool lists newest first, not parked first — and the
  // enable control only shows up once you have found one. Filters compose on
  // the server, so this narrows the current kind/search rather than replacing it.
  const parkedOn = STATE.library.filters.state === "parked";
  const parked = makeEl("button", "fchip parked" + (parkedOn ? " on" : ""), "⏸ parked only");
  parked.id = "parked-only";
  parked.setAttribute("aria-pressed", parkedOn ? "true" : "false");
  filters.appendChild(parked);
  parked.addEventListener("click", () => {
    STATE.library.filters.state = parkedOn ? "all" : "parked";
    renderFilters();
    loadGrid(true);
  });
  // Dropping a whole category is the usual fix when a search returned junk, so
  // it is offered only while that category is actually selected — never next to
  // "all", where a mis-click would be catastrophic.
  if (STATE.library.filters.kind) {
    const danger = makeEl("button", "fchip danger",
      '✕ delete all "' + STATE.library.filters.kind + '"');
    danger.id = "drop-kind";
    danger.addEventListener("click", dropKind);
    filters.appendChild(danger);
  }
  // Only the kind chips — the ones `chip()` stamped with data-kind. A bare
  // ".fchip" sweep would also catch the delete-category chip, the parked toggle
  // and every .pv-enable button in the grid, handing each of them a kind reset
  // it never asked for (and a fresh duplicate listener on every re-render).
  filters.querySelectorAll(".fchip[data-kind]").forEach((b) => b.addEventListener("click", () => {
    STATE.library.filters.kind = b.dataset.kind || null;
    renderFilters();
    loadGrid(true);
  }));
}

async function dropKind() {
  const k = STATE.library.filters.kind;
  const n = poolKinds()[k] || 0;
  if (!confirm('Delete the entire "' + k + '" category?\n\n' + n +
               " bumper(s) and their files are removed permanently.")) return;
  try {
    const j = await api("/api/pool/kind/" + encodeURIComponent(k), { method: "DELETE" });
    announce("dropped category " + k + ": removed " + j.removed +
             (j.dirs_removed ? ", " + j.dirs_removed + " dir(s)" : ""));
    STATE.library.filters.kind = null;
    await loadStatus();
    loadGrid(true);
  } catch (err) { announce("category delete failed: " + err.message); }
}

async function deleteBumper(b, el) {
  const what = rowLabel(b);
  if (!confirm("Delete \"" + what + "\"?\n\nThe file is removed too, so it cannot come back on the next scan.")) return;
  let j;
  try {
    j = await api("/api/bumpers/" + encodeURIComponent(b.id), { method: "DELETE" });
  } catch (err) { announce("delete failed: " + err.message); return; }
  STATE.library.items = STATE.library.items.filter((row) => row.id !== b.id);
  if (el) {
    el.classList.add("gone");
    setTimeout(() => el.remove(), 220);
  }
  announce("deleted " + j.kind + " · " + (j.title || b.id) +
           (j.file_removed ? " (file removed)" : ""));
  loadStatus();
}

// Bringing a parked row back on. The pool keeps rows the system switched off —
// a cam dropped from the YAML, a file the asset sweep could not find — and the
// only way back used to be spotting the id in the list and curling it. The
// server may answer with a `warning` (an on_this_day card is parked by the
// calendar, not by anyone, and the rotation will take it back); relay it rather
// than let the click look like the last word.
async function enableBumper(b) {
  let j;
  try {
    j = await api("/api/pool/enable?bumper_id=" + encodeURIComponent(b.id), { method: "POST" });
  } catch (err) { announce("enable failed: " + err.message); return; }
  announce("enabled " + rowLabel(b) +
           (j.changed ? "" : " (already on)") +
           (j.warning ? " — " + j.warning : ""));
  await loadStatus();
  loadGrid(true);
}

function renderLibraryState() {
  const el = $("#browse-state");
  const lib = STATE.library;
  // Unlike the overview and station panels, every library read is something the
  // operator asked for, so saying "loading" cannot flicker on a background
  // refresh — and a Retry that showed only the old stale line would look dead.
  if (lib.loading) return renderPanelState(el, { state: "loading" });
  if (lib.error && lib.items.length) {
    return renderPanelState(el, {
      state: "stale", message: lib.error, updatedAt: lib.updatedAt,
      onAction: () => { loadGrid(true); },
    });
  }
  if (lib.error) {
    return renderPanelState(el, {
      state: "error", message: lib.error, onAction: () => { loadGrid(true); },
    });
  }
  if (!lib.items.length) {
    if (filtersActive()) {
      return renderPanelState(el, {
        state: "empty", message: "No rows match the current filter.",
        filtersActive: true, actionLabel: "Clear filters", onAction: clearFilters,
      });
    }
    return renderPanelState(el, {
      state: "empty",
      message: lib.source === "shuffle"
        ? "the shuffle draw came back with nothing"
        : "nothing here yet — generate some cards above",
    });
  }
  return renderPanelState(el, { state: "populated" });
}

function renderLibrary() {
  const grid = $("#grid");
  if (grid) grid.replaceChildren(...STATE.library.items.map(cardEl));
  const more = $("#more");
  if (more) more.hidden = !STATE.library.hasMore;
}

function libraryParams(offset) {
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  const f = STATE.library.filters;
  if (f.kind) params.set("kind", f.kind);
  if (f.type) params.set("type", f.type);
  if (f.state === "parked") params.set("enabled", "false");
  if (f.q) params.set("q", f.q);
  return params;
}

// Every read carries a generation. A superseded search is aborted, and an answer
// that arrives anyway is dropped rather than overwriting newer rows.
async function loadGrid(reset) {
  const lib = STATE.library;
  const offset = reset ? 0 : lib.offset;
  const generation = ++lib.generation;
  if (libraryAbort) libraryAbort.abort();
  libraryAbort = new AbortController();
  lib.loading = true;
  renderLibraryState();
  let d;
  try {
    d = await api("/api/bumpers?" + libraryParams(offset), { signal: libraryAbort.signal });
  } catch (err) {
    if (isApiAbort(err) || generation !== lib.generation) return null;
    lib.loading = false;
    lib.error = err.message;
    renderLibraryState();
    return null;
  }
  if (generation !== lib.generation) return null;
  const rows = Array.isArray(d && d.bumpers) ? d.bumpers : [];
  const count = typeof (d && d.count) === "number" ? d.count : rows.length;
  lib.items = reset ? rows : lib.items.concat(rows);
  lib.offset = offset + count;
  lib.hasMore = count >= PAGE;
  lib.loading = false;
  lib.error = null;
  lib.source = "listing";
  lib.updatedAt = now();
  renderLibrary();
  renderLibraryState();
  return d;
}

function scheduleSearch(value) {
  STATE.library.filters.q = value;
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchTimer = null; loadGrid(true); }, SEARCH_DEBOUNCE_MS);
}

async function shufflePreview() {
  // The preview draws from /api/bumpers/random, which serves only live rows:
  // leaving the parked chip lit would claim these are the parked ones.
  const lib = STATE.library;
  lib.filters.kind = null; lib.filters.q = ""; lib.filters.state = "all";
  const search = $("#search");
  if (search) search.value = "";
  renderFilters();
  const generation = ++lib.generation;
  lib.loading = true;
  renderLibraryState();
  let d;
  try {
    d = await api("/api/bumpers/random?count=" + PAGE);
  } catch (err) {
    if (generation !== lib.generation) return null;
    lib.loading = false;
    lib.error = err.message;
    renderLibraryState();
    return null;
  }
  if (generation !== lib.generation) return null;
  lib.items = Array.isArray(d && d.bumpers) ? d.bumpers : [];
  lib.offset = lib.items.length;
  lib.hasMore = false;
  lib.loading = false;
  lib.error = null;
  lib.source = "shuffle";
  lib.updatedAt = now();
  renderLibrary();
  renderLibraryState();
  return d;
}

// ---------------------------------------------------------------------------
// 8. Composer / playback preview  (read-only: never advances playout)
// ---------------------------------------------------------------------------

function packSummaryEl(d) {
  const root = makeEl("div", "pack-summary");
  if (!d || typeof d !== "object") {
    root.append(makeEl("div", "preview-err", "preview failed: empty response"));
    return root;
  }
  const count = d.count || 0;
  root.append(makeEl("div", "",
    "Requested " + d.requested + "s | Composed " + d.total + "s | Gap " + d.gap +
    "s | " + (d.exact ? "Within tolerance" : "Outside tolerance") +
    " | " + count + " item(s)"));
  const relaxed = (d.composition && d.composition.relaxed_rules) || [];
  if (relaxed.length) {
    root.append(makeEl("div", "attn pv-relax", "Relaxed: " + relaxed.join(", ")));
  }
  if (!count) {
    root.append(makeEl("div", "empty", d.note || "nothing in this pack"));
  }
  return root;
}

function renderPackPreview(d) {
  const summary = $("#preview-summary");
  const grid = $("#preview-grid");
  if (summary) summary.replaceChildren(packSummaryEl(d));
  if (!grid) return;
  grid.replaceChildren(...((d && d.bumpers) || []).map(cardEl));
}

function renderComposerState() {
  const el = $("#preview-state");
  const c = STATE.composer;
  if (c.loading) return renderPanelState(el, { state: "loading", message: c.loadingLabel });
  if (c.error && c.result) {
    return renderPanelState(el, {
      state: "stale", message: c.error, updatedAt: c.updatedAt,
      onAction: c.retry || undefined,
    });
  }
  if (c.error) {
    return renderPanelState(el, {
      state: "error", message: c.error, onAction: c.retry || undefined,
    });
  }
  if (!c.result) return renderPanelState(el, { state: "empty", message: "Nothing previewed yet." });
  return renderPanelState(el, { state: "populated" });
}

// The preview is GET-only. It never calls station advance(), writes play
// history, or touches play_count/last_played.
async function runPreview(path, loadingLabel, render) {
  const c = STATE.composer;
  c.loading = true;
  c.loadingLabel = loadingLabel;
  c.retry = () => runPreview(path, loadingLabel, render);
  renderComposerState();
  let d;
  try {
    d = await api(path);
  } catch (err) {
    c.loading = false;
    c.error = err.message;
    renderComposerState();
    return null;
  }
  c.loading = false;
  c.error = null;
  c.result = d;
  c.updatedAt = now();
  render(d);
  renderComposerState();
  return d;
}

function previewPack(seconds) {
  STATE.composer.seconds = seconds;
  return runPreview(
    "/api/bumpers/fill?seconds=" + encodeURIComponent(seconds) + "&explain=true",
    "composing " + seconds + "s pack…",
    renderPackPreview);
}

function previewOne() {
  return runPreview(
    "/api/bumpers/random?count=1&explain=true",
    "loading one item…",
    (d) => {
      const summary = $("#preview-summary");
      const grid = $("#preview-grid");
      if (summary) {
        summary.replaceChildren(makeEl("div", "pack-summary",
          d && d.count ? "one item" : "nothing to preview"));
      }
      if (grid) {
        grid.replaceChildren(...((d && d.bumpers) || []).map(cardEl));
        if (!(d && d.count)) grid.appendChild(makeEl("div", "empty", "nothing here yet"));
      }
    });
}

// ---------------------------------------------------------------------------
// 9. Station
// ---------------------------------------------------------------------------

// Icon + word + colour, from the station body alone.
function stationState(s) {
  if (!s || typeof s !== "object") {
    return { level: "offline", detail: "the station could not be read" };
  }
  const conformed = (s.conformed || 0) + " / " + (s.eligible || 0) + " conformed";
  if (s.ffmpeg === false) {
    return { level: "attention", detail: "ffmpeg not found: nothing can be conformed" };
  }
  const live = s.channels && s.channels.live && s.channels.live.now;
  if (!live) return { level: "attention", detail: "live channel is off air · " + conformed };
  return { level: "healthy", detail: conformed };
}

function stationEl(s) {
  const root = makeEl("div", "station-body");
  const state = stationState(s);
  root.append(statusBadge(state.level, state.detail));
  for (const name of ["live", "standby"]) {
    const ch = (s.channels || {})[name] || {};
    const row = makeEl("div", "station-row");
    row.append(makeEl("span", "lbl", name));
    if (ch.now) {
      const left = Math.max(0, Math.round((ch.now.ends_at || 0) - Date.now() / 1000));
      row.append(makeEl("span", "now", ch.now.title + " (" + ch.now.kind + ", " + left + "s left)"));
    } else {
      row.append(makeEl("span", "now muted", "off air"));
    }
    if (ch.next) row.append(makeEl("span", "next muted", "next: " + ch.next.title));
    root.append(row);
  }
  const urls = s.urls || {};
  for (const [label, key] of [["Channel M3U", "channel_m3u"], ["Guide XMLTV", "guide_xml"], ["Standby HLS", "standby"]]) {
    const row = makeEl("div", "station-url");
    const id = "station-url-" + key;
    const caption = makeEl("label", "lbl", label);
    caption.setAttribute("for", id);
    row.append(caption);
    const input = document.createElement("input");
    input.readOnly = true; input.className = "url"; input.value = urls[key] || "";
    input.id = id;
    input.addEventListener("focus", () => input.select && input.select());
    row.append(input);
    root.append(row);
  }
  root.append(makeEl("div", "muted", s.ffmpeg === false
    ? "ffmpeg not found: nothing can be conformed"
    : (s.conformed || 0) + " / " + (s.eligible || 0) + " conformed"));
  return root;
}

function renderStationState() {
  const el = $("#station-state");
  const st = STATE.station;
  if (st.loading && !st.value) return renderPanelState(el, { state: "loading" });
  if (st.error && st.value) {
    return renderPanelState(el, {
      state: "stale", message: st.error, updatedAt: st.updatedAt,
      onAction: () => { loadStation(); },
    });
  }
  if (st.error) {
    return renderPanelState(el, {
      state: "error", message: st.error, onAction: () => { loadStation(); },
    });
  }
  if (!st.value) return renderPanelState(el, { state: "loading" });
  return renderPanelState(el, { state: "populated" });
}

async function loadStation() {
  STATE.station.loading = true;
  renderStationState();
  let s;
  try {
    s = await api("/api/station");
  } catch (err) {
    if (isApiAbort(err)) return null;
    STATE.station.loading = false;
    STATE.station.error = err.message;
    renderStationState();
    return null;
  }
  STATE.station.loading = false;
  STATE.station.error = null;
  STATE.station.value = s && typeof s === "object" ? s : {};
  STATE.station.updatedAt = now();
  const el = $("#station");
  if (el) el.replaceChildren(stationEl(STATE.station.value));
  renderStationState();
  return s;
}

// ---------------------------------------------------------------------------
// 10. Operations and jobs
// ---------------------------------------------------------------------------

// Housekeeping actions. Both are safe and idempotent — they only remove debris
// or restore assets whose media is verifiably fine — so neither needs a confirm.
const MAINT = {
  tidy: { url: "/api/pool/tidy", say: (j) =>
    "tidy: removed " + j.zero_byte_files + " empty file(s), " + j.empty_dirs + " empty dir(s)" },
  revive: { url: "/api/pool/revive", say: (j) =>
    "recheck: " + j.restored + " restored, " + j.still_dead + " still unplayable, " +
    j.skipped_streams + " stream(s) skipped" },
};

const JOB_STOPPED = "stopped checking — the job may still be running";
const JOB_FORGOTTEN = "status unknown: the server no longer tracks this job";

// A job POST returns immediately; polling owns the long wait, so no clock is
// imposed on the server's own duration and no five-minute success is invented.
//
// A lost status read is not a lost job: the work is very likely still running
// server-side, so a network failure keeps `status unknown`, backs off to ten
// seconds and keeps asking rather than reporting the action as failed. Only a
// 404 — the server itself no longer tracking the id — ends the poll, and even
// that is reported as unknown.
//
// The loop always terminates: `hooks.stopped()` lets the surface abandon the
// wait, so no caller can be left awaiting a poll that never returns.
async function pollJob(job, getStatus = async (jobId) =>
  api("/api/request/" + encodeURIComponent(jobId)),
pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
hooks = {}) {
  const jobId = job.job_id;
  const stopped = hooks.stopped || (() => false);
  let current = job;
  let delay = JOB_POLL_MS;
  let elapsed = 0;
  while (jobId && current.status === "working") {
    await pause(delay);
    if (stopped()) return { status: "unknown", result: JOB_STOPPED };
    elapsed += delay;
    try {
      current = await getStatus(jobId);
      delay = JOB_POLL_MS;
      if (current && current.status === "working" && hooks.onWorking) {
        hooks.onWorking(Math.round(elapsed / 1000));
      }
    } catch (err) {
      if (err && err.status === 404) return { status: "unknown", result: JOB_FORGOTTEN };
      delay = JOB_BACKOFF_MS;
      const message = "status unknown (" + err.message +
                      ") — the job may still be running; checking again in 10s";
      if (hooks.onUnknown) hooks.onUnknown(message);
      else announce(message);
    }
  }
  return current;
}

// Every operator surface that waits on a job shares this. pollJob owns the
// state machine; the pause here can be cut short by "Check now" or abandoned
// by "Stop checking", and the surface's controls go back to the operator the
// moment a read is lost. Nothing here can leave a panel disabled with no way
// out, and a superseded surface abandons its poll instead of polling forever.
function watchJob(job, view) {
  let wake = null;
  let stopped = false;
  const pause = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
  const escapes = [
    { label: "Check now", onClick: () => { if (wake) wake(); } },
    { label: "Stop checking", onClick: () => { stopped = true; if (wake) wake(); } },
  ];
  return pollJob(job, undefined, pause, {
    stopped: () => stopped || (view.superseded ? view.superseded() : false),
    onWorking: (seconds) => view.working(seconds),
    onUnknown: (message) => { view.release(); view.unknown(message, escapes); },
  });
}

function wireMaintenance() {
  $$("[data-maint]").forEach((b) => b.addEventListener("click", async () => {
    const m = MAINT[b.dataset.maint];
    const label = b.textContent;
    b.disabled = true; b.textContent = "working…";
    try {
      const j = await api(m.url, { method: "POST", timeout: 0 });
      announce(m.say(j));
      await loadStatus();
      loadGrid(true);
    } catch (err) { announce("failed: " + err.message); }
    b.disabled = false; b.textContent = label;
  }));

  $$("[data-starter]").forEach((b) => b.addEventListener("click", async () => {
    const dry = b.dataset.starter === "dry";
    if (!dry && !confirm("Run the starter seeds?\n\nThis downloads clips from the stock " +
                         "and archive sources using your own API keys. It can take several " +
                         "minutes and is deliberately paced so the archives don't throttle you."))
      return;
    await doAction("/api/starter?dry_run=" + dry, dry ? "check starter" : "run starter");
  }));
}

async function doAction(url, label) {
  const btns = $$(".actions button");
  const state = $("#actions-state");
  const mine = ++actionGeneration;
  const current = () => mine === actionGeneration;
  // The panel is held only while the operator is actually being made to wait.
  // The moment a status read is lost the buttons come back, so the escape from
  // a silent server is a real control, not a page reload.
  const release = () => { if (current()) btns.forEach((b) => { b.disabled = false; }); };
  btns.forEach((b) => { b.disabled = true; });
  announce("→ " + label + " …");
  renderJobState(state, "working", label + "…", []);
  try {
    let r = await api(url, { method: "POST", timeout: 0 });
    if (r.job_id) {
      r = await watchJob(r, {
        superseded: () => !current(),
        release,
        working: (seconds) => {
          if (current()) renderJobState(state, "working", label + "… (" + seconds + "s)", []);
        },
        unknown: (message, actions) => {
          if (current()) renderJobState(state, "attention", message, actions);
        },
      });
    }
    const result = r.result === undefined ? r : r.result;
    const msg = typeof result === "string" ? result : JSON.stringify(result);
    // "unknown" is not "failed": the run may well have completed.
    const mark = r.status === "error" ? "✗ " : (r.status === "unknown" ? "▲ " : "✓ ");
    if (current()) {
      announce(mark + label + ": " + msg.trim().split("\n").slice(-2).join(" ") +
               (r.status === "unknown" ? " — run it again to check" : ""));
    }
  } catch (err) {
    if (current()) announce("✗ " + label + " failed: " + err.message);
  }
  release();
  if (current()) renderPanelState(state, { state: "populated" });
  loadStatus(); loadGrid(true);
  loadStation();
}

async function submitAsk() {
  const inp = $("#ask"), btn = $("#ask-go"), out = $("#ask-result");
  const text = inp.value.trim();
  if (!text) return;
  // A poll that hands the controls back can be overtaken by a second ask; only
  // the newest one is allowed to write to the result line.
  const mine = ++askGeneration;
  const current = () => mine === askGeneration;
  btn.disabled = true; inp.disabled = true;
  out.replaceChildren(statusBadge("working", "downloads and captures can take a bit"));
  const finish = (level, msg) => {
    if (!current()) return;
    out.replaceChildren(statusBadge(level, msg));
    announce(msg);
    btn.disabled = false; inp.disabled = false; inp.focus();
    loadStatus(); loadGrid(true);
  };
  let job;
  try {
    // Kick off the background job; this returns immediately (no proxy timeout).
    job = await api("/api/request", {
      method: "POST", timeout: 0,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) { return finish("failed", err.message); }
  if (!job.job_id) return finish(job.status === "error" ? "failed" : "healthy", job.result || "done");
  inp.value = "";
  // The same poller the Actions panel uses: never a false success, never a
  // failure invented from a lost read, and never a form left disabled.
  const final = await watchJob(job, {
    superseded: () => !current(),
    // Controls handed back after a lost poll are never taken away again.
    release: () => { if (current()) { btn.disabled = false; inp.disabled = false; } },
    working: (seconds) => {
      if (current()) renderJobState(out, "working", "working on it… (" + seconds + "s)", []);
    },
    unknown: (message, actions) => {
      if (current()) renderJobState(out, "attention", message, actions);
    },
  });
  finish(final.status === "done" ? "healthy"
    : (final.status === "unknown" ? "attention" : "failed"), final.result || "done");
}

// ---------------------------------------------------------------------------
// 11. Lifecycle, visibility, boot
// ---------------------------------------------------------------------------

const isVisible = () => typeof document === "undefined" ||
  document.visibilityState === undefined || document.visibilityState === "visible";

// The 20-second refresh does nothing while the tab is hidden; coming back
// refreshes at once rather than waiting out the rest of the interval.
async function refreshTick() {
  if (!isVisible()) return null;
  return Promise.all([loadStatus(), loadStation()]);
}

async function handleVisibilityChange() {
  if (!isVisible()) return null;
  return refreshTick();
}

function boot() {
  wireMaintenance();
  $("#ask-go").addEventListener("click", submitAsk);
  $("#ask").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAsk(); });

  $$("[data-gen]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/generate/" + b.dataset.gen + "?n=20", "generate " + b.dataset.gen)));
  $$("[data-src]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/sources/" + b.dataset.src, b.dataset.src)));
  $$("[data-station]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/station/conform", "conform")));
  $("#shuffle").addEventListener("click", shufflePreview);
  $("#more").addEventListener("click", () => loadGrid(false));
  $("#search").addEventListener("input", (e) => scheduleSearch(e.target.value));
  const previewOneBtn = $("#preview-one");
  if (previewOneBtn) previewOneBtn.addEventListener("click", previewOne);
  $$("[data-pack]").forEach((b) =>
    b.addEventListener("click", () => previewPack(b.dataset.pack)));

  document.addEventListener("visibilitychange", handleVisibilityChange);
  loadStatus();
  loadGrid(true);
  loadStation();
  refreshTimer = setInterval(refreshTick, REFRESH_MS);
}

// ---------------------------------------------------------------------------
// 12. CommonJS exports for tests
// ---------------------------------------------------------------------------

const COMMONJS = typeof module !== "undefined" && module.exports;
if (typeof document !== "undefined" && !COMMONJS) boot();
if (COMMONJS) {
  module.exports = {
    // constants
    PAGE, API_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, REFRESH_MS, JOB_POLL_MS, STATE,
    // helpers
    makeEl, api, isApiAbort, humanMessage, formatAge, formatDuration,
    // components
    statusBadge, renderPanelState, cardEl, packSummaryEl, renderPackPreview,
    freshnessLine, stationEl, stationState,
    // behaviour
    loadStatus, loadGrid, loadStation, scheduleSearch, shufflePreview,
    clearFilters, renderFilters, previewPack, previewOne, pollJob, doAction,
    enableBumper, deleteBumper, announce, refreshTick, handleVisibilityChange,
    submitAsk,
    resetStateForTests() {
      if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
      libraryAbort = null;
      askGeneration = 0;
      actionGeneration = 0;
      Object.assign(STATE, initialState());
    },
  };
}
