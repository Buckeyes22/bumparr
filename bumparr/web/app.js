"use strict";
const $ = (s) => document.querySelector(s);
const log = (m) => { const el = $("#log"); el.textContent = (m + "\n" + el.textContent).slice(0, 4000); };
const makeEl = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

let STATE = { kind: null, search: "", parked: false, offset: 0, kinds: {} };
const PAGE = 24;
const GEN_TERMINAL = { completed: 1, failed: 1, cancelled: 1 };
let GEN_TIMER = null;
let GEN_PREFLIGHT = null;
let GEN_MODELS = [];
let GEN_CREATING = false;
let GEN_JOBS_OFFSET = 0;
let GEN_REVIEW_OFFSET = 0;
let GEN_DEFAULT_MODEL = "";
let GEN_LOAD_VERSION = 0;
const GEN_RENDERED = {};

async function loadStatus() {
  let s;
  try { s = await (await fetch("/api/status")).json(); }
  catch (e) { $("#status-pill").textContent = "offline"; return; }
  STATE.kinds = s.by_kind;
  $("#status-pill").textContent = s.total + " bumpers · " + s.playable_now + " live";
  const totals = $("#totals"); totals.replaceChildren();
  [[s.total, "total"], [s.playable_now, "playable now"],
   [Object.keys(s.by_kind).length, "kinds"]].forEach(([n, label]) => {
    const box = makeEl("div", "num", n); box.appendChild(makeEl("small", "", label));
    totals.appendChild(box);
  });
  const max = Math.max(1, ...Object.values(s.by_type));
  const typeColor = { video: "#5db3a0", stream: "#c9a15d", card: "#7b83cc", image: "#9a7bcc" };
  const memEl = $("#memory-status");
  if (memEl) {
    memEl.replaceChildren();
    const mem = s.memory;
    if (mem && typeof mem === "object") {
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
  }
  const typeBox = $("#by-type"); typeBox.replaceChildren();
  Object.entries(s.by_type).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    const bar = makeEl("div", "bar"), track = makeEl("span", "track"), fill = makeEl("span", "fill");
    fill.style.width = (100 * n / max) + "%";
    fill.style.background = typeColor[t] || "#5db3a0";
    track.appendChild(fill);
    bar.append(makeEl("span", "name", t), track, makeEl("span", "n", n));
    typeBox.appendChild(bar);
  });
  renderFilters();
}

function renderFilters() {
  const kinds = Object.entries(STATE.kinds).sort((a, b) => b[1] - a[1]);
  const total = Object.values(STATE.kinds).reduce((a, b) => a + b, 0);
  const filters = $("#filters"); filters.replaceChildren();
  const chip = (k, label, n) => {
    const b = makeEl("button", "fchip" + (STATE.kind === k ? " on" : ""), label);
    b.dataset.kind = k === null ? "" : k;
    b.appendChild(makeEl("b", "", n));
    filters.appendChild(b);
  };
  chip(null, "all", total);
  kinds.forEach(([k, n]) => chip(k, k, n));
  // The other half of ?enabled=false. A parked row is the one thing you cannot
  // find by scrolling — the pool lists newest first, not parked first — and the
  // enable control only shows up once you have found one. Filters compose on
  // the server, so this narrows the current kind/search rather than replacing it.
  const parked = makeEl("button", "fchip parked" + (STATE.parked ? " on" : ""),
                        "⏸ parked only");
  parked.id = "parked-only";
  filters.appendChild(parked);
  parked.addEventListener("click", () => {
    STATE.parked = !STATE.parked;
    STATE.offset = 0;
    renderFilters();
    loadGrid(true);
  });
  // Dropping a whole category is the usual fix when a search returned junk, so
  // it is offered only while that category is actually selected — never next to
  // "all", where a mis-click would be catastrophic.
  if (STATE.kind) {
    const danger = makeEl("button", "fchip danger", '✕ delete all "' + STATE.kind + '"');
    danger.id = "drop-kind"; filters.appendChild(danger);
  }
  const dk = $("#drop-kind");
  if (dk) dk.addEventListener("click", async () => {
    const k = STATE.kind, n = STATE.kinds[k] || 0;
    if (!confirm('Delete the entire "' + k + '" category?\n\n' + n +
                 " bumper(s) and their files are removed permanently.")) return;
    try {
      const r = await fetch("/api/pool/kind/" + encodeURIComponent(k), { method: "DELETE" });
      const j = await r.json();
      log("dropped category " + k + ": removed " + j.removed +
          (j.dirs_removed ? ", " + j.dirs_removed + " dir(s)" : ""));
      STATE.kind = null; STATE.offset = 0;
      await loadStatus(); loadGrid(true);
    } catch (e) { log("category delete failed: " + e); }
  });
  // Only the kind chips — the ones `chip()` stamped with data-kind. A bare
  // ".fchip" sweep would also catch the delete-category chip, the parked toggle
  // and every .pv-enable button in the grid, handing each of them a kind reset
  // it never asked for (and a fresh duplicate listener on every re-render).
  filters.querySelectorAll(".fchip[data-kind]").forEach((b) => b.addEventListener("click", () => {
    STATE.kind = b.dataset.kind || null;
    STATE.offset = 0;
    renderFilters();
    loadGrid(true);
  }));
}

