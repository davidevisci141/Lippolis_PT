"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore, Timestamp } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { logger } = require("firebase-functions");
const { cleanText, validateCreateClient, validateId, validateProgram } = require("./lib/validation");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 4, timeoutSeconds: 120, memory: "256MiB" });

const db = getFirestore();
const adminAuth = getAuth();

function callableOptions(extra = {}) {
  return { enforceAppCheck: false, consumeAppCheckToken: false, ...extra };
}

function invalidArgument(error) {
  if (error instanceof HttpsError) throw error;
  throw new HttpsError("invalid-argument", error.message || "Parametri non validi.");
}

async function getPasswordUpdatedAt(request) {
  const authorization = request.rawRequest?.headers?.authorization || "";
  const idToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!idToken) throw new HttpsError("unauthenticated", "Token di accesso mancante.");

  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const apiKey = emulatorHost ? "fake-api-key" : process.env.IDENTITY_TOOLKIT_API_KEY;
  if (!apiKey) {
    logger.error("IDENTITY_TOOLKIT_API_KEY non configurata per il controllo onboarding.");
    throw new HttpsError("failed-precondition", "Configurazione Firebase Auth incompleta.");
  }
  const baseUrl = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com/v1`
    : "https://identitytoolkit.googleapis.com/v1";
  const response = await fetch(`${baseUrl}/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!response.ok) {
    logger.error("Controllo passwordUpdatedAt fallito.", { status: response.status });
    throw new HttpsError("internal", "Impossibile verificare l’aggiornamento della password.");
  }
  const payload = await response.json();
  return Number(payload.users?.[0]?.passwordUpdatedAt);
}

async function requireActor(request, role = "coach") {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const ref = db.doc(`profiles/${request.auth.uid}`);
  const snap = await ref.get();
  const profile = snap.data();
  if (!snap.exists || profile.role !== role || profile.status !== "active") {
    throw new HttpsError("permission-denied", "Account non autorizzato.");
  }
  if (request.auth.token.email_verified !== true) {
    throw new HttpsError("failed-precondition", "Verifica l’indirizzo email.");
  }
  return { uid: request.auth.uid, profile, ref };
}

