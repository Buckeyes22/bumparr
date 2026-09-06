"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Fake DOM. Small on purpose: enough of the element contract that app.js runs
// unmodified (classList, attributes/dataset, listeners you can dispatch,
// hidden/focus, id and descendant selectors), and nothing more. No jsdom.
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor(node) { this.node = node; }
  list() { return String(this.node.className || "").split(/\s+/).filter(Boolean); }
  write(list) { this.node.className = list.join(" "); }
  add(...names) {
    const list = this.list();
    names.forEach((n) => { if (!list.includes(n)) list.push(n); });
    this.write(list);
  }
  remove(...names) { this.write(this.list().filter((n) => !names.includes(n))); }
  contains(name) { return this.list().includes(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

const dataKey = (name) => name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());

function matchesSimple(node, selector) {
  const tokens = selector.match(/[.#]?[\w-]+|\[[^\]]+\]/g) || [];
  return tokens.every((token) => {
    if (token[0] === ".") return node.classList.contains(token.slice(1));
    if (token[0] === "#") return node.id === token.slice(1);
    if (token[0] === "[") {
      const body = token.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq === -1) return node.getAttribute(body) !== null;
      const want = body.slice(eq + 1).replace(/^["']|["']$/g, "");
      return node.getAttribute(body.slice(0, eq)) === want;
    }
    return node.tagName === token.toUpperCase();
  });
}

function matchesSelector(node, selector) {
  const parts = String(selector).trim().split(/\s+/);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (ancestor && !matchesSimple(ancestor, parts[i])) ancestor = ancestor.parent;
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.id = "";
    // Form and media state app.js reads back as properties rather than as
    // attributes, exactly as a real element carries them.
    this.value = "";
    this.checked = false;
    this.paused = true;
    this.loads = 0;
    // <dialog>: `open` plus showModal/close below. app.js only reaches for
    // those when HTMLDialogElement exists, so deleting that global exercises
    // the fallback panel against this same node.
    this.open = false;
    this.returnValue = "";
    // Back-references stay non-enumerable: several tests serialise a subtree
    // with JSON.stringify to prove no markup got in, and a parent/classList
    // link would make that a circular structure.
    Object.defineProperty(this, "parent", { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, "classList", { value: new FakeClassList(this), enumerable: false });
  }
  adopt(nodes) {
    nodes.forEach((n) => { if (n && typeof n === "object") n.parent = this; });
    return nodes;
  }
  append(...nodes) { this.children.push(...this.adopt(nodes)); }
  appendChild(node) { this.children.push(...this.adopt([node])); return node; }
  replaceChildren(...nodes) {
    this.children.forEach((n) => { if (n && n.parent === this) n.parent = null; });
    this.children = this.adopt(nodes);
  }
  replaceChild(fresh, old) {
    const at = this.children.indexOf(old);
    if (at === -1) return old;
    old.parent = null;
    this.children[at] = this.adopt([fresh])[0];
    return old;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    if (name.startsWith("data-")) { this.dataset[dataKey(name)] = String(value); return; }
    if (name === "id") { this.id = String(value); return; }
    if (name === "class") { this.className = String(value); return; }
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith("data-")) {
      const key = dataKey(name);
      return key in this.dataset ? String(this.dataset[key]) : null;
    }
    if (name === "id") return this.id || null;
    if (name === "class") return this.className;
    return name in this.attributes ? this.attributes[name] : null;
  }
  removeAttribute(name) {
    if (name.startsWith("data-")) { delete this.dataset[dataKey(name)]; return; }
    delete this.attributes[name];
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const fns = this.listeners.get(type) || [];
    this.listeners.set(type, fns.filter((f) => f !== fn));
  }
  dispatch(type, event) {
    const ev = Object.assign(
      { type, target: this, stopPropagation() {}, preventDefault() {} }, event);
    return Promise.all((this.listeners.get(type) || []).map((fn) => fn(ev)));
  }
  click() { return this.dispatch("click"); }
  focus() { global.document.activeElement = this; }
  select() { this.selected = true; }
  // Counted rather than mocked: the assertion is that a route change scrolls
  // the current tab into view once, and that a refresh does not do it again.
  scrollIntoView(options) {
    this.scrolls = (this.scrolls || 0) + 1;
    this.scrollOptions = options;
  }
  // Modal open/close. close() is idempotent, so a double teardown is harmless
  // here for the same reason it is on the real element.
  showModal() { this.open = true; this.setAttribute("open", ""); }
  close(value) {
    if (!this.open) return;
    this.open = false;
    this.removeAttribute("open");
    this.returnValue = value === undefined ? "" : String(value);
    this.dispatch("close");
  }
  // Media. play() resolves like the real promise-returning method so app.js's
  // .catch() has something to attach to, and both fire their events, which is
  // what lets a test prove only one preview is ever playing.
  play() { this.paused = false; this.dispatch("play"); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatch("pause"); } }
  load() { this.loads++; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  contains(node) { return node === this || this.descendants().includes(node); }
  querySelector(selector) {
    return this.descendants().find((n) => matchesSelector(n, selector)) || null;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((n) => matchesSelector(n, selector));
  }
}

// A stand-in for index.html: only the ids/hooks app.js reaches for, in the same
// nesting, so a selector that would miss in the browser also misses here.
// Keep this in step with bumparr/web/index.html — every element app.js reaches
// for must exist here, in the same view, or a test proves nothing.
function buildDocument() {
  const el = (tag, props, kids) => {
    const node = new FakeNode(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === "data") Object.assign(node.dataset, v);
      else node[k] = v;
    });
    (kids || []).forEach((kid) => node.appendChild(kid));
    return node;
  };
  const panel = (id, kids) => el("section", { id, className: "panel" }, kids);
  // index.html ships the default view visible and the rest hidden, so a page
  // whose script never ran still shows the overview shell.
  const view = (id, kids) => el("section",
    { id, className: "view", hidden: id !== "view-overview" }, kids);
  const navLink = (name) => el("a", { href: "#/" + name, data: { view: name } });
  const body = el("body", {}, [
    el("a", { className: "skip-link" }),
    el("header", {}, [
      el("h1", { className: "brand", textContent: "Bumparr" }),
      el("div", { className: "headmeta" }, [
        el("div", { id: "status-pill", className: "pill" }),
        el("div", { id: "header-profile", className: "hmeta" }),
        el("div", { id: "header-jobs", className: "hmeta" }),
        el("div", { id: "header-refresh", className: "hmeta" }),
      ]),
    ]),
    el("div", { className: "shell" }, [
      el("nav", { id: "viewnav", className: "viewnav" },
         ["overview", "library", "composer", "station", "operations"].map(navLink)),
      el("main", { id: "main" }, [
        el("p", { id: "live-region", className: "live-region" }),
        view("view-overview", [
          el("div", { id: "pool-state", className: "panel-state" }),
          panel("panel-warnings", [
            el("div", { id: "warnings-state", className: "panel-state" }),
            el("ul", { id: "warnings", className: "warnings" }),
          ]),
          el("div", { className: "viewgrid" }, [
            panel("panel-service", [el("div", { id: "service-summary" })]),
            panel("panel-pool", [
              el("div", { id: "totals" }),
              el("div", { id: "by-type" }),
            ]),
            panel("panel-ov-station", [
              el("div", { id: "ov-station-state", className: "panel-state" }),
              el("div", { id: "ov-station" }),
              el("div", { id: "ov-now" }),
            ]),
            panel("panel-config", [
              el("div", { id: "config-summary" }),
              el("div", { id: "memory-status" }),
            ]),
            panel("panel-jobs", [
              el("div", { id: "jobs-state", className: "panel-state" }),
              el("ul", { id: "jobs-list", className: "joblist" }),
            ]),
          ]),
        ]),
        view("view-library", [
          el("div", { className: "viewtools" }, [
            el("button", { id: "shuffle" }),
          ]),
          el("div", { className: "panel wide" }, [
            el("div", { className: "libbar" }, [
              el("label", { htmlFor: "search" }),
              el("input", { id: "search", value: "" }),
              el("select", { id: "filter-type", value: "" }),
              el("select", { id: "filter-kind", value: "" }),
              el("select", { id: "filter-state", value: "all" }),
              el("select", { id: "page-size", value: "24" }),
              el("select", { id: "density", value: "grid" }),
              el("button", { id: "clear-filters" }),
            ]),
            el("p", { id: "library-counts", className: "libcounts" }),
            el("div", { id: "browse-state", className: "panel-state" }),
            el("div", { id: "grid", className: "grid" }),
            el("button", { id: "more", hidden: true }),
          ]),
          el("section", { id: "library-danger", className: "panel wide danger-zone" }, [
            el("p", { id: "danger-note", className: "note" }),
            el("button", { id: "drop-kind", disabled: true }),
          ]),
        ]),
        view("view-composer", [
          panel("panel-compose", [
            el("div", { className: "cmp-presets" },
               ["15", "30", "60", "90"].map((s) => el("button", { data: { preset: s } }))),
            el("div", { className: "cmpbar" }, [
              el("label", { htmlFor: "cmp-seconds" }),
              el("input", { id: "cmp-seconds", type: "number", value: "30" }),
              el("label", { htmlFor: "cmp-tolerance" }),
              el("input", { id: "cmp-tolerance", type: "number", value: "1.5" }),
              el("label", { htmlFor: "cmp-max-items" }),
              el("input", { id: "cmp-max-items", type: "number", value: "8" }),
              el("label", { htmlFor: "cmp-placement" }),
              el("select", { id: "cmp-placement", value: "any" }),
            ]),
            el("fieldset", { className: "cmp-types" },
               ["video", "card", "image", "stream"].map((t) =>
                 el("input", { id: "cmp-type-" + t, type: "checkbox",
                               data: { cmptype: t } }))),
            el("div", { id: "cmp-validation", className: "cmp-validation", hidden: true }),
            el("button", { id: "cmp-go" }),
          ]),
          panel("panel-break", [
            el("div", { id: "composer-state", className: "panel-state" }),
            el("p", { id: "composer-summary", className: "cmp-summary" }),
            el("p", { id: "composer-count", className: "cmp-count" }),
            el("div", { id: "composer-attention", className: "cmp-attn", hidden: true }),
            el("div", { id: "composer-stale", className: "cmp-stale", hidden: true }),
            el("div", { className: "cmp-playback" }, [
              el("button", { id: "cmp-play", disabled: true }),
              el("button", { id: "cmp-prev", disabled: true }),
              el("button", { id: "cmp-next", disabled: true }),
              el("button", { id: "cmp-stop", disabled: true }),
            ]),
            el("p", { id: "cmp-progress", className: "cmp-progress" }),
            el("div", { id: "composer-stage", className: "cmp-stage" }),
            el("ol", { id: "composer-timeline", className: "cmp-timeline" }),
          ]),
        ]),
        view("view-station", [
          panel("panel-channels", [
            el("div", { id: "station-state", className: "panel-state" }),
            el("div", { id: "station" }),
            // Never redrawn with the summary: an open preview holds a
            // connection to the channel and must survive the 20s refresh.
            el("div", { id: "station-preview", className: "station-preview" }),
          ]),
          // Read-only: index.html gives this block a heading and two empty
          // containers, and app.js is the only thing that ever fills them.
          panel("panel-station-config", [
            el("div", { id: "station-config-state", className: "panel-state" }),
            el("div", { id: "station-config", className: "summary" }),
          ]),
          panel("panel-conform", [
            el("div", { id: "conform-state", className: "panel-state" }),
            el("div", { id: "conform" }),
            el("div", { className: "viewtools" }, [
              el("button", { data: { station: "conform", jobKey: "station conform" } }),
            ]),
          ]),
        ]),
        view("view-operations", [
          el("p", { className: "notice notice-panel", textContent:
            "This operator API has no authentication. Do not expose this " +
            "service to the public internet." }),
          panel("panel-ask", [
            el("input", { id: "ask", value: "" }),
            el("button", { id: "ask-go" }),
            el("div", { id: "ask-result" }),
            el("div", { className: "action-group" }, [
              el("button", { data: { starter: "dry", jobKey: "check starter" } }),
              el("button", { data: { starter: "run", jobKey: "run starter" } }),
            ]),
          ]),
          panel("panel-actions", [
            el("div", { id: "actions-state", className: "panel-state" }),
            // Grouped by consequence, exactly as the view is: every button that
            // starts a job carries the key its lock is held under.
            el("div", { className: "actions" }, [
              el("button", { data: { gen: "trivia", jobKey: "generate trivia" } }),
              el("button", { data: { gen: "psa", jobKey: "generate psa" } }),
              el("button", { data: { src: "fetch-queue", jobKey: "fetch-queue" } }),
              el("button", { data: { prep: "render", jobKey: "render cards" } }),
              el("button", { data: { prep: "conform", jobKey: "station conform" } }),
              el("button", { data: { maint: "tidy-dry", jobKey: "preview tidy" } }),
              el("button", { data: { maint: "tidy", jobKey: "tidy up" } }),
              el("button", { data: { maint: "revive", jobKey: "recheck retired" } }),
            ]),
          ]),
          panel("panel-ops-jobs", [
            el("div", { id: "ops-jobs-state", className: "panel-state" }),
            el("ul", { id: "ops-jobs-list", className: "joblist" }),
            el("pre", { id: "log", className: "log" }),
          ]),
        ]),
      ]),
    ]),
    el("footer", {}, [el("p", { id: "footer-version" })]),
    // One inspector for the whole page, empty until something is inspected.
    el("dialog", { id: "inspector", className: "dlg dlg-inspector" }, [
      el("div", { className: "dlg-head" }, [
        el("h2", { id: "inspector-title", textContent: "Item" }),
        el("button", { id: "inspector-close", textContent: "Close" }),
      ]),
      el("div", { id: "inspector-state", className: "panel-state" }),
      el("div", { id: "inspector-body", className: "dlg-body" }),
    ]),
  ]);
  return body;
}

let BODY = buildDocument();
const docListeners = new Map();
// The hash the router reads and rewrites. `replace` records what it was asked
// to do, so an unknown route can be shown to normalize without a real browser.
const replaced = [];
global.location = {
  hash: "",
  replace(url) { replaced.push(String(url)); this.hash = String(url); },
};

global.document = {
  visibilityState: "visible",
  activeElement: null,
  createElement(tag) { return new FakeNode(tag); },
  get body() { return BODY; },
  querySelector(sel) { return BODY.querySelector(sel); },
  querySelectorAll(sel) { return BODY.querySelectorAll(sel); },
  getElementById(id) { return BODY.querySelector("#" + id); },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  dispatch(type) { return Promise.all((docListeners.get(type) || []).map((fn) => fn({ type }))); },
};
global.confirm = () => true;
// A browser with a real <dialog>. The fallback-panel test deletes this.
global.HTMLDialogElement = function HTMLDialogElement() {};
// prefers-reduced-motion, which app.js asks about before it starts a hover
// preview. Off by default, which is the browser's own default.
let reduceMotion = false;
global.matchMedia = (query) => ({
  media: String(query),
  matches: reduceMotion && /prefers-reduced-motion/.test(String(query)),
});
// Density is the only thing the dashboard is allowed to remember locally.
const stored = new Map();
let storageThrows = false;
global.localStorage = {
  getItem(key) {
    if (storageThrows) throw new Error("access denied");
    return stored.has(key) ? stored.get(key) : null;
  },
  setItem(key, value) {
    if (storageThrows) throw new Error("access denied");
    stored.set(key, String(value));
  },
};

const app = require("./app.js");
const { cardEl, pollJob, enableBumper, deleteBumper, stationEl, stationState,
        freshnessLine, api, isApiAbort,
        renderPanelState, statusBadge, formatAge, formatDuration, loadGrid,
        loadStatus, scheduleSearch, refreshTick, handleVisibilityChange,
        announce, STATE, API_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, REFRESH_MS,
        doAction, submitAsk, resetStateForTests,
        ROUTES, DEFAULT_ROUTE, parseHash, applyHash, VIEWS, overviewWarnings,
        poolCounts, configLines, stationNow, recentJobs, recordJob, finishJob,
        renderChrome, renderJobs, renderOverview,
        openInspector, closeInspector, confirmDialog, disableBumper, dropKind,
        setFilter, setPageSize, setDensity, clearFilters, renderFilters,
        libraryCounts, libraryHash, poolState, PAGE, PAGE_SIZES,
        LIBRARY_DENSITIES, NOT_AVAILABLE,
        gapLabel, composerProblems, composerParams, composeBreak,
        readComposerControls, setComposerPreset, renderComposer, timelineItemEl,
        playComposerSequence, advanceComposer, stopComposerPlayback,
        markComposerStale, playbackLine, wireComposer, RELAXED_TEXT, STALE_TEXT,
        COMPOSER_PRESETS,
        REASON_TEXT, NO_PROVENANCE, renderStationConfig } = app;

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

const buttonClasses = (row) => descendants(cardEl(row))
  .filter((node) => node.tagName === "BUTTON").map((node) => node.className);

const $ = (sel) => document.querySelector(sel);
const logText = () => $("#log").textContent;
const textOf = (node) => descendants(node).map((n) => n.textContent).join(" ");

// Dialogs. The inspector ships in index.html; confirmations are appended to
// the body while they are up. "The" dialog is the topmost open one, which is
// what a click would actually reach.
const openDialogs = () => BODY.children.filter(
  (n) => n.tagName === "DIALOG" && (n.open || n.getAttribute("open") !== null));
const topDialog = () => openDialogs()[openDialogs().length - 1] || null;
const dialogText = () => (topDialog() ? textOf(topDialog()) : "");
const dialogControls = (tag) => (topDialog() ? descendants(topDialog()) : [])
  .filter((n) => n.tagName === tag);
const dialogButton = (label) => dialogControls("BUTTON")
  .find((n) => n.textContent === label);
const jsonReply = (body, init) => ({
  ok: (init && init.ok) !== undefined ? init.ok : true,
  status: (init && init.status) || 200,
  text: async () => JSON.stringify(body),
});
// The shape api() throws: a status plus a message safe to show a human.
const apiRejection = (status, message) => {
  const err = new Error(message);
  err.name = "ApiError";
  err.status = status;
  return err;
};
// Let every pending microtask settle; setImmediate is not one of the mocked
// timer APIs, so this works with or without mock.timers enabled.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => {
  BODY = buildDocument();
  global.confirm = () => true;
  global.HTMLDialogElement = function HTMLDialogElement() {};
  global.location.hash = "";
  replaced.length = 0;
  stored.clear();
  storageThrows = false;
  document.activeElement = null;
  reduceMotion = false;
  // Node has no execCommand, which is the shape of a browser that dropped it.
  // The tests that need the legacy copy path install one.
  delete document.execCommand;
  // Node ships a `navigator` with no `clipboard`, which is the shape a browser
  // without permission presents. Tests that need one install it.
  Object.defineProperty(globalThis, "navigator", {
    value: {}, configurable: true, writable: true });
  if (resetStateForTests) resetStateForTests();
});
test.afterEach(() => { delete global.fetch; });

// enableBumper refreshes the pool after a successful POST. Those follow-up
// fetches are not what these tests are about, so they reject and app.js's own
// error paths absorb them, leaving one call worth asserting on.
function stubFetch(reply) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    if (!String(url).startsWith("/api/pool/enable")) throw new Error("refresh not under test");
    return { ok: reply.ok !== false, status: reply.status || 200,
             text: async () => JSON.stringify(reply.body) };
  };
  return calls;
}

// ---------------------------------------------------------------------------
// Cards: hostile strings, parked rows, destructive controls
// ---------------------------------------------------------------------------

test("hostile API strings remain text/property values, never parsed markup", () => {
  const title = '<img src=x onerror="globalThis.pwned=1">';
  const kind = 'news" data-owned="yes';
  const media = 'https://media.example/a.mp4" onerror="globalThis.pwned=2';
  const card = cardEl({ type: "video", title, kind, media_url: media, duration: 4 });
  const nodes = descendants(card);

  assert.equal(nodes.filter((node) => node.tagName === "IMG").length, 0);
  assert.equal(nodes.find((node) => node.className === "pv-title").textContent, title);
  assert.equal(nodes.find((node) => node.className === "pv-kind").textContent, kind);
  assert.equal(nodes.find((node) => node.tagName === "VIDEO").src, media + "#t=2");
  assert.equal(globalThis.pwned, undefined);
});

test("an attacker-controlled type cannot create an element", () => {
  // enabled:1 keeps this row off the parked path, so the node list stays the
  // shape this test is about: whatever `type` says, no element comes from it.
  const card = cardEl({
    type: '<iframe src="javascript:alert(1)">',
    kind: "safe",
    enabled: 1,
    payload: { text: "literal <script>not markup</script>" },
  });
  const nodes = descendants(card);
  assert.equal(nodes.filter((node) => node.tagName === "IFRAME").length, 0);
  assert.equal(nodes.filter((node) => node.tagName === "SCRIPT").length, 0);
  assert.equal(nodes.find((node) => node.className === "tc").textContent,
               "literal <script>not markup</script>");
});

const inspectButton = (card) => descendants(card).find(
  (node) => node.tagName === "BUTTON" && String(node.className).split(" ").includes("pv-inspect"));
const badgeText = (card) => descendants(card)
  .filter((n) => String(n.className).split(" ").includes("pv-state"))
  .map(textOf).join(" ");

test("a card names its pool state in words rather than only in colour", () => {
  // The state used to be readable only from which hover icon appeared. Now the
  // card says it, and the same word is the one the state filter uses.
  const row = { id: "a", type: "stream", kind: "webcam", title: "harbour",
                media_url: "https://x/s.m3u8" };
  assert.match(badgeText(cardEl({ ...row, enabled: 1, health: "ok" })), /Healthy.*playable/s);
  assert.match(badgeText(cardEl({ ...row, enabled: 0, health: "ok" })), /Attention.*parked/s);
  assert.match(badgeText(cardEl({ ...row, enabled: 1, health: "dead" })), /Failed.*dead/s);
  assert.match(badgeText(cardEl({ id: "c", type: "card", kind: "psa", enabled: 1,
                                  health: "ok", media_url: null, payload: {} })),
               /Attention.*unrendered/s);
});

test("a row that never says whether it is parked claims no state at all", () => {
  // /api/bumpers/random — the shuffle preview — returns nothing but live rows
  // and has no `enabled` key. Reading that undefined as a state would invent
  // one; missing data is not evidence either way.
  const row = { id: "a", type: "stream", kind: "webcam", title: "harbour" };
  assert.equal(badgeText(cardEl(row)), "");
  assert.equal(badgeText(cardEl({ ...row, enabled: null })), "");
  assert.equal(poolState(row), "unknown");
});

test("Inspect is the card's only action control, always visible and named", () => {
  // Delete used to be a hover-only ✕, which is no control at all by keyboard
  // or on a touch screen; enable was a second one that only some rows grew.
  // Both moved into the inspector, and the name survives a hostile title.
  // (A stream card also carries Play, which acts on the preview, not the row.)
  const title = '<img src=x onerror="globalThis.pwned=4">';
  const row = { id: "vid:x", type: "video", kind: "ambient", title,
                media_url: "/media/x.mp4" };
  assert.deepEqual(buttonClasses({ ...row, enabled: 1 }), ["pv-inspect mini"]);
  assert.deepEqual(buttonClasses({ ...row, enabled: 0 }), ["pv-inspect mini"]);
  const card = cardEl({ ...row, enabled: 0 });
  const inspect = inspectButton(card);
  assert.equal(inspect.hidden, false);
  assert.equal(inspect.textContent, "Inspect");
  assert.ok(inspect.getAttribute("aria-label").includes(title));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("no card anywhere carries a delete control", () => {
  // The rule for the whole page, not just the library: permanent deletion
  // exists in the inspector's danger zone and the bulk flow, nowhere else.
  const rows = [
    { id: "a", type: "video", kind: "ambient", title: "t", media_url: "/m/a.mp4", enabled: 1 },
    { id: "b", type: "card", kind: "psa", title: "t", payload: { text: "x" }, enabled: 0 },
    { id: "c", type: "stream", kind: "webcam", title: "t", enabled: 1, health: "dead" },
  ];
  rows.forEach((row) => {
    const labels = descendants(cardEl(row))
      .filter((n) => n.tagName === "BUTTON")
      .map((n) => (n.textContent + " " + (n.getAttribute("aria-label") || "")).toLowerCase());
    assert.ok(!labels.some((l) => l.includes("delete")),
              "no delete control on a " + row.type + " card: " + JSON.stringify(labels));
  });
});

test("a declined confirmation sends no destructive request", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    return jsonReply({});
  };
  const pending = deleteBumper({ id: "vid:x", title: "x" });
  await flush();
  dialogButton("Cancel").click();
  await pending;
  assert.deepEqual(calls, []);
  assert.match(logText(), /delete cancelled/);
});

// ---------------------------------------------------------------------------
// Enable / delete request contracts
// ---------------------------------------------------------------------------

test("enableBumper escapes ids carrying scheme and path characters", async () => {
  // Pool ids are not URL-safe: "stream:cam:foo", "vid:ambient/x y.mp4". Raw,
  // the slash would re-point the request and the space would break it.
  const calls = stubFetch({ body: { changed: true } });
  await enableBumper({ id: "stream:cam:foo", title: "harbour" });
  await enableBumper({ id: "vid:ambient/x y.mp4", title: "ambient" });
  assert.deepEqual(calls.filter((c) => c.url.startsWith("/api/pool/enable")), [
    { url: "/api/pool/enable?bumper_id=stream%3Acam%3Afoo", method: "POST" },
    { url: "/api/pool/enable?bumper_id=vid%3Aambient%2Fx%20y.mp4", method: "POST" },
  ]);
});

test("a refused enable is reported, not swallowed", async () => {
  stubFetch({ ok: false, status: 404, body: { error: "not found" } });
  await enableBumper({ id: "ghost", title: "ghost cam" });
  assert.match(logText(), /enable failed: not found/);
  assert.doesNotMatch(logText(), /enabled ghost cam/);

  // No error field either: the status is what is left to say, and saying
  // nothing would leave a dead button looking like a working one.
  stubFetch({ ok: false, status: 503, body: {} });
  await enableBumper({ id: "ghost", title: "ghost cam" });
  assert.match(logText(), /enable failed: Server error \(503\)/);
});

test("the server's warning is relayed to the operator", async () => {
  // A calendar-managed card comes back with a warning that the rotation will
  // take it away again. Dropping it would let the click look like the last word.
  stubFetch({ body: { changed: true, warning: "the rotation parks it again within the hour" } });
  await enableBumper({ id: "card:on_this_day:abc", title: "moon landing" });
  assert.match(logText(),
    /enabled moon landing — the rotation parks it again within the hour/);
  assert.match($("#live-region").textContent, /the rotation parks it again/);
});

test("an enable that changed nothing says so", async () => {
  stubFetch({ body: { changed: false } });
  await enableBumper({ id: "s", title: "harbour" });
  assert.match(logText(), /enabled harbour \(already on\)/);
});

test("action polling continues past the old five-minute cap", async () => {
  let calls = 0;
  const getStatus = async (jobId) => {
    assert.equal(jobId, "slow-job");
    calls++;
    return calls <= 105
      ? { status: "working" }
      : { status: "done", result: "landed" };
  };
  const pause = async (ms) => assert.equal(ms, 3000);

  const result = await pollJob(
    { job_id: "slow-job", status: "working" }, getStatus, pause);

  assert.equal(calls, 106);
  assert.deepEqual(result, { status: "done", result: "landed" });
});

test("a lost status poll keeps the job unknown and backs off, never failing it", async () => {
  // A blip while reading the status is not a finished job. Letting the
  // rejection escape reported "✗ generate trivia failed: Bumparr could not be
  // reached" over work that was still running server-side.
  const answers = [
    () => { throw apiRejection(0, "Bumparr could not be reached."); },
    () => { throw apiRejection(0, "The server did not answer in time."); },
    () => ({ status: "working" }),
    () => ({ status: "done", result: "landed" }),
  ];
  let call = 0;
  const pauses = [];
  const result = await pollJob(
    { job_id: "j1", status: "working" },
    async () => answers[call++](),
    async (ms) => { pauses.push(ms); });

  assert.deepEqual(result, { status: "done", result: "landed" });
  assert.deepEqual(pauses, [3000, 10000, 10000, 3000],
                   "each lost read backs off to ten seconds, then recovers");
  assert.match(logText(), /status unknown/);
  assert.doesNotMatch(logText(), /failed/);
});

test("a job the server no longer tracks ends the poll as unknown, not done", async () => {
  let calls = 0;
  const result = await pollJob(
    { job_id: "gone", status: "working" },
    async () => { calls++; throw apiRejection(404, "Not found (404)."); },
    async () => {});
  assert.equal(calls, 1, "an expired job stops the poll");
  assert.equal(result.status, "unknown");
  assert.match(result.result, /no longer tracks this job/);
});

test("the default status poll reads the job endpoint and survives a blip", async () => {
  // The injected-getStatus tests above never exercise the default, which is the
  // path every Actions button actually takes.
  const urls = [];
  let attempt = 0;
  global.fetch = async (url) => {
    urls.push(String(url));
    attempt++;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return jsonReply({ status: "done", result: "landed" });
  };
  const pauses = [];
  const result = await pollJob({ job_id: "j 1", status: "working" }, undefined,
                               async (ms) => { pauses.push(ms); });
  assert.deepEqual(result, { status: "done", result: "landed" });
  assert.deepEqual(pauses, [3000, 10000]);
  assert.deepEqual(urls, ["/api/request/j%201", "/api/request/j%201"]);
  assert.match(logText(), /status unknown/);
});

test("an action whose status is unknown is not announced as a failure", async () => {
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") {
      return jsonReply({ job_id: "j1", status: "unknown", result: "status unknown" });
    }
    return jsonReply({ total: 0, playable_now: 0, by_kind: {}, by_type: {},
                       count: 0, bumpers: [], channels: {}, urls: {} });
  };
  await doAction("/api/generate/trivia?n=20", "generate trivia");
  assert.match(logText(), /generate trivia: status unknown/);
  assert.doesNotMatch(logText(), /generate trivia failed/);
  assert.match(logText(), /run it again to check/);
});

