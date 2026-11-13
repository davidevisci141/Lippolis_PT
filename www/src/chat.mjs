import { supabase } from "./supabase.mjs";

export async function markChatRead(athleteId, messages, readerId) {
  const ids = messages.filter(message => !message.read_at && message.sender_id !== readerId).map(message => message.id);
  if (!ids.length) return;
  const { error } = await supabase.rpc("mark_chat_read", { p_athlete: athleteId, p_messages: ids });
  if (error) throw error;
}
