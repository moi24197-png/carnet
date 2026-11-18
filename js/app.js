// Carnet : journal de santé personnel, chiffré sur l'appareil.
// Aucune donnée ne quitte le navigateur, sauf les fichiers de sauvegarde que tu télécharges toi-même.

import {
  cryptoAvailable, newDataKey, wrapKey, unwrapKey, importDataKey, encryptJSON, decryptJSON,
  newRecoveryCode, normalizeCode, formatCode, isValidBox, FORMAT_VERSION
} from "./crypto.js";
import { DEFAULT_SETTINGS, SLEEP_EXTRA } from "./defaults.js";

const APP_VERSION = "1.1.0";
const STORE_KEY = "carnet-coffre";
const MIN_PASS = 12;
const LOCK_AFTER_MS = 3 * 60 * 1000;
const BACKUP_REMINDER_DAYS = 30;

const WORDS = ["", "Aucun symptôme", "Presque rien", "Léger", "Gênant par moments", "Modéré",
               "Gênant", "Marqué", "Poussée", "Forte poussée", "Poussée sévère"];
const SLEEP = ["Bon", "Moyen", "Mauvais"];
const INJ_TYPES = ["Tendinite", "Entorse", "Fracture", "Lésion musculaire", "Autre"];
const PHASES = ["Aiguë", "Rééducation", "Reprise", "Guérie"];
const MISSES = ["Aucun oubli", "Quelques oublis", "Souvent oublié"];
const FREQS = ["Tous les jours", "Certains jours", "Toutes les 2 semaines", "À la demande"];
const FREQ_KEYS = ["daily", "days", "biweekly", "asneeded"];
const WEEKDAYS = [["Lun", 1], ["Mar", 2], ["Mer", 3], ["Jeu", 4], ["Ven", 5], ["Sam", 6], ["Dim", 0]];
/* ---------- Utilitaires ---------- */
const $ = (id) => document.getElementById(id);
const each = (list, fn) => Array.prototype.forEach.call(list, fn);
const sevClass = (v) => v <= 3 ? "sev-calm" : v <= 6 ? "sev-mid" : "sev-high";   // 10 = le pire
const sevGood = (v) => v >= 8 ? "sev-calm" : v >= 5 ? "sev-mid" : "sev-high";    // 10 = le mieux
const sevColor = (v) => v <= 3 ? "var(--c-calm)" : v <= 6 ? "var(--c-mid)" : "var(--c-high)";
const dayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const keyDate = (k) => new Date(k + "T12:00:00");
let now = new Date();
let TODAY = dayKey(now);
const addDays = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return dayKey(d); };
const daysBetween = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 86400000);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const lastOf = (arr) => arr.length ? arr[arr.length - 1] : null;
const clip = (str, n) => str.length > n ? str.slice(0, n - 1) + "…" : str;
const fr1 = (n) => n.toFixed(1).replace(".", ",");
const plural = (n, one, many) => n + " " + (n > 1 ? many : one);
const hhmm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (k) => keyDate(k).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtFull = (k) => keyDate(k).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
function fmtDate(k) {
  const d = keyDate(k), opt = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opt.year = "numeric";
  return d.toLocaleDateString("fr-FR", opt);
}
function span(a, b) { const n = daysBetween(a, b); return n === 0 ? "aujourd'hui" : plural(n, "jour", "jours"); }
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Création d'éléments sans innerHTML : tout texte saisi est inséré comme texte, jamais comme code.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c)); });
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}

/* ---------- Stockage local : uniquement le coffre chiffré ---------- */
let memStore = null, storeOk = true;
function readStore() { try { return localStorage.getItem(STORE_KEY); } catch (e) { storeOk = false; return memStore; } }
function writeStore(s) { memStore = s; try { localStorage.setItem(STORE_KEY, s); } catch (e) { storeOk = false; throw e; } }
function clearStore() { memStore = null; try { localStorage.removeItem(STORE_KEY); } catch (e) { storeOk = false; } }
try { localStorage.setItem(STORE_KEY + "-test", "1"); localStorage.removeItem(STORE_KEY + "-test"); } catch (e) { storeOk = false; }
function readBox() { try { const b = JSON.parse(readStore()); return isValidBox(b) ? b : null; } catch (e) { return null; } }
async function askPersistentStorage() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* facultatif */ }
}

/* ---------- Coffre ---------- */
let key = null, wraps = null, vault = null;   // en mémoire seulement, effacés au verrouillage
function normVault(v) {
  v = v || {};
  v.schema = 1;
  v.entries = v.entries || {};
  v.injuries = v.injuries || [];
  v.treatments = v.treatments || [];
  v.settings = Object.assign({}, DEFAULT_SETTINGS, v.settings || {});
  ["zones", "triggers", "checks"].forEach((k) => { v.settings[k] = (v.settings[k] || []).slice(); });
  v.lastBackup = v.lastBackup || null;
  v.treatments.forEach((t) => { t.freq = t.freq || "asneeded"; t.days = t.days || []; t.takes = t.takes || []; t.evals = t.evals || []; t.anchor = t.anchor || null; });
  v.injuries.forEach((j) => { j.points = j.points || []; });
  return v;
}
async function persist() {
  const box = await encryptJSON(key, vault);
  writeStore(JSON.stringify({ v: FORMAT_VERSION, pw: wraps.pw, rc: wraps.rc, iv: box.iv, ct: box.ct }));
}
async function save(rerender) {
  try { await persist(); }
  catch (e) { setStatus("L'enregistrement a échoué : l'espace de stockage est peut-être plein.", true); }
  if (rerender) rerender();
}

/* ---------- Composants de saisie ---------- */
function scaleInput(idPrefix, label, opts) {
  opts = opts || {};
  const min = opts.min === 0 ? 0 : 1, sev = opts.good ? sevGood : sevClass;
  let value = null;
  const box = h("div", { class: "scale compact" + (min === 0 ? " eleven" : ""), role: "group", "aria-label": label });
  const paint = () => each(box.children, (b) => b.setAttribute("aria-pressed", Number(b.textContent) === value ? "true" : "false"));
  for (let i = min; i <= 10; i++) {
    box.append(h("button", { type: "button", id: idPrefix + "-" + i, class: sev(i), text: i,
      onclick: () => { value = value === i ? null : i; paint(); } }));
  }
  paint();
  return { el: box, get: () => value };
}
function chipInput(idPrefix, items, opts) {
  opts = opts || {};
  let sel = (opts.initial || []).filter(Boolean);
  const box = h("div", { class: "chips" });
  const paint = () => each(box.children, (b) => b.setAttribute("aria-pressed", sel.indexOf(b.textContent) >= 0 ? "true" : "false"));
  items.forEach((label, i) => box.append(h("button", { type: "button", id: idPrefix + "-" + i, text: label, onclick: () => {
    const on = sel.indexOf(label) >= 0;
    sel = opts.multi ? (on ? sel.filter((x) => x !== label) : sel.concat(label)) : (on ? [] : [label]);
    paint();
    if (opts.onChange) opts.onChange(opts.multi ? sel : (sel[0] || null));
  } })));
  paint();
  return { el: box, get: () => opts.multi ? sel : (sel[0] || null) };
}
function field(label, hint, control) {
  return h("div", { class: "field" }, h("span", { class: "flabel" }, label, hint ? h("small", null, hint) : null), control);
}
function textInput(id, placeholder, value, max) {
  return h("input", { type: "text", id, maxlength: String(max || 80), placeholder: placeholder || null, value: value || null });
}
function passInput(id, autocomplete) {
  return h("input", { type: "password", id, autocomplete, autocapitalize: "off", spellcheck: "false" });
}
function dateInput(id, value) { return h("input", { type: "date", id, value: value || TODAY, max: TODAY }); }
function confirmButton(label, onConfirm, confirmLabel) {
  let armed = false, timer = null;
  const b = h("button", { type: "button", class: "link danger-link", text: label });
  b.addEventListener("click", () => {
    if (armed) { clearTimeout(timer); onConfirm(); return; }
    armed = true; b.textContent = confirmLabel || "Confirmer la suppression";
    timer = setTimeout(() => { armed = false; b.textContent = label; }, 4000);
  });
  return b;
}
function historyBlock(title, rows) {
  if (!rows.length) return null;
  return h("details", { class: "history" }, h("summary", { text: title + " (" + rows.length + ")" }),
    h("ul", null, rows.slice().reverse().map((r) => h("li", null, h("strong", { text: fmtDate(r.date) + " " }), r.text))));
}

/* ---------- Matin ---------- */
let score = null;
const ui = { view: "matin", injNew: false, pointFor: null, trtNew: false, evalFor: null, freqFor: null,
  period: 30, selDay: null, recap: { mode: "main", days: 90, since: null, to: "" } };

function setStatus(msg, err) { const s = $("status"); s.textContent = msg; s.className = "status" + (err ? " err" : ""); }
function setScore(v) {
  score = v;
  each($("scale").children, (el, idx) => el.setAttribute("aria-pressed", idx + 1 === v ? "true" : "false"));
  $("readout").className = "readout" + (v ? " " + sevClass(v) : "");
  $("score-num").textContent = v || "–";
  $("score-word").textContent = v ? WORDS[v] : "Touche une note de 1 à 10";
  $("score-word").className = v ? "word" : "word empty";
}
function addChip(id, label) {
  const box = $(id), multi = box.hasAttribute("data-multi");
  const b = h("button", { type: "button", id: id + "-" + box.children.length, text: label, "aria-pressed": "false" });
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") === "true";
    if (!multi) each(box.children, (c) => c.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", on ? "false" : "true");
  });
  box.append(b);
  return b;
}
const fillChips = (id, items) => { $(id).textContent = ""; items.forEach((l) => addChip(id, l)); };
const getGroup = (id) => Array.prototype.filter.call($(id).children, (c) => c.getAttribute("aria-pressed") === "true").map((c) => c.textContent);
const setGroup = (id, labels) => each($(id).children, (c) => c.setAttribute("aria-pressed", (labels || []).indexOf(c.textContent) >= 0 ? "true" : "false"));