// Both job surfaces are driven the same way: start the wait, let the POST
// settle, then advance the clock a poll at a time.
const escapeLabels = (sel) => descendants($(sel))
  .filter((n) => n.tagName === "BUTTON").map((n) => n.textContent);
const escapeButton = (sel, label) => descendants($(sel))
  .find((n) => n.tagName === "BUTTON" && n.textContent === label);

function stubFailingJob(urls) {
  global.fetch = async (url, opts) => {
    urls.push(String(url));
    if ((opts && opts.method) === "POST") return jsonReply({ job_id: "j1", status: "working" });
    throw new TypeError("Failed to fetch");
  };
  return () => urls.filter((u) => u.startsWith("/api/request/j1")).length;
}

test("an ask poll that cannot reach the server hands the controls back", async (t) => {
  // The poll used to reschedule itself every ten seconds forever with the input
  // and button still disabled: no typing, no cancel, no retry, only a reload.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = [];
  const statusReads = stubFailingJob(urls);
  $("#ask").value = "more dead air";
  const waiting = submitAsk();
  await flush();
  assert.equal($("#ask-go").disabled, true, "the form is held while the job starts");

  t.mock.timers.tick(3000);
  await flush();
  assert.equal(statusReads(), 1);
  assert.equal($("#ask-go").disabled, false, "a lost poll never leaves the form dead");
  assert.equal($("#ask").disabled, false);
  assert.match(textOf($("#ask-result")), /status unknown/);
  assert.deepEqual(escapeLabels("#ask-result"), ["Check now", "Stop checking"]);

  t.mock.timers.tick(10000);
  await flush();
  assert.equal(statusReads(), 2, "it keeps checking in the background");

  escapeButton("#ask-result", "Stop checking").click();
  await waiting;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(statusReads(), 2, "stopping actually stops the poll");
  assert.match(textOf($("#ask-result")), /stopped checking/);
  assert.equal($("#ask-go").disabled, false);
});

test("an action whose status reads keep failing leaves the panel usable", async (t) => {
  // The shared poller loops until the job ends or the operator stops it, so
  // without an escape a silent server pinned every Actions button on disabled.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = [];
  const statusReads = stubFailingJob(urls);
  const buttons = document.querySelectorAll(".actions button");
  const mine = buttons.find((b) => b.dataset.jobKey === "generate trivia");
  const others = buttons.filter((b) => b !== mine);
  assert.ok(others.length > 1, "the panel holds more actions than the one clicked");

  const running = doAction("/api/generate/trivia?n=20", "generate trivia");
  await flush();
  assert.ok(mine.disabled, "the duplicate of a running action is held");
  assert.ok(others.every((b) => !b.disabled),
            "unrelated actions stay available within backend concurrency");

  t.mock.timers.tick(3000);
  await flush();
  assert.equal(statusReads(), 1);
  assert.ok(buttons.every((b) => !b.disabled), "a lost read never leaves the panel dead");
  assert.match(textOf($("#actions-state")), /status unknown/);
  assert.equal($("#actions-state").dataset.state, "attention");
  assert.deepEqual(escapeLabels("#actions-state"), ["Check now", "Stop checking"]);

  t.mock.timers.tick(10000);
  await flush();
  assert.equal(statusReads(), 2, "it keeps checking in the background");

  escapeButton("#actions-state", "Stop checking").click();
  await running;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(statusReads(), 2, "stopping actually stops the poll");
  assert.match(logText(), /generate trivia: stopped checking/);
  assert.doesNotMatch(logText(), /generate trivia failed/);
  assert.ok(buttons.every((b) => !b.disabled));
  assert.equal($("#actions-state").dataset.state, "populated",
               "the region goes back to the panel vocabulary once the job ends");
  assert.equal($("#actions-state").hidden, true);
});

test("Check now polls immediately instead of waiting out the backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = [];
  const statusReads = stubFailingJob(urls);
  $("#ask").value = "more dead air";
  submitAsk();
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(statusReads(), 1);

  escapeButton("#ask-result", "Check now").click();
  await flush();
  assert.equal(statusReads(), 2, "the operator does not wait out the ten-second backoff");
});

test("a second ask supersedes the first job's poll and result line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = [];
  let posts = 0;
  global.fetch = async (url, opts) => {
    urls.push(String(url));
    if ((opts && opts.method) === "POST") {
      posts++;
      return jsonReply({ job_id: "j" + posts, status: "working" });
    }
    if (String(url).includes("j1")) return jsonReply({ status: "done", result: "first landed" });
    return jsonReply({ status: "working" });
  };
  $("#ask").value = "one";
  const first = submitAsk();
  await flush();
  $("#ask").value = "two";
  submitAsk();
  await flush();

  t.mock.timers.tick(3000);
  await flush();
  assert.doesNotMatch(textOf($("#ask-result")), /first landed/,
                      "a superseded poll may not overwrite the newer request");
  assert.match(textOf($("#ask-result")), /working on it/);
  await first;
  const readsOfFirst = urls.filter((u) => u.includes("j1")).length;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(urls.filter((u) => u.includes("j1")).length, readsOfFirst,
               "a superseded job stops being polled rather than polling forever");
});

// --- the ask form's controls belong to STATE, not to the elements -------------

// An ingest, answered the way the server answers one: the POST returns a job
// id, the status read says it is still working, and the registry lists the row
// only once the POST has been made — before that the job does not exist.
function stubRunningAsk(row) {
  const calls = [];
  let posted = false;
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET" });
    if ((opts && opts.method) === "POST") {
      posted = true;
      return jsonReply({ job_id: "j1", status: "working" });
    }
    if (u.startsWith("/api/jobs")) {
      const jobs = posted ? [row] : [];
      return jsonReply({ jobs, count: jobs.length });
    }
    if (u.startsWith("/api/request/")) return jsonReply({ status: "working" });
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    return jsonReply({ count: 0, total: 0, bumpers: [] });
  };
  return calls;
}

test("leaving Operations mid-ingest hands the ask form back, and coming back shows it",
     async (t) => {
  // The disabled state used to live in the elements: route teardown superseded
  // the ask before it could re-enable anything, so Operations reopened with a
  // form nobody could type into and no way out short of a reload.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  stubRunningAsk(serverJob({ id: "j1", request: "add: harbour cams",
                             status: "working", result: "" }));
  await applyHash("#/operations");
  await flush();
  $("#ask").value = "harbour cams";
  const waiting = submitAsk();
  await flush();
  assert.equal($("#ask-go").disabled, true, "the form is held while the job starts");
  assert.equal(STATE.ops.ask.busy, true, "and the hold is a fact in STATE");

  await applyHash("#/overview");
  await flush();
  await waiting;
  await applyHash("#/operations");
  await flush();
  assert.equal($("#ask").disabled, false, "the input is usable again on re-entry");
  assert.equal($("#ask-go").disabled, false, "and so is the button");
  assert.equal(STATE.ops.ask.busy, false);
  // The ingest was never cancelled — only this surface stopped watching it.
  assert.match(textOf($("#ops-jobs-list")), /add: harbour cams/,
               "the job is still on the list: " + textOf($("#ops-jobs-list")));
  assert.match(textOf($("#ask-result")), /still running/,
               "the line reports what the registry says, not a made-up ending");
  assert.doesNotMatch(textOf($("#ask-result")), /stopped checking/,
                      "a torn-down poll is not an outcome to show the operator");
  app.exitRoute(STATE.route);
});

test("an ask whose job has finished while away reads its outcome off the registry",
     async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  stubRunningAsk(serverJob({ id: "j1", request: "add: harbour cams",
                             status: "done", result: "captured 2" }));
  await applyHash("#/operations");
  await flush();
  $("#ask").value = "harbour cams";
  const waiting = submitAsk();
  await flush();
  await applyHash("#/overview");
  await flush();
  await waiting;
  await applyHash("#/operations");
  await flush();
  assert.equal($("#ask").disabled, false);
  assert.match(textOf($("#ask-result")), /captured 2/);
  assert.match(textOf($("#ask-result")), /Healthy/);
  app.exitRoute(STATE.route);
});

test("the re-entry line keeps a hostile job result as one line of text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hostile = '<img src=x onerror="globalThis.pwned=1">\nsecond line\n'.repeat(40);
  stubRunningAsk(serverJob({ id: "j1", request: "add: harbour cams",
                             status: "error", result: hostile }));
  await applyHash("#/operations");
  await flush();
  $("#ask").value = "harbour cams";
  const waiting = submitAsk();
  await flush();
  await applyHash("#/overview");
  await flush();
  await waiting;
  await applyHash("#/operations");
  await flush();
  const line = $("#ask-result");
  assert.ok(textOf(line).includes("<img src=x"), "shown as the text it is");
  assert.equal(descendants(line).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
  const detail = descendants(line).find((n) => n.className === "badge-detail");
  assert.ok(detail.textContent.length <= 300, "bounded like every other server string");
  assert.ok(!detail.textContent.includes("\n"), "and kept to one line");
  assert.match(textOf(line), /Failed/, "an icon and a word, never colour alone");
  app.exitRoute(STATE.route);
});

test("a newer ask during an older one's poll leaves the controls usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let posts = 0;
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") {
      posts++;
      return jsonReply({ job_id: "j" + posts, status: "working" });
    }
    if (String(url).includes("j2")) return jsonReply({ status: "done", result: "second landed" });
    return jsonReply({ status: "working" });
  };
  $("#ask").value = "one";
  const first = submitAsk();
  await flush();
  $("#ask").value = "two";
  const second = submitAsk();
  await flush();
  assert.equal($("#ask-go").disabled, true, "the newer ask holds the controls");

  t.mock.timers.tick(3000);
  await flush();
  await first;
  await second;
  assert.equal($("#ask").disabled, false, "and hands them back when it ends");
  assert.equal($("#ask-go").disabled, false);
  assert.match(textOf($("#ask-result")), /second landed/);
  assert.doesNotMatch(textOf($("#ask-result")), /stopped checking/,
                      "the superseded ask may not write over the newer one's answer");
  assert.equal(STATE.jobs.items.filter((r) => r.label.startsWith("add: ")).length, 2,
               "both asks are still on the jobs list");
});

test("a POST that lands after the ask was superseded touches neither field nor watch",
     async (t) => {
  // The takeover block ran whatever had happened while the POST was in flight:
  // it cleared the input a newer ask had already been typed into, and stopped
  // the background watch the re-entered view had just started.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const reads = [];
  let land = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") {
      return new Promise((resolve) => { land = () => resolve(jsonReply({ job_id: "j1", status: "working" })); });
    }
    if (u.startsWith("/api/request/")) { reads.push(u); return jsonReply({ status: "working" }); }
    if (u.startsWith("/api/jobs")) {
      return jsonReply({ jobs: [serverJob({ id: "j1", request: "add: harbour cams",
                                            status: "working", result: "" })], count: 1 });
    }
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    return jsonReply({ count: 0, total: 0, bumpers: [] });
  };
  await applyHash("#/operations");
  await flush();
  $("#ask").value = "harbour cams";
  const waiting = submitAsk();
  await flush();

  await applyHash("#/overview");
  await flush();
  await applyHash("#/operations");
  await flush();
  assert.equal($("#ask").disabled, false, "the form came back usable");
  // The operator types again into the form they were handed back.
  $("#ask").value = "second thoughts";

  land();
  await flush();
  assert.equal($("#ask").value, "second thoughts",
               "a superseded POST may not empty a field it no longer owns");

  const before = reads.length;
  t.mock.timers.tick(30000);
  await flush();
  assert.ok(reads.length > before,
            "and may not stop the watch the re-entered view started: " +
            reads.length + " reads after 30s, was " + before);
  await waiting;
  app.exitRoute(STATE.route);
});

test("a background watch settling after a route change lets go of its own entry only",
     async (t) => {
  // stopJobWatches takes a watch out of the map while its status read is still
  // in flight; a re-entry then registers a fresh watch of the same job. An
  // unguarded delete in the old watch's settle removed the new one, leaving a
  // poll no teardown could reach.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const reads = [];
  let land = null;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/api/request/")) {
      reads.push(u);
      if (reads.length === 1) {
        return new Promise((resolve) => { land = () => resolve(jsonReply({ status: "working" })); });
      }
      return jsonReply({ status: "working" });
    }
    if (u.startsWith("/api/jobs")) {
      return jsonReply({ jobs: [serverJob({ id: "j1", request: "fetch-queue",
                                            status: "working", result: "" })], count: 1 });
    }
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    return jsonReply({ count: 0, total: 0, bumpers: [] });
  };
  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(reads.length, 1, "the background watch is reading the job");

  await applyHash("#/overview");
  await flush();
  await applyHash("#/operations");
  await flush();
  // The abandoned read lands now, after a fresh watch has taken its place.
  land();
  await flush();

  app.exitRoute("operations");
  const settled = reads.length;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(reads.length, settled,
               "the re-entry's watch was still in the map for the teardown to stop: " +
               reads.slice(settled).join(", "));
});

// ---------------------------------------------------------------------------
// Station
// ---------------------------------------------------------------------------

test("station panel renders now/next and URLs as text and values, never markup", () => {
  const s = {
    ffmpeg: true, conformed: 3, eligible: 5,
    urls: { channel_m3u: "http://x/station/channel.m3u\"><img src=x>", guide_xml: "http://x/g.xml", standby: "http://x/s.m3u8" },
    channels: {
      live: { now: { id: "a", title: "<b>Ident</b>", kind: "station_id", started_at: 0, ends_at: Date.now() / 1000 + 5 }, next: { id: "b", title: "Next & co", kind: "trivia" } },
      standby: { now: null, next: null },
    },
  };
  const el = stationEl(s);
  const text = JSON.stringify(el);
  assert.ok(text.includes("<b>Ident</b>"));
  assert.ok(!text.includes("innerHTML"));
  const inputs = [];
  (function walk(n) { if (n.tagName === "INPUT") inputs.push(n); (n.children || []).forEach(walk); })(el);
  assert.equal(inputs.length, 3);
  assert.ok(inputs[0].value.includes("<img src=x>"));
  assert.ok(inputs.every((i) => i.readOnly === true));
  assert.ok(text.includes("off air"));
  assert.ok(text.includes("3 / 5 conformed"));
});

test("station panel says when ffmpeg is missing", () => {
  const el = stationEl({ ffmpeg: false, conformed: 0, eligible: 4, urls: {}, channels: {} });
  assert.ok(JSON.stringify(el).includes("ffmpeg not found"));
});

test("stationState names a level and a word, never colour alone", () => {
  assert.equal(stationState({ ffmpeg: false, channels: {} }).level, "attention");
  assert.equal(stationState({ ffmpeg: true, channels: { live: { now: { title: "x" } } } }).level,
               "healthy");
  assert.equal(stationState({ ffmpeg: true, channels: { live: {} } }).level, "attention");
  assert.equal(stationState(null).level, "offline");
  assert.ok(stationState(null).detail.length > 0);
});

// ---------------------------------------------------------------------------
// Card metadata lines
// ---------------------------------------------------------------------------

test("preview cards keep hostile creative strings as text", () => {
  const family = '<img src=x onerror="globalThis.pwned=9">';
  const card = cardEl({
    type: "card", kind: "psa", title: "x",
    source: '<script>globalThis.pwned=8</script>',
    payload: { lines: ["Stay."], source: "operator" },
    creative: { family, audio: "music", template: "minimal_center",
                brand_mode: "reveal" },
    selection: { factors: { base: 1, score: 0.5 } },
  });
  const text = textOf(descendants(card).find((n) => n.className === "pv-chips"));
  assert.ok(text.includes(family));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("memory freshness stays text and does not invent missing fields", () => {
  const channel = '<img src=x onerror="globalThis.pwned=12">';
  const card = cardEl({
    type: "card", kind: "channel_statistics", title: "x", enabled: 0,
    payload: { lines: ["This channel has aired 25 bumpers."],
               channel, generated_at: 1700000000, valid_until: 1700003600 },
  });
  const node = descendants(card).find((n) => n.className === "pv-freshness");
  assert.ok(node);
  assert.ok(node.textContent.includes(channel));
  assert.ok(node.textContent.includes("valid until 1700003600"));
  assert.ok(node.textContent.includes("parked"));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
  const empty = freshnessLine({ type: "card", payload: { lines: ["Stay."] } });
  assert.equal(empty, "");
  const noExpiry = freshnessLine({
    payload: { channel: "station:live", generated_at: 1 },
  });
  assert.ok(noExpiry.includes("no expiry"));
  assert.ok(!noExpiry.includes("valid until"));
});

test("music credits stay text and do not invent missing fields", () => {
  const title = '<img src=x onerror="globalThis.pwned=11">';
  const card = cardEl({
    type: "card", kind: "psa", title: "x",
    payload: { lines: ["Stay."] },
    music_credits: { id: "night-room-01", title, creator: "Example Artist",
                     license: "CC0-1.0", attribution: "" },
  });
  const node = descendants(card).find((n) => n.className === "pv-credits");
  assert.ok(node);
  assert.ok(node.textContent.includes(title));
  assert.ok(node.textContent.includes("Example Artist"));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  const empty = cardEl({
    type: "card", kind: "psa", title: "x",
    payload: { lines: ["Stay."] },
    music_credits: { id: "legacy.loose.wav", title: "", creator: "", license: "" },
  });
  const uncredited = descendants(empty).find((n) => n.className === "pv-credits");
  assert.equal(uncredited.textContent, "legacy.loose.wav");
  assert.ok(!uncredited.textContent.toLowerCase().includes("unknown"));
});

// ---------------------------------------------------------------------------
// api(): status, JSON, timeout, abort
// ---------------------------------------------------------------------------

test("api normalizes a non-2xx body into {status, message}", async () => {
  global.fetch = async () => ({
    ok: false, status: 422, text: async () => JSON.stringify({ error: "kind is unknown" }),
  });
  await assert.rejects(api("/api/bumpers"), (err) => {
    assert.equal(err.status, 422);
    assert.equal(err.message, "kind is unknown");
    return true;
  });
});

test("api falls back to a status message when the server explains nothing", async () => {
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
  await assert.rejects(api("/api/status"), (err) => {
    assert.equal(err.status, 500);
    assert.match(err.message, /Server error \(500\)/);
    return true;
  });
});

test("api keeps a hostile server error as a single line of plain text", async () => {
  const hostile = "<img src=x onerror=alert(1)>\nsecond line\n".repeat(40);
  global.fetch = async () => ({
    ok: false, status: 400, text: async () => JSON.stringify({ error: hostile }),
  });
  await assert.rejects(api("/api/x"), (err) => {
    assert.ok(err.message.length <= 300, "message is bounded");
    assert.ok(!err.message.includes("\n"), "message stays one line");
    return true;
  });
});

test("api reports an HTML error page as an unreadable answer, not a crash", async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "<html>502</html>" });
  await assert.rejects(api("/api/status"), (err) => {
    assert.equal(err.name, "ApiError");
    assert.match(err.message, /could not read/i);
    return true;
  });
});

test("api aborts an ordinary read that never answers", async () => {
  const signals = [];
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    signals.push(opts.signal);
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted"); err.name = "AbortError"; reject(err);
    });
  });
  await assert.rejects(api("/api/status", { timeout: 5 }), (err) => {
    assert.match(err.message, /did not answer/i);
    assert.equal(isApiAbort(err), false, "a timeout is a failure, not a cancellation");
    return true;
  });
  assert.equal(signals[0].aborted, true);
  assert.equal(API_TIMEOUT_MS, 15000);
});

test("api does not time out a job POST", async () => {
  let aborted = false;
  global.fetch = (url, opts) => new Promise((resolve) => {
    opts.signal.addEventListener("abort", () => { aborted = true; });
    setTimeout(() => resolve(jsonReply({ job_id: "j1", status: "working" })), 5);
  });
  const body = await api("/api/request", { method: "POST", timeout: 0 });
  assert.deepEqual(body, { job_id: "j1", status: "working" });
  assert.equal(aborted, false);
});

test("api reports a caller's abort as a cancellation, not a failure", async () => {
  const controller = new AbortController();
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted"); err.name = "AbortError"; reject(err);
    });
  });
  const pending = api("/api/bumpers", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => {
    assert.equal(isApiAbort(err), true);
    return true;
  });
});

test("api reports an unreachable server without leaking the exception object", async () => {
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(api("/api/status"), (err) => {
    assert.equal(err.status, 0);
    assert.match(err.message, /could not be reached/);
    assert.ok(!err.message.includes("TypeError"));
    return true;
  });
});

// A server that answers with headers and then stops sending. The 15s clock used
// to be cleared before the body was read, so this shape hung for ever: the
// panel kept saying loading and the poll never came back.
const stalledBody = () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });

test("api's deadline covers a body that never arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  global.fetch = async () => stalledBody();
  const pending = api("/api/status");
  await flush();
  t.mock.timers.tick(API_TIMEOUT_MS);
  await assert.rejects(pending, (err) => {
    assert.match(err.message, /did not answer in time/);
    assert.equal(isApiAbort(err), false, "a timeout is a failure, not a cancellation");
    return true;
  });
});

test("api reports a caller's abort during the body as a cancellation", async () => {
  const controller = new AbortController();
  global.fetch = async () => stalledBody();
  const pending = api("/api/bumpers", { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(pending, (err) => {
    assert.equal(isApiAbort(err), true, "a route change is a cancellation, not a failure");
    assert.match(err.message, /cancelled/i);
    return true;
  });
});

test("a body that arrives in time leaves no timer behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  global.fetch = async (url, opts) => { signals.push(opts.signal); return jsonReply({ ok: 1 }); };
  assert.deepEqual(await api("/api/status"), { ok: 1 });
  t.mock.timers.tick(API_TIMEOUT_MS * 4);
  await flush();
  assert.equal(signals[0].aborted, false,
               "the deadline came down with the answer, not minutes later");
});

test("the body reader still tolerates an empty body and a json()-only response",
     async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "" });
  assert.equal(await api("/api/x"), null, "a 200 with no body is still a 200");
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ a: 1 }) });
  assert.deepEqual(await api("/api/y"), { a: 1 });
});

// ---------------------------------------------------------------------------
// Panel states
// ---------------------------------------------------------------------------

test("a panel renders exactly one explicit state", () => {
  const el = new FakeNode("div");
  ["loading", "populated", "empty", "error", "stale"].forEach((state) => {
    renderPanelState(el, { state, message: "m" });
    assert.equal(el.dataset.state, state);
  });
  renderPanelState(el, { state: "loading" });
  assert.equal(el.getAttribute("aria-busy"), "true");
  assert.equal(el.hidden, false);
  renderPanelState(el, { state: "populated" });
  assert.equal(el.getAttribute("aria-busy"), "false");
  assert.equal(el.hidden, true, "a healthy populated panel says nothing extra");
  assert.equal(el.children.length, 0);
});

test("a panel error keeps hostile text as text and offers Retry", async () => {
  const el = new FakeNode("div");
  const hostile = '<img src=x onerror="globalThis.pwned=20">';
  let retried = 0;
  renderPanelState(el, { state: "error", message: hostile, onAction: () => { retried++; } });
  assert.equal(descendants(el).filter((n) => n.tagName === "IMG").length, 0);
  assert.ok(textOf(el).includes(hostile));
  const retry = descendants(el).find((n) => n.tagName === "BUTTON");
  assert.equal(retry.textContent, "Retry");
  await retry.click();
  assert.equal(retried, 1);
  assert.equal(globalThis.pwned, undefined);
});

test("an error state names the trouble in words, not only in colour", () => {
  const el = new FakeNode("div");
  renderPanelState(el, { state: "error", message: "boom" });
  assert.match(textOf(el), /Failed/);
  renderPanelState(el, { state: "stale", message: "boom", updatedAt: 1000, now: 61000 });
  assert.match(textOf(el), /Attention/);
});

test("a stale panel says how old the content it is still showing is", () => {
  const el = new FakeNode("div");
  renderPanelState(el, {
    state: "stale", message: "refresh failed", updatedAt: 1000, now: 121000,
  });
  assert.equal(el.dataset.state, "stale");
  assert.match(textOf(el), /2m ago/);
  assert.match(textOf(el), /refresh failed/);
});

test("an empty panel distinguishes an empty pool from a filtered-out one", () => {
  const el = new FakeNode("div");
  let cleared = 0;
  renderPanelState(el, { state: "empty", message: "nothing here yet" });
  assert.match(textOf(el), /nothing here yet/);
  assert.equal(descendants(el).filter((n) => n.tagName === "BUTTON").length, 0);

  renderPanelState(el, {
    state: "empty", message: "No rows match the current filters.",
    filtersActive: true, actionLabel: "Clear filters", onAction: () => { cleared++; },
  });
  const clear = descendants(el).find((n) => n.tagName === "BUTTON");
  assert.equal(clear.textContent, "Clear filters");
  clear.click();
  assert.equal(cleared, 1);
});

test("statusBadge pairs an icon with a word and keeps hostile detail as text", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=21">';
  const badge = statusBadge("healthy", hostile);
  assert.match(textOf(badge), /Healthy/);
  assert.equal(descendants(badge).filter((n) => n.tagName === "IMG").length, 0);
  assert.ok(textOf(badge).includes(hostile));
  const icon = descendants(badge).find((n) => n.className === "badge-icon");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.match(textOf(statusBadge("offline")), /Offline/);
  assert.equal(globalThis.pwned, undefined);
});

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

test("formatAge and formatDuration stay honest about missing values", () => {
  assert.equal(formatAge(1000, 1000), "just now");
  assert.equal(formatAge(1000, 31000), "30s ago");
  assert.equal(formatAge(1000, 121000), "2m ago");
  assert.equal(formatAge(1000, 7201000), "2h ago");
  assert.equal(formatAge(null), "an unknown time ago");
  assert.equal(formatDuration(4), "4s");
  assert.equal(formatDuration(95), "1m 35s");
  assert.equal(formatDuration(null), "unknown length");
  assert.equal(formatDuration("bogus"), "unknown length");
});

// ---------------------------------------------------------------------------
// Library: search cancellation, generations, panel truth
// ---------------------------------------------------------------------------

test("a superseded library search is aborted and its late answer discarded", async () => {
  const pending = [];
  global.fetch = (url, opts) => new Promise((resolve) => {
    pending.push({ url: String(url), signal: opts.signal, resolve });
  });

  STATE.library.filters.q = "old";
  const first = loadGrid(true);
  STATE.library.filters.q = "new";
  const second = loadGrid(true);

  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true, "the superseded read is cancelled");

  pending[1].resolve(jsonReply({
    count: 1, bumpers: [{ id: "n", type: "card", kind: "psa", title: "new result",
                          payload: { text: "new result" } }],
  }));
  await second;
  pending[0].resolve(jsonReply({
    count: 1, bumpers: [{ id: "o", type: "card", kind: "psa", title: "old result",
                          payload: { text: "old result" } }],
  }));
  await first;

  const text = textOf($("#grid"));
  assert.match(text, /new result/);
  assert.doesNotMatch(text, /old result/);
  assert.equal(STATE.library.items.length, 1);
});

test("typing does not fire a request per keystroke", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  global.fetch = (url) => { calls.push(String(url)); return new Promise(() => {}); };
  scheduleSearch("h");
  scheduleSearch("ha");
  scheduleSearch("harb");
  assert.equal(SEARCH_DEBOUNCE_MS, 250);
  t.mock.timers.tick(249);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /q=harb/);
});

test("a failed library read keeps the rows it has and marks them stale", async () => {
  global.fetch = async () => jsonReply({
    count: 1, bumpers: [{ id: "a", type: "card", kind: "psa", title: "kept",
                          payload: { text: "kept" } }],
  });
  await loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "populated");
  assert.equal($("#grid").children.length, 1);

  global.fetch = async () => { throw new Error("down"); };
  await loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "stale");
  assert.equal($("#grid").children.length, 1, "known-good rows are not cleared by a failure");
  assert.match(textOf($("#browse-state")), /could not be reached/);
});

test("a retry says it is working, not only that the rows are stale", async () => {
  global.fetch = async () => jsonReply({
    count: 1, bumpers: [{ id: "a", type: "card", kind: "psa", title: "kept",
                          payload: { text: "kept" } }],
  });
  await loadGrid(true);
  global.fetch = async () => { throw new Error("down"); };
  await loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "stale");

  let release;
  global.fetch = () => new Promise((resolve) => { release = resolve; });
  const retry = loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "loading",
               "a retry in flight is not reported as an idle stale panel");
  release(jsonReply({ count: 0, bumpers: [] }));
  await retry;
});

test("an empty first page says whether filters are hiding the rows", async () => {
  global.fetch = async () => jsonReply({ count: 0, bumpers: [] });
  await loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "empty");
  assert.doesNotMatch(textOf($("#browse-state")), /filters/);

  STATE.library.filters.kind = "psa";
  await loadGrid(true);
  assert.equal($("#browse-state").dataset.state, "empty");
  assert.match(textOf($("#browse-state")), /filter/i);
});

test("library reads ask for one bounded page and stay GETs", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    return jsonReply({ count: 0, bumpers: [] });
  };
  STATE.library.filters.kind = 'psa" onload="x';
  STATE.library.filters.q = "a&b=c";
  STATE.library.filters.state = "parked";
  await loadGrid(true);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /limit=24/);
  assert.match(calls[0].url, /kind=psa%22\+onload%3D%22x/);
  assert.match(calls[0].url, /q=a%26b%3Dc/);
  // The server's own `state` filter, sharing its SQL with /api/status's counts,
  // so an overview warning and the listing it links to cannot disagree.
  assert.match(calls[0].url, /state=parked/);
});

// ---------------------------------------------------------------------------
// Overview + visibility-gated refresh
// ---------------------------------------------------------------------------

