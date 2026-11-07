const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RX = /^[A-Za-z0-9_-]{8,128}$/;

export function cleanText(value, max = 120) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function validateCreateClient(input = {}) {
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 60);
  const email = cleanText(input.email, 254).toLowerCase();
  const password = String(input.password ?? "");
  const idempotencyKey = cleanText(input.idempotencyKey, 80);
  if (!firstName || !lastName) throw new Error("Nome e cognome sono obbligatori.");
  if (!EMAIL_RX.test(email)) throw new Error("Email non valida.");
  if (password.length < 12 || password.length > 128) throw new Error("La password deve avere tra 12 e 128 caratteri.");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) throw new Error("La password deve includere maiuscola, minuscola e numero.");
  if (!ID_RX.test(idempotencyKey)) throw new Error("Identificativo richiesta non valido.");
  return { firstName, lastName, email, password, idempotencyKey };
}

export function validateProgram(program = {}) {
  const name = cleanText(program.name || program.nome, 120);
  const startDate = cleanText(program.startDate || program.dal, 10);
  const endDate = cleanText(program.endDate || program.al, 10);
  const weeks = program.weeks || program.settimane;
  if (!name) throw new Error("Il nome della scheda è obbligatorio.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) throw new Error("Il periodo della scheda non è valido.");
  if (!Array.isArray(weeks) || weeks.length < 1 || weeks.length > 52) throw new Error("La scheda deve contenere da 1 a 52 settimane.");
  const normalizedWeeks = weeks.map((week, wi) => {
    const days = week.days || week.giorni;
    if (!Array.isArray(days) || days.length < 1 || days.length > 7) throw new Error(`Settimana ${wi + 1}: giorni non validi.`);
    return { ...week, n: Number(week.n || wi + 1), giorni: days.map((day, di) => {
      const exercises = day.exercises || day.esercizi;
      if (!Array.isArray(exercises) || exercises.length < 1 || exercises.length > 40) throw new Error(`Settimana ${wi + 1}, giorno ${di + 1}: esercizi non validi.`);
      return { ...day, titolo: cleanText(day.title || day.titolo || `Giorno ${di + 1}`, 120), esercizi: exercises.map((exercise, ei) => {
        const exerciseName = cleanText(exercise.name || exercise.nome, 160);
        if (!exerciseName) throw new Error(`Settimana ${wi + 1}, giorno ${di + 1}, esercizio ${ei + 1}: nome mancante.`);
        const sets = Number(exercise.sets ?? exercise.serie ?? 0);
        if (!Number.isFinite(sets) || sets < 1 || sets > 20) throw new Error(`${exerciseName}: numero di serie non valido.`);
        return { ...exercise, nome: exerciseName, serie: sets, reps: cleanText(exercise.reps ?? exercise.ripetizioni, 80), rec: cleanText(exercise.rec ?? exercise.recupero, 40), note: cleanText(exercise.note, 1000) };
      }) };
    }) };
  });
  return { ...program, nome: name, dal: startDate, al: endDate, settimane: normalizedWeeks };
}

export function validateId(value, label = "ID") {
  const id = cleanText(value, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`${label} non valido.`);
  return id;
}
