import { supabase } from "./supabase.mjs";

export function watchAthleteNutrition(uid, onChange) {
  let active = true, request = 0, lastRevision = -1;
  onChange({ plan: null, state: "loading" });
  const load = async () => {
    const sequence = ++request;
    try {
      const { data, error } = await supabase.from("nutrition_plans").select("plan, revision")
        .eq("athlete_id", uid).eq("status", "published").maybeSingle();
      if (!active || sequence !== request) return;
      if (error) throw error;
      if (data && Number(data.revision) < lastRevision) return;
      lastRevision = data ? Number(data.revision) : -1;
      onChange({ plan: data?.plan || null, state: "ready" });
    } catch {
      if (active && sequence === request && lastRevision < 0) onChange({ plan: null, state: "error" });
    }
  };
  const channel = supabase.channel(`athlete-nutrition:${uid}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "nutrition_plans", filter: `athlete_id=eq.${uid}` }, load)
    .subscribe((status) => { if (status === "SUBSCRIBED") void load(); });
  const onVisible = () => { if (!document.hidden) void load(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", load);
  void load();
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", load);
    void supabase.removeChannel(channel);
  };
}
