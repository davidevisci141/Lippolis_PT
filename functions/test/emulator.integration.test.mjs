import test from "node:test";
import assert from "node:assert/strict";

const projectId = "demo-lippolis-pt";
const authBase = "http://127.0.0.1:9099";
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const functionsBase = `http://127.0.0.1:5001/${projectId}/europe-west1`;
const ownerHeaders = { Authorization: "Bearer owner", "Content-Type": "application/json" };

function valueOf(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(valueOf) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  return { mapValue: { fields: fieldsOf(value) } };
}

function fieldsOf(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, valueOf(value)]));
}

function fromValue(value = {}) {
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(fromValue);
  if (value.mapValue) return fromFields(value.mapValue.fields || {});
  return undefined;
}

function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromValue(value)]));
}

async function jsonRequest(url, options = {}, expected = [200]) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!expected.includes(response.status)) {
    const error = new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status; error.body = body; throw error;
  }
  return { status: response.status, body };
}

async function authCall(method, data) {
  return (await jsonRequest(`${authBase}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=fake-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  })).body;
}

async function signUp(email, password) {
  return authCall("signUp", { email, password, returnSecureToken: true });
}

async function signIn(email, password) {
  return authCall("signInWithPassword", { email, password, returnSecureToken: true });
}

async function verifyEmail(email, idToken) {
  await authCall("sendOobCode", { requestType: "VERIFY_EMAIL", idToken });
  const result = await jsonRequest(`${authBase}/emulator/v1/projects/${projectId}/oobCodes`);
  const codes = result.body?.oobCodes || [];
  const code = codes.filter((item) => item.email === email && item.requestType === "VERIFY_EMAIL").at(-1);
  assert.ok(code?.oobCode, `Codice verifica non trovato per ${email}`);
  await authCall("update", { oobCode: code.oobCode });
}

async function callable(name, token, data = {}) {
  const result = await jsonRequest(`${functionsBase}/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
  if (result.body?.error) {
    const error = new Error(result.body.error.message || name);
    error.code = result.body.error.status; throw error;
  }
  return result.body?.result ?? result.body?.data;
}

function documentName(path) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

async function adminSet(path, data) {
  return jsonRequest(`${firestoreBase}/${path}`, {
    method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ fields: fieldsOf(data) })
  });
}

async function adminPatch(path, data) {
  const masks = Object.keys(data).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  return jsonRequest(`${firestoreBase}/${path}?${masks}`, {
    method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ fields: fieldsOf(data) })
  });
}

async function getDocument(path, token = "owner", expected = [200]) {
  return jsonRequest(`${firestoreBase}/${path}`, { headers: { Authorization: `Bearer ${token}` } }, expected);
}

async function listCollection(path, token = "owner") {
  const result = await jsonRequest(`${firestoreBase}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return result.body?.documents || [];
}

async function clientSetWithServerTime(path, data, token) {
  const result = await jsonRequest(`${firestoreBase}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: { name: documentName(path), fields: fieldsOf(data) },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]
    })
  });
  return result.body;
}

