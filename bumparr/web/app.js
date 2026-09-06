"use strict";

const PAGE = 24;

const API_TIMEOUT_MS = 15e3;

const SEARCH_DEBOUNCE_MS = 250;

const REFRESH_MS = 2e4;

const JOB_POLL_MS = 3e3;

const JOB_BACKOFF_MS = 1e4;

const MAX_NOTICES = 20;

const MAX_JOBS = 20;

const RECENT_JOBS = 5;

const MAX_FILTER_TEXT = 100;

const PAGE_SIZES = [ 24, 48, 100 ];

const ROUTES = [ "overview", "library", "composer", "station", "operations", "generation" ];

const DEFAULT_ROUTE = "overview";

const LIBRARY_STATES = [ "all", "playable", "parked", "dead", "unrendered" ];

const LIBRARY_TYPES = [ "video", "card", "stream", "image" ];

const LIBRARY_DENSITIES = [ "grid", "list" ];

const DENSITY_KEY = "bumparr.library.density";

// Generation owns a separate API, pagination state, and timer from Operations.
const GEN_TERMINAL = {
  completed: 1,
  failed: 1,
  cancelled: 1
};

let GEN_TIMER = null, GEN_PREFLIGHT = null, GEN_MODELS = [], GEN_CREATING = false;

let GEN_JOBS_OFFSET = 0, GEN_REVIEW_OFFSET = 0, GEN_DEFAULT_MODEL = "", GEN_LOAD_VERSION = 0, GEN_ACTION_VERSION = 0;

const GEN_RENDERED = {};

const NOT_AVAILABLE = "Not available in this version.";

const DELETE_FILE_NOTE = "The registry row goes and its media file is deleted with it — an orphaned " + "file would be registered again by the next asset scan. A live stream has no " + "local file and only loses its row.";

const KEEP_FILE_LABEL = "Keep the media file on disk (delete the row only)";

const LIVE_WARNING = "Playing this opens the live stream as a real client, which can advance playout.";

const COPY_BY_HAND = "this browser would not let Bumparr use the clipboard — " + "the URL is selected, copy it with your keyboard";

const REASON_TEXT = {
  eligible: "eligible — nothing is gating it",
  disabled: "disabled — the row is parked",
  unhealthy: "unhealthy — the pool marked its media dead",
  missing_media: "missing media — there is nothing to play",
  base_weight: "base weight — its stored weight is zero or less",
  season: "season — this kind scores zero in the current season",
  daypart: "daypart — this kind scores zero at this hour",
  non_finite_score: "non-finite score — the computed score is not a number"
};

const FACTOR_ORDER = [ "base", "season", "daypart", "recency", "affinity", "fatigue" ];

const ZERO_REASON = {
  base: "base_weight",
  season: "season",
  daypart: "daypart"
};

const ZERO_UNNAMED = "the server raises no reason token for this factor";

const NO_PROVENANCE = "No provenance recorded";

const PROVENANCE_NOTE = "Nothing in this row records where it came from. Every " + "action above still works — this is a note, not a block.";

const NOT_RECORDED = "not recorded";

const FILE_OWNED = "Configuration is file-owned: the channel profile, the " + "music-bed manifest and the operator messages are edited in their files on " + "the server and loaded at startup. Nothing on this page writes them.";

const CONFIG_FILES = [ "channel profile", "music manifest", "channel memory" ];

function initialState() {
  return {
    route: DEFAULT_ROUTE,
    status: {
      value: null,
      loading: false,
      error: null,
      updatedAt: null
    },
    station: {
      value: null,
      loading: false,
      error: null,
      updatedAt: null
    },
    library: {
      filters: {
        q: "",
        kind: null,
        type: null,
        state: "all"
      },
      items: [],
      offset: 0,
      hasMore: false,
      loading: false,
      error: null,
      selectedId: null,
      generation: 0,
      updatedAt: null,
      source: "listing",
      total: null,
      pageSize: PAGE,
      density: "grid"
    },
    inspector: {
      id: null,
      open: false,
      value: null,
      loading: false,
      error: null,
      updatedAt: null,
      busy: "",
      notice: "",
      copied: null
    },
    composer: {
      seconds: 30,
      tolerance: 1.5,
      maxItems: 8,
      placement: "any",
      types: [],
      result: null,
      loading: false,
      error: null,
      updatedAt: null,
      retry: null,
      loadingLabel: "",
      stale: false,
      playback: {
        index: -1,
        playing: false,
        startedAt: null,
        elapsed: 0,
        duration: 0
      }
    },
    jobs: {
      items: [],
      server: [],
      loading: false,
      error: null,
      updatedAt: null
    },
    ops: {
      copied: null,
      preview: null,
      running: {},
      jobNotes: {},
      stoppedJobs: {},
      hls: null,
      ask: {
        busy: false,
        job: null,
        level: "",
        message: ""
      }
    },
    notices: []
  };
}

const STATE = initialState();

let searchTimer = null;

let libraryAbort = null;

let statusAbort = null;

let stationAbort = null;

let jobsAbort = null;

let refreshTimer = null;

let activeRoute = null;

let activeQuery = "";

let navShown = null;

let jobSeq = 0;

let askGeneration = 0;

let actionGeneration = 0;

let inspectorAbort = null;

let inspectorGeneration = 0;

const DIALOGS = [];

let dialogSeq = 0;

let activeMedia = null;

let inspectorOnMutate = null;

const $ = s => document.querySelector(s);

const $$ = s => Array.from(document.querySelectorAll(s));

const asObject = value => value && typeof value === "object" ? value : {};

const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

function reducedMotion() {
  try {
    return typeof matchMedia === "function" && Boolean(matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {
    return false;
  }
}

function execCopy() {
  try {
    return typeof document !== "undefined" && document && typeof document.execCommand === "function" && Boolean(document.execCommand("copy"));
  } catch (e) {
    return false;
  }
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

function makeLink(href, text, cls) {
  const a = document.createElement("a");
  if (cls) a.className = cls;
  a.href = href;
  if (text !== undefined) a.textContent = String(text);
  return a;
}

function makeButton(label, cls, onClick, ariaLabel) {
  const button = makeEl("button", cls, label);
  button.type = "button";
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function labelledControl(id, labelText, control) {
  const wrap = makeEl("p", "field");
  const label = makeEl("label", "", labelText);
  label.setAttribute("for", id);
  control.id = id;
  wrap.append(label, control);
  return wrap;
}

function readLocal(key) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return false;
    localStorage.setItem(key, String(value));
    return true;
  } catch (e) {
    return false;
  }
}

const now = () => Date.now();

function claimMedia(el) {
  if (activeMedia && activeMedia !== el && typeof activeMedia.pause === "function") {
    activeMedia.pause();
  }
  activeMedia = el;
}

function watchMedia(el) {
  el.addEventListener("play", () => claimMedia(el));
  el.addEventListener("pause", () => {
    if (activeMedia === el) activeMedia = null;
  });
  return el;
}

function fillGrid(el, nodes) {
  if (!el) return null;
  releaseMedia(el);
  el.replaceChildren(...nodes);
  return el;
}

function releaseMedia(root) {
  if (!root || typeof root.querySelectorAll !== "function") return null;
  [ "video", "audio" ].forEach(tag => {
    Array.from(root.querySelectorAll(tag)).forEach(el => {
      if (typeof el.pause === "function") el.pause();
      if (el.removeAttribute) el.removeAttribute("src");
      el.src = "";
      if (typeof el.load === "function") {
        try {
          el.load();
        } catch (e) {}
      }
      if (activeMedia === el) activeMedia = null;
    });
  });
  return null;
}

function apiError(status, message, name) {
  const err = new Error(message);
  err.name = name || "ApiError";
  err.status = status;
  return err;
}

const isApiAbort = err => Boolean(err) && err.name === "AbortError";

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

async function readBody(response) {
  if (typeof response.text === "function") {
    let text = "";
    try {
      text = await response.text();
    } catch (e) {
      return {
        ok: false,
        body: null
      };
    }
    if (!text) return {
      ok: true,
      body: null
    };
    try {
      return {
        ok: true,
        body: JSON.parse(text)
      };
    } catch (e) {
      return {
        ok: false,
        body: null
      };
    }
  }
  if (typeof response.json === "function") {
    try {
      return {
        ok: true,
        body: await response.json()
      };
    } catch (e) {
      return {
        ok: false,
        body: null
      };
    }
  }
  return {
    ok: true,
    body: null
  };
}

const whenAborted = signal => new Promise((resolve, reject) => {
  const fire = () => reject(apiError(0, "Request cancelled.", "AbortError"));
  if (signal.aborted) fire(); else signal.addEventListener("abort", fire);
});

// One guarded API boundary: callers receive normalized errors, never raw HTML.
async function api(path, options) {
  const opts = Object.assign({}, options || {});
  const timeout = opts.timeout === undefined ? API_TIMEOUT_MS : opts.timeout;
  const callerSignal = opts.signal || null;
  delete opts.timeout;
  const controller = new AbortController;
  opts.signal = controller.signal;
  let timedOut = false;
  let timer = null;
  const relay = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(); else callerSignal.addEventListener("abort", relay);
  }
  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  }
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (callerSignal) callerSignal.removeEventListener("abort", relay);
  };
  const lost = () => {
    if (timedOut) return apiError(0, "The server did not answer in time.");
    if (callerSignal && callerSignal.aborted) {
      return apiError(0, "Request cancelled.", "AbortError");
    }
    return apiError(0, "Bumparr could not be reached.");
  };
  let response;
  try {
    response = await fetch(path, opts);
  } catch (e) {
    clear();
    throw lost();
  }
  let parsed;
  try {
    parsed = await Promise.race([ readBody(response), whenAborted(controller.signal) ]);
  } catch (e) {
    throw lost();
  } finally {
    clear();
  }
  if (!response.ok) {
    const served = parsed.body && typeof parsed.body === "object" ? parsed.body.error : "";
    throw apiError(response.status, humanMessage(served, httpMessage(response.status)));
  }
  if (!parsed.ok) {
    throw apiError(response.status || 0, "The server sent an answer Bumparr could not read.");
  }
  return parsed.body;
}

const VIEWS = {
  overview: {
    enter: enterOverview,
    exit: exitOverview
  },
  library: {
    enter: enterLibrary,
    exit: exitLibrary
  },
  composer: {
    enter: enterComposer,
    exit: exitComposer
  },
  station: {
    enter: enterStation,
    exit: exitStation
  },
  operations: {
    enter: enterOperations,
    exit: exitOperations
  },
  generation: {
    enter: enterGeneration,
    exit: exitGeneration
  }
};

const currentHash = () => typeof location !== "undefined" && location && location.hash || "";

function parseHash(hash) {
  const raw = String(hash === undefined || hash === null ? "" : hash).replace(/^#/, "");
  const cut = raw.indexOf("?");
  const path = (cut === -1 ? raw : raw.slice(0, cut)).replace(/^\/+/, "");
  const name = path.split("/")[0].toLowerCase();
  return {
    route: ROUTES.indexOf(name) === -1 ? null : name,
    params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1))
  };
}

function isFragmentLink(hash) {
  const raw = String(hash === undefined || hash === null ? "" : hash).replace(/^#/, "");
  if (!raw || raw.charAt(0) === "/" || raw.indexOf("?") !== -1) return false;
  return Boolean(typeof document !== "undefined" && document.getElementById && document.getElementById(raw));
}

function applyHash(hash) {
  const raw = hash === undefined ? currentHash() : hash;
  const parsed = parseHash(raw);
  if (parsed.route) return enterRoute(parsed.route, parsed.params);
  if (activeRoute && isFragmentLink(raw)) return null;
  if (typeof location !== "undefined" && location && location.replace) {
    location.replace("#/" + DEFAULT_ROUTE);
  }
  return enterRoute(DEFAULT_ROUTE, new URLSearchParams(""));
}

// Route transitions own all reads, timers, dialogs, and focus restoration.
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

function exitRoute(name) {
  STATE.route = "";
  stopRefresh();
  stopJobWatches();
  const closed = closeAllDialogs();
  abortReads();
  const live = $("#live-region");
  if (live) live.textContent = "";
  const view = VIEWS[name];
  if (view && view.exit) view.exit();
  if (closed) landOnMain();
}

function landOnMain() {
  const main = $("#main");
  if (main && main.focus) main.focus();
  return main;
}

// Abort before the next view enters so stale completions cannot repaint it.
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
  if (inspectorAbort) {
    inspectorAbort.abort();
    inspectorAbort = null;
    STATE.inspector.loading = false;
  }
  inspectorGeneration++;
  askGeneration++;
  actionGeneration++;
}