// Contrôles rapides (oui / non), définis dans les réglages
let checkInputs = [];
function buildChecks(entryChecks) {
  const root = $("checks"); root.textContent = ""; checkInputs = [];
  (vault ? vault.settings.checks : []).forEach((c, i) => {
    const prev = (entryChecks || {})[c.id] || {};
    const follow = h("div", { class: "follow" });
    // Avec « Non », la question devient celle d'une prise préventive (traitement pris sans que le symptôme soit apparu).
    const ttt = c.askTreatment ? chipInput("check-" + i + "-ttt", ["Oui", "Pas encore"], { initial: [prev.ttt] }) : null;
    const question = h("span");
    const showFollow = (v) => {
      follow.hidden = !(v && ttt);
      question.textContent = v === "Non" ? "Traitement préventif pris ?" : "Traitement pris ?";
    };
    if (ttt) follow.append(question, ttt.el);
    const yn = chipInput("check-" + i, ["Non", "Oui"], { initial: [prev.on === true ? "Oui" : prev.on === false ? "Non" : null], onChange: showFollow });
    showFollow(prev.on === true ? "Oui" : prev.on === false ? "Non" : null);
    checkInputs.push({ id: c.id, yn, ttt });
    root.append(h("section", { "aria-label": c.label }, h("h2", { text: c.label }), yn.el, follow));
  });
}
function readChecks() {
  const out = {};
  checkInputs.forEach((c) => {
    const v = c.yn.get();
    if (v) out[c.id] = { on: v === "Oui", ttt: c.ttt ? c.ttt.get() : null };
  });
  return out;
}

function readForm() {
  return { score, zones: getGroup("zones"), sleep: getGroup("sleep")[0] || null, sleepExtra: getGroup("sleep-extra"),
    triggers: getGroup("triggers"), checks: readChecks(), note: $("note").value.trim(), savedAt: new Date().toISOString() };
}
function fillForm(e) {
  e = e || {};
  setScore(e.score || null);
  setGroup("zones", e.zones); setGroup("sleep", e.sleep ? [e.sleep] : []); setGroup("sleep-extra", e.sleepExtra);
  setGroup("triggers", e.triggers);
  buildChecks(e.checks);
  $("note").value = e.note || ""; $("trig-new").value = "";
}
function buildMorning() {
  const s = vault.settings;
  $("main-name").textContent = s.name;
  // les étiquettes cochées un jour puis retirées des réglages restent affichées pour ce jour-là
  const today = vault.entries[TODAY] || {};
  const extra = (list, chosen) => list.concat((chosen || []).filter((x) => list.indexOf(x) < 0));
  fillChips("zones", extra(s.zones, today.zones));
  fillChips("triggers", extra(s.triggers, today.triggers));
  fillForm(vault.entries[TODAY]);
  $("save").textContent = vault.entries[TODAY] ? "Mettre à jour la saisie" : "Enregistrer la journée";
  renderWeek();
  renderTodayTrt();
  renderBackupNudge();
}
function renderWeek() {
  const week = $("week"); week.textContent = "";
  for (let d = 7; d >= 0; d--) {
    const k = addDays(TODAY, -d), entry = vault && vault.entries[k], v = entry ? entry.score : null;
    const bar = h("div", { class: v ? "bar" : "bar todo" });
    if (v) bar.style.height = (v * 10) + "%";
    week.append(h("div", { class: "day" + (d === 0 ? " today" : "") + (v ? " " + sevClass(v) : "") },
      h("span", { class: "val", text: v || "·" }), h("div", { class: "track" }, bar),
      h("span", { class: "lbl", text: d === 0 ? "Auj." : keyDate(k).toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "") })));
  }
}
function renderBackupNudge() {
  const n = $("backup-nudge"), count = Object.keys(vault.entries).length;
  const age = vault.lastBackup ? daysBetween(vault.lastBackup, TODAY) : null;
  const show = count >= 7 && (age === null || age >= BACKUP_REMINDER_DAYS);
  n.hidden = !show;
  n.textContent = "";
  if (show) n.append(age === null ? "Aucune sauvegarde pour l'instant. " : "Dernière sauvegarde il y a " + age + " jours. ",
    h("button", { type: "button", class: "link inline", text: "Sauvegarder maintenant", onclick: () => switchView("reglages") }));
}

/* ---------- Blessures ---------- */
const injPhase = (inj) => inj.end ? "Guérie" : ((lastOf(inj.points) || {}).phase || "Aiguë");
function pointText(p) {
  const bits = [p.phase];
  if (p.pain != null) bits.push("douleur " + p.pain);
  if (p.gene != null) bits.push("gêne " + p.gene);
  if (p.kine) bits.push("kiné");
  return bits.join(" · ") + (p.note ? ". " + p.note : "");
}
function renderInjNew() {
  const root = $("inj-new"); root.textContent = "";
  $("inj-new-open").hidden = ui.injNew;
  if (!ui.injNew) return;
  const name = textInput("inj-name", "Ex. : tendinite épaule droite");
  const type = chipInput("inj-type", INJ_TYPES);
  const start = dateInput("inj-start");
  const note = textInput("inj-note", "Circonstances, côté, diagnostic posé", null, 200);
  const msg = h("p", { class: "status err" });
  root.append(h("form", { class: "card form", onsubmit: (e) => {
    e.preventDefault();
    if (!name.value.trim()) { msg.textContent = "Donne un nom à cette blessure."; return; }
    vault.injuries.push({ id: newId(), name: name.value.trim(), type: type.get(), start: start.value || TODAY, end: null, note: note.value.trim(), points: [] });
    ui.injNew = false; save(renderInjuries);
  } },
    h("h3", { text: "Nouvelle blessure" }),
    field("Nom", null, name), field("Type", null, type.el), field("Date de la blessure", null, start), field("Note", "optionnel", note), msg,
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Ouvrir l'épisode" }),
      h("button", { type: "button", class: "ghost", text: "Annuler", onclick: () => { ui.injNew = false; renderInjuries(); } }))));
}
function pointForm(inj) {
  const phase = chipInput("pt-phase", PHASES, { initial: [injPhase(inj)] });
  const pain = scaleInput("pt-pain", "Douleur de 0 à 10", { min: 0 });
  const gene = scaleInput("pt-gene", "Gêne de 0 à 10", { min: 0 });
  const kine = chipInput("pt-kine", ["Séance de kiné aujourd'hui"], { multi: true });
  const note = textInput("pt-note", "Exercices, gêne particulière, avis du kiné", null, 200);
  return h("form", { class: "form inner", onsubmit: (e) => {
    e.preventDefault();
    const p = { date: TODAY, phase: phase.get() || injPhase(inj), pain: pain.get(), gene: gene.get(), kine: kine.get().length > 0, note: note.value.trim() };
    inj.points.push(p);
    if (p.phase === "Guérie") inj.end = TODAY;
    ui.pointFor = null; save(renderInjuries);
  } },
    field("Phase", "« Guérie » clôture l'épisode", phase.el),
    field("Douleur", "0 = aucune, 10 = maximale", pain.el),
    field("Gêne fonctionnelle", "0 = aucune, 10 = usage impossible", gene.el),
    kine.el, field("Note", "optionnel", note),
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Enregistrer le point" }),
      h("button", { type: "button", class: "ghost", text: "Annuler", onclick: () => { ui.pointFor = null; renderInjuries(); } })));
}
function injuryCard(inj) {
  const last = lastOf(inj.points), phase = injPhase(inj);
  const when = inj.end
    ? "Du " + fmtDate(inj.start) + " au " + fmtDate(inj.end) + " (" + span(inj.start, inj.end) + ")"
    : "Depuis le " + fmtDate(inj.start) + " (" + span(inj.start, TODAY) + ")";
  const actions = inj.end
    ? [h("button", { type: "button", class: "ghost", text: "Rouvrir (rechute)", onclick: () => { inj.end = null; save(renderInjuries); } })]
    : (ui.pointFor === inj.id ? [] : [h("button", { type: "button", class: "ghost", text: "Ajouter un point", onclick: () => { ui.pointFor = inj.id; renderInjuries(); } })]);
  return h("article", { class: "card" + (inj.end ? " closed" : "") },
    h("div", { class: "card-head" }, h("h3", { text: inj.name }), h("span", { class: "pill phase-" + PHASES.indexOf(phase), text: phase })),
    h("p", { class: "meta", text: (inj.type ? inj.type + " · " : "") + when }),
    inj.note ? h("p", { class: "meta", text: inj.note }) : null,
    last ? h("p", { class: "last", text: "Dernier point le " + fmtDate(last.date) + " : " + pointText(last) }) : h("p", { class: "meta", text: "Aucun point de suivi pour l'instant." }),
    ui.pointFor === inj.id && !inj.end ? pointForm(inj) : null,
    historyBlock("Historique", inj.points.map((p) => ({ date: p.date, text: pointText(p) }))),
    h("div", { class: "row" }, actions, confirmButton("Supprimer", () => { vault.injuries = vault.injuries.filter((x) => x !== inj); save(renderInjuries); })));
}
function renderInjuries() {
  renderInjNew();
  const root = $("injuries-list"); root.textContent = "";
  if (!vault) return;
  const open = vault.injuries.filter((x) => !x.end), closed = vault.injuries.filter((x) => x.end);
  if (!vault.injuries.length && !ui.injNew) root.append(h("p", { class: "empty", text: "Aucune blessure suivie. Ouvre un épisode quand une blessure survient : tu le suivras de la phase aiguë à la guérison." }));
  open.forEach((x) => root.append(injuryCard(x)));
  if (closed.length) { root.append(h("h2", { text: "Épisodes terminés" })); closed.forEach((x) => root.append(injuryCard(x))); }
}