test("a failed status read leaves the pool panel stale, never healthily blank", async () => {
  global.fetch = async () => jsonReply({
    total: 2, playable_now: 1, by_kind: { psa: 2 }, by_type: { card: 2 },
  });
  await loadStatus();
  assert.equal($("#pool-state").dataset.state, "populated");
  assert.match(textOf($("#status-pill")), /Healthy/);
  const totals = $("#totals").children.length;

  global.fetch = async () => { throw new Error("down"); };
  await loadStatus();
  assert.equal($("#pool-state").dataset.state, "stale");
  assert.equal($("#totals").children.length, totals, "the last good counts stay on screen");
  assert.match(textOf($("#status-pill")), /Offline/);
});

test("the periodic refresh does no work while the tab is hidden", async () => {
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return jsonReply({
    total: 0, playable_now: 0, by_kind: {}, by_type: {}, channels: {}, urls: {} }); };

  document.visibilityState = "hidden";
  await refreshTick();
  assert.deepEqual(calls, [], "a hidden tab polls nothing");

  document.visibilityState = "visible";
  await handleVisibilityChange();
  assert.ok(calls.some((u) => u.startsWith("/api/status")), "coming back refreshes at once");
  assert.ok(calls.some((u) => u.startsWith("/api/station")));
  assert.equal(REFRESH_MS, 20000);
});

test("short results are announced to assistive technology as well as logged", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=30">';
  announce(hostile);
  const live = $("#live-region");
  assert.equal(live.textContent, hostile);
  assert.equal(live.children.length, 0);
  assert.ok(logText().includes(hostile));
  assert.equal(globalThis.pwned, undefined);
});

// ---------------------------------------------------------------------------
// Routing: hash views, aria-current, deep links, per-route teardown
// ---------------------------------------------------------------------------

const OK_STATUS = {
  brand: "Bumparr", total: 6, playable_now: 5, parked: 1, dead: 0, unrendered: 0,
  by_kind: { psa: 3, trivia: 3 }, by_type: { card: 6 },
  profile: { version: 1, valid: true, source: "shipped-default" },
  music: { version: 1, valid: true, source: "shipped-default",
           enabled_beds: 2, compatibility: false },
  memory: { refresh_seconds: 3600, enabled_kinds: ["previously_on"],
            channel: "station:live", messages: { valid: true } },
};
const OK_STATION = {
  ffmpeg: true, conformed: 3, eligible: 3, pending: 0, urls: {},
  channels: { live: { now: null, next: null }, standby: { now: null, next: null } },
};

// Answers every read a view can make, so a test can assert on which ones a
// route actually issued rather than on a hand-fed single reply.
function stubRoutes(over) {
  const o = over || {};
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET" });
    if (u.startsWith("/api/status")) return jsonReply(Object.assign({}, OK_STATUS, o.status));
    if (u.startsWith("/api/station")) return jsonReply(Object.assign({}, OK_STATION, o.station));
    if (u.startsWith("/api/bumpers")) {
      return jsonReply(o.bumpers || { count: 0, total: 0, bumpers: [] });
    }
    return jsonReply({});
  };
  return calls;
}

const navLinks = () => $("#viewnav").children;
const currentNav = () => navLinks().filter((a) => a.getAttribute("aria-current") === "page")
  .map((a) => a.dataset.view);
const shownViews = () => ROUTES.filter((name) => $("#view-" + name).hidden === false);

test("an unknown hash lands on the overview without adding a history entry", async () => {
  stubRoutes();
  await applyHash("#/nowhere");
  assert.equal(STATE.route, DEFAULT_ROUTE);
  assert.deepEqual(replaced, ["#/overview"], "the URL is corrected in place, not pushed");
  assert.deepEqual(shownViews(), ["overview"]);
});

test("an empty hash lands on the overview", async () => {
  stubRoutes();
  await applyHash("");
  assert.equal(STATE.route, "overview");
  assert.deepEqual(shownViews(), ["overview"]);
});

test("the active view is the only one shown and the only one marked current", async () => {
  stubRoutes();
  await applyHash("#/station");
  assert.deepEqual(currentNav(), ["station"]);
  assert.deepEqual(shownViews(), ["station"]);

  await applyHash("#/library");
  assert.deepEqual(currentNav(), ["library"], "aria-current moves rather than accumulating");
  assert.deepEqual(shownViews(), ["library"]);
});

test("a deep link into the library reads its filters from the hash query", async () => {
  const calls = stubRoutes();
  await applyHash("#/library?state=parked&kind=trivia&type=card&q=harbour");
  assert.deepEqual(STATE.library.filters,
                   { q: "harbour", kind: "trivia", type: "card", state: "parked" });
  assert.equal($("#search").value, "harbour", "the visible control agrees with the filter");
  const listing = calls.find((c) => c.url.startsWith("/api/bumpers"));
  assert.equal(listing.method, "GET");
  assert.match(listing.url, /state=parked/);
  assert.match(listing.url, /kind=trivia/);
  assert.match(listing.url, /type=card/);
  assert.match(listing.url, /q=harbour/);
});

test("a hostile hash query cannot invent a filter the API does not have", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=40">';
  const calls = stubRoutes();
  await applyHash("#/library?state=" + encodeURIComponent(hostile) +
                  "&type=" + encodeURIComponent("javascript:alert(1)") +
                  "&kind=" + encodeURIComponent(hostile) +
                  "&q=" + encodeURIComponent(hostile));
  assert.equal(STATE.library.filters.state, "all", "an unknown state is not passed on");
  assert.equal(STATE.library.filters.type, null, "an unknown type is not passed on");
  const listing = calls.find((c) => c.url.startsWith("/api/bumpers"));
  assert.doesNotMatch(listing.url, /<img/);
  assert.match(listing.url, /kind=%3Cimg/);
  assert.equal(descendants($("#view-library")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("the overview reads nothing but the pool, the station and the job list",
     async () => {
  const calls = stubRoutes();
  await applyHash("#/overview");
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => c.method === "GET"), "the overview never writes");
  // /api/jobs is documented pure — it never starts, cancels or changes a job —
  // so listing the registry cannot create or advance a station timeline either.
  assert.ok(calls.every((c) => /^\/api\/(status|station|jobs)($|\?)/.test(c.url)),
            "the overview reads only /api/status, /api/station and /api/jobs: " +
            JSON.stringify(calls));
  assert.ok(calls.every((c) => !c.url.includes("advance")));
});

test("leaving a view stops its refresh and aborts the reads it left behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const signals = [];
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    signals.push({ url: String(url), signal: opts.signal });
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted"); err.name = "AbortError"; reject(err);
    });
  });
  applyHash("#/overview");
  await flush();
  assert.ok(signals.length >= 2, "the overview started its reads");
  assert.ok(signals.every((s) => s.signal.aborted === false));

  const left = signals.slice();
  applyHash("#/operations");
  await flush();
  assert.ok(left.every((s) => s.signal.aborted),
            "an in-flight read is cancelled when its view goes away");
  const before = signals.length;
  t.mock.timers.tick(REFRESH_MS * 3);
  await flush();
  assert.equal(signals.length, before, "the departed view's 20s refresh is cleared");
});

test("a route change during a status read leaves the new view a read of its own",
     async () => {
  // The cancel is synchronous but the rejection is not, so a `loading` flag
  // cleared only in the catch made the destination view believe a read was
  // still coming: Library opened with no kind chips and the header claimed the
  // profile was unavailable until the operator navigated a second time.
  const started = [];
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    started.push({ url: String(url), signal: opts.signal });
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted"); err.name = "AbortError"; reject(err);
    });
  });
  const statusReads = () => started.filter((s) => s.url.startsWith("/api/status"));
  applyHash("#/overview");
  await flush();
  assert.equal(statusReads().length, 1);

  applyHash("#/library");
  await flush();
  assert.equal(statusReads().length, 2, "the library reads the counts its chips need");
  assert.equal(statusReads()[0].signal.aborted, true, "the abandoned read is cancelled");
  assert.equal(statusReads()[1].signal.aborted, false, "the replacement is not");
  assert.equal(STATE.status.loading, true);
  // Leave nothing in flight: an unanswered read holds api()'s 15s timer, which
  // would keep the test process alive long after the assertions are done.
  app.exitRoute(STATE.route);
});

test("an abandoned read cannot clear the flags of the one that replaced it", async () => {
  const pending = [];
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    pending.push({ url: String(url), resolve });
    opts.signal.addEventListener("abort", () => {
      const err = new Error("aborted"); err.name = "AbortError"; reject(err);
    });
  });
  applyHash("#/overview");
  await flush();
  applyHash("#/library");
  await flush();
  // The first status read's rejection lands only now, after its replacement is
  // already in flight.
  await flush();
  assert.equal(STATE.status.loading, true, "the replacement is still reading");
  assert.equal(STATE.status.error, null, "an abandoned read reports no failure");
  app.exitRoute(STATE.route);
});

test("the overview refreshes on its own clock only while it is the visible view", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = stubRoutes();
  await applyHash("#/overview");
  const first = calls.length;
  t.mock.timers.tick(REFRESH_MS);
  await flush();
  assert.ok(calls.length > first, "the overview keeps itself up to date");
});

