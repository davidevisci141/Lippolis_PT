import { convertLegacyProgram, validateV2Program } from "./workout-metrics.mjs";
import { parseExerciseVideo } from "./exercise-video.mjs";

const clone = (value) => structuredClone(value);
const clean = (value) => String(value ?? "").trim();
const secs = (value) => {
  const parts = clean(value).split(":").map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
};
const textReps = (s) => s?.reps_mode === "amrap" ? "AMRAP" : s?.reps_mode === "time" ? `${Math.floor((s.reps_min || 0) / 60)}:${String((s.reps_min || 0) % 60).padStart(2, "0")}` : s?.reps_min == null ? "" : s.reps_max !== s.reps_min ? `${s.reps_min}-${s.reps_max}` : String(s.reps_min);
const textLoad = (s) => s?.load_unit === "bodyweight" ? "PC" : s?.load_note || (s?.load_value != null ? String(s.load_value) + (String(s.load_unit).startsWith("percent") ? "%" : "") : "");

export function mockupToProgram(template, dates) {
  const { dal, al } = dates;
  const weeks = template.weeks || [];
  const program = convertLegacyProgram({
    nome: clean(template.nome), dal, al,
    settimane: weeks.map((week, wi) => ({
      n: wi + 1, fase: clean(week.nome),
      giorni: (week.giorni || []).map((day) => ({
        titolo: clean(day.nome), dt: clean(day.giorno), giorno_settimana: Number(day.giorno) || null,
        esercizi: (day.esercizi || []).map((exercise) => ({
          nome: clean(exercise.nome), serie: Number(exercise.serie),
          reps: exercise.tipo === "tempo" ? (secs(exercise.rip) > 0 ? `${secs(exercise.rip)}s` : "") : clean(exercise.rip),
          rec: clean(exercise.rec), rir: clean(exercise.rir), tempo: clean(exercise.tut),
          carico: clean(exercise.carico), muscolo: clean(exercise.muscolo), note: clean(exercise.note),
          video_ref: clean(exercise.video), instructions: clean(exercise.descrizione), videoStoragePath: clean(exercise.videoStoragePath)
        }))
      }))
    }))
  });
  delete program.legacyBackup;
  program.legacyFields = { mockupId: template.id || null, livello: clean(template.livello), tipologia: clean(template.tipologia), descrizione: clean(template.descrizione) };
  weeks.forEach((week, wi) => (week.giorni || []).forEach((day, di) => {
    const target = program.settimane[wi].giorni[di];
    target.weekday = Number(day.giorno) || null;
    const inputs = day.esercizi || [];
    const blocks = [];
    for (let i = 0; i < inputs.length; i++) {
      const original = inputs[i], block = target.blocks[i], exercise = block.exercises[0];
      if (!clean(original.nome) || !Number.isInteger(Number(original.serie)) || Number(original.serie)<1 || Number(original.serie)>100) throw new Error(`Settimana ${wi+1}, ${day.nome}: inserisci nome e numero di serie per ogni esercizio.`);
      exercise.instructions = clean(original.descrizione);
      exercise.video_ref = clean(original.video) || null;
      if (exercise.video_ref && !parseExerciseVideo(exercise.video_ref)) throw new Error(`Video non valido: ${original.nome}`);
      exercise.legacyFields = { videoStoragePath: clean(original.videoStoragePath), alternativa: original.link === "alternativa" };
      if (original._advanced?.sets && original._advanced.signature === exerciseSignature(original)) exercise.sets = clone(original._advanced.sets);
      else exercise.sets.forEach((set) => { set.effort_by_feel = !clean(original.carico); set.client_note = ""; });
      if (original.link === "superserie" && blocks.length) {
        const previous = blocks.at(-1);
        previous.method = original._advanced?.method==="circuit" ? "circuit" : previous.exercises.length>=2 ? "giant_set" : "superset";
        exercise.position = previous.exercises.length + 1; previous.exercises.push(exercise);
      } else {
        block.position = blocks.length + 1;
        if (original._advanced?.method && !["superset","giant_set","circuit"].includes(original._advanced.method)) block.method = original._advanced.method;
        blocks.push(block);
      }
    }
    target.blocks = blocks;
  }));
  const checked = validateV2Program(program,{forPublish:true});
  if (!checked.valid) throw new Error(checked.errors[0]?.message || "Controlla date e prescrizioni.");
  return checked.program;
}

function exerciseSignature(e) { return JSON.stringify([e.serie,e.tipo,e.rip,e.rec,e.rir,e.tut,e.carico]); }

export function programToMockup(input, id) {
  const program=convertLegacyProgram(input);
  const weeks=program.settimane.map((week, i)=>({
    nome: clean(week.fase) || `Settimana ${i+1}`,
    giorni: week.giorni.map((day, di)=>({
      nome: day.title || `Allenamento ${di+1}`, giorno: String(day.weekday || ((di%7)+1)),
      esercizi: day.blocks.flatMap((block)=>block.exercises.map((exercise, ei)=>{
        const first=exercise.sets.find(s=>s.set_type!=="warmup") || exercise.sets[0];
        const item={ nome:exercise.name, muscolo:(exercise.primary_muscles||[]).join(" · "), serie:String(exercise.sets.length),
          tipo:first?.reps_mode==="time"?"tempo":"ripetizioni", rip:textReps(first),
          rec:first?.rest_seconds==null?"":`${String(Math.floor(first.rest_seconds/60)).padStart(2,"0")}:${String(first.rest_seconds%60).padStart(2,"0")}`,
          rir:first?.target_rir==null?"":String(first.target_rir), tut:first?.tempo||"", carico:textLoad(first), note:block.client_note || first?.client_note || "",
          descrizione:exercise.instructions||"", video:exercise.video_ref||"", videoStoragePath:exercise.legacyFields?.videoStoragePath||"",
          link:exercise.legacyFields?.alternativa?"alternativa":ei?"superserie":undefined };
        item._advanced={sets:clone(exercise.sets),method:block.method,signature:exerciseSignature(item)};
        return item;
      }))
    }))
  }));
  return {id:id||crypto.randomUUID(),nome:program.nome,livello:program.legacyFields?.livello||"",tipologia:program.legacyFields?.tipologia||"",descrizione:program.legacyFields?.descrizione||"",dal:program.dal,al:program.al,weeks:weeks.length?weeks:[{nome:"Settimana 1",giorni:[]}],viewMode:"col",clienti:0};
}

export function nutritionSummary(plan) {
  return {
    title: clean(plan.nome).slice(0,120),
    notes: clean(plan.descrizione).slice(0,4000),
    meals: (plan.giorni || []).slice(0,12).map((day,index)=>({
      label:(clean(day.nome)||`Giorno ${index+1}`).slice(0,80),
      text:[clean(day.note),...(day.pasti||[]).map(meal=>`${clean(meal.tipo)}: ${(meal.items||[]).map(item=>[clean(item.nome),item.g?`${item.g} g`:""].filter(Boolean).join(" ")).join(", ")}`)].filter(Boolean).join("\n").slice(0,2000)
    })).filter(item=>item.text)
  };
}
