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

// ==== 1. Constants and state ====

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
const PAGE_SIZES = [24, 48, 100];   // the page-size control; 100 is the UI cap

// The five views. A hash naming anything else is not a view.
const ROUTES = ["overview", "library", "composer", "station", "operations"];
const DEFAULT_ROUTE = "overview";
// What /api/bumpers?state= and ?type= actually accept. A hash may say anything,
// so it is checked against these rather than forwarded on trust.
const LIBRARY_STATES = ["all", "playable", "parked", "dead", "unrendered"];
const LIBRARY_TYPES = ["video", "card", "stream", "image"];
// Grid or list: the one preference kept locally, a layout choice rather than a
// response, a job, a URL or a secret.
const LIBRARY_DENSITIES = ["grid", "list"];
const DENSITY_KEY = "bumparr.library.density";

// Said, once, wherever this build of the server does not report a field. Never
// a zero, a dash, or an invented default.
const NOT_AVAILABLE = "Not available in this version.";

// What the server's own docstrings say the destructive routes do, quoted rather
// than paraphrased so a confirmation cannot promise what the endpoint will not.
const DELETE_FILE_NOTE =
  "The registry row goes and its media file is deleted with it — an orphaned " +
  "file would be registered again by the next asset scan. A live stream has no " +
  "local file and only loses its row.";
const KEEP_FILE_LABEL = "Keep the media file on disk (delete the row only)";
// Opening HLS in a video element makes this page a real client of the station.
const LIVE_WARNING =
  "Playing this opens the live stream as a real client, which can advance playout.";
// The Clipboard API is a permission a browser may simply refuse. Said out loud
// rather than silently: a Copy that did nothing must not look like one that did.
const COPY_BY_HAND = "this browser would not let Bumparr use the clipboard — " +
  "the URL is selected, copy it with your keyboard";

// The server's eligibility vocabulary plus a plain reading. A reason not listed
// here is shown exactly as the server sent it.
const REASON_TEXT = {
  eligible: "eligible — nothing is gating it",
  disabled: "disabled — the row is parked",
  unhealthy: "unhealthy — the pool marked its media dead",
  missing_media: "missing media — there is nothing to play",
  base_weight: "base weight — its stored weight is zero or less",
  season: "season — this kind scores zero in the current season",
  daypart: "daypart — this kind scores zero at this hour",
  non_finite_score: "non-finite score — the computed score is not a number",
};

// The score is a product, and these are its terms in the order rotation.explain
// multiplies them. `score` is the server's own answer and is never recomputed.
const FACTOR_ORDER = ["base", "season", "daypart", "recency", "affinity", "fatigue"];
// Which `reasons` token the server raises when this term alone is the gate.
// recency, affinity and fatigue have none; inventing one would be a lie.
const ZERO_REASON = { base: "base_weight", season: "season", daypart: "daypart" };
const ZERO_UNNAMED = "the server raises no reason token for this factor";

// Said where a row records nothing at all about where it came from. It is a
// note, not a block: no curation control is disabled because of it.
const NO_PROVENANCE = "No provenance recorded";
const PROVENANCE_NOTE = "Nothing in this row records where it came from. Every " +
  "action above still works — this is a note, not a block.";
// A credits field the snapshot carries but left empty. Different from
// NOT_AVAILABLE: the build has the field, nobody filled it in.
const NOT_RECORDED = "not recorded";

// Configuration is read out of files the server loaded at startup. The
// dashboard reports what it loaded and offers nothing that could write one.
const FILE_OWNED = "Configuration is file-owned: the channel profile, the " +
  "music-bed manifest and the operator messages are edited in their files on " +
  "the server and loaded at startup. Nothing on this page writes them.";
const CONFIG_FILES = ["channel profile", "music manifest", "channel memory"];

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
      // `total` is the server's count of rows matching every filter before
      // limit/offset — null until a build that reports it answers, so
      // "how many matched" and "none matched" stay different answers.
      total: null, pageSize: PAGE, density: "grid",
    },
    // The one inspected row. `value` is the detail body, never the list row:
    // only the detail route carries uri, history and `selection`.
    // `notice` is the server's own last word on the last mutation. The live
    // region alone will not do: it is outside the modal, and inert under it.
    inspector: {
      id: null, open: false, value: null, loading: false, error: null,
      updatedAt: null, busy: "", notice: "", copied: null,
    },
    composer: {
      seconds: 30, tolerance: 1.5, maxItems: 8,
      placement: "any", types: [], result: null, loading: false, error: null,
      updatedAt: null, retry: null, loadingLabel: "",
      // The composed break is the server's; `stale` says a row under it moved
      // and it has to be composed again rather than patched up here.
      stale: false,
      // Where the local preview has got to. `index` is -1 while stopped.
      playback: { index: -1, playing: false, startedAt: null, elapsed: 0, duration: 0 },
    },
    // Jobs, from two sources. `items` is what THIS page started, newest first
    // (it knows a label before the POST answers, and covers the synchronous
    // actions the registry never sees); `server` is the last GET /api/jobs.
    jobs: { items: [], server: [], loading: false, error: null, updatedAt: null },
    // The operator surfaces' own state: which URL was last copied and how it
    // went, which channel preview is open, which actions are running (so only
    // the duplicate is disabled), a per-job doubt note, and the browser's
    // one-time answer about native HLS.
    ops: { copied: null, preview: null, running: {}, jobNotes: {}, hls: null },
    notices: [],
  };
}

const STATE = initialState();

let searchTimer = null;
let libraryAbort = null;
let statusAbort = null;
let stationAbort = null;
let jobsAbort = null;
let refreshTimer = null;
// What has actually been entered, as opposed to STATE.route (what is drawn).
// Re-entering the same route with the same query is a no-op, which is what
// keeps location.replace()'s own hashchange from loading everything twice.
let activeRoute = null;
let activeQuery = "";
// Which nav link has already been scrolled into view, so the 20-second refresh
// does not drag a phone's tab row back under the operator's thumb.
let navShown = null;
let jobSeq = 0;
// One counter per job surface: a superseded wait abandons its poll and stops
// writing, so it can neither overwrite newer feedback nor poll forever.
let askGeneration = 0;
let actionGeneration = 0;
let inspectorAbort = null;
let inspectorGeneration = 0;
// Modals, innermost last: a confirmation opened over the inspector is the one
// Escape and Tab reach, and a route change tears the whole stack down.
const DIALOGS = [];
let dialogSeq = 0;
// At most one preview is ever playing. This is the element that is.
let activeMedia = null;
// Handed to openInspector by the surface that opened it, so another surface can
// hear about a mutation without this file knowing anything about it.
let inspectorOnMutate = null;

// ==== 2. Safe DOM helpers ====

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// An answer to read fields off. A 200 with an empty body parses to null, and a
// mutation is still a mutation — but reading j.warning off null is a thrown
// click in a handler nothing is waiting on.
const asObject = (value) => (value && typeof value === "object" ? value : {});

// A plain object read as a map: a key an inherited property would answer for
// ("constructor", "toString", "__proto__") is not a value anyone stored, and
// every map on this page is keyed by something the server or the DOM supplied.
const own = (map, key) =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

// An operator who asked for reduced motion asked for it everywhere, including
// the places CSS cannot reach: a looping video started by a hover (which is a
// tap on a touch screen) is motion nobody asked for.
function reducedMotion() {
  try {
    return typeof matchMedia === "function" &&
      Boolean(matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; }
}

// Where the Clipboard API is absent, this IS the copy on an older browser. It
// only ever acts on the current selection, and a browser that refuses returns
// false rather than throwing — either way the caller says what happened.
function execCopy() {
  try {
    return typeof document !== "undefined" && document &&
      typeof document.execCommand === "function" &&
      Boolean(document.execCommand("copy"));
  } catch (e) { return false; }
}

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

// Every button on this page has words in it: an icon alone is unreadable by
// screen reader and ambiguous on a touch screen.
function makeButton(label, cls, onClick, ariaLabel) {
  const button = makeEl("button", cls, label);
  button.type = "button";
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

// Label always visible and bound by id: no placeholder says what a field is.
function labelledControl(id, labelText, control) {
  const wrap = makeEl("p", "field");
  const label = makeEl("label", "", labelText);
  label.setAttribute("for", id);
  control.id = id;
  wrap.append(label, control);
  return wrap;
}

// localStorage is a privilege, not a guarantee — a private window or a browser
// set to block storage makes these throw — and nothing in it is load-bearing.
function readLocal(key) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    return localStorage.getItem(key);
  } catch (e) { return null; }
}

function writeLocal(key, value) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return false;
    localStorage.setItem(key, String(value));
    return true;
  } catch (e) { return false; }
}

const now = () => Date.now();

// --- media: one preview at a time, and nothing left running ------------------
// Starting one stops whatever was playing: never two soundtracks, never two
// open streams.
function claimMedia(el) {
  if (activeMedia && activeMedia !== el && typeof activeMedia.pause === "function") {
    activeMedia.pause();
  }
  activeMedia = el;
}

function watchMedia(el) {
  el.addEventListener("play", () => claimMedia(el));
  el.addEventListener("pause", () => { if (activeMedia === el) activeMedia = null; });
  return el;
}

// Every rebuild of a card grid. Cards on their way out may hold a buffer or an
// open connection, and `activeMedia` must not point outside the document.
function fillGrid(el, nodes) {
  if (!el) return null;
  releaseMedia(el);
  el.replaceChildren(...nodes);
  return el;
}

// Pause AND detach: a paused <video> holds its buffer and an HLS element holds
// its connection, so a card going away has to let go of both — otherwise
// leaving the view keeps the station serving this page.
function releaseMedia(root) {
  if (!root || typeof root.querySelectorAll !== "function") return null;
  ["video", "audio"].forEach((tag) => {
    Array.from(root.querySelectorAll(tag)).forEach((el) => {
      if (typeof el.pause === "function") el.pause();
      if (el.removeAttribute) el.removeAttribute("src");
      el.src = "";
      if (typeof el.load === "function") { try { el.load(); } catch (e) { /* detached */ } }
      if (activeMedia === el) activeMedia = null;
    });
  });
  return null;
}

// ==== 3. API, error and abort helpers ====

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

// ==== 4. Routing and shell chrome ====
// Five hash views, no server routes and no router library. The hash says which
// view is on screen; STATE says what it shows, and nothing is read back out of
// the DOM — so a deep link, a back button and a first paint render the same
// way. Each view registers `enter` (paint from STATE, then read) and `exit`
// (give back what it holds); the shared teardown below stops the clock, the
// polls and the dialogs for all of them.

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

// Shared teardown first — clock, polls, modals, in-flight reads — then what the
// view holds itself. Dialogs and polls are here rather than in one view's exit:
// the inspector belongs to every surface that draws a card, and a conform is
// the same kind of job whether the Station or Operations started it.
function exitRoute(name) {
  stopRefresh();
  // Every job poll, whichever surface started it: a poll is a timer, and the
  // rule for timers is that none of them outlives the view. A job still
  // running on the server is picked up again by the background watch the next
  // time the operator opens Operations, which is where it can be seen.
  stopJobWatches();
  // A dialog hands focus back to whatever opened it, which here is a control
  // in the view about to be hidden: focus would land on <body> and the next
  // Tab would start again at the top of the page.
  const closed = closeAllDialogs();
  abortReads();
  // A short result belongs to the view it happened on. Carried across, it
  // reads as news about the view the operator has just arrived at.
  const live = $("#live-region");
  if (live) live.textContent = "";
  const view = VIEWS[name];
  if (view && view.exit) view.exit();
  if (closed) landOnMain();
}

// Where focus goes when the control that held it is being taken away.
function landOnMain() {
  const main = $("#main");
  if (main && main.focus) main.focus();
  return main;
}

// Cancelling is finished the moment it is asked for, not a microtask later when
// the rejection arrives: the next view's `enter` runs in this same turn, and a
// `loading` flag left standing would stop it issuing a read of its own.
function abortReads() {
  if (statusAbort) {
    statusAbort.abort();
    statusAbort = null;
    STATE.status.loading = false;
  }
  if (stationAbort) {
    stationAbort.abort();
    stationAbort = null;
    STATE.station.loading = false;
  }
  if (libraryAbort) {
    libraryAbort.abort();
    libraryAbort = null;
    STATE.library.loading = false;
  }
  if (composerAbort) {
    composerAbort.abort();
    composerAbort = null;
    STATE.composer.loading = false;
  }
  if (jobsAbort) {
    jobsAbort.abort();
    jobsAbort = null;
    STATE.jobs.loading = false;
  }
  // A route-level read like any other: an answer arriving after the view is
  // gone must not write into the dialog it was opened from.
  if (inspectorAbort) {
    inspectorAbort.abort();
    inspectorAbort = null;
    STATE.inspector.loading = false;
  }
  // The three job/read counters together: a surface that has been left behind
  // writes nothing. stopJobWatches has already ended the polls themselves, and
  // these are what stop the tail of an abandoned wait announcing its outcome
  // into a view that never started it.
  inspectorGeneration++;
  askGeneration++;
  actionGeneration++;
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
    if (link.dataset.view !== STATE.route) {
      link.removeAttribute("aria-current");
      return;
    }
    link.setAttribute("aria-current", "page");
    // Below 760px the nav is a horizontally scrolling tab row, so the tab the
    // operator is on can sit off-screen with its aria-current invisible. Only
    // on an actual change of view: this function runs on every refresh, and a
    // scroll on each of those would drag the page around under the operator.
    if (navShown !== STATE.route && link.scrollIntoView) {
      // "nearest" in both axes, and never "smooth": a correction, not motion.
      try { link.scrollIntoView({ block: "nearest", inline: "nearest" }); }
      catch (e) { /* an older signature; the tab row still scrolls by hand */ }
    }
  });
  navShown = STATE.route;
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

// Why there is no /api/status body to read a field out of, or "" when there is
// one. "Not available in this version." is reserved for a read that landed and
// simply did not carry the field: never read, still reading, and read-and-failed
// are three different facts, and a server that has not answered has not told us
// anything about what it supports. The failure itself is spelled out by the
// panel's own error state, so this stays short enough to repeat in a field row.
function statusGap() {
  const s = STATE.status;
  if (s.value) return "";
  // A failure that is already being retried is still a failure, but saying so
  // without saying a retry is in flight makes a live Retry look like a dead one.
  if (s.error) return s.loading ? "not read: the last try failed, trying again"
                                : "not read: the last try failed";
  if (s.loading) return "reading the service…";
  return "not read yet";
}