test("a view is re-rendered from state, never rebuilt from what the DOM still holds",
     async () => {
  stubRoutes({ bumpers: { count: 1, total: 1, bumpers: [
    { id: "a", type: "card", kind: "psa", title: "kept", payload: { text: "kept" } }] } });
  await applyHash("#/library");
  assert.equal($("#grid").children.length, 1);

  await applyHash("#/overview");
  $("#grid").replaceChildren();
  global.fetch = async (url) => {
    if (String(url).startsWith("/api/bumpers")) throw new Error("down");
    return jsonReply(String(url).startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  await applyHash("#/library");
  assert.equal($("#grid").children.length, 1, "the rows come back from STATE, not the DOM");
  assert.equal($("#browse-state").dataset.state, "stale");
});

// ---------------------------------------------------------------------------
// Overview: warnings, counts, configuration, now cards
// ---------------------------------------------------------------------------

test("overview warnings are derived from explicit fields and each links to the fix", () => {
  const warnings = overviewWarnings(
    { playable_now: 0, unrendered: 3,
      profile: { valid: false, source: "fallback-after-error" },
      music: { valid: false, source: "custom" } },
    { ffmpeg: false, pending: 5 },
    [{ id: "j1", label: "generate trivia", status: "error", result: "boom" }]);
  assert.deepEqual(warnings.map((w) => w.id),
                   ["no-playable", "unrendered", "conform-backlog", "ffmpeg",
                    "profile", "music", "failed-job"]);
  assert.deepEqual(warnings.map((w) => w.href),
                   ["#/library?state=playable", "#/library?state=unrendered",
                    "#/station", "#/station", "#/station", "#/station", "#/operations"]);
});

test("a healthy service raises no warnings and a missing field invents none", () => {
  assert.deepEqual(overviewWarnings(OK_STATUS, OK_STATION, []), []);
  assert.deepEqual(overviewWarnings({}, {}, []), [],
                   "an older server that reports nothing is not an alarm");
  assert.deepEqual(overviewWarnings(null, null, null), []);
});

test("a warning built from a hostile field stays text and keeps a safe link", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=41">';
  STATE.status.value = Object.assign({}, OK_STATUS, {
    playable_now: 0,
    profile: { valid: false, source: hostile },
  });
  STATE.status.updatedAt = 1000;
  renderOverview();
  const list = $("#warnings");
  assert.ok(list.children.length >= 2);
  const links = descendants(list).filter((n) => n.tagName === "A");
  assert.deepEqual(links.map((a) => a.href),
                   ["#/library?state=playable", "#/station"]);
  assert.ok(textOf(list).includes(hostile), "the server's own words are shown, as text");
  assert.equal(descendants(list).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("a clean overview says so instead of showing an empty warnings box", () => {
  STATE.status.value = OK_STATUS;
  STATE.station.value = OK_STATION;
  renderOverview();
  assert.equal($("#warnings-state").dataset.state, "empty");
  assert.match(textOf($("#warnings-state")), /Nothing needs attention/i);
  assert.equal($("#warnings").children.length, 0);
});

test("pool counts never invent a field the server did not send", () => {
  const full = poolCounts({ total: 10, playable_now: 4, parked: 3, dead: 2,
                            unrendered: 1, by_kind: { psa: 1 } });
  assert.deepEqual(full.boxes.map((b) => b.label),
                   ["total", "playable now", "parked", "dead", "unrendered", "kinds"]);
  assert.deepEqual(full.boxes.map((b) => b.n), [10, 4, 3, 2, 1, 1]);
  assert.deepEqual(full.missing, []);

  const older = poolCounts({ total: 10, playable_now: 4, by_kind: {} });
  assert.deepEqual(older.missing, ["parked", "dead", "unrendered"]);
  assert.ok(!older.boxes.some((b) => b.label === "parked"));
});

test("a missing count is reported as unavailable, not as a zero", () => {
  STATE.status.value = { total: 10, playable_now: 4, by_kind: {}, by_type: {} };
  renderOverview();
  assert.match(textOf($("#totals")), /Not available in this version/);
  assert.equal($("#totals").children.filter((n) => n.className === "num").length, 3,
               "only the counts the server actually sent get a number");
});

test("configuration reports source and validity, or says the field is missing", () => {
  const lines = configLines(OK_STATUS);
  assert.deepEqual(lines.map((l) => l.label), ["profile", "music"]);
  assert.match(lines[0].text, /shipped-default/);
  assert.equal(lines[0].level, "healthy");
  assert.match(lines[1].text, /2 bed/);

  const none = configLines({});
  assert.deepEqual(none.map((l) => l.text),
                   ["Not available in this version.", "Not available in this version."]);
});

test("configuration keeps a hostile source string as text", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=42">';
  STATE.status.value = Object.assign({}, OK_STATUS, {
    profile: { version: 1, valid: false, source: hostile },
  });
  renderOverview();
  assert.ok(textOf($("#config-summary")).includes(hostile));
  assert.equal(descendants($("#config-summary")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("now cards report what is on air without asking the station to advance", () => {
  const cards = stationNow({ channels: {
    live: { now: { title: "Ident", kind: "station_id", ends_at: 0 } },
    standby: { now: null },
  } });
  assert.deepEqual(cards.map((c) => c.channel), ["live", "standby"]);
  assert.match(cards[0].detail, /Ident/);
  assert.match(cards[1].detail, /off air/);
  assert.deepEqual(stationNow(null).map((c) => c.detail),
                   ["the station could not be read", "the station could not be read"]);
});

test("a now card keeps a hostile title as text", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=43">';
  STATE.station.value = { ffmpeg: true, conformed: 1, eligible: 1, pending: 0,
    channels: { live: { now: { title: hostile, kind: "psa", ends_at: 0 } },
                standby: { now: null } } };
  STATE.status.value = OK_STATUS;
  renderOverview();
  assert.ok(textOf($("#ov-now")).includes(hostile));
  assert.equal(descendants($("#ov-now")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("the overview station summary marks known data stale rather than blanking it",
     async () => {
  global.fetch = async () => jsonReply(OK_STATION);
  await app.loadStation();
  assert.equal($("#ov-station-state").dataset.state, "populated");
  const summary = textOf($("#ov-station"));
  assert.match(summary, /3 \/ 3 conformed/);

  global.fetch = async () => { throw new Error("down"); };
  await app.loadStation();
  assert.equal($("#ov-station-state").dataset.state, "stale");
  assert.equal($("#station-state").dataset.state, "stale");
  assert.equal(textOf($("#ov-station")), summary, "the last known summary stays on screen");
});

// ---------------------------------------------------------------------------
// Jobs this page started: header count, recent list, warning
// ---------------------------------------------------------------------------

test("the recent jobs list is honest about having none", () => {
  renderJobs();
  assert.equal($("#jobs-state").dataset.state, "empty");
  assert.match(textOf($("#jobs-state")), /No jobs started from this page/);
  assert.equal($("#jobs-list").children.length, 0);
});

test("recent jobs are newest first and bounded to five", () => {
  for (let i = 0; i < 7; i++) finishJob(recordJob("job " + i), "done", "ok");
  const recent = recentJobs(STATE.jobs.items);
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.map((j) => j.label),
                   ["job 6", "job 5", "job 4", "job 3", "job 2"]);
  renderJobs();
  assert.equal($("#jobs-list").children.length, 5);
  assert.equal($("#jobs-state").dataset.state, "populated");
});

test("a job's label and result reach the list as text, never as markup", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=44">';
  finishJob(recordJob(hostile), "error", hostile);
  renderJobs();
  assert.ok(textOf($("#jobs-list")).includes(hostile));
  assert.equal(descendants($("#jobs-list")).filter((n) => n.tagName === "IMG").length, 0);
  assert.match(textOf($("#jobs-list")), /Failed/);
  assert.equal(globalThis.pwned, undefined);
});

test("the header counts the jobs this page is still waiting on", () => {
  const a = recordJob("first");
  recordJob("second");
  renderChrome();
  assert.match(textOf($("#header-jobs")), /2 jobs running/);
  finishJob(a, "done", "ok");
  renderChrome();
  assert.match(textOf($("#header-jobs")), /1 job running/);
});

test("an action registers the job it started and the outcome it got", async () => {
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") return jsonReply({ status: "done", result: "made 20" });
    return jsonReply(String(url).startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  await doAction("/api/generate/trivia?n=20", "generate trivia");
  assert.equal(STATE.jobs.items.length, 1);
  assert.equal(STATE.jobs.items[0].label, "generate trivia");
  assert.equal(STATE.jobs.items[0].status, "done");
  assert.match(String(STATE.jobs.items[0].result), /made 20/);
  assert.deepEqual(overviewWarnings(OK_STATUS, OK_STATION, STATE.jobs.items), [],
                   "a job that worked is not a warning");
});

test("a failed job becomes an overview warning that points at Operations", async () => {
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") throw new TypeError("Failed to fetch");
    return jsonReply(String(url).startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  await doAction("/api/generate/trivia?n=20", "generate trivia");
  assert.equal(STATE.jobs.items[0].status, "error");
  const warnings = overviewWarnings(OK_STATUS, OK_STATION, STATE.jobs.items);
  assert.deepEqual(warnings.map((w) => w.id), ["failed-job"]);
  assert.equal(warnings[0].href, "#/operations");
});

// ---------------------------------------------------------------------------
// Header and footer chrome
// ---------------------------------------------------------------------------

test("the footer reports no version rather than inventing one", () => {
  STATE.status.value = OK_STATUS;
  renderChrome();
  assert.equal($("#footer-version").textContent, "version not reported");
  STATE.status.value = Object.assign({}, OK_STATUS, { version: "1.4.0" });
  renderChrome();
  assert.equal($("#footer-version").textContent, "version 1.4.0");
});

test("the header shows profile validity and how old the last read is", () => {
  STATE.status.value = OK_STATUS;
  STATE.status.updatedAt = 1000;
  renderChrome(121000);
  assert.match(textOf($("#header-profile")), /Healthy/);
  assert.match(textOf($("#header-profile")), /shipped-default/);
  assert.match(textOf($("#header-refresh")), /2m ago/);

  STATE.status.value = Object.assign({}, OK_STATUS, {
    profile: { version: 1, valid: false, source: "fallback-after-error" } });
  renderChrome(121000);
  assert.match(textOf($("#header-profile")), /Attention/);
});

test("the header says when the server does not report a profile at all", () => {
  STATE.status.value = { total: 1, playable_now: 1, by_kind: {}, by_type: {} };
  renderChrome();
  assert.match(textOf($("#header-profile")), /Not available in this version/);
});

test("every route has a nav link and a view to show", () => {
  assert.deepEqual(navLinks().map((a) => a.dataset.view), ROUTES);
  assert.deepEqual(navLinks().map((a) => a.href), ROUTES.map((n) => "#/" + n));
  ROUTES.forEach((name) => {
    assert.ok($("#view-" + name), "index.html is missing #view-" + name);
  });
});

test("the service summary and the shell keep hostile server strings as text", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=45">';
  STATE.status.value = { brand: hostile, version: hostile, total: 1, playable_now: 1,
                         by_kind: {}, by_type: {},
                         profile: { version: 1, valid: true, source: hostile } };
  STATE.status.updatedAt = 1000;
  renderOverview();
  const shell = [$("#service-summary"), $("#header-profile"), $("#footer-version")];
  shell.forEach((el) => {
    assert.equal(descendants(el).filter((n) => n.tagName === "IMG").length, 0);
  });
  assert.ok(textOf($("#service-summary")).includes(hostile));
  assert.ok(textOf($("#header-profile")).includes(hostile));
  assert.equal($("#footer-version").textContent, "version " + hostile);
  assert.equal(globalThis.pwned, undefined);
});

test("a station read that never answers leaves the overview honest, not blank", async () => {
  stubRoutes();
  await applyHash("#/overview");
  const populated = textOf($("#ov-station"));

  global.fetch = async () => { throw new Error("down"); };
  await app.loadStation();
  assert.equal($("#ov-station-state").dataset.state, "stale");
  assert.equal(textOf($("#ov-station")), populated);
  assert.match(textOf($("#ov-station-state")), /last known data/i);
});

test("the composer and operations views ask for nothing that could advance playout",
     async () => {
  const calls = stubRoutes();
  await applyHash("#/composer");
  await applyHash("#/operations");
  assert.ok(calls.every((c) => c.method === "GET"));
  // /api/jobs is documented pure — it never starts, cancels or changes a job —
  // so Operations may list the registry without touching a timeline.
  assert.ok(calls.every((c) => /^\/api\/(status|jobs)($|\?)/.test(c.url)),
            "entering a view reads the header's status and the job list, and " +
            "nothing else: " + JSON.stringify(calls));
});

test("back and forward between two deep links restore both filter sets", async () => {
  const calls = stubRoutes();
  await applyHash("#/library?state=parked");
  assert.equal(STATE.library.filters.state, "parked");
  await applyHash("#/library?kind=trivia");
  assert.equal(STATE.library.filters.state, "all", "the new hash owns every filter");
  assert.equal(STATE.library.filters.kind, "trivia");
  await applyHash("#/library?state=parked");
  assert.equal(STATE.library.filters.state, "parked");
  assert.equal(STATE.library.filters.kind, null);
  const listings = calls.filter((c) => c.url.startsWith("/api/bumpers"));
  assert.equal(listings.length, 3, "each hash change re-reads its own page");
});

test("re-entering the view already on screen does no work", async () => {
  const calls = stubRoutes();
  await applyHash("#/library?state=parked");
  const before = calls.length;
  await applyHash("#/library?state=parked");
  assert.equal(calls.length, before, "clicking the current link does not re-read");
});

test("the skip link is an in-page jump, not an unknown route", async () => {
  stubRoutes();
  await applyHash("#/station");
  replaced.length = 0;
  assert.equal(applyHash("#main"), null, "a fragment that names a real element is left alone");
  assert.deepEqual(replaced, [], "and the view it was used from is not taken away");
  assert.deepEqual(shownViews(), ["station"]);

  await applyHash("#not-an-element");
  assert.deepEqual(replaced, ["#/overview"], "a fragment naming nothing is a bad route");
  assert.deepEqual(shownViews(), ["overview"]);
});

test("a different set of filters does not show the previous answer's rows", async () => {
  stubRoutes({ bumpers: { count: 1, total: 1, bumpers: [
    { id: "a", type: "card", kind: "psa", title: "trivia row", payload: { text: "row" } }] } });
  await applyHash("#/library?kind=trivia");
  assert.equal($("#grid").children.length, 1);

  let release;
  global.fetch = (url) => new Promise((resolve) => {
    if (String(url).startsWith("/api/bumpers")) { release = resolve; return; }
    resolve(jsonReply(OK_STATUS));
  });
  applyHash("#/library?kind=psa");
  await flush();
  assert.equal($("#grid").children.length, 0,
               "rows answering the old filter are not shown under the new one");
  assert.equal($("#browse-state").dataset.state, "loading");
  release(jsonReply({ count: 0, total: 0, bumpers: [] }));
  await flush();
});

// ---------------------------------------------------------------------------
// Unread is not unsupported
// ---------------------------------------------------------------------------

test("before the first read the shell says nothing has been read, not that a field is missing",
     () => {
  renderOverview();
  const unread = [$("#header-profile"), $("#config-summary"), $("#service-summary")];
  unread.forEach((el) => {
    assert.doesNotMatch(textOf(el), /Not available in this version/,
                        "a server that has not answered has claimed no such thing");
    assert.match(textOf(el), /not read yet/);
  });
});

test("a failed status read is never reported as a server that lacks the field", async () => {
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await applyHash("#/overview");
  assert.equal(STATE.status.value, null);
  assert.equal($("#pool-state").dataset.state, "error");
  assert.match(textOf($("#pool-state")), /could not be reached/,
               "the failure itself is still spelled out once");
  [$("#header-profile"), $("#config-summary"), $("#service-summary")].forEach((el) => {
    assert.doesNotMatch(textOf(el), /Not available in this version/);
    assert.match(textOf(el), /not read/);
  });
  assert.equal($("#warnings-state").dataset.state, "error");
  assert.match(textOf($("#warnings-state")), /nothing has been checked/i,
               "an unread overview does not look like a clean bill of health");
});

test("a read that landed without the field is the one case that says unavailable", () => {
  STATE.status.value = { total: 1, playable_now: 1, by_kind: {}, by_type: {} };
  STATE.status.updatedAt = 1000;
  renderOverview();
  assert.match(textOf($("#header-profile")), /Not available in this version/);
  assert.match(textOf($("#config-summary")), /Not available in this version/);
  assert.doesNotMatch(textOf($("#config-summary")), /not read/);
});

// ---------------------------------------------------------------------------
// F2: library toolbar, results, media, inspector, reversible curation
// ---------------------------------------------------------------------------

// The detail route returns every registry column, `payload` as the stored JSON
// STRING (not an object, unlike the listing), plus media_url, creative and —
// with explain=true — selection.
const DETAIL = {
  id: "card:psa:abc", type: "card", kind: "psa", source: "generated",
  uri: "bumpers/psa/abc.mp4", duration: 12, title: "Stay tuned",
  payload: JSON.stringify({ lines: ["Back after this."], answer: "",
                            source: "operator", bg_creator: "A Photographer",
                            bg_title: "Harbour at dusk" }),
  tags: "night,calm", weight: 1.5, enabled: 1, health: "ok", fail_count: 0,
  last_played: 1700000500, play_count: 4, created_at: 1700000000,
  media_url: "/media/bumpers/psa/abc.mp4",
  creative: { family: "psa", roles: ["filler"], energy: "calm", audio: "bed",
              text_heavy: true, template: "minimal_center", render_seed: 7,
              brand_mode: "reveal", music_id: null },
  music_credits: { id: "night-room-01", title: "Night Room", creator: "Example",
                   license: "CC0-1.0" },
  selection: { eligible_now: true, reasons: ["eligible"],
               factors: { base: 1, season: 1, daypart: 1, recency: 1,
                          affinity: 1, fatigue: 1, score: 1 } },
};

const isDetailUrl = (u) => /^\/api\/bumpers\/[^?]/.test(u) &&
  !u.startsWith("/api/bumpers/random") && !u.startsWith("/api/bumpers/fill");

// Answers the reads an inspector session makes. `over.detail` overrides the
// row; `over.reply` is the whole answer to any POST/DELETE.
function stubInspector(over) {
  const o = over || {};
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    calls.push({ url: u, method });
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    if (isDetailUrl(u) && method === "GET") {
      return jsonReply(Object.assign({}, DETAIL, o.detail));
    }
    // GET only: a DELETE of /api/bumpers/{id} is a mutation, and answering it
    // with a listing body would hide whatever the endpoint really said back.
    if (u.startsWith("/api/bumpers") && method === "GET") {
      return jsonReply(o.bumpers || { count: 0, total: 0, bumpers: [] });
    }
    return jsonReply(o.reply || { status: "done", result: "ok" });
  };
  return calls;
}

const inspectorText = () => textOf($("#inspector-body"));
const inspectorButton = (label) => descendants($("#inspector"))
  .find((n) => n.tagName === "BUTTON" && n.textContent === label);

// --- toolbar ---------------------------------------------------------------

test("every library filter is a labelled control the toolbar owns", () => {
  // Hover chips are gone: each filter is a real control index.html labels, and
  // the fake document only proves anything if it carries the same ones.
  ["#search", "#filter-type", "#filter-kind", "#filter-state", "#page-size",
   "#density", "#clear-filters", "#library-counts", "#drop-kind"].forEach((sel) => {
    const el = $(sel);
    assert.ok(el, "index.html is missing " + sel);
    assert.ok(matchesSelector(el, "#view-library " + sel),
              sel + " belongs to the library view");
  });
});

test("the kind list comes from the status counts and stays text", () => {
  const hostile = "<option>pwn</option>";
  STATE.status.value = Object.assign({}, OK_STATUS,
    { by_kind: { trivia: 12, [hostile]: 1 } });
  renderFilters();
  const options = $("#filter-kind").children;
  // Busiest kind first: the counts are the ordering, not the alphabet.
  assert.deepEqual(options.map((o) => o.value), ["", "trivia", hostile]);
  assert.match(options[1].textContent, /^trivia \(12\)/);
  assert.equal(options[2].textContent, hostile + " (1)");
  assert.ok(options.every((o) => o.children.length === 0),
            "nothing was parsed out of the hostile kind");
});

test("a kind the counts do not list is still offered, not silently dropped", () => {
  // A deep link can name a kind that has since gone to zero. Rebuilding the
  // select without it would leave the control reading "All kinds" while the
  // listing was still filtered by it.
  STATE.status.value = Object.assign({}, OK_STATUS, { by_kind: { trivia: 2 } });
  STATE.library.filters.kind = "webcam";
  renderFilters();
  assert.deepEqual($("#filter-kind").children.map((o) => o.value),
                   ["", "webcam", "trivia"]);
  assert.equal($("#filter-kind").value, "webcam");
});

test("changing a filter writes it back to the hash in place", async () => {
  const calls = stubRoutes();
  await applyHash("#/library");
  replaced.length = 0;
  await setFilter("state", "parked");
  assert.deepEqual(replaced, ["#/library?state=parked"],
                   "replace, not assign: a filter change is not a history entry");
  await setFilter("kind", "trivia");
  assert.equal(replaced[replaced.length - 1], "#/library?state=parked&kind=trivia");
  assert.equal(libraryHash(), "#/library?state=parked&kind=trivia");
  const listings = calls.filter((c) => c.url.startsWith("/api/bumpers?"));
  assert.ok(listings.length >= 2);
  assert.match(listings[listings.length - 1].url, /kind=trivia/);
});

test("the hash a filter change wrote does not re-enter the view", async () => {
  // location.replace fires a hashchange of its own. Left alone it would tear
  // the view down and read the page again after every filter change.
  const calls = stubRoutes();
  await applyHash("#/library");
  await setFilter("state", "parked");
  const before = calls.length;
  await applyHash(global.location.hash);
  assert.equal(calls.length, before, "the router recognises the hash it just wrote");
  assert.equal(STATE.library.filters.state, "parked");
});

test("a deep link reproduces exactly the filters the toolbar wrote", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  stubRoutes();
  await applyHash("#/library");
  await setFilter("state", "parked");
  await setFilter("type", "card");
  await setFilter("kind", "trivia");
  scheduleSearch("harbour");
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  const written = libraryHash();
  assert.equal(written, "#/library?state=parked&type=card&kind=trivia&q=harbour");

  resetStateForTests();
  BODY = buildDocument();
  await applyHash(written);
  assert.deepEqual(STATE.library.filters,
                   { q: "harbour", kind: "trivia", type: "card", state: "parked" });
});

test("totals are reported as matched and loaded, and paginate", async () => {
  const rows = (n, from) => Array.from({ length: n }, (_, i) => ({
    id: "r" + (from + i), type: "card", kind: "psa", title: "row " + (from + i),
    enabled: 1, health: "ok", media_url: "/m/x.mp4", payload: {} }));
  global.fetch = async (url) => {
    if (String(url).startsWith("/api/bumpers")) {
      return jsonReply({ count: 24, total: 30, bumpers: rows(24, 0) });
    }
    return jsonReply(OK_STATUS);
  };
  await loadGrid(true);
  assert.deepEqual(libraryCounts(), { loaded: 24, total: 30, hasMore: true });
  assert.match(textOf($("#library-counts")), /Showing 24 of 30/);
  assert.equal($("#more").hidden, false);

  global.fetch = async (url) => {
    if (String(url).startsWith("/api/bumpers")) {
      return jsonReply({ count: 6, total: 30, bumpers: rows(6, 24) });
    }
    return jsonReply(OK_STATUS);
  };
  await loadGrid(false);
  assert.deepEqual(libraryCounts(), { loaded: 30, total: 30, hasMore: false });
  assert.equal($("#grid").children.length, 30, "load more appends rather than replaces");
  assert.equal($("#more").hidden, true);
});

test("a server that reports no total says so instead of guessing one", async () => {
  global.fetch = async () => jsonReply({ count: 1, bumpers: [
    { id: "a", type: "card", kind: "psa", title: "x", enabled: 1, payload: {} }] });
  await loadGrid(true);
  assert.equal(libraryCounts().total, null);
  assert.match(textOf($("#library-counts")), /Not available in this version/);
  assert.doesNotMatch(textOf($("#library-counts")), /of 0/);
});

test("the page size is bounded by the UI maximum", async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return jsonReply({ count: 0, total: 0, bumpers: [] });
  };
  assert.deepEqual(PAGE_SIZES, [24, 48, 100]);
  await setPageSize("48");
  assert.match(calls[calls.length - 1], /limit=48/);
  await setPageSize("5000");
  assert.equal(STATE.library.pageSize, 100, "the UI never asks for more than 100");
  assert.match(calls[calls.length - 1], /limit=100/);
  await setPageSize("nonsense");
  assert.equal(STATE.library.pageSize, PAGE, "an unreadable size falls back to the default");
});

test("density is the one thing remembered locally, and never a response", () => {
  assert.deepEqual(LIBRARY_DENSITIES, ["grid", "list"]);
  setDensity("list");
  assert.equal(stored.get("bumparr.library.density"), "list");
  assert.equal(stored.size, 1, "nothing but the density is written");
  assert.ok($("#grid").classList.contains("grid-list"));
  setDensity("something else");
  assert.equal(STATE.library.density, "grid", "an unknown density falls back to grid");
  assert.ok(!$("#grid").classList.contains("grid-list"));
});

test("a browser that refuses local storage still renders the library", async () => {
  storageThrows = true;
  stubRoutes();
  await applyHash("#/library");
  assert.equal(STATE.library.density, "grid");
  setDensity("list");
  assert.equal(STATE.library.density, "list", "the session still honours the choice");
});

test("Clear filters empties every filter and the hash query with them", async () => {
  stubRoutes();
  await applyHash("#/library?state=parked&kind=trivia&type=card&q=harbour");
  replaced.length = 0;
  await clearFilters();
  assert.deepEqual(STATE.library.filters, { q: "", kind: null, type: null, state: "all" });
  assert.equal($("#search").value, "");
  assert.deepEqual(replaced, ["#/library"]);
});

// --- media -----------------------------------------------------------------

test("only one preview plays at a time", async () => {
  STATE.library.items = ["a", "b"].map((id) => ({
    id, type: "video", kind: "ambient", title: id, duration: 8,
    media_url: "/media/" + id + ".mp4", enabled: 1, health: "ok" }));
  app.renderLibrary();
  const videos = descendants($("#grid")).filter((n) => n.tagName === "VIDEO");
  assert.equal(videos.length, 2);
  assert.ok(videos.every((v) => v.preload === "metadata"), "metadata only, never the file");
  assert.ok(videos.every((v) => v.muted === true), "sound is never started for anyone");

  await videos[0].play();
  assert.deepEqual(videos.map((v) => v.paused), [false, true]);
  await videos[1].play();
  assert.deepEqual(videos.map((v) => v.paused), [true, false],
                   "starting a second preview stops the first");
});

test("a live stream is never opened until Play is pressed", async () => {
  const card = cardEl({ id: "stream:cam", type: "stream", kind: "webcam",
                        title: "harbour", enabled: 1, health: "ok",
                        media_url: "/api/stream/stream%3Acam/index.m3u8" });
  assert.equal(descendants(card).filter((n) => n.tagName === "VIDEO").length, 0,
               "no element holds the stream URL before the operator asks");
  assert.match(textOf(card), /LIVE/);
  const play = descendants(card).find(
    (n) => n.tagName === "BUTTON" && /play/i.test(n.textContent));
  assert.ok(play, "a stream card offers Play");
  assert.match(textOf(card), /real client|advance/i,
               "opening HLS is a real client, and the card says so before Play");
  await play.click();
  const video = descendants(card).find((n) => n.tagName === "VIDEO");
  assert.ok(video, "Play is what creates the player");
  assert.equal(video.src, "/api/stream/stream%3Acam/index.m3u8");
});

test("leaving the library pauses and detaches the media it was showing", async () => {
  STATE.library.items = [{ id: "a", type: "video", kind: "ambient", title: "a",
                           media_url: "/media/a.mp4", enabled: 1, health: "ok" }];
  app.renderLibrary();
  const video = descendants($("#grid")).find((n) => n.tagName === "VIDEO");
  await video.play();
  assert.equal(video.paused, false);
  VIEWS.library.exit();
  assert.equal(video.paused, true, "a departed view leaves nothing playing");
  assert.equal(video.src, "", "and nothing still buffering");
  assert.ok(video.loads >= 1, "the element is told to let go of the stream");
});

// --- inspector -------------------------------------------------------------

test("the inspector reads the row with explain only when it opens", async () => {
  const calls = stubInspector();
  STATE.library.items = [{ id: "card:psa:abc", type: "card", kind: "psa",
                           title: "Stay tuned", enabled: 1, health: "ok",
                           media_url: "/m/x.mp4", payload: {} }];
  app.renderLibrary();
  assert.deepEqual(calls, [], "rendering the grid explains nothing");
  const inspect = descendants($("#grid")).find(
    (n) => n.tagName === "BUTTON" && n.className.includes("pv-inspect"));
  await inspect.click();
  await flush();
  const detail = calls.filter((c) => isDetailUrl(c.url));
  assert.equal(detail.length, 1);
  assert.equal(detail[0].method, "GET");
  assert.equal(detail[0].url, "/api/bumpers/card%3Apsa%3Aabc?explain=true");
});

test("the inspector shows the facts the plan lists, as text", async () => {
  stubInspector();
  await openInspector("card:psa:abc");
  const text = inspectorText();
  [/card:psa:abc/, /Stay tuned/, /psa/, /generated/, /12s/, /night,calm/,
   /Back after this\./, /calm/, /minimal_center/, /reveal/, /eligible/,
   /base/, /score/, /A Photographer/, /Night Room/, /play count/i,
   /created/, /last played/].forEach((re) => {
    assert.match(text, re, "the inspector is missing " + re);
  });
  // The media URL is a read-only field, not prose: it is there to be copied.
  const url = descendants($("#inspector-body")).find((n) => n.tagName === "INPUT");
  assert.equal(url.value, "/media/bumpers/psa/abc.mp4");
  assert.equal(url.readOnly, true);
  assert.equal(descendants($("#inspector")).filter((n) => n.tagName === "SCRIPT").length, 0);
});

test("the inspector keeps hostile detail as text, never as markup", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=50">';
  stubInspector({ detail: {
    title: hostile, kind: hostile, source: hostile, tags: hostile,
    payload: JSON.stringify({ lines: [hostile], answer: hostile,
                              bg_creator: hostile }),
    creative: { family: hostile, roles: [hostile], energy: hostile,
                audio: hostile, text_heavy: false, template: hostile,
                brand_mode: hostile, render_seed: 1, music_id: null },
    music_credits: { id: hostile, title: hostile, creator: hostile, license: hostile },
    selection: { eligible_now: false, reasons: [hostile],
                 factors: { base: 1, score: 0 } },
  } });
  await openInspector("card:psa:abc");
  const dlg = $("#inspector");
  assert.ok(textOf(dlg).includes(hostile), "the server's own words are shown, as text");
  assert.equal(descendants(dlg).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("a detail body without the newer blocks says unavailable, never blank", async () => {
  stubInspector({ detail: { creative: null, music_credits: null, selection: null } });
  await openInspector("card:psa:abc");
  const text = inspectorText();
  assert.ok(text.split(NOT_AVAILABLE).length - 1 >= 3,
            "each missing block says so rather than showing nothing: " + text);
  assert.doesNotMatch(text, /undefined/);
});

test("the inspector's primary action is the reversible one for the state", async () => {
  const cases = [
    [{}, "Disable from rotation"],
    [{ enabled: 0 }, "Enable"],
    [{ health: "dead" }, "Run revive (all retired)"],
    [{ uri: null, media_url: null }, "Render card"],
  ];
  for (const [over, label] of cases) {
    stubInspector({ detail: over });
    await openInspector("card:psa:abc");
    assert.ok(inspectorButton(label), "expected the primary action " + label +
              " for " + JSON.stringify(over));
    closeInspector();
  }
});

test("the dead-item action says it rechecks every retired row, not just this one",
     async () => {
  const calls = stubInspector({ detail: { health: "dead", enabled: 0 },
                                reply: { checked: 4, restored: 1, still_dead: 3,
                                         skipped_streams: 0 } });
  await openInspector("card:psa:abc");
  assert.match(inspectorText(), /every retired item/i);
  await inspectorButton("Run revive (all retired)").click();
  await flush();
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.url), ["/api/pool/revive"]);
  assert.match(logText(), /1 restored/);
});

test("Render card starts a job that shows up in Recent jobs", async () => {
  const calls = stubInspector({ detail: { uri: null, media_url: null },
                                reply: { status: "done", result: "rendered 1" } });
  await openInspector("card:psa:abc");
  await inspectorButton("Render card").click();
  await flush();
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.url),
                   ["/api/render/cards?bumper_id=card%3Apsa%3Aabc"]);
  assert.equal(STATE.jobs.items.length, 1);
  assert.equal(STATE.jobs.items[0].status, "done");
  renderJobs();
  assert.match(textOf($("#jobs-list")), /render card/i);
});

test("disable escapes the id and reports the server's warning", async () => {
  const calls = stubInspector({ reply: { id: "x", enabled: false, changed: true,
                                         warning: "the rotation enables it again" } });
  await disableBumper({ id: "card:on_this_day/x y", title: "moon" });
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.url),
                   ["/api/pool/disable?bumper_id=card%3Aon_this_day%2Fx%20y"]);
  assert.match(logText(), /disabled moon — the rotation enables it again/);
  assert.match($("#live-region").textContent, /the rotation enables it again/);
});

test("a mutation refreshes the row it changed without resetting filters or paging",
     async () => {
  const listing = { count: 2, total: 2, bumpers: [
    { id: "card:psa:abc", type: "card", kind: "psa", title: "Stay tuned",
      enabled: 1, health: "ok", media_url: "/m/a.mp4", payload: {} },
    { id: "other", type: "card", kind: "psa", title: "Other", enabled: 1,
      health: "ok", media_url: "/m/b.mp4", payload: {} }] };
  const calls = stubInspector({ bumpers: listing,
    reply: { id: "card:psa:abc", enabled: false, changed: true } });
  STATE.library.filters.kind = "psa";
  await loadGrid(true);
  const offset = STATE.library.offset;
  const listings = () => calls.filter((c) => c.url.startsWith("/api/bumpers?")).length;
  const before = listings();

  await openInspector("card:psa:abc");
  await inspectorButton("Disable from rotation").click();
  await flush();

  assert.equal(listings(), before, "the grid is not re-read out from under the operator");
  assert.equal(STATE.library.offset, offset);
  assert.equal(STATE.library.filters.kind, "psa");
  assert.equal(STATE.library.items.length, 2);
  assert.equal(STATE.library.items[0].enabled, 0, "only the affected row changed");
  assert.equal(STATE.library.items[1].enabled, 1);
  assert.match(badgeText($("#grid").children[0]), /parked/);
  assert.ok(calls.some((c) => c.url.startsWith("/api/status")), "the counts are refreshed");
});

// The Clipboard API, swapped per test. Node ships a `navigator` with no
// `clipboard` on it, which is exactly the shape a browser without permission
// presents, so the fallback path needs no stubbing at all.
function stubClipboard(writeText) {
  Object.defineProperty(globalThis, "navigator", {
    value: writeText ? { clipboard: { writeText } } : {},
    configurable: true, writable: true,
  });
}
const urlField = () => descendants($("#inspector-body"))
  .find((n) => n.tagName === "INPUT" && n.className === "url");
const copyResult = () => textOf(descendants($("#inspector-body"))
  .find((n) => String(n.className).split(" ").includes("insp-copy")) || new FakeNode("p"));

test("the media URL is copyable, and says so when it worked", async () => {
  const written = [];
  stubClipboard(async (text) => { written.push(text); });
  stubInspector();
  await openInspector("card:psa:abc");
  const copy = inspectorButton("Copy");
  assert.ok(copy, "the inspector offers a copy control, not just a field");
  assert.equal(urlField().value, "/media/bumpers/psa/abc.mp4");

  await copy.click();
  await flush();
  assert.deepEqual(written, ["/media/bumpers/psa/abc.mp4"],
                   "the whole URL reaches the clipboard, unaltered");
  assert.match(copyResult(), /Healthy/, "the outcome is a state, not just colour");
  assert.match(copyResult(), /copied/i, "and it is visible inside the dialog");
  assert.match($("#live-region").textContent, /copied/i, "and announced");
});

test("a clipboard the browser refuses falls back to a selection and says so",
     async () => {
  stubClipboard(async () => { throw new Error("denied"); });
  stubInspector();
  await openInspector("card:psa:abc");
  await inspectorButton("Copy").click();
  await flush();
  assert.equal(urlField().selected, true, "the URL is selected to copy by hand");
  assert.match(copyResult(), /Attention/, "a refusal is not reported as a success");
  assert.match(copyResult(), /keyboard/i, "and it says what to do instead");
  assert.match($("#live-region").textContent, /keyboard/i);
});

test("a browser with no Clipboard API at all still offers a way to copy",
     async () => {
  stubClipboard(null);
  stubInspector();
  await openInspector("card:psa:abc");
  await inspectorButton("Copy").click();
  await flush();
  assert.equal(urlField().selected, true);
  assert.match(copyResult(), /Attention/);
  assert.match(copyResult(), /keyboard/i);
});

test("a hostile media URL reaches the clipboard as a value, never as markup",
     async () => {
  const hostile = '/media/x.mp4"><img src=x onerror="globalThis.pwned=53">';
  const written = [];
  stubClipboard(async (text) => { written.push(text); });
  stubInspector({ detail: { media_url: hostile } });
  await openInspector("card:psa:abc");
  assert.equal(urlField().value, hostile, "the URL is a property, not parsed markup");
  assert.equal(descendants($("#inspector")).filter((n) => n.tagName === "IMG").length, 0);
  await inspectorButton("Copy").click();
  await flush();
  assert.deepEqual(written, [hostile]);
  assert.equal(descendants($("#inspector")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("the copy result belongs to the row it was copied from", async () => {
  // It is drawn from STATE, so a redraw repeats it — but inspecting a second
  // row must not inherit the first row's "copied".
  stubClipboard(async () => {});
  stubInspector();
  await openInspector("card:psa:abc");
  await inspectorButton("Copy").click();
  await flush();
  assert.match(copyResult(), /copied/i);
  app.renderInspector();
  assert.match(copyResult(), /copied/i, "a redraw repeats it rather than losing it");
  await openInspector("card:psa:other");
  assert.equal(copyResult(), "", "a different row starts with nothing copied");
});

test("the server's warning is shown inside the inspector, not only announced",
     async () => {
  // #live-region sits outside the modal and is inert under it, so a warning
  // that only went there was a warning the operator reading the dialog never
  // saw. It has to survive being a hostile string, like every other API value.
  const hostile = '<img src=x onerror="globalThis.pwned=52">';
  stubInspector({ reply: { id: "card:psa:abc", enabled: false, changed: true,
                           warning: hostile } });
  await openInspector("card:psa:abc");
  await inspectorButton("Disable from rotation").click();
  await flush();
  const dlg = $("#inspector");
  assert.ok(textOf(dlg).includes(hostile), "the warning is inside the dialog");
  assert.equal(descendants(dlg).filter((n) => n.tagName === "IMG").length, 0);
  assert.match(textOf($("#inspector-state")), /Attention/);
  assert.ok($("#live-region").textContent.includes(hostile), "and announced too");
  assert.equal(globalThis.pwned, undefined);
});

test("a mutation the server had nothing to add to leaves no warning behind",
     async () => {
  stubInspector({ reply: { id: "card:psa:abc", enabled: false, changed: true } });
  await openInspector("card:psa:abc");
  await inspectorButton("Disable from rotation").click();
  await flush();
  assert.equal($("#inspector-state").dataset.state, "populated");
  assert.equal(STATE.inspector.notice, "");
});

test("a delete that left a file behind keeps saying so where it can be read",
     async () => {
  // cleanup_failed means the row is gone but something is still on disk. The
  // inspector is the only surface that said so, so it does not close on it.
  const calls = stubInspector({ reply: { deleted: "card:psa:abc", kind: "psa",
    title: "Stay tuned", file_removed: false, dir_removed: false,
    cleanup_failed: true } });
  await openInspector("card:psa:abc");
  const pending = deleteBumper({ id: "card:psa:abc", title: "Stay tuned" });
  await flush();
  dialogButton("Delete permanently").click();
  await pending;
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url),
                   ["/api/bumpers/card%3Apsa%3Aabc"]);
  assert.equal($("#inspector").open, true, "the dialog stays up to carry the news");
  assert.match(textOf($("#inspector-state")), /quarantine file remains/);
  assert.equal($("#inspector-body").children.length, 0,
               "but there is nothing left to inspect");
  assert.match(logText(), /quarantine file remains/);
});

test("a clean delete closes the inspector on the row it removed", async () => {
  stubInspector({ reply: { deleted: "card:psa:abc", kind: "psa", title: "x",
    file_removed: true, dir_removed: false, cleanup_failed: false } });
  await openInspector("card:psa:abc");
  const pending = deleteBumper({ id: "card:psa:abc", title: "x" });
  await flush();
  dialogButton("Delete permanently").click();
  await pending;
  assert.equal($("#inspector").open, false);
});

test("a mutation that redraws the inspector does not drop focus out of it",
     async () => {
  // The clicked button is replaced by the redraw and disabled by the job
  // banner; either one would otherwise leave focus on <body>, outside the modal.
  stubInspector({ reply: { id: "card:psa:abc", enabled: false, changed: true } });
  await openInspector("card:psa:abc");
  const button = inspectorButton("Disable from rotation");
  button.focus();
  await button.click();
  await flush();
  assert.ok($("#inspector").contains(document.activeElement),
            "focus stayed inside the dialog");
  assert.equal(document.activeElement, $("#inspector-title"));
});

test("openInspector tells its caller about every mutation it makes", async () => {
  const seen = [];
  stubInspector({ reply: { id: "card:psa:abc", enabled: false, changed: true } });
  await openInspector("card:psa:abc", { onMutate: (kind, id) => seen.push([kind, id]) });
  await inspectorButton("Disable from rotation").click();
  await flush();
  assert.deepEqual(seen, [["disable", "card:psa:abc"]]);
});

test("the inspector focuses its heading and hands focus back to the invoker",
     async () => {
  stubInspector();
  const invoker = new FakeNode("button");
  await openInspector("card:psa:abc", { invoker });
  assert.equal($("#inspector").open, true);
  assert.equal(document.activeElement, $("#inspector-title"));
  closeInspector();
  assert.equal($("#inspector").open, false);
  assert.equal(document.activeElement, invoker, "focus goes back where it came from");
});

test("Escape closes the inspector", async () => {
  stubInspector();
  const invoker = new FakeNode("button");
  await openInspector("card:psa:abc", { invoker });
  await $("#inspector").dispatch("keydown", { key: "Escape" });
  assert.equal($("#inspector").open, false);
  assert.equal(document.activeElement, invoker);
});

test("Tab is trapped inside the modal while it is open", async () => {
  stubInspector();
  await openInspector("card:psa:abc");
  const dlg = $("#inspector");
  const buttons = descendants(dlg).filter((n) => n.tagName === "BUTTON" && !n.disabled);
  assert.ok(buttons.length >= 2);
  buttons[buttons.length - 1].focus();
  await dlg.dispatch("keydown", { key: "Tab" });
  assert.equal(document.activeElement, buttons[0], "Tab wraps to the first control");
  await dlg.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, buttons[buttons.length - 1],
               "and Shift+Tab wraps back");
});

test("a browser with no <dialog> gets a labelled fallback panel", async () => {
  delete global.HTMLDialogElement;
  stubInspector();
  await openInspector("card:psa:abc");
  const dlg = $("#inspector");
  assert.equal(dlg.open, false, "showModal is never called without support");
  assert.equal(dlg.getAttribute("open"), "", "the panel is shown by attribute instead");
  assert.equal(dlg.getAttribute("role"), "dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  assert.match(inspectorText(), /Stay tuned/);
  closeInspector();
  assert.equal(dlg.getAttribute("open"), null);
});

test("a failed detail read is an error with Retry, not an empty inspector", async () => {
  let attempt = 0;
  global.fetch = async (url) => {
    if (isDetailUrl(String(url))) {
      attempt++;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return jsonReply(DETAIL);
    }
    return jsonReply(OK_STATUS);
  };
  await openInspector("card:psa:abc");
  assert.equal($("#inspector-state").dataset.state, "error");
  assert.match(textOf($("#inspector-state")), /could not be reached/);
  const retry = descendants($("#inspector-state")).find((n) => n.tagName === "BUTTON");
  await retry.click();
  await flush();
  assert.equal($("#inspector-state").dataset.state, "populated");
  assert.match(inspectorText(), /Stay tuned/);
});

test("leaving the library closes the inspector it left open", async () => {
  stubRoutes();
  await applyHash("#/library");
  stubInspector();
  await openInspector("card:psa:abc");
  assert.equal($("#inspector").open, true);
  await applyHash("#/overview");
  assert.equal($("#inspector").open, false, "no modal survives a route change");
});

test("an inspector opened from the composer is torn down by a route change too",
     async (t) => {
  // The inspector belongs to every surface that draws a card, not to the
  // Library. Wiring its teardown into exitLibrary alone left a native <dialog>
  // in the top layer over the next view, its explain read still in flight and
  // still able to write, and the composer's video still playing.
  const pack = { requested: 15, total: 8, gap: 7, exact: false, count: 1,
                 bumpers: [{ id: "vid:a", type: "video", kind: "ambient",
                             title: "clip", duration: 8, enabled: 1, health: "ok",
                             media_url: "/media/a.mp4" }] };
  let detail = null;
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    const u = String(url);
    if (isDetailUrl(u)) {
      detail = { signal: opts.signal, resolve };
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted"); err.name = "AbortError"; reject(err);
      });
      return;
    }
    if (u.startsWith("/api/bumpers/fill")) return resolve(jsonReply(pack));
    if (u.startsWith("/api/station")) return resolve(jsonReply(OK_STATION));
    resolve(jsonReply(OK_STATUS));
  });

  await applyHash("#/composer");
  await composeBreak();
  playComposerSequence();
  const video = descendants($("#composer-stage")).find((n) => n.tagName === "VIDEO");
  await video.play();
  const inspect = descendants($("#composer-timeline")).find(
    (n) => n.tagName === "BUTTON" && n.className.includes("cmp-inspect"));
  inspect.click();
  await flush();
  assert.equal($("#inspector").open, true, "the composer's cards inspect too");
  assert.ok(detail, "and the detail read is in flight");

  applyHash("#/overview");
  await flush();
  assert.equal($("#inspector").open, false, "the dialog does not outlive the view");
  assert.equal(detail.signal.aborted, true, "nor does its read");
  assert.equal(video.paused, true, "nor does the media it was showing");
  assert.equal(video.src, "");
  assert.equal(STATE.inspector.value, null);
  assert.equal(STATE.inspector.loading, false,
               "a cancelled read does not leave the panel waiting forever");

  // The abandoned answer arrives after the teardown and writes nothing.
  detail.resolve(jsonReply(DETAIL));
  await flush();
  assert.equal(STATE.inspector.value, null);
  assert.equal($("#inspector").open, false);
});

test("composing again lets go of the media the last break was playing", async () => {
  const row = (id) => ({ id, type: "video", kind: "ambient", title: id,
                         duration: 8, enabled: 1, health: "ok",
                         media_url: "/media/" + id + ".mp4" });
  global.fetch = async () => jsonReply({ requested: 15, total: 8, gap: 7,
    exact: true, count: 1, bumpers: [row("a")] });
  await composeBreak();
  playComposerSequence();
  const first = descendants($("#composer-stage")).find((n) => n.tagName === "VIDEO");
  assert.equal(first.paused, false);

  global.fetch = async () => jsonReply({ requested: 30, total: 8, gap: 22,
    exact: false, count: 1, bumpers: [row("b")] });
  await composeBreak();
  assert.equal(first.paused, true, "the replaced item is not left playing");
  assert.equal(first.src, "", "nor left holding its buffer");
  assert.equal(STATE.composer.playback.index, -1, "and the sequence is back at a stop");
});

// --- danger flows ----------------------------------------------------------

test("the delete confirmation names the item and states the file consequence",
     async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=51">';
  const calls = stubInspector({ reply: { deleted: "card:psa:abc", kind: "psa",
                                         title: "Stay tuned", file_removed: true,
                                         dir_removed: false, cleanup_failed: false } });
  const pending = deleteBumper({ id: "card:psa:abc", title: hostile });
  await flush();
  assert.ok(topDialog(), "deleting opens a confirmation");
  assert.ok(dialogText().includes(hostile), "the item is named, as text");
  assert.equal(dialogControls("IMG").length, 0);
  assert.match(dialogText(), /media file/i);
  assert.match(dialogText(), /asset scan/i, "it says why the file goes too");
  dialogButton("Delete permanently").click();
  await pending;
  const destructive = calls.filter((c) => c.method === "DELETE");
  assert.deepEqual(destructive.map((c) => c.url), ["/api/bumpers/card%3Apsa%3Aabc"]);
  assert.equal(globalThis.pwned, undefined);
});

test("the destructive confirmation puts Cancel first and focuses it", async () => {
  stubInspector();
  const pending = deleteBumper({ id: "a", title: "x" });
  await flush();
  const buttons = dialogControls("BUTTON").map((b) => b.textContent);
  assert.deepEqual(buttons, ["Cancel", "Delete permanently"],
                   "Cancel comes first in reading and tab order");
  assert.equal(document.activeElement.textContent, "Cancel",
               "the destructive button is never the default");
  dialogButton("Cancel").click();
  await pending;
});

test("Keep the media file is offered and honoured", async () => {
  const calls = stubInspector({ reply: { deleted: "a", kind: "psa", title: "x",
                                         file_removed: false, dir_removed: false,
                                         cleanup_failed: false } });
  const pending = deleteBumper({ id: "vid:a b", title: "x" });
  await flush();
  const box = dialogControls("INPUT").find((n) => n.type === "checkbox");
  assert.ok(box, "the server supports keep_file, so the dialog offers it");
  box.checked = true;
  await box.dispatch("change");
  dialogButton("Delete permanently").click();
  await pending;
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url),
                   ["/api/bumpers/vid%3Aa%20b?keep_file=true"]);
});