/* ---------- Traitements ---------- */
function freqInput(prefix, t) {
  t = t || { freq: "asneeded", days: [] };
  const daysBox = chipInput(prefix + "-day", WEEKDAYS.map((d) => d[0]), { multi: true, initial: WEEKDAYS.filter((d) => t.days.indexOf(d[1]) >= 0).map((d) => d[0]) });
  const daysField = field("Jours de prise", null, daysBox.el);
  daysField.hidden = t.freq !== "days";
  const anchor = h("input", { type: "date", id: prefix + "-anchor", value: t.anchor || TODAY });
  const anchorField = field("Première ou prochaine prise", "ensuite 14 jours après chaque prise notée", anchor);
  anchorField.hidden = t.freq !== "biweekly";
  const freq = chipInput(prefix + "-freq", FREQS, { initial: [FREQS[FREQ_KEYS.indexOf(t.freq)]],
    onChange: (v) => { daysField.hidden = v !== FREQS[1]; anchorField.hidden = v !== FREQS[2]; } });
  return { el: h("div", { class: "field-group" }, field("Rythme", "sert au rappel du matin", freq.el), daysField, anchorField),
    get: () => {
      const f = FREQ_KEYS[FREQS.indexOf(freq.get())] || "asneeded";
      return { freq: f, days: f === "days" ? WEEKDAYS.filter((d) => daysBox.get().indexOf(d[0]) >= 0).map((d) => d[1]) : [],
        anchor: f === "biweekly" ? (anchor.value || TODAY) : null };
    } };
}
// Toutes les 2 semaines : la prochaine prise tombe 14 jours après la dernière prise notée, sinon à la date de départ.
const nextDue = (t) => t.takes.length ? addDays(lastOf(t.takes), 14) : (t.anchor || t.start);
const freqText = (t) => t.freq === "biweekly" ? "Toutes les 2 semaines" : t.freq === "daily" ? "Tous les jours"
  : t.freq === "days" ? (WEEKDAYS.filter((d) => t.days.indexOf(d[1]) >= 0).map((d) => d[0]).join(", ") || "Jours à préciser") : "À la demande";
const isDue = (t, k) => t.freq === "biweekly" ? (k >= nextDue(t) && k <= TODAY)
  : k >= t.start && (t.freq === "daily" || (t.freq === "days" && t.days.indexOf(keyDate(k).getDay()) >= 0));
function setTake(t, k, on) {
  t.takes = t.takes.filter((x) => x !== k);
  if (on) { t.takes.push(k); t.takes.sort(); }
}
function takesBlock(t) {
  const cells = [], date = dateInput("take-date-" + t.id);
  let count = 0;
  for (let d = 13; d >= 0; d--) {
    const k = addDays(TODAY, -d), taken = t.takes.indexOf(k) >= 0;
    if (taken) count++;
    cells.push(h("span", { class: taken ? "on" : (isDue(t, k) && (!t.end || k <= t.end) ? "due" : "off"), title: fmtDay(k) }));
  }
  const last = lastOf(t.takes);
  return h("div", { class: "takes-block" },
    h("div", { class: "strip", role: "img", "aria-label": count + " prises sur les 14 derniers jours" }, cells),
    h("p", { class: "meta", text: plural(count, "prise", "prises") + " sur les 14 derniers jours" + (last ? " · dernière le " + fmtDay(last) : "") + ". Case pleine : pris. Case cerclée : prévu, non noté." }),
    h("details", { class: "history" }, h("summary", { text: "Prises (" + t.takes.length + ")" }),
      h("ul", null, t.takes.slice().reverse().map((k) => h("li", null, fmtDay(k) + " ",
        h("button", { type: "button", class: "link inline", text: "retirer", onclick: () => { setTake(t, k, false); save(renderTreatments); } })))),
      h("div", { class: "add-row" }, date, h("button", { type: "button", text: "Ajouter cette date", onclick: () => { if (date.value) { setTake(t, date.value, true); save(renderTreatments); } } }))));
}
function freqForm(t) {
  const f = freqInput("fq", t);
  return h("form", { class: "form inner", onsubmit: (e) => { e.preventDefault(); Object.assign(t, f.get()); ui.freqFor = null; save(renderTreatments); } },
    f.el,
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Enregistrer le rythme" }),
      h("button", { type: "button", class: "ghost", text: "Annuler", onclick: () => { ui.freqFor = null; renderTreatments(); } })));
}
function renderTodayTrt() {
  const root = $("today-trt"); root.textContent = "";
  const list = vault ? vault.treatments.filter((t) => !t.end) : [];
  $("today-trt-section").hidden = !list.length;
  list.slice().sort((a, b) => isDue(b, TODAY) - isDue(a, TODAY)).forEach((t, i) => {
    const taken = t.takes.indexOf(TODAY) >= 0, due = isDue(t, TODAY);
    const when = due ? (t.freq === "biweekly" && nextDue(t) < TODAY ? "Prévu depuis le " + fmtDay(nextDue(t)) : "Prévu aujourd'hui")
      : t.freq === "asneeded" ? "À la demande" : t.freq === "biweekly" ? "Prochaine prise le " + fmtDay(nextDue(t)) : "Pas prévu aujourd'hui";
    root.append(h("div", { class: "take-row" + (due && !taken ? " due" : "") },
      h("div", { class: "take-text" }, h("strong", { text: t.name }), h("span", { class: "meta", text: when + (t.dose ? " · " + t.dose : "") })),
      h("div", { class: "chips" }, h("button", { type: "button", id: "take-today-" + i, "aria-pressed": taken ? "true" : "false", text: taken ? "Pris" : "Marquer pris",
        onclick: () => { setTake(t, TODAY, !taken); save(renderTodayTrt); } }))));
  });
}
function treatmentTargets() {
  return [vault.settings.name].concat(vault.settings.checks.map((c) => c.label), vault.injuries.filter((x) => !x.end).map((x) => x.name), ["Autre"]);
}
function renderTrtNew() {
  const root = $("trt-new"); root.textContent = "";
  $("trt-new-open").hidden = ui.trtNew;
  if (!ui.trtNew) return;
  const name = textInput("trt-name", "Nom du médicament ou du soin");
  const target = chipInput("trt-target", treatmentTargets());
  const dose = textInput("trt-dose", "Ex. : 1 application le soir");
  const freq = freqInput("trt", null);
  const start = dateInput("trt-start");
  const note = textInput("trt-note", "Prescripteur, durée prévue", null, 200);
  const msg = h("p", { class: "status err" });
  root.append(h("form", { class: "card form", onsubmit: (e) => {
    e.preventDefault();
    if (!name.value.trim()) { msg.textContent = "Indique le nom du traitement."; return; }
    vault.treatments.push(Object.assign({ id: newId(), name: name.value.trim(), target: target.get(), dose: dose.value.trim(),
      start: start.value || TODAY, end: null, note: note.value.trim(), evals: [], takes: [] }, freq.get()));
    ui.trtNew = false; save(renderTreatments);
  } },
    h("h3", { text: "Nouveau traitement" }),
    field("Nom", null, name), field("Pour", null, target.el), field("Posologie", "optionnel", dose), freq.el,
    field("Date de début", null, start), field("Note", "optionnel", note), msg,
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Ajouter le traitement" }),
      h("button", { type: "button", class: "ghost", text: "Annuler", onclick: () => { ui.trtNew = false; renderTreatments(); } }))));
}
function evalText(ev) {
  const bits = [];
  if (ev.efficacy) bits.push("efficacité " + ev.efficacy);
  if (ev.misses) bits.push(ev.misses.toLowerCase());
  if (ev.sideEffects) bits.push("effets : " + ev.sideEffects);
  return (bits.join(" · ") || "sans note") + (ev.note ? ". " + ev.note : "");
}
function evalForm(t) {
  const efficacy = scaleInput("ev-eff", "Efficacité de 1 à 10", { good: true });
  const misses = chipInput("ev-miss", MISSES);
  const side = textInput("ev-side", "Ex. : somnolence, maux de tête", null, 200);
  const note = textInput("ev-note", "", null, 200);
  return h("form", { class: "form inner", onsubmit: (e) => {
    e.preventDefault();
    t.evals.push({ date: TODAY, efficacy: efficacy.get(), misses: misses.get(), sideEffects: side.value.trim(), note: note.value.trim() });
    ui.evalFor = null; save(renderTreatments);
  } },
    field("Efficacité", "10 = très efficace", efficacy.el), field("Régularité", null, misses.el),
    field("Effets indésirables", "optionnel", side), field("Note", "optionnel", note),
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Enregistrer l'évaluation" }),
      h("button", { type: "button", class: "ghost", text: "Annuler", onclick: () => { ui.evalFor = null; renderTreatments(); } })));
}
function treatmentCard(t) {
  const last = lastOf(t.evals);
  const when = t.end
    ? "Du " + fmtDate(t.start) + " au " + fmtDate(t.end) + " (" + span(t.start, t.end) + ")"
    : "Depuis le " + fmtDate(t.start) + " (" + span(t.start, TODAY) + ")";
  const actions = [];
  if (!t.end && ui.evalFor !== t.id) actions.push(h("button", { type: "button", class: "ghost", text: "Évaluer", onclick: () => { ui.evalFor = t.id; ui.freqFor = null; renderTreatments(); } }));
  if (!t.end && ui.freqFor !== t.id) actions.push(h("button", { type: "button", class: "ghost", text: "Rythme", onclick: () => { ui.freqFor = t.id; ui.evalFor = null; renderTreatments(); } }));
  actions.push(t.end
    ? h("button", { type: "button", class: "ghost", text: "Reprendre", onclick: () => { t.end = null; save(renderTreatments); } })
    : h("button", { type: "button", class: "ghost", text: "Arrêter", onclick: () => { t.end = TODAY; ui.evalFor = null; save(renderTreatments); } }));
  return h("article", { class: "card" + (t.end ? " closed" : "") },
    h("div", { class: "card-head" }, h("h3", { text: t.name }), h("span", { class: "pill " + (t.end ? "phase-3" : "phase-1"), text: t.end ? "Arrêté" : "En cours" })),
    h("p", { class: "meta", text: [t.target ? "Pour : " + t.target : null, t.dose || null, freqText(t), when].filter(Boolean).join(" · ") }),
    t.note ? h("p", { class: "meta", text: t.note }) : null,
    last ? h("p", { class: "last", text: "Dernière évaluation le " + fmtDate(last.date) + " : " + evalText(last) }) : h("p", { class: "meta", text: "Pas encore évalué." }),
    ui.evalFor === t.id && !t.end ? evalForm(t) : null,
    ui.freqFor === t.id && !t.end ? freqForm(t) : null,
    takesBlock(t),
    historyBlock("Évaluations", t.evals.map((ev) => ({ date: ev.date, text: evalText(ev) }))),
    h("div", { class: "row" }, actions, confirmButton("Supprimer", () => { vault.treatments = vault.treatments.filter((x) => x !== t); save(renderTreatments); })));
}
function renderTreatments() {
  renderTrtNew();
  const root = $("treatments-list"); root.textContent = "";
  if (!vault) return;
  const active = vault.treatments.filter((x) => !x.end), stopped = vault.treatments.filter((x) => x.end);
  if (!vault.treatments.length && !ui.trtNew) root.append(h("p", { class: "empty", text: "Aucun traitement suivi. Ajoute-en un pour noter son efficacité et ses effets au fil du temps." }));
  active.forEach((x) => root.append(treatmentCard(x)));
  if (stopped.length) { root.append(h("h2", { text: "Traitements arrêtés" })); stopped.forEach((x) => root.append(treatmentCard(x))); }
}