function renderHeaderMeta(at) {
  const profileEl = $("#header-profile");
  if (profileEl) {
    const gap = statusGap();
    const profile = STATE.status.value && STATE.status.value.profile;
    if (gap) {
      profileEl.replaceChildren(STATE.status.error
        ? statusBadge("offline", "profile · " + gap)
        : makeEl("span", "hmeta-text", "profile · " + gap));
    } else if (!profile || typeof profile !== "object") {
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
    // The age of the /api/status read specifically, named as such: only two
    // views re-read it, so on the Station this climbs while the station body
    // beneath it is seconds old, and a bare "updated" would misreport that.
    refreshEl.textContent = STATE.status.updatedAt
      ? "service read " + formatAge(STATE.status.updatedAt, at)
      : "service not read yet";
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

// Overview reads GET /api/status, GET /api/station and GET /api/jobs, and
// nothing else. All three are pure — /api/jobs is documented as never starting,
// cancelling or changing a job — so no station timeline is created or advanced
// by opening it. The jobs read is what makes the recent list and the failed-job
// warning cover the whole registry rather than only this tab's own work.
function enterOverview() {
  renderOverview();
  startRefresh();
  return Promise.all([loadStatus(), loadStation(), loadJobs()]);
}

function exitOverview() { return null; }

function enterLibrary(params) {
  STATE.library.density = storedDensity();
  applyLibraryQuery(params);
  renderFilters();
  renderLibrary();
  renderLibraryState();
  return Promise.all([ensureStatus(), loadGrid(true)]);
}

// What the library holds beyond the reads and modals exitRoute already tears
// down: the search debounce, and every media element still buffering.
function exitLibrary() {
  if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
  releaseMedia($("#grid"));
  return null;
}

function enterComposer() {
  readComposerControls();
  renderComposer();
  return ensureStatus();
}

// A sequence is the one thing on this page that runs by itself: leaving takes
// its timers, its readout and the medium on its stage with it. The fill read is
// cancelled by abortReads with every other route-level read.
function exitComposer() { return stopComposerPlayback(); }

function enterStation() {
  renderStationState();
  renderStation();
  renderActionLocks();
  startRefresh();
  return Promise.all([ensureStatus(), loadStation()]);
}

// The preview is the one thing here that holds a connection open.
function exitStation() { return closeStationPreview(); }

function enterOperations() {
  renderActionLocks();
  renderJobs();
  return Promise.all([ensureStatus(), loadJobs()]);
}

// Job polls are torn down by exitRoute for every view, not just this one: a
// conform started on the Station is the same kind of timer as one started here.
function exitOperations() { return null; }

// ==== 5. Shared components: badges, panel states, notices, cards ====

// Icon and word first, colour last: a status must survive a monochrome screen.
const STATUS_LEVELS = {
  healthy: { icon: "✓", word: "Healthy" },
  working: { icon: "◐", word: "Working" },
  attention: { icon: "▲", word: "Attention" },
  failed: { icon: "✕", word: "Failed" },
  offline: { icon: "⌁", word: "Offline" },
};

function statusBadge(level, detail) {
  const known = own(STATUS_LEVELS, level);
  const spec = known || STATUS_LEVELS.attention;
  const root = makeEl("span", "badge badge-" + (known ? level : "attention"));
  const icon = makeEl("span", "badge-icon", spec.icon);
  icon.setAttribute("aria-hidden", "true");
  root.append(icon, makeEl("span", "badge-word", spec.word));
  if (detail !== undefined && detail !== null && detail !== "") {
    root.append(makeEl("span", "badge-detail", detail));
  }
  return root;
}

// A job surface: one badge plus whatever escape controls the poller offers.
// `dataset.state` carries the job's level rather than a panel state; the caller
// hands the region back to renderPanelState once the job ends.
function renderJobState(el, level, message, actions) {
  if (!el) return null;
  const nodes = [statusBadge(level, message)];
  (actions || []).forEach((action) => {
    const button = makeEl("button", "mini", action.label);
    button.addEventListener("click", action.onClick);
    nodes.push(button);
  });
  el.className = "panel-state panel-state-" + level;
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

// The state ladder every read-backed region shares, written once so no two
// panels can disagree about what a half-finished read looks like.
function readState(source, retry) {
  if (source.error && source.value) {
    return { state: "stale", message: source.error, updatedAt: source.updatedAt,
             onAction: retry };
  }
  if (source.error) return { state: "error", message: source.error, onAction: retry };
  if (!source.value) return { state: "loading" };
  return { state: "populated" };
}

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
    const label = opts.actionLabel || "Retry";
    const button = makeEl("button", "panel-retry", label);
    // A Retry whose read lands on the same stale line looks like a dead
    // button, so the control itself says it is working until its replacement
    // is drawn. Only the default label: "Clear filters" is not a retry.
    button.addEventListener("click", () => {
      button.disabled = true;
      if (label === "Retry") button.textContent = "Retrying…";
      opts.onAction();
    });
    el.append(button);
  }
  return el;
}

// --- dialogs ----------------------------------------------------------------
// Native <dialog> where the browser has one, a fixed panel with the same
// role/aria-modal where it does not. Shared by the inspector and every
// confirmation, so focus, Escape and teardown cannot drift apart. Without
// HTMLDialogElement a <dialog> is an unknown element with no showModal, so the
// feature test checks both.
const nativeDialog = (node) => typeof HTMLDialogElement !== "undefined" &&
  Boolean(node) && typeof node.showModal === "function";

// Tab order inside a modal, in document order, skipping what the browser skips.
// Everything the browser really puts in that order, not only the form controls:
// a <video controls> in the inspector is the item under review, and a trap that
// walked past it left a keyboard operator unable to play what they were
// looking at. <summary> and an explicit non-negative tabindex are here for the
// same reason — the inspector's own heading carries tabindex="-1" and is
// correctly not a stop.
const FOCUS_TAGS = ["button", "input", "select", "textarea", "summary"];
const MEDIA_TAGS = ["video", "audio"];
const tabIndexed = (node) => {
  const raw = node.getAttribute ? node.getAttribute("tabindex") : null;
  return raw !== null && raw !== undefined && raw !== "" && Number(raw) >= 0;
};
const hasControls = (node) => Boolean(node.controls) ||
  (node.getAttribute ? node.getAttribute("controls") !== null : false);

function focusables(root) {
  const out = [];
  const walk = (node) => {
    Array.from((node && node.children) || []).forEach((child) => {
      const tag = String(child.tagName || "").toLowerCase();
      const focusable = FOCUS_TAGS.indexOf(tag) !== -1 ||
        (tag === "a" && child.href) ||
        (MEDIA_TAGS.indexOf(tag) !== -1 && hasControls(child)) ||
        Boolean(child.isContentEditable) || tabIndexed(child);
      if (focusable && !child.disabled && !child.hidden) out.push(child);
      walk(child);
    });
  };
  walk(root);
  return out;
}

// Every control a modal owns, disabled or not. `focusables` skips a disabled
// element by design, so using it to hand controls BACK would leave them
// disabled for ever; and only these four tags have a disabled state at all —
// setting one on a <video> would be an expando the browser ignores.
function modalControls(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return ["button", "input", "select", "textarea"]
    .reduce((all, tag) => all.concat(Array.from(root.querySelectorAll(tag))), []);
}

// Trapped only while modal, and only by wrapping: nothing outside is disabled.
function trapTab(node, event) {
  const list = focusables(node);
  if (!list.length) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const at = list.indexOf(active);
  const next = event.shiftKey
    ? (at <= 0 ? list.length - 1 : at - 1)
    : (at === -1 || at === list.length - 1 ? 0 : at + 1);
  if (event.preventDefault) event.preventDefault();
  list[next].focus();
}

// Escape always closes, destructive confirmations included: closing IS the
// cancel, running the same `finish(false)` Cancel does. The rule forbids
// Escape from *confirming*, not from refusing.
function openDialog(node, opts) {
  if (!node) return null;
  const options = opts || {};
  const entry = {
    node,
    invoker: options.invoker ||
      (typeof document !== "undefined" ? document.activeElement : null),
    onClose: typeof options.onClose === "function" ? options.onClose : null,
  };
  if (DIALOGS.indexOf(entry) === -1) DIALOGS.push(entry);
  entry.keydown = (event) => {
    if (DIALOGS[DIALOGS.length - 1] !== entry) return;
    if (event.key === "Escape") {
      if (event.preventDefault) event.preventDefault();
      closeDialog(node);
      return;
    }
    if (event.key === "Tab") trapTab(node, event);
  };
  node.addEventListener("keydown", entry.keydown);
  // A native dialog turns Escape into `cancel`; preventDefault so this file
  // owns the teardown, then close through the same door.
  entry.cancel = (event) => {
    if (event.preventDefault) event.preventDefault();
    closeDialog(node);
  };
  node.addEventListener("cancel", entry.cancel);
  if (nativeDialog(node)) {
    node.showModal();
  } else {
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("open", "");
  }
  if (options.focus && options.focus.focus) options.focus.focus();
  return entry;
}

function closeDialog(node) {
  const at = DIALOGS.findIndex((entry) => entry.node === node);
  if (at === -1) return null;
  const entry = DIALOGS[at];
  DIALOGS.splice(at, 1);
  node.removeEventListener("keydown", entry.keydown);
  node.removeEventListener("cancel", entry.cancel);
  if (nativeDialog(node)) node.close();
  else node.removeAttribute("open");
  if (entry.invoker && entry.invoker.focus) entry.invoker.focus();
  if (entry.onClose) entry.onClose();
  return entry;
}

// Innermost first, so each one hands focus back to whatever opened it. Returns
// how many were closed: a caller tearing a view down has to know whether focus
// was just handed to a control it is about to hide.
function closeAllDialogs() {
  let closed = 0;
  while (DIALOGS.length) { closeDialog(DIALOGS[DIALOGS.length - 1].node); closed++; }
  return closed;
}

/**
 * confirmDialog({title, body, confirmLabel, cancelLabel, danger, requireText,
 *                requireLabel, checkbox}) -> Promise<boolean>
 *
 * `body` is a string or an array of paragraphs. `requireText` gates the confirm
 * button behind typing that exact word. `checkbox` is a mutable `{label,
 * checked}` the caller reads back afterwards, so the promise stays a yes/no.
 * A danger dialog puts Cancel first in the DOM (first by tab and by screen
 * reader) and focuses it; the destructive button is never the default, and
 * dismissing the dialog any way at all resolves false.
 */
function confirmDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "dlg dlg-confirm" + (opts.danger ? " dlg-danger" : "");
    const titleId = "dlg-title-" + (++dialogSeq);
    const heading = makeEl("h2", "dlg-title", opts.title || "Are you sure?");
    heading.id = titleId;
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.append(heading);
    const lines = Array.isArray(opts.body) ? opts.body : [opts.body];
    lines.forEach((line) => {
      if (line) dialog.append(makeEl("p", "dlg-line", String(line)));
    });

    let typed = null;
    if (opts.requireText) {
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      typed = input;
      dialog.append(labelledControl("dlg-require-" + dialogSeq,
        opts.requireLabel || ("Type " + String(opts.requireText) + " to confirm"),
        input));
    }
    let box = null;
    if (opts.checkbox) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(opts.checkbox.checked);
      box = input;
      const row = labelledControl("dlg-keep-" + dialogSeq,
        String(opts.checkbox.label || "Keep the file"), input);
      row.className = "field field-check";
      dialog.append(row);
    }

    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      if (box && opts.checkbox) opts.checkbox.checked = Boolean(box.checked);
      closeDialog(dialog);
      dialog.remove();
      resolve(answer);
    };

    const actions = makeEl("div", "dlg-actions");
    const cancel = makeButton(opts.cancelLabel || "Cancel", "dlg-cancel",
                              () => finish(false));
    const accept = makeButton(opts.confirmLabel || "Confirm",
                              "dlg-confirm" + (opts.danger ? " danger-btn" : ""),
                              () => finish(true));
    if (typed) {
      accept.disabled = true;
      const gate = () => {
        accept.disabled = String(typed.value || "").trim() !== String(opts.requireText);
      };
      typed.addEventListener("input", gate);
      typed.addEventListener("change", gate);
    }
    actions.append(cancel, accept);
    dialog.append(actions);
    document.body.appendChild(dialog);
    openDialog(dialog, {
      focus: opts.danger ? cancel : accept,
      onClose: () => finish(false),
    });
    return null;
  });
}

/**
 * copyControls(id, label, value, store, opts) -> {input, copy, said}
 *
 * A read-only field, a Copy control and a visible sentence about what happened,
 * shared by the inspector's media URL and the Station's handoff URLs so the two
 * cannot drift apart. Placement is the caller's: the inspector puts these in a
 * block, the Station in a row.
 *
 * A field rather than a link — following a link opens the media when what is
 * wanted is the string. The Clipboard API is a permission a browser may simply
 * refuse, and a Copy that did nothing cannot be told from one that worked, so
 * every path ends in a badge and an announcement. Where the API is missing or
 * refuses, the field is focused and selected and `document.execCommand("copy")`
 * is tried, because on an older browser that IS the copy; only when that fails
 * too is the operator asked to press the keys themselves.
 *
 * `store` is the caller's own record of the last copy — kept in STATE, so a
 * redraw repeats the answer instead of losing it.
 */
function copyControls(id, label, value, store, opts) {
  const options = opts || {};
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.className = "url";
  input.value = String(value);
  input.id = id;
  const select = () => { if (input.select) input.select(); };
  // Focus first: a selection in an unfocused field is not what execCommand
  // copies, and it is not what the operator's own Ctrl-C would copy either.
  const takeSelection = () => { if (input.focus) input.focus(); select(); };
  input.addEventListener("focus", select);

  const said = makeEl("p", options.saidClass || "insp-copy");
  const show = () => {
    const done = store.read();
    said.replaceChildren(...(done ? [statusBadge(done.level, done.message)] : []));
  };
  const report = (level, message) => {
    store.write(level, message);
    show();
    announce(message);
  };
  const done = () => report("healthy", label + " copied to the clipboard");
  const byHand = () => {
    takeSelection();
    return execCopy() ? done() : report("attention", COPY_BY_HAND);
  };
  const copy = makeButton("Copy", options.copyClass || "insp-copy-btn mini", () => {
    const clip = typeof navigator !== "undefined" && navigator && navigator.clipboard;
    if (!clip || !clip.writeText) return byHand();
    return clip.writeText(input.value).then(done, byHand);
  }, "Copy the " + label);
  show();
  return { input, copy, said };
}

// One labelled fact. Used by every summary block so a missing value reads the
// same way everywhere it appears.
function summaryRow(label, value) {
  const row = makeEl("div", "summary-row");
  row.append(makeEl("span", "lbl", label), makeEl("span", "val", value));
  return row;
}

// Whether the server actually sent something to show. `false` and `0` are
// values a field can legitimately hold, so only absent and empty are missing —
// and an empty array is empty: String([]) is "", which would print as nothing
// at all rather than as the caller's own word for absent.
const present = (value) => value !== undefined && value !== null && value !== "" &&
  !(Array.isArray(value) && value.length === 0);

// A value the server sent, or the sentence that says it did not. `absent` is for
// a field whose emptiness means something (no tags is not a missing column).
function fieldText(value, absent) {
  if (!present(value)) return absent === undefined ? NOT_AVAILABLE : absent;
  return String(value);
}

// `[label, value]` pairs to labelled facts: a block is a list of what it shows.
const facts = (pairs) => pairs.map(([label, value]) => summaryRow(label, value));

// A boolean the server actually sent, said in words; NOT_AVAILABLE otherwise.
const yesNo = (value, yes, no) => typeof value === "boolean" || value === 0 || value === 1
  ? (value ? (yes || "yes") : (no || "no")) : NOT_AVAILABLE;

const num = (value) => present(value) ? String(value) : NOT_AVAILABLE;

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

// Family and audio are what a shelf of cards is scanned by, so they are labelled
// chips; roles, energy, template and brand mode are one press away in the
// inspector. Neither resolved keeps F2's sentence rather than showing nothing.
function creativeChips(b) {
  const cr = b.creative && typeof b.creative === "object" ? b.creative : {};
  const box = makeEl("div", "pv-chips");
  const chips = [["family", cr.family], ["audio", cr.audio]]
    .filter((pair) => present(pair[1]))
    .map(([label, value]) => {
      const chip = makeEl("span", "pv-chip");
      chip.append(makeEl("span", "pv-chip-k", label),
                  makeEl("span", "pv-chip-v", String(value)));
      return chip;
    });
  box.append(...(chips.length ? chips
                              : [makeEl("span", "pv-chip-none", NOT_AVAILABLE)]));
  return box;
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

const hasMedia = (b) => typeof b.media_url === "string" && b.media_url !== "";

// The state filter's own vocabulary, from explicit fields only. "unknown" is a
// real answer: /api/bumpers/random sends no `enabled` key at all, and reading
// that absence as a state would invent one.
function poolState(b) {
  const row = b && typeof b === "object" ? b : {};
  if (row.health === "dead") return "dead";
  if (row.enabled === 0 || row.enabled === false) return "parked";
  if (row.enabled === undefined || row.enabled === null) return "unknown";
  if (row.type === "card" && !hasMedia(row)) return "unrendered";
  return "playable";
}

// Icon + word + colour, and the state's own name as the detail.
const STATE_BADGES = {
  playable: ["healthy", "playable"],
  parked: ["attention", "parked"],
  dead: ["failed", "dead — the pool could not read its media"],
  unrendered: ["attention", "unrendered — no media file yet"],
};

function stateBadge(b) {
  const spec = STATE_BADGES[poolState(b)];
  if (!spec) return null;
  const badge = statusBadge(spec[0], spec[1]);
  badge.classList.add("pv-state");
  return badge;
}

function decorateCard(card, b) {
  card.append(creativeChips(b));
  const cred = creditsLine(b);
  if (cred) card.append(makeEl("div", "pv-credits", cred));
  const prov = provenanceLine(b);
  if (prov) card.append(makeEl("div", "pv-meta", prov));
  const fac = factorsLine(b);
  if (fac) card.append(makeEl("div", "pv-factors", fac));
  const fresh = freshnessLine(b);
  if (fresh) card.append(makeEl("div", "pv-freshness", fresh));
}

// Every video this page makes: muted, controlled, metadata-only. Sound is never
// started for anyone, the controls are what a keyboard or touch screen uses, and
// `preload` is "none" for a stream — catalog HLS is never fetched unasked.
function mediaVideo(src, label, preload) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.controls = true;
  v.preload = preload || "metadata";
  v.src = String(src);
  v.setAttribute("aria-label", label);
  return watchMedia(v);
}

function videoPreview(b) {
  const v = mediaVideo(String(b.media_url || "") + "#t=2", "Preview of " + rowLabel(b));
  v.loop = true;
  return v;
}

