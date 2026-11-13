import { supabase } from "./supabase.mjs";

const defaultPlan = () => ({ title: "Consigli alimentari", notes: "", meals: [] });
const blankMeal = () => ({ label: "", text: "" });
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function mountCoachNutrition(root) {
  let uid = null, plan = defaultPlan(), draft = null, published = null, epoch = 0, busy = false, dirty = false, message = "", failed = false;
  const unsaved = new Map();
  function draw() {
    if (!uid) { root.replaceChildren(); return; }
    const publishedLine = published
      ? `Versione ${Number(published.revision)} visibile al cliente in “Consigli alimentari”.`
      : "Il cliente non ha ancora indicazioni pubblicate.";
    root.innerHTML = `<section class="card">
      <h3>Consigli alimentari</h3><p class="sub">${publishedLine} La bozza resta nel pannello PT.</p>
      <form id="nutritionForm"><fieldset ${busy || failed ? "disabled" : ""} style="display:grid;gap:12px;border:0;padding:0;min-width:0;margin:0">
        <label>Titolo<input class="field" name="title" maxlength="120" required value="${esc(plan.title)}"></label>
        <label>Indicazioni generali<textarea class="field" name="notes" rows="4" maxlength="4000">${esc(plan.notes)}</textarea></label>
        <div>${plan.meals.map((meal, index) => `<div class="rowcard" style="margin-bottom:8px;display:grid;gap:8px">
          <label>Nome del pasto<input class="field" data-meal="${index}" data-key="label" required maxlength="80" value="${esc(meal.label)}" placeholder="Es. Colazione"></label>
          <label>Indicazioni<textarea class="field" data-meal="${index}" data-key="text" rows="3" required maxlength="2000">${esc(meal.text)}</textarea></label>
          <div><button type="button" class="secondary" data-remove-meal="${index}">Rimuovi pasto</button></div></div>`).join("")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="secondary" data-add-meal ${plan.meals.length >= 12 ? "disabled" : ""}>+ Aggiungi pasto</button>
          <button type="submit" class="secondary" value="draft">Salva bozza</button>
          <button type="submit" class="primary" value="publish">Pubblica per il cliente</button>
        </div>
      </fieldset></form>
      <p class="sub" data-nutrition-message role="status" aria-live="polite">${esc(message || (dirty ? "Modifiche da salvare." : ""))}</p>
      ${failed ? '<button type="button" class="secondary" data-retry-nutrition>Ricarica dal database</button>' : ""}
    </section>`;
  }
  async function load(id) {
    const current = ++epoch;
    uid = id || null; plan = defaultPlan(); draft = null; published = null; busy = !!uid; dirty = false; failed = false; message = busy ? "Caricamento dal database…" : "";
    draw();
    if (!id) return;
    try {
      const { data, error } = await supabase.from("nutrition_plans").select("status, revision, plan").eq("athlete_id", id);
      if (error) throw error;
      if (current !== epoch) return;
      draft = data.find((row) => row.status === "draft") || null;
      published = data.find((row) => row.status === "published") || null;
      const saved = unsaved.get(id);
      if (saved && Number(draft?.revision || 0) === saved.revision) { plan = saved.plan; dirty = true; }
      else {
        if (saved) unsaved.delete(id);
        plan = structuredClone(draft?.plan || published?.plan || defaultPlan());
      }
      message = saved && !dirty ? "La bozza nel database è cambiata. È stata caricata la revisione più recente." : "";
    } catch {
      if (current !== epoch) return;
      message = "Non riesco a leggere i consigli alimentari dal database. Riprova.";
      failed = true;
    } finally {
      if (current === epoch) { busy = false; draw(); }
    }
  }
  function markDirty() {
    dirty = true;
    unsaved.set(uid, { revision: Number(draft?.revision || 0), plan: structuredClone(plan) });
    const status = root.querySelector("[data-nutrition-message]");
    if (status) status.textContent = "Modifiche da salvare.";
  }
  root.addEventListener("input", (event) => {
    const field = event.target;
    if (field.dataset.meal != null) plan.meals[Number(field.dataset.meal)][field.dataset.key] = field.value;
    else if (["title", "notes"].includes(field.name)) plan[field.name] = field.value;
    else return;
    markDirty();
  });
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    if (button.hasAttribute("data-retry-nutrition")) { void load(uid); return; }
    if (button.hasAttribute("data-add-meal") && plan.meals.length < 12) {
      plan.meals.push(blankMeal()); markDirty(); draw(); root.querySelector(`[data-meal="${plan.meals.length - 1}"]`)?.focus();
    } else if (button.dataset.removeMeal != null) {
      plan.meals.splice(Number(button.dataset.removeMeal), 1); markDirty(); draw();
    }
  });
  root.addEventListener("submit", async (event) => {
    if (event.target.id !== "nutritionForm") return;
    event.preventDefault();
    if (!uid || busy || failed) return;
    const publish = event.submitter?.value === "publish", id = uid, current = epoch;
    const clean = { title: plan.title.trim(), notes: plan.notes.trim(), meals: plan.meals.map(({ label, text }) => ({ label: label.trim(), text: text.trim() })) };
    if (!clean.title || clean.meals.some((item) => !item.label || !item.text) || (publish && !clean.notes && !clean.meals.length)) {
      message = "Inserisci un titolo e completa i pasti. Per pubblicare serve almeno un consiglio o un pasto."; draw(); return;
    }
    busy = true; message = publish ? "Pubblicazione in corso…" : "Salvataggio in corso…"; draw();
    try {
      const { data, error } = await supabase.rpc("save_client_nutrition", {
        p_athlete_id: id, p_expected_revision: Number(draft?.revision || 0), p_plan: clean, p_publish: publish
      });
      if (error) throw error;
      unsaved.delete(id);
      if (current !== epoch) return;
      plan = clean; draft = { revision: data.draftRevision, plan: clean }; dirty = false;
      if (publish) published = { revision: data.publishedRevision, plan: clean };
      message = publish ? "Indicazioni pubblicate per il cliente." : "Bozza salvata nel database.";
    } catch (error) {
      if (current !== epoch) return;
      if (error.code === "40001") { failed = true; message = "La bozza è stata aggiornata altrove. Ricaricala dal database."; }
      else message = "Salvataggio non riuscito. Riprova.";
    } finally {
      if (current === epoch) { busy = false; draw(); }
    }
  });
  return { select(id) { if ((id || null) !== uid) void load(id); } };
}
