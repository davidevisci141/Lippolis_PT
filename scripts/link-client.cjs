"use strict";

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

function arg(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : ""; }
const trainerUid = arg("trainer");
const athleteUid = arg("athlete");
const projectId = arg("project") || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!trainerUid || !athleteUid || !projectId || trainerUid === athleteUid) {
  console.error("Uso: node scripts/link-client.cjs --project PROJECT_ID --trainer UID_PT --athlete UID_CLIENTE"); process.exit(2);
}
initializeApp({ credential: applicationDefault(), projectId });

(async () => {
  const db = getFirestore();
  const [trainer, athlete, trainerProfile, athleteProfile] = await Promise.all([
    getAuth().getUser(trainerUid), getAuth().getUser(athleteUid),
    db.doc(`profiles/${trainerUid}`).get(), db.doc(`profiles/${athleteUid}`).get()
  ]);
  if (!trainerProfile.exists || trainerProfile.get("role") !== "coach" || trainerProfile.get("status") !== "active") throw new Error("Il trainer indicato non è un PT attivo.");
  if (athleteProfile.exists && athleteProfile.get("role") === "coach") throw new Error("Impossibile associare un altro PT come cliente.");
  await db.doc(`profiles/${athleteUid}`).set({
    email: athlete.email,
    displayName: athlete.displayName || athlete.email,
    role: "athlete", trainerId: trainerUid, status: athlete.disabled ? "suspended" : "active",
    onboardingComplete: Boolean(athleteProfile.get("onboardingComplete")),
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: athleteProfile.exists ? athleteProfile.get("createdAt") : FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(`Cliente ${athleteUid} associato al PT ${trainerUid} (${trainer.email}).`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