test("bulk kind deletion will not confirm until the kind is typed exactly", async () => {
  const calls = stubInspector({ reply: { kind: "trivia", removed: 12,
                                         dirs_removed: 1, failed: [] } });
  STATE.status.value = Object.assign({}, OK_STATUS, { by_kind: { trivia: 12 } });
  STATE.library.filters.kind = "trivia";
  const pending = dropKind();
  await flush();
  const confirmBtn = dialogControls("BUTTON").find((b) => /^Delete/.test(b.textContent));
  const input = dialogControls("INPUT").find((n) => n.type !== "checkbox");
  assert.ok(input, "the bulk flow asks for the kind by name");
  assert.equal(confirmBtn.disabled, true, "the confirm button starts dead");

  input.value = "trivi";
  await input.dispatch("input");
  assert.equal(confirmBtn.disabled, true, "a near miss is still a miss");
  input.value = " trivia ";
  await input.dispatch("input");
  assert.equal(confirmBtn.disabled, false, "surrounding space is forgiven");
  confirmBtn.click();
  await pending;
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url),
                   ["/api/pool/kind/trivia"]);
  assert.match(logText(), /removed 12/);
});

test("cancelling the bulk flow sends no request", async () => {
  const calls = stubInspector();
  STATE.library.filters.kind = "trivia";
  const pending = dropKind();
  await flush();
  dialogButton("Cancel").click();
  await pending;
  assert.deepEqual(calls.filter((c) => c.method === "DELETE"), []);
});

test("Escape cancels a destructive confirmation and sends no request", async () => {
  // Escape is the cancel direction, so it takes the same path Cancel does:
  // the promise resolves false and nothing destructive is sent. What Escape
  // must never do is confirm.
  const calls = stubInspector();
  const pending = deleteBumper({ id: "a", title: "x" });
  await flush();
  const dlg = topDialog();
  await dlg.dispatch("keydown", { key: "Escape" });
  assert.equal(topDialog(), null, "Escape dismisses the confirmation");
  assert.equal(await pending, null, "and it is dismissed as a refusal");
  assert.deepEqual(calls.filter((c) => c.method === "DELETE"), []);
  assert.match(logText(), /delete cancelled/);
});

test("a native dialog's own cancel event is also a refusal", async () => {
  // The UA turns Escape into `cancel` before it turns into a close; app.js
  // takes that door rather than letting the browser tear the dialog down
  // behind its back.
  const calls = stubInspector();
  const pending = deleteBumper({ id: "a", title: "x" });
  await flush();
  await topDialog().dispatch("cancel", {});
  assert.equal(await pending, null);
  assert.deepEqual(calls.filter((c) => c.method === "DELETE"), []);
});

test("the danger zone is dead until a kind is actually selected", () => {
  STATE.status.value = Object.assign({}, OK_STATUS, { by_kind: { trivia: 12 } });
  STATE.library.filters.kind = null;
  renderFilters();
  assert.equal($("#drop-kind").disabled, true);
  assert.match(textOf($("#danger-note")), /choose a kind/i);
  STATE.library.filters.kind = "trivia";
  renderFilters();
  assert.equal($("#drop-kind").disabled, false);
  assert.match(textOf($("#danger-note")), /12/);
});

// ---- F3 composer tests ----
// The composer asks the server for a break and shows what came back. These
// cover the two things that cannot be allowed to drift: the request is built
// only from valid controls, and the answer is rendered in the server's order,
// never recomposed, reordered or substituted here.

const BREAK_ITEM = (over) => Object.assign({
  id: "vid:a", type: "video", kind: "ambient", title: "harbour",
  duration: 8, enabled: 1, health: "ok", media_url: "/media/a.mp4",
  creative: { family: "scenic", roles: ["open"], energy: "quiet", audio: "music",
              text_heavy: false, template: "image_caption", brand_mode: "reveal" },
}, over);

const CARD_ITEM = (over) => Object.assign({
  id: "card:psa:a", type: "card", kind: "psa", title: "stay tuned",
  duration: 5, enabled: 1, health: "ok", media_url: null,
  payload: { lines: ["Back after this."] },
  creative: { family: "text", roles: ["inside"], energy: "quiet", audio: "silence",
              text_heavy: true, template: "minimal_center", brand_mode: "none" },
}, over);

const breakBody = (items, over) => Object.assign({
  requested: 30, total: 29.4, gap: 0.6, exact: true,
  count: items.length, bumpers: items,
  composition: { placement: "any", relaxed_rules: [], profile_version: 1 },
}, over);

// Answers /api/bumpers/fill with `body` and everything else with a status, so a
// test can assert on exactly which requests the composer made.
function stubFill(body) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET" });
    if (u.startsWith("/api/bumpers/fill")) return jsonReply(body);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    return jsonReply(OK_STATUS);
  };
  return calls;
}

const setControl = (sel, value) => { $(sel).value = String(value); };
const tickType = (name) => { $("#cmp-type-" + name).checked = true; };
const fillCalls = (calls) => calls.filter((c) => c.url.startsWith("/api/bumpers/fill"));
const timelineItems = () => $("#composer-timeline").children;
const titles = () => timelineItems()
  .map((li) => descendants(li).find((n) => n.className === "cmp-title").textContent);
const stageVideo = () => descendants($("#composer-stage")).find((n) => n.tagName === "VIDEO");

test("every composer control is a labelled control the composer view owns", () => {
  // The fake document only proves anything if it carries the same controls
  // index.html does, in the same view.
  ["#cmp-seconds", "#cmp-tolerance", "#cmp-max-items", "#cmp-placement",
   "#cmp-validation", "#cmp-go", "#cmp-play", "#cmp-prev", "#cmp-next",
   "#cmp-stop", "#cmp-progress", "#composer-state", "#composer-summary",
   "#composer-attention", "#composer-stale", "#composer-stage",
   "#composer-timeline"].forEach((sel) => {
    const el = $(sel);
    assert.ok(el, "index.html is missing " + sel);
    assert.ok(matchesSelector(el, "#view-composer " + sel),
              sel + " belongs to the composer view");
  });
  assert.deepEqual(document.querySelectorAll("#view-composer [data-preset]")
                     .map((b) => Number(b.dataset.preset)),
                   COMPOSER_PRESETS, "the presets are the four documented ones");
});

// --- the summary line -------------------------------------------------------

test("gapLabel writes the sign and takes 'within tolerance' from the server", () => {
  // The example from the spec, exactly.
  assert.equal(gapLabel(30, 29.4, true),
               "Requested 30.0s | Composed 29.4s | Gap +0.6s | Within tolerance");
  // Underfilled is positive, overfilled is negative, and the sign is always there.
  assert.match(gapLabel(15, 20, false), /Gap -5\.0s \| Outside tolerance$/);
  assert.match(gapLabel(60, 60, true), /Gap \+0\.0s/);
  // A gap too small to show is not printed as a negative zero.
  assert.match(gapLabel(30, 30.04, true), /Gap \+0\.0s/);
  // `exact` is the server's word: a zero gap outside tolerance is still outside,
  // and a non-zero gap inside it is still within.
  assert.match(gapLabel(30, 30, false), /Gap \+0\.0s \| Outside tolerance$/);
  assert.match(gapLabel(30, 28.9, true), /Gap \+1\.1s \| Within tolerance$/);
});

test("a figure this build does not send is named, never shown as a zero", () => {
  const label = gapLabel(undefined, null, undefined);
  assert.equal(label, "Requested " + NOT_AVAILABLE + " | Composed " + NOT_AVAILABLE +
                      " | Gap " + NOT_AVAILABLE + " | " + NOT_AVAILABLE);
  assert.ok(!/0\.0/.test(label));
});

test("the summary line is the composed break's one summary line", async () => {
  stubFill(breakBody([BREAK_ITEM(), CARD_ITEM()]));
  await composeBreak();
  assert.equal($("#composer-summary").textContent,
               "Requested 30.0s | Composed 29.4s | Gap +0.6s | Within tolerance");
  assert.match($("#composer-count").textContent, /^2 item\(s\)/);
});

// --- controls and the request they build ------------------------------------

test("the fill request is built from the controls, through URLSearchParams",
     async () => {
  const calls = stubFill(breakBody([BREAK_ITEM()]));
  setControl("#cmp-seconds", "45.5");
  setControl("#cmp-tolerance", "2");
  setControl("#cmp-max-items", "3");
  setControl("#cmp-placement", "close");
  tickType("video");
  tickType("card");
  await composeBreak();
  const fill = fillCalls(calls);
  assert.equal(fill.length, 1);
  assert.equal(fill[0].url,
    "/api/bumpers/fill?seconds=45.5&tolerance=2&max_items=3&placement=close" +
    "&types=video%2Ccard&explain=true");
  assert.deepEqual(STATE.composer.types, ["video", "card"]);
});

test("ticking no type asks for every type rather than naming all four", async () => {
  const calls = stubFill(breakBody([BREAK_ITEM()]));
  await composeBreak();
  assert.ok(!fillCalls(calls)[0].url.includes("types="),
            "no types parameter is the request for all of them");
});

test("a preset fills the seconds field in and sends nothing by itself", () => {
  const calls = stubFill(breakBody([BREAK_ITEM()]));
  setComposerPreset(90);
  assert.equal($("#cmp-seconds").value, "90");
  assert.equal($("#cmp-go").disabled, false);
  assert.deepEqual(calls, [], "choosing a duration is not composing one");
  const pressed = document.querySelectorAll("#view-composer [data-preset]")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.dataset.preset);
  assert.deepEqual(pressed, ["90"]);
});

test("an out-of-range control disables Compose and sends no request", async () => {
  const calls = stubFill(breakBody([BREAK_ITEM()]));
  const cases = [
    ["#cmp-seconds", "0", /at least 0.1/],
    // Below the step the control itself offers: the field's min and this
    // file's own bound have to agree, or the browser and the page disagree
    // about a value one of them will accept.
    ["#cmp-seconds", "0.05", /at least 0.1/],
    ["#cmp-seconds", "86401", /86400/],
    ["#cmp-seconds", "not a number", /Seconds/],
    ["#cmp-tolerance", "3601", /3600/],
    ["#cmp-tolerance", "-1", /Tolerance/],
    ["#cmp-tolerance", "", /Tolerance/],
    ["#cmp-max-items", "0", /1 to 40/],
    ["#cmp-max-items", "41", /1 to 40/],
    ["#cmp-max-items", "2.5", /whole number/],
    ["#cmp-placement", "everywhere", /any, open, inside or close/],
  ];
  for (const [sel, value, says] of cases) {
    resetStateForTests();
    BODY = buildDocument();
    setControl(sel, value);
    assert.equal(await composeBreak(), null, sel + "=" + value + " sends nothing");
    assert.equal($("#cmp-go").disabled, true, sel + "=" + value + " disables Compose");
    assert.match(textOf($("#cmp-validation")), says);
    assert.equal($("#cmp-validation").hidden, false);
    assert.equal($(sel).getAttribute("aria-invalid"), "true");
  }
  assert.deepEqual(fillCalls(calls), [], "no request was ever built");
});

test("composerProblems is pure and clears once the controls are legal", () => {
  assert.deepEqual(composerProblems({ seconds: 30, tolerance: 1.5, maxItems: 8,
                                      placement: "any", types: [] }), {});
  assert.deepEqual(composerProblems({ seconds: 30, tolerance: 0, maxItems: 40,
                                     placement: "close", types: ["video"] }), {});
  assert.deepEqual(Object.keys(composerProblems({ seconds: 30, tolerance: 0, maxItems: 40,
                                                  placement: "close", types: ["exe"] })),
                   ["types"]);
  assert.deepEqual(Object.keys(composerProblems({})).sort(),
                   ["maxItems", "placement", "seconds", "tolerance"]);
});

// --- the timeline -----------------------------------------------------------

test("the timeline keeps the server's order, and never sorts it", async () => {
  const items = [
    BREAK_ITEM({ id: "z", title: "zebra" }),
    BREAK_ITEM({ id: "a", title: "alpha" }),
    CARD_ITEM({ id: "m", title: "middle" }),
  ];
  stubFill(breakBody(items, { count: 3 }));
  await composeBreak();
  assert.deepEqual(titles(), ["zebra", "alpha", "middle"]);
  assert.deepEqual(timelineItems().map((li) => li.dataset.order), ["1", "2", "3"]);
  assert.equal($("#composer-timeline").tagName, "OL", "an ordered list, ordered");
});

test("each item states order, kind, family, duration, audio, role and brand mode",
     async () => {
  stubFill(breakBody([BREAK_ITEM(), CARD_ITEM()]));
  await composeBreak();
  const first = textOf(timelineItems()[0]);
  assert.match(first, /1 of 2/);
  assert.match(first, /harbour/);
  assert.match(first, /ambient/);
  assert.match(first, /scenic/);
  assert.match(first, /8s/);
  assert.match(first, /music/);
  assert.match(first, /open/);
  assert.match(first, /reveal/);
  // A stream has no length: it runs until it stops.
  const streamed = timelineItemEl({ type: "stream", title: "cam" }, 0, 1);
  assert.match(textOf(streamed), /LIVE/);
  // A build that sends no creative block says so rather than inventing one.
  const bare = timelineItemEl({ id: "x", type: "video", title: "t" }, 0, 1);
  assert.ok(textOf(bare).includes(NOT_AVAILABLE));
});

test("hostile strings in a composed item stay text, never markup", async () => {
  const title = '<img src=x onerror="globalThis.pwned=60">';
  const kind = 'news" data-owned="yes';
  const family = "<script>globalThis.pwned=61</script>";
  const media = 'https://media.example/a.mp4" onerror="globalThis.pwned=62';
  stubFill(breakBody([BREAK_ITEM({
    title, kind, media_url: media,
    creative: { family, roles: ["<b>open</b>"], audio: "music", brand_mode: kind },
  })]));
  await composeBreak();
  const li = timelineItems()[0];
  const nodes = descendants(li);
  assert.equal(nodes.filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(nodes.filter((n) => n.tagName === "SCRIPT").length, 0);
  assert.equal(nodes.find((n) => n.className === "cmp-title").textContent, title);
  assert.ok(textOf(li).includes(kind));
  assert.ok(textOf(li).includes(family));
  // The URL only ever reaches an element property, and only on the stage.
  playComposerSequence();
  assert.equal(stageVideo().src, media);
  assert.equal(globalThis.pwned, undefined);
  stopComposerPlayback();
});

test("a relaxed rule is a sentence in an Attention panel, not a token", async () => {
  stubFill(breakBody([BREAK_ITEM()], {
    composition: { placement: "any", profile_version: 1,
                   relaxed_rules: ["exit_ident", "energy_jump", "same_family",
                                   "text_run", "same_music", "future_rule"] },
  }));
  await composeBreak();
  const attention = $("#composer-attention");
  assert.equal(attention.hidden, false);
  const said = textOf(attention);
  assert.match(said, /Attention/);
  Object.keys(RELAXED_TEXT).forEach((token) => {
    assert.ok(said.includes(RELAXED_TEXT[token]), token + " is explained in words");
  });
  // A token this build of the server invents is shown as it arrived.
  assert.ok(said.includes("future_rule"));
  const lines = descendants(attention).filter((n) => n.tagName === "LI");
  assert.equal(lines.length, 6, "one line per relaxed rule, on the page");
});

test("a break with nothing relaxed shows no attention panel at all", async () => {
  stubFill(breakBody([BREAK_ITEM()]));
  await composeBreak();
  assert.equal($("#composer-attention").hidden, true);
  assert.equal($("#composer-attention").children.length, 0);
});

// --- states -----------------------------------------------------------------

test("an empty break reports the server's own note, not leftover items", async () => {
  stubFill(breakBody([BREAK_ITEM()]));
  await composeBreak();
  assert.equal(timelineItems().length, 1);
  stubFill({ requested: 15, total: 0.0, gap: 15, exact: false, count: 0, bumpers: [],
             note: "no bumper is short enough for this gap",
             composition: { placement: "any", relaxed_rules: [], profile_version: 1 } });
  await composeBreak();
  assert.equal(timelineItems().length, 0, "the old break does not linger under the note");
  assert.equal($("#composer-state").dataset.state, "empty");
  assert.match(textOf($("#composer-state")), /no bumper is short enough/);
  assert.equal($("#cmp-play").disabled, true);
});

test("a failed compose reports the error and keeps the last good break", async () => {
  stubFill(breakBody([BREAK_ITEM({ title: "keep me" })]));
  await composeBreak();
  assert.deepEqual(titles(), ["keep me"]);

  global.fetch = async () => { throw new Error("network down"); };
  await composeBreak();
  assert.deepEqual(titles(), ["keep me"], "known-good items survive a failure");
  assert.equal($("#composer-state").dataset.state, "stale");
  assert.match(textOf($("#composer-state")), /could not be reached/);

  // Retry is offered, and it composes again rather than sitting there.
  const calls = stubFill(breakBody([BREAK_ITEM({ title: "fresh" })]));
  const retry = descendants($("#composer-state")).find((n) => n.tagName === "BUTTON");
  await retry.click();
  await flush();
  assert.deepEqual(titles(), ["fresh"]);
  assert.equal(fillCalls(calls).length, 1);
});

test("nothing composed yet is empty, and says which button composes one", () => {
  renderComposer();
  assert.equal($("#composer-state").dataset.state, "empty");
  assert.match(textOf($("#composer-state")), /Compose break/);
  assert.equal($("#cmp-play").disabled, true);
  assert.equal($("#cmp-stop").disabled, true);
});

// --- local playback ---------------------------------------------------------

test("playback advances on the medium's own ended event", async () => {
  stubFill(breakBody([BREAK_ITEM({ id: "a", media_url: "/media/a.mp4" }),
                      BREAK_ITEM({ id: "b", title: "second", media_url: "/media/b.mp4" })]));
  await composeBreak();
  playComposerSequence();
  const first = stageVideo();
  assert.equal(first.src, "/media/a.mp4");
  assert.equal(STATE.composer.playback.index, 0);
  assert.match($("#cmp-progress").textContent, /^Item 1 of 2/);
  assert.equal(timelineItems()[0].getAttribute("aria-current"), "true");

  await first.dispatch("ended");
  assert.equal(STATE.composer.playback.index, 1, "the sequence moved on by itself");
  assert.equal(stageVideo().src, "/media/b.mp4");
  assert.equal(first.paused, true, "and let go of the item it had finished");
  assert.equal(first.src, "");
  assert.equal(timelineItems()[1].getAttribute("aria-current"), "true");
  assert.equal(timelineItems()[0].getAttribute("aria-current"), null);

  // Off the end is the end of the break, not a wrap back to the top.
  await stageVideo().dispatch("ended");
  assert.equal(STATE.composer.playback.index, -1);
  assert.equal($("#composer-stage").children.length, 0);
  assert.match(logText(), /sequence finished/);
});

test("a payload-only card is shown for its declared duration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  stubFill(breakBody([CARD_ITEM({ id: "c1", duration: 5, title: "first card" }),
                      CARD_ITEM({ id: "c2", duration: 4, title: "second card" })]));
  await composeBreak();
  playComposerSequence();
  assert.equal(STATE.composer.playback.index, 0);
  assert.match(textOf($("#composer-stage")), /Back after this/);
  assert.equal(stageVideo(), undefined, "a card with no media file opens no player");
  assert.match($("#cmp-progress").textContent, /Item 1 of 2 · 0s elapsed · 5s remaining/);

  t.mock.timers.tick(4999);
  assert.equal(STATE.composer.playback.index, 0, "not a moment early");
  t.mock.timers.tick(1);
  assert.equal(STATE.composer.playback.index, 1, "the card's own clock advanced it");
  assert.match(textOf($("#composer-stage")), /Item 2 of 2/);
  stopComposerPlayback();
});

test("Previous, Next and Stop drive the sequence by hand", async () => {
  // Through the buttons index.html ships, wired the way boot() wires them.
  wireComposer();
  stubFill(breakBody([BREAK_ITEM({ id: "a" }), BREAK_ITEM({ id: "b" }),
                      BREAK_ITEM({ id: "c" })]));
  await composeBreak();
  assert.equal($("#cmp-stop").disabled, true, "nothing to stop before it starts");
  await $("#cmp-next").click();
  assert.equal(STATE.composer.playback.index, 0, "Next from stopped starts at the top");
  await $("#cmp-next").click();
  assert.equal(STATE.composer.playback.index, 1);
  assert.equal($("#cmp-stop").disabled, false);
  await $("#cmp-prev").click();
  assert.equal(STATE.composer.playback.index, 0);
  await $("#cmp-prev").click();
  assert.equal(STATE.composer.playback.index, -1, "before the first item is a stop");
  await $("#cmp-next").click();
  await $("#cmp-stop").click();
  assert.equal(STATE.composer.playback.index, -1);
  assert.equal($("#composer-stage").children.length, 0);
  assert.match($("#cmp-progress").textContent, /Stopped · 3 item\(s\)/);
});

test("only one medium is ever active, in the composer as anywhere else", async () => {
  stubFill(breakBody([BREAK_ITEM({ id: "a", media_url: "/media/a.mp4" }),
                      BREAK_ITEM({ id: "b", media_url: "/media/b.mp4" })]));
  await composeBreak();
  playComposerSequence();
  const first = stageVideo();
  assert.equal(first.paused, false);
  advanceComposer(1);
  const second = stageVideo();
  assert.notEqual(first, second);
  assert.equal(first.paused, true);
  assert.equal(BODY.querySelectorAll("video").filter((v) => !v.paused).length, 1,
               "exactly one video is playing");
  stopComposerPlayback();
});

test("a live stream in a break is never opened by the sequence itself", async () => {
  stubFill(breakBody([{ id: "cam:a", type: "stream", kind: "webcam", title: "harbour",
                        media_url: "https://x/s.m3u8", enabled: 1, health: "ok",
                        creative: { family: "window", roles: ["inside"],
                                    audio: "native", brand_mode: "none" } }]));
  await composeBreak();
  playComposerSequence();
  assert.equal(stageVideo(), undefined, "no element holds the stream URL yet");
  assert.match(textOf($("#composer-stage")), /LIVE/);
  assert.match(textOf($("#composer-stage")), /real client/,
               "and the page says what pressing Play would do");
  stopComposerPlayback();
});

test("leaving the composer stops the sequence, its timers and its media",
     async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  stubFill(breakBody([CARD_ITEM({ id: "c1", duration: 5 }),
                      CARD_ITEM({ id: "c2", duration: 5 })]));
  await applyHash("#/composer");
  await composeBreak();
  playComposerSequence();
  assert.equal(STATE.composer.playback.index, 0);

  applyHash("#/overview");
  await flush();
  assert.equal(STATE.composer.playback.index, -1, "the sequence is stopped");
  assert.equal($("#composer-stage").children.length, 0, "and the stage is empty");
  t.mock.timers.tick(60000);
  assert.equal(STATE.composer.playback.index, -1,
               "the card's timer cannot advance a view that is gone");
});

test("leaving the composer cancels a fill that is still in flight", async () => {
  const signals = [];
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    const u = String(url);
    if (u.startsWith("/api/bumpers/fill")) {
      signals.push(opts.signal);
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted"); err.name = "AbortError"; reject(err);
      });
      return;
    }
    resolve(jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS));
  });
  await applyHash("#/composer");
  const pending = composeBreak();
  assert.equal(signals.length, 1);
  applyHash("#/overview");
  await pending;
  await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(STATE.composer.loading, false,
               "a cancelled read does not leave the panel waiting forever");
  assert.equal(STATE.composer.error, null, "and a cancellation is not a failure");
});

// --- staleness --------------------------------------------------------------

test("disabling an item through the inspector marks the break stale", async () => {
  stubFill(breakBody([BREAK_ITEM({ id: "vid:a", title: "weak one" }),
                      BREAK_ITEM({ id: "vid:b", title: "the other" })]));
  await composeBreak();
  playComposerSequence();
  assert.equal($("#cmp-play").disabled, false);

  // The inspector the composer opens reports its mutations back to it.
  const calls = stubInspector({ detail: { id: "vid:a", title: "weak one" } });
  const inspect = descendants(timelineItems()[0])
    .find((n) => n.tagName === "BUTTON" && n.className.includes("cmp-inspect"));
  inspect.click();
  await flush();
  const disable = inspectorButton("Disable from rotation");
  assert.ok(disable, "the inspector offers the reversible action");
  await disable.click();
  await flush();

  assert.equal(STATE.composer.stale, true);
  assert.equal($("#composer-stale").hidden, false);
  assert.match(textOf($("#composer-stale")), /Stale — recompose/);
  assert.equal($("#cmp-play").disabled, true, "a stale break is not played");
  assert.equal(STATE.composer.playback.index, -1, "and whatever was playing stopped");
  assert.deepEqual(titles(), ["weak one", "the other"],
                   "nothing was substituted for the item that changed");
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.url),
                   ["/api/pool/disable?bumper_id=vid%3Aa"]);
  // Marking the pack stale must not rebuild the timeline out from under the
  // open dialog: that button is where focus goes when it closes.
  assert.ok(descendants(BODY).includes(inspect), "the invoker survives the mutation");
  closeInspector();
  assert.equal(document.activeElement, inspect, "and focus comes back to it");
});

test("a stale break refuses to play until it is composed again", async () => {
  stubFill(breakBody([BREAK_ITEM(), BREAK_ITEM({ id: "b" })]));
  await composeBreak();
  markComposerStale("delete", "vid:a");
  assert.equal(STATE.composer.stale, true);
  playComposerSequence();
  assert.equal(STATE.composer.playback.index, -1, "Play does nothing while stale");
  advanceComposer(1);
  assert.equal(STATE.composer.playback.index, -1);

  stubFill(breakBody([BREAK_ITEM({ id: "c", title: "recomposed" })]));
  await composeBreak();
  assert.equal(STATE.composer.stale, false, "composing again clears it");
  assert.equal($("#composer-stale").hidden, true);
  assert.equal($("#cmp-play").disabled, false);
  assert.deepEqual(titles(), ["recomposed"]);
});

test("a mutation with no break on screen marks nothing stale", () => {
  assert.equal(markComposerStale("disable", "vid:a"), null);
  assert.equal(STATE.composer.stale, false);
  assert.equal($("#composer-stale").hidden, true);
});

// --- read-only --------------------------------------------------------------

test("the composer only ever GETs, and never writes play history", async () => {
  const calls = stubFill(breakBody([BREAK_ITEM({ id: "a", media_url: "/media/a.mp4" }),
                                    CARD_ITEM({ id: "c", duration: 3 })]));
  await applyHash("#/composer");
  setControl("#cmp-seconds", "60");
  await composeBreak();
  playComposerSequence();
  await stageVideo().dispatch("ended");
  advanceComposer(-1);
  stopComposerPlayback();

  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c.method === "GET"),
            "nothing the composer does is a write: " + JSON.stringify(calls));
  assert.ok(calls.every((c) => !/\/station\//.test(c.url)));
  assert.ok(calls.every((c) => !c.url.includes("advance")));
  assert.ok(fillCalls(calls).every((c) => c.url.includes("explain=true")));
  // Playing a sequence locally asks the server for nothing at all.
  const before = calls.length;
  playComposerSequence();
  advanceComposer(1);
  stopComposerPlayback();
  assert.equal(calls.length, before, "local playback makes no requests");
});

test("an answer with no break in it is a failure, not an empty composer", async () => {
  // A 200 that carries no object used to blank the panel and claim nothing had
  // ever been composed — known-good content cleared without a replacement, and
  // a factually wrong state on top of it.
  stubFill(breakBody([BREAK_ITEM({ title: "keep me" })]));
  await composeBreak();
  assert.deepEqual(titles(), ["keep me"]);

  stubFill(null);
  assert.equal(await composeBreak(), null);
  assert.deepEqual(titles(), ["keep me"], "the known-good break is kept");
  assert.equal($("#composer-state").dataset.state, "stale");
  assert.match(textOf($("#composer-state")), /empty response/);
  assert.ok(descendants($("#composer-state")).some((n) => n.tagName === "BUTTON"),
            "and it still offers a way to try again");
});

test("a failed compose with nothing to keep is an error with Retry", async () => {
  global.fetch = async () => { throw new Error("network down"); };
  await composeBreak();
  assert.equal($("#composer-state").dataset.state, "error");
  assert.match(textOf($("#composer-state")), /Failed/);
  assert.match(textOf($("#composer-state")), /could not be reached/);
  const retry = descendants($("#composer-state")).find((n) => n.tagName === "BUTTON");
  assert.ok(retry, "an error offers a way to try again");
  const calls = stubFill(breakBody([BREAK_ITEM({ title: "second try" })]));
  await retry.click();
  await flush();
  assert.equal($("#composer-state").dataset.state, "populated");
  assert.deepEqual(titles(), ["second try"]);
  assert.equal(fillCalls(calls).length, 1);

  // An empty body with nothing to fall back on is the same failure.
  resetStateForTests();
  BODY = buildDocument();
  stubFill(null);
  await composeBreak();
  assert.equal($("#composer-state").dataset.state, "error");
  assert.match(textOf($("#composer-state")), /empty response/);
  assert.equal(timelineItems().length, 0);
});

// ---------------------------------------------------------------------------
// F4: station diagnostics, handoff copy, operations and the jobs list
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const { stationRollup, conformEl, hlsSupported, renderStation, mergeJobs,
        jobsList, jobRetry, renderOpsJobs, loadJobs, lockAction, RECENT_JOBS,
        renderActionLocks, wireMaintenance, syncJobWatches, stopJobWatches,
        STATION_MESSAGES, HLS_NO_NATIVE } = app;

// The fake selector parser splits on whitespace, so an attribute value with a
// space in it cannot be written as a selector. Job keys are action labels.
const keyed = (key) => document.querySelectorAll("[data-job-key]")
  .filter((b) => b.dataset.jobKey === key);