function startRefresh() {
  if (refreshTimer === null) refreshTimer = setInterval(refreshTick, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  return null;
}

function renderNav() {
  ROUTES.forEach(name => {
    const view = $("#view-" + name);
    if (view) view.hidden = name !== STATE.route;
  });
  $$("#viewnav [data-view]").forEach(link => {
    if (link.dataset.view !== STATE.route) {
      link.removeAttribute("aria-current");
      return;
    }
    link.setAttribute("aria-current", "page");
    if (navShown !== STATE.route && link.scrollIntoView) {
      try {
        link.scrollIntoView({
          block: "nearest",
          inline: "nearest"
        });
      } catch (e) {}
    }
  });
  navShown = STATE.route;
}

function renderChrome(at) {
  renderNav();
  renderStatusPill();
  renderHeaderMeta(at);
  renderFooter();
}

function statusGap() {
  const s = STATE.status;
  if (s.value) return "";
  if (s.error) return s.loading ? "not read: the last try failed, trying again" : "not read: the last try failed";
  if (s.loading) return "reading the service…";
  return "not read yet";
}

function renderHeaderMeta(at) {
  const profileEl = $("#header-profile");
  if (profileEl) {
    const gap = statusGap();
    const profile = STATE.status.value && STATE.status.value.profile;
    if (gap) {
      profileEl.replaceChildren(STATE.status.error ? statusBadge("offline", "profile · " + gap) : makeEl("span", "hmeta-text", "profile · " + gap));
    } else if (!profile || typeof profile !== "object") {
      profileEl.replaceChildren(makeEl("span", "hmeta-text", "profile · " + NOT_AVAILABLE));
    } else {
      const bad = profile.valid === false || profile.source === "fallback-after-error";
      profileEl.replaceChildren(statusBadge(bad ? "attention" : "healthy", "profile · " + String(profile.source == null ? "unknown source" : profile.source)));
    }
  }
  const jobsEl = $("#header-jobs");
  if (jobsEl) {
    const running = jobsList().filter(job => job.status === "working").length;
    jobsEl.textContent = running === 1 ? "1 job running" : running + " jobs running";
  }
  const refreshEl = $("#header-refresh");
  if (refreshEl) {
    refreshEl.textContent = STATE.status.updatedAt ? "service read " + formatAge(STATE.status.updatedAt, at) : "service not read yet";
  }
}

function renderFooter() {
  const el = $("#footer-version");
  if (!el) return;
  const version = STATE.status.value && STATE.status.value.version;
  const usable = (typeof version === "string" || typeof version === "number") && String(version).trim() !== "";
  el.textContent = usable ? "version " + String(version).trim() : "version not reported";
}

function ensureStatus() {
  if (STATE.status.value || STATE.status.loading) return null;
  return loadStatus();
}

function enterOverview() {
  renderOverview();
  startRefresh();
  return Promise.all([ loadStatus(), loadStation(), loadJobs() ]);
}

function exitOverview() {
  return null;
}

function enterLibrary(params) {
  STATE.library.density = storedDensity();
  applyLibraryQuery(params);
  renderFilters();
  renderLibrary();
  renderLibraryState();
  return Promise.all([ ensureStatus(), loadGrid(true) ]);
}

function exitLibrary() {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  releaseMedia($("#grid"));
  return null;
}

function enterComposer() {
  readComposerControls();
  renderComposer();
  return ensureStatus();
}

function exitComposer() {
  return stopComposerPlayback();
}

function enterStation() {
  renderStationState();
  renderStation();
  renderActionLocks();
  startRefresh();
  return Promise.all([ ensureStatus(), loadStation() ]);
}

function exitStation() {
  return closeStationPreview();
}

function enterOperations() {
  renderActionLocks();
  renderAsk();
  renderJobs();
  return Promise.all([ ensureStatus(), loadJobs() ]).then(read => {
    renderAsk();
    return read;
  });
}

function exitOperations() {
  return releaseAsk("");
}

const STATUS_LEVELS = {
  healthy: {
    icon: "✓",
    word: "Healthy"
  },
  working: {
    icon: "◐",
    word: "Working"
  },
  attention: {
    icon: "▲",
    word: "Attention"
  },
  failed: {
    icon: "✕",
    word: "Failed"
  },
  offline: {
    icon: "⌁",
    word: "Offline"
  }
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

function renderJobState(el, level, message, actions) {
  if (!el) return null;
  const nodes = [ statusBadge(level, message) ];
  (actions || []).forEach(action => {
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
  const seconds = Math.max(0, Math.round(((at === undefined ? now() : at) - then) / 1e3));
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

const PANEL_STATES = [ "loading", "populated", "empty", "error", "stale" ];

function readState(source, retry) {
  if (source.error && source.value) {
    return {
      state: "stale",
      message: source.error,
      updatedAt: source.updatedAt,
      onAction: retry
    };
  }
  if (source.error) return {
    state: "error",
    message: source.error,
    onAction: retry
  };
  if (!source.value) return {
    state: "loading"
  };
  return {
    state: "populated"
  };
}

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
    el.append(statusBadge("attention", "Showing the last known data from " + formatAge(opts.updatedAt, opts.now) + "."));
    if (opts.message) el.append(makeEl("p", "panel-state-msg", opts.message));
  }
  if (typeof opts.onAction === "function") {
    const label = opts.actionLabel || "Retry";
    const button = makeEl("button", "panel-retry", label);
    button.addEventListener("click", () => {
      button.disabled = true;
      if (label === "Retry") button.textContent = "Retrying…";
      opts.onAction();
    });
    el.append(button);
  }
  return el;
}

const nativeDialog = node => typeof HTMLDialogElement !== "undefined" && Boolean(node) && typeof node.showModal === "function";

const FOCUS_TAGS = [ "button", "input", "select", "textarea", "summary" ];

const MEDIA_TAGS = [ "video", "audio" ];

const tabIndexed = node => {
  const raw = node.getAttribute ? node.getAttribute("tabindex") : null;
  return raw !== null && raw !== undefined && raw !== "" && Number(raw) >= 0;
};

const hasControls = node => Boolean(node.controls) || (node.getAttribute ? node.getAttribute("controls") !== null : false);

function focusables(root) {
  const out = [];
  const walk = node => {
    Array.from(node && node.children || []).forEach(child => {
      const tag = String(child.tagName || "").toLowerCase();
      const focusable = FOCUS_TAGS.indexOf(tag) !== -1 || tag === "a" && child.href || MEDIA_TAGS.indexOf(tag) !== -1 && hasControls(child) || Boolean(child.isContentEditable) || tabIndexed(child);
      if (focusable && !child.disabled && !child.hidden) out.push(child);
      walk(child);
    });
  };
  walk(root);
  return out;
}

function modalControls(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [ "button", "input", "select", "textarea" ].reduce((all, tag) => all.concat(Array.from(root.querySelectorAll(tag))), []);
}

function trapTab(node, event) {
  const list = focusables(node);
  if (!list.length) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const at = list.indexOf(active);
  const next = event.shiftKey ? at <= 0 ? list.length - 1 : at - 1 : at === -1 || at === list.length - 1 ? 0 : at + 1;
  if (event.preventDefault) event.preventDefault();
  list[next].focus();
}

function openDialog(node, opts) {
  if (!node) return null;
  const options = opts || {};
  const entry = {
    node: node,
    invoker: options.invoker || (typeof document !== "undefined" ? document.activeElement : null),
    onClose: typeof options.onClose === "function" ? options.onClose : null
  };
  if (DIALOGS.indexOf(entry) === -1) DIALOGS.push(entry);
  entry.keydown = event => {
    if (DIALOGS[DIALOGS.length - 1] !== entry) return;
    if (event.key === "Escape") {
      if (event.preventDefault) event.preventDefault();
      closeDialog(node);
      return;
    }
    if (event.key === "Tab") trapTab(node, event);
  };
  node.addEventListener("keydown", entry.keydown);
  entry.cancel = event => {
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
  const at = DIALOGS.findIndex(entry => entry.node === node);
  if (at === -1) return null;
  const entry = DIALOGS[at];
  DIALOGS.splice(at, 1);
  node.removeEventListener("keydown", entry.keydown);
  node.removeEventListener("cancel", entry.cancel);
  if (nativeDialog(node)) node.close(); else node.removeAttribute("open");
  if (entry.invoker && entry.invoker.focus) entry.invoker.focus();
  if (entry.onClose) entry.onClose();
  return entry;
}

function closeAllDialogs() {
  let closed = 0;
  while (DIALOGS.length) {
    closeDialog(DIALOGS[DIALOGS.length - 1].node);
    closed++;
  }
  return closed;
}

function confirmDialog(options) {
  const opts = options || {};
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "dlg dlg-confirm" + (opts.danger ? " dlg-danger" : "");
    const titleId = "dlg-title-" + ++dialogSeq;
    const heading = makeEl("h2", "dlg-title", opts.title || "Are you sure?");
    heading.id = titleId;
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.append(heading);
    const lines = Array.isArray(opts.body) ? opts.body : [ opts.body ];
    lines.forEach(line => {
      if (line) dialog.append(makeEl("p", "dlg-line", String(line)));
    });
    let typed = null;
    if (opts.requireText) {
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      typed = input;
      dialog.append(labelledControl("dlg-require-" + dialogSeq, opts.requireLabel || "Type " + String(opts.requireText) + " to confirm", input));
    }
    let box = null;
    if (opts.checkbox) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(opts.checkbox.checked);
      box = input;
      const row = labelledControl("dlg-keep-" + dialogSeq, String(opts.checkbox.label || "Keep the file"), input);
      row.className = "field field-check";
      dialog.append(row);
    }
    let settled = false;
    const finish = answer => {
      if (settled) return;
      settled = true;
      if (box && opts.checkbox) opts.checkbox.checked = Boolean(box.checked);
      closeDialog(dialog);
      dialog.remove();
      resolve(answer);
    };
    const actions = makeEl("div", "dlg-actions");
    const cancel = makeButton(opts.cancelLabel || "Cancel", "dlg-cancel", () => finish(false));
    const accept = makeButton(opts.confirmLabel || "Confirm", "dlg-confirm" + (opts.danger ? " danger-btn" : ""), () => finish(true));
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
      onClose: () => finish(false)
    });
    return null;
  });
}