// Never opened on render, on hover, or on page load: the badge says it is live,
// the note says what Play does to the station, and only the press builds an
// element that holds the URL.
function streamPreview(b) {
  const box = makeEl("div", "pv-stream-box");
  const badge = makeEl("div", "pv-stream", "◉ LIVE");
  const note = makeEl("p", "pv-live-note", LIVE_WARNING);
  const play = makeButton("▶ Play live stream", "pv-play mini", () => {
    if (!hasMedia(b)) { announce("this stream has no URL to open"); return; }
    const v = mediaVideo(b.media_url, "Live stream " + rowLabel(b), "none");
    box.replaceChildren(badge, v, note);
    claimMedia(v);
    if (typeof v.play === "function") { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  }, "Play the live stream " + rowLabel(b));
  box.append(badge, play, note);
  return box;
}

// A row the pool marked dead has media it could not read. Pointing an element
// at it buys a console 404 and a broken box where the honest answer is words.
const deadPreview = () => makeEl("div", "pv-stream pv-dead", "media unreadable");

/**
 * One row as a card.
 *
 * `opts.onMutate(kind, id)` is forwarded to the inspector this card opens, so
 * a surface that has its own idea of staleness (the composer's break) hears
 * about a disable/enable/render/delete without this file knowing about it.
 */
function cardEl(b, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const card = makeEl("article", "pv-card");
  card.dataset.state = poolState(b);
  // A run of unnamed <article>s is what a screen reader announces otherwise.
  card.setAttribute("aria-label", rowLabel(b));
  const body = makeEl("div", "pv-body");
  // A stream has no length: it runs until it stops.
  const lengthLine = (b.type === "stream" ? "LIVE" : formatDuration(b.duration)) +
    (b.type == null || b.type === "" ? "" : " · " + String(b.type));
  if (b.type === "video" || b.type === "image") {
    if (poolState(b) === "dead") card.append(deadPreview());
    else if (b.type === "image") card.append(imagePreview(b));
    else {
      const v = videoPreview(b);
      card.append(v);
      // A pointer may preview on hover, claiming the one preview slot as a
      // press of Play would — unless reduced motion was asked for, because on
      // a touch screen this fires on a tap. The controls still start it.
      card.addEventListener("mouseenter", () => {
        if (reducedMotion()) return;
        const started = v.play();
        if (started && started.catch) started.catch(() => {});
      });
      card.addEventListener("mouseleave", () => { v.pause(); });
    }
  } else if (b.type === "stream") {
    card.append(streamPreview(b));
  } else {
    const p = b.payload || {};
    const txt = p.lines ? p.lines.join("\n") : (p.number || p.text || b.title || "");
    card.className = "pv-card pv-textcard";
    card.append(makeEl("div", "tc", txt));
  }
  body.append(makeEl("div", "pv-kind", b.kind == null ? "" : b.kind),
              makeEl("div", "pv-title", b.title == null ? "" : b.title),
              makeEl("div", "pv-meta", lengthLine));
  const badge = stateBadge(b);
  if (badge) body.append(badge);
  card.append(body);
  decorateCard(card, b);
  // Never hidden: everything that changes or removes a row is behind it.
  if (b.id !== undefined && b.id !== null && String(b.id) !== "") {
    const actions = makeEl("div", "pv-actions");
    const inspect = makeButton("Inspect", "pv-inspect mini",
      () => { openInspector(b.id, { invoker: inspect, onMutate: options.onMutate }); },
      "Inspect " + rowLabel(b));
    actions.append(inspect);
    card.append(actions);
  }
  return card;
}

function imagePreview(b) {
  const img = document.createElement("img");
  img.src = String(b.media_url || "");
  img.alt = "Preview of " + rowLabel(b);
  img.loading = "lazy";
  return img;
}

// ==== 6. Overview ====

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
    // A server-supplied key read as a map: "constructor" must not answer with
    // a Function that CSSOM then silently rejects, losing the bar's colour.
    fill.style.background = own(TYPE_COLOR, t) || "var(--accent)";
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
//
// `gap` is statusGap's sentence: while it is set nothing is known about these
// fields, which is not the claim that the server lacks them. Shared with the
// Station's full block so the two cannot disagree. `fallback-after-error` is
// the server saying it could not read its file and is running the default.
const configLevel = (part) => part.valid === false ||
  part.source === "fallback-after-error" ? "attention" : "healthy";
const configSay = (part) =>
  String(part.source == null ? "unknown source" : part.source) +
  (part.valid === false ? " · invalid, running the shipped default" : " · valid");

function configLines(s, gap) {
  if (gap) {
    return [{ label: "profile", text: String(gap), level: null },
            { label: "music", text: String(gap), level: null }];
  }
  const status = s && typeof s === "object" ? s : {};
  const lines = [];
  const profile = status.profile;
  if (profile && typeof profile === "object") {
    lines.push({ label: "profile", text: configSay(profile),
                 level: configLevel(profile) });
  } else {
    lines.push({ label: "profile", text: NOT_AVAILABLE, level: null });
  }
  const music = status.music;
  if (music && typeof music === "object") {
    const beds = typeof music.enabled_beds === "number" ? music.enabled_beds : null;
    lines.push({
      label: "music", level: configLevel(music),
      text: configSay(music) +
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
  el.replaceChildren(...configLines(STATE.status.value, statusGap()).map((line) => {
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
  const gap = statusGap();
  const brand = s.value && s.value.brand;
  const version = s.value && s.value.version;
  el.replaceChildren(
    statusBadge(level, detail),
    // The badge above carries the real failure; these rows only say whether
    // there is an answer to read a field out of at all.
    summaryRow("brand",
      gap || (brand == null || brand === "" ? NOT_AVAILABLE : String(brand))),
    summaryRow("version",
      gap || (version === undefined || version === null || version === ""
        ? "not reported" : String(version))),
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
        // The list is the whole registry now, not only this tab's work, so the
        // warning no longer claims to know where the job came from.
        "A job failed: " + String(failed.label) + ".",
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

// Warnings before the healthy detail, and an overview with nothing wrong says
// so rather than showing an empty box. The failed-job warning is drawn from the
// same five rows the panel below shows, not from all twenty: a failure the
// operator cannot see listed is one they cannot act on.
function renderWarnings() {
  const warnings = overviewWarnings(STATE.status.value, STATE.station.value,
                                    recentJobs(jobsList()));
  const list = $("#warnings");
  if (list) list.replaceChildren(...warnings.map(warningEl));
  const el = $("#warnings-state");
  if (!el) return null;
  if (!STATE.status.value && !STATE.station.value) {
    // Nothing was read, so nothing was checked. Saying "loading" over a read
    // that already failed would read as "all clear so far". The Retry sits on
    // the pool region directly above rather than being offered twice.
    if (STATE.status.error || STATE.station.error) {
      return renderPanelState(el, { state: "error",
        message: "Nothing could be read, so nothing has been checked." });
    }
    return renderPanelState(el, { state: "loading" });
  }
  if (!warnings.length) {
    return renderPanelState(el, { state: "empty", message: "Nothing needs attention." });
  }
  return renderPanelState(el, { state: "populated" });
}

function renderOverviewState() {
  // `loading && !value` first, so the 20-second refresh does not blink
  // "Working" over counts that are already on screen and still correct.
  const s = STATE.status;
  return renderPanelState($("#pool-state"), s.loading && !s.value
    ? { state: "loading" } : readState(s, () => { loadStatus(); }));
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
  const controller = new AbortController();
  statusAbort = controller;
  STATE.status.loading = true;
  renderOverviewState();
  let s;
  try {
    s = await api("/api/status", { signal: controller.signal });
  } catch (err) {
    // Only the read that is still the current one may write. A read that was
    // superseded or dropped by a route change has already had its flags
    // settled, and clearing them again here would undo its replacement's.
    if (statusAbort !== controller) return null;
    STATE.status.loading = false;
    if (isApiAbort(err)) return null;
    STATE.status.error = err.message;
    renderOverview();
    renderStationConfig();
    return null;
  }
  // The same guard the catch already had: only the read that is still the
  // current one may write, success included.
  if (statusAbort !== controller) return null;
  STATE.status.loading = false;
  STATE.status.error = null;
  STATE.status.value = asObject(s);
  STATE.status.updatedAt = now();
  renderOverview();
  renderFilters();
  // Two other views read the same body: the library's kind list, and the
  // Station's configuration block. One read, every surface that shows it.
  renderStationConfig();
  return s;
}

// ==== 7. Library ====

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
    lib.total = null;
    lib.error = null;
    lib.updatedAt = null;
    lib.source = "listing";
  }
  const search = $("#search");
  if (search) search.value = f.q;
}

// The hash query the current filters describe, written back on every change so
// the address bar is always a deep link to what is on screen.
function libraryQuery() {
  const f = STATE.library.filters;
  const params = new URLSearchParams();
  if (f.state && f.state !== "all") params.set("state", f.state);
  if (f.type) params.set("type", f.type);
  if (f.kind) params.set("kind", f.kind);
  if (f.q) params.set("q", f.q);
  return params.toString();
}

const libraryHash = () => {
  const query = libraryQuery();
  return "#/library" + (query ? "?" + query : "");
};

// An in-page move to another view, through the same hash the anchors use, so
// the router handles it exactly as a click on the nav would.
function goTo(hash) {
  if (typeof location !== "undefined" && location) location.hash = hash;
  return hash;
}

// The control focus would go back to has just been removed with its row, and
// focus falling to <body> sends the next Tab to the top of the page. The counts
// line above the grid is stable, and its text is the news the removal made.
function landAfterRemoval() {
  if (STATE.route !== "library") return null;
  const el = $("#library-counts");
  if (el && el.focus) el.focus();
  return el;
}

// replace(), not assign(): a filter change is a correction to where you are, not
// a stop on the way back. `activeQuery` moves first on purpose — replace() fires
// a hashchange, and enterRoute's "same route, same query" no-op is what stops
// every filter change re-reading the view.
function syncLibraryHash() {
  if (activeRoute !== "library") return null;
  const query = libraryQuery();
  if (activeQuery === query) return null;
  activeQuery = query;
  if (typeof location !== "undefined" && location && location.replace) {
    location.replace(libraryHash());
  }
  return query;
}

// One door for every filter control. A <select>'s value is checked against what
// /api/bumpers accepts exactly as a hash value is.
function setFilter(name, raw) {
  const f = STATE.library.filters;
  const value = String(raw === undefined || raw === null ? "" : raw);
  if (name === "state") {
    f.state = LIBRARY_STATES.indexOf(value) === -1 ? "all" : value;
  } else if (name === "type") {
    f.type = LIBRARY_TYPES.indexOf(value) === -1 ? null : value;
  } else if (name === "kind") {
    f.kind = value ? value.slice(0, MAX_FILTER_TEXT) : null;
  } else {
    return null;
  }
  renderFilters();
  syncLibraryHash();
  return loadGrid(true);
}

// The server accepts up to 1000; this page never asks for more than 100.
function setPageSize(raw) {
  const n = Number(raw);
  STATE.library.pageSize = PAGE_SIZES.indexOf(n) === -1
    ? (isFinite(n) && n > PAGE_SIZES[PAGE_SIZES.length - 1]
        ? PAGE_SIZES[PAGE_SIZES.length - 1] : PAGE)
    : n;
  renderFilters();
  return loadGrid(true);
}

const storedDensity = () => {
  const saved = readLocal(DENSITY_KEY);
  return LIBRARY_DENSITIES.indexOf(String(saved)) === -1 ? "grid" : String(saved);
};

// Layout only: it changes no row, so it neither re-reads nor enters the hash.
function setDensity(raw) {
  const value = String(raw === undefined || raw === null ? "" : raw);
  STATE.library.density = LIBRARY_DENSITIES.indexOf(value) === -1 ? "grid" : value;
  writeLocal(DENSITY_KEY, STATE.library.density);
  renderFilters();
  applyDensity();
  return STATE.library.density;
}

function applyDensity() {
  const grid = $("#grid");
  if (grid) grid.className = "grid" + (STATE.library.density === "list" ? " grid-list" : "");
}

function clearFilters() {
  STATE.library.filters.kind = null;
  STATE.library.filters.q = "";
  STATE.library.filters.type = null;
  STATE.library.filters.state = "all";
  if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
  const search = $("#search");
  if (search) search.value = "";
  renderFilters();
  syncLibraryHash();
  return loadGrid(true);
}

// The controls are static in index.html; this puts the current filters into them
// and rebuilds the one data-driven list. It never writes #search — the operator
// may be mid-word, and applyLibraryQuery and clearFilters own that field.
function renderFilters() {
  const f = STATE.library.filters;
  const kindSel = $("#filter-kind");
  if (kindSel) {
    const counts = poolKinds();
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const option = (value, label) => {
      const node = makeEl("option", "", label);
      node.value = value;
      return node;
    };
    const nodes = [option("", "All kinds")];
    // A deep link can name a kind the counts no longer list. Dropping it would
    // leave the control reading "All kinds" over a still-filtered listing.
    if (f.kind && names.indexOf(f.kind) === -1) nodes.push(option(f.kind, f.kind));
    names.forEach((name) => nodes.push(option(name, name + " (" + counts[name] + ")")));
    kindSel.replaceChildren(...nodes);
    kindSel.value = f.kind || "";
  }
  const set = (sel, value) => { const el = $(sel); if (el) el.value = value; };
  set("#filter-type", f.type || "");
  set("#filter-state", f.state);
  set("#page-size", String(STATE.library.pageSize));
  set("#density", STATE.library.density);
  renderDangerZone();
}

// How many rows this build says the kind holds, or null where it says nothing.
function kindCount(kind) {
  const counts = poolKinds();
  return Object.prototype.hasOwnProperty.call(counts, kind) ? counts[kind] : null;
}

// Offered only while a kind is selected — never beside "all kinds", where a
// mis-click would empty the pool.
function renderDangerZone() {
  const kind = STATE.library.filters.kind;
  const button = $("#drop-kind");
  const note = $("#danger-note");
  const known = kindCount(kind);
  if (button) {
    button.disabled = !kind;
    button.textContent = kind
      ? "Delete every item in “" + kind + "”"
      : "Delete every item in this kind";
  }
  if (!note) return;
  if (!kind) {
    note.textContent = "Choose a kind above to delete the whole category. " +
      "Nothing here is reversible.";
    return;
  }
  note.textContent = "Deletes " + (known === null ? "every item" : known + " item(s)") +
    " of kind “" + kind + "”. " + DELETE_FILE_NOTE;
}

// "Showing N of TOTAL". `total` is what the server matched before paging; a
// build that reports none says so rather than letting the loaded count stand
// in for the matched count.
function libraryCounts() {
  const lib = STATE.library;
  const loaded = lib.items.length;
  const total = typeof lib.total === "number" && isFinite(lib.total) ? lib.total : null;
  return { loaded, total, hasMore: total === null ? lib.hasMore : loaded < total };
}

function renderLibraryCounts() {
  const el = $("#library-counts");
  if (!el) return null;
  const counts = libraryCounts();
  // A shuffle draw is not a filtered listing, so it does not claim to be one.
  const scope = STATE.library.source === "shuffle" ? " drawn at random"
    : (filtersActive() ? " matching the current filters" : " in the pool");
  el.textContent = counts.total === null
    ? "Showing " + counts.loaded + " loaded · matched total: " + NOT_AVAILABLE
    : "Showing " + counts.loaded + " of " + counts.total + scope + ".";
  return el;
}

// --- reversible curation -----------------------------------------------------
// Every mutation updates exactly the row it changed and refreshes the counts.
// None re-reads the listing: the filters, page offset and scroll position are
// the operator's, not something an action may reset.
function patchLibraryRow(id, patch) {
  const lib = STATE.library;
  const at = lib.items.findIndex((row) => row && row.id === id);
  if (at === -1) return null;
  lib.items[at] = Object.assign({}, lib.items[at], patch || {});
  const grid = $("#grid");
  const card = grid && grid.children ? grid.children[at] : null;
  if (card) {
    releaseMedia(card);
    grid.replaceChild(cardEl(lib.items[at], { onMutate: markComposerStale }), card);
  }
  return lib.items[at];
}

// What every mutation does afterwards: the row, the open inspector, the counts,
// whoever asked to be told, and the server's own `notice` shown inline.
function afterMutation(kind, id, patch, notice) {
  STATE.inspector.notice = notice ? String(notice) : "";
  patchLibraryRow(id, patch);
  const inspected = STATE.inspector.value;
  if (inspected && inspected.id === id) {
    if (patch) STATE.inspector.value = Object.assign({}, inspected, patch);
    renderInspector();
    renderInspectorState();
  }
  loadStatus();
  if (inspectorOnMutate) inspectorOnMutate(kind, id);
  return null;
}

async function dropKind() {
  const kind = STATE.library.filters.kind;
  if (!kind) return null;
  const known = kindCount(kind);
  const how = known === null ? "every item" : known + " item(s)";
  const keep = { label: "Keep the media files on disk (delete the rows only)",
                 checked: false };
  const ok = await confirmDialog({
    title: "Delete every item in “" + kind + "”?",
    body: ["Removes " + how + " of kind “" + kind + "” from the registry.",
           "Unless you tick the box below, their files are deleted with them " +
             "and the now-empty category directory is removed, because the " +
             "next asset scan would otherwise register anything left inside it.",
           "This cannot be undone."],
    confirmLabel: "Delete " + how,
    danger: true,
    requireText: kind,
    requireLabel: "Type “" + kind + "” to enable the delete button",
    checkbox: keep,
  });
  if (!ok) { announce("category delete cancelled"); return null; }
  const url = "/api/pool/kind/" + encodeURIComponent(kind) +
    (keep.checked ? "?keep_files=true" : "");
  let j;
  try {
    j = await api(url, { method: "DELETE" });
  } catch (err) { announce("category delete failed: " + err.message); return null; }
  const body = asObject(j);
  const failed = Array.isArray(body.failed) ? body.failed.length : 0;
  announce("dropped category " + kind + ": removed " + body.removed +
           (body.dirs_removed ? ", " + body.dirs_removed + " dir(s)" : "") +
           (failed ? ", " + failed + " needing manual cleanup" : ""));
  // The kind this page was filtered by no longer exists, so its filter goes
  // with it and the listing is read again for the question that is left.
  STATE.library.filters.kind = null;
  closeInspector();
  renderFilters();
  syncLibraryHash();
  await loadStatus();
  const listing = await loadGrid(true);
  landAfterRemoval();
  return listing;
}

/**
 * Permanent deletion. The confirmation names the item, states the file
 * consequence in the server's own terms, offers the `keep_file` the endpoint
 * documents, and puts Cancel first and focused. Dismissing it any way at all,
 * Escape included, is a refusal and sends nothing: Escape may not confirm, and
 * refusing to close is not a way to make it safer.
 */
async function deleteBumper(b) {
  const keep = { label: KEEP_FILE_LABEL, checked: false };
  const ok = await confirmDialog({
    title: "Delete “" + rowLabel(b) + "” permanently?",
    body: [DELETE_FILE_NOTE,
           "Disabling it instead takes it out of rotation and can be undone.",
           "Item id: " + String(b.id)],
    confirmLabel: "Delete permanently",
    danger: true,
    checkbox: keep,
  });
  if (!ok) { announce("delete cancelled"); return null; }
  const url = "/api/bumpers/" + encodeURIComponent(b.id) +
    (keep.checked ? "?keep_file=true" : "");
  let answer;
  try {
    answer = await api(url, { method: "DELETE" });
  } catch (err) { announce("delete failed: " + err.message); return null; }
  const j = asObject(answer);
  // Closing the inspector clears its subscriber, so whoever asked to be told
  // is remembered before that happens rather than losing the last mutation.
  const notify = inspectorOnMutate;
  STATE.library.items = STATE.library.items.filter((row) => row.id !== b.id);
  if (typeof STATE.library.total === "number") {
    STATE.library.total = Math.max(0, STATE.library.total - 1);
  }
  renderLibrary();
  // Deleting the last visible row leaves an empty grid: the region has to say
  // so rather than keep claiming it is populated.
  renderLibraryState();
  const leftover = j.cleanup_failed
    ? "deleted, but a hidden quarantine file remains on disk for manual cleanup"
    : "";
  announce("deleted " + j.kind + " · " + (j.title || b.id) +
           (j.file_removed ? " (file removed)" : " (file kept)") +
           (leftover ? " — " + leftover : ""));
  if (STATE.inspector.id === b.id) {
    // A gone row has nothing left to inspect, so the dialog goes with it —
    // unless the server left something behind, in which case closing the only
    // surface that said so is exactly the wrong move.
    if (leftover) {
      STATE.inspector.notice = leftover;
      STATE.inspector.value = null;
      renderInspector();
      renderInspectorState();
    } else closeInspector();
  }
  loadStatus();
  if (notify) notify("delete", b.id);
  landAfterRemoval();
  return j;
}

// Bringing a parked row back on: a cam dropped from the YAML, a file the asset
// sweep could not find. The server may answer with a `warning` — the calendar
// parks an on_this_day card, and the rotation will take it back — so relay it
// rather than let the click look like the last word.
async function enableBumper(b) {
  let j;
  try {
    j = asObject(await api("/api/pool/enable?bumper_id=" +
                           encodeURIComponent(b.id), { method: "POST" }));
  } catch (err) { announce("enable failed: " + err.message); return null; }
  announce("enabled " + rowLabel(b) +
           (j.changed ? "" : " (already on)") +
           (j.warning ? " — " + j.warning : ""));
  afterMutation("enable", b.id, { enabled: 1 }, j.warning);
  return j;
}

// The reversible half of the editorial controls, and the primary one: out of
// rotation without touching health, file or history, so always undoable.
async function disableBumper(b) {
  let j;
  try {
    j = asObject(await api("/api/pool/disable?bumper_id=" +
                           encodeURIComponent(b.id), { method: "POST" }));
  } catch (err) { announce("disable failed: " + err.message); return null; }
  announce("disabled " + rowLabel(b) +
           (j.changed ? "" : " (already off)") +
           (j.warning ? " — " + j.warning : ""));
  afterMutation("disable", b.id, { enabled: 0 }, j.warning);
  return j;
}

function renderLibraryState() {
  const el = $("#browse-state");
  const lib = STATE.library;
  // Unlike the overview and station panels, every library read is something the
  // operator asked for, so saying "loading" cannot flicker on a background
  // refresh — and a Retry that showed only the old stale line would look dead.
  if (lib.loading) return renderPanelState(el, { state: "loading" });
  if (lib.error) {
    return renderPanelState(el, readState(
      { value: lib.items.length ? lib.items : null, error: lib.error,
        updatedAt: lib.updatedAt },
      () => { loadGrid(true); }));
  }
  if (!lib.items.length) {
    if (filtersActive()) {
      return renderPanelState(el, {
        state: "empty", message: "No rows match the current filter.",
        filtersActive: true, actionLabel: "Clear filters", onAction: clearFilters,
      });
    }
    if (lib.source === "shuffle") {
      return renderPanelState(el, {
        state: "empty", message: "the shuffle draw came back with nothing" });
    }
    // Nothing is generated from this view: adding material and generating
    // cards are on Operations, so the empty state points there rather than at
    // controls that are not on the page it is printed on.
    return renderPanelState(el, {
      state: "empty",
      message: "Nothing in the pool yet. Adding material and generating cards " +
        "are on the Operations view.",
      actionLabel: "Open operations",
      onAction: () => { goTo("#/operations"); },
    });
  }
  return renderPanelState(el, { state: "populated" });
}

function renderLibrary() {
  // A break composed on the other view can contain any of these rows, so a
  // mutation made from a library card marks it stale exactly as one made from
  // the composer's own timeline does.
  fillGrid($("#grid"), STATE.library.items.map(
    (row) => cardEl(row, { onMutate: markComposerStale })));
  applyDensity();
  renderLibraryCounts();
  const more = $("#more");
  if (more) more.hidden = !libraryCounts().hasMore;
}

function libraryParams(offset) {
  const params = new URLSearchParams({
    limit: String(STATE.library.pageSize), offset: String(offset) });
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
  // `total` is what the server matched before paging. Where a build reports it,
  // it is the authority on whether there is another page; where it does not,
  // a full page is the only evidence there is that more might exist.
  lib.total = typeof (d && d.total) === "number" && isFinite(d.total) ? d.total : null;
  lib.hasMore = lib.total === null ? count >= lib.pageSize : lib.items.length < lib.total;
  lib.loading = false;
  lib.error = null;
  lib.source = "listing";
  lib.updatedAt = now();
  renderLibrary();
  renderLibraryState();
  return d;
}

// The hash is written when the debounce fires, not per keystroke: an address
// bar rewritten on every letter is noise, and location.replace()'s hashchange
// is not free either.
function scheduleSearch(value) {
  STATE.library.filters.q = String(value === undefined || value === null ? "" : value)
    .slice(0, MAX_FILTER_TEXT);
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    syncLibraryHash();
    loadGrid(true);
  }, SEARCH_DEBOUNCE_MS);
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
  // A draw supersedes whatever listing was still in flight, and a superseded
  // read is cancelled rather than left to arrive under the new answer.
  if (libraryAbort) libraryAbort.abort();
  libraryAbort = new AbortController();
  lib.loading = true;
  renderLibraryState();
  let d;
  try {
    d = await api("/api/bumpers/random?count=" + PAGE,
                  { signal: libraryAbort.signal });
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
  // A draw is not a filtered listing, so there is no matched total to report.
  lib.total = lib.items.length;
  lib.loading = false;
  lib.error = null;
  lib.source = "shuffle";
  lib.updatedAt = now();
  syncLibraryHash();
  renderLibrary();
  renderLibraryState();
  return d;
}

// ==== 7b. Item inspector ====
// One modal over one row. The listing carries neither `selection` nor `uri` nor
// the history columns, so the detail route is read on open and not before.

const parsePayload = (value) => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) { return {}; }
};

function formatStamp(seconds, zero) {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!isFinite(n) || n <= 0) return zero === undefined ? NOT_AVAILABLE : zero;
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" +
    " · " + formatAge(n * 1000);
}

function inspectorBlock(title, rows) {
  const block = makeEl("section", "insp-block");
  block.append(makeEl("h3", "insp-h", title));
  rows.forEach((row) => { if (row) block.append(row); });
  return block;
}

// The media/text preview, and the answer where the card has one.
function inspectorPreview(row) {
  const rows = [];
  const payload = parsePayload(row.payload);
  if (row.type === "stream") {
    rows.push(streamPreview(row));
  } else if (row.type === "image" && hasMedia(row)) {
    rows.push(imagePreview(row));
  } else if (hasMedia(row)) {
    // A rendered card is a media file like any other, so it gets a player too.
    rows.push(mediaVideo(row.media_url, "Preview of " + rowLabel(row)));
  }
  const lines = Array.isArray(payload.lines) ? payload.lines.join("\n")
    : fieldText(payload.text || payload.number || payload.meaning, "");
  if (lines) rows.push(makeEl("pre", "insp-card-text", lines));
  if (payload.answer) rows.push(summaryRow("answer", String(payload.answer)));
  if (!rows.length) rows.push(makeEl("p", "insp-none", "Nothing to preview."));
  return inspectorBlock("Preview", rows);
}

function inspectorIdentity(row) {
  return inspectorBlock("Item", facts([
    ["id", fieldText(row.id)],
    ["title", fieldText(row.title, "untitled")],
    ["type", fieldText(row.type)],
    ["kind", fieldText(row.kind)],
    ["source", fieldText(row.source)],
    ["duration", row.type === "stream" ? "LIVE" : formatDuration(row.duration)],
    ["tags", fieldText(row.tags, "none")],
  ]));
}

function inspectorStateBlock(row) {
  const spec = STATE_BADGES[poolState(row)];
  const head = makeEl("div", "summary-row");
  head.append(makeEl("span", "lbl", "pool state"),
    spec ? statusBadge(spec[0], spec[1]) : makeEl("span", "val", NOT_AVAILABLE));
  return inspectorBlock("State", [head].concat(facts([
    ["enabled", yesNo(row.enabled, "yes", "no — parked")],
    ["health", fieldText(row.health)],
    ["rendered", row.type === "card"
      ? (hasMedia(row) ? "yes" : "no — there is no media file yet") : "not a card"],
    ["base weight", num(row.weight)],
    ["failures", num(row.fail_count)],
  ])));
}

function inspectorCreative(row) {
  const c = row.creative;
  if (!c || typeof c !== "object") {
    return inspectorBlock("Creative", [makeEl("p", "insp-none", NOT_AVAILABLE)]);
  }
  return inspectorBlock("Creative", facts([
    ["family", fieldText(c.family)],
    ["roles", Array.isArray(c.roles) && c.roles.length
      ? c.roles.map(String).join(", ") : fieldText(c.roles, "none")],
    ["energy", fieldText(c.energy)],
    ["audio", fieldText(c.audio)],
    ["text-heavy", yesNo(c.text_heavy)],
    ["template", fieldText(c.template)],
    ["brand mode", fieldText(c.brand_mode)],
  ]));
}

// `selection.json_factors` writes null where a value is not finite, so a key
// present-but-null and a key the build never sent are two different answers.
function factorText(factors, key) {
  if (!Object.prototype.hasOwnProperty.call(factors, key)) return NOT_AVAILABLE;
  return factors[key] === null ? "not a number" : String(factors[key]);
}

// A term the product cannot recover from: an exact zero, or a value the server
// could not express as a finite number. A hostile string is neither.
const gatedTerm = (value) => value === 0 || value === null;

// base × season × daypart × recency × affinity × fatigue = score. Each term is
// a summaryRow, so the figures land in the page's own monospace `.val`.
function factorEquation(factors) {
  const eq = makeEl("div", "insp-eq");
  const term = (key) => {
    const row = summaryRow(key, factorText(factors, key));
    if (gatedTerm(factors[key])) row.classList.add("insp-term-zero");
    return row;
  };
  FACTOR_ORDER.forEach((key, at) => {
    if (at) eq.append(makeEl("span", "insp-eq-op", "×"));
    eq.append(term(key));
  });
  eq.append(makeEl("span", "insp-eq-op", "="), term("score"));
  return eq;
}

// A product cannot recover from a zero, so whichever term is zero IS the gate.
// The badge carries icon, word and colour; the sentence under it reads out the
// server's own reason token, or says plainly that there is none for this term.
function zeroGate(factors) {
  const gated = FACTOR_ORDER.filter((key) => gatedTerm(factors[key]));
  if (gated.length) {
    return [statusBadge("attention", "zero gate — " + gated.join(", "))].concat(
      gated.map((key) => {
        const token = factors[key] === null ? "non_finite_score" : ZERO_REASON[key];
        return makeEl("p", "insp-note", key + " is " + factorText(factors, key) +
          ", so the score cannot be positive: " +
          (token ? own(REASON_TEXT, token) : ZERO_UNNAMED));
      }));
  }
  if (factors.score === null) {
    return [statusBadge("attention", "gated — " + REASON_TEXT.non_finite_score)];
  }
  if (factors.score === 0) {
    return [statusBadge("attention",
      "zero gate — the score is zero although no single factor this build sent is")];
  }
  return [];
}

function inspectorSelection(row) {
  const sel = row.selection;
  if (!sel || typeof sel !== "object") {
    return inspectorBlock("Selection", [makeEl("p", "insp-none", NOT_AVAILABLE)]);
  }
  const rows = [];
  rows.push(summaryRow("eligible now", sel.eligible_now === undefined
    ? NOT_AVAILABLE : (sel.eligible_now ? "yes" : "no")));
  const reasons = Array.isArray(sel.reasons) ? sel.reasons : [];
  if (reasons.length) {
    const list = makeEl("ul", "insp-reasons");
    // Contract order, as the server returned it: the first is the first gate
    // that applied, not an alphabetised set.
    reasons.forEach((reason) => {
      // Own keys only: a token named "constructor" must read as that word,
      // not as whatever Object.prototype happens to carry under it.
      list.append(makeEl("li", "", own(REASON_TEXT, reason) || String(reason)));
    });
    rows.push(list);
  } else {
    rows.push(summaryRow("reasons", NOT_AVAILABLE));
  }
  const f = sel.factors;
  if (f && typeof f === "object") rows.push(factorEquation(f), ...zeroGate(f));
  else rows.push(summaryRow("factors", NOT_AVAILABLE));
  return inspectorBlock("Selection", rows);
}

// Whatever the snapshot actually carries: a missing creator is not "unknown".
const joined = (values) => values.filter(present).map(String).join(" · ")
  || NOT_AVAILABLE;

// Every field bumparr.music's CREDITS_KEYS can carry, so a licence that
// requires attribution shows the attribution text it requires.
const CREDIT_FIELDS = [
  ["music title", "title"], ["music creator", "creator"],
  ["music license", "license"], ["music attribution", "attribution"],
  ["music source page", "source_page"], ["music license URL", "license_url"],
  ["music bed id", "id"],
];
// What a payload can record about the background image enrich_bg attached.
const BG_FIELDS = ["bg_creator", "bg_title", "bg_license", "bg_license_url",
                   "bg_source_page"];

function inspectorProvenance(row) {
  const payload = parsePayload(row.payload);
  const credits = row.music_credits && typeof row.music_credits === "object"
    ? row.music_credits : null;
  // A snapshot that left a field empty is not a build that never carried it.
  const hasCredits = Boolean(credits) && CREDIT_FIELDS.some(([, key]) =>
    present(credits[key]));
  const rows = facts([
    ["registered source", fieldText(row.source)],
    ["payload source", fieldText(payload.source)],
    ["background", joined([payload.bg_creator, payload.bg_title, payload.bg_license])],
    ["background links", joined([payload.bg_source_page, payload.bg_license_url])],
  ].concat(hasCredits
    ? CREDIT_FIELDS.map(([label, key]) => [label, fieldText(credits[key], NOT_RECORDED)])
    : [["music", NOT_AVAILABLE]]));
  // Nothing recorded is a fact about the row, not a failure of the read. It is
  // said out loud, and nothing above it is disabled because of it.
  const recorded = [row.source, payload.source]
    .concat(BG_FIELDS.map((key) => payload[key])).some(present) || hasCredits;
  if (!recorded) {
    rows.unshift(statusBadge("attention", NO_PROVENANCE),
                 makeEl("p", "insp-note", PROVENANCE_NOTE));
  }
  return inspectorBlock("Provenance & rights", rows);
}

function inspectorHistory(row) {
  return inspectorBlock("History", facts([
    ["created", formatStamp(row.created_at)],
    ["last played", formatStamp(row.last_played, "never played")],
    ["play count", num(row.play_count)],
  ]));
}

// The media URL as something to copy rather than follow. The shared control
// owns the field, the button and the sentence; the outcome lives in STATE so a
// redraw repeats it, and it is written straight into `said` so pressing Copy
// does not rebuild the dialog out from under the button that was just pressed.
function inspectorMediaUrl(row) {
  if (!hasMedia(row)) {
    return inspectorBlock("Media URL", [
      makeEl("p", "insp-none", row.type === "card"
        ? "No media file yet — render the card to give it one." : NOT_AVAILABLE)]);
  }
  const built = copyControls("inspector-media-url", "Media URL", row.media_url, {
    read: () => STATE.inspector.copied,
    write: (level, message) => { STATE.inspector.copied = { level, message }; },
  });
  return inspectorBlock("Media URL", [
    labelledControl("inspector-media-url", "Media URL", built.input),
    built.copy, built.said]);
}

// The one reversible action this state deserves, plus any second control that
// still makes sense. Disable is the primary rejection wherever it applies.
function inspectorActions(row) {
  const state = poolState(row);
  const rows = [];
  const buttons = makeEl("div", "insp-actions");
  const primary = (label, onClick) =>
    buttons.append(makeButton(label, "insp-primary", onClick));
  const secondary = (label, onClick) =>
    buttons.append(makeButton(label, "insp-secondary mini", onClick));

  if (state === "dead") {
    // There is no per-item recheck endpoint, and a button that quietly ran a
    // pool-wide sweep under a per-item name would be lying about what it does.
    rows.push(makeEl("p", "insp-note",
      "There is no per-item recheck. Revive re-examines every retired item in " +
      "the pool and un-parks only the ones ffprobe can still read; " +
      "on_this_day cards and live streams are left alone."));
    primary("Run revive (all retired)", () => {
      inspectorJob({ url: MAINT.revive.url, label: "recheck retired",
                     kind: "enable", id: row.id, say: MAINT.revive.say });
    });
  } else if (state === "parked") {
    rows.push(makeEl("p", "insp-note",
      "Enabling is operator intent. A cam no longer in live_cams.yaml is " +
      "parked again on the next restart, and the rotation can take back a " +
      "dated card — the server says so in its answer when it applies."));
    primary("Enable", () => { enableBumper(row); });
  } else if (state === "unrendered") {
    rows.push(makeEl("p", "insp-note",
      "No media file, so only a browser can play it. Rendering runs offline."));
    primary("Render card", () => {
      inspectorJob({
        url: "/api/render/cards?bumper_id=" + encodeURIComponent(row.id),
        label: "render card " + rowLabel(row), kind: "render", id: row.id });
    });
    secondary("Disable from rotation", () => { disableBumper(row); });
  } else if (state === "playable") {
    rows.push(makeEl("p", "insp-note",
      "Takes this out of rotation and nothing else: not its health, not its " +
      "file, not its history. Enable brings it straight back."));
    primary("Disable from rotation", () => { disableBumper(row); });
  } else {
    rows.push(makeEl("p", "insp-none",
      "This response does not say whether the row is enabled, so no action is offered."));
  }
  rows.push(buttons);
  return inspectorBlock("Action", rows);
}

// Apart, last, never the default: deletion is not how you reject an item.
function inspectorDanger(row) {
  const block = inspectorBlock("Danger zone", [
    makeEl("p", "insp-note", DELETE_FILE_NOTE),
  ]);
  block.classList.add("danger-zone");
  block.append(makeButton("Delete permanently", "danger-btn",
    () => { deleteBumper(row); }, "Delete " + rowLabel(row) + " permanently"));
  return block;
}

// Replacing or disabling the focused control drops focus to <body>, outside the
// modal, so everything that does either hands it back.
function heldFocus() {
  const body = $("#inspector-body");
  const active = typeof document !== "undefined" ? document.activeElement : null;
  return Boolean(body && active && body.contains && body.contains(active));
}

function giveBackFocus(held) {
  const title = held && $("#inspector-title");
  if (title && title.focus) title.focus();
}

function renderInspector() {
  const title = $("#inspector-title");
  const body = $("#inspector-body");
  const row = STATE.inspector.value;
  const held = heldFocus();
  if (title) title.textContent = row ? rowLabel(row) : "Item";
  if (!body) return null;
  // Emptying the dialog is exactly when a still-buffering preview has to be
  // let go of, not only when one block is replaced by another.
  if (!row) { releaseMedia(body); body.replaceChildren(); giveBackFocus(held); return body; }
  releaseMedia(body);
  body.replaceChildren(
    inspectorPreview(row), inspectorIdentity(row), inspectorStateBlock(row),
    inspectorCreative(row), inspectorSelection(row), inspectorProvenance(row),
    inspectorHistory(row), inspectorMediaUrl(row), inspectorActions(row),
    inspectorDanger(row));
  giveBackFocus(held);
  return body;
}

function renderInspectorState() {
  const el = $("#inspector-state");
  const insp = STATE.inspector;
  // A running job owns the region, then whatever the server said back about the
  // last mutation — a rotation that will undo it, a file it could not finish
  // removing. That has to be readable HERE, inside the modal the operator is in.
  if (insp.busy) return renderJobState(el, "working", insp.busy, []);
  if (insp.notice) return renderJobState(el, "attention", insp.notice, []);
  // The id this Retry belongs to, captured: reading STATE at click time would
  // let a button left in a closed dialog ask for /api/bumpers/null.
  const id = insp.id;
  return renderPanelState(el, readState(insp,
    id ? () => { loadInspector(id); } : undefined));
}

function setInspectorBusy(message) {
  STATE.inspector.busy = message || "";
  const body = $("#inspector-body");
  const held = heldFocus();
  if (body) modalControls(body).forEach((el) => { el.disabled = Boolean(message); });
  if (message) giveBackFocus(held);
  renderInspectorState();
}

// One read per open. `explain=true` is asked for exactly here: a listing of 24
// rows must never carry 24 explanations.
async function loadInspector(id) {
  const insp = STATE.inspector;
  const generation = ++inspectorGeneration;
  if (inspectorAbort) inspectorAbort.abort();
  inspectorAbort = new AbortController();
  insp.id = id;
  insp.loading = true;
  renderInspectorState();
  let d;
  try {
    d = await api("/api/bumpers/" + encodeURIComponent(id) + "?explain=true",
                  { signal: inspectorAbort.signal });
  } catch (err) {
    if (generation !== inspectorGeneration) return null;
    insp.loading = false;
    if (isApiAbort(err)) return null;
    insp.error = err.message;
    renderInspectorState();
    return null;
  }
  if (generation !== inspectorGeneration) return null;
  insp.loading = false;
  insp.error = null;
  insp.value = d && typeof d === "object" ? d : null;
  insp.updatedAt = now();
  renderInspector();
  renderInspectorState();
  return d;
}

/**
 * openInspector(id, opts) -> Promise
 *
 *   opts.invoker   element focus returns to on close; defaults to the active one.
 *   opts.onMutate  (kind, id) => void after every mutation the inspector
 *                  completes; kind is "disable" | "enable" | "render" |
 *                  "delete". A surface with its own idea of staleness (the
 *                  composer's pack) marks itself from this rather than polling.
 *
 * The dialog opens before the read lands, with its own loading state: a click
 * has to produce something at once on a slow link.
 */
function openInspector(id, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const dialog = $("#inspector");
  if (id === undefined || id === null || String(id) === "") return null;
  inspectorOnMutate = typeof options.onMutate === "function" ? options.onMutate : null;
  const insp = STATE.inspector;
  insp.id = String(id);
  insp.value = null;
  insp.error = null;
  insp.busy = "";
  insp.notice = "";
  insp.copied = null;
  insp.loading = true;
  renderInspector();
  renderInspectorState();
  if (dialog && !insp.open) {
    insp.open = true;
    openDialog(dialog, {
      invoker: options.invoker,
      focus: $("#inspector-title"),
      onClose: () => {
        insp.open = false;
        insp.id = null;
        insp.value = null;
        insp.busy = "";
        insp.notice = "";
        insp.copied = null;
        insp.loading = false;
        inspectorOnMutate = null;
        if (inspectorAbort) { inspectorAbort.abort(); inspectorAbort = null; }
        inspectorGeneration++;
        releaseMedia($("#inspector-body"));
        const body = $("#inspector-body");
        if (body) body.replaceChildren();
        // Including the state strip: a Retry left standing in a closed dialog
        // belongs to a row nobody is inspecting any more.
        const state = $("#inspector-state");
        if (state) renderPanelState(state, { state: "populated" });
      },
    });
  }
  return loadInspector(String(id));
}

function closeInspector() {
  const dialog = $("#inspector");
  if (dialog) closeDialog(dialog);
  return null;
}

// Through the page's own registry so it shows up in Recent jobs, and the shared
// poller so a silent server can be escaped. `say` turns the result object into a
// sentence; without one the raw body is reported.
async function inspectorJob(options) {
  const { url, label, kind, id, say } = options;
  const record = recordJob(label);
  // The inspector's own counter: inspecting a second row supersedes this wait,
  // and a render here must not abandon an Operations action's poll.
  const mine = ++inspectorGeneration;
  const current = () => mine === inspectorGeneration;
  setInspectorBusy(label + "…");
  let r;
  try {
    r = await api(url, { method: "POST", timeout: 0 });
  } catch (err) {
    finishJob(record, "error", err.message);
    announce("✗ " + label + " failed: " + err.message);
    setInspectorBusy("");
    return null;
  }
  if (r && r.job_id) {
    record.id = String(r.job_id);
    r = await watchJob(r, {
      superseded: () => !current(),
      release: () => setInspectorBusy(""),
      working: (seconds) => {
        if (current()) setInspectorBusy(label + "… (" + seconds + "s)");
      },
      unknown: (message, actions) => {
        if (current()) renderJobState($("#inspector-state"), "attention", message, actions);
      },
    });
  }
  const payload = r && r.result !== undefined ? r.result : r;
  let message;
  try {
    message = say ? String(say(payload))
      : (typeof payload === "string" ? payload : JSON.stringify(payload));
  } catch (e) {
    // A build that answers a shape the formatter did not expect still gets a
    // truthful line rather than a thrown click.
    message = typeof payload === "string" ? payload : JSON.stringify(payload);
  }
  finishJob(record, r && r.status ? jobOutcome(r.status) : "done", message);
  announce(label + ": " + humanMessage(message, "done"));
  setInspectorBusy("");
  if (inspectorOnMutate) inspectorOnMutate(kind, id);
  loadStatus();
  // The row's columns may have moved (a rendered card gains a uri, a revived
  // one loses its park), so it is read again rather than guessed at — and the
  // listing is left exactly where it was.
  if (STATE.inspector.id === id) await loadInspector(id);
  return r;
}

// ==== 8. Composer / playback  (read-only: never advances playout) ====
// The server composes the break; this file asks for one, shows it in the order
// it came back in, and plays it locally. Nothing here re-implements
// compose_break, re-sorts it, or substitutes an item when a row is disabled: a
// composition the pool has moved under is marked stale and composed again.

const COMPOSER_PRESETS = [15, 30, 60, 90];
const COMPOSER_PLACEMENTS = ["any", "open", "inside", "close"];
const COMPOSER_TYPES = ["video", "card", "image", "stream"];
// Exactly what GET /api/bumpers/fill documents, so an out-of-range control is
// refused here rather than by a 422 the operator has to interpret.
const MIN_FILL_SECONDS = 0.1;   // index.html: <input id="cmp-seconds" min="0.1">
const MAX_FILL_SECONDS = 86400;
const MAX_FILL_TOLERANCE = 3600;
const MAX_FILL_ITEMS = 40;
const COMPOSER_TICK_MS = 1000;

// The server's relaxation tokens, said in words. A rule was bent to fill the
// gap and the operator has to be able to read which, so this is a panel, never
// a tooltip. A token this build sends that is not listed is shown as it arrived.
const RELAXED_TEXT = {
  exit_ident: "The break could not end on a station ident.",
  energy_jump: "Adjacent items jump in energy more than the profile prefers.",
  same_family: "Two adjacent items share a visual family.",
  text_run: "Text-heavy cards run back to back.",
  same_music: "Adjacent items share a music bed.",
};

const STALE_TEXT = "Stale — recompose to reflect changes";

let composerAbort = null;
let composerTimer = null;   // a payload-only card's own clock
let composerTick = null;    // the elapsed/remaining readout
let composerMedia = null;   // the element the sequence is playing, if any
// Its listeners as [type, fn] pairs, so every one of them comes off again when
// the stage is released. A sequence that leaks an `ended` handler advances the
// next item twice.
let composerHandlers = [];

const composerItems = () => {
  const d = STATE.composer.result;
  return d && Array.isArray(d.bumpers) ? d.bumpers : [];
};

// A blank field is not a zero: "" would read as 0 and quietly send a tolerance
// nobody typed, so it is NaN here and the control says it is invalid.
function fillNumber(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return NaN;
  const n = Number(raw);
  return isFinite(n) ? n : NaN;
}

// composerProblems(controls) -> {field: sentence}. Pure; every bound is the
// endpoint's own, and only an empty object lets a request be built at all.
function composerProblems(controls) {
  const c = controls || {};
  const out = {};
  const seconds = fillNumber(c.seconds);
  // The endpoint accepts anything above zero; this control's step is 0.1, so
  // 0.1 is the smallest duration it can express. Validating against the same
  // number the field's own min attribute carries keeps the browser's verdict
  // and this one from disagreeing about a value nobody can type anyway.
  if (!(seconds >= MIN_FILL_SECONDS) || seconds > MAX_FILL_SECONDS) {
    out.seconds = "Seconds to fill must be at least 0.1 and at most 86400.";
  }
  const tolerance = fillNumber(c.tolerance);
  if (!(tolerance >= 0) || tolerance > MAX_FILL_TOLERANCE) {
    out.tolerance = "Tolerance must be between 0 and 3600 seconds.";
  }
  const maxItems = fillNumber(c.maxItems);
  if (!(maxItems >= 1) || maxItems > MAX_FILL_ITEMS || Math.floor(maxItems) !== maxItems) {
    out.maxItems = "Maximum items must be a whole number from 1 to 40.";
  }
  if (COMPOSER_PLACEMENTS.indexOf(String(c.placement)) === -1) {
    out.placement = "Placement must be any, open, inside or close.";
  }
  const types = Array.isArray(c.types) ? c.types : [];
  if (types.some((t) => COMPOSER_TYPES.indexOf(String(t)) === -1)) {
    out.types = "Only video, card, image and stream can be asked for.";
  }
  return out;
}

// The fill query, built through URLSearchParams so no value can smuggle a
// separator. Ticking no type at all means every type, which is what leaving
// `types` off says — sending all four would say the same thing more loudly.
function composerParams(controls) {
  const c = controls || {};
  const params = new URLSearchParams();
  params.set("seconds", String(fillNumber(c.seconds)));
  params.set("tolerance", String(fillNumber(c.tolerance)));
  params.set("max_items", String(fillNumber(c.maxItems)));
  params.set("placement", String(c.placement));
  const types = (Array.isArray(c.types) ? c.types : [])
    .filter((t) => COMPOSER_TYPES.indexOf(String(t)) !== -1);
  if (types.length) params.set("types", types.join(","));
  params.set("explain", "true");
  return params;
}

/**
 * gapLabel(requested, total, exact) ->
 *   "Requested 30.0s | Composed 29.4s | Gap +0.6s | Within tolerance"
 *
 * Pure. `gap = requested - total`: positive is underfilled, negative
 * overfilled, and the sign is always written out. "Within tolerance" is the
 * server's own `exact` — comparing the gap with zero here would call a
 * perfectly good break a bad one. A figure this build does not send reads
 * "Not available in this version." rather than as a zero.
 */
function gapLabel(requested, total, exact) {
  const req = fillNumber(requested);
  const tot = fillNumber(total);
  const parts = [
    "Requested " + (isFinite(req) ? req.toFixed(1) + "s" : NOT_AVAILABLE),
    "Composed " + (isFinite(tot) ? tot.toFixed(1) + "s" : NOT_AVAILABLE),
  ];
  if (isFinite(req) && isFinite(tot)) {
    // Rounded before the sign is read, so an overfill too small to show does
    // not print as "-0.0s".
    const gap = Math.round((req - tot) * 10) / 10;
    parts.push("Gap " + (gap < 0 ? "-" : "+") + Math.abs(gap).toFixed(1) + "s");
  } else {
    parts.push("Gap " + NOT_AVAILABLE);
  }
  parts.push(typeof exact === "boolean"
    ? (exact ? "Within tolerance" : "Outside tolerance") : NOT_AVAILABLE);
  return parts.join(" | ");
}

// A minute-long clip is not sixty times the width of a one-second card: the
// share is bounded, and CSS keeps a floor under it, so every item stays
// readable however long it is. The length is written out as text regardless.
function durationShare(seconds) {
  const n = Number(seconds);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(6, Math.round((n / 5) * 100) / 100));
}

// --- controls ---------------------------------------------------------------

// Operator input, not response data: the fields are the operator's while they
// are being typed in, so they are read into STATE here (on every change, on
// entry, and once more before a request is built) and nothing writes them back
// except a preset, whose whole job is to fill the seconds field in. Nothing
// rendered is ever read back out of the DOM — a browser that restores form
// values across a reload would otherwise show one duration and send another.
function readComposerControls() {
  const c = STATE.composer;
  const value = (sel) => { const el = $(sel); return el ? el.value : ""; };
  c.seconds = value("#cmp-seconds");
  c.tolerance = value("#cmp-tolerance");
  c.maxItems = value("#cmp-max-items");
  c.placement = value("#cmp-placement");
  c.types = $$("#view-composer [data-cmptype]")
    .filter((box) => box.checked)
    .map((box) => String(box.dataset.cmptype));
  return c;
}

function setComposerPreset(value) {
  const n = Number(value);
  if (COMPOSER_PRESETS.indexOf(n) === -1) return null;
  STATE.composer.seconds = n;
  const el = $("#cmp-seconds");
  if (el) el.value = String(n);
  renderComposerControls();
  return n;
}

// Invalid controls name themselves in words, next to the button they disable.
// Nothing is sent while anything is listed here.
function renderComposerControls() {
  const c = STATE.composer;
  const problems = composerProblems(c);
  // aria-invalid marks the field; aria-describedby points at the sentences
  // that say why, which live in one polite live region beside the button they
  // disable rather than in a tooltip nobody hears.
  const mark = (sel, key) => {
    const el = $(sel);
    if (!el) return;
    if (problems[key]) {
      el.setAttribute("aria-invalid", "true");
      el.setAttribute("aria-describedby", "cmp-validation");
    } else {
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    }
  };
  mark("#cmp-seconds", "seconds");
  mark("#cmp-tolerance", "tolerance");
  mark("#cmp-max-items", "maxItems");
  mark("#cmp-placement", "placement");
  const said = $("#cmp-validation");
  const lines = Object.keys(problems).map((key) => problems[key]);
  if (said) {
    said.replaceChildren(...lines.map((line) => makeEl("p", "cmp-invalid", line)));
    said.hidden = lines.length === 0;
  }
  const go = $("#cmp-go");
  if (go) go.disabled = lines.length > 0 || c.loading;
  const seconds = fillNumber(c.seconds);
  $$("#view-composer [data-preset]").forEach((button) => {
    button.setAttribute("aria-pressed",
      Number(button.dataset.preset) === seconds ? "true" : "false");
  });
  return said;
}

// --- the composed break ------------------------------------------------------

// One composed item, in the server's own order. Family, audio, role and brand
// mode are the vocabulary the profile composed by, so they are on the item
// itself rather than a click away.
function timelineItemEl(b, index, count) {
  const row = b && typeof b === "object" ? b : {};
  const cr = row.creative && typeof row.creative === "object" ? row.creative : {};
  const li = makeEl("li", "cmp-item");
  li.dataset.order = String(index + 1);
  li.style.flexGrow = String(durationShare(row.duration));
  const head = makeEl("div", "cmp-head");
  head.append(makeEl("span", "cmp-order", String(index + 1) + " of " + count),
              makeEl("span", "cmp-dur",
                     row.type === "stream" ? "LIVE" : formatDuration(row.duration)));
  const roles = (Array.isArray(cr.roles) ? cr.roles : [])
    .filter((r) => r !== undefined && r !== null && r !== "").map(String);
  li.append(head, makeEl("p", "cmp-title", fieldText(row.title, "untitled")),
            summaryRow("kind", fieldText(row.kind)),
            summaryRow("family", fieldText(cr.family)),
            summaryRow("audio", fieldText(cr.audio)),
            summaryRow("role", roles.length ? roles.join(", ") : NOT_AVAILABLE),
            summaryRow("brand mode", fieldText(cr.brand_mode)));
  if (row.id !== undefined && row.id !== null && String(row.id) !== "") {
    const inspect = makeButton("Inspect", "cmp-inspect mini",
      () => { openInspector(row.id, { invoker: inspect, onMutate: markComposerStale }); },
      "Inspect " + rowLabel(row));
    li.append(inspect);
  }
  return li;
}

// Which rules the composer had to bend, in plain sentences. A relaxation is
// editorial news, so it is an Attention panel on the page and never a tooltip.
function renderComposerAttention() {
  const el = $("#composer-attention");
  if (!el) return null;
  const d = STATE.composer.result;
  const composition = d && typeof d.composition === "object" ? d.composition : null;
  const rules = composition && Array.isArray(composition.relaxed_rules)
    ? composition.relaxed_rules : [];
  el.hidden = rules.length === 0;
  if (!rules.length) { el.replaceChildren(); return el; }
  const list = makeEl("ul", "cmp-relax");
  rules.forEach((rule) => {
    list.append(makeEl("li", "", own(RELAXED_TEXT, String(rule)) || String(rule)));
  });
  el.replaceChildren(
    statusBadge("attention", "The profile's rules were relaxed to fill this gap"),
    list);
  return el;
}

// The pack the server composed is the pack it composed. Disabling, enabling,
// rendering or deleting a row through the inspector does not let this page swap
// in a replacement: the break is marked stale and Play is disabled until the
// operator asks the server for a new one.
function markComposerStale(kind, id) {
  const c = STATE.composer;
  if (!c.result) return null;
  // Any card surface can call this now, the Library's included. A mutation to
  // a row this break does not contain has not changed the sequence on screen,
  // and marking it stale for that would be a false alarm.
  if (!composerItems().some((row) => row && String(row.id) === String(id))) return null;
  c.stale = true;
  stopComposerPlayback();
  // The timeline itself is left exactly as it is — nothing is substituted, and
  // rebuilding it would throw away the Inspect button the still-open dialog has
  // to hand focus back to when it closes.
  renderComposerStale();
  renderComposerPlayback();
  announce(STALE_TEXT + " (" + String(kind) + " · " + String(id) + ")");
  return kind;
}

function renderComposerStale() {
  const el = $("#composer-stale");
  if (!el) return null;
  const stale = Boolean(STATE.composer.stale);
  el.hidden = !stale;
  el.replaceChildren(...(stale ? [
    statusBadge("attention", STALE_TEXT),
    makeEl("p", "cmp-note",
      "An item changed while this break was on screen. Bumparr does not " +
      "substitute one item for another — press Compose break for a new sequence."),
  ] : []));
  return el;
}

function renderComposerBreak() {
  const d = STATE.composer.result;
  const items = composerItems();
  const summary = $("#composer-summary");
  if (summary) {
    summary.textContent = d ? gapLabel(d.requested, d.total, d.exact) : "";
  }
  const count = $("#composer-count");
  if (count) {
    count.textContent = d
      ? items.length + " item(s), in the order the server composed them."
      : "";
  }
  renderComposerAttention();
  fillGrid($("#composer-timeline"),
           items.map((row, at) => timelineItemEl(row, at, items.length)));
  return items.length;
}

function renderComposerState() {
  const el = $("#composer-state");
  const c = STATE.composer;
  // Every composer read is one the operator asked for, so "loading" cannot
  // flicker on a background refresh; and never composed is empty, not loading.
  if (c.loading) return renderPanelState(el, { state: "loading", message: c.loadingLabel });
  if (!c.error && !c.result) {
    return renderPanelState(el, { state: "empty",
      message: "Nothing composed yet — choose a duration and press Compose break." });
  }
  if (!c.error && !composerItems().length) {
    // The server's own note says why nothing fit; there is no client-side
    // second guess at a pool it can see and this page cannot.
    return renderPanelState(el, { state: "empty",
      message: humanMessage(c.result && c.result.note,
                            "Nothing in the pool fits this break.") });
  }
  return renderPanelState(el, readState(
    { value: c.result, error: c.error, updatedAt: c.updatedAt },
    c.retry || undefined));
}

// The one request this view makes, and a GET built from validated controls. It
// never calls station advance(), writes play history, or touches
// play_count/last_played.
async function composeBreak() {
  const c = STATE.composer;
  readComposerControls();
  const problems = composerProblems(c);
  if (Object.keys(problems).length) {
    // Nothing is sent from an invalid form. The fields say what is wrong and
    // Compose stays disabled until they are right.
    renderComposerControls();
    announce("compose blocked: " + Object.keys(problems).map((k) => problems[k]).join(" "));
    return null;
  }
  // A new composition is a new sequence: whatever was playing stops first.
  stopComposerPlayback();
  c.stale = false;
  if (composerAbort) composerAbort.abort();
  composerAbort = new AbortController();
  c.loading = true;
  c.loadingLabel = "composing a " + fillNumber(c.seconds) + "s break…";
  c.retry = () => composeBreak();
  renderComposer();
  let d;
  try {
    d = await api("/api/bumpers/fill?" + composerParams(c).toString(),
                  { signal: composerAbort.signal });
  } catch (err) {
    c.loading = false;
    // A cancelled read (the view was left) leaves the last good break alone.
    if (isApiAbort(err)) { renderComposer(); return null; }
    c.error = err.message;
    renderComposer();
    return null;
  }
  c.loading = false;
  // A 200 carrying no object is not a composition. Dropping the last good break
  // for it would clear known-good content without a replacement and leave the
  // panel claiming nothing was ever composed, so it is a failure like any
  // other: the previous break stays, marked stale, and says what happened.
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    c.error = "The server sent an empty response instead of a break.";
    renderComposer();
    return null;
  }
  c.error = null;
  c.result = d;
  c.updatedAt = now();
  renderComposer();
  return d;
}

// --- local sequential playback ----------------------------------------------
// One medium at a time, advancing on the medium's own `ended` where it has one
// and on the item's declared duration where it does not. Nothing is reported
// back to the server: this is a preview, not a playout.

// The stage element for one item, plus the medium to wait on if it has one.
// A live stream is never opened by the sequence — it keeps its own Play button
// and the warning that pressing it makes this page a real client.
function stagePlayer(b) {
  const row = b && typeof b === "object" ? b : {};
  if (row.type === "stream") return { node: streamPreview(row), medium: null };
  if (row.type === "image" && hasMedia(row)) return { node: imagePreview(row), medium: null };
  if (hasMedia(row) && (row.type === "video" || row.type === "card")) {
    const v = mediaVideo(row.media_url, "Playing " + rowLabel(row));
    return { node: v, medium: v };
  }
  const p = row.payload && typeof row.payload === "object" ? row.payload : {};
  const text = Array.isArray(p.lines) ? p.lines.join("\n")
    : String(p.number || p.text || row.title || "");
  const card = makeEl("div", "cmp-textcard");
  card.append(makeEl("div", "tc", text));
  return { node: card, medium: null };
}

// Timers off, medium detached, stage emptied — without touching where the
// sequence had got to, which is what Next and Previous need kept.
function releaseComposerStage() {
  if (composerTimer !== null) { clearTimeout(composerTimer); composerTimer = null; }
  if (composerTick !== null) { clearInterval(composerTick); composerTick = null; }
  if (composerMedia && composerMedia.removeEventListener) {
    composerHandlers.forEach(([type, fn]) => {
      composerMedia.removeEventListener(type, fn);
    });
  }
  composerMedia = null;
  composerHandlers = [];
  const stage = $("#composer-stage");
  if (stage) { releaseMedia(stage); stage.replaceChildren(); }
  return null;
}

// The full stop: nothing playing, nothing counting, and back to the top.
function stopComposerPlayback() {
  releaseComposerStage();
  const p = STATE.composer.playback;
  p.index = -1;
  p.playing = false;
  p.startedAt = null;
  p.elapsed = 0;
  p.duration = 0;
  return null;
}

function playbackLine() {
  const items = composerItems();
  const p = STATE.composer.playback;
  if (!items.length) return "Nothing composed yet.";
  if (p.index < 0) return "Stopped · " + items.length + " item(s) in this break.";
  const head = "Item " + (p.index + 1) + " of " + items.length;
  const elapsed = Math.max(0, Math.round(p.elapsed));
  if (!(p.duration > 0)) return head + " · " + elapsed + "s elapsed · length not reported";
  return head + " · " + elapsed + "s elapsed · " +
    Math.max(0, Math.round(p.duration - p.elapsed)) + "s remaining";
}

function renderComposerPlayback() {
  const c = STATE.composer;
  const p = c.playback;
  const items = composerItems();
  // A stale break is not played: the sequence on screen is no longer the
  // sequence the server would compose.
  const can = items.length > 0 && !c.stale && !c.loading;
  const set = (sel, disabled) => { const el = $(sel); if (el) el.disabled = disabled; };
  set("#cmp-play", !can);
  set("#cmp-prev", !can);
  set("#cmp-next", !can);
  set("#cmp-stop", p.index < 0);
  const line = $("#cmp-progress");
  if (line) line.textContent = playbackLine();
  const list = $("#composer-timeline");
  Array.from((list && list.children) || []).forEach((li, at) => {
    if (at === p.index) li.setAttribute("aria-current", "true");
    else li.removeAttribute("aria-current");
  });
  return line;
}

function renderComposer() {
  renderComposerControls();
  renderComposerBreak();
  renderComposerStale();
  renderComposerPlayback();
  renderComposerState();
  return null;
}

// The elapsed/remaining readout, from the wall clock rather than the medium, so
// a card with no medium at all counts the same way a video does.
function startComposerTick() {
  if (composerTick !== null) clearInterval(composerTick);
  composerTick = setInterval(() => {
    const p = STATE.composer.playback;
    if (!p.playing || p.startedAt === null) return;
    p.elapsed = (now() - p.startedAt) / 1000;
    renderComposerPlayback();
  }, COMPOSER_TICK_MS);
  return composerTick;
}

// Put item `index` on the stage and start it. Past either end is the end of the
// break, not a wrap: the sequence stops there.
function playComposerAt(index) {
  const c = STATE.composer;
  const items = composerItems();
  const p = c.playback;
  if (!items.length || c.stale) {
    stopComposerPlayback();
    renderComposerPlayback();
    return null;
  }
  const at = Math.trunc(Number(index));
  if (!isFinite(at) || at < 0 || at >= items.length) {
    stopComposerPlayback();
    renderComposerPlayback();
    announce("preview sequence finished — nothing was written to play history");
    return null;
  }
  releaseComposerStage();
  const b = items[at] || {};
  const duration = Number(b.duration);
  p.index = at;
  p.playing = true;
  p.startedAt = now();
  p.elapsed = 0;
  p.duration = isFinite(duration) && duration > 0 ? duration : 0;
  const built = stagePlayer(b);
  const stage = $("#composer-stage");
  if (stage) {
    stage.replaceChildren(
      makeEl("p", "cmp-stage-label",
             "Item " + (at + 1) + " of " + items.length + " · " + rowLabel(b)),
      built.node);
  }
  if (built.medium) {
    composerMedia = built.medium;
    // `ended` is the ordinary advance. A medium that cannot be decoded would
    // otherwise hold the sequence for ever, so `error` says so and moves on;
    // `stalled` says the wait is the network's and leaves the decision to the
    // operator, because a stall usually recovers and skipping it would not be
    // showing them the break the server composed.
    const on = (type, fn) => {
      composerHandlers.push([type, fn]);
      composerMedia.addEventListener(type, fn);
    };
    on("ended", () => { advanceComposer(1); });
    on("error", () => {
      announce("could not play item " + (at + 1) + " of " + items.length +
               " (" + rowLabel(b) + ") — moving on");
      advanceComposer(1);
    });
    on("stalled", () => {
      announce("still waiting on item " + (at + 1) + " of " + items.length +
               " — press Next to move on");
    });
    claimMedia(composerMedia);
    if (typeof composerMedia.play === "function") {
      const started = composerMedia.play();
      if (started && started.catch) started.catch(() => {});
    }
  } else if (p.duration > 0) {
    // A payload-only card has nothing to fire `ended`, so its declared
    // duration is the clock. A live stream with no declared length holds here
    // until Next: this page never opens one by itself.
    composerTimer = setTimeout(() => {
      composerTimer = null;
      advanceComposer(1);
    }, p.duration * 1000);
  }
  startComposerTick();
  renderComposerPlayback();
  announce("previewing item " + (at + 1) + " of " + items.length + ": " + rowLabel(b));
  return at;
}

// Previous and Next are the sequence's controls whether or not it is running:
// from stopped, Next starts at the top.
function advanceComposer(delta) {
  const p = STATE.composer.playback;
  const step = Number(delta) < 0 ? -1 : 1;
  // From stopped, Next starts at the top and Previous at the end. Reporting
  // "sequence finished" to someone who has not started one is not an answer.
  const from = p.index < 0
    ? (step > 0 ? -1 : composerItems().length) : p.index;
  return playComposerAt(from + step);
}

const playComposerSequence = () => playComposerAt(0);

function stopComposerSequence() {
  stopComposerPlayback();
  renderComposerPlayback();
  announce("preview stopped");
  return null;
}

// Wired once at boot. Values are read out of the fields as they change; only a
// preset ever writes one back.
function wireComposer() {
  const on = (sel, type, fn) => { const el = $(sel); if (el) el.addEventListener(type, fn); };
  const reread = () => { readComposerControls(); renderComposerControls(); };
  $$("#view-composer [data-preset]").forEach((button) => {
    button.addEventListener("click", () => { setComposerPreset(button.dataset.preset); });
  });
  ["#cmp-seconds", "#cmp-tolerance", "#cmp-max-items"].forEach((sel) => {
    on(sel, "input", reread);
    on(sel, "change", reread);
  });
  on("#cmp-placement", "change", reread);
  $$("#view-composer [data-cmptype]").forEach((box) => {
    box.addEventListener("change", reread);
  });
  on("#cmp-go", "click", () => { composeBreak(); });
  on("#cmp-play", "click", () => { playComposerSequence(); });
  on("#cmp-prev", "click", () => { advanceComposer(-1); });
  on("#cmp-next", "click", () => { advanceComposer(1); });
  on("#cmp-stop", "click", () => { stopComposerSequence(); });
  return null;
}

// ==== 9. Station ====

// The plan's operator sentences, verbatim. Each is reached from one explicit
// field, never from parsing a human string the server happened to send.
const STATION_MESSAGES = {
  idle: "Idle — no playlist client has requested this channel recently.",
  unavailable: "Unavailable — conform at least one eligible item.",
  slate: "Using slate — all playable candidates are currently gated.",
  ffmpeg: "Cannot conform — ffmpeg is unavailable in the service.",
  playing: "On air — playing a conformed item.",
};
const STATION_UNREAD = "Station status unavailable; last successful update was ";

// Opening a channel in a <video> is not a read: it makes this page a playlist
// client, which is the one thing on this view that can advance playout.
const HLS_CLIENT_NOTE =
  "Opening the preview is a real playlist client and may advance and report playout.";
// Chromium and Firefox generally answer "" to canPlayType for HLS. No remote
// media library is loaded to paper over that — the plan forbids one — so the
// honest offer is the URL and somewhere to paste it.
const HLS_NO_NATIVE = "Copy the URL and Open in external player (VLC, mpv, IINA): " +
  "this browser has no native HLS playback, so no preview is offered here.";

const CHANNEL_LEVELS = { active: "healthy", idle: "attention",
                         unavailable: "failed", unknown: "offline" };

// Icon + word + colour for the whole station, from the station body alone.
function stationRollup(s) {
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

/**
 * Two questions, one name.
 *
 * `stationState(body)` — no channel named — is the whole station's roll-up
 * badge, which is what the Overview shows: `{level, detail}`.
 *
 * `stationState(channel, body, meta)` is one channel's operator state:
 * `{state, message, level}`, where `state` is the API's own vocabulary plus
 * "unknown" and `message` is the plan's sentence for exactly that condition.
 * `meta` carries `{updatedAt, at}` so a failed read can say how old the last
 * good one is. Pure: no DOM, and no clock beyond what `at` supplies.
 *
 * "no client", "nothing conformed", "gated" and "ffmpeg absent" stay four
 * different answers. ffmpeg absence outranks "nothing conformed" because it is
 * that state's cause — with ffmpeg present the two still read differently.
 */
function stationState(channel, station, meta) {
  if (typeof channel !== "string") return stationRollup(channel);
  const m = meta || {};
  const s = station && typeof station === "object" ? station : null;
  const say = (state, key, level) => ({
    state, message: STATION_MESSAGES[key],
    level: level || CHANNEL_LEVELS[state] || "attention" });
  if (!s) {
    return { state: "unknown", level: "offline",
             message: STATION_UNREAD +
               (m.updatedAt ? formatAge(m.updatedAt, m.at) : "never") + "." };
  }
  const channels = s.channels && typeof s.channels === "object" ? s.channels : {};
  const ch = channels[channel] && typeof channels[channel] === "object"
    ? channels[channel] : null;
  // A build that does not send the channel, or does not diagnose it, has told
  // us nothing — which is not the same claim as "idle".
  if (!ch || typeof ch.state !== "string") {
    return { state: "unknown", level: "offline", message: NOT_AVAILABLE };
  }
  if (ch.state === "unavailable") {
    return say("unavailable", s.ffmpeg === false ? "ffmpeg" : "unavailable");
  }
  if (ch.state === "idle") return say("idle", "idle");
  if (ch.state === "active") {
    // The slate plays, so the channel is up — but it is the brand card, not
    // content, and that is an amber fact rather than a green one.
    return ch.reason === "slate" ? say("active", "slate", "attention")
                                 : say("active", "playing");
  }
  return { state: "unknown", level: "offline", message: NOT_AVAILABLE };
}

// Detected once per session and cached in STATE, so the answer survives a
// redraw and is cleared with everything else between tests. No remote HLS
// script is loaded either way: an unsupported browser is told the truth.
function hlsSupported() {
  if (STATE.ops.hls === null) {
    let ok = false;
    try {
      const probe = document.createElement("video");
      ok = typeof probe.canPlayType === "function" &&
        Boolean(probe.canPlayType("application/vnd.apple.mpegurl"));
    } catch (e) { ok = false; }
    STATE.ops.hls = ok;
  }
  return STATE.ops.hls;
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

// One handoff URL, through the same shared control the inspector uses. A URL
// this build does not send is named and reported missing, not shown as an
// empty box. The outcome lives in STATE so a redraw repeats it, keyed so one
// row's answer is never shown against another's.
function copyField(key, label, value) {
  const row = makeEl("div", "station-url");
  if (value === undefined || value === null || value === "") {
    row.append(makeEl("span", "lbl", label), makeEl("span", "val", NOT_AVAILABLE));
    return row;
  }
  const id = "station-url-" + key;
  const built = copyControls(id, label, value, {
    read: () => (STATE.ops.copied && STATE.ops.copied.key === key
      ? STATE.ops.copied : null),
    write: (level, message) => { STATE.ops.copied = { key, level, message }; },
  }, { saidClass: "st-copy", copyClass: "st-copy-btn mini" });
  const caption = makeEl("label", "lbl", label);
  caption.setAttribute("for", id);
  row.append(caption, built.input, built.copy, built.said);
  return row;
}

// Epoch seconds as a wall clock, which is what an operator matches against a
// player. A field the server did not send says so rather than showing an epoch.
function formatClock(seconds) {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!isFinite(n) || n <= 0) return NOT_AVAILABLE;
  return new Date(n * 1000).toISOString().slice(11, 19) + " UTC";
}

// Never a <video> until Open preview is pressed, and never one at all where the
// browser has no native HLS: a player that cannot play is worse than a URL.
function channelPreview(name, url) {
  const box = makeEl("div", "station-pv");
  if (!url) {
    box.append(makeEl("p", "panel-state-msg", "No playlist URL — " + NOT_AVAILABLE));
    return box;
  }
  if (!hlsSupported()) {
    box.append(makeEl("p", "note", HLS_NO_NATIVE));
    return box;
  }
  box.append(makeEl("p", "note", HLS_CLIENT_NOTE));
  box.append(STATE.ops.preview === name
    ? makeButton("Close preview", "st-open mini", () => { closeStationPreview(); },
                 "Close the " + name + " channel preview")
    : makeButton("Open preview", "st-open mini", () => { openStationPreview(name, url); },
                 "Open a preview of the " + name + " channel"));
  return box;
}

function channelEl(name, s, meta) {
  const ch = ((s && s.channels) || {})[name] || {};
  const box = makeEl("section", "station-ch");
  const verdict = stationState(name, s, meta);
  box.append(makeEl("h4", "station-ch-name", name),
             statusBadge(verdict.level, verdict.message));
  const playing = ch.now && typeof ch.now === "object" ? ch.now : null;
  const left = playing
    ? Math.max(0, Math.round((playing.ends_at || 0) - Date.now() / 1000)) : 0;
  const row = makeEl("div", "station-row");
  row.append(makeEl("span", "lbl", "now"));
  if (playing) {
    row.append(makeEl("span", "now",
      String(playing.title == null ? "" : playing.title) + " (" +
      String(playing.kind == null ? "" : playing.kind) + ", " + left + "s left)"));
  } else {
    row.append(makeEl("span", "now muted", "off air"));
  }
  box.append(row);
  const next = ch.next && typeof ch.next === "object" ? ch.next : null;
  const nextRow = makeEl("div", "station-row");
  nextRow.append(makeEl("span", "lbl", "next"),
    next ? makeEl("span", "next", String(next.title == null ? "" : next.title) +
      (next.kind == null || next.kind === "" ? "" : " (" + String(next.kind) + ")"))
         : makeEl("span", "next muted", "nothing scheduled"));
  box.append(nextRow);
  box.append(
    summaryRow("on air", playing
      ? formatClock(playing.started_at) + " → " + formatClock(playing.ends_at)
      : "nothing scheduled"),
    summaryRow("remaining", playing ? formatDuration(left) : "nothing scheduled"),
    // Reading this never sets it: /api/station reports the channel's own
    // record of when a playlist client last asked for it.
    summaryRow("last playlist request", ch.last_playlist_request === undefined
      ? NOT_AVAILABLE
      : (ch.last_playlist_request === null ? "no client has asked yet"
         : formatAge(Number(ch.last_playlist_request) * 1000, meta && meta.at))),
    summaryRow("lookahead", typeof ch.lookahead_seconds === "number"
      ? formatDuration(ch.lookahead_seconds) : NOT_AVAILABLE));
  box.append(channelPreview(name, ((s && s.urls) || {})[name]));
  return box;
}

function stationEl(s, meta) {
  const root = makeEl("div", "station-body");
  const state = stationState(s);
  root.append(statusBadge(state.level, state.detail));
  root.append(channelEl("live", s, meta), channelEl("standby", s, meta));
  const urls = (s && s.urls) || {};
  const block = makeEl("div", "station-urls");
  block.append(makeEl("h4", "station-ch-name", "Handoff URLs"));
  [["Channel M3U", "channel_m3u"], ["Guide XMLTV", "guide_xml"],
   ["Live HLS", "live"], ["Standby HLS", "standby"]]
    .forEach(([label, key]) => block.append(copyField(key, label, urls[key])));
  root.append(block);
  root.append(makeEl("div", "muted",
    ((s && s.conformed) || 0) + " / " + ((s && s.eligible) || 0) + " conformed" +
    (s && s.ffmpeg === false ? " · ffmpeg not found" : "")));
  return root;
}

// Conform progress, what the last sweep did, and whether ffmpeg is there to run
// the next one. A build that sends no `last_conform` says so; one that sends
// null has simply not swept yet, which is a different fact.
function conformEl(s) {
  const box = makeEl("div", "conform-body");
  if (!s || typeof s !== "object") {
    // Why there is no body is the Channels panel's state region's job to say;
    // this only reports that there are no figures to show for it.
    box.append(makeEl("p", "panel-state-msg",
      "No conform figures — the station body has not been read."));
    return box;
  }
  box.append(
    summaryRow("ffmpeg", s.ffmpeg === false ? "not found"
      : (s.ffmpeg === true ? "found" : NOT_AVAILABLE)),
    summaryRow("conformed", (s.conformed || 0) + " / " + (s.eligible || 0)),
    summaryRow("pending", typeof s.pending === "number"
      ? String(s.pending) : NOT_AVAILABLE));
  if (s.ffmpeg === false) box.append(statusBadge("failed", STATION_MESSAGES.ffmpeg));
  const sweep = s.last_conform;
  if (sweep === undefined) {
    box.append(summaryRow("last sweep", NOT_AVAILABLE));
  } else if (sweep === null || typeof sweep !== "object") {
    box.append(summaryRow("last sweep", "no sweep has finished in this service yet"));
  } else {
    box.append(summaryRow("last sweep", formatAge(Number(sweep.at) * 1000)),
      summaryRow("last sweep result",
        [["conformed", sweep.conformed], ["failed", sweep.failed],
         ["pruned", sweep.pruned], ["skipped", sweep.skipped]]
          .map(([k, v]) => k + " " + (typeof v === "number" ? v : "?")).join(" · ") +
        (sweep.ffmpeg === false ? " · ffmpeg was missing" : "")));
  }
  return box;
}

// The button that toggles the preview is inside the region the redraw replaces,
// so pressing it would drop focus to <body>. Its replacement is handed the
// focus instead, and only when the press is what moved it.
function keepPreviewFocus(held, label) {
  if (!held) return null;
  const next = $$("#station .st-open").find((b) => b.textContent === label);
  if (next && next.focus) next.focus();
  return next;
}

const previewFocusHeld = () => {
  const root = $("#station");
  const active = typeof document !== "undefined" ? document.activeElement : null;
  return Boolean(root && active && root.contains && root.contains(active));
};

// The preview lives in its own container, which a redraw never touches: the
// summary refreshes every 20 seconds, and rebuilding an open <video> would
// reopen the stream each time. Never autoplayed — the element is built muted,
// controlled and preload="none", and the operator presses play.
function openStationPreview(name, url) {
  const box = $("#station-preview");
  if (!box) return null;
  const held = previewFocusHeld();
  const video = mediaVideo(url, name + " channel preview", "none");
  const wrap = makeEl("div", "st-preview");
  wrap.append(makeEl("h4", "station-ch-name", name + " preview"),
              makeEl("p", "note", HLS_CLIENT_NOTE), video);
  box.replaceChildren(wrap);
  STATE.ops.preview = name;
  claimMedia(video);
  announce("preview opened for the " + name + " channel — this page is now a " +
           "playlist client of it");
  renderStation();
  keepPreviewFocus(held, "Close preview");
  return video;
}

function closeStationPreview() {
  const box = $("#station-preview");
  const had = STATE.ops.preview;
  const held = previewFocusHeld();
  STATE.ops.preview = null;
  if (box) { releaseMedia(box); box.replaceChildren(); }
  if (had) { renderStation(); keepPreviewFocus(held, "Open preview"); }
  return null;
}

// The station body is shown twice — in full on the Station view, in summary on
// the Overview — so one read decides the state of both regions and neither can
// disagree with the other about how old the content is.
const STATION_STATE_REGIONS = ["#station-state", "#ov-station-state"];

function renderStationState() {
  const st = STATE.station;
  const opts = st.loading && !st.value
    ? { state: "loading" } : readState(st, () => { loadStation(); });
  let rendered = null;
  STATION_STATE_REGIONS.forEach((sel) => {
    rendered = renderPanelState($(sel), opts) || rendered;
  });
  return rendered;
}

// --- configuration, read-only -------------------------------------------------
// What the server loaded from its three files at startup. Nothing here can
// change one: no field, no picker, no form, and no request that writes.

// One file's group: its name, one badge, and the fields behind it. `absent` is
// the sentence shown where there is no badge to show.
function configGroup(title, badge, rows, absent) {
  const group = makeEl("div", "cfg-group");
  const head = makeEl("div", "summary-row");
  head.append(makeEl("span", "lbl", title),
              badge || makeEl("span", "val", absent || NOT_AVAILABLE));
  group.append(head, ...(rows || []));
  return group;
}

// Each file the same way: name, one badge, then its own fields, every one read
// straight off the status object it came from.
function stationConfigGroups(status) {
  const s = status && typeof status === "object" ? status : {};
  const group = (title, part, pairs) => (part && typeof part === "object"
    ? configGroup(title, statusBadge(configLevel(part), configSay(part)), facts(pairs(part)))
    : configGroup(title, null, []));
  const mem = s.memory && typeof s.memory === "object" ? s.memory : null;
  const msgs = mem && mem.messages && typeof mem.messages === "object"
    ? mem.messages : null;
  const kinds = mem && Array.isArray(mem.enabled_kinds) ? mem.enabled_kinds : null;
  return [
    group("channel profile", s.profile, (p) => [
      ["source", fieldText(p.source)],
      ["version", num(p.version)],
      ["valid", yesNo(p.valid)],
    ]),
    group("music manifest", s.music, (m) => [
      ["source", fieldText(m.source)],
      ["version", num(m.version)],
      ["valid", yesNo(m.valid)],
      ["enabled beds", num(m.enabled_beds)],
      ["compatibility", yesNo(m.compatibility,
        "yes — beds outside the manifest are allowed", "no — manifest only")],
    ]),
    // Memory reports no validity of its own; the operator messages file does.
    mem ? configGroup("channel memory",
      statusBadge(msgs ? configLevel(msgs) : "healthy",
        kinds ? (kinds.length ? kinds.length + " memory kind" +
                 (kinds.length === 1 ? "" : "s") + " enabled" : "no memory kinds enabled")
              : "kinds not reported"),
      facts([
        ["refresh", mem.refresh_seconds === 0 ? "off — memory is not refreshed"
          : (present(mem.refresh_seconds) ? String(mem.refresh_seconds) + "s"
                                          : NOT_AVAILABLE)],
        ["kinds", kinds ? (kinds.length ? kinds.map(String).join(", ") : "none")
                        : NOT_AVAILABLE],
        ["history channel", fieldText(mem.channel)],
        ["operator messages", msgs ? configSay(msgs) : NOT_AVAILABLE],
        ["messages enabled", msgs ? num(msgs.enabled) + " of " + num(msgs.total)
                                  : NOT_AVAILABLE],
      ]))
      : configGroup("channel memory", null, []),
  ];
}

// While there is no /api/status body, statusGap's sentence stands in for every
// file: never read is not the same claim as a build that lacks the field.
function renderStationConfig() {
  const el = $("#station-config");
  const gap = statusGap();
  if (el) {
    el.replaceChildren(makeEl("p", "note", FILE_OWNED),
      ...(gap ? CONFIG_FILES.map((name) => configGroup(name, null, [], gap))
              : stationConfigGroups(STATE.status.value)),
      // These files change only when the service is restarted, so this view's
      // 20-second clock re-reads the station and not the status. The age says
      // so out loud rather than letting an hour-old answer look current.
      summaryRow("last read", STATE.status.updatedAt
        ? formatAge(STATE.status.updatedAt) : "not read yet"));
  }
  return renderPanelState($("#station-config-state"),
    STATE.status.loading && !STATE.status.value
      ? { state: "loading" }
      : readState(STATE.status, () => { loadStatus(); }));
}

// What the station body was told, so a channel with no answer can say how old
// the last good one is rather than going blank.
const stationMeta = () => ({ updatedAt: STATE.station.updatedAt });

function renderStation() {
  const el = $("#station");
  if (el) {
    // A failed read never clears known-good content: the panel-state region
    // above marks it stale and the last body stays on screen.
    if (STATE.station.value) {
      el.replaceChildren(stationEl(STATE.station.value, stationMeta()));
    } else if (STATE.station.error) {
      el.replaceChildren(statusBadge("offline",
        stationState("live", null, stationMeta()).message));
    }
  }
  const conform = $("#conform");
  if (conform) conform.replaceChildren(conformEl(STATE.station.value));
  renderStationConfig();
  renderActionLocks();
  renderOvStation();
}

async function loadStation() {
  if (stationAbort) stationAbort.abort();
  const controller = new AbortController();
  stationAbort = controller;
  STATE.station.loading = true;
  renderStationState();
  let s;
  try {
    s = await api("/api/station", { signal: controller.signal });
  } catch (err) {
    if (stationAbort !== controller) return null;
    STATE.station.loading = false;
    if (isApiAbort(err)) return null;
    STATE.station.error = err.message;
    renderStation();
    renderStationState();
    return null;
  }
  if (stationAbort !== controller) return null;
  STATE.station.loading = false;
  STATE.station.error = null;
  STATE.station.value = asObject(s);
  STATE.station.updatedAt = now();
  renderStation();
  renderStationState();
  return s;
}

// ==== 10. Operations and jobs ====

// Housekeeping actions. Both are idempotent — they only remove debris or
// restore assets whose media is verifiably fine — so neither needs a confirm,
// and each offers the endpoint's own dry run first.
// Both endpoints answer the same body for a dry run and for the real thing,
// with `dry_run` saying which it was — so one sentence covers both, in the
// tense the answer itself reports.
const TIDY_SAY = (j) => (j.dry_run ? "would remove " : "removed ") +
  j.zero_byte_files + " empty file(s), " + j.empty_dirs + " empty dir(s)";
const REVIVE_SAY = (j) => j.restored + (j.dry_run ? " restorable" : " restored") +
  ", " + j.still_dead + " still unplayable, " +
  j.skipped_streams + " stream(s) skipped";
const MAINT = {
  "tidy-dry": { url: "/api/pool/tidy?dry_run=true", label: "preview tidy", say: TIDY_SAY },
  tidy: { url: "/api/pool/tidy", label: "tidy up", say: TIDY_SAY },
  "revive-dry": { url: "/api/pool/revive?dry_run=true", label: "preview recheck",
                  say: REVIVE_SAY },
  revive: { url: "/api/pool/revive", label: "recheck retired", say: REVIVE_SAY },
};

// Prepare-output actions, which both need ffmpeg. Conform is offered here and
// on the Station view; they carry the same job key, so one lock covers both.
const PREP = {
  render: { url: "/api/render/cards", label: "render cards" },
  conform: { url: "/api/station/conform", label: "station conform" },
};

// Costly and not reversible from this page, so it is the one action here that
// stops to ask. Routine refresh never does.
const STARTER_NOTE = "This downloads clips from the stock and archive sources " +
  "using your own API keys. It can take several minutes and is deliberately " +
  "paced so the archives do not throttle you, and nothing on this page undoes it.";

const JOB_STOPPED = "stopped checking — the job may still be running";
const JOB_FORGOTTEN = "status unknown: the server no longer tracks this job";

// --- the jobs list ------------------------------------------------------------
// Two sources, one list. `STATE.jobs.items` is what THIS page started: it knows
// a label before the POST answers and covers the synchronous actions the
// registry never sees. `STATE.jobs.server` is the last GET /api/jobs, which is
// authoritative for status and result. Overview shows the five newest;
// Operations the lot, with the raw result foldable and Retry where it is safe.

const JOB_LEVELS = { working: "working", done: "healthy", error: "failed",
                     unknown: "attention" };
const jobLevel = (status) => own(JOB_LEVELS, status) || "attention";
const JOB_STATUSES = ["working", "done", "error", "unknown"];

// Repeating an action is offered only where a second run does the same work
// again with no extra consequence. Never for the starter (it downloads, on the
// operator's own API keys), never for an ingest of arbitrary text (it would
// pull the material a second time), and never for anything that deletes.
const RETRY_ACTIONS = {
  "station conform": { url: "/api/station/conform" },
  "capture-windows": { url: "/api/sources/capture-windows" },
  "fetch-queue": { url: "/api/sources/fetch-queue" },
  "render cards": { url: "/api/render/cards" },
  "preview tidy": { url: MAINT["tidy-dry"].url, say: TIDY_SAY },
  "tidy up": { url: MAINT.tidy.url, say: TIDY_SAY },
  "preview recheck": { url: MAINT["revive-dry"].url, say: REVIVE_SAY },
  "recheck retired": { url: MAINT.revive.url, say: REVIVE_SAY },
};
const GENERATE_LABEL = /^generate ([a-z_]{1,40})$/;

/**
 * How to run this job again, or null when repetition is not safe.
 *
 * A row this page started carries its own descriptor. A row that only the
 * server knows about is matched by its registry label against the table above —
 * an unrecognised label gets no Retry, which is the safe way round.
 */
function jobRetry(job) {
  if (!job || typeof job !== "object") return null;
  if (job.retry) return job.retry;
  const label = String(job.label === undefined || job.label === null ? "" : job.label);
  if (Object.prototype.hasOwnProperty.call(RETRY_ACTIONS, label)) {
    return Object.assign({ label }, RETRY_ACTIONS[label]);
  }
  const gen = GENERATE_LABEL.exec(label);
  if (gen) return { url: "/api/generate/" + gen[1] + "?n=20", label };
  return null;
}

// A result is a string or the dict an action returns; either way it reaches the
// DOM as text through a property, never as markup.
function jobResultText(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result); } catch (e) { return String(result); }
}