async function deleteBumper(b, el) {
  const what = (b.title || b.kind || "this bumper").slice(0, 60);
  if (!confirm("Delete \"" + what + "\"?\n\nThe file is removed too, so it cannot come back on the next scan.")) return;
  try {
    const r = await fetch("/api/bumpers/" + encodeURIComponent(b.id), { method: "DELETE" });
    const j = await r.json();
    if (!r.ok) { log("delete failed: " + (j.error || r.status)); return; }
    el.classList.add("gone");
    setTimeout(() => el.remove(), 220);
    log("deleted " + j.kind + " · " + (j.title || b.id) + (j.file_removed ? " (file removed)" : ""));
    loadStatus();
  } catch (e) { log("delete failed: " + e); }
}

function addDelete(el, b) {
  const x = document.createElement("button");
  x.className = "pv-del";
  x.title = "Delete this bumper";
  x.textContent = "✕";
  x.addEventListener("click", (ev) => { ev.stopPropagation(); deleteBumper(b, el); });
  el.appendChild(x);
}

// Bringing a parked row back on. The pool keeps rows the system switched off —
// a cam dropped from the YAML, a file the asset sweep could not find — and the
// only way back used to be spotting the id in the list and curling it. The
// server may answer with a `warning` (an on_this_day card is parked by the
// calendar, not by anyone, and the rotation will take it back); relay it rather
// than let the click look like the last word.
async function enableBumper(b) {
  try {
    const r = await fetch("/api/pool/enable?bumper_id=" + encodeURIComponent(b.id),
                          { method: "POST" });
    const j = await r.json();
    if (!r.ok) { log("enable failed: " + (j.error || r.status)); return; }
    log("enabled " + (b.title || b.kind || b.id) +
        (j.changed ? "" : " (already on)") +
        (j.warning ? " — " + j.warning : ""));
    await loadStatus();
    loadGrid(true);
  } catch (e) { log("enable failed: " + e); }
}