/* ---------- Suivi : courbe, traitements et blessures sur le même axe de temps ---------- */
const PERIODS = [["30 jours", 30], ["90 jours", 90], ["1 an", 365]];
const checkLabel = (id) => (vault.settings.checks.find((c) => c.id === id) || {}).label;
const isPreventive = (c) => Boolean(c && !c.on && c.ttt === "Oui");
function checksText(e) {
  const out = [];
  Object.keys(e.checks || {}).filter((id) => checkLabel(id)).forEach((id) => {
    const c = e.checks[id];
    if (c.on) out.push(checkLabel(id) + (c.ttt ? " (traitement : " + c.ttt.toLowerCase() + ")" : ""));
    else if (isPreventive(c)) out.push(checkLabel(id) + " : non, traitement préventif pris");
  });
  return out;
}
function dayDetail(k) {
  const e = vault.entries[k], rows = [h("p", { class: "big", text: keyDate(k).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) })];
  if (e && e.score) {
    rows.push(h("p", { text: vault.settings.name + " : " + e.score + " sur 10, " + WORDS[e.score].toLowerCase() }));
    if (e.zones && e.zones.length) rows.push(h("p", { class: "meta", text: "Zones : " + e.zones.join(", ") }));
    const sleep = [e.sleep ? e.sleep.toLowerCase() : null].concat((e.sleepExtra || []).map((x) => x.toLowerCase())).filter(Boolean);
    if (sleep.length) rows.push(h("p", { class: "meta", text: "Sommeil : " + sleep.join(", ") }));
    if (e.triggers && e.triggers.length) rows.push(h("p", { class: "meta", text: "Déclencheurs : " + e.triggers.join(", ") }));
    checksText(e).forEach((t) => rows.push(h("p", { class: "meta", text: t })));
    if (e.note) rows.push(h("p", { class: "meta", text: "Note : " + e.note }));
  } else rows.push(h("p", { class: "meta", text: "Pas de saisie ce jour-là." }));
  const taken = vault.treatments.filter((t) => t.takes.indexOf(k) >= 0).map((t) => t.name);
  if (taken.length) rows.push(h("p", { class: "meta", text: "Pris : " + taken.join(", ") }));
  vault.injuries.forEach((inj) => inj.points.filter((p) => p.date === k).forEach((p) => rows.push(h("p", { class: "meta", text: inj.name + " : " + pointText(p) }))));
  return rows;
}
function axisTicks(N) { return [[0, "start"], [Math.round((N - 1) / 3), "middle"], [Math.round(2 * (N - 1) / 3), "middle"], [N - 1, "end"]]; }
function severityKeys() {
  const key = (c, label) => h("span", { class: "key" }, h("i", { style: "background:" + c }), label);
  return h("div", { class: "keys" }, key("var(--c-calm)", "1 à 3 calme"), key("var(--c-mid)", "4 à 6 modéré"), key("var(--c-high)", "7 à 10 poussée"));
}
function curvePath(pts, x, y) {
  // la courbe s'interrompt quand plus de 2 jours manquent, pour ne pas inventer de valeurs
  let d = "", prev = null;
  pts.forEach((p) => { d += (prev && p.i - prev.i <= 3 ? "L" : "M") + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1); prev = p; });
  return d;
}
function renderSuivi() {
  const root = $("suivi"); root.textContent = "";
  if (!vault) return;
  const N = ui.period, start = addDays(TODAY, -(N - 1)), days = [];
  for (let i = 0; i < N; i++) days.push(addDays(start, i));
  const idx = (k) => Math.max(0, Math.min(N - 1, daysBetween(start, k)));
  const pts = days.map((k, i) => ({ k, i, v: (vault.entries[k] || {}).score || null })).filter((p) => p.v);
  if (!ui.selDay || ui.selDay < start) ui.selDay = pts.length ? lastOf(pts).k : TODAY;

  root.append(h("button", { type: "button", class: "ghost wide", id: "recap-open", text: "Préparer un récap de consultation", onclick: () => switchView("recap") }));
  root.append(h("div", { class: "chips" }, PERIODS.map((per, i) => h("button", { type: "button", id: "per-" + i, text: per[0],
    "aria-pressed": per[1] === N ? "true" : "false", onclick: () => { ui.period = per[1]; ui.selDay = null; renderSuivi(); } }))));

  let summary = "Aucune saisie sur cette période.";
  if (pts.length) {
    const avg = pts.reduce((a, p) => a + p.v, 0) / pts.length, worst = pts.reduce((a, p) => p.v > a.v ? p : a);
    summary = "Moyenne " + fr1(avg) + " · " + plural(pts.length, "jour noté", "jours notés") + " sur " + N + " · pire jour : " + worst.v + " le " + fmtDate(worst.k);
  }

  const W = Math.max(260, ($("view-suivi").clientWidth || 356) - 26);
  const L = 24, R = 12, T = 10, PH = 150, PW = W - L - R;
  const x = (i) => L + (N === 1 ? 0 : i * PW / (N - 1)), y = (v) => T + (10 - v) * PH / 9;
  const lanes = [];
  vault.settings.checks.forEach((c) => {
    const state = (k) => ((vault.entries[k] || {}).checks || {})[c.id];
    const on = days.filter((k) => state(k) && state(k).on), prev = days.filter((k) => isPreventive(state(k)));
    if (on.length || prev.length) lanes.push({ label: clip(c.label, 40), kind: "marks", days: on, prev });
  });
  vault.treatments.filter((t) => t.start <= TODAY && (!t.end || t.end >= start)).forEach((t) => lanes.push({ label: "Traitement · " + clip(t.name, 34), kind: "trt",
    a: t.start < start ? start : t.start, b: t.end || TODAY, dots: t.takes.filter((k) => k >= start && k <= TODAY) }));
  vault.injuries.filter((j) => j.start <= TODAY && (!j.end || j.end >= start)).forEach((j) => lanes.push({ label: "Blessure · " + clip(j.name, 36), kind: "inj",
    a: j.start < start ? start : j.start, b: j.end || TODAY, dots: j.points.map((p) => p.date).filter((k) => k >= start && k <= TODAY) }));
  const LY = T + PH + 34, LH = 30, H = lanes.length ? LY + lanes.length * LH : T + PH + 26;

  const svg = sv("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": vault.settings.name + " sur " + N + " jours. " + summary });
  [1, 4, 7, 10].forEach((v) => {
    svg.append(sv("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--line)", "stroke-width": 1 }));
    svg.append(sv("text", { x: L - 7, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, v));
  });
  axisTicks(N).forEach((tk) => {
    svg.append(sv("line", { x1: x(tk[0]), x2: x(tk[0]), y1: T + PH, y2: T + PH + 4, stroke: "var(--line)", "stroke-width": 1 }));
    svg.append(sv("text", { x: x(tk[0]), y: T + PH + 17, "text-anchor": tk[1], "font-size": 11, fill: "var(--muted)" }, fmtDate(days[tk[0]])));
  });
  const cross = sv("line", { y1: T, y2: H - 6, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3 3" });
  svg.append(cross);
  const d = curvePath(pts, x, y);
  if (d) svg.append(sv("path", { d, fill: "none", stroke: "var(--muted)", "stroke-opacity": 0.55, "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const r = N <= 30 ? 4 : N <= 90 ? 3 : 2;
  pts.forEach((p) => svg.append(sv("circle", { cx: x(p.i), cy: y(p.v), r, fill: sevColor(p.v), stroke: "var(--surface)", "stroke-width": N <= 30 ? 2 : 0 })));
  const ring = sv("circle", { r: 6.5, fill: "none", stroke: "var(--ink)", "stroke-width": 2 });
  svg.append(ring);
  lanes.forEach((ln, n) => {
    const ty = LY + n * LH, by = ty + 6;
    svg.append(sv("text", { x: L, y: ty, "font-size": 11, fill: "var(--muted)" }, ln.label));
    if (ln.kind === "marks") {
      const w = Math.max(3, PW / N - 1);
      ln.days.forEach((k) => svg.append(sv("rect", { x: x(idx(k)) - w / 2, y: by, width: w, height: 8, rx: 2, fill: "var(--c-high)" })));
      ln.prev.forEach((k) => svg.append(sv("circle", { cx: x(idx(k)), cy: by + 4, r: 3.5, fill: "var(--surface)", stroke: "var(--accent)", "stroke-width": 2 })));
    } else {
      const x1 = x(idx(ln.a)), x2 = x(idx(ln.b > TODAY ? TODAY : ln.b)), color = ln.kind === "trt" ? "var(--accent)" : "var(--c-inj)";
      svg.append(sv("rect", { x: x1 - 4, y: by, width: Math.max(8, x2 - x1 + 8), height: 8, rx: 4, fill: color, "fill-opacity": 0.3 }));
      ln.dots.forEach((k) => svg.append(sv("circle", { cx: x(idx(k)), cy: by + 4, r: 3, fill: color })));
    }
  });

  const detail = h("div", { class: "detail", id: "day-detail", "aria-live": "polite" });
  function select(k) {
    ui.selDay = k;
    const i = idx(k), e = vault.entries[k];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    if (e && e.score) { ring.setAttribute("cx", x(i)); ring.setAttribute("cy", y(e.score)); ring.removeAttribute("visibility"); }
    else ring.setAttribute("visibility", "hidden");
    detail.textContent = ""; detail.append(...dayDetail(k));
  }
  function pick(ev) {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(N - 1, Math.round((ev.clientX - box.left - L) / PW * (N - 1))));
    if (days[i] !== ui.selDay) select(days[i]);
  }
  svg.addEventListener("pointerdown", pick);
  svg.addEventListener("pointermove", (ev) => { if (ev.pointerType === "mouse" || ev.buttons) pick(ev); });
  select(ui.selDay);

  const hasPrev = lanes.some((ln) => ln.prev && ln.prev.length);
  const legend = (lanes.length ? "Bandes : durée d'un traitement ou d'une blessure, points : jours de prise ou de suivi. " : "")
    + (hasPrev ? "Rectangle rouge : symptôme noté. Cercle vide : traitement préventif pris sans symptôme. " : "") + "Touche le graphique pour voir un jour.";
  root.append(h("h2", null, vault.settings.name, h("small", { text: "10 = le pire" })), h("p", { class: "summary", text: summary }),
    h("div", { class: "chart-card" }, svg), severityKeys(), h("p", { class: "meta", text: legend }), detail);

  const listed = pts.slice().reverse();
  if (listed.length) root.append(h("details", { class: "history" }, h("summary", { text: "Toutes les saisies de la période (" + listed.length + ")" }),
    h("ul", null, listed.map((p) => { const e = vault.entries[p.k]; return h("li", null, h("strong", { text: fmtDay(p.k) + " " }), p.v + " · " + WORDS[p.v] + (e.triggers && e.triggers.length ? " · " + e.triggers.join(", ") : "")); }))));
}

/* ---------- Récap de consultation ---------- */
const SPANS = [["30 jours", 30], ["90 jours", 90], ["6 mois", 182], ["1 an", 365]];
function tally(lists) {
  const m = {}; lists.forEach((l) => (l || []).forEach((x) => { m[x] = (m[x] || 0) + 1; }));
  return Object.keys(m).map((k) => [k, m[k]]).sort((a, b) => b[1] - a[1]);
}
function table(heads, rows) {
  return h("div", { class: "tscroll" }, h("table", null, h("thead", null, h("tr", null, heads.map((t) => h("th", { scope: "col", text: t })))),
    h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", { text: c == null || c === "" ? "–" : String(c) })))))));
}
const facts = (pairs) => h("dl", { class: "facts" }, pairs.map((p) => h("div", null, h("dt", { text: p[0] }), h("dd", { text: p[1] }))));
function curveSvg(start, N, W, pts) {
  const L = 24, R = 12, T = 10, PH = 120, H = T + PH + 24, PW = W - L - R;
  const x = (i) => L + (N === 1 ? 0 : i * PW / (N - 1)), y = (v) => T + (10 - v) * PH / 9;
  const svg = sv("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Courbe de la note quotidienne sur la période" });
  [1, 4, 7, 10].forEach((v) => {
    svg.append(sv("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--line)", "stroke-width": 1 }));
    svg.append(sv("text", { x: L - 7, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, v));
  });
  axisTicks(N).forEach((tk) => svg.append(sv("text", { x: x(tk[0]), y: T + PH + 17, "text-anchor": tk[1], "font-size": 11, fill: "var(--muted)" }, fmtDate(addDays(start, tk[0])))));
  const d = curvePath(pts, x, y);
  if (d) svg.append(sv("path", { d, fill: "none", stroke: "var(--muted)", "stroke-opacity": 0.55, "stroke-width": 1.5, "stroke-linejoin": "round" }));
  const r = N <= 31 ? 3.5 : N <= 92 ? 2.6 : 1.8;
  pts.forEach((p) => svg.append(sv("circle", { cx: x(p.i), cy: y(p.v), r, fill: sevColor(p.v) })));
  return svg;
}
function mainSection(start, N, W, detailed) {
  const pts = [];
  for (let i = 0; i < N; i++) { const k = addDays(start, i), e = vault.entries[k]; if (e && e.score) pts.push({ k, i, v: e.score, e }); }
  const out = [h("h3", { text: vault.settings.name })];
  if (!pts.length) { out.push(h("p", { class: "meta", text: "Aucune saisie sur la période." })); return h("section", null, out); }
  const vals = pts.map((p) => p.v), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const flares = pts.filter((p) => p.v >= 7);
  let episodes = 0, last = null;
  flares.forEach((p) => { if (last === null || p.i - last > 1) episodes++; last = p.i; });
  const bad = pts.filter((p) => p.e.sleep === "Mauvais").length, woke = pts.filter((p) => (p.e.sleepExtra || []).length).length;
  out.push(facts([["Note moyenne", fr1(avg) + " / 10"], ["Jours notés", pts.length + " sur " + N], ["Extrêmes", Math.min(...vals) + " à " + Math.max(...vals)],
    ["Jours en poussée (7 et plus)", String(flares.length)], ["Poussées distinctes", String(episodes)], ["Nuits mauvaises", String(bad)], ["Réveils dus aux symptômes", String(woke)]]));
  out.push(curveSvg(start, N, W, pts), severityKeys());
  const zones = tally(pts.map((p) => p.e.zones)).slice(0, 6);
  if (zones.length) out.push(h("p", null, h("strong", { text: "Zones les plus touchées : " }), zones.map((z) => z[0] + " (" + z[1] + " j)").join(", ")));
  const trig = tally(pts.map((p) => (p.e.triggers || []).filter((t) => t !== "Aucun identifié"))).slice(0, 6);
  if (trig.length) out.push(h("p", null, h("strong", { text: "Déclencheurs suspectés : " }), trig.map((t) => {
    const on = pts.filter((p) => (p.e.triggers || []).indexOf(t[0]) >= 0);
    return t[0] + " (" + t[1] + " j, note moyenne " + fr1(on.reduce((a, p) => a + p.v, 0) / on.length) + ")";
  }).join(", ")));
  vault.settings.checks.forEach((c) => {
    const on = pts.filter((p) => (p.e.checks || {})[c.id] && p.e.checks[c.id].on);
    const prev = pts.filter((p) => isPreventive((p.e.checks || {})[c.id]));
    if (!on.length && !prev.length) return;
    const dates = (list) => list.length <= 8 ? " (" + list.map((p) => fmtDate(p.k)).join(", ") + ")" : "";
    const parts = [on.length ? plural(on.length, "jour avec symptôme", "jours avec symptôme") + dates(on) : "aucun jour avec symptôme"];
    if (c.askTreatment && on.length) parts.push("traitement pris pendant le symptôme " + on.filter((p) => p.e.checks[c.id].ttt === "Oui").length + " fois");
    if (prev.length) parts.push("traitement préventif pris sans symptôme " + plural(prev.length, "fois", "fois") + dates(prev));
    out.push(h("p", null, h("strong", { text: c.label + " : " }), parts.join(", ") + "."));
  });
  const notes = pts.filter((p) => p.e.note).reverse().slice(0, detailed ? 12 : 4);
  if (notes.length) out.push(h("p", null, h("strong", { text: "Commentaires du patient" })), h("ul", null, notes.map((p) => h("li", { text: fmtDate(p.k) + " : " + p.e.note }))));
  return h("section", null, out);
}
function trtSection(list, start) {
  const out = [h("h3", { text: "Traitements" })];
  if (!list.length) out.push(h("p", { class: "meta", text: "Aucun traitement suivi sur la période." }));
  list.forEach((t) => {
    const takes = t.takes.filter((k) => k >= start && k <= TODAY), evs = t.evals.filter((ev) => ev.date >= start), last = lastOf(t.evals);
    const eff = evs.map((ev) => ev.efficacy).filter((v) => v != null);
    out.push(h("div", { class: "item" }, h("strong", { text: t.name + (t.end ? " (arrêté)" : "") }),
      h("span", { class: "meta", text: [t.target ? "Pour : " + t.target : null, t.dose || null, freqText(t), t.end ? "du " + fmtDate(t.start) + " au " + fmtDate(t.end) : "depuis le " + fmtFull(t.start)].filter(Boolean).join(" · ") }),
      t.freq !== "asneeded" || takes.length ? h("span", { text: "Prises notées sur la période : " + takes.length + (takes.length && takes.length <= 8 ? " (" + takes.map(fmtDate).join(", ") + ")" : "") }) : null,
      last ? h("span", { text: "Dernière évaluation (" + fmtDate(last.date) + ") : " + evalText(last) }) : h("span", { class: "meta", text: "Pas encore évalué." }),
      eff.length > 1 ? h("span", { class: "meta", text: evs.length + " évaluations sur la période, efficacité de " + Math.min(...eff) + " à " + Math.max(...eff) + " sur 10" }) : null,
      t.note ? h("span", { class: "meta", text: t.note }) : null));
  });
  return h("section", null, out);
}
function injSection(list, start, detailed) {
  const out = [h("h3", { text: "Blessures" })];
  if (!list.length) out.push(h("p", { class: "meta", text: "Aucune blessure suivie sur la période." }));
  list.forEach((j) => {
    const pts = j.points.filter((p) => p.date >= start);
    const evo = (k, label) => { const v = pts.filter((p) => p[k] != null); return v.length ? label + " " + (v.length > 1 ? v[0][k] + " → " + lastOf(v)[k] : v[0][k]) : null; };
    out.push(h("div", { class: "item" }, h("strong", { text: j.name }),
      h("span", { class: "meta", text: [j.type, j.end ? "du " + fmtDate(j.start) + " au " + fmtDate(j.end) + " (" + span(j.start, j.end) + ")" : "depuis le " + fmtFull(j.start) + " (" + span(j.start, TODAY) + ")", "phase actuelle : " + injPhase(j).toLowerCase()].filter(Boolean).join(" · ") }),
      pts.length ? h("span", { text: [plural(pts.length, "point de suivi", "points de suivi"), evo("pain", "douleur"), evo("gene", "gêne"), plural(pts.filter((p) => p.kine).length, "séance de kiné", "séances de kiné")].filter(Boolean).join(" · ") }) : h("span", { class: "meta", text: "Aucun point de suivi sur la période." }),
      j.note ? h("span", { class: "meta", text: j.note }) : null));
    if (detailed && pts.length) out.push(table(["Date", "Phase", "Douleur", "Gêne", "Kiné", "Note"], pts.map((p) => [fmtDate(p.date), p.phase, p.pain, p.gene, p.kine ? "oui" : "", p.note])));
  });
  return h("section", null, out);
}
function printRecap() {
  const prev = document.title;
  document.title = "Recap-" + TODAY;   // nom proposé pour le PDF
  window.addEventListener("afterprint", () => { document.title = prev; }, { once: true });
  window.print();
}
function renderRecap() {
  const root = $("recap"); root.textContent = "";
  if (!vault) return;
  const rc = ui.recap, start = rc.since || addDays(TODAY, -(rc.days - 1)), N = daysBetween(start, TODAY) + 1;
  const modes = [["main", vault.settings.name], ["injuries", "Blessures"], ["full", "Complet"]];
  const since = h("input", { type: "date", id: "recap-since", max: TODAY, value: rc.since || null });
  since.addEventListener("change", () => { rc.since = since.value && since.value <= TODAY ? since.value : null; renderRecap(); });
  const to = textInput("recap-to", "Ex. : Dr Martin, dermatologue", rc.to, 80);
  to.addEventListener("input", () => { rc.to = to.value; const el = $("recap-to-line"); if (el) el.textContent = rc.to ? "Pour : " + rc.to : ""; });
  root.append(h("div", { class: "view no-print" },
    h("button", { type: "button", class: "ghost", id: "recap-back", text: "Retour au suivi", onclick: () => switchView("suivi") }),
    field("Contenu", "selon le spécialiste", h("div", { class: "chips" }, modes.map((m, i) => h("button", { type: "button", id: "mode-" + i, text: m[1],
      "aria-pressed": m[0] === rc.mode ? "true" : "false", onclick: () => { rc.mode = m[0]; renderRecap(); } })))),
    field("Période", null, h("div", { class: "chips" }, SPANS.map((sp, i) => h("button", { type: "button", id: "span-" + i, text: sp[0],
      "aria-pressed": !rc.since && sp[1] === rc.days ? "true" : "false", onclick: () => { rc.days = sp[1]; rc.since = null; renderRecap(); } })))),
    field("Ou depuis une date", "ton dernier rendez-vous, par exemple", since),
    field("Destinataire", "optionnel, non enregistré", to),
    h("button", { type: "button", class: "primary", id: "recap-print", text: "Enregistrer en PDF", onclick: printRecap }),
    h("p", { class: "meta", text: "Dans la fenêtre qui s'ouvre, choisis « Enregistrer au format PDF » comme imprimante." })));

  const W = Math.max(240, ($("view-recap").clientWidth || 356) - 34);
  const inPeriod = (o) => o.start <= TODAY && (!o.end || o.end >= start);
  const injuries = vault.injuries.filter(inPeriod), injNames = vault.injuries.map((j) => j.name), treatments = vault.treatments.filter(inPeriod);
  const doc = h("article", { class: "doc", id: "recap-doc" },
    h("div", { class: "item" }, h("h2", { text: "Récapitulatif de suivi" }),
      h("span", { id: "recap-to-line", text: rc.to ? "Pour : " + rc.to : "" }),
      h("span", { text: "Du " + fmtFull(start) + " au " + fmtFull(TODAY) + " (" + N + " jours)" }),
      h("span", { class: "meta", text: "Établi le " + fmtFull(TODAY) + " à partir des saisies quotidiennes du patient. Note quotidienne : 1 = aucun symptôme, 10 = poussée sévère. Douleur et gêne : 0 = aucune, 10 = maximale. Efficacité : 10 = très efficace." })));
  if (rc.mode === "main") doc.append(mainSection(start, N, W, true), trtSection(treatments.filter((t) => injNames.indexOf(t.target) < 0), start));
  else if (rc.mode === "injuries") doc.append(injSection(injuries, start, true), trtSection(treatments.filter((t) => injNames.indexOf(t.target) >= 0), start));
  else doc.append(mainSection(start, N, W, false), injSection(injuries, start, false), trtSection(treatments, start));
  root.append(doc);
}

/* ---------- Réglages ---------- */
function listEditor(idPrefix, title, hint, items, onChange) {
  const input = textInput(idPrefix + "-new", "Ajouter…", null, 40);
  return h("section", null, h("h2", null, title, hint ? h("small", { text: hint }) : null),
    h("div", { class: "chips" }, items.map((it, i) => h("button", { type: "button", class: "removable", id: idPrefix + "-" + i, "aria-label": "Retirer " + it,
      onclick: () => onChange(items.filter((x) => x !== it)) }, it, h("span", { "aria-hidden": "true", text: " ×" })))),
    h("form", { class: "add-row", onsubmit: (e) => {
      e.preventDefault();
      const v = capitalize(input.value.trim());
      if (v && !items.some((x) => x.toLowerCase() === v.toLowerCase())) onChange(items.concat(v));
    } }, input, h("button", { type: "submit", text: "Ajouter" })));
}
function downloadBackup() {
  persist().then(() => {
    const raw = readStore();
    const blob = new Blob([JSON.stringify(Object.assign({ app: "carnet", exportedAt: new Date().toISOString() }, JSON.parse(raw)))], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: "carnet-sauvegarde-" + TODAY + ".json" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    vault.lastBackup = TODAY;
    save(renderSettings);
  }, () => setStatus("La sauvegarde a échoué.", true));
}
function secretForm(id, title, submitLabel, fields, onSubmit) {
  const msg = h("p", { class: "status", "aria-live": "polite" });
  const btn = h("button", { type: "submit", class: "primary slim", text: submitLabel });
  return h("form", { class: "card form", id, onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; msg.className = "status"; msg.textContent = "Patiente…";
    try { await onSubmit(msg); } catch (err) { msg.className = "status err"; msg.textContent = err.message || "L'opération a échoué."; }
    finally { btn.disabled = false; }
  } }, h("h3", { text: title }), fields, msg, h("div", { class: "row" }, btn));
}
async function rawKeyFromPass(pass) {
  try { return await unwrapKey(wraps.pw, pass); } catch (e) { throw new Error("Phrase actuelle incorrecte."); }
}
function renderSettings() {
  const root = $("reglages"); root.textContent = "";
  if (!vault) return;
  const s = vault.settings;
  const update = (k) => (v) => { s[k] = v; save(renderSettings); };

  const name = textInput("set-name", "Ex. : nom de l'affection suivie", s.name, 40);
  root.append(h("p", { class: "meta", text: "Tes libellés sont enregistrés chiffrés dans le carnet, comme tes saisies. Le code de l'appli, public, ne contient que des valeurs génériques." }));
  root.append(h("section", null, h("h2", { text: "Suivi quotidien" }),
    h("form", { class: "add-row", onsubmit: (e) => { e.preventDefault(); const v = name.value.trim(); if (v) { s.name = v; save(renderSettings); } } },
      name, h("button", { type: "submit", text: "Renommer" }))));
  root.append(listEditor("set-zone", "Zones", "touche pour retirer", s.zones, update("zones")));
  root.append(listEditor("set-trig", "Déclencheurs", "touche pour retirer", s.triggers, update("triggers")));

  const cLabel = textInput("set-check-new", "Ex. : Poussée d'un autre symptôme", null, 40);
  const cAsk = h("input", { type: "checkbox", id: "set-check-ask" });
  root.append(h("section", null, h("h2", null, "Contrôles rapides", h("small", { text: "question oui / non chaque matin" })),
    s.checks.length ? h("div", { class: "list" }, s.checks.map((c, i) => h("div", { class: "take-row" },
      h("div", { class: "take-text" }, h("strong", { text: c.label }), h("span", { class: "meta", text: c.askTreatment ? "Demande aussi si le traitement a été pris" : "Oui ou non" })),
      confirmButton("Retirer", () => { s.checks = s.checks.filter((x) => x !== c); save(renderSettings); }, "Confirmer")))) : h("p", { class: "meta", text: "Aucun contrôle rapide." }),
    h("form", { class: "card form", onsubmit: (e) => {
      e.preventDefault();
      const v = capitalize(cLabel.value.trim());
      if (!v) return;
      s.checks.push({ id: newId(), label: v, askTreatment: cAsk.checked });
      save(renderSettings);
    } }, field("Nouveau contrôle", null, cLabel), h("label", { class: "check" }, cAsk, "Demander aussi si un traitement a été pris"),
      h("div", { class: "row" }, h("button", { type: "submit", class: "primary slim", text: "Ajouter le contrôle" }))),
    h("p", { class: "meta", text: "Retirer un contrôle le masque des prochaines saisies. Les jours déjà notés restent dans le carnet." })));

  const age = vault.lastBackup ? daysBetween(vault.lastBackup, TODAY) : null;
  root.append(h("section", null, h("h2", { text: "Sauvegarde" }),
    h("p", { class: "summary", text: age === null ? "Aucune sauvegarde téléchargée depuis cet appareil." : "Dernière sauvegarde : " + fmtFull(vault.lastBackup) + (age ? " (il y a " + plural(age, "jour", "jours") + ")" : " (aujourd'hui)") + "." }),
    h("p", { class: "meta", text: "Le fichier est chiffré comme le carnet : il ne s'ouvre qu'avec ta phrase secrète ou ton code de secours. Range-le où tu veux, par exemple dans un dossier de ton cloud." }),
    h("div", { class: "row" },
      h("button", { type: "button", class: "primary slim", id: "backup-download", text: "Télécharger une sauvegarde", onclick: downloadBackup }),
      h("button", { type: "button", class: "ghost", id: "backup-restore", text: "Restaurer une sauvegarde", onclick: () => { lock(""); openRestore(); } }))));

  const cur = passInput("set-cur", "current-password"), np1 = passInput("set-new1", "new-password"), np2 = passInput("set-new2", "new-password");
  const cur2 = passInput("set-cur2", "current-password");
  root.append(h("section", null, h("h2", null, "Sécurité", h("small", { text: "verrouillage après 3 min d'inactivité" })),
    secretForm("form-pass", "Changer la phrase secrète", "Changer la phrase",
      [field("Phrase actuelle", null, cur), field("Nouvelle phrase", MIN_PASS + " caractères minimum", np1), field("Confirme la nouvelle phrase", null, np2)],
      async (msg) => {
        if (np1.value.length < MIN_PASS) throw new Error("La nouvelle phrase doit faire au moins " + MIN_PASS + " caractères.");
        if (np1.value !== np2.value) throw new Error("Les deux saisies ne sont pas identiques.");
        const raw = await rawKeyFromPass(cur.value);
        wraps = { pw: await wrapKey(raw, np1.value), rc: wraps.rc }; raw.fill(0);
        await persist();
        cur.value = np1.value = np2.value = "";
        msg.className = "status"; msg.textContent = "Phrase changée. Ton code de secours reste valable. Pense à télécharger une nouvelle sauvegarde.";
      }),
    secretForm("form-code", "Nouveau code de secours", "Générer un nouveau code",
      [h("p", { class: "meta", text: "L'ancien code cessera de fonctionner sur cet appareil. Les anciennes sauvegardes restent ouvrables avec l'ancien code." }), field("Phrase actuelle", null, cur2)],
      async () => {
        const raw = await rawKeyFromPass(cur2.value), code = newRecoveryCode();
        wraps = { pw: wraps.pw, rc: await wrapKey(raw, code) }; raw.fill(0);
        await persist();
        showCode(code, "Note ce nouveau code et range-le en lieu sûr. Il remplace l'ancien et ne sera plus affiché.", "Nouveau code de secours enregistré.");
      })));

  let persisted = null;
  const dev = h("p", { class: "meta", text: "Version " + APP_VERSION + "." });
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { persisted = p;
    dev.textContent = "Version " + APP_VERSION + ". Stockage " + (persisted ? "protégé contre l'effacement automatique du navigateur." : "non protégé : le navigateur pourrait l'effacer en cas de manque de place. Installe l'appli sur l'écran d'accueil et garde des sauvegardes."); }).catch(() => {});
  root.append(h("section", null, h("h2", { text: "Cet appareil" }), dev,
    h("div", { class: "row" }, confirmButton("Effacer le carnet de cet appareil", () => { clearStore(); lock("Carnet effacé de cet appareil."); }, "Confirmer l'effacement définitif"))));
}

/* ---------- Navigation ---------- */
const VIEWS = ["matin", "blessures", "traitements", "suivi", "recap", "reglages"];
const TAB_OF = { recap: "suivi" };
function switchView(name) {
  ui.view = name;
  VIEWS.forEach((v) => { $("view-" + v).hidden = v !== name; });
  ["matin", "blessures", "traitements", "suivi"].forEach((v) => {
    if (v === (TAB_OF[name] || name)) $("tab-" + v).setAttribute("aria-current", "page"); else $("tab-" + v).removeAttribute("aria-current");
  });
  $("savebar").hidden = name !== "matin";
  $("today-title").textContent = name === "matin" ? capitalize(now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }))
    : { blessures: "Blessures", traitements: "Traitements", suivi: "Suivi", recap: "Récap de consultation", reglages: "Réglages" }[name];
  if (name === "matin") buildMorning();
  if (name === "blessures") renderInjuries();
  if (name === "traitements") renderTreatments();
  if (name === "suivi") renderSuivi();
  if (name === "recap") renderRecap();
  if (name === "reglages") renderSettings();
  window.scrollTo(0, 0);
}

/* ---------- Verrouillage ---------- */
let mode = "unlock", pendingRaw = null, showingCode = false, afterCode = "", lastActivity = Date.now(), restoreBox = null;
const lockStatus = (msg, err) => { const s = $("lock-status"); s.textContent = msg; s.className = "status" + (err ? " err" : ""); };
function applyPassType() {
  const t = mode === "recover-code" || $("show-pass").checked ? "text" : "password";
  $("pass1").type = t; $("pass2").type = t;
}
const LOCK_TEXT = {
  "create": ["Crée ta phrase secrète", "Elle chiffre le carnet sur cet appareil. " + MIN_PASS + " caractères au minimum, plusieurs mots de préférence. Un code de secours te sera remis juste après.", "Phrase secrète", "Créer le carnet", ""],
  "unlock": ["Carnet verrouillé", "Saisis ta phrase secrète pour ouvrir le carnet.", "Phrase secrète", "Déverrouiller", "Phrase oubliée ?"],
  "recover-code": ["Code de secours", "Saisis le code noté à la création du carnet. Les tirets et les majuscules n'ont pas d'importance.", "Code de secours", "Vérifier le code", "Retour"],
  "recover-newpass": ["Nouvelle phrase secrète", "Code accepté. Choisis une nouvelle phrase de " + MIN_PASS + " caractères au minimum. Ton code de secours reste valable.", "Nouvelle phrase", "Enregistrer la phrase", "Annuler"]
};
function setMode(m, message) {
  mode = m;
  const T = LOCK_TEXT[m];
  $("lock-title").textContent = T[0]; $("lock-sub").textContent = T[1];
  $("pass1-label").textContent = T[2]; $("lock-submit").textContent = T[3];
  $("alt-link").textContent = T[4]; $("alt-link").hidden = !T[4];
  $("pass2-wrap").hidden = !(m === "create" || m === "recover-newpass");
  $("show-wrap").hidden = m === "recover-code";
  $("pass1").autocomplete = m === "unlock" ? "current-password" : m === "recover-code" ? "off" : "new-password";
  $("wipe-wrap").hidden = m !== "recover-code"; $("wipe-panel").hidden = true;
  $("restore-open").hidden = !(m === "create" || m === "unlock");
  $("restore-panel").hidden = true;
  $("lock-form").hidden = false; $("code-screen").hidden = true; $("forgot").hidden = false;
  $("store-notice").hidden = storeOk;
  $("pass1").value = ""; $("pass2").value = "";
  applyPassType(); lockStatus(message || "");
  $("app").hidden = true; $("lock").hidden = false;
  window.scrollTo(0, 0);
}
const showLock = (message) => setMode(readBox() ? "unlock" : "create", message);
function showCode(code, sub, statusAfter) {
  showingCode = true; afterCode = statusAfter || "";
  $("lock-title").textContent = "Ton code de secours";
  $("lock-sub").textContent = sub;
  $("code-value").textContent = formatCode(code);
  $("code-noted").checked = false; $("code-continue").disabled = true;
  $("code-copy").textContent = "Copier le code";
  $("lock-form").hidden = true; $("forgot").hidden = true; $("restore-panel").hidden = true; $("code-screen").hidden = false;
  $("app").hidden = true; $("lock").hidden = false;
  window.scrollTo(0, 0);
}
function lock(message) {
  key = null; wraps = null; vault = null; showingCode = false;
  if (pendingRaw) { pendingRaw.fill(0); pendingRaw = null; }
  Object.assign(ui, { injNew: false, trtNew: false, pointFor: null, evalFor: null, freqFor: null, selDay: null, period: 30 });
  ui.recap = { mode: "main", days: 90, since: null, to: "" };
  ["zones", "triggers", "checks", "inj-new", "injuries-list", "trt-new", "treatments-list", "today-trt", "suivi", "recap", "reglages", "code-value", "week"].forEach((id) => { $(id).textContent = ""; });
  $("note").value = ""; setScore(null); setStatus("");
  showLock(message);
}
function openApp(message) {
  now = new Date(); TODAY = dayKey(now);
  $("pass1").value = ""; $("pass2").value = "";
  $("lock").hidden = true; $("app").hidden = false;
  switchView("matin");
  const today = vault.entries[TODAY];
  setStatus(message || (today ? "Saisie du jour enregistrée à " + hhmm(today.savedAt) + "." : ""));
  lastActivity = Date.now();
  askPersistentStorage();
}
function checkNewPass(pass) {
  if (pass.length < MIN_PASS) { lockStatus("La phrase doit faire au moins " + MIN_PASS + " caractères.", true); return false; }
  if (pass !== $("pass2").value) { lockStatus("Les deux saisies ne sont pas identiques.", true); return false; }
  return true;
}
const CODE_SUB = "Note-le sur papier et range-le chez toi. Il ouvre le carnet si tu oublies ta phrase secrète. Il ne sera plus jamais affiché.";

async function onLockSubmit(e) {
  e.preventDefault();
  if (!cryptoAvailable()) { lockStatus("Le chiffrement n'est pas disponible : ouvre le carnet en https dans un navigateur récent.", true); return; }
  const pass = $("pass1").value, btn = $("lock-submit");
  if (!pass) return;
  if ((mode === "create" || mode === "recover-newpass") && !checkNewPass(pass)) return;
  btn.disabled = true;
  try {
    if (mode === "create") {
      lockStatus("Création du carnet…");
      const raw = newDataKey(), code = newRecoveryCode();
      wraps = { pw: await wrapKey(raw, pass), rc: await wrapKey(raw, code) };
      key = await importDataKey(raw); raw.fill(0);
      vault = normVault(null);
      await persist();
      showCode(code, CODE_SUB);
    } else if (mode === "unlock") {
      lockStatus("Déverrouillage…");
      const box = readBox();
      if (!box) { lockStatus("Le carnet stocké est illisible.", true); return; }
      let raw;
      try { raw = await unwrapKey(box.pw, pass); } catch (err) { lockStatus("Phrase incorrecte.", true); return; }
      key = await importDataKey(raw); raw.fill(0);
      wraps = { pw: box.pw, rc: box.rc };
      vault = normVault(await decryptJSON(key, box));
      openApp();
    } else if (mode === "recover-code") {
      lockStatus("Vérification…");
      const box = readBox();
      if (!box) { lockStatus("Le carnet stocké est illisible.", true); return; }
      try { pendingRaw = await unwrapKey(box.rc, normalizeCode(pass)); } catch (err) { lockStatus("Code incorrect.", true); return; }
      setMode("recover-newpass");
    } else if (mode === "recover-newpass") {
      lockStatus("Enregistrement de la nouvelle phrase…");
      const box = readBox();
      wraps = { pw: await wrapKey(pendingRaw, pass), rc: box.rc };
      key = await importDataKey(pendingRaw); pendingRaw.fill(0); pendingRaw = null;
      vault = normVault(await decryptJSON(key, box));
      await persist();
      openApp("Nouvelle phrase enregistrée. Ton code de secours reste valable.");
    }
  } catch (err) {
    key = null; wraps = null; vault = null;
    lockStatus("L'opération a échoué. Réessaie.", true);
  } finally { btn.disabled = false; }
}

/* ---------- Restauration d'une sauvegarde ---------- */
function openRestore() {
  restoreBox = null;
  $("restore-file").value = "";
  $("restore-status").textContent = ""; $("restore-status").className = "status";
  $("restore-confirm").disabled = true;
  $("restore-text").textContent = readBox()
    ? "Choisis un fichier de sauvegarde du carnet. Il remplacera le carnet de cet appareil, qui sera perdu s'il n'est pas sauvegardé. Tu l'ouvriras ensuite avec la phrase secrète ou le code de secours de cette sauvegarde."
    : "Choisis un fichier de sauvegarde du carnet. Tu l'ouvriras ensuite avec la phrase secrète ou le code de secours de cette sauvegarde.";
  $("lock-form").hidden = true; $("forgot").hidden = true; $("restore-panel").hidden = false;
}
function onRestoreFile() {
  const f = $("restore-file").files[0], st = $("restore-status");
  restoreBox = null; $("restore-confirm").disabled = true;
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { st.className = "status err"; st.textContent = "Ce fichier est trop volumineux pour être une sauvegarde du carnet."; return; }
  const reader = new FileReader();
  reader.onload = () => {
    let box = null;
    try { box = JSON.parse(reader.result); } catch (e) { box = null; }
    if (!isValidBox(box)) { st.className = "status err"; st.textContent = "Ce fichier n'est pas une sauvegarde du carnet."; return; }
    restoreBox = { v: box.v, pw: box.pw, rc: box.rc, iv: box.iv, ct: box.ct };
    st.className = "status";
    st.textContent = "Sauvegarde valide" + (box.exportedAt ? ", créée le " + fmtFull(dayKey(new Date(box.exportedAt))) : "") + ".";
    $("restore-confirm").disabled = false;
  };
  reader.onerror = () => { st.className = "status err"; st.textContent = "Impossible de lire ce fichier."; };
  reader.readAsText(f);
}
function onRestoreConfirm() {
  if (!restoreBox) return;
  try { writeStore(JSON.stringify(restoreBox)); }
  catch (e) { $("restore-status").className = "status err"; $("restore-status").textContent = "Impossible d'écrire sur cet appareil."; return; }
  restoreBox = null;
  setMode("unlock", "Sauvegarde restaurée. Ouvre-la avec sa phrase secrète.");
}

/* ---------- Démarrage ---------- */
function init() {
  const scale = $("scale");
  for (let i = 1; i <= 10; i++) {
    scale.append(h("button", { type: "button", id: "score-" + i, class: sevClass(i), text: i, "aria-pressed": "false",
      "aria-label": i + " sur 10, " + WORDS[i], onclick: () => { setScore(i); setStatus(""); } }));
  }
  fillChips("sleep", SLEEP); fillChips("sleep-extra", SLEEP_EXTRA);

  $("trig-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("trig-new"), label = capitalize(input.value.trim());
    if (!label || !vault) return;
    const exists = Array.prototype.find.call($("triggers").children, (c) => c.textContent.toLowerCase() === label.toLowerCase());
    (exists || addChip("triggers", label)).setAttribute("aria-pressed", "true");
    input.value = "";
    if (!exists) { vault.settings.triggers.push(label); save(); }
  });
  $("save").addEventListener("click", async () => {
    if (!vault) return;
    if (!score) { setStatus("Choisis d'abord une note de 1 à 10.", true); $("score-5").scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    const entry = readForm();
    vault.entries[TODAY] = entry;
    try { await persist(); } catch (e) { setStatus("L'enregistrement a échoué : l'espace de stockage est peut-être plein.", true); return; }
    renderWeek(); renderBackupNudge();
    setStatus("Enregistré et chiffré à " + hhmm(entry.savedAt) + ".");
    $("save").textContent = "Mettre à jour la saisie";
  });
  $("inj-new-open").addEventListener("click", () => { ui.injNew = true; renderInjuries(); $("inj-name").focus(); });
  $("trt-new-open").addEventListener("click", () => { ui.trtNew = true; renderTreatments(); $("trt-name").focus(); });
  ["matin", "blessures", "traitements", "suivi"].forEach((v) => $("tab-" + v).addEventListener("click", () => switchView(v)));
  $("settings-open").addEventListener("click", () => switchView("reglages"));

  $("lock-form").addEventListener("submit", onLockSubmit);
  $("show-pass").addEventListener("change", applyPassType);
  $("code-noted").addEventListener("change", (e) => { $("code-continue").disabled = !e.target.checked; });
  $("code-copy").addEventListener("click", () => {
    const text = $("code-value").textContent;
    const fallback = () => {
      const r = document.createRange(); r.selectNodeContents($("code-value"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      $("code-copy").textContent = "Code sélectionné : copie-le";
    };
    try { navigator.clipboard.writeText(text).then(() => { $("code-copy").textContent = "Copié"; }, fallback); } catch (e) { fallback(); }
  });
  $("code-continue").addEventListener("click", () => { showingCode = false; $("code-value").textContent = ""; openApp(afterCode); });
  $("alt-link").addEventListener("click", () => {
    if (pendingRaw) { pendingRaw.fill(0); pendingRaw = null; }
    setMode(mode === "unlock" ? "recover-code" : "unlock");
  });
  $("lock-now").addEventListener("click", () => lock(""));
  $("wipe-open").addEventListener("click", () => { $("wipe-panel").hidden = false; });
  $("wipe-cancel").addEventListener("click", () => { $("wipe-panel").hidden = true; });
  $("wipe").addEventListener("click", () => { clearStore(); showLock("Carnet effacé."); });
  $("restore-open").addEventListener("click", openRestore);
  $("restore-file").addEventListener("change", onRestoreFile);
  $("restore-confirm").addEventListener("click", onRestoreConfirm);
  $("restore-cancel").addEventListener("click", () => showLock(""));

  // Verrouillage automatique après 3 minutes d'inactivité (suspendu pendant l'affichage du code de secours)
  ["pointerdown", "keydown", "input", "scroll"].forEach((ev) => window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
  const checkIdle = () => { if (vault && !showingCode && Date.now() - lastActivity > LOCK_AFTER_MS) lock("Verrouillé après 3 minutes d'inactivité."); };
  setInterval(checkIdle, 5000);
  document.addEventListener("visibilitychange", checkIdle);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (vault && ui.view === "suivi") renderSuivi(); if (vault && ui.view === "recap") renderRecap(); }, 200);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* l'appli marche aussi sans */ });
  }
  showLock("");
}

init();