// Bounded, but newlines kept: a <pre> inside <details> is where an action's
// stdout is actually readable.
function rawResult(value) {
  const text = jobResultText(value);
  return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
}

const stampMs = (seconds) => {
  const n = Number(seconds);
  return isFinite(n) && n > 0 ? n * 1000 : null;
};

function recordJob(label, retry) {
  const at = now();
  const name = String(label);
  const record = { id: "page-" + (++jobSeq), label: name, status: "working",
                   startedAt: at, updatedAt: at, result: "", polling: false,
                   retry: retry === undefined ? jobRetry({ label: name }) : retry };
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

/**
 * One list from the two registries, newest first.
 *
 * Rows are keyed by job id: once a POST answers, the page's record carries the
 * server's id and the two merge into one row. The server wins on status and
 * result (it is running the work); the page keeps the label it already showed
 * if the server sends none, and keeps its own Retry descriptor. Pure.
 */
function mergeJobs(client, server) {
  const rows = [];
  const at = new Map();
  const push = (row) => {
    const seen = at.get(row.id);
    if (seen === undefined) { at.set(row.id, rows.length); rows.push(row); return; }
    rows[seen] = Object.assign({}, rows[seen], row, {
      label: row.label || rows[seen].label,
      retry: row.retry || rows[seen].retry,
      source: "both",
    });
  };
  (Array.isArray(client) ? client : []).forEach((job) => {
    if (!job || typeof job !== "object") return;
    push({ id: String(job.id), label: String(job.label), status: job.status,
           createdAt: job.startedAt, updatedAt: job.updatedAt,
           result: jobResultText(job.result), retry: job.retry || null,
           source: "page" });
  });
  (Array.isArray(server) ? server : []).forEach((job) => {
    if (!job || typeof job !== "object") return;
    if (job.id === undefined || job.id === null || String(job.id) === "") return;
    push({ id: String(job.id),
           label: String(job.request === undefined || job.request === null
             ? "" : job.request),
           status: JOB_STATUSES.indexOf(job.status) === -1 ? "unknown" : job.status,
           createdAt: stampMs(job.created_at), updatedAt: stampMs(job.updated_at),
           result: jobResultText(job.result), source: "server" });
  });
  // Stable, so rows created inside the same millisecond keep the order the
  // registries already had them in (newest first).
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

const jobsList = () => mergeJobs(STATE.jobs.items, STATE.jobs.server);

/**
 * One row. `opts.details` puts the bounded raw result in an expandable block
 * (Operations); without it the row carries a single collapsed line (the
 * Overview, which is triage and offers no controls of its own). `opts.retry`
 * offers Retry where `jobRetry` says repeating is safe.
 */
function jobRowEl(job, opts) {
  const options = opts || {};
  const li = makeEl("li", "jobrow");
  li.append(statusBadge(jobLevel(job.status), job.label));
  li.append(makeEl("span", "jobrow-age",
    "started " + formatAge(job.createdAt, options.at) +
    " · updated " + formatAge(job.updatedAt, options.at)));
  const result = jobResultText(job.result);
  if (result && options.details) {
    const box = makeEl("details", "jobrow-details");
    box.append(makeEl("summary", "", job.status === "error" ? "error" : "result"),
               makeEl("pre", "jobrow-result", rawResult(result)));
    li.append(box);
  } else if (result) {
    li.append(makeEl("span", "jobrow-result", humanMessage(result, "")));
  }
  // Keyed by a server-supplied id, so it is read as a map and not as an object
  // whose prototype would answer for "constructor" or "__proto__".
  const note = own(STATE.ops.jobNotes, job.id);
  if (note) {
    li.append(statusBadge("attention", String(note)));
    // The escape from a lost poll is another poll, not another run of the job:
    // the work is very likely still going, and starting a second copy of it is
    // the one thing that would make the situation worse.
    const watch = JOB_WATCH.get(job.id);
    if (watch && watch.check) {
      const check = makeButton("Check now", "jobrow-check mini",
        () => { watch.check(); }, "Check the status of " + job.label + " now");
      check.dataset.jobId = String(job.id);
      li.append(check);
    }
  }
  // Retry is a second way to start the same action, so it is one of the buttons
  // that action's lock covers — and a job that is still running is not offered
  // a copy of itself at all.
  if (options.retry && job.status !== "working") {
    const again = jobRetry(job);
    if (again) {
      const button = makeButton("Retry", "jobrow-retry mini", () => {
        doAction(again.url, again.label, { say: again.say, retry: again });
      }, "Run " + again.label + " again");
      button.dataset.jobKey = again.label;
      button.disabled = Boolean(own(STATE.ops.running, again.label));
      li.append(button);
    }
  }
  return li;
}

/**
 * One region, one state, for either list — on the same ladder as every other
 * read-backed region, so a refresh that fails marks the rows stale with their
 * age and a Retry instead of leaving them looking current.
 *
 * "Has a value" for this region means the server list has been read at least
 * once. Before that the page's own registry is the whole truth and says so;
 * after it, a failed read is staleness rather than emptiness.
 */
function renderJobsState(el, count) {
  if (!el) return null;
  const j = STATE.jobs;
  const opts = readState({ value: j.updatedAt ? j.server : null, error: j.error,
                           updatedAt: j.updatedAt }, () => { loadJobs(); });
  // Never read successfully, but this page started jobs of its own: those rows
  // are still true, so the region reports the read that failed rather than
  // hanging a Failed badge over work that is running perfectly well.
  if (opts.state === "error" && count) {
    return renderPanelState(el, { state: "error",
      message: "Showing only the jobs this page started — " + String(j.error),
      onAction: () => { loadJobs(); } });
  }
  if (opts.state === "stale" || opts.state === "error") {
    return renderPanelState(el, opts);
  }
  if (count) return renderPanelState(el, { state: "populated" });
  return renderPanelState(el, { state: "empty", message: j.updatedAt
    ? "No jobs — the server's registry is empty."
    : "No jobs started from this page, and the server's list has not been read yet." });
}

function renderJobs(at) {
  const items = recentJobs(jobsList());
  const list = $("#jobs-list");
  if (list) list.replaceChildren(...items.map((job) => jobRowEl(job, { at })));
  renderJobsState($("#jobs-state"), items.length);
  return renderOpsJobs(at);
}

function renderOpsJobs(at) {
  const items = jobsList();
  const list = $("#ops-jobs-list");
  if (list) {
    list.replaceChildren(...items.map(
      (job) => jobRowEl(job, { at, details: true, retry: true })));
  }
  return renderJobsState($("#ops-jobs-state"), items.length);
}

// A read that fails leaves the page's own list standing: the jobs this tab
// started are still true, and blanking them would lose the only record of a
// job whose POST never reached the registry.
async function loadJobs() {
  if (jobsAbort) jobsAbort.abort();
  const controller = new AbortController();
  jobsAbort = controller;
  STATE.jobs.loading = true;
  let body;
  try {
    body = await api("/api/jobs?limit=" + MAX_JOBS, { signal: controller.signal });
  } catch (err) {
    if (jobsAbort !== controller) return null;
    jobsAbort = null;
    STATE.jobs.loading = false;
    if (isApiAbort(err)) return null;
    STATE.jobs.error = err.message;
    renderJobs();
    renderChrome();
    return null;
  }
  if (jobsAbort === controller) jobsAbort = null;
  STATE.jobs.loading = false;
  STATE.jobs.error = null;
  STATE.jobs.server = body && Array.isArray(body.jobs) ? body.jobs : [];
  STATE.jobs.updatedAt = now();
  renderJobs();
  // The failed-job warning is derived from this list, so a read that changes
  // the list has to redraw it — otherwise a failure the panel is showing has
  // no warning above it until the next status read happens to repaint.
  renderWarnings();
  renderChrome();
  syncJobWatches();
  return body;
}

// --- following a job to a terminal state --------------------------------------
// Every working job in the list is followed, whether this page started it or
// the server already had it: a row that says "working" for ever is a lie, and a
// job another tab started is still an operator's job.

const JOB_WATCH = new Map();

// A pause a control can cut short or abandon. Both watchers use it, so "Check
// now" and "Stop checking" cannot behave differently depending on which surface
// started the job.
function interruptiblePause() {
  let wake = null;
  return {
    wait: (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    }),
    wake: () => { if (wake) wake(); },
  };
}

// The row is rebuilt around the button that was just pressed, so focus would
// fall to <body>. Only when the press is what moved it: this is also called
// from a background poll nobody is looking at, and stealing focus then would
// take the operator out of whatever they were typing.
function noteJob(id, message) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const held = Boolean(active && active.dataset &&
    active.dataset.jobId === String(id) &&
    String(active.className).split(" ").indexOf("jobrow-check") !== -1);
  STATE.ops.jobNotes[id] = message;
  renderJobs();
  if (held) {
    const next = $$(".jobrow-check").find((b) => b.dataset.jobId === String(id));
    if (next && next.focus) next.focus();
  }
  return null;
}

