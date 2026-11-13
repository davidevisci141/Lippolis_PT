import { adminCall, supabase, profileFromRow } from "./supabase.mjs";
import { getAuthorizedSession, friendlyAuthError, logout } from "./auth.mjs";
import { mockupToProgram, programToMockup, nutritionSummary } from "./coach-mockup-model.mjs";
import { parseExerciseVideo } from "./exercise-video.mjs";
import { recognizeInBodyPhoto, requiredBiaFields } from "./bia-ocr.mjs";

const ui = window.CoachMock, $ = (id) => document.getElementById(id);
const escape = (v) => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const replace = (array, list) => array.splice(0,array.length,...list);
const today = () => new Date().toLocaleDateString("sv-SE");
const displayDate = (value) => value && !Number.isNaN(new Date(value).valueOf()) ? new Intl.DateTimeFormat("it-IT",{dateStyle:"medium"}).format(new Date(value)) : "—";
const val = (id) => $(id)?.value.trim() || "";
const row = (title, detail="", action="") => `<div class="row"><span class="row-main"><span class="row-t">${escape(title)}</span><span class="row-s mock-multiline">${escape(detail)}</span></span>${action}</div>`;
const empty = (title,detail="") => `<div class="empty"><div class="ic">${ui.I.doc}</div><h2>${escape(title)}</h2><p>${escape(detail)}</p></div>`;
const button = (id,label,primary=false) => `<button type="button" class="btn btn-${primary?"primary":"ghost"}" id="${id}">${label}</button>`;
const field = (id,label,type="text",value="",required=false) => `<label class="fld"><span>${label}</span><input class="inp" id="${id}" type="${type}" value="${escape(value)}" ${required?"required":""}></label>`;
const textarea = (id,label,value="") => `<label class="fld"><span>${label}</span><textarea class="ta" id="${id}" rows="4">${escape(value)}</textarea></label>`;
const fail = (err) => ui.toast(friendlyAuthError(err));
const checked = ({data,error}) => { if(error) throw error; return data; };
const sectionRows = new Map(), snapshots = new Map(), published = new Map(), versions = new Map(), drafts = new Map();
const sectionWrites = new Map();
let profile, uid, workspaceRevision=0, workspaceSignature="", saveQueue=Promise.resolve(), selectEpoch=0, loadEpoch=0, workspaceLoaded=false;
let workspace = {exerciseEdits:{}, templates:[], collaborators:[], review:{}, priority:{}, recipes:[], preferences:{}};
const key = (client,section) => `${client.id}:${section}`;
const getSection = (client,section) => sectionRows.get(key(client,section))?.content || {};
const items = (client,section) => getSection(client,section).items || [];

