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
const MAX_JOBS = 20;                // jobs this page started, newest first
const RECENT_JOBS = 5;              // how many of them the overview shows
const MAX_FILTER_TEXT = 100;        // /api/bumpers caps `q` at 100 characters

// The five views. A hash naming anything else is not a view.
const ROUTES = ["overview", "library", "composer", "station", "operations"];
const DEFAULT_ROUTE = "overview";
// What /api/bumpers?state= and ?type= actually accept. A hash may say anything,
// so it is checked against these rather than forwarded on trust.
const LIBRARY_STATES = ["all", "playable", "parked", "dead", "unrendered"];
const LIBRARY_TYPES = ["video", "card", "stream", "image"];

// Said, once, wherever this build of the server does not report a field. Never
// a zero, a dash, or an invented default.
const NOT_AVAILABLE = "Not available in this version.";

// One explicit state object, divided by concern. The DOM is never the state:
// every render below can be repeated from this object alone.
//
// Beyond the shared shape, `library.generation` is the filter counter that
// lets a late answer be discarded, `*.updatedAt` is what a stale panel shows,
// and `library.source` records whether the grid is a filtered listing or a
// shuffle draw (they have different empty messages).
function initialState() {
  return {
    route: DEFAULT_ROUTE,
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
    // Jobs THIS page started, newest first. There is no server jobs list yet,
    // so this registry is the whole truth and says so when it is empty.
    jobs: { items: [], error: null },
    notices: [],
  };
}

const STATE = initialState();

let searchTimer = null;
let libraryAbort = null;
let statusAbort = null;
let stationAbort = null;
let refreshTimer = null;
// What has actually been entered, as opposed to STATE.route (what is drawn).
// Re-entering the same route with the same query is a no-op, which is what
// keeps location.replace()'s own hashchange from loading everything twice.
let activeRoute = null;
let activeQuery = "";
let jobSeq = 0;
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

// In-page links only. Every href handed to this comes from a literal route
// table in this file — never from an API string — so no scheme can arrive
// from the server through it.
function makeLink(href, text, cls) {
  const a = document.createElement("a");
  if (cls) a.className = cls;
  a.href = href;
  if (text !== undefined) a.textContent = String(text);
  return a;
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
// 4. Routing and shell chrome
// ---------------------------------------------------------------------------
// Five hash views, no server routes and no router library. The hash says which
// view is on screen; STATE says what it shows. Nothing is ever read back out of
// the DOM, so a deep link, a back button and a first paint all render the same
// way — and every view can be re-rendered at any time without a reload.
//
// Each view registers `enter` (paint from STATE, then read what it needs) and
// `exit` (give back what it holds). Later slices hang media, dialogs and
// pollers off the same `exit` hook; the shared teardown below already stops the
// 20-second clock and cancels reads that are still in flight.

const VIEWS = {
  overview: { enter: enterOverview, exit: exitOverview },
  library: { enter: enterLibrary, exit: exitLibrary },
  composer: { enter: enterComposer, exit: exitComposer },
  station: { enter: enterStation, exit: exitStation },
  operations: { enter: enterOperations, exit: exitOperations },
};

const currentHash = () =>
  (typeof location !== "undefined" && location && location.hash) || "";

// `#/library?state=parked` → {route:"library", params}. An unknown or empty
// path is reported as route:null so the caller can normalize it; the query is
// a URLSearchParams so no hand-rolled splitting can mis-decode a value.
function parseHash(hash) {
  const raw = String(hash === undefined || hash === null ? "" : hash).replace(/^#/, "");
  const cut = raw.indexOf("?");
  const path = (cut === -1 ? raw : raw.slice(0, cut)).replace(/^\/+/, "");
  const name = path.split("/")[0].toLowerCase();
  return {
    route: ROUTES.indexOf(name) === -1 ? null : name,
    params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1)),
  };
}