function refreshAfterJob() {
  loadStatus();
  loadGrid(true);
  loadStation();
  return null;
}

// A terminal state is news for more than its own row: pool counts, the station
// and the library listing may all have changed under it.
function applyJobResult(id, final) {
  const answer = final && typeof final === "object" ? final : {};
  const text = rawResult(answer.result === undefined ? answer : answer.result);
  delete STATE.ops.jobNotes[id];
  const record = STATE.jobs.items.find((r) => String(r.id) === id);
  if (record) finishJob(record, jobOutcome(answer.status), text);
  const row = STATE.jobs.server.find((r) => r && String(r.id) === id);
  if (row) {
    row.status = jobOutcome(answer.status);
    row.result = text;
    row.updated_at = now() / 1000;
  }
  renderJobs();
  renderWarnings();
  renderChrome();
  refreshAfterJob();
  return null;
}

function watchListedJob(id) {
  if (JOB_WATCH.has(id)) return null;
  let stopped = false;
  const paused = interruptiblePause();
  const entry = {
    stop: () => { stopped = true; paused.wake(); },
    // Cuts the current pause short, so an operator who can see the server is
    // back does not sit out the ten-second backoff.
    check: paused.wake,
  };
  JOB_WATCH.set(id, entry);
  const settle = (final) => {
    JOB_WATCH.delete(id);
    // An abandoned watch writes nothing: the view that owned it is gone.
    if (stopped) return null;
    return applyJobResult(id, final);
  };
  return pollJob({ job_id: id, status: "working" }, undefined, paused.wait, {
    stopped: () => stopped,
    // A background poll does not shout into the live region every ten seconds;
    // the row itself carries the doubt, and Retry is on the row.
    onUnknown: (message) => { noteJob(id, message); },
  }).then(settle, (err) => settle({ status: "unknown", result: err.message }));
}

