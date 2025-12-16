/**
 * Age Grade Converter (client-side)
 *
 * Uses transformed JSON road standards derived from:
 * https://github.com/AlanLyttonJones/Age-Grade-Tables (CC0-1.0)
 *
 * This script:
 *  - Loads a local manifest.json which points to the JSON standards files
 *  - Computes an Age Grade % for the selected event/time/age/sex
 *  - Generates equivalent performance tables for selected targets
 */

"use strict";

const CONFIG = {
  MANIFEST_URL: "age_grade_standards/manifest.json",
  TIME_INPUT_DEBOUNCE_MS: 120,
  AGE_MIN: 5,
  AGE_MAX: 110,
  DEFAULT_MESSAGE: "Enter a valid time to calculate.",
  LOAD_ERROR_MESSAGE:
    "Couldn’t load the standards data. Please refresh, or check that the site is deployed correctly.",
};

const $ = (id) => document.getElementById(id);

/** Cached DOM references */
const dom = {
  setPick: $("setPick"),
  sexPick: $("sexPick"),
  agePick: $("agePick"),
  eventPick: $("eventPick"),
  timePick: $("timePick"),

  ageLabelM: $("ageLabelM"),
  ageLabelF: $("ageLabelF"),

  ageGradeOut: $("ageGradeOut"),
  ageGradeNote: $("ageGradeNote"),

  otherGenderLabel: $("otherGenderLabel"),
  otherGenderTime: $("otherGenderTime"),
  peakTimeLabel: $("peakTimeLabel"),
  peakTime: $("peakTime"),
  peakOtherGenderLabel: $("peakOtherGenderLabel"),
  peakOtherGenderTime: $("peakOtherGenderTime"),

  results: $("results"),

  customRow: $("customRow"),
  customSex: $("customSex"),
  customAge: $("customAge"),

  targetsDivider: document.querySelector(".targetsDivider"),
  targetButtons: Array.from(document.querySelectorAll(".targetBtn")),
};

const state = {
  /** Manifest object loaded from CONFIG.MANIFEST_URL */
  manifest: null,
  /** Standards JSON cache: `${year}_${sex}` -> json */
  standardsCache: new Map(),
  /** Peak cache: `${year}_${sex}` -> { [event]: minSeconds|null } */
  peakCache: new Map(),
  runTimer: null,
  /** null | "peakM" | "peakF" | "ageM" | "ageF" | "custom" */
  activeTarget: null,
};

/* -------------------------------------------------------------------------- */
/*                                UI Utilities                                */
/* -------------------------------------------------------------------------- */

/**
 * Updates the Age Grade section (top-level value + note + 3 equivalent lines)
 * @param {object} args
 */
function setAgeGradeUI({
  gradePct = "—",
  note = "",
  sex,
  event,
  otherGenderTime = "—",
  peakSameTime = "—",
  peakOtherTime = "—",
}) {
  const sLabel = sexLabel(sex);
  const oLabel = sexLabel(otherSex(sex));
  const ev = event ? ` ${event}` : "";

  dom.ageGradeOut.textContent = gradePct;
  dom.ageGradeNote.textContent = note;

  dom.otherGenderLabel.textContent = `Equivalent ${oLabel}${ev} Time`;
  dom.peakTimeLabel.textContent = `Equivalent Peak Age ${sLabel}${ev} Time`;
  dom.peakOtherGenderLabel.textContent = `Equivalent Peak Age ${oLabel}${ev} Time`;

  dom.otherGenderTime.textContent = otherGenderTime;
  dom.peakTime.textContent = peakSameTime;
  dom.peakOtherGenderTime.textContent = peakOtherTime;
}

/**
 * Shows friendly error message in the Age Grade note (and clears results)
 * @param {string} msg
 */
function showLoadError(msg = CONFIG.LOAD_ERROR_MESSAGE) {
  const sex = dom.sexPick?.value || "M";
  const event = dom.eventPick?.value || "";
  setAgeGradeUI({
    sex,
    event,
    gradePct: "—",
    note: msg,
    otherGenderTime: "—",
    peakSameTime: "—",
    peakOtherTime: "—",
  });
  if (dom.results) dom.results.innerHTML = "";
}