// "#main" is the skip link, not a view. A hash with no leading slash that names
// an element really in the document is an in-page jump: the browser handles it
// and the router leaves the current view alone. Anything else is a bad route.
function isFragmentLink(hash) {
  const raw = String(hash === undefined || hash === null ? "" : hash).replace(/^#/, "");
  if (!raw || raw.charAt(0) === "/" || raw.indexOf("?") !== -1) return false;
  return Boolean(typeof document !== "undefined" && document.getElementById &&
                 document.getElementById(raw));
}

// The one entry point: called at boot and on every hashchange.
function applyHash(hash) {
  const raw = hash === undefined ? currentHash() : hash;
  const parsed = parseHash(raw);
  if (parsed.route) return enterRoute(parsed.route, parsed.params);
  // Before the first view is entered even a fragment has to land somewhere.
  if (activeRoute && isFragmentLink(raw)) return null;
  // replace(), not assign(): a typo in the address bar must not become a stop
  // on the way back. The hashchange this fires re-enters the same route with
  // the same query, which enterRoute treats as a no-op.
  if (typeof location !== "undefined" && location && location.replace) {
    location.replace("#/" + DEFAULT_ROUTE);
  }
  return enterRoute(DEFAULT_ROUTE, new URLSearchParams(""));
}

function enterRoute(name, params) {
  const query = params ? params.toString() : "";
  if (activeRoute === name && activeQuery === query) return null;
  if (activeRoute) exitRoute(activeRoute);
  activeRoute = name;
  activeQuery = query;
  STATE.route = name;
  renderChrome();
  const view = VIEWS[name];
  return view && view.enter ? view.enter(params || new URLSearchParams("")) : null;
}

// Shared teardown first — the departed view's clock and its in-flight reads —
// then whatever that view holds itself.
function exitRoute(name) {
  stopRefresh();
  abortReads();
  const view = VIEWS[name];
  if (view && view.exit) view.exit();
}

function abortReads() {
  [statusAbort, stationAbort, libraryAbort].forEach((c) => { if (c) c.abort(); });
  statusAbort = null;
  stationAbort = null;
  libraryAbort = null;
}

function startRefresh() {
  if (refreshTimer === null) refreshTimer = setInterval(refreshTick, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
  return null;
}

// Only the active view is shown, and only its link is current. Both are driven
// from STATE.route, so they cannot disagree with what was rendered.
function renderNav() {
  ROUTES.forEach((name) => {
    const view = $("#view-" + name);
    if (view) view.hidden = name !== STATE.route;
  });
  $$("#viewnav [data-view]").forEach((link) => {
    if (link.dataset.view === STATE.route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

// Header and footer: true on every view, so they are rendered from STATE
// rather than owned by one of them. `at` is only for tests, which need a fixed
// clock to assert an age.
function renderChrome(at) {
  renderNav();
  renderStatusPill();
  renderHeaderMeta(at);
  renderFooter();
}

function renderHeaderMeta(at) {
  const profileEl = $("#header-profile");
  if (profileEl) {
    const profile = STATE.status.value && STATE.status.value.profile;
    if (!profile || typeof profile !== "object") {
      profileEl.replaceChildren(makeEl("span", "hmeta-text", "profile · " + NOT_AVAILABLE));
    } else {
      const bad = profile.valid === false || profile.source === "fallback-after-error";
      profileEl.replaceChildren(statusBadge(bad ? "attention" : "healthy",
        "profile · " + String(profile.source == null ? "unknown source" : profile.source)));
    }
  }
  const jobsEl = $("#header-jobs");
  if (jobsEl) {
    const running = STATE.jobs.items.filter((job) => job.status === "working").length;
    jobsEl.textContent = running === 1 ? "1 job running" : running + " jobs running";
  }
  const refreshEl = $("#header-refresh");
  if (refreshEl) {
    refreshEl.textContent = STATE.status.updatedAt
      ? "updated " + formatAge(STATE.status.updatedAt, at)
      : "not read yet";
  }
}

// The server ships no version string today, so the footer says exactly that
// rather than printing an invented one.
function renderFooter() {
  const el = $("#footer-version");
  if (!el) return;
  const version = STATE.status.value && STATE.status.value.version;
  const usable = (typeof version === "string" || typeof version === "number") &&
    String(version).trim() !== "";
  el.textContent = usable ? "version " + String(version).trim() : "version not reported";
}

// --- per-view enter/exit -----------------------------------------------------

// A view that only needs the header's copy of /api/status does not re-read it.
function ensureStatus() {
  if (STATE.status.value || STATE.status.loading) return null;
  return loadStatus();
}

// Overview reads GET /api/status and GET /api/station and nothing else: no
// station timeline is created or advanced by opening it.
function enterOverview() {
  renderOverview();
  startRefresh();
  return Promise.all([loadStatus(), loadStation()]);
}

function exitOverview() { return null; }

function enterLibrary(params) {
  applyLibraryQuery(params);
  renderFilters();
  renderLibrary();
  renderLibraryState();
  return Promise.all([ensureStatus(), loadGrid(true)]);
}

function exitLibrary() {
  if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
  return null;
}

function enterComposer() {
  renderComposerState();
  return ensureStatus();
}

function exitComposer() { return null; }

function enterStation() {
  renderStationState();
  startRefresh();
  return Promise.all([ensureStatus(), loadStation()]);
}

function exitStation() { return null; }

function enterOperations() {
  return ensureStatus();
}

function exitOperations() { return null; }

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

// One labelled fact. Used by every summary block so a missing value reads the
// same way everywhere it appears.
function summaryRow(label, value) {
  const row = makeEl("div", "summary-row");
  row.append(makeEl("span", "lbl", label), makeEl("span", "val", value));
  return row;
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

// Counts a build of the server actually reported, and the names of the ones it
// did not. A field that is absent is never shown as a zero: "0 parked" and "no
// idea how many are parked" are different answers to a morning health check.
function poolCounts(s) {
  const status = s && typeof s === "object" ? s : {};
  const boxes = [];
  const missing = [];
  [[status.total, "total"], [status.playable_now, "playable now"],
   [status.parked, "parked"], [status.dead, "dead"],
   [status.unrendered, "unrendered"]].forEach(([value, label]) => {
    if (typeof value === "number" && isFinite(value)) boxes.push({ n: value, label });
    else missing.push(label);
  });
  if (status.by_kind && typeof status.by_kind === "object") {
    boxes.push({ n: Object.keys(status.by_kind).length, label: "kinds" });
  } else missing.push("kinds");
  return { boxes, missing };
}

function renderTotals(s) {
  const totals = $("#totals");
  if (!totals) return;
  const counts = poolCounts(s);
  const nodes = counts.boxes.map(({ n, label }) => {
    const box = makeEl("div", "num", n);
    box.appendChild(makeEl("small", "", label));
    return box;
  });
  if (counts.missing.length) {
    nodes.push(makeEl("div", "totals-missing",
      counts.missing.join(" · ") + " — " + NOT_AVAILABLE));
  }
  totals.replaceChildren(...nodes);
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

// Configuration is file-owned: this reports what the server loaded and never
// offers to change it. `source` is a server-controlled string, so it goes
// through textContent like any other API value.
function configLines(s) {
  const status = s && typeof s === "object" ? s : {};
  const say = (part) => String(part.source == null ? "unknown source" : part.source) +
    (part.valid === false ? " · invalid, running the shipped default" : " · valid");
  const lines = [];
  const profile = status.profile;
  if (profile && typeof profile === "object") {
    lines.push({
      label: "profile", text: say(profile),
      level: profile.valid === false || profile.source === "fallback-after-error"
        ? "attention" : "healthy",
    });
  } else {
    lines.push({ label: "profile", text: NOT_AVAILABLE, level: null });
  }
  const music = status.music;
  if (music && typeof music === "object") {
    const beds = typeof music.enabled_beds === "number" ? music.enabled_beds : null;
    lines.push({
      label: "music", level: music.valid === false ||
        music.source === "fallback-after-error" ? "attention" : "healthy",
      text: say(music) +
        (beds === null ? "" : " · " + beds + " bed" + (beds === 1 ? "" : "s")) +
        (music.compatibility ? " · compatibility mode" : ""),
    });
  } else {
    lines.push({ label: "music", text: NOT_AVAILABLE, level: null });
  }
  return lines;
}

function renderConfig() {
  const el = $("#config-summary");
  if (!el) return;
  el.replaceChildren(...configLines(STATE.status.value).map((line) => {
    const row = makeEl("div", "summary-row");
    row.append(makeEl("span", "lbl", line.label));
    row.append(line.level ? statusBadge(line.level, line.text)
                          : makeEl("span", "val", line.text));
    return row;
  }));
}

function renderService() {
  const el = $("#service-summary");
  if (!el) return;
  const s = STATE.status;
  const level = s.error ? (s.value ? "attention" : "offline")
                        : (s.value ? "healthy" : "working");
  const detail = s.error ? s.error
    : (s.value ? "answering on this host" : "reading the service…");
  const brand = s.value && s.value.brand;
  const version = s.value && s.value.version;
  el.replaceChildren(
    statusBadge(level, detail),
    summaryRow("brand", brand == null || brand === "" ? NOT_AVAILABLE : String(brand)),
    summaryRow("version",
      version === undefined || version === null || version === ""
        ? "not reported" : String(version)),
    summaryRow("last refresh",
      s.updatedAt ? formatAge(s.updatedAt) : "not read yet"));
}

// A compact now card per channel. Built from the station body the overview
// already read: it never asks the station for a new item, so looking at the
// overview cannot advance playout.
function nowCardEl(card) {
  const box = makeEl("div", "nowcard");
  box.append(makeEl("span", "nowcard-ch", card.channel),
             makeEl("span", "nowcard-now", card.detail));
  return box;
}

function renderOvStation() {
  const el = $("#ov-station");
  const s = STATE.station.value;
  if (el) {
    if (!s) {
      el.replaceChildren(summaryRow("station", "not read yet"));
    } else {
      const state = stationState(s);
      el.replaceChildren(
        statusBadge(state.level, state.detail),
        summaryRow("ffmpeg", s.ffmpeg === false ? "not found"
          : (s.ffmpeg === true ? "found" : NOT_AVAILABLE)),
        summaryRow("conformed", (s.conformed || 0) + " / " + (s.eligible || 0)),
        summaryRow("pending", typeof s.pending === "number"
          ? String(s.pending) : NOT_AVAILABLE));
    }
  }
  const nowEl = $("#ov-now");
  if (nowEl) nowEl.replaceChildren(...stationNow(s).map(nowCardEl));
}

// Every warning below is decided by an explicit field, never by reading a
// human sentence, and a field this build of the server does not send raises
// nothing at all. Each one links to the view that can actually fix it.
function overviewWarnings(status, station, jobs) {
  const s = status && typeof status === "object" ? status : {};
  const st = station && typeof station === "object" ? station : {};
  const list = [];
  const add = (id, href, message, action) => list.push({ id, href, message, action });

  if (s.playable_now === 0) {
    add("no-playable", "#/library?state=playable",
        "Nothing in the pool is playable right now.", "Open the library");
  }
  if (typeof s.unrendered === "number" && s.unrendered > 0) {
    add("unrendered", "#/library?state=unrendered",
        s.unrendered + " card(s) have no rendered media yet.", "Open the library");
  }
  if (typeof st.pending === "number" && st.pending > 0) {
    add("conform-backlog", "#/station",
        st.pending + " item(s) are waiting to be conformed.", "Open the station");
  }
  if (st.ffmpeg === false) {
    add("ffmpeg", "#/station",
        "ffmpeg was not found, so nothing can be conformed.", "Open the station");
  }
  const profile = s.profile;
  if (profile && typeof profile === "object" &&
      (profile.valid === false || profile.source === "fallback-after-error")) {
    add("profile", "#/station",
        "The channel profile in use is " + String(profile.source) +
        ", not the operator's file.", "Open the station");
  }
  const music = s.music;
  if (music && typeof music === "object" &&
      (music.valid === false || music.source === "fallback-after-error")) {
    add("music", "#/station",
        "The music manifest in use is " + String(music.source) +
        ", not the operator's file.", "Open the station");
  }
  const failed = (Array.isArray(jobs) ? jobs : [])
    .find((job) => job && job.status === "error");
  if (failed) {
    add("failed-job", "#/operations",
        "A job started from this page failed: " + String(failed.label) + ".",
        "Open operations");
  }
  return list;
}

function warningEl(warning) {
  const li = makeEl("li", "warning");
  const icon = makeEl("span", "warning-icon", "▲");
  icon.setAttribute("aria-hidden", "true");
  // One link per warning, and its text says both the trouble and where the fix
  // is, so the accessible name is not a bare "here".
  const link = makeLink(warning.href, undefined, "warning-link");
  link.append(makeEl("span", "warning-msg", warning.message),
              makeEl("span", "warning-go", warning.action));
  li.append(icon, link);
  return li;
}

// Warnings come before the healthy detail, and an overview with nothing wrong
// says so rather than showing an empty box.
function renderWarnings() {
  const warnings = overviewWarnings(STATE.status.value, STATE.station.value,
                                    STATE.jobs.items);
  const list = $("#warnings");
  if (list) list.replaceChildren(...warnings.map(warningEl));
  const el = $("#warnings-state");
  if (!el) return null;
  if (!STATE.status.value && !STATE.station.value) {
    return renderPanelState(el, { state: "loading" });
  }
  if (!warnings.length) {
    return renderPanelState(el, { state: "empty", message: "Nothing needs attention." });
  }
  return renderPanelState(el, { state: "populated" });
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
  renderService();
  renderConfig();
  renderOvStation();
  renderWarnings();
  renderJobs();
  renderChrome();
  renderOverviewState();
}

async function loadStatus() {
  if (statusAbort) statusAbort.abort();
  statusAbort = new AbortController();
  STATE.status.loading = true;
  renderOverviewState();
  let s;
  try {
    s = await api("/api/status", { signal: statusAbort.signal });
  } catch (err) {
    // A cancelled read is not a failure: it leaves the last known counts and
    // the panel state exactly as they were, but it must not leave the panel
    // believing a read is still on its way.
    STATE.status.loading = false;
    if (isApiAbort(err)) return null;
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
  Boolean(STATE.library.filters.q) || Boolean(STATE.library.filters.type) ||
  STATE.library.filters.state !== "all";

// `#/library?state=parked&kind=trivia&type=card&q=harbour`. The hash is
// operator input, not API output: `state` and `type` are checked against what
// the endpoint accepts (an unknown one is dropped, never forwarded), and the
// free-text fields are bounded to the length the server documents.
function applyLibraryQuery(params) {
  const query = params && typeof params.get === "function"
    ? params : new URLSearchParams("");
  const lib = STATE.library;
  const f = lib.filters;
  const state = query.get("state");
  const type = query.get("type");
  const kind = query.get("kind");
  const q = query.get("q");
  const before = JSON.stringify([f.state, f.type, f.kind, f.q]);
  f.state = LIBRARY_STATES.indexOf(String(state)) === -1 ? "all" : String(state);
  f.type = LIBRARY_TYPES.indexOf(String(type)) === -1 ? null : String(type);
  f.kind = kind ? String(kind).slice(0, MAX_FILTER_TEXT) : null;
  f.q = q ? String(q).slice(0, MAX_FILTER_TEXT) : "";
  lib.offset = 0;
  // Coming back to the same filters repaints the rows that answer them. A
  // different hash is a different question, and the old answer is dropped
  // rather than shown under the new filter for a moment.
  if (JSON.stringify([f.state, f.type, f.kind, f.q]) !== before) {
    lib.items = [];
    lib.hasMore = false;
    lib.error = null;
    lib.updatedAt = null;
    lib.source = "listing";
  }
  const search = $("#search");
  if (search) search.value = f.q;
}

function clearFilters() {
  STATE.library.filters.kind = null;
  STATE.library.filters.q = "";
  STATE.library.filters.type = null;
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
  // One vocabulary for both ends: `state` is the server's own filter, using the
  // same SQL /api/status counts parked/dead/unrendered with, so a link from an
  // overview warning lands on exactly the rows that warning counted.
  if (f.state && f.state !== "all") params.set("state", f.state);
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
    // A superseded read leaves every flag to the newer one. A cancelled-but-
    // current read (the view was left) only clears `loading`, so a later visit
    // does not find the panel waiting on a request that no longer exists.
    if (generation !== lib.generation) return null;
    lib.loading = false;
    if (isApiAbort(err)) return null;
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

// What each channel is playing, from the body the page already holds. Read
// only: nothing here asks the station for the next item.
function stationNow(s) {
  const channels = s && typeof s === "object" ? s.channels : null;
  return ["live", "standby"].map((channel) => {
    if (!channels || typeof channels !== "object") {
      return { channel, level: "offline", detail: "the station could not be read" };
    }
    const now_ = (channels[channel] || {}).now;
    if (!now_ || typeof now_ !== "object") {
      return { channel, level: "attention", detail: "off air" };
    }
    const left = Math.max(0, Math.round((now_.ends_at || 0) - Date.now() / 1000));
    const kind = now_.kind == null ? "" : String(now_.kind);
    return {
      channel, level: "healthy",
      detail: String(now_.title == null ? "" : now_.title) +
        (kind ? " · " + kind : "") + " · " + left + "s left",
    };
  });
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

// The station body is shown twice — in full on the Station view, in summary on
// the Overview — so one read decides the state of both regions and neither can
// disagree with the other about how old the content is.
const STATION_STATE_REGIONS = ["#station-state", "#ov-station-state"];

function renderStationState() {
  const st = STATE.station;
  let opts;
  if (st.loading && !st.value) opts = { state: "loading" };
  else if (st.error && st.value) {
    opts = { state: "stale", message: st.error, updatedAt: st.updatedAt,
             onAction: () => { loadStation(); } };
  } else if (st.error) {
    opts = { state: "error", message: st.error, onAction: () => { loadStation(); } };
  } else if (!st.value) opts = { state: "loading" };
  else opts = { state: "populated" };
  let rendered = null;
  STATION_STATE_REGIONS.forEach((sel) => {
    rendered = renderPanelState($(sel), opts) || rendered;
  });
  return rendered;
}

function renderStation() {
  const el = $("#station");
  if (el && STATE.station.value) el.replaceChildren(stationEl(STATE.station.value));
  renderOvStation();
}

async function loadStation() {
  if (stationAbort) stationAbort.abort();
  stationAbort = new AbortController();
  STATE.station.loading = true;
  renderStationState();
  let s;
  try {
    s = await api("/api/station", { signal: stationAbort.signal });
  } catch (err) {
    STATE.station.loading = false;
    if (isApiAbort(err)) return null;
    STATE.station.error = err.message;
    renderStationState();
    return null;
  }
  STATE.station.loading = false;
  STATE.station.error = null;
  STATE.station.value = s && typeof s === "object" ? s : {};
  STATE.station.updatedAt = now();
  renderStation();
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

// --- jobs this page started --------------------------------------------------
// There is no server-side jobs list yet, so this registry is only what this tab
// kicked off. The empty state says exactly that rather than implying the server
// has been idle. A later slice merges a real GET /api/jobs into the same list.

const JOB_LEVELS = { working: "working", done: "healthy", error: "failed",
                     unknown: "attention" };
const JOB_STATUSES = ["working", "done", "error", "unknown"];

function recordJob(label) {
  const at = now();
  const record = { id: "page-" + (++jobSeq), label: String(label), status: "working",
                   startedAt: at, updatedAt: at, result: "" };
  STATE.jobs.items.unshift(record);
  if (STATE.jobs.items.length > MAX_JOBS) STATE.jobs.items.length = MAX_JOBS;
  renderJobs();
  renderChrome();
  return record;
}

function finishJob(record, status, result) {
  if (!record) return null;
  record.status = JOB_STATUSES.indexOf(status) === -1 ? "unknown" : status;
  record.result = result === undefined || result === null ? "" : String(result);
  record.updatedAt = now();
  renderJobs();
  renderChrome();
  return record;
}

const recentJobs = (items, limit) =>
  (Array.isArray(items) ? items : []).slice(0, limit || RECENT_JOBS);

function jobRowEl(job) {
  const li = makeEl("li", "jobrow");
  li.append(statusBadge(JOB_LEVELS[job.status] || "attention", job.label));
  li.append(makeEl("span", "jobrow-age", formatAge(job.updatedAt)));
  const result = humanMessage(job.result, "");
  if (result) li.append(makeEl("span", "jobrow-result", result));
  return li;
}

function renderJobs() {
  const items = recentJobs(STATE.jobs.items);
  const list = $("#jobs-list");
  if (list) list.replaceChildren(...items.map(jobRowEl));
  const el = $("#jobs-state");
  if (!el) return null;
  if (!items.length) {
    return renderPanelState(el, {
      state: "empty", message: "No jobs started from this page",
    });
  }
  return renderPanelState(el, { state: "populated" });
}

// "unknown" is not "failed": a lost status read may well have been a job that
// finished. Only an outright error is recorded as one.
const jobOutcome = (status) =>
  status === "error" ? "error" : (status === "unknown" ? "unknown" : "done");

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
  const record = recordJob(label);
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
      record.id = String(r.job_id);
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
    // Recorded whether or not this surface is still the current one: the job
    // ran, and the overview's recent list is about jobs, not about panels.
    finishJob(record, jobOutcome(r.status), msg);
    if (current()) {
      announce(mark + label + ": " + msg.trim().split("\n").slice(-2).join(" ") +
               (r.status === "unknown" ? " — run it again to check" : ""));
    }
  } catch (err) {
    finishJob(record, "error", err.message);
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
  const record = recordJob("add: " + text.slice(0, 60));
  btn.disabled = true; inp.disabled = true;
  out.replaceChildren(statusBadge("working", "downloads and captures can take a bit"));
  const finish = (level, msg) => {
    finishJob(record, level === "healthy" ? "done"
      : (level === "attention" ? "unknown" : "error"), msg);
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
  record.id = String(job.job_id);
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
// refreshes at once rather than waiting out the rest of the interval. Only the
// two views that show live figures have a clock at all, and each reads only
// what it actually shows.
async function refreshTick() {
  if (!isVisible()) return null;
  if (STATE.route === "overview") return Promise.all([loadStatus(), loadStation()]);
  if (STATE.route === "station") return loadStation();
  return null;
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
  // Anchors carry the routes, so a click is an ordinary in-page hash change:
  // no listener, no preventDefault, and no reload. Back and forward arrive
  // here the same way a deep link does.
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", () => { applyHash(); });
  }
  applyHash();
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
    ROUTES, DEFAULT_ROUTE, LIBRARY_STATES, LIBRARY_TYPES, NOT_AVAILABLE,
    // helpers
    makeEl, makeLink, api, isApiAbort, humanMessage, formatAge, formatDuration,
    // routing and shell
    parseHash, applyHash, enterRoute, exitRoute, VIEWS, renderChrome, renderNav,
    // components
    statusBadge, renderPanelState, cardEl, packSummaryEl, renderPackPreview,
    freshnessLine, stationEl, stationState, stationNow, summaryRow,
    // overview
    overviewWarnings, poolCounts, configLines, renderOverview,
    // jobs started from this page
    recordJob, finishJob, recentJobs, renderJobs,
    // behaviour
    loadStatus, loadGrid, loadStation, scheduleSearch, shufflePreview,
    clearFilters, renderFilters, applyLibraryQuery, previewPack, previewOne,
    pollJob, doAction, enableBumper, deleteBumper, announce, refreshTick,
    handleVisibilityChange, submitAsk,
    resetStateForTests() {
      if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
      stopRefresh();
      libraryAbort = null;
      statusAbort = null;
      stationAbort = null;
      activeRoute = null;
      activeQuery = "";
      jobSeq = 0;
      askGeneration = 0;
      actionGeneration = 0;
      Object.assign(STATE, initialState());
    },
  };
}