function syncJobWatches() {
  if (STATE.route !== "operations") return null;
  jobsList().forEach((job) => {
    if (job.status !== "working") return;
    // No server id yet: the POST has not answered, so there is nothing to poll.
    if (job.id.indexOf("page-") === 0) return;
    // Its own surface is already waiting on it; two polls would double the load
    // and race each other to write the answer.
    const owner = STATE.jobs.items.find((r) => String(r.id) === job.id);
    if (owner && owner.polling) return;
    watchListedJob(job.id);
  });
  return null;
}

function stopJobWatches() {
  JOB_WATCH.forEach((entry) => entry.stop());
  JOB_WATCH.clear();
  // The doubt belonged to polls that no longer exist. Re-entering the view
  // starts fresh watches, which raise their own the moment a read is lost —
  // a note with neither Check now nor Retry beside it is not an escape.
  STATE.ops.jobNotes = {};
  return null;
}

// A surface that starts a job takes it over from the background watch: two
// polls would double the load on the registry and race to write the answer.
function stopJobWatch(id) {
  const entry = JOB_WATCH.get(id);
  if (entry) { entry.stop(); JOB_WATCH.delete(id); }
  return null;
}

// --- action locking -----------------------------------------------------------
// Only the duplicate action is held while a job runs: freezing every unrelated
// button because one is busy is a UI decision, not the server's. Every button
// that starts the same work carries the same data-job-key, so the Station's
// Conform now and the Operations copy lock together and nothing else does.