function copyControls(id, label, value, store, opts) {
  const options = opts || {};
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.className = "url";
  input.value = String(value);
  input.id = id;
  const select = () => {
    if (input.select) input.select();
  };
  const takeSelection = () => {
    if (input.focus) input.focus();
    select();
  };
  input.addEventListener("focus", select);
  const said = makeEl("p", options.saidClass || "insp-copy");
  const show = () => {
    const done = store.read();
    said.replaceChildren(...done ? [ statusBadge(done.level, done.message) ] : []);
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
  return {
    input: input,
    copy: copy,
    said: said
  };
}

function summaryRow(label, value) {
  const row = makeEl("div", "summary-row");
  row.append(makeEl("span", "lbl", label), makeEl("span", "val", value));
  return row;
}

const present = value => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

function fieldText(value, absent) {
  if (!present(value)) return absent === undefined ? NOT_AVAILABLE : absent;
  return String(value);
}

const facts = pairs => pairs.map(([label, value]) => summaryRow(label, value));

const yesNo = (value, yes, no) => typeof value === "boolean" || value === 0 || value === 1 ? value ? yes || "yes" : no || "no" : NOT_AVAILABLE;

const num = value => present(value) ? String(value) : NOT_AVAILABLE;

function log(message) {
  const el = $("#log");
  if (!el) return;
  el.textContent = (message + "\n" + el.textContent).slice(0, 4e3);
}

function announce(message) {
  const text = String(message);
  STATE.notices.push({
    text: text,
    at: now()
  });
  if (STATE.notices.length > MAX_NOTICES) STATE.notices.shift();
  const live = $("#live-region");
  if (live) live.textContent = text;
  log(text);
}

function provenanceLine(b) {
  const p = b.payload || {};
  const bits = [];
  [ b.source, p.source, p.bg_creator, p.bg_title ].forEach(value => {
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
  const c = b.music_credits || b.payload && b.payload.music_credits || {};
  if (!c || typeof c !== "object") return "";
  const bits = [];
  [ c.title, c.creator, c.license ].forEach(value => {
    const text = value == null ? "" : String(value);
    if (text && bits.indexOf(text) === -1) bits.push(text);
  });
  if (!bits.length && c.id) bits.push(String(c.id));
  return bits.join(" · ");
}

function creativeChips(b) {
  const cr = b.creative && typeof b.creative === "object" ? b.creative : {};
  const box = makeEl("div", "pv-chips");
  const chips = [ [ "family", cr.family ], [ "audio", cr.audio ] ].filter(pair => present(pair[1])).map(([label, value]) => {
    const chip = makeEl("span", "pv-chip");
    chip.append(makeEl("span", "pv-chip-k", label), makeEl("span", "pv-chip-v", String(value)));
    return chip;
  });
  box.append(...chips.length ? chips : [ makeEl("span", "pv-chip-none", NOT_AVAILABLE) ]);
  return box;
}

function factorsLine(b) {
  const f = b.selection && b.selection.factors;
  if (!f) return "";
  const parts = [ "base", "season", "daypart", "recency", "affinity", "fatigue" ].filter(key => f[key] !== undefined).map(key => key + " " + f[key]);
  if (f.score !== undefined) parts.push("score " + f.score);
  return parts.join(" · ");
}

const rowLabel = b => String(b.title || b.kind || b.id || "this bumper").slice(0, 60);

const hasMedia = b => typeof b.media_url === "string" && b.media_url !== "";

function poolState(b) {
  const row = b && typeof b === "object" ? b : {};
  if (row.health === "dead") return "dead";
  if (row.enabled === 0 || row.enabled === false) return "parked";
  if (row.enabled === undefined || row.enabled === null) return "unknown";
  if (row.type === "card" && !hasMedia(row)) return "unrendered";
  return "playable";
}

const STATE_BADGES = {
  playable: [ "healthy", "playable" ],
  parked: [ "attention", "parked" ],
  dead: [ "failed", "dead — the pool could not read its media" ],
  unrendered: [ "attention", "unrendered — no media file yet" ]
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

function mediaVideo(src, label, preload) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.controls = true;
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

function streamPreview(b) {
  const box = makeEl("div", "pv-stream-box");
  const badge = makeEl("div", "pv-stream", "◉ LIVE");
  const note = makeEl("p", "pv-live-note", LIVE_WARNING);
  const play = makeButton("▶ Play live stream", "pv-play mini", () => {
    if (!hasMedia(b)) {
      announce("this stream has no URL to open");
      return;
    }
    const v = mediaVideo(b.media_url, "Live stream " + rowLabel(b), "none");
    box.replaceChildren(badge, v, note);
    claimMedia(v);
    if (typeof v.play === "function") {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }, "Play the live stream " + rowLabel(b));
  box.append(badge, play, note);
  return box;
}

const deadPreview = () => makeEl("div", "pv-stream pv-dead", "media unreadable");

function cardEl(b, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const card = makeEl("article", "pv-card");
  card.dataset.state = poolState(b);
  card.setAttribute("aria-label", rowLabel(b));
  const body = makeEl("div", "pv-body");
  const lengthLine = (b.type === "stream" ? "LIVE" : formatDuration(b.duration)) + (b.type == null || b.type === "" ? "" : " · " + String(b.type));
  if (b.type === "video" || b.type === "image") {
    if (poolState(b) === "dead") card.append(deadPreview()); else if (b.type === "image") card.append(imagePreview(b)); else {
      const v = videoPreview(b);
      card.append(v);
      card.addEventListener("mouseenter", () => {
        if (reducedMotion()) return;
        const started = v.play();
        if (started && started.catch) started.catch(() => {});
      });
      card.addEventListener("mouseleave", () => {
        v.pause();
      });
    }
  } else if (b.type === "stream") {
    card.append(streamPreview(b));
  } else {
    const p = b.payload || {};
    const txt = p.lines ? p.lines.join("\n") : p.number || p.text || b.title || "";
    card.className = "pv-card pv-textcard";
    card.append(makeEl("div", "tc", txt));
  }
  body.append(makeEl("div", "pv-kind", b.kind == null ? "" : b.kind), makeEl("div", "pv-title", b.title == null ? "" : b.title), makeEl("div", "pv-meta", lengthLine));
  const badge = stateBadge(b);
  if (badge) body.append(badge);
  card.append(body);
  decorateCard(card, b);
  if (b.id !== undefined && b.id !== null && String(b.id) !== "") {
    const actions = makeEl("div", "pv-actions");
    const inspect = makeButton("Inspect", "pv-inspect mini", () => {
      openInspector(b.id, {
        invoker: inspect,
        onMutate: options.onMutate
      });
    }, "Inspect " + rowLabel(b));
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

const TYPE_COLOR = {
  video: "var(--accent)",
  stream: "var(--warning)",
  card: "var(--info)",
  image: "var(--accent-strong)"
};

function renderStatusPill() {
  const pill = $("#status-pill");
  if (!pill) return;
  const s = STATE.status.value;
  if (STATE.status.error && !s) {
    pill.replaceChildren(statusBadge("offline", STATE.status.error));
    return;
  }
  if (STATE.status.error) {
    pill.replaceChildren(statusBadge("offline", "last read " + formatAge(STATE.status.updatedAt)));
    return;
  }
  if (!s) {
    pill.replaceChildren(statusBadge("working", "reading the pool…"));
    return;
  }
  const detail = s.total + " bumpers · " + s.playable_now + " live";
  pill.replaceChildren(statusBadge(s.total > 0 ? "healthy" : "attention", detail));
}

function poolCounts(s) {
  const status = s && typeof s === "object" ? s : {};
  const boxes = [];
  const missing = [];
  [ [ status.total, "total" ], [ status.playable_now, "playable now" ], [ status.parked, "parked" ], [ status.dead, "dead" ], [ status.unrendered, "unrendered" ] ].forEach(([value, label]) => {
    if (typeof value === "number" && isFinite(value)) boxes.push({
      n: value,
      label: label
    }); else missing.push(label);
  });
  if (status.by_kind && typeof status.by_kind === "object") {
    boxes.push({
      n: Object.keys(status.by_kind).length,
      label: "kinds"
    });
  } else missing.push("kinds");
  return {
    boxes: boxes,
    missing: missing
  };
}

function renderTotals(s) {
  const totals = $("#totals");
  if (!totals) return;
  const counts = poolCounts(s);
  const nodes = counts.boxes.map(({n: n, label: label}) => {
    const box = makeEl("div", "num", n);
    box.appendChild(makeEl("small", "", label));
    return box;
  });
  if (counts.missing.length) {
    nodes.push(makeEl("div", "totals-missing", counts.missing.join(" · ") + " — " + NOT_AVAILABLE));
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
    fill.style.width = 100 * n / max + "%";
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
    memEl.appendChild(makeEl("div", "", "memory · " + NOT_AVAILABLE));
    return;
  }
  const kinds = Array.isArray(mem.enabled_kinds) ? mem.enabled_kinds : [];
  const msgs = mem.messages && typeof mem.messages === "object" ? mem.messages : {};
  const refresh = mem.refresh_seconds === 0 ? "refresh off" : "refresh " + String(mem.refresh_seconds) + "s";
  const kindText = kinds.length ? kinds.join(", ") : "no kinds";
  const msgState = msgs.valid === false ? "messages invalid" : "messages ok";
  const disabled = kinds.length ? "" : " · disabled";
  memEl.appendChild(makeEl("div", "", "memory · " + refresh + " · " + kindText + " · " + msgState + disabled));
}

const configLevel = part => part.valid === false || part.source === "fallback-after-error" ? "attention" : "healthy";

const configSay = part => String(part.source == null ? "unknown source" : part.source) + (part.valid === false ? " · invalid, running the shipped default" : " · valid");

function configLines(s, gap) {
  if (gap) {
    return [ {
      label: "profile",
      text: String(gap),
      level: null
    }, {
      label: "music",
      text: String(gap),
      level: null
    } ];
  }
  const status = s && typeof s === "object" ? s : {};
  const lines = [];
  const profile = status.profile;
  if (profile && typeof profile === "object") {
    lines.push({
      label: "profile",
      text: configSay(profile),
      level: configLevel(profile)
    });
  } else {
    lines.push({
      label: "profile",
      text: NOT_AVAILABLE,
      level: null
    });
  }
  const music = status.music;
  if (music && typeof music === "object") {
    const beds = typeof music.enabled_beds === "number" ? music.enabled_beds : null;
    lines.push({
      label: "music",
      level: configLevel(music),
      text: configSay(music) + (beds === null ? "" : " · " + beds + " bed" + (beds === 1 ? "" : "s")) + (music.compatibility ? " · compatibility mode" : "")
    });
  } else {
    lines.push({
      label: "music",
      text: NOT_AVAILABLE,
      level: null
    });
  }
  return lines;
}

function renderConfig() {
  const el = $("#config-summary");
  if (!el) return;
  el.replaceChildren(...configLines(STATE.status.value, statusGap()).map(line => {
    const row = makeEl("div", "summary-row");
    row.append(makeEl("span", "lbl", line.label));
    row.append(line.level ? statusBadge(line.level, line.text) : makeEl("span", "val", line.text));
    return row;
  }));
}

function renderService() {
  const el = $("#service-summary");
  if (!el) return;
  const s = STATE.status;
  const level = s.error ? s.value ? "attention" : "offline" : s.value ? "healthy" : "working";
  const detail = s.error ? s.error : s.value ? "answering on this host" : "reading the service…";
  const gap = statusGap();
  const brand = s.value && s.value.brand;
  const version = s.value && s.value.version;
  el.replaceChildren(statusBadge(level, detail), summaryRow("brand", gap || (brand == null || brand === "" ? NOT_AVAILABLE : String(brand))), summaryRow("version", gap || (version === undefined || version === null || version === "" ? "not reported" : String(version))), summaryRow("last refresh", s.updatedAt ? formatAge(s.updatedAt) : "not read yet"));
}

function nowCardEl(card) {
  const box = makeEl("div", "nowcard");
  box.append(makeEl("span", "nowcard-ch", card.channel), makeEl("span", "nowcard-now", card.detail));
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
      el.replaceChildren(statusBadge(state.level, state.detail), summaryRow("ffmpeg", s.ffmpeg === false ? "not found" : s.ffmpeg === true ? "found" : NOT_AVAILABLE), summaryRow("conformed", (s.conformed || 0) + " / " + (s.eligible || 0)), summaryRow("pending", typeof s.pending === "number" ? String(s.pending) : NOT_AVAILABLE));
    }
  }
  const nowEl = $("#ov-now");
  if (nowEl) nowEl.replaceChildren(...stationNow(s).map(nowCardEl));
}

function overviewWarnings(status, station, jobs) {
  const s = status && typeof status === "object" ? status : {};
  const st = station && typeof station === "object" ? station : {};
  const list = [];
  const add = (id, href, message, action) => list.push({
    id: id,
    href: href,
    message: message,
    action: action
  });
  if (s.playable_now === 0) {
    add("no-playable", "#/library?state=playable", "Nothing in the pool is playable right now.", "Open the library");
  }
  if (typeof s.unrendered === "number" && s.unrendered > 0) {
    add("unrendered", "#/library?state=unrendered", s.unrendered + " card(s) have no rendered media yet.", "Open the library");
  }
  if (typeof st.pending === "number" && st.pending > 0) {
    add("conform-backlog", "#/station", st.pending + " item(s) are waiting to be conformed.", "Open the station");
  }
  if (st.ffmpeg === false) {
    add("ffmpeg", "#/station", "ffmpeg was not found, so nothing can be conformed.", "Open the station");
  }
  const profile = s.profile;
  if (profile && typeof profile === "object" && (profile.valid === false || profile.source === "fallback-after-error")) {
    add("profile", "#/station", "The channel profile in use is " + String(profile.source) + ", not the operator's file.", "Open the station");
  }
  const music = s.music;
  if (music && typeof music === "object" && (music.valid === false || music.source === "fallback-after-error")) {
    add("music", "#/station", "The music manifest in use is " + String(music.source) + ", not the operator's file.", "Open the station");
  }
  const failed = (Array.isArray(jobs) ? jobs : []).find(job => job && job.status === "error");
  if (failed) {
    add("failed-job", "#/operations", "A job failed: " + String(failed.label) + ".", "Open operations");
  }
  return list;
}

function warningEl(warning) {
  const li = makeEl("li", "warning");
  const icon = makeEl("span", "warning-icon", "▲");
  icon.setAttribute("aria-hidden", "true");
  const link = makeLink(warning.href, undefined, "warning-link");
  link.append(makeEl("span", "warning-msg", warning.message), makeEl("span", "warning-go", warning.action));
  li.append(icon, link);
  return li;
}

function renderWarnings() {
  const warnings = overviewWarnings(STATE.status.value, STATE.station.value, recentJobs(jobsList()));
  const list = $("#warnings");
  if (list) list.replaceChildren(...warnings.map(warningEl));
  const el = $("#warnings-state");
  if (!el) return null;
  if (!STATE.status.value && !STATE.station.value) {
    if (STATE.status.error || STATE.station.error) {
      return renderPanelState(el, {
        state: "error",
        message: "Nothing could be read, so nothing has been checked."
      });
    }
    return renderPanelState(el, {
      state: "loading"
    });
  }
  if (!warnings.length) {
    return renderPanelState(el, {
      state: "empty",
      message: "Nothing needs attention."
    });
  }
  return renderPanelState(el, {
    state: "populated"
  });
}

function renderOverviewState() {
  const s = STATE.status;
  return renderPanelState($("#pool-state"), s.loading && !s.value ? {
    state: "loading"
  } : readState(s, () => {
    loadStatus();
  }));
}

function renderOverview() {
  const s = STATE.status.value;
  if (s) {
    renderTotals(s);
    renderByType(s);
    renderMemory(s);
  }
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
  const controller = new AbortController;
  statusAbort = controller;
  STATE.status.loading = true;
  renderOverviewState();
  let s;
  try {
    s = await api("/api/status", {
      signal: controller.signal
    });
  } catch (err) {
    if (statusAbort !== controller) return null;
    STATE.status.loading = false;
    if (isApiAbort(err)) return null;
    STATE.status.error = err.message;
    renderOverview();
    renderStationConfig();
    return null;
  }
  if (statusAbort !== controller) return null;
  STATE.status.loading = false;
  STATE.status.error = null;
  STATE.status.value = asObject(s);
  STATE.status.updatedAt = now();
  renderOverview();
  renderFilters();
  renderStationConfig();
  return s;
}

const poolKinds = () => STATE.status.value && STATE.status.value.by_kind || {};

const filtersActive = () => Boolean(STATE.library.filters.kind) || Boolean(STATE.library.filters.q) || Boolean(STATE.library.filters.type) || STATE.library.filters.state !== "all";

function applyLibraryQuery(params) {
  const query = params && typeof params.get === "function" ? params : new URLSearchParams("");
  const lib = STATE.library;
  const f = lib.filters;
  const state = query.get("state");
  const type = query.get("type");
  const kind = query.get("kind");
  const q = query.get("q");
  const before = JSON.stringify([ f.state, f.type, f.kind, f.q ]);
  f.state = LIBRARY_STATES.indexOf(String(state)) === -1 ? "all" : String(state);
  f.type = LIBRARY_TYPES.indexOf(String(type)) === -1 ? null : String(type);
  f.kind = kind ? String(kind).slice(0, MAX_FILTER_TEXT) : null;
  f.q = q ? String(q).slice(0, MAX_FILTER_TEXT) : "";
  lib.offset = 0;
  if (JSON.stringify([ f.state, f.type, f.kind, f.q ]) !== before) {
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

function libraryQuery() {
  const f = STATE.library.filters;
  const params = new URLSearchParams;
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

function goTo(hash) {
  if (typeof location !== "undefined" && location) location.hash = hash;
  return hash;
}

function landAfterRemoval() {
  if (STATE.route !== "library") return null;
  const el = $("#library-counts");
  if (el && el.focus) el.focus();
  return el;
}

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

function setPageSize(raw) {
  const n = Number(raw);
  STATE.library.pageSize = PAGE_SIZES.indexOf(n) === -1 ? isFinite(n) && n > PAGE_SIZES[PAGE_SIZES.length - 1] ? PAGE_SIZES[PAGE_SIZES.length - 1] : PAGE : n;
  renderFilters();
  return loadGrid(true);
}

const storedDensity = () => {
  const saved = readLocal(DENSITY_KEY);
  return LIBRARY_DENSITIES.indexOf(String(saved)) === -1 ? "grid" : String(saved);
};

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
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  const search = $("#search");
  if (search) search.value = "";
  renderFilters();
  syncLibraryHash();
  return loadGrid(true);
}

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
    const nodes = [ option("", "All kinds") ];
    if (f.kind && names.indexOf(f.kind) === -1) nodes.push(option(f.kind, f.kind));
    names.forEach(name => nodes.push(option(name, name + " (" + counts[name] + ")")));
    kindSel.replaceChildren(...nodes);
    kindSel.value = f.kind || "";
  }
  const set = (sel, value) => {
    const el = $(sel);
    if (el) el.value = value;
  };
  set("#filter-type", f.type || "");
  set("#filter-state", f.state);
  set("#page-size", String(STATE.library.pageSize));
  set("#density", STATE.library.density);
  renderDangerZone();
}

function kindCount(kind) {
  const counts = poolKinds();
  return Object.prototype.hasOwnProperty.call(counts, kind) ? counts[kind] : null;
}

function renderDangerZone() {
  const kind = STATE.library.filters.kind;
  const button = $("#drop-kind");
  const note = $("#danger-note");
  const known = kindCount(kind);
  if (button) {
    button.disabled = !kind;
    button.textContent = kind ? "Delete every item in “" + kind + "”" : "Delete every item in this kind";
  }
  if (!note) return;
  if (!kind) {
    note.textContent = "Choose a kind above to delete the whole category. " + "Nothing here is reversible.";
    return;
  }
  note.textContent = "Deletes " + (known === null ? "every item" : known + " item(s)") + " of kind “" + kind + "”. " + DELETE_FILE_NOTE;
}

function libraryCounts() {
  const lib = STATE.library;
  const loaded = lib.items.length;
  const total = typeof lib.total === "number" && isFinite(lib.total) ? lib.total : null;
  return {
    loaded: loaded,
    total: total,
    hasMore: total === null ? lib.hasMore : loaded < total
  };
}

function renderLibraryCounts() {
  const el = $("#library-counts");
  if (!el) return null;
  const counts = libraryCounts();
  const scope = STATE.library.source === "shuffle" ? " drawn at random" : filtersActive() ? " matching the current filters" : " in the pool";
  el.textContent = counts.total === null ? "Showing " + counts.loaded + " loaded · matched total: " + NOT_AVAILABLE : "Showing " + counts.loaded + " of " + counts.total + scope + ".";
  return el;
}

function patchLibraryRow(id, patch) {
  const lib = STATE.library;
  const at = lib.items.findIndex(row => row && row.id === id);
  if (at === -1) return null;
  lib.items[at] = Object.assign({}, lib.items[at], patch || {});
  const grid = $("#grid");
  const card = grid && grid.children ? grid.children[at] : null;
  if (card) {
    releaseMedia(card);
    grid.replaceChild(cardEl(lib.items[at], {
      onMutate: markComposerStale
    }), card);
  }
  return lib.items[at];
}

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
  const keep = {
    label: "Keep the media files on disk (delete the rows only)",
    checked: false
  };
  const ok = await confirmDialog({
    title: "Delete every item in “" + kind + "”?",
    body: [ "Removes " + how + " of kind “" + kind + "” from the registry.", "Unless you tick the box below, their files are deleted with them " + "and the now-empty category directory is removed, because the " + "next asset scan would otherwise register anything left inside it.", "This cannot be undone." ],
    confirmLabel: "Delete " + how,
    danger: true,
    requireText: kind,
    requireLabel: "Type “" + kind + "” to enable the delete button",
    checkbox: keep
  });
  if (!ok) {
    announce("category delete cancelled");
    return null;
  }
  const url = "/api/pool/kind/" + encodeURIComponent(kind) + (keep.checked ? "?keep_files=true" : "");
  let j;
  try {
    j = await api(url, {
      method: "DELETE"
    });
  } catch (err) {
    announce("category delete failed: " + err.message);
    return null;
  }
  const body = asObject(j);
  const failed = Array.isArray(body.failed) ? body.failed.length : 0;
  announce("dropped category " + kind + ": removed " + body.removed + (body.dirs_removed ? ", " + body.dirs_removed + " dir(s)" : "") + (failed ? ", " + failed + " needing manual cleanup" : ""));
  STATE.library.filters.kind = null;
  closeInspector();
  renderFilters();
  syncLibraryHash();
  await loadStatus();
  const listing = await loadGrid(true);
  landAfterRemoval();
  return listing;
}

async function deleteBumper(b) {
  const keep = {
    label: KEEP_FILE_LABEL,
    checked: false
  };
  const ok = await confirmDialog({
    title: "Delete “" + rowLabel(b) + "” permanently?",
    body: [ DELETE_FILE_NOTE, "Disabling it instead takes it out of rotation and can be undone.", "Item id: " + String(b.id) ],
    confirmLabel: "Delete permanently",
    danger: true,
    checkbox: keep
  });
  if (!ok) {
    announce("delete cancelled");
    return null;
  }
  const url = "/api/bumpers/" + encodeURIComponent(b.id) + (keep.checked ? "?keep_file=true" : "");
  let answer;
  try {
    answer = await api(url, {
      method: "DELETE"
    });
  } catch (err) {
    announce("delete failed: " + err.message);
    return null;
  }
  const j = asObject(answer);
  const notify = inspectorOnMutate;
  STATE.library.items = STATE.library.items.filter(row => row.id !== b.id);
  if (typeof STATE.library.total === "number") {
    STATE.library.total = Math.max(0, STATE.library.total - 1);
  }
  renderLibrary();
  renderLibraryState();
  const leftover = j.cleanup_failed ? "deleted, but a hidden quarantine file remains on disk for manual cleanup" : "";
  announce("deleted " + j.kind + " · " + (j.title || b.id) + (j.file_removed ? " (file removed)" : " (file kept)") + (leftover ? " — " + leftover : ""));
  if (STATE.inspector.id === b.id) {
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

async function enableBumper(b) {
  let j;
  try {
    j = asObject(await api("/api/pool/enable?bumper_id=" + encodeURIComponent(b.id), {
      method: "POST"
    }));
  } catch (err) {
    announce("enable failed: " + err.message);
    return null;
  }
  announce("enabled " + rowLabel(b) + (j.changed ? "" : " (already on)") + (j.warning ? " — " + j.warning : ""));
  afterMutation("enable", b.id, {
    enabled: 1
  }, j.warning);
  return j;
}

async function disableBumper(b) {
  let j;
  try {
    j = asObject(await api("/api/pool/disable?bumper_id=" + encodeURIComponent(b.id), {
      method: "POST"
    }));
  } catch (err) {
    announce("disable failed: " + err.message);
    return null;
  }
  announce("disabled " + rowLabel(b) + (j.changed ? "" : " (already off)") + (j.warning ? " — " + j.warning : ""));
  afterMutation("disable", b.id, {
    enabled: 0
  }, j.warning);
  return j;
}

function renderLibraryState() {
  const el = $("#browse-state");
  const lib = STATE.library;
  if (lib.loading) return renderPanelState(el, {
    state: "loading"
  });
  if (lib.error) {
    return renderPanelState(el, readState({
      value: lib.items.length ? lib.items : null,
      error: lib.error,
      updatedAt: lib.updatedAt
    }, () => {
      loadGrid(true);
    }));
  }
  if (!lib.items.length) {
    if (filtersActive()) {
      return renderPanelState(el, {
        state: "empty",
        message: "No rows match the current filter.",
        filtersActive: true,
        actionLabel: "Clear filters",
        onAction: clearFilters
      });
    }
    if (lib.source === "shuffle") {
      return renderPanelState(el, {
        state: "empty",
        message: "the shuffle draw came back with nothing"
      });
    }
    return renderPanelState(el, {
      state: "empty",
      message: "Nothing in the pool yet. Adding material and generating cards " + "are on the Operations view.",
      actionLabel: "Open operations",
      onAction: () => {
        goTo("#/operations");
      }
    });
  }
  return renderPanelState(el, {
    state: "populated"
  });
}

function renderLibrary() {
  fillGrid($("#grid"), STATE.library.items.map(row => cardEl(row, {
    onMutate: markComposerStale
  })));
  applyDensity();
  renderLibraryCounts();
  const more = $("#more");
  if (more) more.hidden = !libraryCounts().hasMore;
}

function libraryParams(offset) {
  const params = new URLSearchParams({
    limit: String(STATE.library.pageSize),
    offset: String(offset)
  });
  const f = STATE.library.filters;
  if (f.kind) params.set("kind", f.kind);
  if (f.type) params.set("type", f.type);
  if (f.state && f.state !== "all") params.set("state", f.state);
  if (f.q) params.set("q", f.q);
  return params;
}

async function loadGrid(reset) {
  const lib = STATE.library;
  const offset = reset ? 0 : lib.offset;
  const generation = ++lib.generation;
  if (libraryAbort) libraryAbort.abort();
  libraryAbort = new AbortController;
  lib.loading = true;
  renderLibraryState();
  let d;
  try {
    d = await api("/api/bumpers?" + libraryParams(offset), {
      signal: libraryAbort.signal
    });
  } catch (err) {
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

function scheduleSearch(value) {
  STATE.library.filters.q = String(value === undefined || value === null ? "" : value).slice(0, MAX_FILTER_TEXT);
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    syncLibraryHash();
    loadGrid(true);
  }, SEARCH_DEBOUNCE_MS);
}

async function shufflePreview() {
  const lib = STATE.library;
  lib.filters.kind = null;
  lib.filters.q = "";
  lib.filters.state = "all";
  const search = $("#search");
  if (search) search.value = "";
  renderFilters();
  const generation = ++lib.generation;
  if (libraryAbort) libraryAbort.abort();
  libraryAbort = new AbortController;
  lib.loading = true;
  renderLibraryState();
  let d;
  try {
    d = await api("/api/bumpers/random?count=" + PAGE, {
      signal: libraryAbort.signal
    });
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

const parsePayload = value => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
};

function formatStamp(seconds, zero) {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!isFinite(n) || n <= 0) return zero === undefined ? NOT_AVAILABLE : zero;
  return new Date(n * 1e3).toISOString().replace("T", " ").slice(0, 19) + " UTC" + " · " + formatAge(n * 1e3);
}

function inspectorBlock(title, rows) {
  const block = makeEl("section", "insp-block");
  block.append(makeEl("h3", "insp-h", title));
  rows.forEach(row => {
    if (row) block.append(row);
  });
  return block;
}

function inspectorPreview(row) {
  const rows = [];
  const payload = parsePayload(row.payload);
  if (row.type === "stream") {
    rows.push(streamPreview(row));
  } else if (row.type === "image" && hasMedia(row)) {
    rows.push(imagePreview(row));
  } else if (hasMedia(row)) {
    rows.push(mediaVideo(row.media_url, "Preview of " + rowLabel(row)));
  }
  const lines = Array.isArray(payload.lines) ? payload.lines.join("\n") : fieldText(payload.text || payload.number || payload.meaning, "");
  if (lines) rows.push(makeEl("pre", "insp-card-text", lines));
  if (payload.answer) rows.push(summaryRow("answer", String(payload.answer)));
  if (!rows.length) rows.push(makeEl("p", "insp-none", "Nothing to preview."));
  return inspectorBlock("Preview", rows);
}

function inspectorIdentity(row) {
  return inspectorBlock("Item", facts([ [ "id", fieldText(row.id) ], [ "title", fieldText(row.title, "untitled") ], [ "type", fieldText(row.type) ], [ "kind", fieldText(row.kind) ], [ "source", fieldText(row.source) ], [ "duration", row.type === "stream" ? "LIVE" : formatDuration(row.duration) ], [ "tags", fieldText(row.tags, "none") ] ]));
}

function inspectorStateBlock(row) {
  const spec = STATE_BADGES[poolState(row)];
  const head = makeEl("div", "summary-row");
  head.append(makeEl("span", "lbl", "pool state"), spec ? statusBadge(spec[0], spec[1]) : makeEl("span", "val", NOT_AVAILABLE));
  return inspectorBlock("State", [ head ].concat(facts([ [ "enabled", yesNo(row.enabled, "yes", "no — parked") ], [ "health", fieldText(row.health) ], [ "rendered", row.type === "card" ? hasMedia(row) ? "yes" : "no — there is no media file yet" : "not a card" ], [ "base weight", num(row.weight) ], [ "failures", num(row.fail_count) ] ])));
}

function inspectorCreative(row) {
  const c = row.creative;
  if (!c || typeof c !== "object") {
    return inspectorBlock("Creative", [ makeEl("p", "insp-none", NOT_AVAILABLE) ]);
  }
  return inspectorBlock("Creative", facts([ [ "family", fieldText(c.family) ], [ "roles", Array.isArray(c.roles) && c.roles.length ? c.roles.map(String).join(", ") : fieldText(c.roles, "none") ], [ "energy", fieldText(c.energy) ], [ "audio", fieldText(c.audio) ], [ "text-heavy", yesNo(c.text_heavy) ], [ "template", fieldText(c.template) ], [ "brand mode", fieldText(c.brand_mode) ] ]));
}

function factorText(factors, key) {
  if (!Object.prototype.hasOwnProperty.call(factors, key)) return NOT_AVAILABLE;
  return factors[key] === null ? "not a number" : String(factors[key]);
}

const gatedTerm = value => value === 0 || value === null;

function factorEquation(factors) {
  const eq = makeEl("div", "insp-eq");
  const term = key => {
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

function zeroGate(factors) {
  const gated = FACTOR_ORDER.filter(key => gatedTerm(factors[key]));
  if (gated.length) {
    return [ statusBadge("attention", "zero gate — " + gated.join(", ")) ].concat(gated.map(key => {
      const token = factors[key] === null ? "non_finite_score" : ZERO_REASON[key];
      return makeEl("p", "insp-note", key + " is " + factorText(factors, key) + ", so the score cannot be positive: " + (token ? own(REASON_TEXT, token) : ZERO_UNNAMED));
    }));
  }
  if (factors.score === null) {
    return [ statusBadge("attention", "gated — " + REASON_TEXT.non_finite_score) ];
  }
  if (factors.score === 0) {
    return [ statusBadge("attention", "zero gate — the score is zero although no single factor this build sent is") ];
  }
  return [];
}

function inspectorSelection(row) {
  const sel = row.selection;
  if (!sel || typeof sel !== "object") {
    return inspectorBlock("Selection", [ makeEl("p", "insp-none", NOT_AVAILABLE) ]);
  }
  const rows = [];
  rows.push(summaryRow("eligible now", sel.eligible_now === undefined ? NOT_AVAILABLE : sel.eligible_now ? "yes" : "no"));
  const reasons = Array.isArray(sel.reasons) ? sel.reasons : [];
  if (reasons.length) {
    const list = makeEl("ul", "insp-reasons");
    reasons.forEach(reason => {
      list.append(makeEl("li", "", own(REASON_TEXT, reason) || String(reason)));
    });
    rows.push(list);
  } else {
    rows.push(summaryRow("reasons", NOT_AVAILABLE));
  }
  const f = sel.factors;
  if (f && typeof f === "object") rows.push(factorEquation(f), ...zeroGate(f)); else rows.push(summaryRow("factors", NOT_AVAILABLE));
  return inspectorBlock("Selection", rows);
}

const joined = values => values.filter(present).map(String).join(" · ") || NOT_AVAILABLE;

const CREDIT_FIELDS = [ [ "music title", "title" ], [ "music creator", "creator" ], [ "music license", "license" ], [ "music attribution", "attribution" ], [ "music source page", "source_page" ], [ "music license URL", "license_url" ], [ "music bed id", "id" ] ];

const BG_FIELDS = [ "bg_creator", "bg_title", "bg_license", "bg_license_url", "bg_source_page" ];

function inspectorProvenance(row) {
  const payload = parsePayload(row.payload);
  const credits = row.music_credits && typeof row.music_credits === "object" ? row.music_credits : null;
  const hasCredits = Boolean(credits) && CREDIT_FIELDS.some(([, key]) => present(credits[key]));
  const rows = facts([ [ "registered source", fieldText(row.source) ], [ "payload source", fieldText(payload.source) ], [ "background", joined([ payload.bg_creator, payload.bg_title, payload.bg_license ]) ], [ "background links", joined([ payload.bg_source_page, payload.bg_license_url ]) ] ].concat(hasCredits ? CREDIT_FIELDS.map(([label, key]) => [ label, fieldText(credits[key], NOT_RECORDED) ]) : [ [ "music", NOT_AVAILABLE ] ]));
  const recorded = [ row.source, payload.source ].concat(BG_FIELDS.map(key => payload[key])).some(present) || hasCredits;
  if (!recorded) {
    rows.unshift(statusBadge("attention", NO_PROVENANCE), makeEl("p", "insp-note", PROVENANCE_NOTE));
  }
  return inspectorBlock("Provenance & rights", rows);
}

function inspectorHistory(row) {
  return inspectorBlock("History", facts([ [ "created", formatStamp(row.created_at) ], [ "last played", formatStamp(row.last_played, "never played") ], [ "play count", num(row.play_count) ] ]));
}

function inspectorMediaUrl(row) {
  if (!hasMedia(row)) {
    return inspectorBlock("Media URL", [ makeEl("p", "insp-none", row.type === "card" ? "No media file yet — render the card to give it one." : NOT_AVAILABLE) ]);
  }
  const built = copyControls("inspector-media-url", "Media URL", row.media_url, {
    read: () => STATE.inspector.copied,
    write: (level, message) => {
      STATE.inspector.copied = {
        level: level,
        message: message
      };
    }
  });
  return inspectorBlock("Media URL", [ labelledControl("inspector-media-url", "Media URL", built.input), built.copy, built.said ]);
}

function inspectorActions(row) {
  const state = poolState(row);
  const rows = [];
  const buttons = makeEl("div", "insp-actions");
  const primary = (label, onClick) => buttons.append(makeButton(label, "insp-primary", onClick));
  const secondary = (label, onClick) => buttons.append(makeButton(label, "insp-secondary mini", onClick));
  if (state === "dead") {
    rows.push(makeEl("p", "insp-note", "There is no per-item recheck. Revive re-examines every retired item in " + "the pool and un-parks only the ones ffprobe can still read; " + "on_this_day cards and live streams are left alone."));
    primary("Run revive (all retired)", () => {
      inspectorJob({
        url: MAINT.revive.url,
        label: "recheck retired",
        kind: "enable",
        id: row.id,
        say: MAINT.revive.say
      });
    });
  } else if (state === "parked") {
    rows.push(makeEl("p", "insp-note", "Enabling is operator intent. A cam no longer in live_cams.yaml is " + "parked again on the next restart, and the rotation can take back a " + "dated card — the server says so in its answer when it applies."));
    primary("Enable", () => {
      enableBumper(row);
    });
  } else if (state === "unrendered") {
    rows.push(makeEl("p", "insp-note", "No media file, so only a browser can play it. Rendering runs offline."));
    primary("Render card", () => {
      inspectorJob({
        url: "/api/render/cards?bumper_id=" + encodeURIComponent(row.id),
        label: "render card " + rowLabel(row),
        kind: "render",
        id: row.id
      });
    });
    secondary("Disable from rotation", () => {
      disableBumper(row);
    });
  } else if (state === "playable") {
    rows.push(makeEl("p", "insp-note", "Takes this out of rotation and nothing else: not its health, not its " + "file, not its history. Enable brings it straight back."));
    primary("Disable from rotation", () => {
      disableBumper(row);
    });
  } else {
    rows.push(makeEl("p", "insp-none", "This response does not say whether the row is enabled, so no action is offered."));
  }
  rows.push(buttons);
  return inspectorBlock("Action", rows);
}

function inspectorDanger(row) {
  const block = inspectorBlock("Danger zone", [ makeEl("p", "insp-note", DELETE_FILE_NOTE) ]);
  block.classList.add("danger-zone");
  block.append(makeButton("Delete permanently", "danger-btn", () => {
    deleteBumper(row);
  }, "Delete " + rowLabel(row) + " permanently"));
  return block;
}

function focusInside(rootSelector) {
  const root = $(rootSelector);
  const active = typeof document !== "undefined" ? document.activeElement : null;
  return Boolean(root && active && root.contains && root.contains(active));
}

function giveBackFocus(held) {
  const title = held && $("#inspector-title");
  if (title && title.focus) title.focus();
}

function renderInspector() {
  const title = $("#inspector-title");
  const body = $("#inspector-body");
  const row = STATE.inspector.value;
  const held = focusInside("#inspector-body");
  if (title) title.textContent = row ? rowLabel(row) : "Item";
  if (!body) return null;
  if (!row) {
    releaseMedia(body);
    body.replaceChildren();
    giveBackFocus(held);
    return body;
  }
  releaseMedia(body);
  body.replaceChildren(inspectorPreview(row), inspectorIdentity(row), inspectorStateBlock(row), inspectorCreative(row), inspectorSelection(row), inspectorProvenance(row), inspectorHistory(row), inspectorMediaUrl(row), inspectorActions(row), inspectorDanger(row));
  giveBackFocus(held);
  return body;
}

function renderInspectorState() {
  const el = $("#inspector-state");
  const insp = STATE.inspector;
  if (insp.busy) return renderJobState(el, "working", insp.busy, []);
  if (insp.notice) return renderJobState(el, "attention", insp.notice, []);
  const id = insp.id;
  return renderPanelState(el, readState(insp, id ? () => {
    loadInspector(id);
  } : undefined));
}

function setInspectorBusy(message) {
  STATE.inspector.busy = message || "";
  const body = $("#inspector-body");
  const held = focusInside("#inspector-body");
  if (body) modalControls(body).forEach(el => {
    el.disabled = Boolean(message);
  });
  if (message) giveBackFocus(held);
  renderInspectorState();
}

async function loadInspector(id) {
  const insp = STATE.inspector;
  const generation = ++inspectorGeneration;
  if (inspectorAbort) inspectorAbort.abort();
  inspectorAbort = new AbortController;
  insp.id = id;
  insp.loading = true;
  renderInspectorState();
  let d;
  try {
    d = await api("/api/bumpers/" + encodeURIComponent(id) + "?explain=true", {
      signal: inspectorAbort.signal
    });
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
        if (inspectorAbort) {
          inspectorAbort.abort();
          inspectorAbort = null;
        }
        inspectorGeneration++;
        releaseMedia($("#inspector-body"));
        const body = $("#inspector-body");
        if (body) body.replaceChildren();
        const state = $("#inspector-state");
        if (state) renderPanelState(state, {
          state: "populated"
        });
      }
    });
  }
  return loadInspector(String(id));
}

function closeInspector() {
  const dialog = $("#inspector");
  if (dialog) closeDialog(dialog);
  return null;
}

async function inspectorJob(options) {
  const {url: url, label: label, kind: kind, id: id, say: say} = options;
  const record = recordJob(label);
  const mine = ++inspectorGeneration;
  const current = () => mine === inspectorGeneration;
  setInspectorBusy(label + "…");
  let r;
  try {
    r = await api(url, {
      method: "POST",
      timeout: 0
    });
  } catch (err) {
    finishJob(record, "error", err.message);
    if (current()) {
      announce("✗ " + label + " failed: " + err.message);
      setInspectorBusy("");
    }
    return null;
  }
  if (r && r.job_id) {
    record.id = String(r.job_id);
    if (!current()) {
      handoffJob(record);
      return r;
    }
    record.polling = true;
    stopJobWatch(record.id);
    r = await watchJob(r, {
      superseded: () => !current(),
      release: () => setInspectorBusy(""),
      working: seconds => {
        if (current()) setInspectorBusy(label + "… (" + seconds + "s)");
      },
      unknown: (message, actions) => {
        if (current()) renderJobState($("#inspector-state"), "attention", message, actions);
      }
    });
    if (!current()) {
      handoffJob(record);
      return r;
    }
    record.polling = false;
  }
  const payload = r && r.result !== undefined ? r.result : r;
  let message;
  try {
    message = say ? String(say(payload)) : typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch (e) {
    message = typeof payload === "string" ? payload : JSON.stringify(payload);
  }
  finishJob(record, r && r.status ? jobOutcome(r.status) : "done", message);
  if (!current()) return r;
  announce(label + ": " + humanMessage(message, "done"));
  setInspectorBusy("");
  if (inspectorOnMutate) inspectorOnMutate(kind, id);
  loadStatus();
  if (STATE.inspector.id === id) await loadInspector(id);
  return r;
}

const COMPOSER_PRESETS = [ 15, 30, 60, 90 ];

const COMPOSER_PLACEMENTS = [ "any", "open", "inside", "close" ];

const COMPOSER_TYPES = [ "video", "card", "image", "stream" ];

const MIN_FILL_SECONDS = .1;

const MAX_FILL_SECONDS = 86400;

const MAX_FILL_TOLERANCE = 3600;

const MAX_FILL_ITEMS = 40;

const COMPOSER_TICK_MS = 1e3;

const RELAXED_TEXT = {
  exit_ident: "The break could not end on a station ident.",
  energy_jump: "Adjacent items jump in energy more than the profile prefers.",
  same_family: "Two adjacent items share a visual family.",
  text_run: "Text-heavy cards run back to back.",
  same_music: "Adjacent items share a music bed."
};

const STALE_TEXT = "Stale — recompose to reflect changes";

let composerAbort = null;

let composerTimer = null;

let composerTick = null;

let composerMedia = null;

let composerHandlers = [];

const composerItems = () => {
  const d = STATE.composer.result;
  return d && Array.isArray(d.bumpers) ? d.bumpers : [];
};

function fillNumber(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return NaN;
  const n = Number(raw);
  return isFinite(n) ? n : NaN;
}

function composerProblems(controls) {
  const c = controls || {};
  const out = {};
  const seconds = fillNumber(c.seconds);
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
  if (types.some(t => COMPOSER_TYPES.indexOf(String(t)) === -1)) {
    out.types = "Only video, card, image and stream can be asked for.";
  }
  return out;
}

function composerParams(controls) {
  const c = controls || {};
  const params = new URLSearchParams;
  params.set("seconds", String(fillNumber(c.seconds)));
  params.set("tolerance", String(fillNumber(c.tolerance)));
  params.set("max_items", String(fillNumber(c.maxItems)));
  params.set("placement", String(c.placement));
  const types = (Array.isArray(c.types) ? c.types : []).filter(t => COMPOSER_TYPES.indexOf(String(t)) !== -1);
  if (types.length) params.set("types", types.join(","));
  params.set("explain", "true");
  return params;
}

function gapLabel(requested, total, exact) {
  const req = fillNumber(requested);
  const tot = fillNumber(total);
  const parts = [ "Requested " + (isFinite(req) ? req.toFixed(1) + "s" : NOT_AVAILABLE), "Composed " + (isFinite(tot) ? tot.toFixed(1) + "s" : NOT_AVAILABLE) ];
  if (isFinite(req) && isFinite(tot)) {
    const gap = Math.round((req - tot) * 10) / 10;
    parts.push("Gap " + (gap < 0 ? "-" : "+") + Math.abs(gap).toFixed(1) + "s");
  } else {
    parts.push("Gap " + NOT_AVAILABLE);
  }
  parts.push(typeof exact === "boolean" ? exact ? "Within tolerance" : "Outside tolerance" : NOT_AVAILABLE);
  return parts.join(" | ");
}

function durationShare(seconds) {
  const n = Number(seconds);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(6, Math.round(n / 5 * 100) / 100));
}

function readComposerControls() {
  const c = STATE.composer;
  const value = sel => {
    const el = $(sel);
    return el ? el.value : "";
  };
  c.seconds = value("#cmp-seconds");
  c.tolerance = value("#cmp-tolerance");
  c.maxItems = value("#cmp-max-items");
  c.placement = value("#cmp-placement");
  c.types = $$("#view-composer [data-cmptype]").filter(box => box.checked).map(box => String(box.dataset.cmptype));
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

function renderComposerControls() {
  const c = STATE.composer;
  const problems = composerProblems(c);
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
  const lines = Object.keys(problems).map(key => problems[key]);
  if (said) {
    said.replaceChildren(...lines.map(line => makeEl("p", "cmp-invalid", line)));
    said.hidden = lines.length === 0;
  }
  const go = $("#cmp-go");
  if (go) go.disabled = lines.length > 0 || c.loading;
  const seconds = fillNumber(c.seconds);
  $$("#view-composer [data-preset]").forEach(button => {
    button.setAttribute("aria-pressed", Number(button.dataset.preset) === seconds ? "true" : "false");
  });
  return said;
}

function timelineItemEl(b, index, count) {
  const row = b && typeof b === "object" ? b : {};
  const cr = row.creative && typeof row.creative === "object" ? row.creative : {};
  const li = makeEl("li", "cmp-item");
  li.dataset.order = String(index + 1);
  li.style.flexGrow = String(durationShare(row.duration));
  const head = makeEl("div", "cmp-head");
  head.append(makeEl("span", "cmp-order", String(index + 1) + " of " + count), makeEl("span", "cmp-dur", row.type === "stream" ? "LIVE" : formatDuration(row.duration)));
  const roles = (Array.isArray(cr.roles) ? cr.roles : []).filter(r => r !== undefined && r !== null && r !== "").map(String);
  li.append(head, makeEl("p", "cmp-title", fieldText(row.title, "untitled")), summaryRow("kind", fieldText(row.kind)), summaryRow("family", fieldText(cr.family)), summaryRow("audio", fieldText(cr.audio)), summaryRow("role", roles.length ? roles.join(", ") : NOT_AVAILABLE), summaryRow("brand mode", fieldText(cr.brand_mode)));
  if (row.id !== undefined && row.id !== null && String(row.id) !== "") {
    const inspect = makeButton("Inspect", "cmp-inspect mini", () => {
      openInspector(row.id, {
        invoker: inspect,
        onMutate: markComposerStale
      });
    }, "Inspect " + rowLabel(row));
    li.append(inspect);
  }
  return li;
}

function renderComposerAttention() {
  const el = $("#composer-attention");
  if (!el) return null;
  const d = STATE.composer.result;
  const composition = d && typeof d.composition === "object" ? d.composition : null;
  const rules = composition && Array.isArray(composition.relaxed_rules) ? composition.relaxed_rules : [];
  el.hidden = rules.length === 0;
  if (!rules.length) {
    el.replaceChildren();
    return el;
  }
  const list = makeEl("ul", "cmp-relax");
  rules.forEach(rule => {
    list.append(makeEl("li", "", own(RELAXED_TEXT, String(rule)) || String(rule)));
  });
  el.replaceChildren(statusBadge("attention", "The profile's rules were relaxed to fill this gap"), list);
  return el;
}

function markComposerStale(kind, id) {
  const c = STATE.composer;
  if (!c.result) return null;
  if (!composerItems().some(row => row && String(row.id) === String(id))) return null;
  c.stale = true;
  stopComposerPlayback();
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
  el.replaceChildren(...stale ? [ statusBadge("attention", STALE_TEXT), makeEl("p", "cmp-note", "An item changed while this break was on screen. Bumparr does not " + "substitute one item for another — press Compose break for a new sequence.") ] : []);
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
    count.textContent = d ? items.length + " item(s), in the order the server composed them." : "";
  }
  renderComposerAttention();
  fillGrid($("#composer-timeline"), items.map((row, at) => timelineItemEl(row, at, items.length)));
  return items.length;
}

function renderComposerState() {
  const el = $("#composer-state");
  const c = STATE.composer;
  if (c.loading) return renderPanelState(el, {
    state: "loading",
    message: c.loadingLabel
  });
  if (!c.error && !c.result) {
    return renderPanelState(el, {
      state: "empty",
      message: "Nothing composed yet — choose a duration and press Compose break."
    });
  }
  if (!c.error && !composerItems().length) {
    return renderPanelState(el, {
      state: "empty",
      message: humanMessage(c.result && c.result.note, "Nothing in the pool fits this break.")
    });
  }
  return renderPanelState(el, readState({
    value: c.result,
    error: c.error,
    updatedAt: c.updatedAt
  }, c.retry || undefined));
}

async function composeBreak() {
  const c = STATE.composer;
  readComposerControls();
  const problems = composerProblems(c);
  if (Object.keys(problems).length) {
    renderComposerControls();
    announce("compose blocked: " + Object.keys(problems).map(k => problems[k]).join(" "));
    return null;
  }
  stopComposerPlayback();
  c.stale = false;
  if (composerAbort) composerAbort.abort();
  composerAbort = new AbortController;
  c.loading = true;
  c.loadingLabel = "composing a " + fillNumber(c.seconds) + "s break…";
  c.retry = () => composeBreak();
  renderComposer();
  let d;
  try {
    d = await api("/api/bumpers/fill?" + composerParams(c).toString(), {
      signal: composerAbort.signal
    });
  } catch (err) {
    c.loading = false;
    if (isApiAbort(err)) {
      renderComposer();
      return null;
    }
    c.error = err.message;
    renderComposer();
    return null;
  }
  c.loading = false;
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

function stagePlayer(b) {
  const row = b && typeof b === "object" ? b : {};
  if (row.type === "stream") return {
    node: streamPreview(row),
    medium: null
  };
  if (row.type === "image" && hasMedia(row)) return {
    node: imagePreview(row),
    medium: null
  };
  if (hasMedia(row) && (row.type === "video" || row.type === "card")) {
    const v = mediaVideo(row.media_url, "Playing " + rowLabel(row));
    return {
      node: v,
      medium: v
    };
  }
  const p = row.payload && typeof row.payload === "object" ? row.payload : {};
  const text = Array.isArray(p.lines) ? p.lines.join("\n") : String(p.number || p.text || row.title || "");
  const card = makeEl("div", "cmp-textcard");
  card.append(makeEl("div", "tc", text));
  return {
    node: card,
    medium: null
  };
}

function releaseComposerStage() {
  if (composerTimer !== null) {
    clearTimeout(composerTimer);
    composerTimer = null;
  }
  if (composerTick !== null) {
    clearInterval(composerTick);
    composerTick = null;
  }
  if (composerMedia && composerMedia.removeEventListener) {
    composerHandlers.forEach(([type, fn]) => {
      composerMedia.removeEventListener(type, fn);
    });
  }
  composerMedia = null;
  composerHandlers = [];
  const stage = $("#composer-stage");
  if (stage) {
    releaseMedia(stage);
    stage.replaceChildren();
  }
  return null;
}

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
  return head + " · " + elapsed + "s elapsed · " + Math.max(0, Math.round(p.duration - p.elapsed)) + "s remaining";
}

function renderComposerPlayback() {
  const c = STATE.composer;
  const p = c.playback;
  const items = composerItems();
  const can = items.length > 0 && !c.stale && !c.loading;
  const set = (sel, disabled) => {
    const el = $(sel);
    if (el) el.disabled = disabled;
  };
  set("#cmp-play", !can);
  set("#cmp-prev", !can);
  set("#cmp-next", !can);
  set("#cmp-stop", p.index < 0);
  const line = $("#cmp-progress");
  if (line) line.textContent = playbackLine();
  const list = $("#composer-timeline");
  Array.from(list && list.children || []).forEach((li, at) => {
    if (at === p.index) li.setAttribute("aria-current", "true"); else li.removeAttribute("aria-current");
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

function startComposerTick() {
  if (composerTick !== null) clearInterval(composerTick);
  composerTick = setInterval(() => {
    const p = STATE.composer.playback;
    if (!p.playing || p.startedAt === null) return;
    p.elapsed = (now() - p.startedAt) / 1e3;
    renderComposerPlayback();
  }, COMPOSER_TICK_MS);
  return composerTick;
}

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
    stage.replaceChildren(makeEl("p", "cmp-stage-label", "Item " + (at + 1) + " of " + items.length + " · " + rowLabel(b)), built.node);
  }
  if (built.medium) {
    composerMedia = built.medium;
    const on = (type, fn) => {
      composerHandlers.push([ type, fn ]);
      composerMedia.addEventListener(type, fn);
    };
    on("ended", () => {
      advanceComposer(1);
    });
    on("error", () => {
      announce("could not play item " + (at + 1) + " of " + items.length + " (" + rowLabel(b) + ") — moving on");
      advanceComposer(1);
    });
    on("stalled", () => {
      announce("still waiting on item " + (at + 1) + " of " + items.length + " — press Next to move on");
    });
    claimMedia(composerMedia);
    if (typeof composerMedia.play === "function") {
      const started = composerMedia.play();
      if (started && started.catch) started.catch(() => {});
    }
  } else if (p.duration > 0) {
    composerTimer = setTimeout(() => {
      composerTimer = null;
      advanceComposer(1);
    }, p.duration * 1e3);
  }
  startComposerTick();
  renderComposerPlayback();
  announce("previewing item " + (at + 1) + " of " + items.length + ": " + rowLabel(b));
  return at;
}

function advanceComposer(delta) {
  const p = STATE.composer.playback;
  const step = Number(delta) < 0 ? -1 : 1;
  const from = p.index < 0 ? step > 0 ? -1 : composerItems().length : p.index;
  return playComposerAt(from + step);
}

const playComposerSequence = () => playComposerAt(0);

function stopComposerSequence() {
  stopComposerPlayback();
  renderComposerPlayback();
  announce("preview stopped");
  return null;
}

function wireComposer() {
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
  };
  const reread = () => {
    readComposerControls();
    renderComposerControls();
  };
  $$("#view-composer [data-preset]").forEach(button => {
    button.addEventListener("click", () => {
      setComposerPreset(button.dataset.preset);
    });
  });
  [ "#cmp-seconds", "#cmp-tolerance", "#cmp-max-items" ].forEach(sel => {
    on(sel, "input", reread);
    on(sel, "change", reread);
  });
  on("#cmp-placement", "change", reread);
  $$("#view-composer [data-cmptype]").forEach(box => {
    box.addEventListener("change", reread);
  });
  on("#cmp-go", "click", () => {
    composeBreak();
  });
  on("#cmp-play", "click", () => {
    playComposerSequence();
  });
  on("#cmp-prev", "click", () => {
    advanceComposer(-1);
  });
  on("#cmp-next", "click", () => {
    advanceComposer(1);
  });
  on("#cmp-stop", "click", () => {
    stopComposerSequence();
  });
  return null;
}

const STATION_MESSAGES = {
  idle: "Idle — no playlist client has requested this channel recently.",
  unavailable: "Unavailable — conform at least one eligible item.",
  slate: "Using slate — all playable candidates are currently gated.",
  ffmpeg: "Cannot conform — ffmpeg is unavailable in the service.",
  playing: "On air — playing a conformed item."
};

const STATION_UNREAD = "Station status unavailable; last successful update was ";

const HLS_CLIENT_NOTE = "Opening the preview is a real playlist client and may advance and report playout.";

const HLS_NO_NATIVE = "Copy the URL and Open in external player (VLC, mpv, IINA): " + "this browser has no native HLS playback, so no preview is offered here.";

const CHANNEL_LEVELS = {
  active: "healthy",
  idle: "attention",
  unavailable: "failed",
  unknown: "offline"
};

function stationRollup(s) {
  if (!s || typeof s !== "object") {
    return {
      level: "offline",
      detail: "the station could not be read"
    };
  }
  const conformed = (s.conformed || 0) + " / " + (s.eligible || 0) + " conformed";
  if (s.ffmpeg === false) {
    return {
      level: "attention",
      detail: "ffmpeg not found: nothing can be conformed"
    };
  }
  const live = s.channels && s.channels.live && s.channels.live.now;
  if (!live) return {
    level: "attention",
    detail: "live channel is off air · " + conformed
  };
  return {
    level: "healthy",
    detail: conformed
  };
}

function stationState(channel, station, meta) {
  if (typeof channel !== "string") return stationRollup(channel);
  const m = meta || {};
  const s = station && typeof station === "object" ? station : null;
  const say = (state, key, level) => ({
    state: state,
    message: STATION_MESSAGES[key],
    level: level || CHANNEL_LEVELS[state] || "attention"
  });
  if (!s) {
    return {
      state: "unknown",
      level: "offline",
      message: STATION_UNREAD + (m.updatedAt ? formatAge(m.updatedAt, m.at) : "never") + "."
    };
  }
  const channels = s.channels && typeof s.channels === "object" ? s.channels : {};
  const ch = channels[channel] && typeof channels[channel] === "object" ? channels[channel] : null;
  if (!ch || typeof ch.state !== "string") {
    return {
      state: "unknown",
      level: "offline",
      message: NOT_AVAILABLE
    };
  }
  if (ch.state === "unavailable") {
    return say("unavailable", s.ffmpeg === false ? "ffmpeg" : "unavailable");
  }
  if (ch.state === "idle") return say("idle", "idle");
  if (ch.state === "active") {
    return ch.reason === "slate" ? say("active", "slate", "attention") : say("active", "playing");
  }
  return {
    state: "unknown",
    level: "offline",
    message: NOT_AVAILABLE
  };
}

function hlsSupported() {
  if (STATE.ops.hls === null) {
    let ok = false;
    try {
      const probe = document.createElement("video");
      ok = typeof probe.canPlayType === "function" && Boolean(probe.canPlayType("application/vnd.apple.mpegurl"));
    } catch (e) {
      ok = false;
    }
    STATE.ops.hls = ok;
  }
  return STATE.ops.hls;
}

function stationNow(s) {
  const channels = s && typeof s === "object" ? s.channels : null;
  return [ "live", "standby" ].map(channel => {
    if (!channels || typeof channels !== "object") {
      return {
        channel: channel,
        level: "offline",
        detail: "the station could not be read"
      };
    }
    const now_ = (channels[channel] || {}).now;
    if (!now_ || typeof now_ !== "object") {
      return {
        channel: channel,
        level: "attention",
        detail: "off air"
      };
    }
    const left = Math.max(0, Math.round((now_.ends_at || 0) - Date.now() / 1e3));
    const kind = now_.kind == null ? "" : String(now_.kind);
    return {
      channel: channel,
      level: "healthy",
      detail: String(now_.title == null ? "" : now_.title) + (kind ? " · " + kind : "") + " · " + left + "s left"
    };
  });
}

function copyField(key, label, value) {
  const row = makeEl("div", "station-url");
  if (value === undefined || value === null || value === "") {
    row.append(makeEl("span", "lbl", label), makeEl("span", "val", NOT_AVAILABLE));
    return row;
  }
  const id = "station-url-" + key;
  const built = copyControls(id, label, value, {
    read: () => STATE.ops.copied && STATE.ops.copied.key === key ? STATE.ops.copied : null,
    write: (level, message) => {
      STATE.ops.copied = {
        key: key,
        level: level,
        message: message
      };
    }
  }, {
    saidClass: "st-copy",
    copyClass: "st-copy-btn mini"
  });
  const caption = makeEl("label", "lbl", label);
  caption.setAttribute("for", id);
  row.append(caption, built.input, built.copy, built.said);
  return row;
}

function formatClock(seconds) {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!isFinite(n) || n <= 0) return NOT_AVAILABLE;
  return new Date(n * 1e3).toISOString().slice(11, 19) + " UTC";
}

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
  box.append(STATE.ops.preview === name ? makeButton("Close preview", "st-open mini", () => {
    closeStationPreview();
  }, "Close the " + name + " channel preview") : makeButton("Open preview", "st-open mini", () => {
    openStationPreview(name, url);
  }, "Open a preview of the " + name + " channel"));
  return box;
}

function channelEl(name, s, meta) {
  const ch = (s && s.channels || {})[name] || {};
  const box = makeEl("section", "station-ch");
  const verdict = stationState(name, s, meta);
  box.append(makeEl("h4", "station-ch-name", name), statusBadge(verdict.level, verdict.message));
  const playing = ch.now && typeof ch.now === "object" ? ch.now : null;
  const left = playing ? Math.max(0, Math.round((playing.ends_at || 0) - Date.now() / 1e3)) : 0;
  const row = makeEl("div", "station-row");
  row.append(makeEl("span", "lbl", "now"));
  if (playing) {
    row.append(makeEl("span", "now", String(playing.title == null ? "" : playing.title) + " (" + String(playing.kind == null ? "" : playing.kind) + ", " + left + "s left)"));
  } else {
    row.append(makeEl("span", "now muted", "off air"));
  }
  box.append(row);
  const next = ch.next && typeof ch.next === "object" ? ch.next : null;
  const nextRow = makeEl("div", "station-row");
  nextRow.append(makeEl("span", "lbl", "next"), next ? makeEl("span", "next", String(next.title == null ? "" : next.title) + (next.kind == null || next.kind === "" ? "" : " (" + String(next.kind) + ")")) : makeEl("span", "next muted", "nothing scheduled"));
  box.append(nextRow);
  box.append(summaryRow("on air", playing ? formatClock(playing.started_at) + " → " + formatClock(playing.ends_at) : "nothing scheduled"), summaryRow("remaining", playing ? formatDuration(left) : "nothing scheduled"), summaryRow("last playlist request", ch.last_playlist_request === undefined ? NOT_AVAILABLE : ch.last_playlist_request === null ? "no client has asked yet" : formatAge(Number(ch.last_playlist_request) * 1e3, meta && meta.at)), summaryRow("lookahead", typeof ch.lookahead_seconds === "number" ? formatDuration(ch.lookahead_seconds) : NOT_AVAILABLE));
  box.append(channelPreview(name, (s && s.urls || {})[name]));
  return box;
}

function stationEl(s, meta) {
  const root = makeEl("div", "station-body");
  const state = stationState(s);
  root.append(statusBadge(state.level, state.detail));
  root.append(channelEl("live", s, meta), channelEl("standby", s, meta));
  const urls = s && s.urls || {};
  const block = makeEl("div", "station-urls");
  block.append(makeEl("h4", "station-ch-name", "Handoff URLs"));
  [ [ "Channel M3U", "channel_m3u" ], [ "Guide XMLTV", "guide_xml" ], [ "Live HLS", "live" ], [ "Standby HLS", "standby" ] ].forEach(([label, key]) => block.append(copyField(key, label, urls[key])));
  root.append(block);
  root.append(makeEl("div", "muted", (s && s.conformed || 0) + " / " + (s && s.eligible || 0) + " conformed" + (s && s.ffmpeg === false ? " · ffmpeg not found" : "")));
  return root;
}

function conformEl(s) {
  const box = makeEl("div", "conform-body");
  if (!s || typeof s !== "object") {
    box.append(makeEl("p", "panel-state-msg", "No conform figures — the station body has not been read."));
    return box;
  }
  box.append(summaryRow("ffmpeg", s.ffmpeg === false ? "not found" : s.ffmpeg === true ? "found" : NOT_AVAILABLE), summaryRow("conformed", (s.conformed || 0) + " / " + (s.eligible || 0)), summaryRow("pending", typeof s.pending === "number" ? String(s.pending) : NOT_AVAILABLE));
  if (s.ffmpeg === false) box.append(statusBadge("failed", STATION_MESSAGES.ffmpeg));
  const sweep = s.last_conform;
  if (sweep === undefined) {
    box.append(summaryRow("last sweep", NOT_AVAILABLE));
  } else if (sweep === null || typeof sweep !== "object") {
    box.append(summaryRow("last sweep", "no sweep has finished in this service yet"));
  } else {
    box.append(summaryRow("last sweep", formatAge(Number(sweep.at) * 1e3)), summaryRow("last sweep result", [ [ "conformed", sweep.conformed ], [ "failed", sweep.failed ], [ "pruned", sweep.pruned ], [ "skipped", sweep.skipped ] ].map(([k, v]) => k + " " + (typeof v === "number" ? v : "?")).join(" · ") + (sweep.ffmpeg === false ? " · ffmpeg was missing" : "")));
  }
  return box;
}

function keepPreviewFocus(held, label) {
  if (!held) return null;
  const next = $$("#station .st-open").find(b => b.textContent === label);
  if (next && next.focus) next.focus();
  return next;
}

function openStationPreview(name, url) {
  const box = $("#station-preview");
  if (!box) return null;
  const held = focusInside("#station");
  const video = mediaVideo(url, name + " channel preview", "none");
  const wrap = makeEl("div", "st-preview");
  wrap.append(makeEl("h4", "station-ch-name", name + " preview"), makeEl("p", "note", HLS_CLIENT_NOTE), video);
  box.replaceChildren(wrap);
  STATE.ops.preview = name;
  claimMedia(video);
  announce("preview opened for the " + name + " channel — this page is now a " + "playlist client of it");
  renderStation();
  keepPreviewFocus(held, "Close preview");
  return video;
}

function closeStationPreview() {
  const box = $("#station-preview");
  const had = STATE.ops.preview;
  const held = focusInside("#station");
  STATE.ops.preview = null;
  if (box) {
    releaseMedia(box);
    box.replaceChildren();
  }
  if (had) {
    renderStation();
    keepPreviewFocus(held, "Open preview");
  }
  return null;
}

const STATION_STATE_REGIONS = [ "#station-state", "#ov-station-state" ];

function renderStationState() {
  const st = STATE.station;
  const opts = st.loading && !st.value ? {
    state: "loading"
  } : readState(st, () => {
    loadStation();
  });
  let rendered = null;
  STATION_STATE_REGIONS.forEach(sel => {
    rendered = renderPanelState($(sel), opts) || rendered;
  });
  return rendered;
}

function configGroup(title, badge, rows, absent) {
  const group = makeEl("div", "cfg-group");
  const head = makeEl("div", "summary-row");
  head.append(makeEl("span", "lbl", title), badge || makeEl("span", "val", absent || NOT_AVAILABLE));
  group.append(head, ...rows || []);
  return group;
}

function stationConfigGroups(status) {
  const s = status && typeof status === "object" ? status : {};
  const group = (title, part, pairs) => part && typeof part === "object" ? configGroup(title, statusBadge(configLevel(part), configSay(part)), facts(pairs(part))) : configGroup(title, null, []);
  const mem = s.memory && typeof s.memory === "object" ? s.memory : null;
  const msgs = mem && mem.messages && typeof mem.messages === "object" ? mem.messages : null;
  const kinds = mem && Array.isArray(mem.enabled_kinds) ? mem.enabled_kinds : null;
  return [ group("channel profile", s.profile, p => [ [ "source", fieldText(p.source) ], [ "version", num(p.version) ], [ "valid", yesNo(p.valid) ] ]), group("music manifest", s.music, m => [ [ "source", fieldText(m.source) ], [ "version", num(m.version) ], [ "valid", yesNo(m.valid) ], [ "enabled beds", num(m.enabled_beds) ], [ "compatibility", yesNo(m.compatibility, "yes — beds outside the manifest are allowed", "no — manifest only") ] ]), mem ? configGroup("channel memory", statusBadge(msgs ? configLevel(msgs) : "healthy", kinds ? kinds.length ? kinds.length + " memory kind" + (kinds.length === 1 ? "" : "s") + " enabled" : "no memory kinds enabled" : "kinds not reported"), facts([ [ "refresh", mem.refresh_seconds === 0 ? "off — memory is not refreshed" : present(mem.refresh_seconds) ? String(mem.refresh_seconds) + "s" : NOT_AVAILABLE ], [ "kinds", kinds ? kinds.length ? kinds.map(String).join(", ") : "none" : NOT_AVAILABLE ], [ "history channel", fieldText(mem.channel) ], [ "operator messages", msgs ? configSay(msgs) : NOT_AVAILABLE ], [ "messages enabled", msgs ? num(msgs.enabled) + " of " + num(msgs.total) : NOT_AVAILABLE ] ])) : configGroup("channel memory", null, []) ];
}

function renderStationConfig() {
  const el = $("#station-config");
  const gap = statusGap();
  if (el) {
    el.replaceChildren(makeEl("p", "note", FILE_OWNED), ...gap ? CONFIG_FILES.map(name => configGroup(name, null, [], gap)) : stationConfigGroups(STATE.status.value), summaryRow("last read", STATE.status.updatedAt ? formatAge(STATE.status.updatedAt) : "not read yet"));
  }
  return renderPanelState($("#station-config-state"), STATE.status.loading && !STATE.status.value ? {
    state: "loading"
  } : readState(STATE.status, () => {
    loadStatus();
  }));
}

const stationMeta = () => ({
  updatedAt: STATE.station.updatedAt
});

function renderStation() {
  const el = $("#station");
  if (el) {
    if (STATE.station.value) {
      el.replaceChildren(stationEl(STATE.station.value, stationMeta()));
    } else if (STATE.station.error) {
      el.replaceChildren(statusBadge("offline", stationState("live", null, stationMeta()).message));
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
  const controller = new AbortController;
  stationAbort = controller;
  STATE.station.loading = true;
  renderStationState();
  let s;
  try {
    s = await api("/api/station", {
      signal: controller.signal
    });
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

const TIDY_SAY = j => (j.dry_run ? "would remove " : "removed ") + j.zero_byte_files + " empty file(s), " + j.empty_dirs + " empty dir(s)";

const REVIVE_SAY = j => j.restored + (j.dry_run ? " restorable" : " restored") + ", " + j.still_dead + " still unplayable, " + j.skipped_streams + " stream(s) skipped";

const MAINT = {
  "tidy-dry": {
    url: "/api/pool/tidy?dry_run=true",
    label: "preview tidy",
    say: TIDY_SAY
  },
  tidy: {
    url: "/api/pool/tidy",
    label: "tidy up",
    say: TIDY_SAY
  },
  "revive-dry": {
    url: "/api/pool/revive?dry_run=true",
    label: "preview recheck",
    say: REVIVE_SAY
  },
  revive: {
    url: "/api/pool/revive",
    label: "recheck retired",
    say: REVIVE_SAY
  }
};

const PREP = {
  render: {
    url: "/api/render/cards",
    label: "render cards"
  },
  conform: {
    url: "/api/station/conform",
    label: "station conform"
  }
};

const STARTER_NOTE = "This downloads clips from the stock and archive sources " + "using your own API keys. It can take several minutes and is deliberately " + "paced so the archives do not throttle you, and nothing on this page undoes it.";

const JOB_STOPPED = "stopped checking — the job may still be running";

const JOB_FORGOTTEN = "status unknown: the server no longer tracks this job";

const JOB_LEVELS = {
  working: "working",
  done: "healthy",
  error: "failed",
  unknown: "attention"
};

const jobLevel = status => own(JOB_LEVELS, status) || "attention";

const JOB_STATUSES = [ "working", "done", "error", "unknown" ];

const RETRY_ACTIONS = {
  "station conform": {
    url: "/api/station/conform"
  },
  "capture-windows": {
    url: "/api/sources/capture-windows"
  },
  "fetch-queue": {
    url: "/api/sources/fetch-queue"
  },
  "render cards": {
    url: "/api/render/cards"
  },
  "preview tidy": {
    url: MAINT["tidy-dry"].url,
    say: TIDY_SAY
  },
  "tidy up": {
    url: MAINT.tidy.url,
    say: TIDY_SAY
  },
  "preview recheck": {
    url: MAINT["revive-dry"].url,
    say: REVIVE_SAY
  },
  "recheck retired": {
    url: MAINT.revive.url,
    say: REVIVE_SAY
  }
};

const GENERATE_LABEL = /^generate ([a-z_]{1,40})$/;

function jobRetry(job) {
  if (!job || typeof job !== "object") return null;
  if (job.retry) return job.retry;
  const label = String(job.label === undefined || job.label === null ? "" : job.label);
  if (Object.prototype.hasOwnProperty.call(RETRY_ACTIONS, label)) {
    return Object.assign({
      label: label
    }, RETRY_ACTIONS[label]);
  }
  const gen = GENERATE_LABEL.exec(label);
  if (gen) return {
    url: "/api/generate/" + gen[1] + "?n=20",
    label: label
  };
  return null;
}

function jobResultText(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch (e) {
    return String(result);
  }
}

function rawResult(value) {
  const text = jobResultText(value);
  return text.length > 2e3 ? text.slice(0, 2e3) + "…" : text;
}

const stampMs = seconds => {
  const n = Number(seconds);
  return isFinite(n) && n > 0 ? n * 1e3 : null;
};

function recordJob(label, retry) {
  const at = now();
  const name = String(label);
  const record = {
    id: "page-" + ++jobSeq,
    label: name,
    status: "working",
    startedAt: at,
    updatedAt: at,
    result: "",
    polling: false,
    retry: retry === undefined ? jobRetry({
      label: name
    }) : retry
  };
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

const recentJobs = (items, limit) => (Array.isArray(items) ? items : []).slice(0, limit || RECENT_JOBS);

function mergeJobs(client, server) {
  const rows = [];
  const at = new Map;
  const push = row => {
    const seen = at.get(row.id);
    if (seen === undefined) {
      at.set(row.id, rows.length);
      rows.push(row);
      return;
    }
    const previous = rows[seen];
    const staleWorking = row.status === "working" && (previous.status === "done" || previous.status === "error");
    const next = staleWorking ? Object.assign({}, row, {
      status: previous.status,
      result: previous.result,
      updatedAt: previous.updatedAt
    }) : row;
    rows[seen] = Object.assign({}, previous, next, {
      label: next.label || previous.label,
      retry: next.retry || previous.retry,
      source: "both"
    });
  };
  (Array.isArray(client) ? client : []).forEach(job => {
    if (!job || typeof job !== "object") return;
    push({
      id: String(job.id),
      label: String(job.label),
      status: job.status,
      createdAt: job.startedAt,
      updatedAt: job.updatedAt,
      result: jobResultText(job.result),
      retry: job.retry || null,
      source: "page"
    });
  });
  (Array.isArray(server) ? server : []).forEach(job => {
    if (!job || typeof job !== "object") return;
    if (job.id === undefined || job.id === null || String(job.id) === "") return;
    push({
      id: String(job.id),
      label: String(job.request === undefined || job.request === null ? "" : job.request),
      status: JOB_STATUSES.indexOf(job.status) === -1 ? "unknown" : job.status,
      createdAt: stampMs(job.created_at),
      updatedAt: stampMs(job.updated_at),
      result: jobResultText(job.result),
      source: "server"
    });
  });
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

const jobsList = () => mergeJobs(STATE.jobs.items, STATE.jobs.server);

function jobRowEl(job, opts) {
  const options = opts || {};
  const li = makeEl("li", "jobrow");
  li.append(statusBadge(jobLevel(job.status), job.label));
  li.append(makeEl("span", "jobrow-age", "started " + formatAge(job.createdAt, options.at) + " · updated " + formatAge(job.updatedAt, options.at)));
  const result = jobResultText(job.result);
  if (result && options.details) {
    const box = makeEl("details", "jobrow-details");
    box.append(makeEl("summary", "", job.status === "error" ? "error" : "result"), makeEl("pre", "jobrow-result", rawResult(result)));
    li.append(box);
  } else if (result) {
    li.append(makeEl("span", "jobrow-result", humanMessage(result, "")));
  }
  const note = own(STATE.ops.jobNotes, job.id) || own(STATE.ops.stoppedJobs, job.id);
  if (note) {
    li.append(statusBadge("attention", String(note)));
    const watch = JOB_WATCH.get(job.id);
    if (watch && watch.check || own(STATE.ops.stoppedJobs, job.id)) {
      const check = makeButton("Check now", "jobrow-check mini", () => {
        if (watch && watch.check) watch.check(); else resumeJobWatch(job.id);
      }, "Check the status of " + job.label + " now");
      check.dataset.jobId = String(job.id);
      li.append(check);
    }
  }
  if (options.retry && job.status !== "working") {
    const again = jobRetry(job);
    if (again) {
      const button = makeButton("Retry", "jobrow-retry mini", () => {
        doAction(again.url, again.label, {
          say: again.say,
          retry: again
        });
      }, "Run " + again.label + " again");
      button.dataset.jobKey = again.label;
      button.disabled = Boolean(own(STATE.ops.running, again.label));
      li.append(button);
    }
  }
  return li;
}

function renderJobsState(el, count) {
  if (!el) return null;
  const j = STATE.jobs;
  const opts = readState({
    value: j.updatedAt ? j.server : null,
    error: j.error,
    updatedAt: j.updatedAt
  }, () => {
    loadJobs();
  });
  if (opts.state === "error" && count) {
    return renderPanelState(el, {
      state: "error",
      message: "Showing only the jobs this page started — " + String(j.error),
      onAction: () => {
        loadJobs();
      }
    });
  }
  if (opts.state === "stale" || opts.state === "error") {
    return renderPanelState(el, opts);
  }
  if (count) return renderPanelState(el, {
    state: "populated"
  });
  return renderPanelState(el, {
    state: "empty",
    message: j.updatedAt ? "No jobs — the server's registry is empty." : "No jobs started from this page, and the server's list has not been read yet."
  });
}

function renderJobs(at) {
  const items = recentJobs(jobsList());
  const list = $("#jobs-list");
  if (list) list.replaceChildren(...items.map(job => jobRowEl(job, {
    at: at
  })));
  renderJobsState($("#jobs-state"), items.length);
  return renderOpsJobs(at);
}

function renderOpsJobs(at) {
  const items = jobsList();
  const list = $("#ops-jobs-list");
  if (list) {
    list.replaceChildren(...items.map(job => jobRowEl(job, {
      at: at,
      details: true,
      retry: true
    })));
  }
  return renderJobsState($("#ops-jobs-state"), items.length);
}

async function loadJobs() {
  if (jobsAbort) jobsAbort.abort();
  const controller = new AbortController;
  jobsAbort = controller;
  STATE.jobs.loading = true;
  let body;
  try {
    body = await api("/api/jobs?limit=" + MAX_JOBS, {
      signal: controller.signal
    });
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
  STATE.jobs.server.forEach(job => {
    if (job && job.id !== undefined && job.id !== null && job.status !== "working") {
      delete STATE.ops.stoppedJobs[String(job.id)];
    }
  });
  STATE.jobs.updatedAt = now();
  renderJobs();
  renderWarnings();
  renderChrome();
  syncJobWatches();
  return body;
}

const JOB_WATCH = new Map;

function interruptiblePause() {
  let wake = null;
  return {
    wait: ms => new Promise(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    }),
    wake: () => {
      if (wake) wake();
    }
  };
}

function noteJob(id, message) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const held = Boolean(active && active.dataset && active.dataset.jobId === String(id) && String(active.className).split(" ").indexOf("jobrow-check") !== -1);
  STATE.ops.jobNotes[id] = message;
  renderJobs();
  if (held) {
    const next = $$(".jobrow-check").find(b => b.dataset.jobId === String(id));
    if (next && next.focus) next.focus();
  }
  return null;
}

function refreshAfterJob() {
  loadStatus();
  if (STATE.route === "library") loadGrid(true);
  loadStation();
  return null;
}

function applyJobResult(id, final) {
  const answer = final && typeof final === "object" ? final : {};
  const text = rawResult(answer.result === undefined ? answer : answer.result);
  delete STATE.ops.jobNotes[id];
  delete STATE.ops.stoppedJobs[id];
  const record = STATE.jobs.items.find(r => String(r.id) === id);
  if (record) finishJob(record, jobOutcome(answer.status), text);
  const row = STATE.jobs.server.find(r => r && String(r.id) === id);
  if (row) {
    row.status = jobOutcome(answer.status);
    row.result = text;
    row.updated_at = now() / 1e3;
  }
  const ask = STATE.ops.ask;
  if (!ask.busy && !ask.level && ask.job && String(ask.job.id) === String(id)) {
    renderAsk();
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
    stop: () => {
      stopped = true;
      paused.wake();
    },
    check: paused.wake
  };
  JOB_WATCH.set(id, entry);
  const settle = final => {
    if (JOB_WATCH.get(id) === entry) JOB_WATCH.delete(id);
    if (stopped) return null;
    return applyJobResult(id, final);
  };
  return pollJob({
    job_id: id,
    status: "working"
  }, undefined, paused.wait, {
    stopped: () => stopped,
    onUnknown: message => {
      noteJob(id, message);
    }
  }).then(settle, err => settle({
    status: "unknown",
    result: err.message
  }));
}

function syncJobWatches() {
  if (STATE.route !== "operations") return null;
  jobsList().forEach(job => {
    if (job.status !== "working") return;
    if (own(STATE.ops.stoppedJobs, job.id)) return;
    if (job.id.indexOf("page-") === 0) return;
    const owner = STATE.jobs.items.find(r => String(r.id) === job.id);
    if (owner && owner.polling) return;
    watchListedJob(job.id);
  });
  return null;
}

function handoffJob(record) {
  if (!record) return null;
  record.polling = false;
  if (STATE.route === "operations" && String(record.id).indexOf("page-") !== 0) {
    syncJobWatches();
  }
  return null;
}

function resumeJobWatch(id) {
  delete STATE.ops.stoppedJobs[id];
  syncJobWatches();
  renderJobs();
  return null;
}

function stopJobWatches() {
  JOB_WATCH.forEach(entry => entry.stop());
  JOB_WATCH.clear();
  STATE.ops.jobNotes = {};
  STATE.ops.stoppedJobs = {};
  return null;
}

function stopJobWatch(id) {
  const entry = JOB_WATCH.get(id);
  if (entry) {
    entry.stop();
    JOB_WATCH.delete(id);
  }
  return null;
}

const ACTION_REGIONS = {
  station: "#conform-state"
};

const activeActionRegion = () => own(ACTION_REGIONS, STATE.route) || "#actions-state";

function renderActionLocks() {
  $$("[data-job-key]").forEach(button => {
    button.disabled = Boolean(own(STATE.ops.running, button.dataset.jobKey));
  });
  return null;
}

function lockAction(label, held) {
  const key = String(label);
  const at = own(STATE.ops.running, key) || 0;
  if (held) STATE.ops.running[key] = at + 1; else if (at <= 1) delete STATE.ops.running[key]; else STATE.ops.running[key] = at - 1;
  renderActionLocks();
  return STATE.ops.running;
}

const jobOutcome = status => status === "error" ? "error" : status === "unknown" ? "unknown" : "done";

async function pollJob(job, getStatus = async jobId => api("/api/request/" + encodeURIComponent(jobId)), pause, hooks = {}) {
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
    if (stopped()) return {
      status: "unknown",
      result: JOB_STOPPED
    };
    elapsed += delay;
    try {
      current = await getStatus(jobId);
      delay = JOB_POLL_MS;
      if (current && current.status === "working" && hooks.onWorking) {
        hooks.onWorking(Math.round(elapsed / 1e3));
      }
    } catch (err) {
      if (err && err.status === 404) return {
        status: "unknown",
        result: JOB_FORGOTTEN
      };
      delay = JOB_BACKOFF_MS;
      const message = "status unknown (" + err.message + ") — the job may still be running; checking again in 10s";
      if (hooks.onUnknown) hooks.onUnknown(message); else announce(message);
    }
    if (stopped()) return {
      status: "unknown",
      result: JOB_STOPPED
    };
  }
  return current;
}

function watchJob(job, view) {
  const id = job && job.job_id !== undefined && job.job_id !== null ? String(job.job_id) : "";
  let stopped = false;
  const paused = interruptiblePause();
  const entry = {
    stop: () => {
      stopped = true;
      paused.wake();
    },
    check: paused.wake
  };
  if (id) JOB_WATCH.set(id, entry);
  const escapes = [ {
    label: "Check now",
    onClick: paused.wake
  }, {
    label: "Stop checking",
    onClick: () => {
      if (id) STATE.ops.stoppedJobs[id] = JOB_STOPPED;
      entry.stop();
    }
  } ];
  const release = () => {
    if (id && JOB_WATCH.get(id) === entry) JOB_WATCH.delete(id);
  };
  return pollJob(job, undefined, paused.wait, {
    stopped: () => stopped || (view.superseded ? view.superseded() : false),
    onWorking: seconds => view.working(seconds),
    onUnknown: message => {
      view.release();
      view.unknown(message, escapes);
    }
  }).then(final => {
    release();
    return final;
  }, err => {
    release();
    throw err;
  });
}

function wireMaintenance() {
  $$("[data-maint]").forEach(b => b.addEventListener("click", () => {
    const m = own(MAINT, b.dataset.maint);
    return m ? doAction(m.url, m.label, {
      say: m.say
    }) : null;
  }));
  $$("[data-prep]").forEach(b => b.addEventListener("click", () => {
    const p = own(PREP, b.dataset.prep);
    return p ? doAction(p.url, p.label) : null;
  }));
  $$("[data-starter]").forEach(b => b.addEventListener("click", async () => {
    if (b.dataset.starter === "dry") {
      return doAction("/api/starter?dry_run=true", "check starter", {
        retry: null
      });
    }
    const go = await confirmDialog({
      title: "Run the starter seeds?",
      body: [ STARTER_NOTE ],
      confirmLabel: "Seed the pool",
      cancelLabel: "Cancel"
    });
    if (!go) return null;
    return doAction("/api/starter?dry_run=false", "run starter", {
      retry: null
    });
  }));
}

async function doAction(url, label, opts) {
  const options = opts || {};
  const state = $(options.region || activeActionRegion());
  const mine = ++actionGeneration;
  const record = recordJob(label, options.retry);
  const current = () => mine === actionGeneration;
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
    let r = await api(url, {
      method: "POST",
      timeout: 0
    });
    const synchronous = !r || !r.job_id;
    if (!synchronous) {
      record.id = String(r.job_id);
      if (!current()) {
        handoffJob(record);
        release();
        if (STATE.route === "operations") loadJobs();
        return null;
      }
      record.polling = true;
      stopJobWatch(record.id);
      r = await watchJob(r, {
        superseded: () => !current(),
        release: release,
        working: seconds => {
          if (current()) renderJobState(state, "working", label + "… (" + seconds + "s)", []);
        },
        unknown: (message, actions) => {
          if (current()) renderJobState(state, "attention", message, actions);
        }
      });
      record.polling = false;
      if (!current()) {
        handoffJob(record);
        release();
        refreshAfterJob();
        if (STATE.route === "operations") loadJobs();
        return null;
      }
    }
    const result = r && r.result !== undefined ? r.result : r;
    let msg = jobResultText(result);
    if (synchronous && options.say) {
      try {
        msg = String(options.say(r));
      } catch (e) {}
    }
    const status = r && r.status !== undefined ? r.status : "done";
    const mark = status === "error" ? "✗ " : status === "unknown" ? "▲ " : "✓ ";
    finishJob(record, jobOutcome(status), msg);
    if (current()) {
      announce(mark + label + ": " + msg.trim().split("\n").slice(-2).join(" ") + (status === "unknown" ? " — run it again to check" : ""));
    }
  } catch (err) {
    record.polling = false;
    const capacity = err.status === 429;
    finishJob(record, "error", err.message);
    if (current()) {
      announce((capacity ? "▲ " : "✗ ") + label + (capacity ? " not started: " + err.message + " — try again in a moment" : " failed: " + err.message));
    }
  }
  release();
  if (current()) renderPanelState(state, {
    state: "populated"
  });
  refreshAfterJob();
  if (STATE.route === "operations") loadJobs();
}

const ASK_WORKING = "downloads and captures can take a bit";

const ASK_RUNNING = "still running — follow it in Recent jobs";

const ASK_OUTCOMES = {
  done: "healthy",
  error: "failed",
  unknown: "attention"
};

function askRegistryLine(job) {
  if (!job) return null;
  const row = jobsList().find(r => String(r.id) === String(job.id));
  if (!row) return null;
  if (row.status === "working") return {
    level: "working",
    message: ASK_RUNNING
  };
  return {
    level: own(ASK_OUTCOMES, row.status) || "attention",
    message: humanMessage(row.result, row.status)
  };
}

function renderAsk() {
  const inp = $("#ask"), btn = $("#ask-go"), out = $("#ask-result");
  const ask = STATE.ops.ask;
  if (btn) btn.disabled = ask.busy;
  if (inp) inp.disabled = ask.busy;
  if (!out || ask.busy) return out || null;
  const line = ask.level ? ask : askRegistryLine(ask.job);
  out.replaceChildren(...line ? [ statusBadge(line.level, line.message) ] : []);
  return out;
}

function holdAsk(record) {
  STATE.ops.ask = {
    busy: true,
    job: record,
    level: "working",
    message: ASK_WORKING
  };
  const out = $("#ask-result");
  if (out) out.replaceChildren(statusBadge("working", ASK_WORKING));
  return renderAsk();
}

function releaseAsk(level, message) {
  const ask = STATE.ops.ask;
  ask.busy = false;
  ask.level = level || "";
  ask.message = message || "";
  return renderAsk();
}

async function submitAsk() {
  const inp = $("#ask"), out = $("#ask-result");
  const text = inp.value.trim();
  if (!text) return;
  const mine = ++askGeneration;
  const current = () => mine === askGeneration;
  const record = recordJob("add: " + text.slice(0, 60), null);
  holdAsk(record);
  const finish = (level, msg) => {
    finishJob(record, level === "healthy" ? "done" : level === "attention" ? "unknown" : "error", msg);
    if (!current()) return;
    releaseAsk(level, msg);
    announce(msg);
    if (inp.focus) inp.focus();
    loadStatus();
    loadGrid(true);
  };
  let job;
  try {
    job = await api("/api/request", {
      method: "POST",
      timeout: 0,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: text
      })
    });
  } catch (err) {
    return finish(err.status === 429 ? "attention" : "failed", err.status === 429 ? err.message + " — your text is still here, try again" : err.message);
  }
  if (!job.job_id) return finish(job.status === "error" ? "failed" : "healthy", job.result || "done");
  record.id = String(job.job_id);
  if (!current()) {
    handoffJob(record);
    return null;
  }
  stopJobWatch(record.id);
  record.polling = true;
  inp.value = "";
  const final = await watchJob(job, {
    superseded: () => !current(),
    release: () => {
      if (current()) {
        STATE.ops.ask.busy = false;
        renderAsk();
      }
    },
    working: seconds => {
      if (current()) renderJobState(out, "working", "working on it… (" + seconds + "s)", []);
    },
    unknown: (message, actions) => {
      if (current()) renderJobState(out, "attention", message, actions);
    }
  });
  record.polling = false;
  if (!current()) {
    handoffJob(record);
    return null;
  }
  finish(final.status === "done" ? "healthy" : final.status === "unknown" ? "attention" : "failed", final.result || "done");
}

function enterGeneration() {
  // The global header is shared chrome, so a deep generation link hydrates it.
  return Promise.all([ ensureStatus(), loadGeneration().catch(e => genMessage(e.message)) ]);
}

function exitGeneration() {
  ++GEN_LOAD_VERSION;
  ++GEN_ACTION_VERSION;
  stopGenerationPoll();
}

function stopGenerationPoll() {
  if (GEN_TIMER) {
    clearTimeout(GEN_TIMER);
    GEN_TIMER = null;
  }
}

function genBody() {
  const model = $("#gen-model") && $("#gen-model").value;
  return {
    model: model,
    output: "video",
    mode: "text",
    prompt: $("#gen-brief") && $("#gen-brief").value || "",
    duration: Number($("#gen-duration") && $("#gen-duration").value),
    resolution: $("#gen-resolution") && $("#gen-resolution").value || undefined,
    ratio: "16:9",
    creative: {
      roles: [ "inside" ],
      energy: $("#gen-energy") && $("#gen-energy").value || "quiet"
    }
  };
}

function fillModels(models) {
  const before = JSON.stringify(genBody());
  GEN_MODELS = models || [];
  const sel = $("#gen-model");
  if (!sel) return;
  const previous = sel.value;
  sel.replaceChildren();
  (models || []).forEach(m => {
    const opt = makeEl("option", "", (m.id || "") + " · " + (m.provider || "") + " / " + (m.model || ""));
    opt.value = m.id;
    opt.disabled = !m.available;
    sel.appendChild(opt);
  });
  const chosen = GEN_MODELS.find(m => m.id === previous && m.available) || GEN_MODELS.find(m => m.id === GEN_DEFAULT_MODEL && m.available) || GEN_MODELS.find(m => m.available);
  sel.value = chosen ? chosen.id : "";
  fillGenerationOptions();
  if (before !== JSON.stringify(genBody()) || GEN_PREFLIGHT && (!chosen || chosen.capabilities.hash !== GEN_PREFLIGHT.data.capability_hash)) invalidatePreflight();
}

function fillGenerationOptions() {
  const chosen = GEN_MODELS.find(m => m.id === $("#gen-model").value);
  const caps = chosen && chosen.capabilities || {};
  [ [ "#gen-resolution", caps.resolutions, "resolution" ], [ "#gen-duration", caps.durations, "duration" ] ].forEach(([id, values, key]) => {
    const sel = $(id);
    const old = sel.value;
    sel.replaceChildren();
    (values || []).forEach(name => {
      const opt = makeEl("option", "", name);
      opt.value = String(name);
      sel.appendChild(opt);
    });
    const options = (values || []).map(String);
    sel.value = options.includes(String(old)) ? String(old) : String(chosen && chosen.defaults[key] || options[0] || "");
  });
}

function invalidatePreflight() {
  GEN_PREFLIGHT = null;
  $("#gen-submit").disabled = true;
  $("#gen-estimate").textContent = "Run preflight before creating a paid job.";
}

function genMessage(message) {
  $("#gen-message").textContent = message;
}

function genButton(parent, label, action) {
  const button = makeEl("button", "", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } catch (e) {
      genMessage(e.message);
    } finally {
      button.disabled = false;
    }
  });
  parent.appendChild(button);
}

function renderGenerationStatus(data) {
  const banner = $("#gen-banner");
  const privacy = $("#gen-privacy");
  const status = $("#gen-status");
  if (banner) banner.textContent = data.enabled ? "Generation is enabled. This uses a paid external API on a trusted network only." : "Generation is off. GENERATION_ENABLED=1, a model alias, and a provider key are required. Keys never spend by themselves.";
  if (privacy) {
    const notes = (data.warnings || []).join(" ");
    privacy.textContent = notes;
  }
  if (status) {
    const b = data.budget || {};
    status.textContent = "jobs " + (b.jobs && b.jobs.remaining || 0) + " remaining · video-seconds " + (b.video_seconds && b.video_seconds.remaining || 0) + " remaining · USD remaining " + (b.usd && b.usd.remaining_microusd || 0) + " µ$";
  }
}

function renderGenerationJobs(jobs) {
  const box = $("#gen-jobs");
  if (!box) return;
  box.replaceChildren();
  (jobs || []).forEach(job => {
    const el = makeEl("div", "gen-job");
    el.appendChild(makeEl("div", "", job.title || job.id));
    el.appendChild(makeEl("div", "", (job.provider || "") + " · " + (job.status || "") + " · " + (job.next_step || "")));
    el.appendChild(makeEl("div", "", job.error_message || ""));
    const url = "/api/generation/jobs/" + encodeURIComponent(job.id);
    if (job.status === "queued") genButton(el, "Cancel queued job", () => genAct("POST", url + "/cancel"));
    if (job.status === "submission_unknown") {
      genButton(el, "Attach provider job ID", async () => {
        const id = prompt("Provider job ID verified in the provider dashboard:");
        if (id && id.trim()) await genAct("POST", url + "/reconcile", {
          provider_job_id: id.trim()
        });
      });
      genButton(el, "Confirm not accepted", async () => {
        if (confirm("Have you verified in the provider dashboard that this request was NOT accepted? This releases its reservation.")) await genAct("POST", url + "/reconcile", {
          not_accepted: true
        });
      });
    }
    if (GEN_TERMINAL[job.status]) genButton(el, "Regenerate (paid)", () => regenerateJob(job));
    box.appendChild(el);
  });
}

function renderReview(jobs) {
  const box = $("#gen-review");
  if (!box) return;
  box.replaceChildren();
  (jobs || []).forEach(job => {
    (job.outputs || []).forEach(out => {
      const card = makeEl("div", "gen-card");
      if (out.uri && out.processing_status === "ready" && out.review_status !== "deleted") {
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        video.src = "/media/" + out.uri;
        card.appendChild(video);
      }
      card.appendChild(makeEl("div", "", job.title || ""));
      card.appendChild(makeEl("div", "", job.operator_brief || ""));
      card.appendChild(makeEl("div", "", job.submitted_prompt || ""));
      card.appendChild(makeEl("div", "", (job.provider_model || "") + " · " + (job.routing || "") + (job.zdr ? "" : " · not ZDR")));
      card.appendChild(makeEl("div", "", out.processing_status + " · " + out.review_status + " · " + (out.error_message || "")));
      const url = "/api/generation/outputs/" + encodeURIComponent(out.id);
      if (out.processing_status === "ready" && out.review_status === "pending") {
        genButton(card, "Approve", () => genAct("POST", url + "/approve"));
        genButton(card, "Reject", () => genAct("POST", url + "/reject", {
          reason: "rejected"
        }));
      }
      if (out.processing_status === "failed" && out.review_status !== "deleted") genButton(card, "Retry processing (no new charge)", () => genAct("POST", url + "/retry-processing"));
      if (out.review_status !== "deleted" && GEN_TERMINAL[job.status]) genButton(card, "Delete output", async () => {
        if (confirm("Delete this output and its playable file? This cannot refund provider charges.")) await genAct("DELETE", url);
      });
      box.appendChild(card);
    });
  });
}

function jobsNeedPoll(jobs) {
  return (jobs || []).some(job => !GEN_TERMINAL[job.status]);
}

async function genAct(method, url, body) {
  const version = GEN_ACTION_VERSION;
  const result = await genRequest(method, url, body);
  if (version !== GEN_ACTION_VERSION || STATE.route !== "generation") return result;
  invalidatePreflight();
  genMessage("Action completed.");
  await loadGeneration();
  return result;
}

async function genRequest(method, url, body) {
  const opts = {
    method: method,
    headers: {
      "Content-Type": "application/json"
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || typeof data.detail === "string" && data.detail || "Generation request failed (" + r.status + ")");
  return data;
}

async function loadGeneration() {
  // A response from a route that has been left must never redraw this view.
  const version = ++GEN_LOAD_VERSION;
  stopGenerationPoll();
  const reviewState = $("#gen-review-state").value || "pending";
  const [status, models, jobs, outputs] = await Promise.all([ genRequest("GET", "/api/generation"), genRequest("GET", "/api/generation/models"), genRequest("GET", "/api/generation/jobs?limit=50&offset=" + GEN_JOBS_OFFSET), genRequest("GET", "/api/generation/outputs?limit=50&offset=" + GEN_REVIEW_OFFSET + "&review_status=" + reviewState) ]);
  if (version !== GEN_LOAD_VERSION) return;
  renderGenerationStatus(status);
  GEN_DEFAULT_MODEL = status.default_model || "";
  renderIfChanged("models", models.models || [], fillModels);
  renderIfChanged("jobs", jobs.jobs || [], renderGenerationJobs);
  const byId = new Map((jobs.jobs || []).map(job => [ job.id, job ]));
  const ids = [ ...new Set((outputs.outputs || []).map(out => out.job_id)) ];
  await Promise.all(ids.filter(id => !byId.has(id)).map(async id => {
    byId.set(id, await genRequest("GET", "/api/generation/jobs/" + encodeURIComponent(id)));
  }));
  if (version !== GEN_LOAD_VERSION) return;
  renderIfChanged("review", ids.map(id => ({
    ...byId.get(id),
    outputs: outputs.outputs.filter(out => out.job_id === id)
  })), renderReview);
  $("#gen-jobs-prev").disabled = GEN_JOBS_OFFSET === 0;
  $("#gen-jobs-next").disabled = (jobs.jobs || []).length < 50;
  $("#gen-review-prev").disabled = GEN_REVIEW_OFFSET === 0;
  $("#gen-review-next").disabled = (outputs.outputs || []).length < 50;
  stopGenerationPoll();
  // Terminal pages have no state that can advance; do not keep a hidden poll alive.
  if (STATE.route === "generation" && jobsNeedPoll(jobs.jobs || [])) {
    GEN_TIMER = setTimeout(() => loadGeneration().catch(e => genMessage(e.message)), 5e3);
  }
}

function renderIfChanged(key, data, render) {
  // Polling must preserve existing video elements and focused controls.
  const signature = JSON.stringify(data);
  if (GEN_RENDERED[key] === signature) return;
  GEN_RENDERED[key] = signature;
  render(data);
}

async function runPreflight() {
  // The server-derived preview is invalid if any paid-job input changes.
  invalidatePreflight();
  const version = GEN_ACTION_VERSION;
  const body = genBody();
  const data = await genRequest("POST", "/api/generation/preflight", body);
  if (version !== GEN_ACTION_VERSION || STATE.route !== "generation") return;
  if (JSON.stringify(body) !== JSON.stringify(genBody())) return;
  GEN_PREFLIGHT = {
    body: JSON.stringify(body),
    data: data
  };
  $("#gen-submit").disabled = false;
  const prompt = $("#gen-prompt");
  const estimate = $("#gen-estimate");
  if (prompt) prompt.textContent = data.submitted_prompt || data.message || "";
  if (estimate) estimate.textContent = data.estimate ? "estimate " + data.estimate.usd + " USD · " + data.estimate.video_seconds + "s · " + (data.privacy || "") : data.message || "preflight failed";
}

async function runCreate() {
  // A matching preflight token is required before the one paid POST.
  if (GEN_CREATING) return;
  if (!GEN_PREFLIGHT || GEN_PREFLIGHT.body !== JSON.stringify(genBody())) {
    invalidatePreflight();
    genMessage("Run a successful preflight for the current inputs first.");
    return;
  }
  const prepared = GEN_PREFLIGHT;
  if (!confirm(paidConfirmation(prepared.data))) return;
  GEN_CREATING = true;
  invalidatePreflight();
  try {
    await genAct("POST", "/api/generation/jobs", {
      ...JSON.parse(prepared.body),
      preflight_token: prepared.data.preflight_token
    });
  } finally {
    GEN_CREATING = false;
  }
}

function paidConfirmation(data) {
  return "Create one paid job? " + data.provider_model + " · " + data.duration + "s · " + data.resolution + " · " + data.estimate.usd + " USD\nNo references.\n" + data.submitted_prompt + "\n" + data.privacy;
}

async function regenerateJob(job) {
  const version = GEN_ACTION_VERSION;
  const body = {
    model: job.model_alias,
    prompt: job.operator_brief,
    title: job.title,
    kind: job.kind,
    mode: job.mode,
    output: "video",
    duration: job.request.duration,
    resolution: job.request.resolution,
    ratio: "16:9",
    creative: {
      roles: job.creative.roles,
      energy: job.creative.energy
    }
  };
  const pre = await genRequest("POST", "/api/generation/preflight", body);
  if (version !== GEN_ACTION_VERSION || STATE.route !== "generation") return;
  if (confirm(paidConfirmation(pre))) await genAct("POST", "/api/generation/jobs/" + encodeURIComponent(job.id) + "/regenerate", {
    preflight_token: pre.preflight_token
  });
}

function wireGeneration() {
  const pre = $("#gen-preflight");
  const sub = $("#gen-submit");
  if (pre) pre.addEventListener("click", () => runPreflight().catch(e => genMessage(e.message)));
  if (sub) sub.addEventListener("click", () => runCreate().catch(e => genMessage(e.message)));
  [ "#gen-model", "#gen-brief", "#gen-duration", "#gen-resolution", "#gen-energy" ].forEach(id => {
    $(id).addEventListener("input", invalidatePreflight);
    $(id).addEventListener("change", () => {
      if (id === "#gen-model") fillGenerationOptions();
      invalidatePreflight();
    });
  });
  [ "jobs", "review" ].forEach(kind => [ "prev", "next" ].forEach(direction => {
    $("#gen-" + kind + "-" + direction).addEventListener("click", () => {
      const delta = direction === "next" ? 50 : -50;
      if (kind === "jobs") GEN_JOBS_OFFSET = Math.max(0, GEN_JOBS_OFFSET + delta); else GEN_REVIEW_OFFSET = Math.max(0, GEN_REVIEW_OFFSET + delta);
      loadGeneration().catch(e => genMessage(e.message));
    });
  }));
  $("#gen-review-state").addEventListener("change", () => {
    GEN_REVIEW_OFFSET = 0;
    loadGeneration().catch(e => genMessage(e.message));
  });
}

const isVisible = () => typeof document === "undefined" || document.visibilityState === undefined || document.visibilityState === "visible";

async function refreshTick() {
  if (!isVisible()) return null;
  if (STATE.route === "overview") {
    return Promise.all([ loadStatus(), loadStation(), loadJobs() ]);
  }
  if (STATE.route === "station") return loadStation();
  return null;
}

async function handleVisibilityChange() {
  if (!isVisible()) return null;
  return refreshTick();
}

function boot() {
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
  };
  wireMaintenance();
  wireGeneration();
  on("#ask-go", "click", submitAsk);
  on("#ask", "keydown", e => {
    if (e.key === "Enter") submitAsk();
  });
  $$("[data-gen]").forEach(b => b.addEventListener("click", () => doAction("/api/generate/" + b.dataset.gen + "?n=20", "generate " + b.dataset.gen)));
  $$("[data-src]").forEach(b => b.addEventListener("click", () => doAction("/api/sources/" + b.dataset.src, b.dataset.src)));
  $$("[data-station]").forEach(b => b.addEventListener("click", () => doAction(PREP.conform.url, PREP.conform.label)));
  on("#shuffle", "click", shufflePreview);
  on("#more", "click", () => loadGrid(false));
  on("#search", "input", e => scheduleSearch(e.target.value));
  on("#filter-type", "change", e => {
    setFilter("type", e.target.value);
  });
  on("#filter-kind", "change", e => {
    setFilter("kind", e.target.value);
  });
  on("#filter-state", "change", e => {
    setFilter("state", e.target.value);
  });
  on("#page-size", "change", e => {
    setPageSize(e.target.value);
  });
  on("#density", "change", e => {
    setDensity(e.target.value);
  });
  on("#clear-filters", "click", () => {
    clearFilters();
  });
  on("#drop-kind", "click", () => {
    dropKind();
  });
  on("#inspector-close", "click", () => {
    closeInspector();
  });
  wireComposer();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", () => {
      applyHash();
    });
  }
  applyHash();
}