// Native HLS is a browser capability, so it is stubbed the way a browser
// presents it: canPlayType on a freshly created <video>. `null` — the default,
// and what Node's own element stand-in offers — is a browser with no such
// method at all, which is the same answer as "no".
let hlsAnswer = null;
const realCreateElement = document.createElement;
document.createElement = function (tag) {
  const node = realCreateElement(tag);
  if (String(tag).toLowerCase() === "video" && hlsAnswer !== null) {
    node.canPlayType = () => hlsAnswer;
  }
  return node;
};

const F4_STATION = {
  ffmpeg: true, conformed: 3, eligible: 4, pending: 1,
  last_conform: { at: 1700000000, conformed: 2, failed: 0, pruned: 1, skipped: 0,
                  ffmpeg: true },
  urls: { channel_m3u: "http://x/station/channel.m3u",
          guide_xml: "http://x/station/guide.xml",
          live: "http://x/station/live/index.m3u8",
          standby: "http://x/station/standby/index.m3u8" },
  channels: {
    live: { now: { id: "a", title: "Ident", kind: "station_id", started_at: 100,
                   ends_at: 200 },
            next: { id: "b", title: "Trivia", kind: "trivia" },
            state: "active", reason: "playing",
            last_playlist_request: 1700000005, lookahead_seconds: 24 },
    standby: { now: null, next: null, state: "idle", reason: "no_recent_client",
               last_playlist_request: null, lookahead_seconds: 24 },
  },
};

const stationBody = () => stationEl(F4_STATION, { updatedAt: 1 });
const inputsIn = (node) => descendants(node).filter((n) => n.tagName === "INPUT");
const buttonIn = (node, label) => descendants(node)
  .find((n) => n.tagName === "BUTTON" && n.textContent === label);

// --- station state ----------------------------------------------------------

test("stationState answers each condition with the plan's own sentence", () => {
  const withChannel = (channel, over, top) => Object.assign(
    { ffmpeg: true, channels: { live: Object.assign({ state: "active",
      reason: "playing" }, over) } }, top || {});

  assert.deepEqual(
    [stationState("live", withChannel("live", { state: "idle", reason: "no_recent_client" })).state,
     stationState("live", withChannel("live", { state: "idle" })).message],
    ["idle", "Idle — no playlist client has requested this channel recently."]);

  const unconformed = withChannel("live", { state: "unavailable",
                                            reason: "nothing_conformed" });
  assert.equal(stationState("live", unconformed).message,
               "Unavailable — conform at least one eligible item.");

  assert.equal(stationState("live", withChannel("live", { reason: "slate" })).message,
               "Using slate — all playable candidates are currently gated.");

  // ffmpeg absence is the cause of "nothing conformed", so it is what gets
  // said — and with ffmpeg present the two stay different answers.
  const noFfmpeg = Object.assign({}, unconformed, { ffmpeg: false });
  assert.equal(stationState("live", noFfmpeg).message,
               "Cannot conform — ffmpeg is unavailable in the service.");
  assert.notEqual(stationState("live", noFfmpeg).message,
                  stationState("live", unconformed).message,
                  "not conformed and ffmpeg absent are distinct");

  assert.equal(stationState("live", withChannel("live", {})).state, "active");
  assert.equal(stationState("live", withChannel("live", {})).message,
               STATION_MESSAGES.playing);
});

test("every station condition names a level as well as a colour", () => {
  const level = (over, top) => stationState("live", Object.assign(
    { ffmpeg: true, channels: { live: over } }, top || {})).level;
  assert.equal(level({ state: "active", reason: "playing" }), "healthy");
  assert.equal(level({ state: "active", reason: "slate" }), "attention",
               "the slate plays, but it is not content");
  assert.equal(level({ state: "idle", reason: "no_recent_client" }), "attention");
  assert.equal(level({ state: "unavailable", reason: "nothing_conformed" }), "failed");
});

test("a station that could not be read says how old the last good read was", () => {
  const at = 1700000000000;
  const cold = stationState("live", null, { updatedAt: null, at });
  assert.equal(cold.state, "unknown");
  assert.equal(cold.message, "Station status unavailable; last successful update was never.");

  const warm = stationState("live", null, { updatedAt: at - 120000, at });
  assert.match(warm.message,
    /^Station status unavailable; last successful update was 2m ago\.$/,
    "a failed read still says when the page last knew something");
  assert.equal(warm.level, "offline");
});

test("a build that does not diagnose a channel claims nothing about it", () => {
  // Reading an absent `state` as "idle" would invent a diagnosis; missing data
  // is not evidence either way.
  const older = { ffmpeg: true, channels: { live: { now: null, next: null } } };
  assert.equal(stationState("live", older).state, "unknown");
  assert.equal(stationState("live", older).message, NOT_AVAILABLE);
  assert.equal(stationState("nowhere", F4_STATION).message, NOT_AVAILABLE);
});

test("stationState is pure: it reads its arguments and touches nothing", () => {
  const before = JSON.stringify(F4_STATION);
  stationState("live", F4_STATION, { updatedAt: 1, at: 2 });
  stationState("standby", F4_STATION, { updatedAt: 1, at: 2 });
  assert.equal(JSON.stringify(F4_STATION), before);
  // The roll-up form the Overview badge uses is still the same function.
  assert.equal(stationState(F4_STATION).level, stationRollup(F4_STATION).level);
});

// --- station panel ----------------------------------------------------------

test("the station panel reports now, next, times and remaining per channel", () => {
  const text = textOf(stationBody());
  assert.match(text, /Ident/);
  assert.match(text, /Trivia/);
  assert.match(text, /off air/, "a channel with nothing on air says so");
  assert.match(text, /nothing scheduled/);
  assert.match(text, /3 \/ 4 conformed/);
});

test("last playlist request and lookahead are shown without being set", () => {
  const text = textOf(stationBody());
  assert.match(text, /last playlist request/);
  assert.match(text, /no client has asked yet/, "a null request is not an age");
  assert.match(text, /lookahead/);
  assert.match(text, /24s/);

  // A build that does not send them says so rather than showing a zero.
  const older = { ffmpeg: true, conformed: 0, eligible: 0, urls: {},
                  channels: { live: {}, standby: {} } };
  const olderText = textOf(stationEl(older));
  assert.ok(olderText.includes(NOT_AVAILABLE),
            "a field this version does not send is named, never invented");
});

test("the conform block shows progress, ffmpeg and the last sweep", () => {
  const text = textOf(conformEl(F4_STATION));
  assert.match(text, /conformed/);
  assert.match(text, /3 \/ 4/);
  assert.match(text, /pending/);
  assert.match(text, /found/);
  assert.match(text, /last sweep/);
  assert.match(text, /conformed 2 · failed 0 · pruned 1 · skipped 0/);
});

test("a service that has never swept says so, and one without ffmpeg says why", () => {
  const never = textOf(conformEl(Object.assign({}, F4_STATION, { last_conform: null })));
  assert.match(never, /no sweep has finished in this service yet/);

  const older = Object.assign({}, F4_STATION);
  delete older.last_conform;
  assert.ok(textOf(conformEl(older)).includes(NOT_AVAILABLE),
            "a build with no last_conform key is unavailable, not never-swept");

  const broken = textOf(conformEl(Object.assign({}, F4_STATION, { ffmpeg: false })));
  assert.ok(broken.includes(STATION_MESSAGES.ffmpeg));
  assert.match(broken, /Failed/, "it is a state, not only a colour");
});

test("the station view explains that conforming can be slow", () => {
  assert.match(INDEX_HTML, /It can be slow/,
               "a job that takes minutes says so before it is started");
});

// --- HLS gating -------------------------------------------------------------

test("no video element exists anywhere until Open preview is pressed", () => {
  hlsAnswer = "maybe";
  try {
    const body = stationBody();
    assert.equal(descendants(body).filter((n) => n.tagName === "VIDEO").length, 0,
                 "the station panel never builds a player on render");
    const open = buttonIn(body, "Open preview");
    assert.ok(open, "a browser with native HLS is offered an explicit Open preview");
    assert.match(textOf(body),
      /Opening the preview is a real playlist client and may advance and report playout\./,
      "and is told what that does before pressing it");
  } finally { hlsAnswer = null; }
});

test("a browser without native HLS is given the URL, never a broken player", () => {
  hlsAnswer = "";
  try {
    const body = stationBody();
    assert.equal(descendants(body).filter((n) => n.tagName === "VIDEO").length, 0);
    assert.equal(buttonIn(body, "Open preview"), undefined,
                 "no preview is offered where the browser cannot play it");
    assert.ok(textOf(body).includes(HLS_NO_NATIVE));
    assert.match(textOf(body), /Open in external player \(VLC, mpv, IINA\)/);
    // The URL is still right there to copy.
    assert.ok(inputsIn(body).some((i) => i.value.includes("live/index.m3u8")));
  } finally { hlsAnswer = null; }
});

test("the HLS answer is read once and never fetches a media library", () => {
  let asked = 0;
  hlsAnswer = "probably";
  const create = document.createElement;
  document.createElement = function (tag) {
    const node = create(tag);
    if (String(tag).toLowerCase() === "video") {
      node.canPlayType = () => { asked++; return hlsAnswer; };
    }
    return node;
  };
  try {
    assert.equal(hlsSupported(), true);
    assert.equal(hlsSupported(), true);
    assert.equal(asked, 1, "the capability is probed once per session");
  } finally { document.createElement = create; hlsAnswer = null; }
  assert.ok(!INDEX_HTML.includes("hls.js"), "no remote media dependency is loaded");
  assert.equal((INDEX_HTML.match(/<script/g) || []).length, 1);
});

test("opening the preview builds the player only then, and closing lets go", async () => {
  hlsAnswer = "maybe";
  try {
    STATE.station.value = F4_STATION;
    STATE.station.updatedAt = 1;
    renderStation();
    assert.equal($("#station-preview").children.length, 0);

    buttonIn($("#station"), "Open preview").click();
    const video = descendants($("#station-preview")).find((n) => n.tagName === "VIDEO");
    assert.ok(video, "the element is built by the press, not by the render");
    assert.equal(video.src, "http://x/station/live/index.m3u8");
    assert.equal(video.muted, true, "sound is never started for anyone");
    assert.equal(video.preload, "none", "catalog HLS is never pre-fetched");
    assert.equal(video.paused, true, "nothing autoplays");
    assert.match($("#live-region").textContent, /playlist client/);

    // A refresh redraws the summary; it must not reopen the stream.
    renderStation();
    assert.equal(descendants($("#station-preview")).find((n) => n.tagName === "VIDEO"),
                 video, "a redraw leaves the open preview exactly where it was");

    buttonIn($("#station"), "Close preview").click();
    assert.equal($("#station-preview").children.length, 0);
    assert.equal(video.src, "", "closing detaches the stream rather than pausing it");
  } finally { hlsAnswer = null; }
});

test("toggling the preview hands focus to the control that replaced the button",
     async () => {
  // The button lives inside the region the redraw replaces, so pressing it
  // would otherwise drop focus out to <body>.
  hlsAnswer = "maybe";
  try {
    STATE.station.value = F4_STATION;
    renderStation();
    const open = buttonIn($("#station"), "Open preview");
    open.focus();
    open.click();
    assert.equal(document.activeElement.textContent, "Close preview");
    document.activeElement.click();
    assert.equal(document.activeElement.textContent, "Open preview");
  } finally { hlsAnswer = null; }
});

test("leaving the station closes the preview it left open", async () => {
  hlsAnswer = "maybe";
  try {
    stubRoutes({ station: F4_STATION });
    await applyHash("#/station");
    buttonIn($("#station"), "Open preview").click();
    const video = descendants($("#station-preview")).find((n) => n.tagName === "VIDEO");
    assert.ok(video);
    await applyHash("#/overview");
    assert.equal(video.src, "", "the route change let go of the channel");
    assert.equal(STATE.ops.preview, null);
  } finally { hlsAnswer = null; }
});

// --- copying the handoff URLs -----------------------------------------------

const copyRow = (body, label) => descendants(body)
  .filter((n) => String(n.className).split(" ").includes("station-url"))
  .find((n) => textOf(n).includes(label));

test("every handoff URL is copyable and says so when it worked", async () => {
  const written = [];
  stubClipboard(async (text) => { written.push(text); });
  const body = stationBody();
  const row = copyRow(body, "Live HLS");
  assert.ok(row, "the live channel's HLS URL is offered, not only the standby one");
  const field = inputsIn(row)[0];
  assert.equal(field.readOnly, true, "the URL is a field to copy, not a link to follow");

  field.dispatch("focus");
  assert.equal(field.selected, true, "focusing a URL still selects it");

  await buttonIn(row, "Copy").click();
  await flush();
  assert.deepEqual(written, ["http://x/station/live/index.m3u8"]);
  assert.match(textOf(row), /Healthy/, "the outcome is a state, not just colour");
  assert.match(textOf(row), /copied/i);
  assert.match($("#live-region").textContent, /copied/i, "and it is announced");
});

test("a clipboard the browser refuses falls back to a selection and says so", async () => {
  stubClipboard(async () => { throw new Error("denied"); });
  const row = copyRow(stationBody(), "Channel M3U");
  await buttonIn(row, "Copy").click();
  await flush();
  assert.equal(inputsIn(row)[0].selected, true);
  assert.match(textOf(row), /Attention/, "a refusal is never reported as a success");
  assert.match(textOf(row), /keyboard/i);
  assert.match($("#live-region").textContent, /keyboard/i);
});

test("a browser with no Clipboard API at all still offers a way to copy", async () => {
  stubClipboard(null);
  const row = copyRow(stationBody(), "Guide XMLTV");
  await buttonIn(row, "Copy").click();
  await flush();
  assert.equal(inputsIn(row)[0].selected, true);
  assert.match(textOf(row), /Attention/);
});

test("a hostile handoff URL reaches the clipboard as a value, never as markup",
     async () => {
  const hostile = 'http://x/s.m3u8"><img src=x onerror="globalThis.pwned=71">';
  const written = [];
  stubClipboard(async (text) => { written.push(text); });
  const body = stationEl(Object.assign({}, F4_STATION,
    { urls: Object.assign({}, F4_STATION.urls, { live: hostile }) }));
  const row = copyRow(body, "Live HLS");
  assert.equal(inputsIn(row)[0].value, hostile);
  assert.equal(descendants(body).filter((n) => n.tagName === "IMG").length, 0);
  await buttonIn(row, "Copy").click();
  await flush();
  assert.deepEqual(written, [hostile]);
  assert.equal(descendants(body).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("a URL this build does not send is named, not shown as an empty box", () => {
  const body = stationEl(Object.assign({}, F4_STATION, { urls: {} }));
  assert.equal(inputsIn(body).length, 0, "no empty field pretends to hold a URL");
  assert.ok(textOf(copyRow(body, "Live HLS")).includes(NOT_AVAILABLE));
});

test("a hostile station title stays text in the channel block", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=72">';
  const body = stationEl({ ffmpeg: true, conformed: 0, eligible: 0, urls: {},
    channels: { live: { now: { title: hostile, kind: hostile, ends_at: 0 },
                        next: { title: hostile }, state: "active", reason: "playing" },
                standby: {} } });
  assert.ok(textOf(body).includes(hostile));
  assert.equal(descendants(body).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

// --- action locking ---------------------------------------------------------

test("Conform now disables only itself while its job runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let job = { status: "working" };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") return jsonReply({ job_id: "c1", status: "working" });
    if (u.startsWith("/api/request/")) return jsonReply(job);
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  const running = doAction("/api/station/conform", "station conform",
                           { region: "#conform-state" });
  await flush();

  const all = document.querySelectorAll("[data-job-key]");
  const conform = keyed("station conform");
  const others = all.filter((b) => b.dataset.jobKey !== "station conform");
  assert.equal(conform.length, 2,
               "the Station view and Operations offer the same action under one key");
  assert.ok(conform.every((b) => b.disabled), "the duplicate is held wherever it appears");
  assert.ok(others.length > 3);
  assert.ok(others.every((b) => !b.disabled),
            "unrelated actions stay available while conform runs");
  assert.match(textOf($("#conform-state")), /station conform/,
               "the station's own panel reports its own job");
  assert.equal(textOf($("#actions-state")), "",
               "and does not shout it from a panel on another view");

  job = { status: "done", result: "conformed 2" };
  t.mock.timers.tick(3000);
  await running;
  assert.ok(all.every((b) => !b.disabled), "the lock is released when the job ends");
});

test("a lock is a rendering of state, so redrawing repeats it", () => {
  lockAction("generate psa", true);
  renderActionLocks();
  const psa = keyed("generate psa")[0];
  assert.equal(psa.disabled, true);
  psa.disabled = false;                 // as a stray DOM write would leave it
  renderActionLocks();
  assert.equal(psa.disabled, true, "the button's state comes from STATE, not the DOM");
  lockAction("generate psa", false);
  renderActionLocks();
  assert.equal(psa.disabled, false);
});

// --- the merged jobs list ---------------------------------------------------

const serverJob = (over) => Object.assign(
  { id: "s1", request: "generate trivia", status: "done", created_at: 1700000000,
    updated_at: 1700000004, result: "made 20" }, over);

test("the jobs list merges the server's registry with the page's own, newest first", () => {
  const client = [
    { id: "s2", label: "conform", status: "working", startedAt: 3000, updatedAt: 3000,
      result: "" },
    { id: "page-1", label: "tidy up", status: "done", startedAt: 1000, updatedAt: 1200,
      result: "removed 2 empty file(s), 0 empty dir(s)" },
  ];
  const server = [serverJob({ id: "s2", request: "station conform", status: "done",
                              created_at: 3, updated_at: 4, result: "conformed 2" }),
                  serverJob({ id: "s1", created_at: 2, updated_at: 2 })];
  const rows = mergeJobs(client, server);
  assert.deepEqual(rows.map((r) => r.id), ["s2", "s1", "page-1"],
                   "newest first, whichever registry knew about them");
  const merged = rows[0];
  assert.equal(merged.status, "done", "the server is authoritative for the verdict");
  assert.equal(merged.result, "conformed 2");
  assert.equal(merged.source, "both");
  assert.equal(rows[2].label, "tidy up",
               "a synchronous action the registry never saw is still listed");
});

test("the merge keeps the label the page already showed when the server sends none", () => {
  const rows = mergeJobs(
    [{ id: "s1", label: "add: more harbour cams", status: "working",
       startedAt: 5000, updatedAt: 5000, result: "" }],
    [serverJob({ id: "s1", request: "", status: "working", result: null })]);
  assert.equal(rows.length, 1, "one job is one row, not two");
  assert.equal(rows[0].label, "add: more harbour cams");
  assert.equal(rows[0].result, "");
});

test("the merge survives a body that is not the shape it promised", () => {
  assert.deepEqual(mergeJobs(null, null), []);
  assert.deepEqual(mergeJobs(undefined, [null, {}, { id: "" }, "nope"]), []);
  const rows = mergeJobs([], [serverJob({ status: "gibberish" })]);
  assert.equal(rows[0].status, "unknown", "a status outside the vocabulary is unknown");
});

test("a dict result reaches both lists as one line of text, never as markup", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=73">';
  STATE.jobs.server = [serverJob({ request: hostile,
    result: { ok: false, output: hostile } })];
  renderJobs();
  const overview = textOf($("#jobs-list"));
  const ops = textOf($("#ops-jobs-list"));
  assert.ok(overview.includes(hostile));
  assert.ok(ops.includes(hostile));
  assert.equal(descendants($("#ops-jobs-list")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(descendants($("#jobs-list")).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("Operations expands a job's raw result; the Overview stays a triage line", () => {
  STATE.jobs.server = [serverJob({ status: "error", result: "line one\nline two" })];
  renderJobs();
  const ops = descendants($("#ops-jobs-list"));
  const box = ops.find((n) => n.tagName === "DETAILS");
  assert.ok(box, "the raw error is expandable rather than truncated into a log");
  assert.equal(descendants(box).find((n) => n.tagName === "SUMMARY").textContent, "error");
  assert.match(textOf($("#ops-jobs-list")), /Failed/);
  assert.equal(descendants($("#jobs-list")).filter((n) => n.tagName === "DETAILS").length, 0,
               "the overview offers no controls of its own");
});

test("a job id borrowed from Object.prototype claims no note and no lock", () => {
  // Ids come from the server, and the note/lock maps are plain objects: read
  // naively, "constructor" would answer with a function and render as a badge.
  STATE.jobs.server = [serverJob({ id: "constructor", request: "generate psa" }),
                       serverJob({ id: "__proto__", request: "fetch-queue",
                                   created_at: 1699999999 })];
  renderOpsJobs();
  const rows = $("#ops-jobs-list").children;
  assert.equal(rows.length, 2);
  assert.ok(!textOf(rows[0]).includes("function"),
            "an inherited property is not a note anyone stored");
  renderActionLocks();
  assert.ok(document.querySelectorAll("[data-job-key]").every((b) => !b.disabled),
            "and it locks nothing");
});

test("both lists say which registries they could read", () => {
  renderJobs();
  assert.equal($("#ops-jobs-state").dataset.state, "empty");
  assert.match(textOf($("#ops-jobs-state")), /has not been read yet/);
  STATE.jobs.updatedAt = Date.now();
  renderJobs();
  assert.match(textOf($("#ops-jobs-state")), /the server's registry is empty/,
               "once it has been read, an empty list is the server's answer");
});

test("Retry is offered only where running it a second time is safe", () => {
  const offered = (label, retry) => Boolean(jobRetry(
    retry === undefined ? { label } : { label, retry }));
  assert.ok(offered("station conform"));
  assert.ok(offered("capture-windows"));
  assert.ok(offered("fetch-queue"));
  assert.ok(offered("render cards"));
  assert.ok(offered("tidy up"));
  assert.ok(offered("recheck retired"));
  assert.ok(offered("generate trivia"));
  assert.equal(jobRetry({ label: "generate trivia" }).url, "/api/generate/trivia?n=20");

  assert.ok(!offered("starter"), "the starter spends the operator's API quota");
  assert.ok(!offered("run starter"));
  assert.ok(!offered("add: more harbour cams"),
            "repeating an ingest of arbitrary text pulls the material twice");
  assert.ok(!offered("delete kind trivia"), "retry is never invented for destructive work");
  assert.ok(!offered("something this build has never heard of"));
  assert.ok(!offered("add: anything", null), "an explicit refusal wins over the table");
});

test("the jobs list shows Retry only on the rows that may be repeated", () => {
  STATE.jobs.server = [
    serverJob({ id: "a", request: "fetch-queue", status: "error", result: "no" }),
    serverJob({ id: "b", request: "starter", status: "error", result: "no",
                created_at: 1699999999 }),
  ];
  renderOpsJobs();
  const rows = $("#ops-jobs-list").children;
  assert.equal(rows.length, 2);
  assert.ok(buttonIn(rows[0], "Retry"), "a source refresh may simply be run again");
  assert.equal(buttonIn(rows[1], "Retry"), undefined,
               "the starter is never offered a one-click repeat");
});

test("Retry runs the same action again and reports where it was started", async () => {
  const posts = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") { posts.push(u); return jsonReply({ status: "done", result: "ok" }); }
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs: [], count: 0 });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  STATE.jobs.server = [serverJob({ id: "a", request: "fetch-queue", status: "error" })];
  renderOpsJobs();
  await buttonIn($("#ops-jobs-list").children[0], "Retry").click();
  await flush();
  assert.deepEqual(posts, ["/api/sources/fetch-queue"]);
});

// --- following listed jobs to a terminal state ------------------------------

function stubOperations(jobs, request) {
  const urls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    urls.push(u);
    if ((opts && opts.method) === "POST") return jsonReply({ job_id: "n1", status: "working" });
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs, count: jobs.length });
    if (u.startsWith("/api/request/")) return request();
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  return urls;
}

const jobReads = (urls) => urls.filter((u) => u.startsWith("/api/request/")).length;

test("a working job the server lists is polled to its terminal state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let answer = { status: "working" };
  const urls = stubOperations(
    [serverJob({ id: "w1", request: "station conform", status: "working", result: null })],
    () => jsonReply(answer));

  await applyHash("#/operations");
  await flush();
  assert.match(textOf($("#ops-jobs-list")), /Working/);

  answer = { status: "done", result: "conformed 2, failed 0" };
  const statusReads = urls.filter((u) => u.startsWith("/api/status")).length;
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls), 1, "one poll every three seconds, not a busy loop");
  assert.match(textOf($("#ops-jobs-list")), /Healthy/);
  assert.match(textOf($("#ops-jobs-list")), /conformed 2/);
  assert.ok(urls.filter((u) => u.startsWith("/api/status")).length > statusReads,
            "a job reaching a terminal state refreshes the views it changed");

  t.mock.timers.tick(60000);
  await flush();
  assert.equal(jobReads(urls), 1, "a finished job stops being polled");
});

test("a job the server no longer tracks reads unknown, and is never called done",
     async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = stubOperations(
    [serverJob({ id: "gone", request: "generate psa", status: "working", result: null })],
    () => jsonReply({ error: "not found" }, { ok: false, status: 404 }));

  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls), 1, "an expired job ends the poll rather than retrying it");
  assert.match(textOf($("#ops-jobs-list")), /Attention/);
  assert.match(textOf($("#ops-jobs-list")), /no longer tracks this job/);
  assert.doesNotMatch(textOf($("#ops-jobs-list")), /Healthy/,
                      "a forgotten job is never invented into a success");

  t.mock.timers.tick(60000);
  await flush();
  assert.equal(jobReads(urls), 1);
});

test("a lost status read keeps a listed job unknown and backs off to ten seconds",
     async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = stubOperations(
    [serverJob({ id: "w2", request: "render cards", status: "working", result: null })],
    () => { throw new TypeError("Failed to fetch"); });

  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls), 1);
  assert.match(textOf($("#ops-jobs-list")), /status unknown/);
  assert.match(textOf($("#ops-jobs-list")), /Working/,
               "a lost read is doubt about the status, not a finished job");
  assert.ok(buttonIn($("#ops-jobs-list"), "Check now"),
            "and the operator can ask again without waiting out the backoff");
  assert.equal(buttonIn($("#ops-jobs-list"), "Retry"), undefined,
               "the escape from a lost poll is another poll, not a second run");

  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls), 1, "it does not keep hammering at three seconds");
  t.mock.timers.tick(7000);
  await flush();
  assert.equal(jobReads(urls), 2, "it keeps checking, ten seconds apart");
});

test("leaving Operations abandons every background job poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = stubOperations(
    [serverJob({ id: "w3", request: "fetch-queue", status: "working", result: null })],
    () => jsonReply({ status: "working" }));

  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls), 1);

  await applyHash("#/overview");
  const settled = jobReads(urls);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(jobReads(urls), settled, "no poll outlives the view that started it");
  assert.equal(stopJobWatches(), null);
});

test("a job this page is already waiting on is not polled twice", async (t) => {
  // The list read at entry already saw this job working, so a background watch
  // was following it. Starting the same work from the panel hands the job over
  // rather than adding a second poll racing the first to write the answer.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let answer = { status: "working" };
  const urls = stubOperations(
    [serverJob({ id: "n1", request: "generate trivia", status: "working", result: null })],
    () => jsonReply(answer));
  await applyHash("#/operations");
  await flush();

  const running = doAction("/api/generate/trivia?n=20", "generate trivia");
  await flush();
  syncJobWatches();
  const before = jobReads(urls);
  answer = { status: "done", result: "made 20" };
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(jobReads(urls) - before, 1,
               "the action's own poll is the only one asking");
  await running;
  assert.match(logText(), /generate trivia: made 20/);
});

// --- capacity, confirmation and the notice ----------------------------------

test("a capacity refusal leaves the operator's text exactly where they typed it",
     async () => {
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") {
      return jsonReply({ error: "job capacity reached" }, { ok: false, status: 429 });
    }
    if (String(url).startsWith("/api/bumpers")) {
      return jsonReply({ count: 0, total: 0, bumpers: [] });
    }
    return jsonReply(OK_STATUS);
  };
  $("#ask").value = "more harbour cams";
  await submitAsk();
  await flush();
  assert.equal($("#ask").value, "more harbour cams",
               "a refusal must not cost the operator what they typed");
  assert.equal($("#ask").disabled, false);
  assert.equal($("#ask-go").disabled, false);
  assert.match(textOf($("#ask-result")), /job capacity reached/);
  assert.match(textOf($("#ask-result")), /Attention/,
               "a server saying 'not now' is not the request failing");
});