async function requireOwnedAthlete(coachUid, clientUid) {
  const uid = validateId(clientUid, "UID cliente");
  if (uid === coachUid) throw new HttpsError("permission-denied", "Non puoi selezionare il tuo account.");
  const ref = db.doc(`profiles/${uid}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get("role") !== "athlete" || snap.get("trainerId") !== coachUid) {
    throw new HttpsError("permission-denied", "Cliente non assegnato a questo PT.");
  }
  return { uid, ref, snap, profile: snap.data() };
}

exports.createClient = onCall(callableOptions(), async (request) => {
  const coach = await requireActor(request);
  let data;
  try { data = validateCreateClient(request.data); } catch (error) { invalidArgument(error); }
  const opId = `${coach.uid}_create_${data.idempotencyKey}`;
  const opRef = db.doc(`adminOperations/${opId}`);
  let operation;

  await db.runTransaction(async (tx) => {
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      operation = opSnap.data();
      return;
    }
    operation = { type: "createClient", status: "reserved", coachId: coach.uid, email: data.email };
    tx.create(opRef, { ...operation, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });

  if (operation.status === "completed") return { uid: operation.targetUid, email: operation.email, reused: true };
  if (operation.coachId !== coach.uid || operation.email !== data.email) {
    throw new HttpsError("already-exists", "Identificativo richiesta già utilizzato.");
  }

  let userRecord = null;
  if (operation.targetUid) {
    try { userRecord = await adminAuth.getUser(operation.targetUid); } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }

  if (!userRecord) {
    try {
      const existing = await adminAuth.getUserByEmail(data.email);
      const key = existing.customClaims?.provisioningOperation;
      if (key !== opId) throw new HttpsError("already-exists", "Esiste già un account con questa email.");
      userRecord = existing;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error.code !== "auth/user-not-found") throw error;
    }
  }

  if (!userRecord) {
    userRecord = await adminAuth.createUser({
      email: data.email,
      emailVerified: false,
      password: data.password,
      displayName: `${data.firstName} ${data.lastName}`,
      disabled: true
    });
    await adminAuth.setCustomUserClaims(userRecord.uid, { provisioningOperation: opId });
    await opRef.set({ targetUid: userRecord.uid, status: "auth-created", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  const baseline = Date.parse(userRecord.metadata.passwordUpdatedAt || userRecord.metadata.creationTime || new Date().toISOString());
  const profileRef = db.doc(`profiles/${userRecord.uid}`);
  const existingProfile = await profileRef.get();
  if (existingProfile.exists && (existingProfile.get("role") !== "athlete" || existingProfile.get("trainerId") !== coach.uid)) {
    throw new HttpsError("already-exists", "L’account esistente appartiene a un altro profilo.");
  }

  await profileRef.set({
    firstName: data.firstName,
    lastName: data.lastName,
    displayName: `${data.firstName} ${data.lastName}`,
    email: data.email,
    role: "athlete",
    trainerId: coach.uid,
    status: "active",
    onboardingComplete: false,
    passwordBaselineAt: Number.isFinite(baseline) ? baseline : Date.now(),
    createdAt: existingProfile.exists && existingProfile.get("createdAt")
      ? existingProfile.get("createdAt")
      : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await adminAuth.updateUser(userRecord.uid, { disabled: false });
  await adminAuth.setCustomUserClaims(userRecord.uid, { role: "athlete" });
  await opRef.set({ status: "completed", targetUid: userRecord.uid, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { uid: userRecord.uid, email: data.email, firstName: data.firstName, lastName: data.lastName };
});

exports.completeOnboarding = onCall(callableOptions(), async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const ref = db.doc(`profiles/${request.auth.uid}`);
  const snap = await ref.get();
  const profile = snap.data();
  if (!snap.exists || profile.role !== "athlete" || profile.status !== "active") {
    throw new HttpsError("permission-denied", "Profilo cliente non autorizzato.");
  }
  const user = await adminAuth.getUser(request.auth.uid);
  if (!user.emailVerified) throw new HttpsError("failed-precondition", "Email non verificata.");
  const changedAt = await getPasswordUpdatedAt(request);
  if (!Number.isFinite(changedAt) || changedAt <= Number(profile.passwordBaselineAt || 0)) {
    throw new HttpsError("failed-precondition", "La password personale non risulta aggiornata.");
  }
  await ref.update({ onboardingComplete: true, onboardingCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { completed: true };
});

exports.setClientAccess = onCall(callableOptions(), async (request) => {
  const coach = await requireActor(request);
  const target = await requireOwnedAthlete(coach.uid, request.data?.clientUid);
  const action = request.data?.action;
  if (!new Set(["suspend", "reactivate"]).has(action)) throw new HttpsError("invalid-argument", "Azione non valida.");

  if (action === "suspend") {
    await target.ref.update({ status: "suspended", suspendedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await adminAuth.updateUser(target.uid, { disabled: true });
    await adminAuth.revokeRefreshTokens(target.uid);
  } else {
    await adminAuth.updateUser(target.uid, { disabled: false });
    await adminAuth.revokeRefreshTokens(target.uid);
    await target.ref.update({ status: "active", suspendedAt: FieldValue.delete(), reactivatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }
  return { uid: target.uid, status: action === "suspend" ? "suspended" : "active" };
});

async function collectionData(ref, limit = 1000) {
  const snap = await ref.limit(limit).get();
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

exports.exportClientData = onCall(callableOptions({ timeoutSeconds: 60 }), async (request) => {
  const coach = await requireActor(request);
  const target = await requireOwnedAthlete(coach.uid, request.data?.clientUid);
  const [program, state, messages, versions] = await Promise.all([
    collectionData(target.ref.collection("program"), 100),
    collectionData(target.ref.collection("state"), 200),
    collectionData(target.ref.collection("messages"), 1000),
    collectionData(target.ref.collection("programVersions"), 200)
  ]);
  return { exportedAt: new Date().toISOString(), profile: { id: target.uid, ...target.profile }, program, state, messages, programVersions: versions };
});

exports.deleteClient = onCall(callableOptions({ timeoutSeconds: 120, memory: "512MiB" }), async (request) => {
  const coach = await requireActor(request);
  const target = await requireOwnedAthlete(coach.uid, request.data?.clientUid);
  const confirmationEmail = cleanText(request.data?.confirmationEmail, 254).toLowerCase();
  if (confirmationEmail !== String(target.profile.email || "").toLowerCase()) {
    throw new HttpsError("invalid-argument", "Email di conferma non corrispondente.");
  }
  const opRef = db.doc(`adminOperations/${coach.uid}_delete_${target.uid}`);
  await opRef.set({ type: "deleteClient", coachId: coach.uid, targetUid: target.uid, status: "blocking", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await target.ref.set({ status: "deleting", deletionRequestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  try { await adminAuth.updateUser(target.uid, { disabled: true }); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  try { await adminAuth.revokeRefreshTokens(target.uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  await opRef.set({ status: "deleting-data", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await db.recursiveDelete(target.ref);
  try { await adminAuth.deleteUser(target.uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  await opRef.set({ status: "completed", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { deleted: true, uid: target.uid };
});

exports.saveProgramDraft = onCall(callableOptions(), async (request) => {
  const coach = await requireActor(request);
  const client = await requireOwnedAthlete(coach.uid, request.data?.clientUid);
  let program;
  try { program = validateProgram(request.data?.program); } catch (error) { invalidArgument(error); }
  const draftId = request.data?.draftId ? validateId(request.data.draftId, "ID bozza") : db.collection("coaches").doc().id;
  const ref = db.doc(`coaches/${coach.uid}/drafts/${draftId}`);
  const expectedRevision = Number(request.data?.expectedRevision || 0);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const revision = snap.exists ? Number(snap.get("revision") || 0) : 0;
    if (snap.exists && revision !== expectedRevision) throw new HttpsError("aborted", "La bozza è stata modificata altrove.");
    const nextRevision = revision + 1;
    tx.set(ref, {
      coachId: coach.uid,
      clientUid: client.uid,
      status: "draft",
      program,
      revision: nextRevision,
      createdAt: snap.exists ? snap.get("createdAt") : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return nextRevision;
  });
  return { draftId, revision: result };
});

exports.publishProgram = onCall(callableOptions(), async (request) => {
  const coach = await requireActor(request);
  const client = await requireOwnedAthlete(coach.uid, request.data?.clientUid);
  const draftId = validateId(request.data?.draftId, "ID bozza");
  const draftRef = db.doc(`coaches/${coach.uid}/drafts/${draftId}`);
  const currentRef = client.ref.collection("program").doc("current");
  const versionId = db.collection("versions").doc().id;
  const publishedRevision = await db.runTransaction(async (tx) => {
    const [draftSnap, currentSnap] = await Promise.all([tx.get(draftRef), tx.get(currentRef)]);
    if (!draftSnap.exists || draftSnap.get("clientUid") !== client.uid || draftSnap.get("status") !== "draft") {
      throw new HttpsError("failed-precondition", "Bozza non disponibile.");
    }
    const expectedRevision = Number(request.data?.expectedRevision || 0);
    if (Number(draftSnap.get("revision") || 0) !== expectedRevision) throw new HttpsError("aborted", "La bozza è stata modificata altrove.");
    const currentRevision = currentSnap.exists ? Number(currentSnap.get("revision") || 0) : 0;
    if (currentSnap.exists) {
      const oldVersion = currentSnap.get("versionId") || db.collection("versions").doc().id;
      tx.set(client.ref.collection("programVersions").doc(oldVersion), { ...currentSnap.data(), archivedAt: FieldValue.serverTimestamp() });
    }
    tx.set(currentRef, {
      program: draftSnap.get("program"),
      versionId,
      revision: currentRevision + 1,
      coachId: coach.uid,
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(draftRef, { status: "published", publishedVersionId: versionId, publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return currentRevision + 1;
  });
  return { versionId, revision: publishedRevision };
});

exports.archiveProgramDraft = onCall(callableOptions(), async (request) => {
  const coach = await requireActor(request);
  const draftId = validateId(request.data?.draftId, "ID bozza");
  const ref = db.doc(`coaches/${coach.uid}/drafts/${draftId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get("coachId") !== coach.uid) throw new HttpsError("not-found", "Bozza non trovata.");
  await ref.update({ status: "archived", archivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { archived: true };
});

exports.health = onCall(callableOptions(), async () => ({ ok: true, time: Timestamp.now().toDate().toISOString() }));

process.on("unhandledRejection", (error) => logger.error("Unhandled rejection", { message: error?.message }));