async function clientPatch(path, data, token, expected = [200]) {
  const masks = Object.keys(data).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  return jsonRequest(`${firestoreBase}/${path}?${masks}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fieldsOf(data) })
  }, expected);
}

function sampleProgram(name) {
  return {
    nome: name, dal: "2026-11-10", al: "2026-12-10",
    settimane: [{ n: 1, giorni: [{ titolo: "Giorno A", esercizi: [{ nome: "Squat", serie: 3, reps: "8-10", rec: "90", note: "Tecnica controllata" }] }] }]
  };
}

test("flusso completo PT e due clienti negli emulatori", { timeout: 120000 }, async () => {
  await jsonRequest(`${authBase}/emulator/v1/projects/${projectId}/accounts`, { method: "DELETE" }, [200]);
  await jsonRequest(`http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" }, [200]);

  const coachSignup = await signUp("coach@example.com", "CoachPassword7!");
  await verifyEmail("coach@example.com", coachSignup.idToken);
  const coachLogin = await signIn("coach@example.com", "CoachPassword7!");
  await adminSet(`profiles/${coachLogin.localId}`, {
    firstName: "Coach", lastName: "Test", displayName: "Coach Test", email: "coach@example.com",
    role: "coach", status: "active", onboardingComplete: true, createdAt: new Date()
  });

  const aliceRequest = {
    firstName: "Alice", lastName: "Test", email: "alice@example.com",
    password: "PasswordIniziale7!", idempotencyKey: "create-alice-0001"
  };
  const alice = await callable("createClient", coachLogin.idToken, aliceRequest);
  const aliceRetry = await callable("createClient", coachLogin.idToken, aliceRequest);
  assert.equal(alice.uid, aliceRetry.uid, "la creazione deve essere idempotente");
  assert.equal(coachLogin.localId, coachSignup.localId, "la sessione del PT non deve cambiare");
  const aliceProfile = await getDocument(`profiles/${alice.uid}`);
  assert.equal(fromFields(aliceProfile.body.fields).trainerId, coachLogin.localId);
  await assert.rejects(
    callable("createClient", coachLogin.idToken, { ...aliceRequest, idempotencyKey: "create-alice-0002" }),
    /Esiste già|ALREADY_EXISTS|already/i
  );

  const bob = await callable("createClient", coachLogin.idToken, {
    firstName: "Bob", lastName: "Test", email: "bob@example.com",
    password: "PasswordIniziale7!", idempotencyKey: "create-bob-000001"
  });

  const aliceInitial = await signIn("alice@example.com", "PasswordIniziale7!");
  await verifyEmail("alice@example.com", aliceInitial.idToken);
  const aliceVerified = await signIn("alice@example.com", "PasswordIniziale7!");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const alicePassword = await authCall("update", { idToken: aliceVerified.idToken, password: "PasswordPersonale8!", returnSecureToken: true });
  await callable("completeOnboarding", alicePassword.idToken, {});
  const completedProfile = fromFields((await getDocument(`profiles/${alice.uid}`)).body.fields);
  assert.equal(completedProfile.onboardingComplete, true);

  const bobInitial = await signIn("bob@example.com", "PasswordIniziale7!");
  await verifyEmail("bob@example.com", bobInitial.idToken);
  const bobVerified = await signIn("bob@example.com", "PasswordIniziale7!");
  await adminPatch(`profiles/${bob.uid}`, { onboardingComplete: true });

  await clientSetWithServerTime(`profiles/${alice.uid}/state/app`, {
    uid: alice.uid, revision: 1, snapshot: { sessioni: [], pesi: [], giornate: {} }
  }, alicePassword.idToken);
  await clientSetWithServerTime(`profiles/${bob.uid}/state/app`, {
    uid: bob.uid, revision: 1, snapshot: { sessioni: [], pesi: [], giornate: {} }
  }, bobVerified.idToken);
  assert.equal((await getDocument(`profiles/${alice.uid}/state/app`, alicePassword.idToken)).status, 200);
  assert.equal((await getDocument(`profiles/${bob.uid}/state/app`, alicePassword.idToken, [403])).status, 403);
  assert.equal((await clientPatch(`profiles/${alice.uid}`, { role: "coach" }, alicePassword.idToken, [403])).status, 403);
  assert.equal((await clientPatch(`profiles/${alice.uid}`, { trainerId: alice.uid }, alicePassword.idToken, [403])).status, 403);

  const draft1 = await callable("saveProgramDraft", coachLogin.idToken, { clientUid: alice.uid, expectedRevision: 0, program: sampleProgram("Scheda 1") });
  const published1 = await callable("publishProgram", coachLogin.idToken, { clientUid: alice.uid, draftId: draft1.draftId, expectedRevision: draft1.revision });
  const current1 = fromFields((await getDocument(`profiles/${alice.uid}/program/current`, alicePassword.idToken)).body.fields);
  assert.equal(current1.versionId, published1.versionId, "il cliente deve vedere la scheda pubblicata");

  await clientSetWithServerTime(`profiles/${alice.uid}/state/app`, {
    uid: alice.uid, revision: 2,
    snapshot: {
      sessioni: [{ id: "s1", ts: Date.now(), titolo: "Giorno A", programVersionId: published1.versionId, esercizi: [{ nome: "Squat", sets: [{ kg: 80, reps: 8, rir: 2 }] }] }],
      pesi: [{ id: "p1", ts: Date.now(), v: 75.5 }], giornate: { "2026-11-07": { energia: 4, doms: 2 } }
    }
  }, alicePassword.idToken);
  const coachRead = fromFields((await getDocument(`profiles/${alice.uid}/state/app`, coachLogin.idToken)).body.fields);
  assert.equal(coachRead.snapshot.pesi[0].v, 75.5, "il peso corporeo deve restare distinto dai carichi");
  assert.equal(coachRead.snapshot.sessioni[0].esercizi[0].sets[0].kg, 80);

  const draft2 = await callable("saveProgramDraft", coachLogin.idToken, { clientUid: alice.uid, expectedRevision: 0, program: sampleProgram("Scheda 2") });
  await callable("publishProgram", coachLogin.idToken, { clientUid: alice.uid, draftId: draft2.draftId, expectedRevision: draft2.revision });
  const versions = await listCollection(`profiles/${alice.uid}/programVersions`, coachLogin.idToken);
  assert.equal(versions.length, 1, "la versione precedente deve essere archiviata");
  const stateAfterPublish = fromFields((await getDocument(`profiles/${alice.uid}/state/app`, coachLogin.idToken)).body.fields);
  assert.equal(stateAfterPublish.snapshot.sessioni[0].programVersionId, published1.versionId, "lo storico non deve cambiare retroattivamente");

  await callable("setClientAccess", coachLogin.idToken, { clientUid: alice.uid, action: "suspend" });
  assert.equal((await getDocument(`profiles/${alice.uid}/state/app`, alicePassword.idToken, [403])).status, 403, "la sospensione deve bloccare un token già emesso");
  await callable("setClientAccess", coachLogin.idToken, { clientUid: alice.uid, action: "reactivate" });
  const aliceAgain = await signIn("alice@example.com", "PasswordPersonale8!");
  assert.equal((await getDocument(`profiles/${alice.uid}/state/app`, aliceAgain.idToken)).status, 200);

  await adminSet(`profiles/${bob.uid}/messages/m1`, { marker: true });
  await callable("deleteClient", coachLogin.idToken, { clientUid: bob.uid, confirmationEmail: "bob@example.com" });
  await assert.rejects(
    signIn("bob@example.com", "PasswordIniziale7!"),
    /EMAIL_NOT_FOUND|USER_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/i,
    "Auth del cliente deve essere eliminato"
  );
  assert.equal((await getDocument(`profiles/${bob.uid}`, "owner", [404])).status, 404, "profilo e sottocollezioni devono essere eliminati");
  assert.equal((await getDocument(`profiles/${coachLogin.localId}`)).status, 200, "il PT non deve essere coinvolto");
});