test("an action refused for capacity says so instead of reporting a failure",
     async () => {
  global.fetch = async (url, opts) => {
    if ((opts && opts.method) === "POST") {
      return jsonReply({ error: "job capacity reached" }, { ok: false, status: 429 });
    }
    if (String(url).startsWith("/api/bumpers")) {
      return jsonReply({ count: 0, total: 0, bumpers: [] });
    }
    return jsonReply(String(url).startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  await doAction("/api/generate/psa?n=20", "generate psa");
  assert.match(logText(), /generate psa not started: job capacity reached/);
  assert.match(logText(), /try again in a moment/);
  assert.doesNotMatch(logText(), /generate psa failed/);
});

test("only the starter run stops to confirm; routine work does not", async () => {
  const posts = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") { posts.push(u); return jsonReply({ status: "done", result: "ok" }); }
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  wireMaintenance();

  await document.querySelector("[data-maint=tidy]").click();
  await flush();
  assert.equal(openDialogs().length, 0, "routine maintenance asks for no modal");
  assert.ok(posts.some((u) => u.startsWith("/api/pool/tidy")));

  await document.querySelector("[data-prep=conform]").click();
  await flush();
  assert.equal(openDialogs().length, 0, "neither does preparing output");

  document.querySelector("[data-starter=dry]").click();
  await flush();
  assert.equal(openDialogs().length, 0, "a dry run only reports");
  assert.ok(posts.some((u) => u === "/api/starter?dry_run=true"));

  document.querySelector("[data-starter=run]").click();
  await flush();
  assert.equal(openDialogs().length, 1, "the starter run is the one thing that asks");
  assert.match(dialogText(), /API keys/);
  dialogButton("Cancel").click();
  await flush();
  assert.ok(!posts.some((u) => u.includes("dry_run=false")), "cancelling sends nothing");

  document.querySelector("[data-starter=run]").click();
  await flush();
  dialogButton("Seed the pool").click();
  await flush();
  assert.ok(posts.some((u) => u === "/api/starter?dry_run=false"));
});

test("Operations carries the unprotected-API notice and groups by consequence", () => {
  const flat = INDEX_HTML.replace(/\s+/g, " ");
  assert.equal((flat.match(
    /This operator API has no authentication\. Do not expose this service to the public internet\./g)
    || []).length, 1, "the notice is at the top of the view, verbatim");
  assert.match(flat, /Unprotected operator API/, "and the footer still carries its own");
  ["1 · Add material", "2 · Generate cards", "3 · Refresh sources",
   "4 · Prepare output", "5 · Maintenance"].forEach((group) => {
    assert.ok(INDEX_HTML.includes(group), "missing group: " + group);
  });
  assert.match(INDEX_HTML, /needs network/);
  assert.match(INDEX_HTML, /needs ffmpeg/);
  assert.match(INDEX_HTML, /\(grounded\)/);
  assert.match(INDEX_HTML, /\(model\)/);

  // Destructive work is linked, never duplicated: hiding a button is not
  // authorization, and the one bulk delete this app has lives in the Library.
  assert.match(INDEX_HTML, /Library danger zone/);
  assert.match(INDEX_HTML, /docs\/CLI\.md/);
  assert.equal((INDEX_HTML.match(/DELETE/g) || []).length, 0,
               "Operations starts no destructive request of its own");
});

test("every button that starts a job carries the key its lock is held under", () => {
  const starters = (INDEX_HTML.match(/data-(gen|src|maint|prep|starter|station)=/g) || []);
  const keys = (INDEX_HTML.match(/data-job-key=/g) || []);
  assert.ok(starters.length >= 18, "the supported kinds and actions are all offered");
  assert.equal(keys.length, starters.length,
               "an unkeyed action would be locked by nothing, or by everything");
});

test("the failed-job warning is bounded to the rows the operator can still see", () => {
  finishJob(recordJob("generate trivia"), "error", "boom");
  assert.deepEqual(
    overviewWarnings(OK_STATUS, OK_STATION, recentJobs(jobsList())).map((w) => w.id),
    ["failed-job"], "a failure still on the list is worth saying");

  for (let i = 0; i < RECENT_JOBS; i++) finishJob(recordJob("job " + i), "done", "ok");
  assert.deepEqual(
    overviewWarnings(OK_STATUS, OK_STATION, recentJobs(jobsList())).map((w) => w.id), [],
    "a failure the operator can no longer see listed is not a warning they cannot clear");
  assert.ok(STATE.jobs.items.length > RECENT_JOBS,
            "the registry still holds it; only the warning is bounded");
});

test("a terminal refresh of the list clears a warning the server has moved past",
     async () => {
  finishJob(recordJob("generate trivia"), "error", "boom");
  global.fetch = async (url) => {
    if (String(url).startsWith("/api/jobs")) {
      return jsonReply({ jobs: [serverJob({ id: "fresh", status: "done" })], count: 1 });
    }
    return jsonReply(OK_STATUS);
  };
  STATE.status.value = OK_STATUS;
  STATE.station.value = OK_STATION;
  renderOverview();
  assert.match(textOf($("#warnings")), /failed/i);

  await loadJobs();
  for (let i = 0; i < RECENT_JOBS; i++) finishJob(recordJob("job " + i), "done", "ok");
  renderOverview();
  assert.equal($("#warnings-state").dataset.state, "empty");
});

// ---------------------------------------------------------------------------
// F4 review round 1: overview jobs read, Retry under the lock, stale jobs,
// and the report region of the view the action was started from
// ---------------------------------------------------------------------------

// Answers every read a view makes, with a real /api/jobs body — stubRoutes()
// predates the job list and answers `{}` for it.
function stubWithJobs(jobs, over) {
  const o = over || {};
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET" });
    if (u.startsWith("/api/jobs")) {
      if (o.jobsFail) throw new TypeError("Failed to fetch");
      return jsonReply({ jobs, count: jobs.length });
    }
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply({ status: "done", result: "ok" });
  };
  return calls;
}

// --- finding 1: the Overview's five recent are the merged list ---------------

test("the Overview lists the server's jobs, not only the ones this page started",
     async () => {
  const calls = stubWithJobs([serverJob({ id: "srv", request: "capture-windows",
                                          status: "done", result: "3 cams" })]);
  await applyHash("#/overview");
  await flush();
  assert.ok(calls.some((c) => c.url.startsWith("/api/jobs")),
            "the panel reads the registry it claims to be showing: " +
            JSON.stringify(calls.map((c) => c.url)));
  assert.match(textOf($("#jobs-list")), /capture-windows/,
               "a job this tab never started is still an operator's job");
  assert.match(textOf($("#jobs-list")), /3 cams/);
  assert.equal($("#jobs-state").dataset.state, "populated");
});

test("a server-side failure the Overview can see becomes a warning it can act on",
     async () => {
  stubWithJobs([serverJob({ id: "srv", request: "fetch-queue", status: "error",
                            result: "no network" })]);
  await applyHash("#/overview");
  await flush();
  const warnings = descendants($("#warnings"));
  assert.match(textOf($("#warnings")), /fetch-queue/,
               "the failed-job warning now covers the whole registry");
  assert.ok(warnings.some((n) => n.tagName === "A" && n.href === "#/operations"),
            "and points at the view that can retry it");
  // It no longer claims to know where the job came from, because it does not.
  assert.doesNotMatch(textOf($("#warnings")), /started from this page/);
});

test("the overview's own clock keeps the job list current too", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = stubWithJobs([]);
  await applyHash("#/overview");
  await flush();
  const before = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
  assert.equal(before, 1);
  t.mock.timers.tick(REFRESH_MS);
  await flush();
  assert.ok(calls.filter((c) => c.url.startsWith("/api/jobs")).length > before,
            "a job that finished elsewhere shows up without a reload");
});

// --- finding 2: Retry is one of the buttons the action's lock covers ---------

test("a job that is still running is offered no Retry", () => {
  STATE.jobs.server = [serverJob({ id: "w", request: "fetch-queue",
                                   status: "working", result: null })];
  renderOpsJobs();
  assert.match(textOf($("#ops-jobs-list")), /Working/);
  assert.equal(buttonIn($("#ops-jobs-list"), "Retry"), undefined,
               "a second copy of work already in flight is not an escape hatch");
});

test("Retry carries the action's job key, so the lock covers it too", () => {
  STATE.jobs.server = [serverJob({ id: "e", request: "fetch-queue",
                                   status: "error", result: "no network" })];
  renderOpsJobs();
  const retry = buttonIn($("#ops-jobs-list"), "Retry");
  assert.equal(retry.dataset.jobKey, "fetch-queue");
  assert.equal(retry.disabled, false);

  lockAction("fetch-queue", true);
  assert.equal(retry.disabled, true,
               "Retry is held while that same action is running");
  renderOpsJobs();
  assert.equal(buttonIn($("#ops-jobs-list"), "Retry").disabled, true,
               "and a redraw mid-run does not hand back an enabled one");
  assert.ok(keyed("fetch-queue").length > 1,
            "the panel button and the Retry answer to one key");
  lockAction("fetch-queue", false);
  renderOpsJobs();
  assert.equal(buttonIn($("#ops-jobs-list"), "Retry").disabled, false);
});

test("the lock counts holders, so one finishing does not release the other", () => {
  const button = keyed("fetch-queue")[0];
  lockAction("fetch-queue", true);
  lockAction("fetch-queue", true);
  assert.equal(button.disabled, true);
  lockAction("fetch-queue", false);
  assert.equal(button.disabled, true,
               "the server runs two at a time; the first to finish holds nothing back");
  lockAction("fetch-queue", false);
  assert.equal(button.disabled, false);
  lockAction("fetch-queue", false);
  assert.equal(button.disabled, false, "and a release with nothing held is harmless");
});

test("two concurrent runs of one action hold its buttons until both end",
     async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers = { j1: { status: "working" }, j2: { status: "working" } };
  let posts = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") {
      return jsonReply({ job_id: "j" + (++posts), status: "working" });
    }
    const waiting = Object.keys(answers).find((id) => u.endsWith("/" + id));
    if (waiting) return jsonReply(answers[waiting]);
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs: [], count: 0 });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  const button = keyed("fetch-queue")[0];
  const first = doAction("/api/sources/fetch-queue", "fetch-queue");
  await flush();
  const second = doAction("/api/sources/fetch-queue", "fetch-queue");
  await flush();
  assert.equal(button.disabled, true);

  answers.j1 = { status: "done", result: "one" };
  t.mock.timers.tick(3000);
  await first;
  // Let the second run's next poll actually schedule itself before the clock
  // moves again, or the tick below fires against a timer that does not exist.
  await flush();
  assert.equal(button.disabled, true,
               "the first run finishing does not unlock work the second still holds");

  answers.j2 = { status: "done", result: "two" };
  t.mock.timers.tick(3000);
  await second;
  assert.equal(button.disabled, false, "and the last one out releases it");
});

test("a run that hands its control back early releases the lock exactly once",
     async (t) => {
  // A lost poll releases the button so the operator is not stuck; the run's own
  // release at the end must not then decrement a lock it no longer holds.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls = [];
  const statusReads = stubFailingJob(urls);
  const button = keyed("fetch-queue")[0];
  const running = doAction("/api/sources/fetch-queue", "fetch-queue");
  await flush();
  assert.equal(button.disabled, true);

  t.mock.timers.tick(3000);
  await flush();
  assert.equal(statusReads(), 1);
  assert.equal(button.disabled, false, "a lost read hands the control back");

  // A second run now takes the lock; the first run ending must not release it.
  lockAction("fetch-queue", true);
  assert.equal(button.disabled, true);
  escapeButton("#actions-state", "Stop checking").click();
  await running;
  assert.equal(button.disabled, true,
               "the finished run gives back only the hold it still had");
  lockAction("fetch-queue", false);
  assert.equal(button.disabled, false);
});

// --- finding 3: a failed refresh marks the rows stale ------------------------

test("a jobs read that fails after a good one marks the rows stale, with Retry",
     async () => {
  stubWithJobs([serverJob({ id: "a", request: "generate trivia" })]);
  await loadJobs();
  assert.equal($("#ops-jobs-state").dataset.state, "populated");
  assert.equal($("#ops-jobs-list").children.length, 1);

  stubWithJobs([], { jobsFail: true });
  await loadJobs();
  assert.equal($("#ops-jobs-state").dataset.state, "stale",
               "rows that could not be refreshed are marked, not left looking current");
  assert.match(textOf($("#ops-jobs-state")), /last known data/i,
               "and it says how old what is on screen is");
  assert.match(textOf($("#ops-jobs-state")), /could not be reached/i,
               "the read failure itself is shown, not swallowed");
  assert.equal($("#ops-jobs-list").children.length, 1,
               "a failed refresh never clears known-good rows");
  assert.ok(descendants($("#ops-jobs-state")).some(
    (n) => n.tagName === "BUTTON" && n.textContent === "Retry"),
    "with a way to try the read again");
  assert.equal($("#jobs-state").dataset.state, "stale", "on both lists");
});

test("a jobs read that fails before any good one is an error, not staleness",
     async () => {
  stubWithJobs([], { jobsFail: true });
  await loadJobs();
  assert.equal($("#ops-jobs-state").dataset.state, "error",
               "nothing was ever read, so there is nothing to call stale");
  assert.ok(descendants($("#ops-jobs-state")).some(
    (n) => n.tagName === "BUTTON" && n.textContent === "Retry"));
});

test("an empty registry and an unread one stay different answers", async () => {
  renderJobs();
  assert.match(textOf($("#ops-jobs-state")), /has not been read yet/);
  stubWithJobs([]);
  await loadJobs();
  assert.equal($("#ops-jobs-state").dataset.state, "empty");
  assert.match(textOf($("#ops-jobs-state")), /the server's registry is empty/);
});

// --- finding 4: the report region belongs to the view, not the action --------

test("a retry reports into the panel of the view it was pressed from", async () => {
  const posts = [];
  let finish = null;
  const held = new Promise((resolve) => { finish = resolve; });
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") {
      posts.push(u);
      await held;
      return jsonReply({ status: "done", result: "conformed 2" });
    }
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs: [], count: 0 });
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  STATE.route = "operations";
  STATE.jobs.server = [serverJob({ id: "c", request: "station conform",
                                   status: "error", result: "ffmpeg died" })];
  renderOpsJobs();

  buttonIn($("#ops-jobs-list"), "Retry").click();
  await flush();
  assert.deepEqual(posts, ["/api/station/conform"]);
  assert.match(textOf($("#actions-state")), /station conform/,
               "the run reports where the operator pressed Retry");
  assert.equal(textOf($("#conform-state")), "",
               "not into a region inside the view that is currently hidden");

  finish();
  await flush();
  await flush();
});

test("the same action started from the Station reports in the Station's panel",
     async () => {
  let finish = null;
  const held = new Promise((resolve) => { finish = resolve; });
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts && opts.method) === "POST") {
      await held;
      return jsonReply({ status: "done", result: "conformed 2" });
    }
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs: [], count: 0 });
    if (u.startsWith("/api/bumpers")) return jsonReply({ count: 0, total: 0, bumpers: [] });
    return jsonReply(u.startsWith("/api/station") ? OK_STATION : OK_STATUS);
  };
  STATE.route = "station";
  const running = doAction("/api/station/conform", "station conform");
  await flush();
  assert.match(textOf($("#conform-state")), /station conform/,
               "one action, reported wherever the operator actually is");
  assert.equal(textOf($("#actions-state")), "");

  finish();
  await running;
});

// ---------------------------------------------------------------------------
// F5: creative and provenance insight
// ---------------------------------------------------------------------------

// The eight tokens bumparr.selection.eligibility_reasons can return, exactly as
// docs/API.md lists them. A ninth here would be an invented field.
const REASON_TOKENS = ["disabled", "unhealthy", "missing_media", "base_weight",
                       "season", "daypart", "non_finite_score", "eligible"];

const equationEl = () => descendants($("#inspector-body"))
  .find((n) => n.className === "insp-eq");
const termsIn = (eq, cls) => descendants(eq).filter((n) => n.className === cls)
  .map((n) => n.textContent);
const gatedTerms = (eq) => descendants(eq)
  .filter((n) => n.className.includes("insp-term-zero"))
  .map((n) => textOf(n).trim());

const withFactors = (factors, reasons) => stubInspector({ detail: {
  selection: { eligible_now: reasons === undefined,
               reasons: reasons || ["eligible"], factors },
} });

// --- the factor product ------------------------------------------------------

test("the score is the product the server computed, shown term by term", async () => {
  withFactors({ base: 1.5, season: 0.8, daypart: 1.2, recency: 0.9,
                affinity: 1, fatigue: 0.7, score: 0.907 });
  await openInspector("card:psa:abc");
  const eq = equationEl();
  assert.ok(eq, "the factors are drawn as one equation, not seven loose rows");
  assert.deepEqual(termsIn(eq, "lbl"),
                   ["base", "season", "daypart", "recency", "affinity",
                    "fatigue", "score"]);
  assert.deepEqual(termsIn(eq, "val"),
                   ["1.5", "0.8", "1.2", "0.9", "1", "0.7", "0.907"]);
  // Five multiplications between six factors, then one equals before the score.
  assert.deepEqual(termsIn(eq, "insp-eq-op"), ["×", "×", "×", "×", "×", "="]);
  assert.deepEqual(gatedTerms(eq), [], "nothing is zero, so nothing is marked");
});

test("a factor of zero is the gate, named in words and in the server's own token",
     async () => {
  withFactors({ base: 1, season: 0, daypart: 1, recency: 1, affinity: 1,
                fatigue: 1, score: 0 }, ["season"]);
  await openInspector("card:psa:abc");
  assert.deepEqual(gatedTerms(equationEl()), ["season 0", "score 0"]);
  const text = inspectorText();
  assert.match(text, /zero gate/);
  assert.match(text, /Attention/, "the gate is an icon and a word, not colour alone");
  assert.ok(text.includes(REASON_TEXT.season), "the token is read out in words");
  assert.ok(text.includes("season is 0"));
});

test("a zero the server has no reason token for is still named as the gate", async () => {
  withFactors({ base: 1, season: 1, daypart: 1, recency: 0, affinity: 1,
                fatigue: 1, score: 0 }, ["eligible"]);
  await openInspector("card:psa:abc");
  const text = inspectorText();
  assert.match(text, /recency is 0/);
  assert.match(text, /no reason token/, "no token is invented for this factor");
  assert.doesNotMatch(text, /undefined/);
});

test("a score the server could not express as a number says so, never a zero",
     async () => {
  withFactors({ base: 1, season: 1, daypart: 1, recency: 1, affinity: 1,
                fatigue: 1, score: null }, ["non_finite_score"]);
  await openInspector("card:psa:abc");
  const text = inspectorText();
  assert.match(text, /not a number/);
  assert.ok(text.includes(REASON_TEXT.non_finite_score));
  assert.doesNotMatch(text, /score 0/);
});

test("every eligibility reason the API documents has a plain reading", async () => {
  assert.deepEqual(Object.keys(REASON_TEXT).slice().sort(), REASON_TOKENS.slice().sort(),
                   "no token is missing and none is invented");
  REASON_TOKENS.forEach((token) => {
    assert.ok(REASON_TEXT[token].includes(" — "), token + " is read out, not echoed");
    assert.ok(REASON_TEXT[token].length > token.length + 6, token + " says something");
  });
  withFactors({ base: 0, season: 0, daypart: 0, recency: 1, affinity: 1,
                fatigue: 1, score: 0 }, REASON_TOKENS);
  await openInspector("card:psa:abc");
  const text = inspectorText();
  REASON_TOKENS.forEach((token) => assert.ok(text.includes(REASON_TEXT[token]),
    "the inspector never leaves " + token + " as a bare token"));
});

test("a reason token borrowed from Object.prototype reads as that word", async () => {
  withFactors({ base: 1, season: 1, daypart: 1, recency: 1, affinity: 1,
                fatigue: 1, score: 1 }, ["constructor", "toString"]);
  await openInspector("card:psa:abc");
  const list = descendants($("#inspector-body"))
    .find((n) => n.className === "insp-reasons");
  assert.deepEqual(list.children.map((n) => n.textContent),
                   ["constructor", "toString"]);
  assert.doesNotMatch(inspectorText(), /native code/);
});

test("a factor this build does not send is named, never shown as a zero", async () => {
  withFactors({ base: 1, score: 1 });
  await openInspector("card:psa:abc");
  const eq = equationEl();
  assert.deepEqual(termsIn(eq, "val"),
                   ["1", NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE,
                    NOT_AVAILABLE, NOT_AVAILABLE, "1"]);
  assert.deepEqual(gatedTerms(eq), [], "an absent factor is not a zero one");
  assert.doesNotMatch(inspectorText(), /zero gate/);
});

test("hostile factor values stay text in the equation", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=71">';
  withFactors({ base: hostile, season: hostile, daypart: 1, recency: 1,
                affinity: 1, fatigue: 1, score: hostile }, [hostile]);
  await openInspector("card:psa:abc");
  const body = $("#inspector-body");
  assert.ok(textOf(body).includes(hostile), "the server's own words are shown, as text");
  assert.equal(descendants(body).filter((n) => n.tagName === "IMG").length, 0);
  assert.deepEqual(gatedTerms(equationEl()), [],
                   "a string that merely looks falsy is not a zero gate");
  assert.equal(globalThis.pwned, undefined);
});

// --- provenance and rights ---------------------------------------------------

test("the rights block carries every field the credits snapshot holds", async () => {
  stubInspector({ detail: {
    payload: JSON.stringify({ lines: ["Back after this."], source: "operator",
      bg_creator: "A Photographer", bg_title: "Harbour at dusk",
      bg_license: "CC0 1.0", bg_license_url: "https://example.test/cc0",
      bg_source_page: "https://example.test/photo" }),
    music_credits: { id: "night-room-01", title: "Night Room",
      creator: "Example Artist", source_page: "https://example.test/bed",
      license: "CC BY 4.0", license_url: "https://example.test/by",
      attribution: "Night Room by Example Artist (CC BY 4.0)" },
  } });
  await openInspector("card:psa:abc");
  const text = inspectorText();
  ["Provenance & rights", "generated", "operator", "A Photographer",
   "Harbour at dusk", "CC0 1.0", "https://example.test/photo",
   "https://example.test/cc0", "Night Room", "Example Artist", "CC BY 4.0",
   "https://example.test/by", "https://example.test/bed", "night-room-01",
   "Night Room by Example Artist (CC BY 4.0)"].forEach((bit) => {
    assert.ok(text.includes(bit), "the rights block is missing " + bit);
  });
  assert.ok(!text.includes(NO_PROVENANCE), "this row records plenty");
});

test("a credit the snapshot left empty is not reported as a missing field", async () => {
  stubInspector({ detail: { music_credits: {
    id: "legacy.loose.wav", title: "", creator: "", source_page: "",
    license: "", license_url: "", attribution: "" } } });
  await openInspector("card:psa:abc");
  const text = inspectorText();
  assert.ok(text.includes("legacy.loose.wav"));
  assert.match(text, /not recorded/, "an empty credit is unrecorded, not unsupported");
  assert.ok(!text.toLowerCase().includes("unknown artist"));
});

test("an item with nothing recorded says so, and its actions still work", async () => {
  stubInspector({ detail: { source: "", payload: "{}", music_credits: null } });
  await openInspector("card:psa:abc");
  const text = inspectorText();
  assert.ok(text.includes(NO_PROVENANCE));
  assert.match(text, /Attention/, "an icon and a word, never colour alone");
  assert.match(text, /not a block/);
  const disable = inspectorButton("Disable from rotation");
  assert.ok(disable, "the reversible action is still offered");
  assert.equal(disable.disabled, false, "missing provenance never blocks curation");
  assert.equal(inspectorButton("Delete permanently").disabled, false);
});

test("hostile provenance and credit strings stay text in the rights block", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=72">';
  stubInspector({ detail: {
    source: hostile,
    payload: JSON.stringify({ source: hostile, bg_creator: hostile,
                              bg_license_url: hostile, bg_source_page: hostile }),
    music_credits: { id: hostile, title: hostile, creator: hostile,
                     source_page: hostile, license: hostile,
                     license_url: hostile, attribution: hostile },
  } });
  await openInspector("card:psa:abc");
  const body = $("#inspector-body");
  assert.ok(textOf(body).includes(hostile));
  assert.equal(descendants(body).filter((n) => n.tagName === "A").length, 0,
               "a hostile URL is never turned into a link");
  assert.equal(descendants(body).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

// --- the library card's creative chips ---------------------------------------

test("a card labels family and audio as chips, and says so when it knows neither",
     () => {
  const card = cardEl({ type: "card", kind: "psa", title: "x",
    payload: { lines: ["Stay."] },
    creative: { family: "text", audio: "music", template: "minimal_center" } });
  const chips = descendants(card).filter((n) => n.className === "pv-chip");
  assert.deepEqual(chips.map((n) => textOf(n).trim()),
                   ["family text", "audio music"]);
  const bare = cardEl({ type: "card", kind: "psa", title: "x",
                        payload: { lines: ["Stay."] } });
  const box = descendants(bare).find((n) => n.className === "pv-chips");
  assert.ok(box, "the row is still accounted for");
  assert.equal(textOf(box).trim(), NOT_AVAILABLE);
  assert.equal(descendants(bare).filter((n) => n.className === "pv-chip").length, 0);
});

test("a card that knows only one of the two chips shows only that one", () => {
  const card = cardEl({ type: "card", kind: "psa", title: "x",
    payload: { lines: ["Stay."] }, creative: { audio: "silence" } });
  const chips = descendants(card).filter((n) => n.className === "pv-chip");
  assert.deepEqual(chips.map((n) => textOf(n).trim()), ["audio silence"]);
});

// --- the Station's read-only configuration block ------------------------------

async function stationConfig(over) {
  stubRoutes(over);
  await applyHash("#/station");
  await flush();
  await flush();
  return $("#station-config");
}

const writeControls = (node) => descendants(node)
  .filter((n) => ["INPUT", "SELECT", "TEXTAREA", "FORM"].includes(n.tagName));

test("the station configuration block holds no control that could write a file",
     async () => {
  const el = await stationConfig();
  const panel = $("#panel-station-config");
  assert.ok(panel && el, "the Station view carries a Configuration block");
  assert.deepEqual(writeControls(panel), [],
    "configuration is read-only: no field, no picker, no form");
  // The content region carries facts and badges only. The panel's state strip
  // is a separate region and may offer Retry; that is asserted below.
  assert.deepEqual(descendants(el).filter((n) => n.tagName === "BUTTON"), []);
  const text = textOf(panel);
  assert.match(text, /file-owned/);
  assert.match(text, /edited in their files on the server/);
  assert.match(text, /Nothing on this page writes them/);
});

test("a failed configuration read offers Retry, and Retry only re-reads status",
     async () => {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("/api/status")) throw new Error("network down");
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    return jsonReply({});
  };
  await applyHash("#/station");
  await flush();
  await flush();
  const panel = $("#panel-station-config");
  assert.deepEqual(writeControls(panel), [],
    "no state of this panel offers a field, a picker or a form");
  const buttons = descendants(panel).filter((n) => n.tagName === "BUTTON");
  assert.equal(buttons.length, 1, "the only control here is the panel's Retry");
  assert.equal(buttons[0].className, "panel-retry");
  assert.equal(buttons[0].textContent, "Retry");
  // The content region says why there is nothing to read rather than claiming
  // this build lacks the fields.
  const body = textOf($("#station-config"));
  assert.match(body, /not read: the last try failed/);
  assert.ok(!body.includes(NOT_AVAILABLE));

  const before = calls.filter((u) => u.startsWith("/api/status")).length;
  await buttons[0].click();
  await flush();
  const after = calls.filter((u) => u.startsWith("/api/status")).length;
  assert.equal(after, before + 1, "Retry re-reads /api/status and nothing else");
  assert.deepEqual(calls.filter((u) => !u.startsWith("/api/status") &&
                                       !u.startsWith("/api/station")), [],
                   "nothing on this panel writes anything");
});

test("configuration reports profile, manifest and memory from the server's fields",
     async () => {
  const text = textOf(await stationConfig());
  ["channel profile", "shipped-default", "music manifest", "enabled beds",
   "compatibility", "channel memory", "previously_on", "station:live",
   "operator messages", "last read"].forEach((bit) => {
    assert.ok(text.includes(bit), "the configuration block is missing " + bit);
  });
  assert.doesNotMatch(text, /undefined/);
});

test("a manifest that fell back after an error is an Attention, not a silent default",
     async () => {
  const el = await stationConfig({ status: {
    profile: { version: 1, valid: false, source: "fallback-after-error" },
    music: { version: 1, valid: false, source: "fallback-after-error",
             enabled_beds: 0, compatibility: true },
  } });
  const attention = descendants(el).filter((n) => n.className.includes("badge-attention"));
  assert.ok(attention.length >= 2, "both files say something is wrong");
  const text = textOf(el);
  assert.match(text, /Attention/);
  assert.match(text, /fallback-after-error/);
  assert.match(text, /invalid, running the shipped default/);
  assert.match(text, /beds outside the manifest are allowed/);
});

test("a build that reports no configuration says so rather than inventing a default",
     async () => {
  const text = textOf(await stationConfig({ status: {
    profile: undefined, music: undefined, memory: undefined } }));
  assert.equal(text.split(NOT_AVAILABLE).length - 1, 3,
               "each of the three files says so exactly once: " + text);
  assert.doesNotMatch(text, /shipped-default/);
});

test("configuration not yet read is not the same claim as a build that lacks it", () => {
  renderStationConfig();
  const text = textOf($("#station-config"));
  assert.match(text, /not read yet/);
  assert.ok(!text.includes(NOT_AVAILABLE), "never read is not 'this build lacks it'");
  assert.match(textOf($("#station-config-state")), /Loading|Working/);
});