// Which panel reports an action depends on where the operator started it, not
// on what the action is: the same conform can be started from the Station's own
// panel or from a Retry on Operations, and reporting it into a region inside
// the view that is currently hidden would leave the operator watching nothing.
const ACTION_REGIONS = { station: "#conform-state" };
const activeActionRegion = () =>
  own(ACTION_REGIONS, STATE.route) || "#actions-state";

function renderActionLocks() {
  $$("[data-job-key]").forEach((button) => {
    button.disabled = Boolean(own(STATE.ops.running, button.dataset.jobKey));
  });
  return null;
}

// A count, not a flag: the server runs two blocking actions at a time, so the
// same action can genuinely be running twice, and the first one to finish must
// not hand back a control the second is still holding. Never goes negative — a
// release with nothing held simply leaves it unheld.
function lockAction(label, held) {
  const key = String(label);
  const at = own(STATE.ops.running, key) || 0;
  if (held) STATE.ops.running[key] = at + 1;
  else if (at <= 1) delete STATE.ops.running[key];
  else STATE.ops.running[key] = at - 1;
  renderActionLocks();
  return STATE.ops.running;
}

// "unknown" is not "failed": a lost status read may well have been a job that
// finished. Only an outright error is recorded as one.
const jobOutcome = (status) =>
  status === "error" ? "error" : (status === "unknown" ? "unknown" : "done");