const htmlProperty=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");
function safeHTML(value) {
  const template=document.createElement("template"); htmlProperty.set.call(template,value);
  for(const el of template.content.querySelectorAll("script, iframe, object, embed, base, link, meta, style, foreignObject, form, animate, set, use"))el.remove();
  for(const el of template.content.querySelectorAll("*")){
    for(const a of Array.from(el.attributes)){
      const name=a.name.toLowerCase();
      if(name.startsWith("on")||["href","xlink:href","src","srcdoc","action","formaction","ping","is","style"].includes(name)){
        if(name==="style" && !/[<>]|url\s*\(|expression\s*\(|@import/i.test(a.value))continue;
        el.removeAttribute(a.name);
      }
    }
  }
  return htmlProperty.get.call(template);
}
function secureMarkup() {
  Object.defineProperty(Element.prototype,"innerHTML",{...htmlProperty,set(html){htmlProperty.set.call(this,safeHTML(html));}});
}

function showModal(title, fields, label, onSave) {
  ui.openModal(`<div class="modal-h"><h3>${escape(title)}</h3><button type="button" class="modal-x" id="mX">${ui.I.x}</button></div><div class="modal-b">${safeHTML(fields)}<p id="mockModalError" role="status"></p></div><div class="modal-f">${button("mockModalCancel","Annulla")}${button("mockModalSave",label,true)}</div>`);
  $("mX").onclick=$("mockModalCancel").onclick=ui.closeModal;
  $("mockModalSave").onclick=async (event)=>{
    const submit=event.currentTarget; submit.disabled=true;
    try {
      const missing=[...$("modalOv").querySelectorAll("input[required]")].find(input=>!input.reportValidity());
      if(missing)return;
      await onSave();
      if(submit.isConnected)ui.closeModal();
    } catch(error){ if($("mockModalError"))$("mockModalError").textContent=friendlyAuthError(error); else fail(error); }
    finally{submit.disabled=false;}
  };
}

function workspacePayload() {
  return {...workspace, programs:ui.programmi.map(p=>({...p,id:p.id ||= crypto.randomUUID()})),
    mealPlans:ui.pianiAlimentari.map(p=>({...p,id:p.id ||= crypto.randomUUID()})), notifications:ui.notifiche.map(n=>n.on)};
}
function saveWorkspace(explicit=false) {
  if(!workspaceLoaded)return Promise.resolve(false);
  const task=saveQueue.catch(()=>{}).then(async ()=>{
    const payload=workspacePayload(), signature=JSON.stringify(payload);
    if(signature!==workspaceSignature){
      setSaveStatus("Salvataggio…");
      workspaceRevision=checked(await supabase.rpc("save_coach_workspace",{p_expected:workspaceRevision,p_content:payload}));
      workspaceSignature=signature;
      setSaveStatus("Salvato su Supabase");
    }
    if(explicit)ui.toast("Salvato nel database");
    return true;
  });
  saveQueue=task;
  return task.catch(error=>{setSaveStatus("Salvataggio non riuscito");fail(error);return false;});
}
function setSaveStatus(message){const status=$("asTxt");if(status)status.textContent=message;}

async function signOutCoach() {
  const headerButton = $("coachLogout");
  if (headerButton.disabled) return;
  const settingsButton = $("mockLogout");
  headerButton.disabled = true;
  if (settingsButton) settingsButton.disabled = true;
  ui.main.inert = true;
  try {
    const saved = !workspaceLoaded || await saveWorkspace();
    if (saved || window.confirm("Le ultime modifiche non sono state salvate. Vuoi uscire comunque?")) {
      await logout();
    }
  } finally {
    ui.main.inert = false;
    headerButton.disabled = false;
    if (settingsButton) settingsButton.disabled = false;
  }
}

async function saveSection(client,section,content) {
  const id=key(client,section), previous=sectionRows.get(id);
  const revision=checked(await supabase.rpc("save_coach_client_section",{p_athlete:client.id,p_section:section,p_expected:previous?.revision||0,p_content:content}));
  sectionRows.set(id,{athlete_id:client.id,section,revision,content});
}

function changeSection(client,section,change){
  const id=key(client,section);
  const previous=sectionWrites.get(id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>saveSection(client,section,change(getSection(client,section))));
  sectionWrites.set(id,next);
  return next.finally(()=>{if(sectionWrites.get(id)===next)sectionWrites.delete(id);});
}
async function loadClientRows(client) {
  const [snapshot,current,history,clientDrafts,sections]=await Promise.all([
    supabase.from("athlete_states").select("snapshot").eq("user_id",client.id).maybeSingle(),
    supabase.from("programs").select("*").eq("athlete_id",client.id).maybeSingle(),
    supabase.from("program_versions").select("*").eq("athlete_id",client.id).order("published_at",{ascending:false}).limit(40),
    supabase.from("program_drafts").select("*").eq("athlete_id",client.id).eq("coach_id",uid).eq("status","draft").order("updated_at",{ascending:false}).limit(40),
    supabase.from("coach_client_sections").select("*").eq("athlete_id",client.id)
  ]);
  snapshots.set(client.id,checked(snapshot)?.snapshot||{});
  const plan=checked(current); if(plan)published.set(client.id,plan); else published.delete(client.id);
  versions.set(client.id,checked(history)); drafts.set(client.id,checked(clientDrafts));
  for(const section of checked(sections)){
    const id=key(client,section.section);
    if(Number(section.revision)>=Number(sectionRows.get(id)?.revision||0))sectionRows.set(id,section);
  }
}
async function loadDirectory() {
  const epoch=++loadEpoch;
  const [people,plans,states,sections,clientDrafts,urgent]=await Promise.all([
    supabase.from("profiles").select("*").eq("trainer_id",uid).eq("role","athlete").order("last_name"),
    supabase.from("programs").select("*").eq("coach_id",uid),
    supabase.from("athlete_states").select("user_id,snapshot"),
    supabase.from("coach_client_sections").select("*"),
    supabase.from("program_drafts").select("*").eq("coach_id",uid).eq("status","draft"),
    supabase.from("messages").select("id,athlete_id,text,created_at").eq("type","urgenza").order("created_at",{ascending:false}).limit(100)
  ]);
  if(epoch!==loadEpoch)return;
  replace(ui.clienti,checked(people).map(p=>({...p,nome:p.display_name||`${p.first_name} ${p.last_name}`,reg:p.created_at?.slice(0,10)||today(),attivo:p.status==="active"})));
  published.clear(); for(const p of checked(plans))published.set(p.athlete_id,p);
  snapshots.clear(); for(const p of checked(states))snapshots.set(p.user_id,p.snapshot||{});
  for(const p of checked(sections)){
    const id=`${p.athlete_id}:${p.section}`;
    if(!sectionRows.has(id)||Number(p.revision)>=Number(sectionRows.get(id).revision))sectionRows.set(id,p);
  }
  const remoteDrafts=checked(clientDrafts);
  for(const item of remoteDrafts){
    const plan=programToMockup(item.program,item.id);
    if(!ui.programmi.some(p=>p.id===item.id))ui.programmi.push({...plan,_remote:{id:item.id,revision:item.revision,clientId:item.athlete_id}});
  }
  urgentMessages=checked(urgent);
  refreshSignals();
}
let urgentMessages=[];
function refreshSignals() {
  const priorities=[], reviews=[], dates=[];
  for(const c of ui.clienti){
    const active=published.get(c.id), end=active?.program?.al||active?.program?.endDate, start=active?.program?.dal||active?.program?.startDate;
    if(start)dates.push({data:start,cliente:c.nome,prog:active.program.nome||active.program.name,tipo:"Inizio"});
    if(end)dates.push({data:end,cliente:c.nome,prog:active.program.nome||active.program.name,tipo:"Scadenza"});
    for(const event of items(c,"agenda"))dates.push({data:event.date,cliente:c.nome,prog:event.title,tipo:"Promemoria"});
    if(!c.attivo)continue;
    for(const message of urgentMessages.filter(m=>m.athlete_id===c.id).slice(0,5)){
      const id=c.id+":urgent:"+message.id;
      const status=workspace.priority[id];
      priorities.push({id:priorities.length+1,key:id,clientId:c.id,cliente:c.nome,urgenza:"alta",fonte:"chat",tag:"Segnalazione",
        titolo:"Segnalazione del cliente",evidenza:String(message.text||"").replace(/<[^>]*>/g," ").slice(0,380),azione:"Apri la conversazione e valuta la segnalazione.",cta:"Rispondi",tono:"rassicurante",
        messaggio:`Ciao ${c.first_name}, ho letto la tua segnalazione. Puoi dirmi come va adesso?`,...(status?.stato==="rimandato"&&status.date!==today()?{messaggio:status.messaggio}:status)});
    }
    const days=end?Math.round((Date.parse(end)-Date.parse(today()))/86400000):null;
    const title=!active?"Scheda da assegnare":days<0?"Scheda scaduta":days!=null&&days<=7?"Scheda in scadenza":"";
    if(title){
      const id=`${c.id}:${active?.version_id||"no-program"}:${title}`, status=workspace.priority[id];
      priorities.push({id:priorities.length+1,key:id,clientId:c.id,cliente:c.nome,urgenza:!active||days<0?"alta":"media",fonte:"auto",tag:"Programmazione",titolo:title,
        evidenza:end?`Fine scheda: ${displayDate(end)}`:"Nessuna scheda pubblicata.",azione:"Apri la programmazione del cliente.",cta:"Invia messaggio",tono:"rassicurante",
        messaggio:`Ciao ${c.first_name}, sto aggiornando la tua programmazione. Scrivimi se hai domande.`, ...(status?.stato==="rimandato"&&status.date!==today()?{messaggio:status.messaggio}:status)});
    }
    const sessions=(snapshots.get(c.id)?.sessioni||[]).slice().sort((a,b)=>b.ts-a.ts), seen=new Set();
    for(const session of sessions.slice(0,10)){
      const program=active?.version_id===session.programVersionId?active.program:null;
      const day=program?.settimane?.find(w=>w.n===session.settimana)?.giorni?.[session.giorno];
      for(const ex of (session.esercizi||[])){
        if(seen.has(ex.nome))continue;
        const prescription=day?.blocks?.flatMap(b=>b.exercises||[]).find(x=>x.id===ex.exerciseId||x.name===ex.nome);
        const target=prescription?.sets?.find(s=>s.target_rir!=null)?.target_rir;
        const sets=(ex.sets||[]).filter(s=>s.rir!=null&&Number.isFinite(Number(s.rir))&&Number.isFinite(Number(s.kg)));
        if(!sets.length||target==null||ex.unita==="sec")continue;
        seen.add(ex.nome);
        const id=`${c.id}:${session.id}:${ex.exerciseId||ex.nome}`;
        reviews.push({id:reviews.length+1,key:id,clientId:c.id,exerciseId:ex.exerciseId,versionId:session.programVersionId, exerciseName:ex.nome,cliente:c.nome,
          esercizio:ex.nome,gruppo:prescription.primary_muscles?.[0]||"Allenamento",sessione:displayDate(session.ts),targetRir:Number(target),reps:String(prescription.sets?.[0]?.reps_min||sets[0].reps),
          carico:Math.max(...sets.map(s=>Number(s.kg))),step:2.5,sets,...workspace.review[id]});
      }
    }
  }
  replace(ui.prioritaOggi,priorities);replace(ui.revisioneCarichi,reviews);replace(ui.scadenze,dates);
}

function clientSelect(id="mockClient") {
  return `<label class="fld"><span>Cliente</span><select class="sel" id="${id}">${ui.clienti.filter(c=>c.attivo).map(c=>`<option value="${c.id}" ${ui.currentClient?.id===c.id?"selected":""}>${escape(c.nome)}</option>`).join("")}</select></label>`;
}
async function assignProgram(template) {
  if(!ui.clienti.some(c=>c.attivo))return ui.toast("Aggiungi prima un cliente attivo.");
  const dal=template.dal||today();
  const al=template.al||new Date(Date.parse(dal)+((template.weeks?.length||1)*7-1)*86400000).toISOString().slice(0,10);
  showModal("Assegna programma",clientSelect()+field("mockStart","Inizio","date",dal,true)+field("mockEnd","Fine","date",al,true)+`<p>La scheda sarà visibile al cliente in Allenamento dopo la pubblicazione.</p>`,"Pubblica per il cliente",async ()=>{
    const clientUid=val("mockClient"), program=mockupToProgram(template,{dal:val("mockStart"),al:val("mockEnd")});
    if(!clientUid)throw new Error("Seleziona un cliente.");
    if(!template._remote && !await saveWorkspace())throw new Error("Salva prima il programma.");
    const previous=template._remote?.clientId===clientUid?template._remote:null;
    const draft=await adminCall("saveProgramDraft",{clientUid,draftId:previous?.id||null,expectedRevision:previous?.revision||0,program});
    template._remote={id:draft.draftId,revision:draft.revision,clientId:clientUid};
    await saveWorkspace();
    const result=await adminCall("publishProgram",{clientUid,draftId:draft.draftId,expectedRevision:draft.revision});
    const actual=checked(await supabase.from("programs").select("*").eq("athlete_id",clientUid).single());
    if(actual.version_id!==result.versionId)throw new Error("La versione attiva è cambiata. Controlla la programmazione del cliente.");
    published.set(clientUid,actual); template.clienti=Math.max(1,template.clienti||0);
    delete template._remote;
    await saveWorkspace();
    refreshSignals();ui.toast("Scheda pubblicata e verificata nel database");
  });
}

function publishNutrition(plan) {
  if(!ui.clienti.some(c=>c.attivo))return ui.toast("Aggiungi prima un cliente attivo.");
  showModal("Assegna piano alimentare",clientSelect(),"Pubblica per il cliente",async ()=>{
    const c=ui.clienti.find(c=>c.id===val("mockClient"));
    const summary=nutritionSummary(plan);
    if(!summary.title||(!summary.notes&&!summary.meals.length))throw new Error("Aggiungi indicazioni o pasti prima di pubblicare.");
    if(!await saveWorkspace())throw new Error("Il piano non è stato salvato.");
    await saveSection(c,"nutrition",{plan:structuredClone(plan),publishedAt:new Date().toISOString()});
    plan.clienti=Math.max(1,plan.clienti||0);await saveWorkspace();ui.toast("Piano pubblicato per "+c.nome);
  });
}

function createClient(){
  showModal("Aggiungi cliente",field("mockFirst","Nome","text","",true)+field("mockLast","Cognome","text","",true)+field("mockEmail","Email","email","",true)+field("mockPassword","Password iniziale","password","",true)+button("mockGenerate","Genera password"),"Crea account",async ()=>{
    const email=val("mockEmail"),password=val("mockPassword");
    await adminCall("createClient",{firstName:val("mockFirst"),lastName:val("mockLast"),email,password,idempotencyKey:crypto.randomUUID()});
    await loadDirectory();ui.go("clienti");
    ui.closeModal();showModal("Account creato",`<p>${escape(email)}</p><p><b>${escape(password)}</b></p>`,"Chiudi",async()=>{});
  });
  $("mockGenerate").onclick=()=>{$("mockPassword").value="Aa7!"+crypto.randomUUID().replaceAll("-","").slice(0,16);$("mockPassword").type="text";};
}
async function openClient(c){
  const epoch=++selectEpoch;
  try{await loadClientRows(c);if(epoch===selectEpoch){hydrateMetrics(c);ui.setClient(c);}}
  catch(error){if(epoch===selectEpoch)fail(error);}
}

function saveProgram(template) {
  if(!template.nome?.trim())return ui.toast("Inserisci il nome del programma.");
  return saveWorkspace(true);
}

function hydrateMetrics(c){
  const snapshot=snapshots.get(c.id)||{}, section=getSection(c,"metrics");
  for(const m of ui.metriche){
    const fromAthlete=(snapshot.metriche||[]).find(x=>x.nome===m.nome)?.dati||[];
    const fromCoach=(section.measures||[]).filter(x=>x.name===m.nome);
    m.dati=[...fromAthlete,...fromCoach].filter(x=>Number.isFinite(Number(x.v))).map(x=>({...x,v:Number(x.v)}));
  }
  const values=section.pliche;
  ui.setPliche(values?.v||snapshot.plicheVals||{petto:0,ascellare:0,tricipite:0,sottoscapolare:0,addome:0,soprailiaca:0,coscia:0},values?.sex||snapshot.plicheSex||"M",values?.age||snapshot.plicheAge||30);
}
function addMeasure(c,metric){
  showModal(metric.nome,field("mockMeasure","Misura (cm)","text","",true),"Salva",async ()=>{
    const value=Number(val("mockMeasure").replace(",","."));
    if(!Number.isFinite(value)||value<=0||value>400)throw new Error("Inserisci una misura valida.");
    const section=getSection(c,"metrics");
    await saveSection(c,"metrics",{...section,measures:[...(section.measures||[]),{id:crypto.randomUUID(),name:metric.nome,v:value,l:displayDate(today()),ts:Date.now()}]});
    hydrateMetrics(c);ui.renderCliMetriche(c);ui.toast("Misura salvata");
  });
}
function metricActions(c){
  const body=$("cmBody");
  const toolbar=document.createElement("div");toolbar.className="mock-tools";
  toolbar.innerHTML=button("mockSavePliche","Salva pliche")+button("mockBia","Referti BIA");
  body.before(toolbar);
  $("mockSavePliche").onclick=()=>saveSection(c,"metrics",{...getSection(c,"metrics"),pliche:ui.getPliche()}).then(()=>ui.toast("Pliche salvate")).catch(fail);
  $("mockBia").onclick=()=>clientBia(c);
}

const clientHeading = (c,title,actions="") => ui.pageHead(title,actions)+ui.cliStrip(c);
function drawClient(c,title,html,actions="") {
  ui.main.innerHTML=clientHeading(c,title,actions)+`<div class="sec">${html}</div>`;
  $("back").onclick=ui.backClient;
}
async function signed(bucket,path) {
  const {signedUrl}=checked(await supabase.storage.from(bucket).createSignedUrl(path,300));
  return signedUrl;
}
async function openFile(bucket,path) {
  const url=await signed(bucket,path);
  const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.click();
}
async function uploadFile(bucket,owner,file) {
  if(!file||file.size>50*1024*1024)throw new Error("Seleziona un file fino a 50 MB.");
  const ext={ "application/pdf":"pdf","text/plain":"txt","image/jpeg":"jpg","image/png":"png","image/webp":"webp","video/mp4":"mp4","video/webm":"webm" }[file.type];
  if(!ext)throw new Error("Formato file non supportato.");
  const path=`${owner}/${crypto.randomUUID()}.${ext}`;
  checked(await supabase.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false}));
  return path;
}
function listFiles(c, section, title) {
  const photos=section==="progress", list=items(c,section);
  const groups=new Map();
  list.forEach((it,i)=>{const day=groups.get(it.date)||[];day.push({it,i});groups.set(it.date,day);});
  const gallery=[...groups].sort(([a],[b])=>b.localeCompare(a)).map(([date,entries])=>
    `<div class="pentry"><div class="pe-head"><div class="pdate">${displayDate(date)}</div></div><div class="pshots">${entries.map(({it,i})=>`<div class="pslot"><div class="ph" data-photo-slot="${i}"></div><div class="plab">${escape(it.title)}</div>${button("mockFile"+i,"Apri")}${button("mockRemoveFile"+i,"Elimina")}</div>`).join("")}</div></div>`).join("");
  const rows=list.map((it,i)=>row(it.title,displayDate(it.date),button("mockFile"+i,"Apri")+button("mockRemoveFile"+i,"Elimina"))).join("");
  const previewControl=photos?`<div class="pg-toggle"><div class="t">Oscura le anteprime</div><button class="tgl ${workspace.preferences.blurPhotos?"on":""}" id="mockBlurPhotos" aria-label="Oscura le anteprime"></button></div>`:"";
  drawClient(c,title,previewControl+(photos?gallery:rows||"")+(list.length?"":empty(photos?"Nessuna foto":"Nessun documento")),button("mockAddFile",photos?"Aggiungi foto":"Aggiungi documento",true));
  if(photos)$("mockBlurPhotos").onclick=()=>{
    workspace.preferences.blurPhotos=!workspace.preferences.blurPhotos;
    ui.scheduleSave();listFiles(c,section,title);
  };
  if(photos&&list.length){
    list.forEach((it,i)=>{
      const slot=ui.main.querySelector('[data-photo-slot="'+i+'"]');
      signed("coach-client-files",it.path).then(url=>{
        if(!slot?.isConnected)return;
        const image=document.createElement("img");image.src=url;image.alt=it.title;image.className="mock-photo";
        if(workspace.preferences.blurPhotos)image.style.filter="blur(14px)";
        slot.append(image);
      }).catch(()=>{});
    });
  }
  $("mockAddFile").onclick=()=>{
    showModal(title,field("mockFileTitle","Nome","text","",true)+`<input type="file" id="mockUpload" accept="${photos?"image/jpeg,image/png,image/webp":".pdf,.txt,image/jpeg,image/png,image/webp"}">`,"Carica",async ()=>{
      const file=$("mockUpload").files[0];
      if(!file||(photos&&!/^image\/(jpeg|png|webp)$/.test(file.type))||(!photos&&!/^(application\/pdf|text\/plain|image\/(jpeg|png|webp))$/.test(file.type)))throw new Error("Formato file non supportato.");
      const path=await uploadFile("coach-client-files",c.id,file);
      try{await saveSection(c,section,{items:[...items(c,section),{id:crypto.randomUUID(),title:val("mockFileTitle"),date:today(),path}]});}
      catch(error){await supabase.storage.from("coach-client-files").remove([path]);throw error;}
      listFiles(c,section,title);
    });
  };
  list.forEach((it,i)=>{
    $("mockFile"+i).onclick=()=>openFile("coach-client-files",it.path).catch(fail);
    $("mockRemoveFile"+i).onclick=async()=>{
      if(!confirm("Eliminare questo allegato?"))return;
      try{await saveSection(c,section,{items:items(c,section).filter(x=>x.id!==it.id)});await supabase.storage.from("coach-client-files").remove([it.path]);listFiles(c,section,title);}catch(error){fail(error);}
    };
  });
}
function questionnaire(c){
  const list=items(c,"questionnaires");
  drawClient(c,"Questionari",list.length?list.map(it=>`<details class="metric"><summary>${escape(it.title)} · ${it.answers?"Compilato":"Da compilare"}</summary>${it.questions.map((q,i)=>row(q,it.answers?.[i]||"In attesa")).join("")}</details>`).join(""):empty("Nessun questionario assegnato"),button("mockAssignForm","Assegna questionario",true));
  $("mockAssignForm").onclick=()=>{
    if(!workspace.templates.length)return ui.toast("Crea un modello da Impostazioni → Questionari.");
    showModal("Assegna questionario",`<label class="fld">Modello<select class="sel" id="mockFormTemplate">${workspace.templates.map(t=>`<option value="${t.id}">${escape(t.title)}</option>`).join("")}</select></label>`,"Assegna",async()=>{
      const t=workspace.templates.find(t=>t.id===val("mockFormTemplate"));if(!t)throw new Error("Scegli un modello.");
      await saveSection(c,"questionnaires",{items:[...items(c,"questionnaires"),{...t,id:crypto.randomUUID(),date:today()}]});questionnaire(c);
    });
  };
}
function editableList(c,section,title,isSubscription=false) {
  const list=items(c,section);
  drawClient(c,title,list.length?list.map((it,i)=>row(it.title,[displayDate(it.date),it.detail].filter(Boolean).join(" · "),button("mockEditEntry"+i,"Modifica")+button("mockDelEntry"+i,"Elimina"))).join(""):empty("Nessun elemento"),button("mockAddEntry",isSubscription?"Aggiungi abbonamento":"Aggiungi promemoria",true));
  const edit=(it)=>showModal(it?"Modifica":"Aggiungi",field("mockEntryTitle","Titolo","text",it?.title,true)+field("mockEntryDate",isSubscription?"Scadenza":"Data","date",it?.date||today(),true)+textarea("mockEntryDetail",isSubscription?"Importo e stato pagamento":"Note",it?.detail),"Salva",async()=>{
    const record={id:it?.id||crypto.randomUUID(),title:val("mockEntryTitle"),date:val("mockEntryDate"),detail:val("mockEntryDetail")};
    await saveSection(c,section,{items:[...items(c,section).filter(x=>x.id!==record.id),record]});refreshSignals();editableList(c,section,title,isSubscription);
  });
  $("mockAddEntry").onclick=()=>edit();
  list.forEach((it,i)=>{
    $("mockEditEntry"+i).onclick=()=>edit(it);
    $("mockDelEntry"+i).onclick=async()=>{if(!confirm("Eliminare la voce?"))return;try{await saveSection(c,section,{items:items(c,section).filter(x=>x.id!==it.id)});refreshSignals();editableList(c,section,title,isSubscription);}catch(error){fail(error);}};
  });
}
async function messageList(c){
  drawClient(c,"Messaggi",row("Caricamento…")+textarea("mockMessage","Scrivi un messaggio")+button("mockSend","Invia",true));
  const root=ui.main.querySelector(".sec");
  try{
    const messages=checked(await supabase.from("messages").select("*").eq("athlete_id",c.id).eq("channel","thread").order("created_at",{ascending:false}).limit(100)).reverse();
    if(!root.isConnected)return;
    root.firstElementChild.outerHTML=messages.length?messages.map(m=>row(m.sender_id===uid?"Tu":c.nome,m.text)).join(""):row("Nessun messaggio");
    $("mockSend").onclick=async(e)=>{
      const text=val("mockMessage"); if(!text||text.length>4000)return ui.toast("Scrivi da 1 a 4000 caratteri.");
      e.currentTarget.disabled=true;
      try{await sendMessage(c.id,text);messageList(c);}catch(error){fail(error);if($("mockSend"))$("mockSend").disabled=false;}
    };
  }catch(error){fail(error);}
}
async function sendMessage(clientId,text){
  checked(await supabase.from("messages").insert({athlete_id:clientId,sender_id:uid,target_id:clientId,channel:"thread",text}));
}
function sendPriority(it,btn){
  btn.disabled=true;
  sendMessage(it.clientId,it.messaggio).then(()=>{
    it.stato="inviato";storeSignal(it,"priority");ui.fillPriorita();ui.toast("Messaggio inviato");
  }).catch(error=>{btn.disabled=false;fail(error);});
}
function storeSignal(it,type){
  if(!it?.key)return;
  if(it.stato)workspace[type][it.key]={stato:it.stato,...(type==="review"?{nuovo:it.nuovo}:{date:today()})};
  else delete workspace[type][it.key];
  if(type==="priority"&&it.messaggio)workspace.priority[it.key]={...workspace.priority[it.key],messaggio:it.messaggio};
  ui.scheduleSave();
  if(type==="review"){
    const c=ui.clienti.find(c=>c.id===it.clientId);
    if(!c)return;
    const recommendation=["approvato","modificato"].includes(it.stato)
      ?{id:it.key,versionId:it.versionId,exerciseId:it.exerciseId,exerciseName:it.exerciseName,kg:Number(it.nuovo),date:today()}:null;
    changeSection(c,"loads",data=>({items:[...(data.items||[]).filter(row=>row.id!==it.key),...(recommendation?[recommendation]:[])]})).catch(fail);
  }
}
function clientInfo(c){
  drawClient(c,"Informazioni generali",row(c.nome,c.email)+row("Accesso",c.attivo?"Attivo":"Sospeso")+button("mockAccess",c.attivo?"Sospendi accesso":"Riattiva accesso")+button("mockExport","Esporta dati")+button("mockClientSubscriptions","Abbonamenti")+button("mockDeleteClient","Elimina cliente"));
  $("mockAccess").onclick=async()=>{
    if(c.attivo&&!confirm("Sospendere l’accesso di questo cliente?"))return;
    try{await adminCall("setClientAccess",{clientUid:c.id,action:c.attivo?"suspend":"reactivate"});await loadDirectory();const next=ui.clienti.find(p=>p.id===c.id);ui.setClient(next,"info");}catch(error){fail(error);}
  };
  $("mockExport").onclick=async()=>{try{
    const data=await adminCall("exportClientData",{clientUid:c.id});
    data.sections=checked(await supabase.from("coach_client_sections").select("*").eq("athlete_id",c.id));
    data.nutrition=checked(await supabase.from("nutrition_plans").select("*").eq("athlete_id",c.id));
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="lippolis-cliente.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){fail(error);}};
  $("mockDeleteClient").onclick=()=>showModal("Elimina cliente",`<p>Questa operazione elimina l’account e i suoi dati. Esporta prima i dati se ti servono.</p>`+field("mockDeleteEmail","Conferma l’email","email","",true),"Elimina definitivamente",async()=>{
    if(val("mockDeleteEmail").toLowerCase()!==c.email.toLowerCase())throw new Error("L’email non corrisponde.");
    await adminCall("deleteClient",{clientUid:c.id,confirmationEmail:val("mockDeleteEmail")});await loadDirectory();ui.go("clienti");
  });
  $("mockClientSubscriptions").onclick=()=>editableList(c,"subscriptions","Abbonamenti",true);
}
function clientNutrition(c){
  const plan=getSection(c,"nutrition").plan;
  drawClient(c,"Consigli alimentari",plan?row(plan.nome,`${plan.giorni?.length||0} giorni · pubblicato il ${displayDate(getSection(c,"nutrition").publishedAt)}`):empty("Nessun piano assegnato"),button("mockGoNutrition","Apri piani",true));
  $("mockGoNutrition").onclick=()=>ui.go("nutrizione");
  if(!plan){
    const view=ui.main.querySelector(".sec");
    void supabase.from("nutrition_plans").select("plan").eq("athlete_id",c.id).eq("status","published").maybeSingle().then(({data,error})=>{
      if(!view.isConnected||error||!data?.plan)return;
      view.innerHTML=row(data.plan.title,data.plan.notes)+(data.plan.meals||[]).map(m=>row(m.label,m.text)).join("");
    });
  }
}
function clientSection(c,section){
  if(section==="alimentari")clientNutrition(c);
  else if(section==="progressi")listFiles(c,"progress","Progressi fisici");
  else if(section==="questionari")questionnaire(c);
  else if(section==="documenti")listFiles(c,"documents","Documenti");
  else if(section==="agenda")editableList(c,"agenda","Agenda");
  else if(section==="messaggi")messageList(c);
  else if(section==="info")clientInfo(c);
  else return false;
  return true;
}
function subscriptions(){
  ui.main.innerHTML=ui.pageHead("Abbonamenti")+`<div class="sec">${ui.clienti.length?ui.clienti.map((c,i)=>row(c.nome,`${items(c,"subscriptions").length} abbonamenti`,button("mockSub"+i,"Gestisci"))).join(""):empty("Nessun cliente")}</div>`;
  $("back").onclick=()=>ui.go("home");
  ui.clienti.forEach((c,i)=>{$("mockSub"+i).onclick=()=>{ui.setClient(c,"info");editableList(c,"subscriptions","Abbonamenti",true);};});
}

function programHistory(c){
  const active=published.get(c.id);
  const entries=[...(active?[active]:[]),...(versions.get(c.id)||[]).filter(v=>v.id!==active?.version_id)];
  const ownDrafts=drafts.get(c.id)||[];
  const workouts=(snapshots.get(c.id)?.sessioni||[]).slice().sort((a,b)=>b.ts-a.ts);
  const table=entries.map((item,i)=>{
    const p=item.program, expired=(p.al||p.endDate)<today(), status=i===0&&active?"Attiva":"Archiviata";
    return `<div class="ptrow"><div class="ptc ptname">${escape(p.nome||p.name)}</div><div class="ptc" data-l="Inizio">${displayDate(p.dal||p.startDate)}</div><div class="ptc" data-l="Fine">${displayDate(p.al||p.endDate)}</div><div class="ptc" data-l="Stato"><span class="pstat ${expired?"scaduta":"corso"}">${expired?"Scaduta":status}</span></div><div class="ptc ptact">${button("mockVersion"+i,"Apri copia")}${button("mockExportVersion"+i,"Esporta")}</div></div>`;
  }).join("");
  drawClient(c,"Programmazione",`<div class="ptable"><div class="pthead"><div>Programma</div><div>Inizio programma</div><div>Fine programma</div><div>Stato</div><div></div></div>${table||row("Nessuna scheda pubblicata")}</div>
    ${ownDrafts.length?`<h2>Bozze del cliente</h2>${ownDrafts.map((d,i)=>row(d.program.nome||d.program.name||"Bozza",displayDate(d.updated_at),button("mockDraft"+i,"Apri bozza")+button("mockArchiveDraft"+i,"Archivia"))).join("")}`:""}
    <h2>Allenamenti registrati</h2>${workouts.length?workouts.slice(0,40).map(s=>`<details class="metric"><summary>${escape(s.titolo||"Seduta")} · ${displayDate(s.ts)}</summary>${(s.esercizi||[]).map(ex=>row(ex.nome,(ex.sets||[]).map(set=>`${set.kg??0} kg × ${set.reps??"—"}${ex.unita==="sec"?" s":""}${set.rir==null?"":" · RIR "+set.rir}`).join("\n"))).join("")}</details>`).join(""):row("Nessuna seduta registrata")}`,button("mockProgramList","Apri Workout",true));
  $("mockProgramList").onclick=()=>ui.go("workout");
  entries.forEach((item,i)=>{
    $("mockVersion"+i).onclick=()=>{const copy=programToMockup(item.program);ui.programmi.unshift(copy);ui.openProgramma(copy);ui.scheduleSave();};
    $("mockExportVersion"+i).onclick=()=>exportProgram(c,item,workouts);
  });
  ownDrafts.forEach((item,i)=>{$("mockDraft"+i).onclick=()=>{
    const copy=ui.programmi.find(p=>p.id===item.id)||{...programToMockup(item.program,item.id),_remote:{id:item.id,revision:item.revision,clientId:c.id}};
    if(!ui.programmi.includes(copy))ui.programmi.push(copy);
    ui.openProgramma(copy);
  };
  $("mockArchiveDraft"+i).onclick=async()=>{
    if(!confirm("Archiviare questa bozza del cliente?"))return;
    try{
      await adminCall("archiveProgramDraft",{draftId:item.id});
      const index=ui.programmi.findIndex(p=>p.id===item.id);
      if(index>=0){const saved=ui.programmi[index];delete saved._remote;saved.id=crypto.randomUUID();await saveWorkspace();}
      await loadClientRows(c);programHistory(c);
    }catch(error){fail(error);}
  };});
}

function exportProgram(c,item,workouts){
  const program=programToMockup(item.program);
  const lines=[`# ${program.nome}`,`Cliente: ${c.nome} · ${displayDate(program.dal)} – ${displayDate(program.al)}`];
  for(const week of program.weeks){
    lines.push("",`## ${week.nome}`);
    for(const day of week.giorni){
      lines.push("",`### ${day.nome}`);
      for(const ex of day.esercizi){
        lines.push(`- ${ex.nome} · ${ex.serie} × ${ex.rip} · ${[ex.carico,ex.rec,ex.rir!==""?"RIR "+ex.rir:"",ex.note].filter(Boolean).join(" · ")}`);
      }
    }
  }
  const registered=workouts.filter(s=>s.programVersionId===(item.version_id||item.id));
  if(registered.length)lines.push("","## Sedute registrate");
  for(const session of registered){
    lines.push("",`### ${session.titolo} · ${displayDate(session.ts)}`,session.nota||"");
    for(const ex of session.esercizi||[]){
      lines.push(`- ${ex.nome} · ${(ex.sets||[]).map(s=>`${s.kg} kg × ${s.reps}${s.rir==null?"":" · RIR "+s.rir}`).join(", ")}${ex.note?" · "+ex.note:""}`);
    }
  }
  const text=lines.join("\n");
  ui.openModal(`<div class="modal-h"><h3>Esporta scheda</h3><button class="modal-x" id="mX">${ui.I.x}</button></div><div class="modal-b"><textarea id="expTa" class="exp-ta" readonly></textarea></div><div class="modal-f">${button("expCopy","Copia")}${button("expDl","Scarica .md",true)}</div>`);
  $("mX").onclick=ui.closeModal;$("expTa").value=text;
  $("expCopy").onclick=()=>navigator.clipboard.writeText(text).then(()=>ui.toast("Copiato")).catch(fail);
  $("expDl").onclick=()=>{
    const url=URL.createObjectURL(new Blob([text],{type:"text/markdown"}));
    const a=document.createElement("a");a.href=url;a.download="lippolis-programma.md";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}

function saveExercise(ex) {
  if(!String(ex.nome||"").trim())return ui.toast("Inserisci il nome dell’esercizio.");
  ex.id ||= crypto.randomUUID();
  workspace.exerciseEdits[ex.id]={...ex};
  return saveWorkspace(true);
}
function createExercise() {
  showModal("Aggiungi esercizio",field("mockExerciseName","Nome","text","",true),"Crea",async()=>{
    const ex={id:crypto.randomUUID(),nome:val("mockExerciseName"),muscolo:"",clip:false};
    if(!ex.nome)throw new Error("Inserisci il nome.");
    ui.libreria.unshift(ex);await saveExercise(ex);ui.openEsercizio(ex);
  });
}
function exerciseAttachments(ex) {
  let file=null;
  const input=document.createElement("input");input.type="file";input.accept="image/jpeg,image/png,image/webp,video/mp4,video/webm";input.hidden=true;ui.main.append(input);
  const drop=$("exDrop"), group=drop.parentElement, urlInput=document.createElement("input");
  urlInput.className="inp";urlInput.placeholder="https://…";urlInput.value=ex.video||"";urlInput.hidden=true;drop.after(urlInput);
  const choose=(value)=>{if(value){file=value;drop.querySelector(".dz-t").textContent=value.name;}};
  const switchMode=mode=>{
    drop.hidden=mode==="link";urlInput.hidden=mode!=="link";
    group.querySelectorAll("[data-at]").forEach(b=>b.classList.toggle("on",b.dataset.at===mode));
  };
  group.querySelectorAll("[data-at]").forEach(b=>b.onclick=()=>switchMode(b.dataset.at));
  drop.onclick=()=>input.click();input.onchange=()=>choose(input.files[0]);
  drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();choose(e.dataTransfer.files[0]);};
  const card=group.querySelector(".att-card");
  card.hidden=!(ex.video||ex.attachmentPath||ex.videoStoragePath);
  if(!card.hidden){
    card.querySelector(".att-meta .t").textContent=ex.attachmentName||"Allegato";
    card.querySelector(".att-thumb").onclick=()=>{
      if(ex.video){const media=parseExerciseVideo(ex.video);if(media)window.open(media.url,"_blank","noopener,noreferrer");}
      else openFile("coach-exercise-files",ex.attachmentPath||ex.videoStoragePath).catch(fail);
    };
  }
  $("attAdd").onclick=async(event)=>{
    event.currentTarget.disabled=true;
    try{
      if(!urlInput.hidden){
        const media=parseExerciseVideo(urlInput.value);
        if(!media)throw new Error("Inserisci un link HTTPS a YouTube, Vimeo, MP4 o WebM.");
        ex.video=media.url;ex.videoStoragePath="";ex.attachmentPath="";
      }else{
        const path=await uploadFile("coach-exercise-files",uid,file);
        ex.attachmentPath=path;ex.videoStoragePath=file.type.startsWith("video/")?path:"";ex.video="";
      }
      ex.attachmentName=val("attNome")||file?.name||"Video dimostrativo";ex.clip=!!(ex.video||ex.videoStoragePath);
      if(await saveExercise(ex))ui.renderEsercizio();
    }catch(error){fail(error);}
    finally{if($("attAdd"))$("attAdd").disabled=false;}
  };
  $("attDel").onclick=async()=>{if(!confirm("Rimuovere l’allegato dalla libreria?"))return;Object.assign(ex,{video:"",videoStoragePath:"",attachmentPath:"",attachmentName:"",clip:false});if(await saveExercise(ex))ui.renderEsercizio();};
}

function settings(panel,tab){
  if(tab==="generali"){
    panel.innerHTML=`<div class="set-title">Generali</div><div class="set-sec"><div class="set-sec-h">Dati personali</div><div class="avatar-edit">${escape(ui.initials(ui.COACH.name))}</div>
      <div class="fld-row">${field("mockCoachFirst","Nome","text",profile.firstName,true)}${field("mockCoachLast","Cognome","text",profile.lastName,true)}</div>
      ${field("mockCoachEmail","Indirizzo email","email",profile.email)}${button("mockCoachSave","Salva modifiche",true)}
      </div><div class="set-sec"><div class="set-sec-h">Gestione account</div>${button("mockCoachPassword","Cambia password")}${button("mockLogout","Esci dall’account")}</div>`;
    $("mockCoachEmail").readOnly=true;
    $("mockCoachSave").onclick=async()=>{
      const first=val("mockCoachFirst"),last=val("mockCoachLast");
      if(!first||!last)return ui.toast("Compila nome e cognome.");
      try{
        const row=checked(await supabase.from("profiles").update({first_name:first,last_name:last,display_name:first+" "+last,updated_at:new Date().toISOString()}).eq("id",uid).select().single());
        profile=profileFromRow(row);updateIdentity();ui.toast("Profilo salvato");
      }catch(error){fail(error);}
    };
    $("mockLogout").onclick=signOutCoach;
    $("mockCoachPassword").onclick=()=>showModal("Cambia password",field("mockNewPassword","Nuova password","password","",true)+field("mockConfirmPassword","Ripeti la password","password","",true),"Salva password",async()=>{
      const password=val("mockNewPassword");if(password.length<12||password!==val("mockConfirmPassword"))throw new Error("Usa almeno 12 caratteri e ripeti la stessa password.");
      checked(await supabase.auth.updateUser({password}));ui.toast("Password aggiornata");
    });
    return;
  }
  const question=tab==="questionari", entries=question?workspace.templates:workspace.collaborators;
  panel.innerHTML=`<div class="set-title">${question?"Questionari":"Collaboratori"}</div>
    ${question?"":'<p class="set-note">Rubrica dei collaboratori del PT.</p>'}
    ${button("mockSettingAdd",question?"Crea questionario":"Aggiungi contatto",true)}
    <div class="list">${entries.map((item,i)=>row(item.title,question?`${item.questions.length} domande`:item.email,button("mockSettingEdit"+i,"Modifica")+button("mockSettingRemove"+i,"Elimina"))).join("")||empty(question?"Nessun modello":"Nessun collaboratore")}</div>`;
  const edit=(item)=>showModal(question?"Modello questionario":"Collaboratore",field("mockSettingTitle",question?"Titolo":"Nome","text",item?.title,true)+(question?textarea("mockSettingBody","Una domanda per riga",item?.questions.join("\n")):field("mockSettingBody","Email","email",item?.email,true)),"Salva",async()=>{
    const title=val("mockSettingTitle"),body=val("mockSettingBody");if(!title||!body)throw new Error("Compila i campi.");
    const result={id:item?.id||crypto.randomUUID(),title,...(question?{questions:body.split(/\r?\n/).map(q=>q.trim()).filter(Boolean).slice(0,30)}:{email:body})};
    if(item)entries.splice(entries.indexOf(item),1,result);else entries.push(result);
    if(!await saveWorkspace())throw new Error("Salvataggio non riuscito.");
    settings(panel,tab);
  });
  $("mockSettingAdd").onclick=()=>edit();
  entries.forEach((it,i)=>{$("mockSettingEdit"+i).onclick=()=>edit(it);$("mockSettingRemove"+i).onclick=async()=>{if(confirm("Rimuovere la voce?")){entries.splice(i,1);if(await saveWorkspace())settings(panel,tab);}};});
}

function clientBia(c){
  const data=(snapshots.get(c.id)?.bia||[]).slice().sort((a,b)=>Date.parse(b.measuredAt)-Date.parse(a.measuredAt));
  const plots=[["weightKg","Peso"],["skeletalMuscleKg","Massa muscolare"],["fatFreeMassKg","Massa magra"]].map(([key,title])=>{
    const points=data.slice().reverse().filter(r=>r[key]!=null&&Number.isFinite(Number(r[key]))).map(r=>({v:Number(r[key]),l:displayDate(r.measuredAt)}));
    return points.length>1?`<section class="metric"><h3>${title}</h3>${ui.buildChart(points.slice(-12))}</section>`:"";
  }).join("");
  const records=data.map((r,i)=>row(displayDate(r.measuredAt),`Peso ${r.weightKg} kg · Muscolo ${r.skeletalMuscleKg} kg · Massa magra ${r.fatFreeMassKg??"—"} kg`,r.reportPath?button("mockBiaFile"+i,"Apri referto"):"")).join("");
  drawClient(c,"Referti BIA",plots+records||empty("Nessuna rilevazione"),button("mockBiaAdd","Carica referto",true)+button("mockBiaMetrics","Metriche")+(plots?button("mockBiaPrint","Stampa andamento"):""));
  $("mockBiaMetrics").onclick=()=>ui.renderCliMetriche(c);
  if(plots)$("mockBiaPrint").onclick=()=>window.print();
  data.forEach((r,i)=>{if(r.reportPath)$("mockBiaFile"+i).onclick=()=>openFile("bia-reports",r.reportPath).catch(fail);});
  $("mockBiaAdd").onclick=()=>{
    let result,file;
    const fields={measuredAtLocal:"Data e ora del referto",weightKg:"Peso (kg)",skeletalMuscleKg:"Massa muscolare (kg)",bodyFatMassKg:"Massa grassa (kg)",targetWeightKg:"Peso obiettivo (kg)"};
    showModal("Carica referto BIA",'<input type="file" id="mockBiaInput" accept="image/jpeg,image/png,image/webp,image/heic,.heic,.pdf,application/pdf"><p id="mockBiaStatus" role="status"></p><div id="mockBiaPreview"></div><p id="mockBiaLean"></p>'+Object.entries(fields).map(([k,label])=>field("mockBia_"+k,label,k==="measuredAtLocal"?"datetime-local":"text","",k!=="targetWeightKg")).join("")+'<label><input type="checkbox" id="mockBiaConfirm"> Ho confrontato i valori con il referto.</label>',"Conferma e salva",async()=>{
      if(!result||!file||!$("mockBiaConfirm").checked)throw new Error("Carica il referto e verifica i valori.");
      const date=new Date(val("mockBia_measuredAtLocal"));if(!Number.isFinite(date.valueOf()))throw new Error("Data non valida.");
      const numeric=Object.keys(fields).filter(k=>k!=="measuredAtLocal");
      const values=Object.fromEntries(numeric.map(k=>[k,val("mockBia_"+k)===""?null:Number(val("mockBia_"+k).replace(",","."))]));
      if(Object.values(values).some(n=>n!==null&&!Number.isFinite(n)))throw new Error("Controlla i valori numerici.");
      const ext={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/heic":"heic","application/pdf":"pdf"}[result.fileType];
      const base=c.id+"/"+crypto.randomUUID(),reportPath=base+"."+ext,reportPreviewPath=base+"-preview.jpg";
      const blob=await new Promise(resolve=>result.preview.toBlob(resolve,"image/jpeg",.86));
      if(!ext||!blob)throw new Error("Anteprima del referto non disponibile.");
      checked(await supabase.storage.from("bia-reports").upload(reportPath,file,{contentType:result.fileType}));
      try{checked(await supabase.storage.from("bia-reports").upload(reportPreviewPath,blob,{contentType:"image/jpeg"}));}
      catch(error){await supabase.storage.from("bia-reports").remove([reportPath]);throw error;}
      await adminCall("recordBia",{clientUid:c.id,measuredAt:date.toISOString(),...values,reportPath,reportPreviewPath,
        sourceAudit:{confirmation:{manuallyConfirmed:true},fields:Object.fromEntries(requiredBiaFields.map(k=>[k,{status:"ok",source:"verificato_dal_pt",confidence:1,bbox:null}]))}});
      await loadClientRows(c);clientBia(c);ui.toast("Referto salvato");
    });
    const updateLean=()=>{
      const weight=val("mockBia_weightKg"),fat=val("mockBia_bodyFatMassKg");
      const lean=Number(weight.replace(",","."))-Number(fat.replace(",","."));
      $("mockBiaLean").textContent=weight&&fat&&Number.isFinite(lean)&&lean>0?"Massa magra calcolata: "+lean.toLocaleString("it-IT",{maximumFractionDigits:2})+" kg":"";
    };
    $("mockBia_weightKg").oninput=$("mockBia_bodyFatMassKg").oninput=updateLean;
    $("mockBiaInput").onchange=async(event)=>{
      const candidate=event.target.files[0];if(!candidate)return;
      result=null;file=candidate;const status=$("mockBiaStatus"),save=$("mockModalSave");save.disabled=true;
      try{
        const recognized=await recognizeInBodyPhoto(file,p=>{status.textContent=p.status;});
        if(file!==candidate||!status.isConnected)return;
        result=recognized;
        result.preview.className="mock-photo";$("mockBiaPreview").replaceChildren(result.preview);
        for(const k of Object.keys(fields))if(result.fields?.[k]?.value!=null)$("mockBia_"+k).value=result.fields[k].value;
        updateLean();
        status.textContent="Controlla e conferma i valori.";
      }catch(error){status.textContent=friendlyAuthError(error);}
      finally{if(status.isConnected&&file===candidate)save.disabled=false;}
    };
  };
}

function recipes(host) {
  host.innerHTML=`<div class="list">${button("mockRecipeAdd","Aggiungi ricetta",true)}${workspace.recipes.map((it,i)=>row(it.title,it.detail,button("mockRecipe"+i,"Modifica"))).join("")||empty("Nessuna ricetta")}</div>`;
  const edit=(it)=>showModal("Ricetta",field("mockRecipeTitle","Nome","text",it?.title,true)+textarea("mockRecipeDetail","Ingredienti e preparazione",it?.detail),"Salva",async()=>{
    const entry={id:it?.id||crypto.randomUUID(),title:val("mockRecipeTitle"),detail:val("mockRecipeDetail")};
    if(it)workspace.recipes.splice(workspace.recipes.indexOf(it),1,entry);else workspace.recipes.push(entry);
    if(!await saveWorkspace())throw new Error("Salvataggio non riuscito.");recipes(host);
  });
  $("mockRecipeAdd").onclick=()=>edit();workspace.recipes.forEach((it,i)=>{$("mockRecipe"+i).onclick=()=>edit(it);});
}

function updateIdentity(){
  ui.COACH.name=profile.firstName||profile.displayName||"PT";
  document.querySelector(".coach-meta .cn").textContent=profile.displayName||ui.COACH.name;
  document.querySelector(".coach-av").textContent=ui.initials(profile.displayName||ui.COACH.name);
}
async function start(){
  secureMarkup();
  ui.main.textContent="Caricamento area PT…";
  try{
    const session=await getAuthorizedSession({requireRole:"coach"});
    if(session.reason){ location.replace("index.html");return; }
    profile=session.profile;uid=session.user.uid;updateIdentity();
    $("coachLogout").disabled=false;
    const saved=checked(await supabase.from("coach_workspaces").select("content,revision").eq("coach_id",uid).maybeSingle());
    for(const ex of ui.libreria)ex.id="catalog:"+ex.nome;
    if(saved){
      workspaceRevision=saved.revision;const {programs,mealPlans,notifications,...rest}=saved.content;
      workspace={...workspace,...rest};
      replace(ui.programmi,programs||[]);replace(ui.pianiAlimentari,mealPlans||[]);
      (notifications||[]).forEach((enabled,i)=>{if(ui.notifiche[i])ui.notifiche[i].on=!!enabled;});
      for(const [id,value] of Object.entries(workspace.exerciseEdits)){
        const found=ui.libreria.find(ex=>ex.id===id);
        if(found)Object.assign(found,value);else ui.libreria.unshift(value);
      }
    }
    await loadDirectory();
    workspaceSignature=JSON.stringify(workspacePayload());workspaceLoaded=true;
    const badge=document.createElement("div");
    badge.className="autosave";
    badge.innerHTML='<span class="as-dot"></span><span id="asTxt" role="status">Salvataggio automatico</span>';
    document.body.append(badge);
    $("brand").disabled=false;ui.go("home");
    let update;
    const reload=()=>{clearTimeout(update);update=setTimeout(async()=>{try{await loadDirectory();if(["home","priorita","revisione","agenda"].includes(ui.view))ui.render();}catch(error){fail(error);}},300);};
    let feed=supabase.channel("coach-mockup:"+uid);
    for(const table of ["athlete_states","programs","profiles","messages","coach_client_sections"])feed=feed.on("postgres_changes",{event:"*",schema:"public",table},reload);
    feed.subscribe();
  }catch(error){
    ui.main.innerHTML=empty("Connessione non riuscita",friendlyAuthError(error))+button("mockRetry","Riprova",true);
    $("mockRetry").onclick=()=>location.reload();
  }
}
window.CoachDB={saveWorkspace,saveProgram,assignProgram,publishNutrition,createClient,openClient,programHistory,clientSection,subscriptions,addMeasure,metricActions,createExercise,saveExercise,exerciseAttachments,settings,sendPriority,storeSignal,recipes};
$("coachLogout").onclick=signOutCoach;
void start();