/**
 * Updates the Age placeholders in the target button labels
 */
function updateAgeButtons() {
  const age = String(dom.agePick.value ?? "").trim() || "—";
  if (dom.ageLabelM) dom.ageLabelM.textContent = age;
  if (dom.ageLabelF) dom.ageLabelF.textContent = age;
}

/**
 * Sets which target is active (only one at a time; clicking again disables)
 * Also controls custom target row visibility and divider visibility
 * @param {string|null} targetOrNull
 */
function setActiveTarget(targetOrNull) {
  state.activeTarget = targetOrNull;

  for (const btn of dom.targetButtons) {
    const t = btn.dataset.target;
    const active = t === state.activeTarget;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  if (dom.customRow) dom.customRow.hidden = state.activeTarget !== "custom";
  if (dom.targetsDivider) {
    dom.targetsDivider.style.display = state.activeTarget ? "block" : "none";
  }

  if (!state.activeTarget && dom.results) dom.results.innerHTML = "";
  scheduleRun(0);
}

/**
 * Creates a results section with a header and a two-column table
 * @param {string} title
 * @param {{event: string, time: string}[]} rows
 * @returns {HTMLDivElement}
 */
function buildSection(title, rows) {
  const div = document.createElement("div");
  div.className = "resultSection";

  const h = document.createElement("h3");
  h.textContent = title;
  div.appendChild(h);

  const wrap = document.createElement("div");
  wrap.className = "resultTableWrap";

  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const th1 = document.createElement("th");
  const th2 = document.createElement("th");
  th1.textContent = "Distance / Event";
  th2.textContent = "Equivalent Time";
  trh.appendChild(th1);
  trh.appendChild(th2);
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    const td2 = document.createElement("td");
    td1.textContent = r.event;
    td2.textContent = r.time;
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  div.appendChild(wrap);

  return div;
}

/* -------------------------------------------------------------------------- */
/*                              Formatting Helpers                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse "mm:ss" or "hh:mm:ss" into seconds
 * Returns NaN for invalid input
 * @param {string} raw
 * @returns {number}
 */
function parseTimeToSeconds(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;

  const parts = s.split(":").map((x) => x.trim());
  if (parts.some((p) => p === "" || Number.isNaN(Number(p)))) return NaN;

  if (parts.length === 2) {
    const [mm, ss] = parts.map(Number);
    return mm * 60 + ss;
  }

  if (parts.length === 3) {
    const [hh, mm, ss] = parts.map(Number);
    return hh * 3600 + mm * 60 + ss;
  }

  return NaN;
}

/**
 * Format seconds to "m:ss" or "h:mm:ss"
 * @param {number} seconds
 * @returns {string}
 */
function secondsToTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";

  const s = Math.round(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;

  const ssStr = String(ss).padStart(2, "0");
  const mmStr = hh > 0 ? String(mm).padStart(2, "0") : String(mm);

  return hh > 0 ? `${hh}:${mmStr}:${ssStr}` : `${mmStr}:${ssStr}`;
}

/**
 * Formats the user input time as a friendly display time
 * @param {string} raw
 * @returns {string}
 */
function formatInputTime(raw) {
  const sec = parseTimeToSeconds(raw);
  return Number.isFinite(sec) && sec > 0 ? secondsToTime(sec) : "—";
}

function sexLabel(sex) {
  return sex === "M" ? "Male" : "Female";
}

function otherSex(sex) {
  return sex === "M" ? "F" : "M";
}

/**
 * Clamp age to the configured range. Returns null for invalid input
 * @param {number} n
 * @returns {number|null}
 */
function clampAge(n) {
  if (!Number.isFinite(n)) return null;
  if (n < CONFIG.AGE_MIN) return CONFIG.AGE_MIN;
  if (n > CONFIG.AGE_MAX) return CONFIG.AGE_MAX;
  return Math.round(n);
}

/**
 * Reads and clamps the age from the UI
 * @returns {number|null}
 */
function getAge() {
  const n = Number(String(dom.agePick.value ?? "").trim());
  return clampAge(n);
}

/* -------------------------------------------------------------------------- */
/*                                Data Loading                                */
/* -------------------------------------------------------------------------- */

/**
 * Loads the standards manifest
 * @returns {Promise<any>}
 */
async function loadManifest() {
  if (state.manifest) return state.manifest;

  const res = await fetch(CONFIG.MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to load manifest: ${CONFIG.MANIFEST_URL}`);

  state.manifest = await res.json();
  return state.manifest;
}

/**
 * Gets the currently selected standards set entry from the manifest
 * @returns {any}
 */
function getSelectedSetEntry() {
  const idx = Number(dom.setPick.value);
  const entry = state.manifest?.sets?.[idx];
  if (!entry) throw new Error("Selected standards set not found in manifest");
  return entry;
}

/**
 * Loads a standards JSON
 * @param {any} entry
 * @param {"M"|"F"} sex
 * @returns {Promise<any>}
 */
async function loadStandards(entry, sex) {
  const sexKey = sex === "M" ? "male" : "female";
  const url = `${entry.base}/${entry[sexKey]}`;
  const cacheKey = `${entry.year}_${sex}`;

  if (state.standardsCache.has(cacheKey)) {
    return state.standardsCache.get(cacheKey);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);

  const json = await res.json();
  state.standardsCache.set(cacheKey, json);
  return json;
}

/**
 * Selects the usable standards table from a JSON payload
 * @param {any} json
 * @returns {{events: string[], standards_seconds: Record<string, Record<string, number|null>>}}
 */
function getTable(json) {
  if (json?.AgeStdSec?.standards_seconds) return json.AgeStdSec;
  if (json?.AgeStdHMS?.standards_seconds) return json.AgeStdHMS;
  throw new Error("No usable standards table found in JSON");
}

/**
 * Returns the standard seconds for a given event and age
 * @param {any} table
 * @param {string} event
 * @param {number} age
 * @returns {number|null}
 */
function getStandardSeconds(table, event, age) {
  const map = table?.standards_seconds?.[event];
  if (!map) return null;
  return map[String(age)] ?? null;
}

/* -------------------------------------------------------------------------- */
/*                              Peak Calculations                              */
/* -------------------------------------------------------------------------- */

/**
 * Computes "peak age" (factor of 1.000 / fastest standard) per event in a standards table
 * @param {any} table
 * @returns {Record<string, number|null>}
 */
function computePeak(table) {
  const peak = {};
  for (const event of table.events) {
    let best = Infinity;
    const m = table.standards_seconds[event];

    for (const a of Object.keys(m)) {
      const v = m[a];
      if (typeof v === "number" && v > 0 && v < best) best = v;
    }

    peak[event] = Number.isFinite(best) ? best : null;
  }
  return peak;
}

/**
 * Gets peak cache for a set/sex key
 * @param {string} cacheKey
 * @param {any} table
 * @returns {Record<string, number|null>}
 */
function getPeak(cacheKey, table) {
  if (!state.peakCache.has(cacheKey)) {
    state.peakCache.set(cacheKey, computePeak(table));
  }
  return state.peakCache.get(cacheKey);
}

/* -------------------------------------------------------------------------- */
/*                             UI Refresh Helpers                              */
/* -------------------------------------------------------------------------- */

function scheduleRun(delayMs = 0) {
  if (state.runTimer) clearTimeout(state.runTimer);
  state.runTimer = setTimeout(runLive, delayMs);
}

/**
 * Populates the WMA Standards select from the manifest
 */
async function refreshSetPick() {
  const manifest = await loadManifest();
  dom.setPick.innerHTML = "";

  for (const [i, entry] of manifest.sets.entries()) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = entry.label;
    dom.setPick.appendChild(opt);
  }

  if (manifest.sets.length) {
    dom.setPick.value = String(manifest.sets.length - 1); // newest by default
  }
}

/**
 * Picks default event preference (tries 5 km first, otherwise first option)
 * @param {HTMLSelectElement} selectEl
 */
function pickDefaultEvent(selectEl) {
  const preferred = ["5 km", "5k", "5K", "parkrun"];
  for (const p of preferred) {
    const opt = Array.from(selectEl.options).find(
      (o) => o.value === p || o.textContent === p
    );
    if (opt) {
      selectEl.value = opt.value;
      return;
    }
  }

  if (selectEl.options.length) {
    selectEl.value = selectEl.options[0].value;
  }
}

function getUrlPreset() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("preset") === "parkrun") return "parkrun";
  return null;
}

function setPickToYear(year) {
  const manifest = state.manifest;
  if (!manifest?.sets?.length) return false;

  const idx = manifest.sets.findIndex(s => String(s.year) === String(year) || String(s.label).includes(String(year)));
  if (idx < 0) return false;

  el("setPick").value = String(idx);
  return true;
}

function setEventIfExists(eventName) {
  const pick = el("eventPick");
  const opt = Array.from(pick.options).find(o => o.value === eventName);
  if (!opt) return false;
  pick.value = eventName;
  return true;
}

/**
 * Populates the Distance/Event list from the selected standards set
 */
async function refreshEvents() {
  const entry = getSelectedSetEntry();
  const sex = dom.sexPick.value;

  const json = await loadStandards(entry, sex);
  const table = getTable(json);

  const prev = dom.eventPick.value;
  dom.eventPick.innerHTML = "";

  for (const ev of table.events) {
    const opt = document.createElement("option");
    opt.value = ev;
    opt.textContent = ev;
    dom.eventPick.appendChild(opt);
  }

  if (prev && Array.from(dom.eventPick.options).some((o) => o.value === prev)) {
    dom.eventPick.value = prev;
  } else {
    pickDefaultEvent(dom.eventPick);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Compute                                   */
/* -------------------------------------------------------------------------- */

/**
 * Computes all inputs and required tables for the current UI state
 */
async function computeContext() {
  const entry = getSelectedSetEntry();
  const sex = dom.sexPick.value;
  const os = otherSex(sex);

  const age = getAge();
  const event = dom.eventPick.value;
  const tSec = parseTimeToSeconds(dom.timePick.value);

  const json = await loadStandards(entry, sex);
  const table = getTable(json);
  const std = age != null ? getStandardSeconds(table, event, age) : null;

  const jsonM = await loadStandards(entry, "M");
  const jsonF = await loadStandards(entry, "F");
  const tableM = getTable(jsonM);
  const tableF = getTable(jsonF);

  const peakM = getPeak(`${entry.year}_M`, tableM);
  const peakF = getPeak(`${entry.year}_F`, tableF);

  return { entry, sex, os, age, event, tSec, std, tableM, tableF, peakM, peakF };
}

async function runLive() {
  updateAgeButtons();

  const sex = dom.sexPick.value;
  const eventNow = dom.eventPick?.value || "";

  setAgeGradeUI({
    sex,
    event: eventNow,
    gradePct: "—",
    note: CONFIG.DEFAULT_MESSAGE,
  });

  let ctx;
  try {
    ctx = await computeContext();
  } catch (err) {
    showLoadError();
    return;
  }

  const { entry, age, event, tSec, sex: s, os, std, tableM, tableF, peakM, peakF } = ctx;

  if (!Number.isFinite(tSec) || tSec <= 0) {
    if (!state.activeTarget) dom.results.innerHTML = "";
    return;
  }

  if (age == null) {
    setAgeGradeUI({
      sex: s,
      event,
      note: "Enter a valid age to calculate.",
    });
    if (!state.activeTarget) dom.results.innerHTML = "";
    return;
  }

  if (!std) {
    setAgeGradeUI({
      sex: s,
      event,
      note: "That age/event doesn’t exist in this standards set.",
    });
    if (!state.activeTarget) dom.results.innerHTML = "";
    return;
  }

  const performanceFactor = std / tSec;
  const ageGradePct = performanceFactor * 100;

  const tableOther = os === "M" ? tableM : tableF;
  const peakSame = s === "M" ? peakM : peakF;
  const peakOther = os === "M" ? peakM : peakF;

  const otherStdSameAge = getStandardSeconds(tableOther, event, age);
  const peakStdSameSex = peakSame[event];
  const peakStdOtherSex = peakOther[event];

  setAgeGradeUI({
    sex: s,
    event,
    gradePct: `${ageGradePct.toFixed(2)}%`,
    note: `${formatInputTime(dom.timePick.value)} ${event}, ${sexLabel(s)}, Age ${age}, WMA ${entry.label}`,
    otherGenderTime: otherStdSameAge ? secondsToTime(otherStdSameAge / performanceFactor) : "—",
    peakSameTime: peakStdSameSex ? secondsToTime(peakStdSameSex / performanceFactor) : "—",
    peakOtherTime: peakStdOtherSex ? secondsToTime(peakStdOtherSex / performanceFactor) : "—",
  });

  if (!state.activeTarget) {
    dom.results.innerHTML = "";
    return;
  }

  dom.results.innerHTML = "";

  if (state.activeTarget === "peakM") {
    const rows = tableM.events.map((ev) => {
      const s2 = peakM[ev];
      return { event: ev, time: s2 ? secondsToTime(s2 / performanceFactor) : "—" };
    });
    dom.results.appendChild(buildSection("Peak Age Male Equivalents", rows));
    return;
  }

  if (state.activeTarget === "peakF") {
    const rows = tableF.events.map((ev) => {
      const s2 = peakF[ev];
      return { event: ev, time: s2 ? secondsToTime(s2 / performanceFactor) : "—" };
    });
    dom.results.appendChild(buildSection("Peak Age Female Equivalents", rows));
    return;
  }

  if (state.activeTarget === "ageM") {
    const rows = tableM.events.map((ev) => {
      const s2 = getStandardSeconds(tableM, ev, age);
      return { event: ev, time: s2 ? secondsToTime(s2 / performanceFactor) : "—" };
    });
    dom.results.appendChild(buildSection(`Age ${age} Male Equivalents`, rows));
    return;
  }

  if (state.activeTarget === "ageF") {
    const rows = tableF.events.map((ev) => {
      const s2 = getStandardSeconds(tableF, ev, age);
      return { event: ev, time: s2 ? secondsToTime(s2 / performanceFactor) : "—" };
    });
    dom.results.appendChild(buildSection(`Age ${age} Female Equivalents`, rows));
    return;
  }

  if (state.activeTarget === "custom") {
    const cSex = dom.customSex.value;
    const cAge = clampAge(Number(dom.customAge.value));

    const jsonC = await loadStandards(entry, cSex);
    const tableC = getTable(jsonC);

    const rows = tableC.events.map((ev) => {
      const s2 = cAge != null ? getStandardSeconds(tableC, ev, cAge) : null;
      return { event: ev, time: s2 ? secondsToTime(s2 / performanceFactor) : "—" };
    });

    dom.results.appendChild(
      buildSection(`Custom Target (${sexLabel(cSex)}, age ${cAge ?? "—"})`, rows)
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Wiring                                   */
/* -------------------------------------------------------------------------- */

function wire() {
  for (const btn of dom.targetButtons) {
    btn.addEventListener("click", () => {
      const t = btn.dataset.target;
      setActiveTarget(state.activeTarget === t ? null : t);
    });
  }

  dom.setPick.addEventListener("change", async () => {
    try {
      await refreshEvents();
      scheduleRun(0);
    } catch {
      showLoadError();
    }
  });

  dom.sexPick.addEventListener("change", async () => {
    try {
      await refreshEvents();
      scheduleRun(0);
    } catch {
      showLoadError();
    }
  });

  dom.agePick.addEventListener("input", () => scheduleRun(0));
  dom.eventPick.addEventListener("change", () => scheduleRun(0));
  dom.timePick.addEventListener("input", () => scheduleRun(CONFIG.TIME_INPUT_DEBOUNCE_MS));

  dom.customSex.addEventListener("change", () => scheduleRun(0));
  dom.customAge.addEventListener("input", () => scheduleRun(0));
}

(async function init() {
  await loadManifest();
  await refreshSetPick();

  const preset = getUrlPreset();

  // Apply preset that changes defaults (but only when URL asks for it)
  if (preset === "parkrun") {
    setPickToYear(2010);
  }

  await refreshEvents();

  if (preset === "parkrun") {
    setEventIfExists("5 km");
  }

  wire();
  setActiveTarget(null);
  scheduleRun(0);
})();