test("hostile configuration strings stay text in the Station's block", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=73">';
  const el = await stationConfig({ status: {
    profile: { version: hostile, valid: true, source: hostile },
    music: { version: 1, valid: true, source: hostile, enabled_beds: hostile,
             compatibility: false },
    memory: { refresh_seconds: hostile, enabled_kinds: [hostile], channel: hostile,
              messages: { valid: true, source: hostile, enabled: hostile, total: 1 } },
  } });
  assert.ok(textOf(el).includes(hostile));
  assert.equal(descendants(el).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

// ---------------------------------------------------------------------------
// F6: accessibility, cleanup and payload
// ---------------------------------------------------------------------------

const readWeb = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

// --- payload ----------------------------------------------------------------

test("the three static files stay inside the payload budget", () => {
  // 256 KiB uncompressed, the revised limit: the plan's original 150 KiB was
  // measured unreachable (stripping every comment and all indentation from all
  // three files still landed at 156 KiB, before F5 had even shipped). The
  // number is asserted here so it stops drifting, and GZipMiddleware is what
  // actually crosses the wire.
  const files = ["index.html", "style.css", "app.js"];
  const bytes = files.map((name) => Buffer.byteLength(readWeb(name), "utf8"));
  const total = bytes.reduce((a, b) => a + b, 0);
  assert.ok(total < 262144,
    "index.html + style.css + app.js = " + total + " B, over the 262144 B budget: " +
    files.map((name, at) => name + " " + bytes[at]).join(", "));
});

// --- the fake document cannot drift away from index.html --------------------

test("every element app.js reaches for by id exists in index.html and here", () => {
  // buildDocument is a hand-made stand-in for index.html. A selector renamed in
  // one and not the other makes every test using it pass while proving nothing,
  // so both are checked against the same list.
  const source = readWeb("app.js");
  const html = readWeb("index.html");
  const wanted = new Set();
  const literal = /\$\("#([\w-]+)"\)/g;
  let hit;
  while ((hit = literal.exec(source))) wanted.add(hit[1]);
  assert.ok(wanted.size > 30, "the selector sweep found " + wanted.size + " ids");
  const inHtml = new Set((html.match(/\bid="([\w-]+)"/g) || [])
    .map((attr) => attr.slice(4, -1)));
  const ids = [...wanted].sort();
  assert.deepEqual(ids.filter((id) => !inHtml.has(id)), [],
                   "app.js reaches for an id index.html does not ship");
  assert.deepEqual(ids.filter((id) => !document.getElementById(id)), [],
                   "app.js reaches for an id the fake document does not have");
});

test("every option index.html offers is a value this file will accept", () => {
  // A <select> whose options drift away from the allow-lists would silently
  // send a filter the endpoint rejects, or hide one it accepts.
  const html = readWeb("index.html");
  const optionsOf = (id) => {
    const open = html.indexOf('id="' + id + '"');
    assert.ok(open > 0, id + " is in index.html");
    const end = html.indexOf("</select>", open);
    return (html.slice(open, end).match(/value="([^"]*)"/g) || [])
      .map((attr) => attr.slice(7, -1));
  };
  assert.deepEqual(optionsOf("filter-state"), app.LIBRARY_STATES);
  assert.deepEqual(optionsOf("filter-type").filter(Boolean).sort(),
                   [...app.LIBRARY_TYPES].sort());
  assert.deepEqual(optionsOf("page-size"), PAGE_SIZES.map(String));
  assert.deepEqual(optionsOf("density"), LIBRARY_DENSITIES);
  assert.deepEqual(
    (html.match(/data-preset="(\d+)"/g) || []).map((a) => Number(a.slice(13, -1))),
    COMPOSER_PRESETS);
});

// --- stylesheet and shell invariants ----------------------------------------

test("the stylesheet keeps its focus, motion and target rules", () => {
  const css = readWeb("style.css");
  assert.match(css, /:focus-visible \{ outline:2px solid var\(--focus\)/,
               "one visible focus ring for every control");
  // Unscoped, this outranked the ring above for anyone arriving by skip link.
  assert.match(css, /main:focus:not\(:focus-visible\) \{ outline:none/);
  assert.doesNotMatch(css, /\bmain:focus \{ outline:none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // Every control the F6 measurement found under 44px, in the shared block.
  const at = css.indexOf(".panel-retry, .pv-inspect");
  const block = css.slice(at, css.indexOf("}", at));
  ["#shuffle", "#inspector-close", ".linkbtn", ".cmp-presets button"]
    .forEach((sel) => assert.ok(block.includes(sel), sel + " clears 44px"));
  assert.match(css, /\.cmp-presets button \{ min-width:44px/);
  assert.match(css, /\.field-check \{ min-height:44px/);
  // A control's boundary against its panel: --border is 1.64:1 there, which is
  // a divider's contrast rather than a control's (WCAG 1.4.11).
  assert.match(css, /button, \.linkbtn \{[^}]*border:1px solid var\(--muted\)/);
  assert.doesNotMatch(css, /cursor:wait/);
  // Nothing builds these any more.
  [".pack-summary", ".preview-err", ".pv-relax"].forEach((dead) => {
    assert.ok(!css.includes(dead), dead + " is dead CSS");
  });
});

test("index.html keeps its landmarks, headings and hidden decoration", () => {
  const html = readWeb("index.html");
  assert.equal((html.match(/<h1\b/g) || []).length, 1, "exactly one <h1>");
  assert.equal((html.match(/<h2\b/g) || []).length, 6,
               "five views plus the inspector, and no more");
  // Decorative glyphs are not part of an accessible name.
  ["▮", "⟳", "＋", "▶", "◀", "■"].forEach((glyph) => {
    const found = html.indexOf(glyph);
    assert.ok(found > 0 && html.slice(found - 22, found).includes('aria-hidden="true"'),
              glyph + " is hidden from assistive technology");
  });
  assert.match(html, /<link rel="icon"/, "no favicon means a 404 on every load");
  // The five action groups are structure, not styled spans.
  assert.ok(html.includes('<h4 class="lbl">2 · Generate cards'));
  assert.ok(html.includes('<h4 class="lbl">5 · Maintenance'));
  assert.ok(!/<span class="lbl">\d/.test(html));
  assert.match(html, /id="cmp-validation"[^>]*role="status"/s);
});

// --- reduced motion ----------------------------------------------------------

const VIDEO_ROW = { id: "v1", type: "video", kind: "ambient", title: "harbour",
                    media_url: "/media/a.mp4", duration: 6, enabled: 1, health: "ok" };

test("hovering a card previews it, unless reduced motion was asked for", async () => {
  const card = cardEl(VIDEO_ROW);
  const video = descendants(card).find((n) => n.tagName === "VIDEO");
  await card.dispatch("mouseenter");
  assert.equal(video.paused, false, "a pointer may still preview on hover");
  await card.dispatch("mouseleave");
  assert.equal(video.paused, true);

  reduceMotion = true;
  const quiet = cardEl(VIDEO_ROW);
  const still = descendants(quiet).find((n) => n.tagName === "VIDEO");
  await quiet.dispatch("mouseenter");
  assert.equal(still.paused, true,
               "an endless loop started by a hover — a tap, on a touch screen — " +
               "is exactly the motion that was opted out of");
  assert.equal(still.controls, true, "and it can still be played deliberately");
});

test("a row whose media the pool could not read shows words, not a broken box", () => {
  const dead = cardEl(Object.assign({}, VIDEO_ROW, { health: "dead" }));
  assert.equal(descendants(dead).filter((n) => n.tagName === "VIDEO").length, 0,
               "no element points at a file that answers 404");
  assert.match(textOf(dead), /media unreadable/);
  assert.match(badgeText(dead), /Failed.*dead/s);
});

test("a card names itself, so a grid is not a run of unnamed articles", () => {
  const hostile = '<img src=x onerror="globalThis.pwned=81">';
  const card = cardEl(Object.assign({}, VIDEO_ROW, { title: hostile }));
  assert.equal(card.getAttribute("aria-label"), hostile.slice(0, 60));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

// --- the modal focus trap ----------------------------------------------------

const tabInInspector = (shift) => $("#inspector").dispatch("keydown",
  { key: "Tab", shiftKey: Boolean(shift) });

test("the inspector's own preview is in the Tab cycle", async () => {
  // The trap collected only form controls, so a keyboard operator could not
  // reach — let alone play or scrub — the item they had just opened.
  stubInspector({ detail: { type: "video", media_url: "/media/bumpers/a.mp4" } });
  await openInspector("card:psa:abc");
  await flush();
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await tabInInspector(false);
    seen.push(document.activeElement);
  }
  assert.ok(seen.some((n) => n && n.tagName === "VIDEO"),
            "the media preview is a stop: " +
            [...new Set(seen.map((n) => n && n.tagName))].join(","));
  assert.ok(seen.every((n) => $("#inspector").contains(n)),
            "and the trap still holds");
});

test("a busy inspector locks its controls and hands every one of them back",
     async () => {
  stubInspector();
  await openInspector("card:psa:abc");
  await flush();
  const controls = () => descendants($("#inspector-body"))
    .filter((n) => n.tagName === "BUTTON" || n.tagName === "INPUT");
  assert.ok(controls().length > 0);
  const before = controls().length;
  STATE.inspector.busy = "";
  app.setInspectorBusy("rendering…");
  assert.ok(controls().every((n) => n.disabled), "everything is held while it runs");
  app.setInspectorBusy("");
  assert.equal(controls().length, before);
  assert.ok(controls().every((n) => !n.disabled),
            "and nothing is left disabled — the focus list skips a disabled " +
            "control, so handing them back cannot go through it");
});

// --- cleanup on route change -------------------------------------------------

test("an action's job poll does not outlive the view that started it", async (t) => {
  // Measured in a browser at 09015e3: four GET /api/request polls in the twelve
  // seconds after Operations was left. doAction's watch is registered like any
  // other now, so the shared teardown reaches it.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const urls = stubOperations([], () => jsonReply({ status: "working" }));
  await applyHash("#/operations");
  await flush();
  doAction("/api/render/cards", "render cards");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.ok(jobReads(urls) >= 1, "it is polling while the view is open");

  await applyHash("#/overview");
  await flush();
  const settled = jobReads(urls);
  t.mock.timers.tick(30000);
  await flush();
  await flush();
  assert.equal(jobReads(urls), settled,
               "and asks nothing more once the view is gone");
  assert.equal(STATE.route, "overview");
});

test("leaving a view clears the announcement it made", async () => {
  stubRoutes();
  await applyHash("#/library");
  await flush();
  announce("delete cancelled");
  assert.equal($("#live-region").textContent, "delete cancelled");
  await applyHash("#/station");
  await flush();
  assert.equal($("#live-region").textContent, "",
               "a message about the library is not news about the station");
});

test("a route change that closes a dialog lands focus somewhere real", async () => {
  stubInspector();
  await applyHash("#/library");
  await flush();
  await openInspector("card:psa:abc");
  await flush();
  assert.equal(STATE.inspector.open, true);
  await applyHash("#/operations");
  await flush();
  assert.equal(STATE.inspector.open, false);
  assert.equal(document.activeElement, $("#main"),
               "not <body>, which would send the next Tab back to the top");
});

test("the current view's tab is scrolled into view once per change", async () => {
  stubRoutes();
  await applyHash("#/operations");
  await flush();
  const tab = BODY.querySelectorAll("[data-view]")
    .find((a) => a.dataset.view === "operations");
  assert.equal(tab.getAttribute("aria-current"), "page");
  assert.equal(tab.scrolls, 1,
               "below 760px the tab row scrolls, and aria-current can sit off-screen");
  assert.deepEqual(tab.scrollOptions, { block: "nearest", inline: "nearest" });
  renderChrome();
  renderChrome();
  assert.equal(tab.scrolls, 1, "a refresh does not drag the row under the operator");
});

// --- hostile keys ------------------------------------------------------------

test("a map keyed by a server string never answers from its prototype", async () => {
  // The type bars: "constructor" used to answer with a Function, which CSSOM
  // then silently rejected, losing the bar its colour.
  STATE.status.value = Object.assign({}, OK_STATUS,
    { by_type: { constructor: 3, toString: 1 } });
  renderOverview();
  const fills = descendants($("#by-type")).filter((n) => n.className === "fill");
  assert.equal(fills.length, 2);
  fills.forEach((fill) => assert.match(String(fill.style.background), /^var\(--/));

  // The eligibility list: a reason of "constructor" used to render
  // "function Object() { [native code] }" instead of the server's own word.
  stubInspector({ detail: { selection: { eligible_now: false,
    reasons: ["constructor", "toString"], factors: {} } } });
  await openInspector("card:psa:abc");
  await flush();
  const text = inspectorText();
  assert.match(text, /constructor/);
  assert.doesNotMatch(text, /native code/);
});

test("a relaxed rule this build does not know is shown as it arrived", async () => {
  stubFill(breakBody([BREAK_ITEM()],
                     { composition: { relaxed_rules: ["constructor", "exit_ident"] } }));
  await composeBreak();
  const text = textOf($("#composer-attention"));
  assert.match(text, /constructor/);
  assert.doesNotMatch(text, /native code/);
  assert.match(text, /station ident/);
});

// --- empty values ------------------------------------------------------------

test("an empty list is absent, not an empty string", async () => {
  stubInspector({ detail: { creative: { family: "psa", roles: [], energy: "calm",
                                        audio: "bed", text_heavy: true,
                                        template: "minimal_center",
                                        brand_mode: "reveal" } } });
  await openInspector("card:psa:abc");
  await flush();
  const roles = descendants($("#inspector-body"))
    .filter((n) => String(n.className) === "summary-row")
    .find((n) => textOf(n).trim().startsWith("roles"));
  assert.match(textOf(roles), /none/,
               'String([]) is "", which would print as nothing at all');
});

// --- copying a URL without the Clipboard API ---------------------------------

test("without the Clipboard API the field is focused and the legacy copy tried",
     async () => {
  // Selecting an unfocused field is not what execCommand copies, and it is not
  // what the operator's own Ctrl-C would copy either.
  const commands = [];
  document.execCommand = (name) => { commands.push(name); return true; };
  stubClipboard(null);
  stubInspector();
  await openInspector("card:psa:abc");
  await flush();
  await inspectorButton("Copy").click();
  await flush();
  const field = descendants($("#inspector-body"))
    .find((n) => n.tagName === "INPUT" && n.className === "url");
  assert.equal(document.activeElement, field, "the field is focused, then selected");
  assert.equal(field.selected, true);
  assert.deepEqual(commands, ["copy"]);
  assert.match(textOf($("#inspector-body")), /copied/i,
               "on an older browser execCommand IS the copy, and it worked");
  assert.doesNotMatch(textOf($("#inspector-body")), /keyboard/i);
});

test("a legacy copy the browser refuses still ends in a sentence", async () => {
  document.execCommand = () => false;
  stubClipboard(null);
  const row = copyRow(stationBody(), "Standby HLS");
  assert.ok(row, "the standby channel's HLS URL is offered too");
  assert.equal(inputsIn(row)[0].value, F4_STATION.urls.standby);
  await buttonIn(row, "Copy").click();
  await flush();
  assert.match(textOf(row), /Attention/, "a refusal is never reported as a success");
  assert.match(textOf(row), /keyboard/i);
});

// --- empty and failed states -------------------------------------------------

test("an empty library points at the view that can fill it", async () => {
  stubRoutes();
  await applyHash("#/library");
  await flush();
  const state = $("#browse-state");
  assert.equal(state.dataset.state, "empty");
  assert.match(textOf(state), /Operations view/,
               "the generate buttons are not on this page, and never were");
  assert.doesNotMatch(textOf(state), /above/);
  const go = descendants(state).find((n) => n.tagName === "BUTTON");
  assert.equal(go.textContent, "Open operations");
  await go.click();
  assert.equal(global.location.hash, "#/operations");
});

test("a Retry says it is working, so it cannot be mistaken for a dead button",
     async () => {
  const el = new FakeNode("div");
  let asked = 0;
  renderPanelState(el, { state: "error", message: "boom", onAction: () => { asked++; } });
  const retry = descendants(el).find((n) => n.tagName === "BUTTON");
  await retry.click();
  assert.equal(asked, 1);
  assert.equal(retry.disabled, true);
  assert.equal(retry.textContent, "Retrying…");

  // "Clear filters" is not a retry and must keep its own name.
  const filtered = new FakeNode("div");
  renderPanelState(filtered, { state: "empty", message: "none",
                               actionLabel: "Clear filters", onAction: () => {} });
  const clear = descendants(filtered).find((n) => n.tagName === "BUTTON");
  await clear.click();
  assert.equal(clear.textContent, "Clear filters");
});

test("Clear filters from the empty-with-filters state re-reads the listing",
     async () => {
  const calls = stubRoutes();
  await applyHash("#/library?state=parked&q=nothing");
  await flush();
  assert.equal($("#browse-state").dataset.state, "empty");
  const clear = descendants($("#browse-state")).find((n) => n.tagName === "BUTTON");
  assert.equal(clear.textContent, "Clear filters");
  const before = calls.filter((c) => c.url.startsWith("/api/bumpers")).length;
  await clear.click();
  await flush();
  assert.ok(calls.filter((c) => c.url.startsWith("/api/bumpers")).length > before,
            "clearing the filters asks the server the new question");
  assert.equal(STATE.library.filters.state, "all");
  assert.equal(STATE.library.filters.q, "");
  assert.equal(libraryHash(), "#/library");
});

test("the Pool panel's Retry re-issues the status read", async () => {
  let fail = true;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("/api/status")) {
      if (fail) throw new TypeError("Failed to fetch");
      return jsonReply(OK_STATUS);
    }
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    if (u.startsWith("/api/jobs")) return jsonReply({ jobs: [], count: 0 });
    return jsonReply({ count: 0, total: 0, bumpers: [] });
  };
  await applyHash("#/overview");
  await flush();
  assert.equal($("#pool-state").dataset.state, "error");
  fail = false;
  const before = calls.filter((u) => u.startsWith("/api/status")).length;
  await descendants($("#pool-state")).find((n) => n.tagName === "BUTTON").click();
  await flush();
  assert.ok(calls.filter((u) => u.startsWith("/api/status")).length > before);
  assert.equal($("#pool-state").dataset.state, "populated");
});

test("a jobs read that never succeeded does not badge this page's own rows",
     async () => {
  recordJob("render cards");
  stubWithJobs([], { jobsFail: true });
  await loadJobs();
  assert.equal($("#ops-jobs-list").children.length, 1,
               "the job this page started is still true");
  assert.match(textOf($("#ops-jobs-state")), /Showing only the jobs this page started/,
               "the failure is the read's, not the row's");
  assert.match(textOf($("#ops-jobs-state")), /could not be reached|Failed to fetch/);
});

// --- deletion -----------------------------------------------------------------

const LIB_ROW = { id: "vid:a", type: "video", kind: "ambient", title: "harbour",
                  media_url: "/media/a.mp4", duration: 6, enabled: 1, health: "ok" };

async function libraryWithOneRow(reply) {
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    if (method === "DELETE") return jsonReply(reply === undefined ? {} : reply);
    if (u.startsWith("/api/status")) return jsonReply(OK_STATUS);
    if (u.startsWith("/api/station")) return jsonReply(OK_STATION);
    if (u.startsWith("/api/bumpers")) {
      return jsonReply({ count: 1, total: 1, bumpers: [LIB_ROW] });
    }
    return jsonReply({});
  };
  await applyHash("#/library");
  await flush();
}

test("deleting the last visible row leaves an empty listing that says so",
     async () => {
  await libraryWithOneRow({ kind: "ambient", title: "harbour", file_removed: true });
  assert.equal($("#browse-state").dataset.state, "populated");
  const pending = deleteBumper(LIB_ROW);
  await flush();
  dialogButton("Delete permanently").click();
  await pending;
  await flush();
  assert.equal($("#grid").children.length, 0);
  assert.equal($("#browse-state").dataset.state, "empty",
               "a populated badge over an empty grid is not a state");
  assert.equal(document.activeElement, $("#library-counts"),
               "focus lands on the counts rather than falling to <body>");
});

test("a delete answered with an empty body is still a delete", async () => {
  // api() parses a 200 with no body to null; reading j.kind off that used to
  // throw inside a click handler nothing was waiting on.
  await libraryWithOneRow(null);
  const pending = deleteBumper(LIB_ROW);
  await flush();
  dialogButton("Delete permanently").click();
  await pending;
  await flush();
  assert.equal(STATE.library.items.length, 0);
  assert.match($("#live-region").textContent, /deleted/);
});

test("the bulk confirmation's prose agrees with its own checkbox", async () => {
  STATE.status.value = Object.assign({}, OK_STATUS, { by_kind: { ambient: 3 } });
  STATE.library.filters.kind = "ambient";
  global.fetch = async () => jsonReply({ removed: 3, dirs_removed: 1, failed: [] });
  const running = dropKind();
  await flush();
  assert.match(dialogText(), /Unless you tick the box below/,
               "the prose used to promise deletion the checkbox could prevent");
  // The typed gate is exact: a near miss is not consent.
  const typed = dialogControls("INPUT").find((n) => n.type === "text");
  const confirm = dialogButton("Delete 3 item(s)");
  assert.equal(confirm.disabled, true);
  typed.value = "AMBIENT";
  await typed.dispatch("input");
  assert.equal(confirm.disabled, true, "the kind name is matched exactly, not loosely");
  typed.value = " ambient ";
  await typed.dispatch("input");
  assert.equal(confirm.disabled, false, "surrounding space is not a different kind");
  await dialogButton("Cancel").click();
  await running;
});

test("a hostile kind name reaches the bulk dialog as text", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=91">';
  STATE.status.value = Object.assign({}, OK_STATUS, { by_kind: { [hostile]: 2 } });
  STATE.library.filters.kind = hostile;
  const running = dropKind();
  await flush();
  assert.ok(dialogText().includes(hostile));
  assert.equal(descendants(topDialog()).filter((n) => n.tagName === "IMG").length, 0);
  await dialogButton("Cancel").click();
  await running;
  assert.equal(globalThis.pwned, undefined);
});

// --- the composer -------------------------------------------------------------

test("Previous from stopped plays the end of the break, not its end message",
     async () => {
  stubFill(breakBody([BREAK_ITEM(), BREAK_ITEM({ id: "b", title: "second" })]));
  await composeBreak();
  assert.equal(STATE.composer.playback.index, -1);
  advanceComposer(-1);
  assert.equal(STATE.composer.playback.index, 1,
               "nobody who has not started a sequence has finished one");
  assert.doesNotMatch($("#live-region").textContent, /finished/);
});

test("a staged medium that cannot be decoded moves the sequence on", async () => {
  stubFill(breakBody([BREAK_ITEM(), BREAK_ITEM({ id: "b", title: "second" })]));
  await composeBreak();
  playComposerSequence();
  assert.equal(STATE.composer.playback.index, 0);
  await stageVideo().dispatch("error");
  assert.equal(STATE.composer.playback.index, 1,
               "a sequence that sits for ever on an unreadable file is not a preview");
  assert.match($("#live-region").textContent, /previewing item 2/);
});

test("a stalled medium says so and leaves the decision to the operator", async () => {
  stubFill(breakBody([BREAK_ITEM(), BREAK_ITEM({ id: "b" })]));
  await composeBreak();
  playComposerSequence();
  await stageVideo().dispatch("stalled");
  assert.equal(STATE.composer.playback.index, 0, "a stall usually recovers");
  assert.match($("#live-region").textContent, /still waiting.*press Next/);
});

test("an answer that is not an object is not a break", async () => {
  stubFill([]);
  assert.equal(await composeBreak(), null);
  assert.equal($("#composer-state").dataset.state, "error");
  assert.match(textOf($("#composer-state")), /empty response/);
});

test("a library mutation marks a break that contains that row stale", async () => {
  stubFill(breakBody([BREAK_ITEM({ id: "vid:a" })]));
  await composeBreak();
  assert.equal(STATE.composer.stale, false);
  // A row the break does not contain has not changed the sequence on screen.
  assert.equal(markComposerStale("disable", "vid:elsewhere"), null);
  assert.equal(STATE.composer.stale, false);
  assert.equal(markComposerStale("disable", "vid:a"), "disable");
  assert.equal(STATE.composer.stale, true);
});

test("a card drawn by the library subscribes the composer to its mutations",
     async () => {
  // Without this the operator could disable a row from the Library and still
  // play a break holding it, which is the substitution the plan forbids.
  stubFill(breakBody([BREAK_ITEM({ id: "vid:a" })]));
  await composeBreak();
  assert.equal(STATE.composer.stale, false);
  STATE.library.items = [LIB_ROW];
  app.renderLibrary();
  global.fetch = async () => jsonReply({ changed: true });
  await inspectButton($("#grid").children[0]).click();
  await flush();
  await disableBumper(LIB_ROW);
  await flush();
  assert.equal(STATE.composer.stale, true,
               "the break holding this row is marked, not quietly patched up");
});

// --- jobs: doubt, focus and bounded output -----------------------------------

test("leaving Operations takes the doubt with the poll it belonged to", async (t) => {
  // A note with neither Check now nor Retry beside it is not an escape: the
  // watch that raised it is gone, so the note goes with it and the fresh watch
  // raises its own the moment a read is lost again.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let failing = true;
  const urls = stubOperations(
    [serverJob({ id: "n7", request: "station conform", status: "working", result: null })],
    () => { if (failing) throw new TypeError("Failed to fetch"); return jsonReply({ status: "done", result: "ok" }); });
  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.match(textOf($("#ops-jobs-list")), /status unknown/);
  assert.ok(buttonIn($("#ops-jobs-list"), "Check now"), "and a way to ask again");

  await applyHash("#/overview");
  await flush();
  assert.deepEqual(STATE.ops.jobNotes, {},
                   "the doubt belonged to a poll that no longer exists");
  assert.equal(jobReads(urls) >= 1, true);
  failing = false;
});

test("Check now keeps the focus that pressed it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const urls = stubOperations(
    [serverJob({ id: "n8", request: "render cards", status: "working", result: null })],
    () => { throw new TypeError("Failed to fetch"); });
  await applyHash("#/operations");
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  const check = buttonIn($("#ops-jobs-list"), "Check now");
  assert.ok(check);
  check.focus();
  await check.click();
  t.mock.timers.tick(10000);
  await flush();
  const now = document.activeElement;
  assert.ok(now && String(now.className).includes("jobrow-check"),
            "the row is rebuilt around the button, so its replacement is handed " +
            "the focus rather than letting it fall to <body>");
  assert.ok(jobReads(urls) >= 2);
  stopJobWatches();
});

test("a long job result is bounded before it reaches the page", () => {
  const huge = "x".repeat(5000);
  STATE.route = "operations";
  STATE.jobs.server = [serverJob({ id: "big", status: "error", result: huge })];
  renderOpsJobs();
  const pre = descendants($("#ops-jobs-list"))
    .find((n) => n.tagName === "PRE" && String(n.className).includes("jobrow-result"));
  assert.ok(pre, "the raw result is in an expandable block");
  assert.equal(pre.textContent.length, 2001, "2000 characters plus the ellipsis");
  assert.ok(pre.textContent.endsWith("…"), "and it says it was cut");
});

test("the Overview's list is the server's registry, not only this tab's", async () => {
  const calls = stubWithJobs([serverJob({ id: "elsewhere", request: "tidy up",
                                          status: "error", result: "no space" })]);
  await applyHash("#/overview");
  await flush();
  assert.ok(calls.some((c) => c.url.startsWith("/api/jobs")));
  assert.match(textOf($("#jobs-list")), /tidy up/,
               "a job another tab or the schedule started is still an operator's");
  assert.match(textOf($("#warnings")), /A job failed: tidy up/);
});

// --- hostile strings in the places F6 added or moved --------------------------

test("hostile creative, payload and stage strings stay text everywhere", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=95">';
  const row = BREAK_ITEM({ id: "vid:h", title: hostile,
    creative: { family: hostile, audio: hostile, roles: [hostile],
                energy: hostile, text_heavy: false, template: hostile,
                brand_mode: hostile },
    payload: { lines: [hostile] } });
  // The card's chips.
  const card = cardEl(row);
  assert.ok(textOf(card).includes(hostile));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  // The composer's stage label and its text card.
  stubFill(breakBody([Object.assign({}, row, { type: "card", media_url: null })]));
  await composeBreak();
  playComposerSequence();
  const stage = $("#composer-stage");
  assert.ok(textOf(stage).includes(hostile), "the stage label names the item");
  assert.equal(descendants(stage).filter((n) => n.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("every route entered in turn leaves no clock and no medium running",
     async (t) => {
  // The whole cleanup contract in one pass: enter all five views, start the
  // things each of them can start, and prove that leaving the last one — which
  // is one of the two with a 20-second clock — leaves nothing ticking.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const ROW = { id: "vid:a", type: "video", kind: "ambient", title: "harbour",
                media_url: "/media/a.mp4", duration: 6, enabled: 1, health: "ok" };
  stubRoutes({ bumpers: { count: 1, total: 1, bumpers: [ROW] } });
  for (const route of ROUTES) {
    await applyHash("#/" + route);
    await flush();
  }

  // A composed break, playing.
  await applyHash("#/composer");
  await flush();
  stubFill(breakBody([BREAK_ITEM(), CARD_ITEM({ duration: 4 })]));
  await composeBreak();
  playComposerSequence();
  assert.equal(STATE.composer.playback.index, 0, "something really is running");

  // A search mid-debounce and a card preview, on the library.
  stubRoutes({ bumpers: { count: 1, total: 1, bumpers: [ROW] } });
  await applyHash("#/library");
  await flush();
  await flush();
  scheduleSearch("harbour");
  const card = $("#grid").children[0];
  const video = descendants(card).find((n) => n.tagName === "VIDEO");
  await card.dispatch("mouseenter");
  assert.equal(video.paused, false, "and something really is playing");

  // End on a view that has a clock, so a surviving one would be visible.
  await applyHash("#/station");
  await flush();
  const after = stubRoutes({ bumpers: { count: 1, total: 1, bumpers: [ROW] } });
  t.mock.timers.tick(REFRESH_MS);
  await flush();
  assert.ok(after.length > 0, "the station's clock is live while the view is");

  app.exitRoute("station");
  const settled = after.length;
  t.mock.timers.tick(120000);
  await flush();
  await flush();
  assert.equal(after.length, settled,
               "no clock survived the exit: " +
               after.slice(settled).map((c) => c.url).join(", "));
  assert.deepEqual(
    descendants(BODY).filter((n) => (n.tagName === "VIDEO" || n.tagName === "AUDIO") &&
                                    !n.paused).map((n) => n.src),
    [], "and no medium is still playing");
  assert.equal(STATE.composer.playback.index, -1, "the sequence was stopped");
  assert.equal($("#composer-stage").children.length, 0, "and its stage emptied");
});

test("the shell keeps one h1, ordered headings and a named current view",
     async () => {
  stubRoutes();
  for (const route of ROUTES) {
    await applyHash("#/" + route);
    await flush();
    const current = BODY.querySelectorAll("[data-view]")
      .filter((a) => a.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1, route + " marks exactly one view current");
    assert.equal(current[0].dataset.view, route);
    const view = $("#view-" + route);
    assert.equal(view.hidden, false);
    assert.equal(ROUTES.filter((r) => r !== route)
      .every((r) => $("#view-" + r).hidden), true, "and hides the other four");
  }
});

// The last test in this file leaves whatever route it entered behind, and its
// 20-second refresh interval would keep the runner alive past the suite. This
// is the teardown beforeEach already does for every other test.
test.after(() => { if (resetStateForTests) resetStateForTests(); });
