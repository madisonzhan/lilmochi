"use strict";
/* Crunchling · a virtual pet that grows when you finish bCourses work.
   Everything (token, checkmarks, custom quests, pet name, cached assignments) lives in this browser only. */

const RELAY = "/api/canvas";
const BC = "https://bcourses.berkeley.edu";
const WINDOW_DAYS = 8;
const XP = { exam: 50, deadline: 30, task: 10 };
const STAGES = [["egg", 0], ["baby", .04], ["kid", .2], ["teen", .45], ["adult", .75], ["graduate", 1]];
const DAY_SYMS = ["☾", "☼", "☘︎", "✎", "❀", "⟡", "♡", "✧"];
const K = { token: "cr-token", cache: "cr-cache", checks: "cr-checks", custom: "cr-custom", name: "cr-name" };

/* ---------- storage (never throws) ---------- */
const LS = {
  get(k, s) { try { return (s || localStorage).getItem(k); } catch { return null; } },
  set(k, v, s) { try { (s || localStorage).setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
  json(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
};
let SS; try { SS = sessionStorage; } catch { SS = null; }
const getToken = () => LS.get(K.token) || (SS && LS.get(K.token, SS)) || "";

/* ---------- state ---------- */
let canvasItems = [];           // normalized from bCourses
let courses = {};               // id -> {code, idx}
let checks = LS.json(K.checks, {});   // id -> bool (manual override)
let custom = LS.json(K.custom, []);   // [{id, day, text, done}]
let lastSync = 0, syncing = false, syncErr = "";
let petName = LS.get(K.name) || "mochi";
let screenIdx = 0, eatingUntil = 0, lovedUntil = 0, lastStage = null;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- dates (viewer's own timezone) ---------- */
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
function days() {
  const out = [], base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    out.push({ d: ymd(d), dow: d.toLocaleDateString("en-US", { weekday: "short" }), md: `${d.getMonth() + 1}/${d.getDate()}`, sym: DAY_SYMS[i % DAY_SYMS.length] });
  }
  return out;
}
let DAYS = days();
let sel = DAYS[0].d;
const timeLabel = d => { let h = d.getHours(), m = d.getMinutes(); const ap = h >= 12 ? "p" : "a"; h = h % 12 || 12; return `${h}${m ? ":" + pad(m) : ""}${ap}`; };

/* ---------- bCourses sync ---------- */
async function relay(path, params, token) {
  const q = new URLSearchParams({ path });
  for (const [k, v] of params) q.append(k, v);
  const r = await fetch(`${RELAY}?${q}`, { headers: { "X-Canvas-Token": token }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (r.status === 401) throw new Error("token_rejected");
  if (!r.ok) throw new Error("http_" + r.status);
  return { data: await r.json(), next: r.headers.get("X-Next-Page") };
}
function kindOf(it) {
  const title = (it.plannable && it.plannable.title) || "";
  if (/\b(midterm|exam|final)\b/i.test(title) && !/practice|review|study guide|solution/i.test(title)) return "exam";
  const pts = it.plannable && it.plannable.points_possible;
  if (it.plannable_type === "calendar_event") return "task";
  return pts > 0 ? "deadline" : "task";
}
function normalize(it) {
  const at = new Date(it.plannable_date || (it.plannable && (it.plannable.due_at || it.plannable.todo_date)));
  if (isNaN(at)) return null;
  const sub = it.submissions || {};
  const c = courses[it.course_id];
  return {
    id: `${it.plannable_type}-${it.plannable_id}`,
    day: ymd(at), at: at.getTime(),
    time: (at.getHours() === 23 && at.getMinutes() === 59) ? "11:59p" : timeLabel(at),
    text: (it.plannable && it.plannable.title) || "Untitled",
    course: c ? c.code : (it.context_name || "other"), cidx: c ? c.idx : 5,
    kind: kindOf(it),
    auto: !!(sub.submitted || sub.graded || sub.excused || (it.planner_override && it.planner_override.marked_complete)),
    missing: !!sub.missing,
    url: it.html_url ? BC + it.html_url : "",
  };
}
async function sync(tokenOverride) {
  const token = tokenOverride || getToken();
  if (!token || syncing) return false;
  syncing = true; syncErr = ""; renderSync();
  try {
    const cr = await relay("/api/v1/courses", [["enrollment_state", "active"], ["per_page", "50"]], token);
    const list = Array.isArray(cr.data) ? cr.data : [];
    courses = {};
    list.forEach((c, i) => {
      const code = String(c.course_code || c.name || "course").replace(/\s*-\s*(LEC|DIS|SEM|LAB).*$/i, "").slice(0, 18);
      courses[c.id] = { code, idx: i % 6 };
    });
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(start.getDate() + WINDOW_DAYS);
    let items = [], page = null;
    for (let i = 0; i < 6; i++) {
      const params = [["start_date", start.toISOString()], ["end_date", end.toISOString()], ["per_page", "100"]];
      if (page) params.push(["page", page]);
      const r = await relay("/api/v1/planner/items", params, token);
      if (Array.isArray(r.data)) items = items.concat(r.data);
      if (!r.next) break; page = r.next;
    }
    canvasItems = items.filter(it => it.plannable_type !== "planner_note").map(normalize).filter(Boolean);
    lastSync = Date.now();
    LS.set(K.cache, JSON.stringify({ lastSync, courses, canvasItems }));
    return true;
  } catch (e) {
    syncErr = e.message === "token_rejected" ? "bCourses rejected that token. It may be expired or deleted." : "Couldn't reach bCourses. Try again in a minute.";
    return false;
  } finally { syncing = false; }
}

/* ---------- derived ---------- */
function allTasks() {
  const first = DAYS[0].d, last = DAYS[DAYS.length - 1].d;
  const t = canvasItems.filter(x => x.day >= first && x.day <= last).map(x => ({ ...x, done: x.auto || !!checks[x.id], locked: x.auto }));
  for (const c of custom) t.push({ id: c.id, day: c.day, at: 0, time: "", text: c.text, course: "mine", cidx: 4, kind: "task", done: !!c.done, custom: true });
  return t;
}
let TASKS = [];
const dayTasks = d => TASKS.filter(t => t.day === d).sort((a, b) => (a.kind === "exam" ? -1 : 0) - (b.kind === "exam" ? -1 : 0) || (a.at || 9e15) - (b.at || 9e15));
const xpOf = t => XP[t.kind] || 10;
const isLate = t => !t.done && (t.missing || (t.at && t.at < Date.now() && t.kind !== "task") || t.day < todayStr());
function left(ms) { const mins = Math.round(ms / 60000); if (mins < 60) return `${mins}m`; const h = Math.floor(mins / 60), m = mins % 60; if (h < 24) return `${h}h ${m}m`; return `${Math.floor(h / 24)}d ${h % 24}h`; }
function stats() {
  const total = TASKS.reduce((s, t) => s + xpOf(t), 0), xp = TASKS.filter(t => t.done).reduce((s, t) => s + xpOf(t), 0);
  const r = total ? xp / total : 0; let stage = "egg"; for (const [n, th] of STAGES) if (r >= th) stage = n;
  const lv = Math.floor(xp / 60) + 1, into = xp % 60;
  const today = dayTasks(todayStr()), tDone = today.filter(t => t.done).length;
  const late = TASKS.filter(isLate).length;
  let streak = 0; for (const day of DAYS) { const it = dayTasks(day.d); if (it.length && it.every(t => t.done)) streak++; else break; }
  const fullness = today.length ? Math.ceil(tDone / today.length * 4) : 4;
  return { total, xp, r, stage, lv, into, late, streak, fullness, happy: Math.max(0, 4 - late), tDone, tTotal: today.length };
}

/* ---------- pixel pet (original design) ---------- */
const SPR = {
  egg: ["................", "................", "......####......", ".....#....#.....", "....#......#....", "...#...##...#...", "...#...##...#...", "..#..........#..", "..#.##.......#..", "..#.##....##.#..", "..#.......##.#..", "..#..........#..", "...#........#...", "....##....##....", "......####......", "................"],
  baby: ["................", "................", "................", "................", "................", ".....######.....", "....#......#....", "...#........#...", "..#..........#..", "..#..........#..", "..#..........#..", "..#..........#..", "...#........#...", "....########....", "................", "................"],
  body: ["................", "................", "................", "................", "....########....", "...#........#...", "..#..........#..", "..#..........#..", "..#..........#..", "..#..........#..", "..#..........#..", "..#..........#..", "...#........#...", "....########....", ".....#....#.....", "................"],
  kid: ["................", ".....#.#........", "......#.........", ".......#........"],
  teen: [".....##.##......", "......#.#.......", ".......#........", ".......#........"],
  adult: ["......###.......", ".....#.#.#......", "......###.......", ".......#........"],
};
const FACE = { happy: ["#....#", "......", ".#..#.", "..##.."], neutral: ["#....#", "......", "......", "..##.."], sad: ["#....#", "......", "..##..", ".#..#."], eat: ["#....#", "......", ".####.", ".####."], eat2: ["#....#", "......", "......", ".####."], sleep: ["......", "##..##", "......", "..##.."], love: ["#....#", "......", ".#..#.", "..##.."] };
const POOP = ["..#..", ".###.", "#####"], HEART = [".#.#.", "#####", ".###.", "..#.."], APPLE = ["..#..", ".###.", "#####", ".###."], Z = ["###", ".#.", "###"];
const cv = document.createElement("canvas"); cv.id = "pet"; cv.width = 32; cv.height = 23;
const cx = cv.getContext("2d");
let px = 8, dir = 1, frame = 0;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function blit(rows, x, y, col) { cx.fillStyle = col; rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === "#") cx.fillRect(x + i, y + j, 1, 1); }); }
function mood(st) {
  const now = Date.now(), h = new Date().getHours();
  if (now < eatingUntil) return frame % 2 ? "eat" : "eat2";
  if (now < lovedUntil) return "love";
  if (h >= 1 && h < 7) return "sleep";
  if (st.late > 0) return "sad";
  if (st.tTotal && st.tDone / st.tTotal >= .5) return "happy";
  return "neutral";
}
function drawPet() {
  const st = stats(), ink = css("--lcd-ink"), dim = css("--lcd-dim");
  cx.clearRect(0, 0, 32, 23); cx.fillStyle = dim; cx.fillRect(0, 21, 32, 1);
  const m = mood(st), y = (m === "sleep" || reduce) ? 5 : (frame % 2 ? 5 : 4);
  if (st.stage === "egg") { blit(SPR.egg, 8 + (reduce ? 0 : (frame % 4 === 1 ? -1 : frame % 4 === 3 ? 1 : 0)), 5, ink); }
  else if (st.stage === "baby") { blit(SPR.baby, px, y, ink); blit(FACE[m], px + 5, y + 8, ink); }
  else {
    blit(SPR.body, px, y, ink);
    blit(st.stage === "kid" ? SPR.kid : st.stage === "teen" ? SPR.teen : SPR.adult, px, y, ink);
    blit(FACE[m], px + 5, y + 7, ink);
    if (st.stage === "graduate") { const sp = frame % 2 ? [[1, 2], [28, 4], [3, 15]] : [[2, 6], [27, 1], [29, 14]]; sp.forEach(([a, b]) => { cx.fillStyle = ink; cx.fillRect(a - 1, b, 3, 1); cx.fillRect(a, b - 1, 1, 3); }); }
  }
  if (m === "sleep") { blit(Z, px + 14, 2, ink); if (frame % 2) blit(Z, px + 17, 0, ink); }
  if (m.startsWith("eat")) blit(APPLE, px - 6 < 0 ? px + 16 : px - 6, 15, ink);
  if (m === "love") { blit(HEART, px + 15, frame % 2 ? 1 : 2, ink); blit(HEART, px - 5 < 0 ? px + 19 : px - 5, frame % 2 ? 4 : 3, ink); }
  for (let i = 0; i < Math.min(3, st.late); i++) blit(POOP, i % 2 ? 26 : 1, 18 - (i > 1 ? 4 : 0), ink);
}
function tick() {
  frame++;
  const st = stats();
  if (!reduce && st.stage !== "egg" && mood(st) !== "sleep" && Date.now() > eatingUntil && Math.random() < .5) {
    px += dir * 2; if (px < 4 || px > 12) { dir *= -1; px = Math.max(4, Math.min(12, px)); }
  }
  if (screenIdx === 0) drawPet();
}

/* ---------- rendering ---------- */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hearts = n => "♥".repeat(n) + "♡".repeat(4 - n);
const fmtWhen = at => new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).toLowerCase();
function nextDue() { const now = Date.now(); return TASKS.filter(t => !t.done && t.at > now && t.kind !== "task").sort((a, b) => a.at - b.at); }

function renderScreen() {
  const st = stats(), el = document.getElementById("screen");
  document.querySelectorAll(".icons span").forEach(s => s.classList.toggle("on", +s.dataset.s === screenIdx));
  if (screenIdx === 0) { if (!el.contains(cv)) { el.innerHTML = ""; el.appendChild(cv); } drawPet(); cv.setAttribute("aria-label", `${petName} the ${st.stage}`); return; }
  if (screenIdx === 1) {
    el.innerHTML = `<div class="stat"><div class="row"><span class="lbl">FULL</span><span class="hearts">${hearts(Math.min(4, st.fullness))}</span></div>
      <div class="row"><span class="lbl">HAPPY</span><span class="hearts">${hearts(Math.min(4, st.happy))}</span></div>
      <div class="row"><span class="lbl">MESS</span><span>${st.late ? "x" + st.late : "clean"}</span></div>
      <div class="small">${st.tDone}/${st.tTotal} fed today</div></div>`; return;
  }
  if (screenIdx === 2) {
    const nx = nextDue()[0];
    el.innerHTML = nx ? `<div class="stat"><span class="lbl">NEXT ${nx.kind === "exam" ? "BOSS" : "DUE"}</span><span class="small">${esc(nx.course + " " + nx.text)}</span><span class="big">${left(nx.at - Date.now())}</span></div>`
      : `<div class="stat"><span class="lbl">ALL CLEAR</span><span class="small">nothing due ✿</span></div>`; return;
  }
  el.innerHTML = `<div class="stat"><div class="row"><span class="lbl">LV</span><span class="big">${st.lv}</span></div>
    <div class="xpbar"><i style="width:${st.into / 60 * 100}%"></i></div><div class="small">${st.xp}/${st.total} xp</div>
    <div class="row"><span class="lbl">STAGE</span><span>${st.stage}</span></div></div>`;
}
function toast(text) { const t = document.createElement("div"); t.className = "toast"; t.textContent = text; document.getElementById("toasts").appendChild(t); setTimeout(() => t.remove(), 1700); }
function renderHUD(st) {
  document.getElementById("hud").innerHTML = `
   <div class="box"><div class="k">level</div><div class="v">${st.lv}</div><div class="mini"><i style="width:${st.into / 60 * 100}%"></i></div></div>
   <div class="box"><div class="k">xp</div><div class="v">${st.xp}<span style="font-size:18px;color:var(--faint)">/${st.total}</span></div><div class="mini"><i style="width:${st.r * 100}%"></i></div></div>
   <div class="box"><div class="k">streak</div><div class="v">${st.streak}<span style="font-size:18px;color:var(--faint)"> day${st.streak === 1 ? "" : "s"}</span></div></div>
   <div class="box"><div class="k">mess</div><div class="v">${st.late ? st.late + " 💩" : "✿ 0"}</div></div>`;
}
function renderSync() {
  const el = document.getElementById("syncbar"); if (!el) return;
  const ago = lastSync ? left(Math.max(60000, Date.now() - lastSync)) + " ago" : "never";
  el.innerHTML = `<span>${syncing ? "syncing with bCourses…" : `synced ${ago}`}</span>${syncErr ? `<span class="err">${esc(syncErr)}</span>` : ""}
    <button id="syncBtn" ${syncing ? "disabled" : ""}>↻ sync</button><button id="logoutBtn">disconnect</button>`;
}
function renderStrip() {
  document.getElementById("strip").innerHTML = DAYS.map((day, i) => {
    const items = dayTasks(day.d), n = items.length, k = items.filter(t => t.done).length, exam = items.some(t => t.kind === "exam");
    return `<button class="tab c${i % 4}" role="tab" aria-selected="${day.d === sel}" data-d="${day.d}">
      <span class="row"><span class="dn">${day.dow} ${day.md}</span><span class="g" aria-hidden="true">${day.sym}</span></span>
      <span class="mini"><i style="width:${n ? k / n * 100 : 0}%"></i></span>
      <span class="meta"><span>${n && k === n ? "✿ done" : `${k}/${n}`}</span>${i === 0 ? '<span class="now">today</span>' : exam ? '<span class="ex">✮ boss</span>' : ""}</span>
    </button>`;
  }).join("");
}
function taskLI(t) {
  const urgent = t.kind !== "task";
  const title = t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.text)}</a>` : esc(t.text);
  const note = t.locked ? "submitted on bCourses ✓" : t.missing ? "marked missing on bCourses" : t.custom ? "your quest" : "";
  return `<li class="${urgent ? "urgent" : ""}${t.done ? " is-done" : ""}${isLate(t) ? " late" : ""}">
    <input type="checkbox" id="cb-${esc(t.id)}" data-id="${esc(t.id)}" ${t.done ? "checked" : ""} ${t.locked ? "disabled" : ""} aria-label="${esc(t.text)}">
    <div class="body"><span class="tag ct c${t.cidx}">${esc(t.course)}</span><span class="text">${t.kind === "exam" ? '<span class="kk">✮</span>' : t.kind === "deadline" ? '<span class="kk">❥</span>' : ""}${title}${t.time ? ` · <span class="time">${esc(t.time)}</span>` : ""}</span>${note ? `<span class="detail">${note}</span>` : ""}</div>
    <span class="xp">+${xpOf(t)} xp</span>
  </li>`;
}
function renderDay() {
  const i = DAYS.findIndex(x => x.d === sel), day = DAYS[i], items = dayTasks(day.d), n = items.length, k = items.filter(t => t.done).length, full = n && k === n;
  const exam = items.some(t => t.kind === "exam");
  const theme = exam ? "boss day · you got this" : n ? `${n} quest${n === 1 ? "" : "s"}` : "free day ♡";
  const el = document.getElementById("day"); el.className = `c${i % 4}`;
  el.innerHTML = `<div class="dayhead"><span class="glyph" aria-hidden="true">${day.sym}</span><div class="head"><h2>${day.dow} ${day.md}</h2></div></div>
    <p class="theme"><span class="sym">${day.sym}</span>${theme}</p>
    <div class="prog${full ? " full" : ""}" role="progressbar" aria-label="Day progress" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${k}"><span class="track"><i style="width:${n ? k / n * 100 : 0}%"></i></span><span class="lbl">${full ? "✿ all done ✿" : `${k}/${n} ♡`}</span></div>
    <p class="sect">quests</p>${n ? `<ul class="tasks">${items.map(taskLI).join("")}</ul>` : `<p class="empty">nothing due on bCourses</p>`}
    <form class="add" data-d="${day.d}"><input id="add-${day.d}" placeholder="+ add your own quest" autocomplete="off" maxlength="120" aria-label="Add a quest for ${day.dow} ${day.md}"><button type="submit">add</button></form>`;
}
function renderBosses() {
  const up = nextDue().slice(0, 6), now = Date.now();
  document.getElementById("bosses").innerHTML = up.length ? up.map(t => `<div class="boss${t.kind === "exam" ? " exam" : ""}${t.at - now < 6 * 3600e3 ? " soon" : ""}"><span class="what">${t.kind === "exam" ? "✮" : "❥"} ${esc(t.course)} · ${esc(t.text)}</span><span class="left">${left(t.at - now)}</span><span class="when">${fmtWhen(t.at)}</span></div>`).join("")
    : `<p class="note">every boss defeated ꒰ა ✿ ໒꒱</p>`;
}
function render() {
  const connected = !!getToken() || canvasItems.length > 0;
  document.getElementById("onboard").hidden = !!getToken();
  document.getElementById("gameUI").hidden = !getToken();
  const newDays = days(); if (newDays[0].d !== DAYS[0].d) { DAYS = newDays; if (!DAYS.some(d => d.d === sel)) sel = DAYS[0].d; }
  TASKS = allTasks();
  const st = stats();
  if (getToken()) {
    const active = document.activeElement && document.activeElement.id;
    const drafts = {}; document.querySelectorAll(".add input").forEach(i => drafts[i.id] = i.value);
    renderHUD(st); renderSync(); renderStrip(); renderDay(); renderBosses();
    for (const id in drafts) { const el = document.getElementById(id); if (el) el.value = drafts[id]; }
    if (active && active !== "petName") { const el = document.getElementById(active); if (el) el.focus(); }
  }
  renderScreen();
  if (lastStage && connected && STAGES.findIndex(s => s[0] === st.stage) > STAGES.findIndex(s => s[0] === lastStage)) {
    const l = document.getElementById("lcd"); l.classList.remove("flash"); void l.offsetWidth; l.classList.add("flash");
    setTimeout(() => toast(`✧ evolved into ${st.stage}! ✧`), 300);
  }
  lastStage = st.stage;
}

/* ---------- events ---------- */
document.getElementById("bA").onclick = () => { screenIdx = (screenIdx + 3) % 4; renderScreen(); };
document.getElementById("bC").onclick = () => { screenIdx = (screenIdx + 1) % 4; renderScreen(); };
document.getElementById("bB").onclick = () => {
  if (screenIdx !== 0) { screenIdx = 0; renderScreen(); return; }
  lovedUntil = Date.now() + 2200; drawPet(); toast("♡ ♡ ♡");
  const d = document.getElementById("device"); d.classList.remove("wiggle"); void d.offsetWidth; d.classList.add("wiggle");
};
document.getElementById("strip").addEventListener("click", e => { const b = e.target.closest(".tab"); if (!b) return; sel = b.dataset.d; render(); });
document.getElementById("strip").addEventListener("keydown", e => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; const b = e.target.closest(".tab"); if (!b) return;
  const i = DAYS.findIndex(x => x.d === b.dataset.d) + (e.key === "ArrowRight" ? 1 : -1); if (i < 0 || i >= DAYS.length) return;
  e.preventDefault(); sel = DAYS[i].d; render(); document.querySelector(`.tab[data-d="${sel}"]`).focus();
});
const dayEl = document.getElementById("day");
dayEl.addEventListener("change", e => {
  const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
  const t = TASKS.find(x => x.id === cb.dataset.id); if (!t || t.locked) return;
  if (t.custom) { const c = custom.find(x => x.id === t.id); if (c) c.done = cb.checked; LS.set(K.custom, JSON.stringify(custom)); }
  else { if (cb.checked) checks[t.id] = true; else delete checks[t.id]; LS.set(K.checks, JSON.stringify(checks)); }
  if (cb.checked) { eatingUntil = Date.now() + 2000; toast(`+${xpOf(t)} xp ✧`); screenIdx = 0; }
  render();
});
dayEl.addEventListener("submit", e => {
  const f = e.target.closest("form.add"); if (!f) return; e.preventDefault();
  const input = f.querySelector("input"), text = input.value.trim(); if (!text) return;
  custom.push({ id: "mine-" + Date.now().toString(36), day: f.dataset.d, text: text.slice(0, 120), done: false });
  LS.set(K.custom, JSON.stringify(custom)); input.value = ""; render();
});
document.addEventListener("click", async e => {
  if (e.target.id === "syncBtn") { await sync(); render(); }
  if (e.target.id === "logoutBtn") {
    LS.del(K.token); LS.del(K.cache); canvasItems = []; courses = {}; lastSync = 0; syncErr = "";
    render(); document.getElementById("tokenInput").focus();
  }
});
document.getElementById("tokenForm").addEventListener("submit", async e => {
  e.preventDefault();
  const input = document.getElementById("tokenInput"), err = document.getElementById("formErr"), btn = document.getElementById("goBtn");
  const token = input.value.trim(); err.hidden = true;
  if (!/^[A-Za-z0-9~_\-.]{20,256}$/.test(token)) { err.textContent = "That doesn't look like a bCourses token. Copy the whole thing."; err.hidden = false; return; }
  btn.disabled = true; btn.textContent = "hatching…";
  const ok = await sync(token);
  btn.disabled = false; btn.textContent = "connect ♡";
  if (!ok) { err.textContent = syncErr; err.hidden = false; return; }
  if (document.getElementById("remember").checked) LS.set(K.token, token); else if (SS) LS.set(K.token, token, SS);
  input.value = ""; toast("✧ hatched! ✧"); render();
});
const nameEl = document.getElementById("petName"); nameEl.value = petName;
nameEl.addEventListener("blur", () => { const v = nameEl.value.trim().slice(0, 14) || "mochi"; nameEl.value = v; petName = v; LS.set(K.name, v); renderScreen(); });
nameEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); } });

/* keychain + device scaling */
(() => { const g = document.getElementById("beads"); let s = ""; const N = 30; for (let i = 0; i <= N; i++) { const a = Math.PI / 2 + i / N * Math.PI * 2; s += `<circle cx="${(60 + Math.cos(a) * 24 * (.75 - .25 * Math.sin(a))).toFixed(1)}" cy="${(38 + Math.sin(a) * 30).toFixed(1)}" r="2.2"/>`; } g.innerHTML = s; })();
(() => { const w = document.getElementById("deviceWrap"); const fit = () => w.style.setProperty("--s", Math.min(1, w.clientWidth / 300) || 1); fit(); if (window.ResizeObserver) new ResizeObserver(fit).observe(w); else addEventListener("resize", fit); })();

/* ---------- boot ---------- */
(() => { const c = LS.json(K.cache, null); if (c && getToken()) { canvasItems = c.canvasItems || []; courses = c.courses || {}; lastSync = c.lastSync || 0; } })();
render();
setInterval(tick, 600);
setInterval(() => { render(); }, 60000);
if (getToken()) sync().then(render);
setInterval(() => { if (getToken() && !document.hidden && Date.now() - lastSync > 15 * 60000) sync().then(render); }, 60000);