// Only a row KNOWN to be parked gets the control. /api/bumpers returns `enabled`
// as 0/1, so falsy is the parked test — but only when the key is actually there.
// /api/bumpers/random (the shuffle preview) omits it entirely and returns none
// but live rows, so a missing value must mean "no button", not "parked": an
// action control appears on evidence of a park, never on the absence of data.
function addEnable(el, b) {
  if (b.enabled === undefined || b.enabled === null || b.enabled) return;
  const x = document.createElement("button");
  x.className = "fchip pv-enable";
  x.title = "Parked — turn this bumper back on";
  x.textContent = "✓ enable";
  x.addEventListener("click", (ev) => { ev.stopPropagation(); enableBumper(b); });
  el.appendChild(x);
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

function cardEl(b) {
  const card = document.createElement("div");
  card.className = "pv-card";
  if (b.type === "video") {
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "metadata";
    v.src = String(b.media_url || "") + "#t=2";
    const body = makeEl("div", "pv-body");
    body.append(makeEl("div", "pv-kind", b.kind || ""),
                makeEl("div", "pv-title", b.title || ""),
                makeEl("div", "pv-meta", Math.round(b.duration || 0) + "s · video"));
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
  grid.replaceChildren();
  (d.bumpers || []).forEach((b) => grid.appendChild(cardEl(b)));
}

async function previewPack(seconds) {
  const summary = $("#preview-summary");
  const grid = $("#preview-grid");
  if (grid) grid.replaceChildren();
  if (summary) summary.replaceChildren(makeEl("div", "muted", "composing " + seconds + "s pack…"));
  try {
    const r = await fetch("/api/bumpers/fill?seconds=" + encodeURIComponent(seconds) + "&explain=true");
    const d = await r.json();
    if (!r.ok) {
      if (summary) summary.replaceChildren(makeEl("div", "preview-err",
        (d && d.error) ? d.error : ("preview failed: " + r.status)));
      return d;
    }
    renderPackPreview(d);
    return d;
  } catch (e) {
    if (summary) summary.replaceChildren(makeEl("div", "preview-err", "preview failed: " + e));
    return null;
  }
}

async function previewOne() {
  const summary = $("#preview-summary");
  const grid = $("#preview-grid");
  if (grid) grid.replaceChildren();
  if (summary) summary.replaceChildren(makeEl("div", "muted", "loading one item…"));
  try {
    const r = await fetch("/api/bumpers/random?count=1&explain=true");
    const d = await r.json();
    if (!r.ok) {
      if (summary) summary.replaceChildren(makeEl("div", "preview-err",
        (d && d.error) ? d.error : ("preview failed: " + r.status)));
      return d;
    }
    if (summary) summary.replaceChildren(makeEl("div", "pack-summary",
      d.count ? "one item" : "nothing to preview"));
    if (grid) {
      grid.replaceChildren();
      (d.bumpers || []).forEach((b) => grid.appendChild(cardEl(b)));
      if (!d.count) grid.appendChild(makeEl("div", "empty", "nothing here yet"));
    }
    return d;
  } catch (e) {
    if (summary) summary.replaceChildren(makeEl("div", "preview-err", "preview failed: " + e));
    return null;
  }
}

function stationEl(s) {
  const root = makeEl("div", "station-body");
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
    row.append(makeEl("span", "lbl", label));
    const input = document.createElement("input");
    input.readOnly = true; input.className = "url"; input.value = urls[key] || "";
    input.addEventListener("focus", () => input.select && input.select());
    row.append(input);
    root.append(row);
  }
  root.append(makeEl("div", "muted", s.ffmpeg === false
    ? "ffmpeg not found: nothing can be conformed"
    : (s.conformed || 0) + " / " + (s.eligible || 0) + " conformed"));
  return root;
}

async function loadStation() {
  let s;
  try { s = await (await fetch("/api/station")).json(); } catch (e) { return; }
  const el = $("#station");
  el.textContent = "";
  el.append(stationEl(s));
}

// Housekeeping actions. Both are safe and idempotent — they only remove debris
// or restore assets whose media is verifiably fine — so neither needs a confirm.
const MAINT = {
  tidy: { url: "/api/pool/tidy", say: (j) =>
    "tidy: removed " + j.zero_byte_files + " empty file(s), " + j.empty_dirs + " empty dir(s)" },
  revive: { url: "/api/pool/revive", say: (j) =>
    "recheck: " + j.restored + " restored, " + j.still_dead + " still unplayable, " +
    j.skipped_streams + " stream(s) skipped" },
};

function wireMaintenance() {
  document.querySelectorAll("[data-maint]").forEach((b) => b.addEventListener("click", async () => {
    const m = MAINT[b.dataset.maint];
    const label = b.textContent;
    b.disabled = true; b.textContent = "working…";
    try {
      const j = await (await fetch(m.url, { method: "POST" })).json();
      log(m.say(j));
      await loadStatus();
      loadGrid(true);
    } catch (e) { log("failed: " + e); }
    b.disabled = false; b.textContent = label;
  }));

  document.querySelectorAll("[data-starter]").forEach((b) => b.addEventListener("click", async () => {
    const dry = b.dataset.starter === "dry";
    if (!dry && !confirm("Run the starter seeds?\n\nThis downloads clips from the stock " +
                         "and archive sources using your own API keys. It can take several " +
                         "minutes and is deliberately paced so the archives don't throttle you."))
      return;
    await doAction("/api/starter?dry_run=" + dry, dry ? "check starter" : "run starter");
  }));
}

async function loadGrid(reset) {
  if (reset) { STATE.offset = 0; $("#grid").innerHTML = ""; }
  const params = new URLSearchParams({ limit: PAGE, offset: STATE.offset });
  if (STATE.kind) params.set("kind", STATE.kind);
  if (STATE.parked) params.set("enabled", "false");
  if (STATE.search) params.set("q", STATE.search);
  let d;
  try { d = await (await fetch("/api/bumpers?" + params)).json(); }
  catch (e) { return; }
  const grid = $("#grid");
  let shown = 0;
  for (const b of d.bumpers) {
    // text cards render from the payload included in the list response
    // (cardEl falls back to the title when it is absent)
    grid.appendChild(cardEl(b));
    shown++;
  }
  STATE.offset += d.count;
  $("#more").classList.toggle("hidden", d.count < PAGE);
  if (reset && shown === 0) grid.replaceChildren(makeEl("div", "empty", "nothing here yet — generate some cards above"));
}

async function shufflePreview() {
  // The preview draws from /api/bumpers/random, which serves only live rows:
  // leaving the parked chip lit would claim these are the parked ones.
  STATE.kind = null; STATE.search = ""; STATE.parked = false; $("#search").value = "";
  renderFilters();
  const d = await (await fetch("/api/bumpers/random?count=" + PAGE)).json();
  const grid = $("#grid"); grid.innerHTML = "";
  d.bumpers.forEach((b) => grid.appendChild(cardEl(b)));
  $("#more").classList.add("hidden");
}

async function pollJob(job, getStatus = async (jobId) =>
  (await fetch("/api/request/" + encodeURIComponent(jobId))).json(),
pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const jobId = job.job_id;
  let current = job;
  while (jobId && current.status === "working") {
    await pause(3000);
    current = await getStatus(jobId);
  }
  return current;
}

async function doAction(url, label) {
  const btns = document.querySelectorAll(".actions button");
  btns.forEach((b) => b.disabled = true);
  log("→ " + label + " …");
  try {
    let r = await (await fetch(url, { method: "POST" })).json();
    if (r.job_id) r = await pollJob(r);
    const result = r.result === undefined ? r : r.result;
    const msg = typeof result === "string" ? result : JSON.stringify(result);
    log((["error", "unknown"].includes(r.status) ? "✗ " : "✓ ") + label + ": " +
        msg.trim().split("\n").slice(-2).join(" "));
  } catch (e) { log("✗ " + label + " failed: " + e); }
  btns.forEach((b) => b.disabled = false);
  loadStatus(); loadGrid(true);
  loadStation();
}

async function submitAsk() {
  const inp = $("#ask"), btn = $("#ask-go"), out = $("#ask-result");
  const text = inp.value.trim();
  if (!text) return;
  btn.disabled = true; inp.disabled = true;
  out.className = "ask-result working";
  out.textContent = "⋯ working on it — downloads/captures can take a bit";
  const finish = (ok, msg) => {
    out.className = "ask-result " + (ok ? "done" : "err");
    out.textContent = (ok ? "✓ " : "✗ ") + msg;
    btn.disabled = false; inp.disabled = false; inp.focus();
    loadStatus(); loadGrid(true);
  };
  let job;
  try {
    // Kick off the background job; this returns immediately (no proxy timeout).
    job = await (await fetch("/api/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    })).json();
  } catch (e) { return finish(false, "" + e); }
  if (!job.job_id) { return finish(job.status !== "error", job.result || "done"); }
  inp.value = "";
  // Poll the job until it finishes (up to ~5 min for big multi-clip pulls).
  let tries = 0;
  const poll = async () => {
    tries++;
    let s;
    try { s = await (await fetch("/api/request/" + job.job_id)).json(); }
    catch (e) { return finish(false, "lost track of the job: " + e); }
    if (s.status === "working") {
      out.textContent = "⋯ working on it… (" + tries * 3 + "s)";
      if (tries < 100) return void setTimeout(poll, 3000);
      return finish(false, "still going after 5 min — check the pool; it may still be landing");
    }
    finish(s.status === "done", s.result || "done");
  };
  setTimeout(poll, 2000);
}
function currentView() {
  const hash = (location.hash || "#/overview").replace(/^#/, "");
  return hash === "/generation" ? "generation" : "overview";
}

function applyView() {
  const view = currentView();
  const gen = $("#generation-view");
  const overview = $("#overview-view");
  if (gen) gen.hidden = view !== "generation";
  if (overview) overview.hidden = view === "generation";
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "generation") loadGeneration();
  else stopGenerationPoll();
}

function stopGenerationPoll() {
  if (GEN_TIMER) { clearTimeout(GEN_TIMER); GEN_TIMER = null; }
}

function genBody() {
  const model = $("#gen-model") && $("#gen-model").value;
  return {
    model,
    output: "video",
    mode: "text",
    prompt: ($("#gen-brief") && $("#gen-brief").value) || "",
    duration: Number($("#gen-duration") && $("#gen-duration").value),
    resolution: ($("#gen-resolution") && $("#gen-resolution").value) || undefined,
    ratio: "16:9",
    creative: { roles: ["inside"], energy: ($("#gen-energy") && $("#gen-energy").value) || "quiet" }
  };
}

function fillModels(models) {
  const before = JSON.stringify(genBody());
  GEN_MODELS = models || [];
  const sel = $("#gen-model");
  if (!sel) return;
  const previous = sel.value;
  sel.replaceChildren();
  (models || []).forEach((m) => {
    const opt = makeEl("option", "", (m.id || "") + " · " + (m.provider || "") + " / " + (m.model || ""));
    opt.value = m.id;
    opt.disabled = !m.available;
    sel.appendChild(opt);
  });
  const chosen = GEN_MODELS.find((m) => m.id === previous && m.available)
    || GEN_MODELS.find((m) => m.id === GEN_DEFAULT_MODEL && m.available)
    || GEN_MODELS.find((m) => m.available);
  sel.value = chosen ? chosen.id : "";
  fillGenerationOptions();
  if (before !== JSON.stringify(genBody()) || (GEN_PREFLIGHT &&
      (!chosen || chosen.capabilities.hash !== GEN_PREFLIGHT.data.capability_hash))) invalidatePreflight();
}

function fillGenerationOptions() {
  const chosen = GEN_MODELS.find((m) => m.id === $("#gen-model").value);
  const caps = (chosen && chosen.capabilities) || {};
  [["#gen-resolution", caps.resolutions, "resolution"], ["#gen-duration", caps.durations, "duration"]].forEach(([id, values, key]) => {
    const sel = $(id);
    const old = sel.value;
    sel.replaceChildren();
    (values || []).forEach((name) => {
      const opt = makeEl("option", "", name);
      opt.value = String(name);
      sel.appendChild(opt);
    });
    const options = (values || []).map(String);
    sel.value = options.includes(String(old)) ? String(old)
      : String((chosen && chosen.defaults[key]) || options[0] || "");
  });
}

function invalidatePreflight() {
  GEN_PREFLIGHT = null;
  $("#gen-submit").disabled = true;
  $("#gen-estimate").textContent = "Run preflight before creating a paid job.";
}

function genMessage(message) { $("#gen-message").textContent = message; }

function genButton(parent, label, action) {
  const button = makeEl("button", "", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (e) { genMessage(e.message); }
    finally { button.disabled = false; }
  });
  parent.appendChild(button);
}

function renderGenerationStatus(data) {
  const banner = $("#gen-banner");
  const privacy = $("#gen-privacy");
  const status = $("#gen-status");
  if (banner) banner.textContent = data.enabled
    ? "Generation is enabled. This uses a paid external API on a trusted network only."
    : "Generation is off. GENERATION_ENABLED=1, a model alias, and a provider key are required. Keys never spend by themselves.";
  if (privacy) {
    const notes = (data.warnings || []).join(" ");
    privacy.textContent = notes;
  }
  if (status) {
    const b = data.budget || {};
    status.textContent = "jobs " + ((b.jobs && b.jobs.remaining) || 0)
      + " remaining · video-seconds " + ((b.video_seconds && b.video_seconds.remaining) || 0)
      + " remaining · USD remaining " + ((b.usd && b.usd.remaining_microusd) || 0) + " µ$";
  }
}

function renderJobs(jobs) {
  const box = $("#gen-jobs");
  if (!box) return;
  box.replaceChildren();
  (jobs || []).forEach((job) => {
    const el = makeEl("div", "gen-job");
    el.appendChild(makeEl("div", "", job.title || job.id));
    el.appendChild(makeEl("div", "", (job.provider || "") + " · " + (job.status || "") + " · " + (job.next_step || "")));
    el.appendChild(makeEl("div", "", job.error_message || ""));
    const url = "/api/generation/jobs/" + encodeURIComponent(job.id);
    if (job.status === "queued") genButton(el, "Cancel queued job", () => genAct("POST", url + "/cancel"));
    if (job.status === "submission_unknown") {
      genButton(el, "Attach provider job ID", async () => {
        const id = prompt("Provider job ID verified in the provider dashboard:");
        if (id && id.trim()) await genAct("POST", url + "/reconcile", { provider_job_id: id.trim() });
      });
      genButton(el, "Confirm not accepted", async () => {
        if (confirm("Have you verified in the provider dashboard that this request was NOT accepted? This releases its reservation."))
          await genAct("POST", url + "/reconcile", { not_accepted: true });
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
  (jobs || []).forEach((job) => {
    (job.outputs || []).forEach((out) => {
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
        genButton(card, "Reject", () => genAct("POST", url + "/reject", { reason: "rejected" }));
      }
      if (out.processing_status === "failed" && out.review_status !== "deleted")
        genButton(card, "Retry processing (no new charge)", () => genAct("POST", url + "/retry-processing"));
      if (out.review_status !== "deleted" && GEN_TERMINAL[job.status])
        genButton(card, "Delete output", async () => {
          if (confirm("Delete this output and its playable file? This cannot refund provider charges."))
            await genAct("DELETE", url);
        });
      box.appendChild(card);
    });
  });
}

function jobsNeedPoll(jobs) {
  return (jobs || []).some((job) => !GEN_TERMINAL[job.status]);
}

async function genAct(method, url, body) {
  const result = await genRequest(method, url, body);
  invalidatePreflight();
  genMessage("Action completed.");
  await loadGeneration();
  return result;
}

async function genRequest(method, url, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || (typeof data.detail === "string" && data.detail) || "Generation request failed (" + r.status + ")");
  return data;
}

async function loadGeneration() {
  const version = ++GEN_LOAD_VERSION;
  stopGenerationPoll();
  const reviewState = $("#gen-review-state").value || "pending";
  const [status, models, jobs, outputs] = await Promise.all([
    genRequest("GET", "/api/generation"), genRequest("GET", "/api/generation/models"),
    genRequest("GET", "/api/generation/jobs?limit=50&offset=" + GEN_JOBS_OFFSET),
    genRequest("GET", "/api/generation/outputs?limit=50&offset=" + GEN_REVIEW_OFFSET + "&review_status=" + reviewState)
  ]);
  if (version !== GEN_LOAD_VERSION) return;
  renderGenerationStatus(status);
  GEN_DEFAULT_MODEL = status.default_model || "";
  renderIfChanged("models", models.models || [], fillModels);
  renderIfChanged("jobs", jobs.jobs || [], renderJobs);
  const byId = new Map((jobs.jobs || []).map((job) => [job.id, job]));
  const ids = [...new Set((outputs.outputs || []).map((out) => out.job_id))];
  await Promise.all(ids.filter((id) => !byId.has(id)).map(async (id) => {
    byId.set(id, await genRequest("GET", "/api/generation/jobs/" + encodeURIComponent(id)));
  }));
  if (version !== GEN_LOAD_VERSION) return;
  renderIfChanged("review", ids.map((id) => ({ ...byId.get(id), outputs: outputs.outputs.filter((out) => out.job_id === id) })), renderReview);
  $("#gen-jobs-prev").disabled = GEN_JOBS_OFFSET === 0;
  $("#gen-jobs-next").disabled = (jobs.jobs || []).length < 50;
  $("#gen-review-prev").disabled = GEN_REVIEW_OFFSET === 0;
  $("#gen-review-next").disabled = (outputs.outputs || []).length < 50;
  stopGenerationPoll();
  if (currentView() === "generation") {
    GEN_TIMER = setTimeout(() => loadGeneration().catch((e) => genMessage(e.message)), 5000);
  }
}

function renderIfChanged(key, data, render) {
  const signature = JSON.stringify(data);
  if (GEN_RENDERED[key] === signature) return;
  GEN_RENDERED[key] = signature;
  render(data);
}

async function runPreflight() {
  invalidatePreflight();
  const body = genBody();
  const data = await genRequest("POST", "/api/generation/preflight", body);
  if (JSON.stringify(body) !== JSON.stringify(genBody())) return;
  GEN_PREFLIGHT = { body: JSON.stringify(body), data };
  $("#gen-submit").disabled = false;
  const prompt = $("#gen-prompt");
  const estimate = $("#gen-estimate");
  if (prompt) prompt.textContent = data.submitted_prompt || data.message || "";
  if (estimate) estimate.textContent = data.estimate
    ? ("estimate " + data.estimate.usd + " USD · " + data.estimate.video_seconds + "s · " + (data.privacy || ""))
    : (data.message || "preflight failed");
}

async function runCreate() {
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
      ...JSON.parse(prepared.body), preflight_token: prepared.data.preflight_token
    });
  } finally { GEN_CREATING = false; }
}

function paidConfirmation(data) {
  return "Create one paid job? " + data.provider_model + " · " + data.duration + "s · "
    + data.resolution + " · " + data.estimate.usd + " USD\nNo references.\n"
    + data.submitted_prompt + "\n" + data.privacy;
}

async function regenerateJob(job) {
  const body = { model: job.model_alias, prompt: job.operator_brief, title: job.title, kind: job.kind,
    mode: job.mode, output: "video", duration: job.request.duration, resolution: job.request.resolution,
    ratio: "16:9", creative: { roles: job.creative.roles, energy: job.creative.energy } };
  const pre = await genRequest("POST", "/api/generation/preflight", body);
  if (confirm(paidConfirmation(pre))) await genAct("POST", "/api/generation/jobs/" + encodeURIComponent(job.id)
    + "/regenerate", { preflight_token: pre.preflight_token });
}

function wireGeneration() {
  const pre = $("#gen-preflight");
  const sub = $("#gen-submit");
  if (pre) pre.addEventListener("click", () => runPreflight().catch((e) => genMessage(e.message)));
  if (sub) sub.addEventListener("click", () => runCreate().catch((e) => genMessage(e.message)));
  ["#gen-model", "#gen-brief", "#gen-duration", "#gen-resolution", "#gen-energy"].forEach((id) => {
    $(id).addEventListener("input", invalidatePreflight);
    $(id).addEventListener("change", () => { if (id === "#gen-model") fillGenerationOptions(); invalidatePreflight(); });
  });
  ["jobs", "review"].forEach((kind) => ["prev", "next"].forEach((direction) => {
    $("#gen-" + kind + "-" + direction).addEventListener("click", () => {
      const delta = direction === "next" ? 50 : -50;
      if (kind === "jobs") GEN_JOBS_OFFSET = Math.max(0, GEN_JOBS_OFFSET + delta);
      else GEN_REVIEW_OFFSET = Math.max(0, GEN_REVIEW_OFFSET + delta);
      loadGeneration().catch((e) => genMessage(e.message));
    });
  }));
  $("#gen-review-state").addEventListener("change", () => {
    GEN_REVIEW_OFFSET = 0;
    loadGeneration().catch((e) => genMessage(e.message));
  });
  window.addEventListener("hashchange", applyView);
}

function boot() {
  wireMaintenance();
  wireGeneration();
  applyView();
  $("#ask-go").addEventListener("click", submitAsk);
  $("#ask").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAsk(); });

  document.querySelectorAll("[data-gen]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/generate/" + b.dataset.gen + "?n=20", "generate " + b.dataset.gen)));
  document.querySelectorAll("[data-src]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/sources/" + b.dataset.src, b.dataset.src)));
  document.querySelectorAll("[data-station]").forEach((b) =>
    b.addEventListener("click", () => doAction("/api/station/conform", "conform")));
  $("#shuffle").addEventListener("click", shufflePreview);
  $("#more").addEventListener("click", () => loadGrid(false));
  $("#search").addEventListener("input", (e) => { STATE.search = e.target.value; loadGrid(true); });
  const previewOneBtn = $("#preview-one");
  if (previewOneBtn) previewOneBtn.addEventListener("click", previewOne);
  document.querySelectorAll("[data-pack]").forEach((b) =>
    b.addEventListener("click", () => previewPack(b.dataset.pack)));

  loadStatus();
  loadGrid(true);
  loadStation();
  setInterval(loadStatus, 20000);
  setInterval(loadStation, 20000);
}

const COMMONJS = typeof module !== "undefined" && module.exports;
if (typeof document !== "undefined" && !COMMONJS) boot();
if (COMMONJS) {
  module.exports = { makeEl, cardEl, stationEl, pollJob, enableBumper,
    previewPack, previewOne, packSummaryEl, renderPackPreview, freshnessLine,
    renderJobs, renderReview, jobsNeedPoll, fillModels, renderGenerationStatus,
    GEN_TERMINAL, runPreflight, runCreate, genRequest, regenerateJob, invalidatePreflight, renderIfChanged };
}
