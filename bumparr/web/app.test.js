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
          el("div", { className: "viewtools" }, [
            el("button", { id: "preview-one" }),
            el("button", { data: { pack: "30" } }),
          ]),
          el("div", { className: "panel wide" }, [
            el("div", { id: "preview-state", className: "panel-state" }),
            el("div", { id: "preview-summary" }),
            el("div", { id: "preview-grid", className: "grid" }),
          ]),
        ]),
        view("view-station", [
          el("div", { className: "viewtools" }, [
            el("button", { data: { station: "conform" } }),
          ]),
          el("div", { className: "panel wide" }, [
            el("div", { id: "station-state", className: "panel-state" }),
            el("div", { id: "station" }),
          ]),
        ]),
        view("view-operations", [
          panel("panel-ask", [
            el("input", { id: "ask", value: "" }),
            el("button", { id: "ask-go" }),
            el("div", { id: "ask-result" }),
          ]),
          panel("panel-actions", [
            el("div", { id: "actions-state", className: "panel-state" }),
            el("div", { className: "actions" }, [
              el("button", { data: { gen: "trivia" } }),
              el("button", { data: { src: "fetch-queue" } }),
              el("button", { data: { starter: "dry" } }),
              el("button", { data: { maint: "tidy" } }),
            ]),
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
        previewPack, previewOne, packSummaryEl, freshnessLine, api, isApiAbort,
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
        LIBRARY_DENSITIES, NOT_AVAILABLE } = app;

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
  assert.ok(buttons.length > 1, "the panel disables more than the clicked button");

  const running = doAction("/api/generate/trivia?n=20", "generate trivia");
  await flush();
  assert.ok(buttons.every((b) => b.disabled), "the panel is held while the job starts");

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
    creative: { family, template: "minimal_center", brand_mode: "reveal" },
    selection: { factors: { base: 1, score: 0.5 } },
  });
  const text = descendants(card).find((n) => n.className === "pv-creative").textContent;
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
// Preview
// ---------------------------------------------------------------------------

test("empty pack preview shows a message, not leftover cards", () => {
  const el = packSummaryEl({
    requested: 15, total: 0, gap: 15, exact: false, count: 0, bumpers: [],
    note: "no bumper is short enough for this gap",
    composition: { relaxed_rules: [] },
  });
  const text = JSON.stringify(el);
  assert.ok(text.includes("nothing in this pack") || text.includes("no bumper is short enough"));
  assert.ok(text.includes("Requested 15s"));
  assert.equal(el.children.filter((n) => n.className === "pv-card").length, 0);
});

test("pack summary reports error text for a missing body", () => {
  const el = packSummaryEl(null);
  assert.ok(JSON.stringify(el).includes("preview failed: empty response"));
});

test("pack preview only GETs fill and never mutates history", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    return jsonReply({
      requested: 15, total: 0, gap: 15, exact: false, count: 0, bumpers: [],
      composition: { relaxed_rules: ["exit_ident"] },
    });
  };
  await previewPack(15);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.every((c) => !/\/station\//.test(c.url)));
  assert.ok(calls.some((c) => c.url.includes("/api/bumpers/fill") && c.url.includes("seconds=15")));
  assert.ok(calls.every((c) => !c.url.includes("advance")));
});

test("one-item preview is a GET with explain and reports errors as text", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    return { ok: false, status: 503, text: async () => JSON.stringify({ error: "offline" }) };
  };
  await previewOne();
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.some((c) => c.url.includes("/api/bumpers/random") && c.url.includes("explain=true")));
  assert.equal($("#preview-state").dataset.state, "error");
  assert.match(textOf($("#preview-state")), /offline/);
});

test("failed pack preview reports the error as text", async () => {
  global.fetch = async () => { throw new Error("network down"); };
  await previewPack(30);
  assert.equal($("#preview-state").dataset.state, "error");
  assert.match(textOf($("#preview-state")), /could not be reached/);
});

test("a failed preview keeps the last good pack rather than blanking it", async () => {
  global.fetch = async () => jsonReply({
    requested: 15, total: 15, gap: 0, exact: true, count: 1,
    bumpers: [{ type: "card", kind: "psa", title: "keep me", payload: { text: "keep me" } }],
  });
  await previewPack(15);
  assert.equal($("#preview-grid").children.length, 1);

  global.fetch = async () => { throw new Error("gone"); };
  await previewPack(15);
  assert.equal($("#preview-grid").children.length, 1, "known-good cards survive a failure");
  assert.equal($("#preview-state").dataset.state, "stale");
  assert.match(textOf($("#preview-state")), /could not be reached/);
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

test("the overview reads nothing but the pool and the station", async () => {
  const calls = stubRoutes();
  await applyHash("#/overview");
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => c.method === "GET"), "the overview never writes");
  assert.ok(calls.every((c) => /^\/api\/(status|station)($|\?)/.test(c.url)),
            "the overview reads only /api/status and /api/station: " + JSON.stringify(calls));
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
  assert.ok(calls.every((c) => c.url.startsWith("/api/status")),
            "entering a view reads the header's status and nothing else: " +
            JSON.stringify(calls));
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
    if (u.startsWith("/api/bumpers")) {
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

test("Escape does not dismiss a destructive confirmation", async () => {
  // Cancel is focused and first, so leaving is one keystroke either way; what
  // must never happen is a stray Escape being taken for an answer.
  stubInspector();
  const pending = deleteBumper({ id: "a", title: "x" });
  await flush();
  const dlg = topDialog();
  await dlg.dispatch("keydown", { key: "Escape" });
  assert.equal(topDialog(), dlg, "the confirmation is still up");
  dialogButton("Cancel").click();
  assert.equal(await pending, null);
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
