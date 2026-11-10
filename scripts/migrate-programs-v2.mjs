import { convertImportedProgram } from "../www/src/workout-metrics.mjs";

const baseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const apply = process.argv.includes("--apply");
if (!baseUrl || !serviceKey) {
  console.error("Definisci SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nell’ambiente prima di eseguire lo script.");
  process.exit(2);
}

const tables = [
  { name: "programs", key: "athlete_id" },
  { name: "program_versions", key: "id" },
  { name: "program_drafts", key: "id" }
];
const totals = { scanned: 0, converted: 0, unchanged: 0, errors: 0, warnings: 0 };
const canonicalJson = (value) => Array.isArray(value) ? value.map(canonicalJson)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])) : value;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

for (const table of tables) {
  let offset = 0;
  while (true) {
    const rows = await request(`${table.name}?select=${table.key},program`, {
      headers: { Range: `${offset}-${offset + 499}`, "Range-Unit": "items" }
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    totals.scanned += rows.length;
    for (const row of rows) {
      try {
        const result = convertImportedProgram(row.program || {});
        totals.warnings += result.warnings.length;
        if (!result.valid) {
          totals.errors++;
          console.error(`${table.name}: record non convertito (${result.errors[0]?.path || "programma"})`);
          continue;
        }
        const next = result.program;
        if (JSON.stringify(canonicalJson(next)) === JSON.stringify(canonicalJson(row.program))) { totals.unchanged++; continue; }
        totals.converted++;
        if (!apply) continue;
        const filter = new URLSearchParams({ [table.key]: `eq.${row[table.key]}` });
        await request(`${table.name}?${filter}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ program: next }) });
      } catch (error) {
        totals.errors++;
        console.error(`${table.name}: errore durante la conversione (${error instanceof Error ? error.message : "errore sconosciuto"})`);
      }
    }
    if (rows.length < 500) break;
    offset += rows.length;
  }
}

console.log(`${apply ? "Migrazione applicata" : "Anteprima (nessuna scrittura)"}: ${totals.scanned} record letti, ${totals.converted} da convertire, ${totals.unchanged} già aggiornati, ${totals.warnings} avvisi, ${totals.errors} errori.`);
if (!apply && totals.converted) console.log("Per scrivere le modifiche, ripeti il comando aggiungendo --apply. Ogni originale resta in legacyBackup.");
if (totals.errors) process.exitCode = 1;
