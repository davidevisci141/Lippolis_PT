import { supabase } from "./supabase.mjs";

export function watchCoachSections(uid, receive) {
  let currentRequest = 0;
  let active = true;
  const refresh = async () => {
    const request = ++currentRequest;
    const { data, error } = await supabase.from("coach_client_sections")
      .select("section,content").eq("athlete_id",uid);
    if (active && request === currentRequest && !error) {
      receive(Object.fromEntries(data.map(row => [row.section, row.content])));
    }
  };
  const channel = supabase.channel("athlete-coach-sections:"+uid)
    .on("postgres_changes", {event:"*",schema:"public",table:"coach_client_sections",filter:"athlete_id=eq."+uid}, refresh)
    .subscribe(status => { if(status==="SUBSCRIBED")void refresh(); });
  const onVisible = () => { if(!document.hidden)void refresh(); };
  window.addEventListener("online",refresh);
  document.addEventListener("visibilitychange",onVisible);
  void refresh();
  return {
    async answer(id, answers) {
      const {error}=await supabase.rpc("answer_coach_questionnaire",{p_questionnaire:id,p_answers:answers});
      if(error)throw error;
      await refresh();
    },
    stop() {
      active=false;
      window.removeEventListener("online",refresh);
      document.removeEventListener("visibilitychange",onVisible);
      void supabase.removeChannel(channel);
    }
  };
}

export async function getCoachFile(bucket,path){
  const {data,error}=await supabase.storage.from(bucket).createSignedUrl(path,300);
  if(error)throw error;
  return data.signedUrl;
}
