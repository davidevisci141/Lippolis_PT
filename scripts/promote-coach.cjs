"use strict";

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const uid = arg("uid");
const expectedEmail = arg("email").toLowerCase();
const projectId = arg("project") || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!uid || !expectedEmail || !projectId) {
  console.error("Uso: node scripts/promote-coach.cjs --project PROJECT_ID --uid UID_ESATTO --email EMAIL_ESATTA");
  process.exit(2);
}

initializeApp({ credential: applicationDefault(), projectId });

(async () => {
  const user = await getAuth().getUser(uid);
  if ((user.email || "").toLowerCase() !== expectedEmail) throw new Error("UID ed email non corrispondono: promozione annullata.");
  if (!user.emailVerified) throw new Error("Verifica prima l’email del PT in Firebase Authentication.");
  await getAuth().setCustomUserClaims(uid, { ...(user.customClaims || {}), role: "coach" });
  await getFirestore().doc(`profiles/${uid}`).set({
    email: user.email,
    displayName: user.displayName || user.email,
    firstName: user.displayName?.split(" ")[0] || "",
    lastName: user.displayName?.split(" ").slice(1).join(" ") || "",
    role: "coach",
    status: "active",
    onboardingComplete: true,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(`PT promosso: ${uid} (${user.email})`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
