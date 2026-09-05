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
  removeAttribute(name) { delete this.attributes[name]; }
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
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(selector) {
    return this.descendants().find((n) => matchesSelector(n, selector)) || null;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((n) => matchesSelector(n, selector));
  }
}

// A stand-in for index.html: only the ids/hooks app.js reaches for, in the same
// nesting, so a selector that would miss in the browser also misses here.
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
  const body = el("body", {}, [
    el("a", { className: "skip-link" }),
    el("header", {}, [
      el("h1", { className: "brand", textContent: "Bumparr" }),
      el("nav", { className: "panelnav" }),
      el("div", { id: "status-pill", className: "pill" }),
    ]),
    el("main", { id: "main" }, [
      el("p", { id: "live-region", className: "live-region" }),
      panel("panel-ask", [
        el("input", { id: "ask", value: "" }),
        el("button", { id: "ask-go" }),
        el("div", { id: "ask-result" }),
      ]),
      panel("panel-pool", [
        el("div", { id: "pool-state", className: "panel-state" }),
        el("div", { id: "totals" }),
        el("div", { id: "by-type" }),
        el("div", { id: "memory-status" }),
      ]),
      panel("panel-station", [
        el("div", { id: "station-state", className: "panel-state" }),
        el("div", { id: "station" }),
        el("div", { className: "action-group" }, [
          el("button", { data: { station: "conform" } }),
        ]),
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
      panel("panel-preview", [
        el("button", { id: "preview-one" }),
        el("button", { data: { pack: "30" } }),
        el("div", { id: "preview-state", className: "panel-state" }),
        el("div", { id: "preview-summary" }),
        el("div", { id: "preview-grid", className: "grid" }),
      ]),
      panel("panel-browse", [
        el("input", { id: "search", value: "" }),
        el("button", { id: "shuffle" }),
        el("div", { id: "filters" }),
        el("div", { id: "browse-state", className: "panel-state" }),
        el("div", { id: "grid", className: "grid" }),
        el("button", { id: "more", hidden: true }),
      ]),
    ]),
    el("footer", {}),
  ]);
  return body;
}

let BODY = buildDocument();
const docListeners = new Map();

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

const app = require("./app.js");
const { cardEl, pollJob, enableBumper, deleteBumper, stationEl, stationState,
        previewPack, previewOne, packSummaryEl, freshnessLine, api, isApiAbort,
        renderPanelState, statusBadge, formatAge, formatDuration, loadGrid,
        loadStatus, scheduleSearch, refreshTick, handleVisibilityChange,
        announce, STATE, API_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, REFRESH_MS,
        doAction, submitAsk, resetStateForTests } = app;

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

const buttonClasses = (row) => descendants(cardEl(row))
  .filter((node) => node.tagName === "BUTTON").map((node) => node.className);

const $ = (sel) => document.querySelector(sel);
const logText = () => $("#log").textContent;
const textOf = (node) => descendants(node).map((n) => n.textContent).join(" ");
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

const enableButton = (card) => descendants(card).find(
  (node) => node.tagName === "BUTTON" && String(node.className).split(" ").includes("pv-enable"));

test("a parked row's card offers the enable control", () => {
  const button = enableButton(cardEl(
    { type: "stream", kind: "webcam", title: "harbour", enabled: 0 }));
  assert.ok(button, "a parked row should carry an enable button");
  assert.equal(button.textContent, "✓ enable");
});

test("an enabled row's card has no enable control", () => {
  // Asserted against the parked twin rather than against undefined: on its own,
  // "the button is absent" is also what deleting addEnable entirely would say.
  const row = { type: "stream", kind: "webcam", title: "harbour" };
  assert.deepEqual(buttonClasses({ ...row, enabled: 1 }), ["pv-del"]);
  assert.deepEqual(buttonClasses({ ...row, enabled: 0 }), ["pv-del", "fchip pv-enable"]);
});

test("a row that never says whether it is parked gets no enable control", () => {
  // /api/bumpers/random — the shuffle preview — returns nothing but live rows
  // and has no `enabled` key at all. Reading that undefined as parked put the
  // pill on every card in the preview, each click a POST that logged
  // "(already on)". Missing data is not evidence of a park.
  const row = { type: "stream", kind: "webcam", title: "harbour" };
  assert.equal(enableButton(cardEl(row)), undefined);
  assert.deepEqual(buttonClasses(row), ["pv-del"]);
  assert.deepEqual(buttonClasses({ ...row, enabled: null }), ["pv-del"]);
});

test("the enable control is built from DOM nodes, not row markup", () => {
  // Same rule as the first test: a hostile title reaches the button only as a
  // property, never as parsed markup, and never as its label.
  const title = '<img src=x onerror="globalThis.pwned=3">';
  const button = enableButton(cardEl(
    { type: "card", kind: "on_this_day", title, enabled: 0, payload: { text: "x" } }));
  assert.equal(button.textContent, "✓ enable");
  assert.equal(descendants(cardEl({ type: "card", title, enabled: 0 }))
    .filter((node) => node.tagName === "IMG").length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test("per-card controls are always visible and carry a name, not just a glyph", () => {
  // They used to appear on hover only, which is no control at all on a touch
  // screen or by keyboard. The name has to survive a hostile title too.
  const title = '<img src=x onerror="globalThis.pwned=4">';
  const card = cardEl({ type: "stream", kind: "webcam", title, enabled: 0 });
  const del = descendants(card).find((n) => n.className === "pv-del");
  assert.equal(del.hidden, false);
  assert.ok(del.getAttribute("aria-label").includes(title));
  assert.equal(descendants(card).filter((n) => n.tagName === "IMG").length, 0);
  assert.ok(enableButton(card).getAttribute("aria-label").includes(title));
  assert.equal(globalThis.pwned, undefined);
});

test("a declined confirmation sends no destructive request", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET" });
    return jsonReply({});
  };
  global.confirm = () => false;
  await deleteBumper({ id: "vid:x", title: "x" }, new FakeNode("div"));
  assert.deepEqual(calls, []);
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
  assert.match(calls[0].url, /enabled=false/);
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
