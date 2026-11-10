import {
  DEFAULT_VOLUME_RANGES, calculateAverageRir, calculateUsefulSets,
  calculateVolume, calculateWeekBars, estimateWorkout, convertLegacyProgram, validateV2Program, inspectProgramDates, calendarDay, formatCalendarDay
} from "./workout-metrics.mjs?v=20261110-program-v4";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const parseNumber = (value) => value === "" || value == null ? null : Number(String(value).replace(",", "."));
const methodNames = {
  straight: "Esercizio singolo", superset: "Superset", giant_set: "Giant set", drop_set: "Drop set",
  rest_pause: "Rest-pause", cluster: "Cluster", myo_reps: "Myo-reps", top_back_off: "Top set + back-off",
  eccentric: "Eccentrica", isometric: "Isometrica", circuit: "Circuito"
};
const typeNames = { warmup: "Riscaldamento", working: "Lavoro", top: "Top set", back_off: "Back-off", drop: "Drop", mini_set: "Mini-set", cluster_group: "Gruppo", failure: "Cedimento" };
const multiExerciseMethods = new Set(["superset", "giant_set", "circuit"]);
const minimumExercises = (method) => method === "superset" ? 2 : ["giant_set", "circuit"].includes(method) ? 3 : 1;
const maximumExercises = (method) => multiExerciseMethods.has(method) ? Infinity : 1;
const blankSet = (type = "working", position = 1, overrides = {}) => ({
  id: uid("set"), position, set_type: type, reps_min: null, reps_max: null, reps_mode: "range", load_value: null,
  load_unit: "kg", target_rir: null, tempo: null, rest_seconds: null, intra_rest_seconds: null, parent_set_id: null, round: position, effort_by_feel: false, ...overrides
});
const blankExercise = (position = 1, sets = null) => ({
  id: uid("exercise"), position, name: "", primary_muscles: [], secondary_muscles: [], equipment: "", avg_setup_seconds: null,
  video_ref: null, instructions: "", sets: sets || [1, 2, 3].map((n) => blankSet("working", n))
});
const blankDay = (weekIndex, dayIndex) => ({
  id: uid("workout"), code: String.fromCharCode(65 + dayIndex), day_code: String.fromCharCode(65 + dayIndex), title: `Seduta ${String.fromCharCode(65 + dayIndex)}`,
  weekday: null, muscle_focus: "", available_minutes: null, client_note: "", trainer_note: "", blocks: []
});
const freshProgram = () => convertLegacyProgram({ nome: "", dal: "", al: "", settimane: [{ n: 1, giorni: [{ titolo: "Seduta A", esercizi: [] }] }] });
function repsText(set) {
  if (set.reps_mode === "amrap") return "AMRAP";
  const min = parseNumber(set.reps_min), max = parseNumber(set.reps_max);
  if (set.reps_mode === "time") return min == null ? "" : `${min}s`;
  if (min == null) return "";
  return max != null && max !== min ? `${min}-${max}` : String(min);
}
function parseReps(text, set) {
  const value = String(text || "").trim().toUpperCase().replace(/[–—]/g, "-");
  if (!value) { set.reps_min = null; set.reps_max = null; set.reps_mode = "range"; return true; }
  if (["AMRAP", "CEDIMENTO", "MAX"].includes(value)) { set.reps_min = null; set.reps_max = null; set.reps_mode = "amrap"; return true; }
  const match = value.match(/^(\d+(?:[.,]\d+)?)\s*(?:-|A)\s*(\d+(?:[.,]\d+)?)$/);
  if (match) { set.reps_min = parseNumber(match[1]); set.reps_max = parseNumber(match[2]); set.reps_mode = "range"; return set.reps_min <= set.reps_max; }
  const timed = value.match(/^(\d+(?:[.,]\d+)?)\s*(?:S|SEC|SECONDI?)$/);
  if (timed) { set.reps_min = parseNumber(timed[1]); set.reps_max = set.reps_min; set.reps_mode = "time"; return set.reps_min > 0; }
  const single = parseNumber(value);
  if (single != null && Number.isFinite(single) && single >= 0) { set.reps_min = single; set.reps_max = single; set.reps_mode = "range"; return true; }
  return false;
}
function parseLoad(text, set) {
  const value = String(text || "").trim();
  if (!value) { set.load_value = null; set.load_unit = "kg"; set.load_note = ""; return true; }
  if (/^(PC|BW|CORPO\s*LIBERO)$/i.test(value)) { set.load_value = null; set.load_unit = "bodyweight"; set.load_note = ""; return true; }
  const n = value.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(kg|%)?$/i);
  if (!n) { set.load_note = value.slice(0, 120); set.load_value = null; set.load_unit = "kg"; return true; }
  set.load_value = parseNumber(n[1]);
  const percent = n[2] === "%";
  set.load_unit = percent ? (set.load_value < 0 ? "percent_of_top" : "percent_1rm") : "kg";
  set.load_note = "";
  return true;
}
function parseSeconds(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return null;
  const clock = value.match(/^(\d+):(\d{1,2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const min = value.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minute?)$/);
  if (min) return Math.round(parseNumber(min[1]) * 60);
  const sec = value.match(/^(\d+(?:[.,]\d+)?)\s*(?:s|sec|secondi?)?$/);
  return sec ? Math.round(parseNumber(sec[1])) : NaN;
}
function changeIds(value) {
  const copy = structuredClone(value);
  const renew = (node, field, prefix) => { node[field] = uid(prefix); };
  for (const week of copy.settimane || []) {
    renew(week, "id", "week");
    for (const day of week.giorni || []) {
      renew(day, "id", "workout");
      for (const block of day.blocks || []) {
        const oldBlockId = block.id; renew(block, "id", "block");
        for (const exercise of block.exercises || []) {
          renew(exercise, "id", "exercise");
          for (const row of exercise.sets || []) {
            const oldParent = row.parent_set_id;
            renew(row, "id", "set");
            if (oldParent) row.parent_set_id = `${block.id}:${oldParent}`;
          }
        }
        if (block.id === oldBlockId) renew(block, "id", "block");
      }
    }
  }
  return copy;
}
function duplicateExercise(value, position) {
  const exercise = structuredClone(value); exercise.id = uid("exercise"); exercise.position = position;
  const parents = new Map();
  for (const row of exercise.sets || []) {
    const previous = row.parent_set_id;
    row.id = uid("set");
    if (previous) {
      if (!parents.has(previous)) parents.set(previous, uid("chain"));
      row.parent_set_id = parents.get(previous);
    }
  }
  return exercise;
}
function methodBlock(method, position) {
  const id = uid("block"), make = (exercisePosition, rows) => blankExercise(exercisePosition, rows);
  const rows = (type, count, overrides = {}) => Array.from({ length: count }, (_, index) => blankSet(type, index + 1, { ...overrides, round: index + 1 }));
  let exercises = [];
  const block = { id, position, method, rest_after_seconds: null, intra_rest_seconds: null, client_note: "", trainer_note: "", exercises };
  switch (method) {
    case "top_back_off": exercises = [make(1, [...rows("warmup", 1), ...rows("top", 1), ...rows("back_off", 3)])]; break;
    case "superset": case "giant_set": case "circuit": {
      const count = minimumExercises(method);
      exercises = Array.from({ length: count }, (_, index) => make(index + 1, rows("working", 3)));
      exercises.forEach((exercise) => exercise.sets.forEach((set, index) => { set.round = index + 1; })); break;
    }
    case "drop_set": {
      const parent = uid("chain"); exercises = [make(1, [blankSet("working", 1, { parent_set_id: parent }), ...rows("drop", 2, { parent_set_id: parent })])]; break;
    }
    case "rest_pause": case "myo_reps": case "cluster": {
      const parent = uid("chain"), count = method === "cluster" ? 4 : method === "myo_reps" ? 5 : 4;
      exercises = [make(1, [blankSet("working", 1, { parent_set_id: parent }), ...rows(method === "cluster" ? "cluster_group" : "mini_set", count - 1, { parent_set_id: parent })])]; break;
    }
    case "eccentric": exercises = [make(1, rows("working", 3))]; break;
    case "isometric": exercises = [make(1, rows("working", 3, { reps_mode: "time" }))]; break;
    default: exercises = [make(1, rows("working", 3))];
  }
  block.exercises = exercises;
  return block;
}

export class ProgramBuilder {
  constructor(root, { onChange = () => {} } = {}) {
    this.root = root; this.onChange = onChange; this.program = freshProgram(); this.weekIndex = 0; this.dayIndex = 0; this.scale = "RIR"; this.openBlocks = new Set(); this.activeToolPanel = "volume";
    this.root.addEventListener("click", (event) => this.#click(event));
    this.root.addEventListener("input", (event) => this.#input(event));
    this.root.addEventListener("change", (event) => this.#change(event));
    this.render();
  }
  setProgram(input) {
    this.program = convertLegacyProgram(input || freshProgram());
    if (!this.program.settimane.length) this.program.settimane = freshProgram().settimane;
    this.openBlocks.clear();
    const firstBlock = this.program.settimane[0]?.giorni?.[0]?.blocks?.[0]; if (firstBlock?.id) this.openBlocks.add(firstBlock.id);
    this.scale = this.program.scala_intensita === "RPE" ? "RPE" : "RIR";
    this.weekIndex = 0;
    this.dayIndex = 0;
    this.render();
  }
  setMeta({ nome, dal, al }) {
    if (nome != null) this.program.nome = nome;
    if (dal != null) this.program.dal = dal;
    if (al != null) this.program.al = al;
    this.#automaticDates(); this.#notify(false); this.#renderSummary();
  }
  setScale(scale) { this.scale = scale === "RPE" ? "RPE" : "RIR"; this.program.scala_intensita = this.scale; this.program.intensity_scale = this.scale; this.render(); this.#notify(); }
  getProgram() { return structuredClone(this.program); }
  duplicate() { const copy = changeIds(this.program); copy.nome = `${copy.nome || "Scheda"} (copia)`; this.setProgram(copy); return this.getProgram(); }
  applyJson(input) {
    const result = validateV2Program(input);
    if (!result.valid) return result;
    this.setProgram(result.program); this.#notify(); return result;
  }
  render() {
    const weeks = this.program.settimane || [], week = weeks[this.weekIndex] || { giorni: [] }, days = week.giorni || [], day = days[this.dayIndex] || { blocks: [] };
    const bars = calculateWeekBars(this.program, this.program.settings);
    const exerciseCatalog = new Map();
    const muscleCatalog = new Set();
    for (const sourceWeek of weeks) for (const sourceDay of sourceWeek.giorni || []) for (const sourceBlock of sourceDay.blocks || []) for (const exercise of sourceBlock.exercises || []) {
      const name = String(exercise.name || "").trim(); if (name && !exerciseCatalog.has(name.toLocaleLowerCase())) exerciseCatalog.set(name.toLocaleLowerCase(), exercise);
      for (const muscle of [...(exercise.primary_muscles || []), ...(exercise.secondary_muscles || [])]) if (String(muscle || "").trim()) muscleCatalog.add(String(muscle).trim());
    }
    this.root.innerHTML = `<div class="pb-layout">
      <section class="pb-main">
        <div class="pb-section-head"><div><b>Programmazione</b><span class="sub">Settimane e sedute della scheda</span></div><button type="button" class="secondary" data-action="add-week">+ Settimana</button></div>
        <div class="pb-week-list">${weeks.map((item, index) => `<button type="button" class="pb-week${index === this.weekIndex ? " on" : ""}" data-action="select-week" data-w="${index}"><b>Sett. ${esc(item.n || index + 1)}</b><small>${esc(item.fase || "Fase non impostata")}</small><small>Volume · ${bars[index].usefulSets} serie</small><span class="pb-bars pb-volume-bar"><i style="width:${Math.round(bars[index].volume * 100)}%"></i></span><small>Intensità · ${bars[index].scale} ${bars[index].meanIntensity == null ? "—" : bars[index].meanIntensity.toFixed(1)}</small><span class="pb-bars pb-intensity-bar"><i style="width:${Math.round(bars[index].intensity * 100)}%"></i></span></button>`).join("")}</div>
        <details class="pb-details"><summary>Dettagli settimana${week.rule_note ? " · nota compilata" : ""}</summary><div class="pb-row"><label>Fase<input class="field" data-field="week.fase" value="${esc(week.fase)}" maxlength="80"></label><label>Dal settimana<input class="field" type="date" data-field="week.dal" value="${esc(week.dal)}" ${week.dates_are_manual ? "" : "disabled"}></label><label>Al settimana<input class="field" type="date" data-field="week.al" value="${esc(week.al)}" ${week.dates_are_manual ? "" : "disabled"}></label><label>Target volume (serie)<input class="field" type="number" min="0" max="1000" data-field="week.volume_target" value="${esc(week.volume_target)}" placeholder="Calcolato"></label><label>Target intensità ${this.scale}<input class="field" type="number" min="0" max="10" step="0.5" data-field="week.intensity_target" value="${esc(week.intensity_target)}" placeholder="Calcolata"></label><label class="pb-check"><input type="checkbox" data-field="week.dates_are_manual" ${week.dates_are_manual ? "checked" : ""}> Date manuali</label><div class="pb-inline-actions"><button type="button" class="secondary" data-action="duplicate-week">Duplica</button><button type="button" class="secondary" data-action="move-week-up">↑</button><button type="button" class="secondary" data-action="move-week-down">↓</button><button type="button" class="secondary danger" data-action="delete-week">Elimina</button></div></div><label>Regola / nota della settimana<textarea class="field pb-note" rows="2" data-field="week.rule_note" maxlength="500">${esc(week.rule_note)}</textarea></label></details><div class="pb-date-warnings" id="pbDateWarnings" role="status"></div>
        <div class="pb-section-head pb-day-head"><div><b>Sedute</b><span class="sub">${esc(week.fase || `Settimana ${this.weekIndex + 1}`)}</span></div><button type="button" class="secondary" data-action="add-day">+ Seduta</button></div>
        <div class="pb-day-list">${days.map((item, index) => `<button type="button" class="pb-day${index === this.dayIndex ? " on" : ""}" data-action="select-day" data-d="${index}"><b>${esc(item.code || item.day_code || String.fromCharCode(65 + index))}</b><span>${esc(item.title || "Seduta")}</span></button>`).join("")}</div>
        <details class="pb-details"><summary>Dettagli seduta · ${esc(day.title || "Seduta")}</summary><div class="pb-row pb-day-settings"><label>Nome seduta<input class="field" data-field="day.title" value="${esc(day.title)}" maxlength="120"></label><label>Giorno settimana<select class="field" data-field="day.weekday"><option value="">Non assegnato</option>${["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"].map((name, index) => `<option value="${index + 1}" ${Number(day.weekday) === index + 1 ? "selected" : ""}>${name}</option>`).join("")}</select></label><label>Gruppi muscolari<input class="field" list="pbMuscleLibrary" data-field="day.muscle_focus" value="${esc(day.muscle_focus)}" maxlength="160" placeholder="Per esempio: Petto, tricipiti"></label><label>Durata massima (min)<input class="field" type="number" min="1" max="600" data-field="day.available_minutes" value="${esc(day.available_minutes)}" placeholder="Facoltativa"></label><div class="pb-inline-actions"><button type="button" class="secondary" data-action="duplicate-day">Duplica seduta</button><button type="button" class="secondary danger" data-action="delete-day">Elimina seduta</button></div></div></details>
        <div class="pb-stats" id="pbStats"></div>
        <div class="pb-section-head pb-block-head"><div><b>Esercizi e metodi</b><span class="sub">Aggiungi un blocco; prescrizioni editabili per ogni serie</span></div></div>
        <div class="pb-methods">${Object.entries(methodNames).map(([method, title]) => `<button type="button" class="secondary" data-action="add-block" data-method="${method}">+ ${esc(title)}</button>`).join("")}</div>
        <div class="pb-blocks">${(day.blocks || []).map((block, blockIndex) => this.#renderBlock(block, blockIndex, exerciseCatalog)).join("") || `<div class="pb-empty">Aggiungi il primo esercizio o un blocco avanzato.</div>`}</div>
        <details class="pb-notes" ${day.client_note || day.trainer_note ? "data-has-note" : ""}><summary>Note seduta${day.client_note || day.trainer_note ? " · compilate" : ""}</summary><label>Nota visibile all'atleta<textarea class="field pb-note" rows="2" data-field="day.client_note" maxlength="2000">${esc(day.client_note)}</textarea></label><label>Nota tecnica, solo PT<textarea class="field pb-note" rows="2" data-field="day.trainer_note" maxlength="2000">${esc(day.trainer_note)}</textarea></label></details>
        <datalist id="pbExerciseLibrary">${[...exerciseCatalog.values()].map((exercise) => `<option value="${esc(exercise.name)}"></option>`).join("")}</datalist><datalist id="pbMuscleLibrary">${[...muscleCatalog].sort().map((muscle) => `<option value="${esc(muscle)}"></option>`).join("")}</datalist>
      </section><aside class="pb-aside"><div class="pb-tool-tabs" role="group" aria-label="Strumenti della scheda">${[["library", "Libreria"], ["volume", "Volume"], ["progression", "Progressione"]].map(([panel, label]) => `<button type="button" class="pb-tool-tab${this.activeToolPanel === panel ? " on" : ""}" aria-pressed="${this.activeToolPanel === panel}" data-action="select-tool-panel" data-panel="${panel}">${label}</button>`).join("")}</div>
        <section class="card pb-tool-panel" id="pbToolLibrary" aria-label="Libreria esercizi" ${this.activeToolPanel === "library" ? "" : "hidden"}><h3>Libreria esercizi</h3>${exerciseCatalog.size ? [...exerciseCatalog.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "it")).map((exercise) => `<div class="pb-library-item"><b>${esc(exercise.name)}</b><small>${esc([...(exercise.primary_muscles || []), ...(exercise.secondary_muscles || []), exercise.equipment].filter(Boolean).join(" · ") || "Muscoli e attrezzo da impostare")}</small></div>`).join("") : `<p class="sub">Gli esercizi compariranno qui quando li aggiungi a una scheda. Puoi cercarli nei campi esercizio.</p>`}</section>
        <section class="card pb-tool-panel" id="pbToolVolume" aria-label="Volume settimanale" ${this.activeToolPanel === "volume" ? "" : "hidden"}><h3>Volume settimana</h3><div id="pbVolume"></div><p class="sub">Range iniziali modificabili; sono un riferimento generale, non una prescrizione clinica.</p><div class="pb-ranges"><div class="pb-range-head"><span>Muscolo</span><span>Min</span><span>Max</span></div>${Object.entries({ ...DEFAULT_VOLUME_RANGES, ...(this.program.volume_ranges || {}) }).map(([muscle, range]) => `<div><span>${esc(muscle)}</span><input class="field" type="number" min="0" max="200" data-field="volume.min" data-muscle="${esc(muscle)}" aria-label="Minimo ${esc(muscle)}" value="${esc(range.min)}"><input class="field" type="number" min="0" max="200" data-field="volume.max" data-muscle="${esc(muscle)}" aria-label="Massimo ${esc(muscle)}" value="${esc(range.max)}"></div>`).join("")}</div></section>
        <section class="card pb-tool-panel" id="pbToolProgression" aria-label="Progressione e periodizzazione" ${this.activeToolPanel === "progression" ? "" : "hidden"}><h3>Progressione</h3><p class="sub">I valori sono registrati internamente come RIR. La vista ${this.scale} cambia solo la rappresentazione.</p><label>Periodizzazione<select class="field" data-field="program.periodization"><option value="linear" ${(this.program.periodizzazione || this.program.periodization) === "linear" ? "selected" : ""}>Lineare</option><option value="dup" ${(this.program.periodizzazione || this.program.periodization) === "dup" ? "selected" : ""}>Ondulata (DUP)</option><option value="block" ${(this.program.periodizzazione || this.program.periodization) === "block" ? "selected" : ""}>A blocchi</option></select></label></section>
      </aside>
    </div>`;
    this.root.querySelectorAll(".pb-block[data-block-id]").forEach((block) => block.addEventListener("toggle", () => { if (block.open) this.openBlocks.add(block.dataset.blockId); else this.openBlocks.delete(block.dataset.blockId); }));
    this.#renderSummary();
  }
  #renderBlock(block, blockIndex, exerciseCatalog = new Map()) {
    const exercises = block.exercises || [], multi = multiExerciseMethods.has(block.method);
    const addSetLabel = block.method === "drop_set" ? "+ Drop" : ["rest_pause", "cluster", "myo_reps"].includes(block.method) ? "+ Mini-serie" : multi ? "+ Giro" : "+ Serie";
    const exerciseNames = exercises.map((exercise) => String(exercise.name || "").trim()).filter(Boolean).join(" + ") || "Esercizi da assegnare";
    const totalRows = exercises.reduce((sum, exercise) => sum + (exercise.sets || []).length, 0);
    return `<details class="pb-block" data-block-id="${esc(block.id)}" ${this.openBlocks.has(block.id) ? "open" : ""}><summary class="pb-block-summary"><span class="pb-method-tag">${esc(methodNames[block.method] || block.method)}</span><b>Blocco ${blockIndex + 1} · ${esc(exerciseNames)}</b><small>${exercises.length} esercizi · ${totalRows} serie</small></summary><div class="pb-block-content"><header><div class="pb-block-ident">${exercises.length === 1 ? `<label class="pb-block-name"><span class="sr-only">Nome esercizio</span><input class="field" list="pbExerciseLibrary" data-field="exercise.name" data-b="${blockIndex}" data-e="0" value="${esc(exercises[0].name)}" maxlength="160" placeholder="Cerca o scrivi esercizio" required></label>` : `<b>Blocco ${blockIndex + 1} · ${exercises.length} esercizi</b>`}</div><div class="pb-inline-actions pb-block-actions"><details class="pb-method-menu"><summary class="pb-method-tag" aria-label="Cambia metodo del blocco">${esc(methodNames[block.method] || block.method)} ▾</summary><div>${Object.entries(methodNames).map(([method, label]) => `<button type="button" class="secondary" data-action="set-method" data-method="${method}" data-b="${blockIndex}">${esc(label)}</button>`).join("")}</div></details><button type="button" class="secondary" data-action="add-set" data-b="${blockIndex}" data-e="0" aria-label="Aggiungi serie o giro">${addSetLabel}</button><button type="button" class="secondary" data-action="move-block-up" data-b="${blockIndex}" aria-label="Sposta blocco ${blockIndex + 1} su">↑</button><button type="button" class="secondary" data-action="move-block-down" data-b="${blockIndex}" aria-label="Sposta blocco ${blockIndex + 1} giù">↓</button><button type="button" class="secondary" data-action="duplicate-block" data-b="${blockIndex}" aria-label="Duplica blocco ${blockIndex + 1}">⧉</button><button type="button" class="secondary danger" data-action="delete-block" data-b="${blockIndex}" aria-label="Elimina blocco ${blockIndex + 1}">×</button></div></header>
      ${exercises.map((exercise, exerciseIndex) => `<div class="pb-exercise"><div class="pb-ex-head">${multi ? `<label>Esercizio ${exerciseIndex + 1}<input class="field" list="pbExerciseLibrary" data-field="exercise.name" data-b="${blockIndex}" data-e="${exerciseIndex}" value="${esc(exercise.name)}" maxlength="160" placeholder="Cerca o scrivi esercizio" required></label>` : ""}<div class="pb-ex-summary">${esc([...(exercise.primary_muscles || []), ...(exercise.secondary_muscles || []), exercise.equipment].filter(Boolean).join(" · ") || "Muscoli e attrezzo non impostati")}</div><details class="pb-exercise-meta"><summary>Modifica muscoli e attrezzo</summary><label>Attrezzo<input class="field" data-field="exercise.equipment" data-b="${blockIndex}" data-e="${exerciseIndex}" value="${esc(exercise.equipment)}" maxlength="100" placeholder="Bilanciere, manubri…"></label><label>Muscolo principale<input class="field" data-field="exercise.primary_muscles" data-b="${blockIndex}" data-e="${exerciseIndex}" value="${esc((exercise.primary_muscles || []).join(", "))}" maxlength="160" placeholder="Petto"></label><label>Secondari<input class="field" data-field="exercise.secondary_muscles" data-b="${blockIndex}" data-e="${exerciseIndex}" value="${esc((exercise.secondary_muscles || []).join(", "))}" maxlength="160" placeholder="Tricipiti"></label></details>${multi ? `<button type="button" class="secondary danger pb-remove-exercise" data-action="remove-exercise" data-b="${blockIndex}" data-e="${exerciseIndex}" aria-label="Rimuovi esercizio ${exerciseIndex + 1}">×</button>` : ""}</div>
        <div class="pb-set-table"><div class="pb-set-row pb-set-labels"><span>Serie</span><span>Tipo</span><span>Reps</span><span>Carico</span><span>${this.scale}</span><span>Tempo</span><span>Rec.</span><span></span></div>${(exercise.sets || []).map((set, setIndex) => `<div class="pb-set-row${["drop", "mini_set", "cluster_group"].includes(set.set_type) ? " pb-set-special" : ""}"><span class="pb-row-number">${["drop", "mini_set", "cluster_group"].includes(set.set_type) ? "↳ " : ""}${setIndex + 1}</span><select class="field" data-field="set.set_type" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" aria-label="Tipo serie">${Object.entries(typeNames).map(([value, label]) => `<option value="${value}" ${set.set_type === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select><input class="field" data-field="set.reps" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" value="${esc(repsText(set))}" placeholder="Reps / AMRAP / sec" aria-label="Ripetizioni o durata"><div class="pb-load-cell"><input class="field" data-field="set.load" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" value="${esc(set.load_unit === "bodyweight" ? "PC" : set.load_value == null ? (set.load_note || "") : `${set.load_value}${set.load_unit.startsWith("percent") ? "%" : ""}`)}" placeholder="kg / % / PC" aria-label="Carico"><label><input type="checkbox" data-field="set.effort_by_feel" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" ${set.effort_by_feel ? "checked" : ""}> A sensazione</label></div><input class="field" type="number" step="0.5" min="${this.scale === "RPE" ? 1 : 0}" max="10" data-field="set.intensity" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" value="${set.target_rir == null ? "" : this.scale === "RPE" ? 10 - Number(set.target_rir) : set.target_rir}" aria-label="Intensità ${this.scale}"><input class="field" data-field="set.tempo" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" value="${esc(set.tempo)}" placeholder="4 valori" aria-label="Tempo"><input class="field" data-field="set.rest_seconds" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" value="${esc(set.rest_seconds)}" placeholder="s" aria-label="Recupero in secondi"><button type="button" class="secondary danger pb-delete-set" data-action="delete-set" data-b="${blockIndex}" data-e="${exerciseIndex}" data-s="${setIndex}" aria-label="Elimina serie">×</button></div>`).join("")}</div>
      </div>`).join("")}
      <details class="pb-notes" ${block.client_note || block.trainer_note ? "data-has-note" : ""}><summary>Note blocco${block.client_note || block.trainer_note ? " · compilate" : ""}</summary><label>Nota visibile all'atleta<textarea class="field pb-note" rows="2" data-field="block.client_note" data-b="${blockIndex}" maxlength="1000">${esc(block.client_note)}</textarea></label><label>Nota tecnica, solo PT<textarea class="field pb-note" rows="2" data-field="block.trainer_note" data-b="${blockIndex}" maxlength="1000">${esc(block.trainer_note)}</textarea></label></details>${multi ? `<button type="button" class="secondary" data-action="add-exercise" data-b="${blockIndex}">+ Aggiungi esercizio al blocco</button>` : ""}
    </div></details>`;
  }
  #renderSummary() {
    if (!this.root.isConnected) return;
    const week = this.program.settimane[this.weekIndex], day = week?.giorni?.[this.dayIndex];
    const stats = this.root.querySelector("#pbStats"), volume = this.root.querySelector("#pbVolume");
    if (!stats || !day || !volume) return;
    const sets = calculateUsefulSets(day, this.program.settings), duration = estimateWorkout(day, this.program.settings), effort = calculateAverageRir(day, this.scale, this.program.settings);
    stats.innerHTML = `<div><small>Serie utili</small><b>${sets}</b></div><div class="${duration.exceedsAvailability ? "warn" : ""}"><small>Durata stimata</small><b>${duration.minutes == null ? "—" : `≈ ${duration.minutes} min`}</b>${duration.estimatedReps ? "<small>AMRAP stimato</small>" : ""}${duration.exceedsAvailability ? `<small>Supera la disponibilità di ${Number(day.available_minutes)} min</small>` : ""}</div><div><small>${this.scale} medio</small><b>${effort.display == null ? "—" : Number(effort.display).toFixed(1)}</b></div>`;
    const totals = calculateVolume(week, this.program.settings, { ...DEFAULT_VOLUME_RANGES, ...(this.program.volume_ranges || {}) });
    const entries = Object.entries(totals.status);
    const outOfRange = entries.filter(([, item]) => item.state === "under" || item.state === "over");
    const volumeRows = entries.map(([muscle, item]) => { const ceiling = Math.max(Number(item.max) || item.total || 1, 1), progress = Math.max(0, Math.min(100, item.total / ceiling * 100)), rangeStart = item.min == null ? 0 : Math.max(0, Math.min(100, item.min / ceiling * 100)); return `<div class="pb-vol-row"><span>${esc(muscle)}</span><b>${item.total.toFixed(1)} serie</b><div class="pb-vol-meter" role="img" aria-label="${esc(muscle)}: ${item.total.toFixed(1)} serie, ${item.state === "under" ? "sotto" : item.state === "over" ? "sopra" : "nel range"}"><i style="width:${progress}%"></i><span style="left:${rangeStart}%"></span></div><small>${item.state === "unconfigured" ? "Range non impostato" : item.state === "under" ? "Sotto" : item.state === "over" ? "Sopra" : "Nel range"}${item.min == null ? "" : ` · ${item.min}–${item.max}`}</small></div>`; }).join("");
    const below = outOfRange.filter(([, item]) => item.state === "under").map(([muscle]) => muscle);
    const above = outOfRange.filter(([, item]) => item.state === "over").map(([muscle]) => muscle);
    volume.innerHTML = entries.length ? `${volumeRows}${outOfRange.length ? `<p class="sub">${below.length ? `Sotto: ${esc(below.join(", "))}. ` : ""}${above.length ? `Sopra: ${esc(above.join(", "))}. ` : ""}Valuta dove spostare le serie; non vengono modificate automaticamente.</p>` : ""}` : `<p class="sub">Aggiungi esercizi e gruppi muscolari per calcolare il volume.</p>`;
    const bars = calculateWeekBars(this.program, this.program.settings);
    const dates = inspectProgramDates(this.program);
    const warnings = [...dates.errors, ...dates.warnings];
    const warningBox = this.root.querySelector("#pbDateWarnings");
    if (warningBox) warningBox.innerHTML = warnings.map((item) => `<p class="${dates.errors.includes(item) ? "error" : "warning"}">${esc(item.message)}</p>`).join("");
    this.root.querySelectorAll(".pb-week").forEach((button, index) => {
      if (!bars[index]) return;
      const volumeFill = button.querySelector(".pb-volume-bar i"), intensityFill = button.querySelector(".pb-intensity-bar i");
      const captions = button.querySelectorAll("small");
      if (volumeFill) volumeFill.style.width = `${Math.round(bars[index].volume * 100)}%`;
      if (intensityFill) intensityFill.style.width = `${Math.round(bars[index].intensity * 100)}%`;
      if (captions[1]) captions[1].textContent = `Volume · ${bars[index].usefulSets} serie`;
      if (captions[2]) captions[2].textContent = `Intensità · ${bars[index].scale} ${bars[index].meanIntensity == null ? "—" : bars[index].meanIntensity.toFixed(1)}`;
    });
  }
  #notify(rerender = false) { if (rerender) this.render(); this.onChange(this.getProgram()); }
  #automaticDates() {
    const start = calendarDay(this.program.dal);
    if (start == null) {
      this.program.settimane.forEach((week) => { if (!week.dates_are_manual) { week.dal = ""; week.al = ""; } });
      return;
    }
    const end = calendarDay(this.program.al);
    this.program.settimane.forEach((week, index) => {
      if (week.dates_are_manual) return;
      const from = start + index * 7;
      week.dal = formatCalendarDay(from);
      week.al = formatCalendarDay(end != null ? Math.min(from + 6, end) : from + 6);
    });
  }
  #renumberWeeks() { this.program.settimane.forEach((week, index) => { week.n = index + 1; }); this.#automaticDates(); }
  #renumberDays(week) { week.giorni.forEach((day, index) => { day.code = String.fromCharCode(65 + index); day.day_code = day.code; }); }
  #currentDay() { return this.program.settimane[this.weekIndex]?.giorni?.[this.dayIndex]; }
  #openFirstBlock() { this.openBlocks.clear(); const block = this.#currentDay()?.blocks?.[0]; if (block?.id) this.openBlocks.add(block.id); }
  #click(event) {
    const button = event.target.closest("[data-action]"); if (!button) return;
    const action = button.dataset.action, week = this.program.settimane[this.weekIndex], day = this.#currentDay(), bi = Number(button.dataset.b), ei = Number(button.dataset.e), si = Number(button.dataset.s);
    if (action === "select-tool-panel") { if (["library", "volume", "progression"].includes(button.dataset.panel)) { this.activeToolPanel = button.dataset.panel; this.render(); } return; }
    if (action === "select-week") { this.weekIndex = Number(button.dataset.w); this.dayIndex = 0; this.#openFirstBlock(); this.render(); return; }
    if (action === "select-day") { this.dayIndex = Number(button.dataset.d); this.#openFirstBlock(); this.render(); return; }
    if (action === "add-week") {
      const duplicate = week && confirm("Vuoi copiare la settimana selezionata? Annulla per aggiungerne una vuota.");
      const next = duplicate ? changeIds(week) : { id: uid("week"), n: this.program.settimane.length + 1, fase: "", dal: "", al: "", dates_are_manual: false, volume_target: null, intensity_target: null, rule_note: "", giorni: [blankDay(this.program.settimane.length, 0)] };
      next.n = this.program.settimane.length + 1; next.dates_are_manual = false; this.program.settimane.push(next); this.weekIndex = this.program.settimane.length - 1; this.dayIndex = 0; this.#renumberWeeks(); this.#notify(true); return;
    }
    if (action === "duplicate-week") { const copy = changeIds(week); copy.n = this.program.settimane.length + 1; copy.fase = `${copy.fase || `Fase ${copy.n}`} (copia)`; copy.dates_are_manual = false; this.program.settimane.splice(this.weekIndex + 1, 0, copy); this.weekIndex++; this.#renumberWeeks(); this.#notify(true); return; }
    if (action === "delete-week") { if (this.program.settimane.length < 2) return alert("La scheda deve mantenere almeno una settimana."); if (!confirm("Eliminare questa settimana?")) return; this.program.settimane.splice(this.weekIndex, 1); this.weekIndex = Math.max(0, this.weekIndex - 1); this.dayIndex = 0; this.#renumberWeeks(); this.#notify(true); return; }
    if (action === "move-week-up" || action === "move-week-down") { const target = this.weekIndex + (action.endsWith("up") ? -1 : 1); if (target < 0 || target >= this.program.settimane.length) return; [this.program.settimane[this.weekIndex], this.program.settimane[target]] = [this.program.settimane[target], this.program.settimane[this.weekIndex]]; this.weekIndex = target; this.#renumberWeeks(); this.#notify(true); return; }
    if (action === "add-day") { if (week.giorni.length >= 7) return alert("Puoi inserire al massimo 7 sedute in una settimana."); week.giorni.push(blankDay(this.weekIndex, week.giorni.length)); this.dayIndex = week.giorni.length - 1; this.#renumberDays(week); this.#notify(true); return; }
    if (action === "duplicate-day") { const copy = changeIds({ settimane: [{ giorni: [day] }] }).settimane[0].giorni[0]; copy.title += " (copia)"; week.giorni.splice(this.dayIndex + 1, 0, copy); this.dayIndex++; this.#renumberDays(week); this.#notify(true); return; }
    if (action === "delete-day") { if (week.giorni.length < 2) return alert("La settimana deve mantenere almeno una seduta."); if (!confirm("Eliminare questa seduta?")) return; week.giorni.splice(this.dayIndex, 1); this.dayIndex = Math.max(0, this.dayIndex - 1); this.#renumberDays(week); this.#notify(true); return; }
    if (action === "add-block") { const block = methodBlock(button.dataset.method, day.blocks.length + 1); day.blocks.push(block); this.openBlocks.clear(); this.openBlocks.add(block.id); this.#notify(true); return; }
    if (action === "set-method") { this.#convertMethod(day.blocks[bi], button.dataset.method); this.#notify(true); return; }
    if (action === "delete-block") { if (!confirm("Eliminare il blocco e le sue prescrizioni?")) return; const [removed] = day.blocks.splice(bi, 1); this.openBlocks.delete(removed?.id); day.blocks.forEach((block, index) => { block.position = index + 1; }); this.#notify(true); return; }
    if (action === "duplicate-block") { const copy = changeIds({ settimane: [{ giorni: [{ blocks: [day.blocks[bi]] }] }] }).settimane[0].giorni[0].blocks[0]; day.blocks.splice(bi + 1, 0, copy); this.openBlocks.add(copy.id); day.blocks.forEach((block, index) => { block.position = index + 1; }); this.#notify(true); return; }
    if (action === "move-block-up" || action === "move-block-down") { const target = bi + (action.endsWith("up") ? -1 : 1); if (target < 0 || target >= day.blocks.length) return; [day.blocks[bi], day.blocks[target]] = [day.blocks[target], day.blocks[bi]]; day.blocks.forEach((block, index) => { block.position = index + 1; }); this.#notify(true); return; }
    if (action === "add-exercise") { const block = day.blocks[bi], exercises = block.exercises; if (!multiExerciseMethods.has(block.method)) return; if (exercises.length >= 12) return alert("Il blocco può contenere al massimo 12 esercizi."); exercises.push(blankExercise(exercises.length + 1)); this.#notify(true); return; }
    if (action === "remove-exercise") { const block = day.blocks[bi]; if (block.exercises.length <= minimumExercises(block.method)) { alert(`Il metodo richiede almeno ${minimumExercises(block.method)} esercizi.`); return; } block.exercises.splice(ei, 1); this.#notify(true); return; }
    if (action === "add-set") {
      const block = day.blocks[bi];
      if (multiExerciseMethods.has(block.method)) {
        const round = Math.max(0, ...block.exercises.flatMap((exercise) => exercise.sets.map((set) => Number(set.round) || 0))) + 1;
        for (const exercise of block.exercises) { const previous = exercise.sets.at(-1) || blankSet(), copy = structuredClone(previous); copy.id = uid("set"); copy.position = exercise.sets.length + 1; copy.round = round; copy.parent_set_id = null; exercise.sets.push(copy); }
      } else { const exercise = block.exercises[ei], previous = exercise.sets.at(-1) || blankSet(), copy = structuredClone(previous); copy.id = uid("set"); copy.position = exercise.sets.length + 1; copy.round = copy.position; exercise.sets.push(copy); }
      this.#notify(true); return;
    }
    if (action === "delete-set") {
      const block = day.blocks[bi], exercise = block.exercises[ei];
      if (multiExerciseMethods.has(block.method)) {
        const round = exercise.sets[si]?.round;
        if (block.exercises.some((item) => item.sets.length < 2)) return alert("Mantieni almeno un giro per esercizio.");
        for (const item of block.exercises) { const index = item.sets.findIndex((set) => set.round === round); if (index >= 0) item.sets.splice(index, 1); item.sets.forEach((row, rowIndex) => { row.position = rowIndex + 1; row.round = rowIndex + 1; }); }
      } else { if (exercise.sets.length < 2) return alert("Mantieni almeno una prescrizione per esercizio."); exercise.sets.splice(si, 1); exercise.sets.forEach((row, index) => { row.position = index + 1; }); }
      this.#notify(true);
    }
  }
  #input(event) {
    const element = event.target.closest("[data-field]"); if (!element || element.tagName === "SELECT" || element.type === "checkbox") return;
    this.#setField(element); this.#notify(); this.#renderSummary();
  }
  #change(event) {
    const element = event.target.closest("[data-field]"); if (!element) return;
    if (element.dataset.field === "program.scale") { this.setScale(element.value); return; }
    if (element.dataset.field === "program.periodization") { this.program.periodizzazione = element.value; this.program.periodization = element.value; this.#notify(); return; }
    if (element.dataset.field === "exercise.name") {
      const day = this.#currentDay(), exercise = day.blocks[Number(element.dataset.b)].exercises[Number(element.dataset.e)], name = element.value.trim();
      const existing = this.program.settimane.flatMap((item) => item.giorni || []).flatMap((item) => item.blocks || []).flatMap((item) => item.exercises || []).find((item) => String(item.name || "").trim().toLocaleLowerCase() === name.toLocaleLowerCase());
      if (name && !existing && globalThis.confirm?.(`“${name}” non è nella libreria di questa scheda. Vuoi aggiungerlo come esercizio personalizzato?`) === false) { exercise.name = ""; this.render(); return; }
      this.#setField(element);
      if (existing) {
        exercise.equipment = existing.equipment || ""; exercise.primary_muscles = structuredClone(existing.primary_muscles || []); exercise.secondary_muscles = structuredClone(existing.secondary_muscles || []);
        if (!day.muscle_focus) day.muscle_focus = [...new Set([...exercise.primary_muscles, ...exercise.secondary_muscles])].join(", ");
      }
      this.#notify(true); return;
    }
    this.#setField(element); this.#notify(true);
  }
  #setField(element) {
    const week = this.program.settimane[this.weekIndex], day = this.#currentDay(), b = Number(element.dataset.b), e = Number(element.dataset.e), s = Number(element.dataset.s);
    const value = element.type === "checkbox" ? element.checked : element.value;
    switch (element.dataset.field) {
      case "week.fase": week.fase = value; break;
      case "week.dates_are_manual": week.dates_are_manual = value; if (!value) this.#automaticDates(); else if (!week.dal || !week.al) { week.dal = this.program.dal; week.al = this.program.al; } break;
      case "week.dal": week.dal = value; week.dates_are_manual = true; break;
      case "week.al": week.al = value; week.dates_are_manual = true; break;
      case "week.rule_note": week.rule_note = value.slice(0, 500); break;
      case "week.volume_target": week.volume_target = parseNumber(value); break;
      case "week.intensity_target": week.intensity_target = parseNumber(value); break;
      case "day.title": day.title = value; break;
      case "day.weekday": day.weekday = value ? Number(value) : null; day.dn = value ? ["", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"][Number(value)] : "Allenamento"; break;
      case "day.muscle_focus": day.muscle_focus = value.slice(0, 160); break;
      case "day.available_minutes": day.available_minutes = parseNumber(value); break;
      case "day.client_note": day.client_note = value.slice(0, 2000); break;
      case "day.trainer_note": day.trainer_note = value.slice(0, 2000); break;
      case "block.method": this.#convertMethod(day.blocks[b], value); break;
      case "block.rest_after_seconds": day.blocks[b].rest_after_seconds = parseNumber(value); break;
      case "block.client_note": day.blocks[b].client_note = value.slice(0, 1000); break;
      case "block.trainer_note": day.blocks[b].trainer_note = value.slice(0, 1000); break;
      case "volume.min": case "volume.max": {
        const muscle = element.dataset.muscle;
        this.program.volume_ranges ||= {};
        const range = this.program.volume_ranges[muscle] ||= { ...(DEFAULT_VOLUME_RANGES[muscle] || { min: 0, max: 0 }) };
        range[element.dataset.field.endsWith("min") ? "min" : "max"] = parseNumber(value); break;
      }
      case "exercise.name": day.blocks[b].exercises[e].name = value.slice(0, 160); break;
      case "exercise.equipment": day.blocks[b].exercises[e].equipment = value.slice(0, 100); break;
      case "exercise.primary_muscles": day.blocks[b].exercises[e].primary_muscles = value.split(",").map((part) => part.trim()).filter(Boolean).slice(0, 8); break;
      case "exercise.secondary_muscles": day.blocks[b].exercises[e].secondary_muscles = value.split(",").map((part) => part.trim()).filter(Boolean).slice(0, 8); break;
      case "exercise.instructions": day.blocks[b].exercises[e].instructions = value.slice(0, 1000); break;
      case "set.set_type": day.blocks[b].exercises[e].sets[s].set_type = value; break;
      case "set.effort_by_feel": day.blocks[b].exercises[e].sets[s].effort_by_feel = Boolean(value); break;
      case "set.reps": { const valid = parseReps(value, day.blocks[b].exercises[e].sets[s]); element.classList.toggle("invalid", !valid); element.setAttribute("aria-invalid", String(!valid)); break; }
      case "set.load": parseLoad(value, day.blocks[b].exercises[e].sets[s]); break;
      case "set.intensity": { const n = parseNumber(value); day.blocks[b].exercises[e].sets[s].target_rir = n == null ? null : this.scale === "RPE" ? 10 - n : n; break; }
      case "set.tempo": day.blocks[b].exercises[e].sets[s].tempo = value.trim() || null; break;
      case "set.rest_seconds": day.blocks[b].exercises[e].sets[s].rest_seconds = parseSeconds(value); element.classList.toggle("invalid", Number.isNaN(day.blocks[b].exercises[e].sets[s].rest_seconds)); break;
    }
    this.program.schemaVersion = 2;
  }
  #convertMethod(block, method) {
    if (block.method === method) return;
    const existing = block.exercises || [];
    const extras = existing.flatMap((exercise) => exercise.sets || []).filter((row) => ["drop", "mini_set", "cluster_group"].includes(row.set_type));
    const lostExercises = Math.max(0, existing.length - maximumExercises(method));
    const structuredMethods = new Set(["drop_set", "rest_pause", "cluster", "myo_reps", "top_back_off"]);
    const structuredChange = structuredMethods.has(block.method) || structuredMethods.has(method);
    const hasPrescription = existing.some((exercise) => (exercise.sets || []).some((set) => set.reps_min != null || set.reps_max != null || set.load_value != null || set.target_rir != null || set.tempo || set.rest_seconds != null));
    const resetRows = structuredChange;
    const confirmResetRows = resetRows && hasPrescription;
    if ((extras.length || lostExercises || confirmResetRows) && globalThis.confirm?.(`Il cambio ${block.method} → ${method} ${lostExercises ? `rimuoverà ${lostExercises} esercizi` : ""}${lostExercises && confirmResetRows ? " e " : ""}${confirmResetRows ? "ricreerà le righe secondo il nuovo metodo, azzerando le prescrizioni" : ""}${extras.length && !confirmResetRows ? " e rimuoverà le righe speciali" : ""}. Continuare?`) === false) { this.render(); return; }
    const replacement = methodBlock(method, block.position);
    const keepCount = Math.min(existing.length, maximumExercises(method));
    const targetCount = Math.max(minimumExercises(method), keepCount);
    const templates = replacement.exercises;
    replacement.exercises = Array.from({ length: targetCount }, (_, index) => {
      const previous = existing[index], template = templates[index] || blankExercise(index + 1);
      if (!previous) return { ...template, position: index + 1 };
      const sets = resetRows ? template.sets : previous.sets;
      return { ...previous, position: index + 1, sets };
    });
    Object.assign(block, replacement);
  }
}

export { methodNames, typeNames };
