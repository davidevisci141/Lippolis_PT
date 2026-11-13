import { supabase } from "./supabase.mjs";

export async function markChatRead(athleteId, messages, readerId) {
  const ids = messages.filter(message => !message.read_at && message.sender_id !== readerId).map(message => message.id);
  if (!ids.length) return;
  const { error } = await supabase.rpc("mark_chat_read", { p_athlete: athleteId, p_messages: ids });
  if (error) throw error;
}

export function notificationLabel() {
  if (!("Notification" in window) || !navigator.serviceWorker) return "Notifiche browser non disponibili";
  if (Notification.permission === "granted") return "Notifiche attive";
  if (Notification.permission === "denied") return "Notifiche bloccate dal browser";
  return "Attiva notifiche";
}

export async function enableChatNotifications() {
  if ("Notification" in window && navigator.serviceWorker && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if ("Notification" in window && navigator.serviceWorker && Notification.permission === "granted") {
    await navigator.serviceWorker.register("chat-worker.js");
  }
  return notificationLabel();
}

export async function notifyChat(role) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted" || !navigator.serviceWorker) return;
  try {
    let registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active) {
      await navigator.serviceWorker.register("chat-worker.js");
      registration = await navigator.serviceWorker.ready;
    }
    await registration.showNotification("Lippolis PT", {
      body: role === "coach" ? "Un cliente ti ha scritto." : "Il tuo PT ti ha scritto.",
      tag: "lippolis-chat-" + role, icon: "icon-192.png", data: { role }
    });
  } catch (error) {
    console.warn("Notifica chat non disponibile", error);
  }
}