// A job POST returns immediately and polling owns the long wait: no clock is
// imposed on the server's own duration and no five-minute success is invented.
// A lost read is not a lost job — the work is very likely still running — so a
// network failure keeps `status unknown`, backs off to ten seconds and keeps
// asking. Only a 404, the server no longer tracking the id, ends the poll, and
// even that reports unknown. `hooks.stopped()` is how a surface abandons the
// wait, so no caller can be left awaiting a poll that never returns.
async function pollJob(job, getStatus = async (jobId) =>
  api("/api/request/" + encodeURIComponent(jobId)),
pause, hooks = {}) {
  // Required, and deliberately so: a default setTimeout nothing can clear is
  // exactly the poll that outlives its view. Every caller owns a pause its own
  // Stop and Check now can reach.
  if (typeof pause !== "function") {
    throw apiError(0, "pollJob needs a pause its caller can cancel.");
  }
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
    // A stop asked for while that read was in flight is answered here, before
    // the loop opens another timer nobody is going to wait out.
    if (stopped()) return { status: "unknown", result: JOB_STOPPED };
  }
  return current;
}

// Every operator surface that waits on a job shares this. pollJob owns the
// state machine; the pause here can be cut short by "Check now" or abandoned
// by "Stop checking", and the surface's controls go back to the operator the
// moment a read is lost. Nothing here can leave a panel disabled with no way
// out, and a superseded surface abandons its poll instead of polling forever.
function watchJob(job, view) {
  const id = job && job.job_id !== undefined && job.job_id !== null
    ? String(job.job_id) : "";
  let stopped = false;
  const paused = interruptiblePause();
  const entry = { stop: () => { stopped = true; paused.wake(); },
                  check: paused.wake };
  // Registered under the job's own id, so leaving the view stops this poll
  // with every other one — a surface that is gone must not keep asking. The
  // work carries on server-side and the background watch picks it up again
  // when the operator opens the view that can show it.
  if (id) JOB_WATCH.set(id, entry);
  const escapes = [
    { label: "Check now", onClick: paused.wake },
    { label: "Stop checking", onClick: entry.stop },
  ];
  const release = () => {
    if (id && JOB_WATCH.get(id) === entry) JOB_WATCH.delete(id);
  };
  return pollJob(job, undefined, paused.wait, {
    stopped: () => stopped || (view.superseded ? view.superseded() : false),
    onWorking: (seconds) => view.working(seconds),
    onUnknown: (message) => { view.release(); view.unknown(message, escapes); },
  }).then((final) => { release(); return final; },
          (err) => { release(); throw err; });
}

function wireMaintenance() {
  // Routine housekeeping and its dry runs: idempotent, cheap, no modal.
  $$("[data-maint]").forEach((b) => b.addEventListener("click", () => {
    const m = own(MAINT, b.dataset.maint);
    return m ? doAction(m.url, m.label, { say: m.say }) : null;
  }));

  $$("[data-prep]").forEach((b) => b.addEventListener("click", () => {
    const p = own(PREP, b.dataset.prep);
    return p ? doAction(p.url, p.label) : null;
  }));

  $$("[data-starter]").forEach((b) => b.addEventListener("click", async () => {
    // The dry run only reports, so it goes straight through; the real one
    // spends the operator's API quota and bandwidth, so it stops to ask.
    if (b.dataset.starter === "dry") {
      return doAction("/api/starter?dry_run=true", "check starter", { retry: null });
    }
    const go = await confirmDialog({
      title: "Run the starter seeds?", body: [STARTER_NOTE],
      confirmLabel: "Seed the pool", cancelLabel: "Cancel",
    });
    if (!go) return null;
    return doAction("/api/starter?dry_run=false", "run starter", { retry: null });
  }));
}

/**
 * Start one action and follow its job to a terminal state.
 *
 * `opts.region` overrides the panel-state element that reports it; by default
 * that is the region of the view the operator is on, so the same action started
 * from the Station's own panel and from a Retry on Operations each reports
 * somewhere visible. `opts.say` formats a synchronous body, and `opts.retry`
 * overrides what Retry would repeat (null where it must not be offered at all).
 *
 * Only the duplicate action is disabled while the job runs; unrelated controls
 * stay available. The shared region still belongs to the newest action, which
 * is what `actionGeneration` decides, but a button's lock is its own.
 */
async function doAction(url, label, opts) {
  const options = opts || {};
  const state = $(options.region || activeActionRegion());
  const mine = ++actionGeneration;
  const record = recordJob(label, options.retry);
  const current = () => mine === actionGeneration;
  // Held only while the operator is really being made to wait: the moment a
  // status read is lost the button comes back, so the escape from a silent
  // server is a control rather than a page reload. Because a lost poll releases
  // early, this run's release takes the lock once and gives it back once.
  let holding = true;
  const release = () => {
    if (!holding) return null;
    holding = false;
    return lockAction(label, false);
  };
  lockAction(label, true);
  announce("→ " + label + " …");
  renderJobState(state, "working", label + "…", []);
  try {
    let r = await api(url, { method: "POST", timeout: 0 });
    const synchronous = !r || !r.job_id;
    if (!synchronous) {
      record.id = String(r.job_id);
      record.polling = true;
      stopJobWatch(record.id);
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
      record.polling = false;
    }
    const result = r && r.result !== undefined ? r.result : r;
    let msg = jobResultText(result);
    // A synchronous endpoint answers with its own counts; the action that asked
    // knows how to read them, and a thrown formatter must not lose the body.
    if (synchronous && options.say) {
      try { msg = String(options.say(r)); } catch (e) { /* keep the raw body */ }
    }
    const status = r && r.status !== undefined ? r.status : "done";
    // "unknown" is not "failed": the run may well have completed.
    const mark = status === "error" ? "✗ " : (status === "unknown" ? "▲ " : "✓ ");
    // Recorded whether or not this surface is still the current one: the job
    // ran, and the jobs list is about jobs, not about panels.
    finishJob(record, jobOutcome(status), msg);
    if (current()) {
      announce(mark + label + ": " + msg.trim().split("\n").slice(-2).join(" ") +
               (status === "unknown" ? " — run it again to check" : ""));
    }
  } catch (err) {
    record.polling = false;
    // 429 is the server saying "not now", not "this failed": the action never
    // started, so it is worth saying plainly and worth trying again.
    const capacity = err.status === 429;
    finishJob(record, "error", err.message);
    if (current()) {
      announce((capacity ? "▲ " : "✗ ") + label +
               (capacity ? " not started: " + err.message + " — try again in a moment"
                         : " failed: " + err.message));
    }
  }
  release();
  if (current()) renderPanelState(state, { state: "populated" });
  refreshAfterJob();
  if (STATE.route === "operations") loadJobs();
}

async function submitAsk() {
  const inp = $("#ask"), btn = $("#ask-go"), out = $("#ask-result");
  const text = inp.value.trim();
  if (!text) return;
  // A poll that hands the controls back can be overtaken by a second ask; only
  // the newest one is allowed to write to the result line.
  const mine = ++askGeneration;
  const current = () => mine === askGeneration;
  // Never retried from the jobs list: repeating an ingest of arbitrary text
  // pulls the material a second time.
  const record = recordJob("add: " + text.slice(0, 60), null);
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
  } catch (err) {
    // The field is deliberately not cleared on the way out: a refusal — a 429
    // saying the registry is full above all — must not cost the operator what
    // they typed. It is still there, still selected by focus, still sendable.
    return finish(err.status === 429 ? "attention" : "failed",
      err.status === 429 ? err.message + " — your text is still here, try again"
                         : err.message);
  }
  if (!job.job_id) return finish(job.status === "error" ? "failed" : "healthy", job.result || "done");
  record.id = String(job.job_id);
  // This surface takes the job over from the background watch, exactly as
  // doAction does: two polls would double the load on the registry and race
  // each other to write the answer.
  stopJobWatch(record.id);
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

// ==== 11. Lifecycle, visibility, boot ====

const isVisible = () => typeof document === "undefined" ||
  document.visibilityState === undefined || document.visibilityState === "visible";

// The 20-second refresh does nothing while the tab is hidden, and coming back
// refreshes at once rather than waiting out the interval. Only the two views
// with live figures have a clock, and each reads only what it shows.
async function refreshTick() {
  if (!isVisible()) return null;
  if (STATE.route === "overview") {
    return Promise.all([loadStatus(), loadStation(), loadJobs()]);
  }
  if (STATE.route === "station") return loadStation();
  // Operations has no clock of its own: only the two views that show live
  // figures do. Its jobs list is kept current by one poll per working job,
  // which is what the plan asks for and costs nothing while nothing is running.
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
  // The Station view's own copy of the conform action. Where it reports is
  // decided by the view the operator is on, not hard-coded here.
  $$("[data-station]").forEach((b) =>
    b.addEventListener("click", () => doAction(PREP.conform.url, PREP.conform.label)));
  $("#shuffle").addEventListener("click", shufflePreview);
  $("#more").addEventListener("click", () => loadGrid(false));
  $("#search").addEventListener("input", (e) => scheduleSearch(e.target.value));
  // Every filter is a labelled control that owns one filter and nothing else.
  const on = (sel, type, fn) => { const el = $(sel); if (el) el.addEventListener(type, fn); };
  on("#filter-type", "change", (e) => { setFilter("type", e.target.value); });
  on("#filter-kind", "change", (e) => { setFilter("kind", e.target.value); });
  on("#filter-state", "change", (e) => { setFilter("state", e.target.value); });
  on("#page-size", "change", (e) => { setPageSize(e.target.value); });
  on("#density", "change", (e) => { setDensity(e.target.value); });
  on("#clear-filters", "click", () => { clearFilters(); });
  on("#drop-kind", "click", () => { dropKind(); });
  on("#inspector-close", "click", () => { closeInspector(); });
  wireComposer();

  document.addEventListener("visibilitychange", handleVisibilityChange);
  // Anchors carry the routes, so a click is an ordinary in-page hash change:
  // no listener, no preventDefault, and no reload. Back and forward arrive
  // here the same way a deep link does.
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", () => { applyHash(); });
  }
  applyHash();
}

// ==== 12. CommonJS exports for tests ====

const COMMONJS = typeof module !== "undefined" && module.exports;
if (typeof document !== "undefined" && !COMMONJS) boot();
if (COMMONJS) {
  module.exports = {
    // constants
    PAGE, PAGE_SIZES, API_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, REFRESH_MS,
    JOB_POLL_MS, STATE, ROUTES, DEFAULT_ROUTE, LIBRARY_STATES, LIBRARY_TYPES,
    LIBRARY_DENSITIES, NOT_AVAILABLE,
    // helpers
    makeEl, makeLink, api, isApiAbort, humanMessage, formatAge, formatDuration,
    // routing and shell
    parseHash, applyHash, enterRoute, exitRoute, VIEWS, renderChrome, renderNav,
    // components
    statusBadge, renderPanelState, cardEl,
    freshnessLine, stationEl, stationState, stationNow, summaryRow, poolState,
    confirmDialog, closeAllDialogs,
    // overview
    overviewWarnings, poolCounts, configLines, renderOverview,
    // jobs started from this page
    recordJob, finishJob, recentJobs, renderJobs,
    // library
    loadGrid, scheduleSearch, shufflePreview, clearFilters, renderFilters,
    renderLibrary, applyLibraryQuery, libraryCounts, libraryHash, setFilter,
    setPageSize, setDensity, dropKind,
    // inspector and reversible curation
    openInspector, closeInspector, renderInspector, setInspectorBusy,
    enableBumper, disableBumper, deleteBumper,
    // behaviour
    loadStatus, loadStation,
    pollJob, doAction, announce, refreshTick,
    handleVisibilityChange, submitAsk,
    // composer
    gapLabel, composerProblems, composerParams, composeBreak, readComposerControls, setComposerPreset, renderComposer, timelineItemEl, playComposerSequence, advanceComposer, stopComposerPlayback, markComposerStale, playbackLine, wireComposer, RELAXED_TEXT, STALE_TEXT, COMPOSER_PRESETS,
    // F4: station diagnostics, handoff copy, operations and the jobs list
    stationRollup, conformEl, hlsSupported, renderStation, closeStationPreview,
    STATION_MESSAGES, HLS_NO_NATIVE, RECENT_JOBS, mergeJobs, jobsList, jobRetry,
    renderOpsJobs, loadJobs, lockAction, renderActionLocks, wireMaintenance,
    syncJobWatches, stopJobWatches,
    // F5: creative, selection and provenance insight
    REASON_TEXT, NO_PROVENANCE, FILE_OWNED, renderStationConfig,
    stationConfigGroups,
    resetStateForTests() {
      if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
      stopRefresh();
      stopComposerPlayback();
      stopJobWatches();
      closeAllDialogs();
      libraryAbort = null;
      composerAbort = null;
      statusAbort = null;
      stationAbort = null;
      jobsAbort = null;
      inspectorAbort = null;
      inspectorOnMutate = null;
      activeMedia = null;
      activeRoute = null;
      activeQuery = "";
      navShown = null;
      jobSeq = 0;
      dialogSeq = 0;
      askGeneration = 0;
      actionGeneration = 0;
      inspectorGeneration = 0;
      Object.assign(STATE, initialState());
    },
  };
}