const COMMONJS = typeof module !== "undefined" && module.exports;

if (typeof document !== "undefined" && !COMMONJS) boot();

if (COMMONJS) {
  module.exports = {
    PAGE: PAGE,
    PAGE_SIZES: PAGE_SIZES,
    API_TIMEOUT_MS: API_TIMEOUT_MS,
    SEARCH_DEBOUNCE_MS: SEARCH_DEBOUNCE_MS,
    REFRESH_MS: REFRESH_MS,
    JOB_POLL_MS: JOB_POLL_MS,
    STATE: STATE,
    ROUTES: ROUTES,
    DEFAULT_ROUTE: DEFAULT_ROUTE,
    LIBRARY_STATES: LIBRARY_STATES,
    LIBRARY_TYPES: LIBRARY_TYPES,
    LIBRARY_DENSITIES: LIBRARY_DENSITIES,
    NOT_AVAILABLE: NOT_AVAILABLE,
    makeEl: makeEl,
    makeLink: makeLink,
    api: api,
    isApiAbort: isApiAbort,
    humanMessage: humanMessage,
    formatAge: formatAge,
    formatDuration: formatDuration,
    parseHash: parseHash,
    applyHash: applyHash,
    enterRoute: enterRoute,
    exitRoute: exitRoute,
    VIEWS: VIEWS,
    renderChrome: renderChrome,
    renderNav: renderNav,
    statusBadge: statusBadge,
    renderPanelState: renderPanelState,
    cardEl: cardEl,
    freshnessLine: freshnessLine,
    stationEl: stationEl,
    stationState: stationState,
    stationNow: stationNow,
    summaryRow: summaryRow,
    poolState: poolState,
    confirmDialog: confirmDialog,
    closeAllDialogs: closeAllDialogs,
    overviewWarnings: overviewWarnings,
    poolCounts: poolCounts,
    configLines: configLines,
    renderOverview: renderOverview,
    recordJob: recordJob,
    finishJob: finishJob,
    recentJobs: recentJobs,
    renderJobs: renderJobs,
    loadGrid: loadGrid,
    scheduleSearch: scheduleSearch,
    shufflePreview: shufflePreview,
    clearFilters: clearFilters,
    renderFilters: renderFilters,
    renderLibrary: renderLibrary,
    applyLibraryQuery: applyLibraryQuery,
    libraryCounts: libraryCounts,
    libraryHash: libraryHash,
    setFilter: setFilter,
    setPageSize: setPageSize,
    setDensity: setDensity,
    dropKind: dropKind,
    openInspector: openInspector,
    closeInspector: closeInspector,
    renderInspector: renderInspector,
    setInspectorBusy: setInspectorBusy,
    enableBumper: enableBumper,
    disableBumper: disableBumper,
    deleteBumper: deleteBumper,
    loadStatus: loadStatus,
    loadStation: loadStation,
    pollJob: pollJob,
    doAction: doAction,
    announce: announce,
    refreshTick: refreshTick,
    handleVisibilityChange: handleVisibilityChange,
    submitAsk: submitAsk,
    gapLabel: gapLabel,
    composerProblems: composerProblems,
    composerParams: composerParams,
    composeBreak: composeBreak,
    readComposerControls: readComposerControls,
    setComposerPreset: setComposerPreset,
    renderComposer: renderComposer,
    timelineItemEl: timelineItemEl,
    playComposerSequence: playComposerSequence,
    advanceComposer: advanceComposer,
    stopComposerPlayback: stopComposerPlayback,
    markComposerStale: markComposerStale,
    playbackLine: playbackLine,
    wireComposer: wireComposer,
    RELAXED_TEXT: RELAXED_TEXT,
    STALE_TEXT: STALE_TEXT,
    COMPOSER_PRESETS: COMPOSER_PRESETS,
    stationRollup: stationRollup,
    conformEl: conformEl,
    hlsSupported: hlsSupported,
    renderStation: renderStation,
    closeStationPreview: closeStationPreview,
    STATION_MESSAGES: STATION_MESSAGES,
    HLS_NO_NATIVE: HLS_NO_NATIVE,
    RECENT_JOBS: RECENT_JOBS,
    mergeJobs: mergeJobs,
    jobsList: jobsList,
    jobRetry: jobRetry,
    renderOpsJobs: renderOpsJobs,
    loadJobs: loadJobs,
    lockAction: lockAction,
    renderActionLocks: renderActionLocks,
    wireMaintenance: wireMaintenance,
    syncJobWatches: syncJobWatches,
    stopJobWatches: stopJobWatches,
    GEN_TERMINAL: GEN_TERMINAL,
    renderGenerationJobs: renderGenerationJobs,
    renderReview: renderReview,
    jobsNeedPoll: jobsNeedPoll,
    fillModels: fillModels,
    renderGenerationStatus: renderGenerationStatus,
    runPreflight: runPreflight,
    runCreate: runCreate,
    genRequest: genRequest,
    regenerateJob: regenerateJob,
    invalidatePreflight: invalidatePreflight,
    renderIfChanged: renderIfChanged,
    loadGeneration: loadGeneration,
    stopGenerationPoll: stopGenerationPoll,
    REASON_TEXT: REASON_TEXT,
    NO_PROVENANCE: NO_PROVENANCE,
    FILE_OWNED: FILE_OWNED,
    renderStationConfig: renderStationConfig,
    stationConfigGroups: stationConfigGroups,
    resetStateForTests() {
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
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
    }
  };
}
