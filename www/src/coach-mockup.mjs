import { adminCall, supabase, profileFromRow } from "./supabase.mjs";
import { getAuthorizedSession, friendlyAuthError, logout } from "./auth.mjs";
import { athleteSessions, athleteWeightHistory, clientProgramList, mockupToProgram, programToMockup, nutritionSummary } from "./coach-mockup-model.mjs";
import { parseExerciseVideo } from "./exercise-video.mjs";
import { recognizeInBodyPhoto, requiredBiaFields } from "./bia-ocr.mjs";
import { markChatRead } from "./chat.mjs";
import { createNotifications } from "./notifications.mjs";
import { listProgressPhotos, PHOTO_BUCKET } from "./progress-photos.mjs";

const ui = window.CoachMock, $ = (id) => document.getElementById(id);
const escape = (v) => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const replace = (array, list) => array.splice(0,array.length,...list);
const today = () => new Date().toLocaleDateString("sv-SE");
const displayDate = (value) => value && !Number.isNaN(new Date(value).valueOf()) ? new Intl.DateTimeFormat("it-IT",{dateStyle:"medium"}).format(new Date(value)) : "—";
const val = (id) => $(id)?.value.trim() || "";
const row = (title, detail="", action="") => `<div class="row"><span class="row-main"><span class="row-t">${escape(title)}</span><span class="row-s mock-multiline">${escape(detail)}</span></span>${action}</div>`;
const empty = (title,detail="") => `<div class="empty"><div class="ic">${ui.I.doc}</div><h2>${escape(title)}</h2><p>${escape(detail)}</p></div>`;
const button = (id,label,primary=false) => `<button type="button" class="btn btn-${primary?"primary":"ghost"}" id="${id}">${label}</button>`;
const field = (id,label,type="text",value="",required=false,autocomplete="") =>
  `<label class="fld"><span>${label}</span><input class="inp" id="${id}" type="${type}" value="${escape(value)}"${required?" required":""}${autocomplete?` autocomplete="${autocomplete}"`:""}></label>`;
const textarea = (id,label,value="") => `<label class="fld"><span>${label}</span><textarea class="ta" id="${id}" rows="4">${escape(value)}</textarea></label>`;
const fail = (err) => ui.toast(friendlyAuthError(err));
const checked = ({data,error}) => { if(error) throw error; return data; };
const sectionRows = new Map(), snapshots = new Map(), stateRevisions = new Map(), published = new Map(), versions = new Map(), drafts = new Map();
const sectionWrites = new Map();
let profile, uid, workspaceRevision=0, workspaceSignature="", saveQueue=Promise.resolve(), selectEpoch=0, loadEpoch=0, workspaceLoaded=false;
let alerts;
let workspace = {exerciseEdits:{}, templates:[], collaborators:[], priority:{}, recipes:[], preferences:{}};
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
    mealPlans:ui.pianiAlimentari.map(p=>({...p,id:p.id ||= crypto.randomUUID()}))};
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
    supabase.from("athlete_states").select("snapshot,revision").eq("user_id",client.id).maybeSingle(),
    supabase.from("programs").select("*").eq("athlete_id",client.id).maybeSingle(),
    supabase.from("program_versions").select("*").eq("athlete_id",client.id).order("published_at",{ascending:false}).limit(40),
    supabase.from("program_drafts").select("*").eq("athlete_id",client.id).eq("coach_id",uid).eq("status","draft").order("updated_at",{ascending:false}).limit(40),
    supabase.from("coach_client_sections").select("*").eq("athlete_id",client.id)
  ]);
  cacheClientSnapshot(client.id,checked(snapshot));
  const plan=checked(current); if(plan)published.set(client.id,plan); else published.delete(client.id);
  versions.set(client.id,checked(history)); drafts.set(client.id,checked(clientDrafts));
  for(const section of checked(sections)){
    const id=key(client,section.section);
    if(Number(section.revision)>=Number(sectionRows.get(id)?.revision||0))sectionRows.set(id,section);
  }
}
function cacheClientSnapshot(clientId,state){
  const revision=state?.revision||0;
  if(state&&revision<=(stateRevisions.get(clientId)??-1))return false;
  snapshots.set(clientId,state?.snapshot||{});
  stateRevisions.set(clientId,revision);
  return true;
}
async function loadDirectory() {
  const epoch=++loadEpoch;
  const [people,plans,sections,clientDrafts,urgent]=await Promise.all([
    supabase.from("profiles").select("*").eq("trainer_id",uid).eq("role","athlete").order("last_name"),
    supabase.from("programs").select("*").eq("coach_id",uid),
    supabase.from("coach_client_sections").select("*"),
    supabase.from("program_drafts").select("*").eq("coach_id",uid).eq("status","draft"),
    supabase.from("messages").select("id,athlete_id,text,created_at").eq("type","urgenza").order("created_at",{ascending:false}).limit(100)
  ]);
  if(epoch!==loadEpoch)return;
  replace(ui.clienti,checked(people).map(p=>({...p,nome:p.display_name||`${p.first_name} ${p.last_name}`,reg:p.created_at?.slice(0,10)||today(),attivo:p.status==="active"})));
  published.clear(); for(const p of checked(plans))published.set(p.athlete_id,p);
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
  const priorities=[], dates=[];
  for(const c of ui.clienti){
    const active=published.get(c.id), end=active?.program?.al||active?.program?.endDate, start=active?.program?.dal||active?.program?.startDate;
    const title=active?.program?.nome||active?.program?.name||"Scheda";
    if(start)dates.push({id:`start:${c.id}:${active.version_id}`,date:start,clientName:c.nome,title,kind:"start"});
    if(end)dates.push({id:`end:${c.id}:${active.version_id}`,date:end,clientName:c.nome,title,kind:"end"});
    for(const event of items(c,"agenda")){
      dates.push({id:event.id,date:event.date,clientId:c.id,clientName:c.nome,title:event.title,detail:event.detail,kind:"reminder"});
    }
    if(!c.attivo)continue;
    for(const message of urgentMessages.filter(m=>m.athlete_id===c.id).slice(0,5)){
      const id=c.id+":urgent:"+message.id;
      const status=workspace.priority[id];
      priorities.push({id:priorities.length+1,key:id,clientId:c.id,cliente:c.nome,urgenza:"alta",fonte:"chat",tag:"Segnalazione",
        titolo:"Segnalazione del cliente",evidenza:String(message.text||"").replace(/<[^>]*>/g," ").slice(0,380),azione:"Apri la conversazione e valuta la segnalazione.",cta:"Rispondi",tono:"rassicurante",
        messaggio:`Ciao ${c.first_name}, ho letto la tua segnalazione. Puoi dirmi come va adesso?`,...(status?.stato==="rimandato"&&status.date!==today()?{messaggio:status.messaggio}:status)});
    }
    const days=end?Math.round((Date.parse(end)-Date.parse(today()))/86400000):null;
    const priorityTitle=!active?"Scheda da assegnare":days<0?"Scheda scaduta":days!=null&&days<=7?"Scheda in scadenza":"";
    if(priorityTitle){
      const id=`${c.id}:${active?.version_id||"no-program"}:${priorityTitle}`, status=workspace.priority[id];
      priorities.push({id:priorities.length+1,key:id,clientId:c.id,cliente:c.nome,urgenza:!active||days<0?"alta":"media",fonte:"auto",tag:"Programmazione",titolo:priorityTitle,
        evidenza:end?`Fine scheda: ${displayDate(end)}`:"Nessuna scheda pubblicata.",azione:"Apri la programmazione del cliente.",cta:"Invia messaggio",tono:"rassicurante",
        messaggio:`Ciao ${c.first_name}, sto aggiornando la tua programmazione. Scrivimi se hai domande.`, ...(status?.stato==="rimandato"&&status.date!==today()?{messaggio:status.messaggio}:status)});
    }
  }
  replace(ui.prioritaOggi,priorities);replace(ui.scadenze,dates);
  checkCalendarAlerts();
}

function checkCalendarAlerts(){
  const date=today();
  const events=ui.calendarEvents(date.slice(0,7)).filter(event=>event.date===date)
    .map(event=>({id:`${event.kind}:${event.id}`,title:`${event.clientName} · ${ui.calendarKinds[event.kind]} · ${event.title}`}));
  void alerts?.calendar(date,events);
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

function confirmNutritionDayDeletion(day,remove){
  showModal("Elimina giornata",`<p>Eliminare «${escape(day.nome)}» dal piano insieme ai suoi pasti e alle note?</p>`,"Elimina",remove);
  $("mockModalCancel").focus();
}

function createClient(){
  showModal("Aggiungi cliente","<p>Genera un link da inviare al cliente. Potrà usarlo una volta entro 7 giorni per creare il suo account.</p>","Genera invito",async ()=>{
    const token=checked(await supabase.rpc("create_client_invite"));
    const link=new URL("invito.html",location.href);
    link.hash=new URLSearchParams({token}).toString();
    showModal("Invito cliente",`<p>Condividi questo link con il cliente.</p><label class="fld">Link di invito<input class="inp" id="mockInvite" readonly value="${escape(link.href)}"></label>${button("mockCopyInvite","Copia link")}<p id="mockInviteStatus" role="status"></p>`,"Chiudi",async()=>{});
    $("mockCopyInvite").onclick=async()=>{
      try{await navigator.clipboard.writeText(link.href);$("mockInviteStatus").textContent="Link copiato.";}
      catch{$("mockInvite").select();$("mockInviteStatus").textContent="Copia il link selezionato.";}
    };
  });
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
  const progress=photos?`<section class="weight-panel"><div class="progress-coach-header"><h2>Foto del cliente</h2>${button("mockRefreshAthletePhotos","Aggiorna")}</div><div id="mockAthletePhotos"><p class="progress-copy">Caricamento foto…</p></div></section>
    <section class="progress-coach-files"><h2 class="progress-photo-heading">Foto aggiunte dal PT</h2>${gallery||'<p class="progress-copy">Nessuna foto aggiunta dal PT.</p>'}</section>`:"";
  drawClient(c,title,previewControl+(photos?progress:rows||empty("Nessun documento")),button("mockAddFile",photos?"Aggiungi foto":"Aggiungi documento",true));
  if(photos)$("mockBlurPhotos").onclick=()=>{
    workspace.preferences.blurPhotos=!workspace.preferences.blurPhotos;
    ui.scheduleSave();listFiles(c,section,title);
  };
  if(photos){
    $("mockRefreshAthletePhotos").onclick=()=>loadAthleteProgressPhotos(c);
    void loadAthleteProgressPhotos(c);
  }
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
async function loadAthleteProgressPhotos(client){
  const host=$("mockAthletePhotos"), refresh=$("mockRefreshAthletePhotos");
  if(!host||refresh.disabled)return;
  refresh.disabled=true;
  try{
    const photos=await listProgressPhotos(client.id);
    if(!host.isConnected)return;
    host.className=photos.length?"progress-grid":"";
    host.innerHTML=photos.map((photo,index)=>`<article class="progress-photo"><button type="button" class="progress-photo-open${workspace.preferences.blurPhotos?" progress-preview-blur":""}" data-progress-open="${index}" aria-label="Apri foto del ${displayDate(photo.date)}"><img loading="lazy" alt="Foto del ${displayDate(photo.date)}"></button><div class="progress-photo-info">${displayDate(photo.date)}</div></article>`).join("")||'<p class="progress-copy">Il cliente non ha ancora condiviso foto.</p>';
    host.querySelectorAll("[data-progress-open]").forEach(button=>{
      const photo=photos[Number(button.dataset.progressOpen)];
      const image=button.querySelector("img");
      signed(PHOTO_BUCKET,photo.path).then(url=>{if(button.isConnected)image.src=url;})
        .catch(()=>{image.alt="Anteprima non disponibile";});
      button.onclick=()=>openFile(PHOTO_BUCKET,photo.path).catch(fail);
    });
  }catch{
    if(host.isConnected){
      host.innerHTML='<p class="progress-copy">Impossibile caricare le foto.</p>'+button("mockRetryAthletePhotos","Riprova");
      $("mockRetryAthletePhotos").onclick=()=>loadAthleteProgressPhotos(client);
    }
  }finally{refresh.disabled=false;}
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
function editCalendarReminder(event,defaultDate){
  const clientField=event?"":`<label class="fld"><span>Cliente</span><select class="sel" id="calendarClient">${ui.clienti.map(client=>`<option value="${escape(client.id)}">${escape(client.nome)}</option>`).join("")}</select></label>`;
  const fields=clientField+field("calendarTitle","Titolo","text",event?.title,true)
    +field("calendarDate","Data","date",event?.date||defaultDate,true)
    +textarea("calendarNote","Note",event?.detail);
  showModal(event?"Modifica promemoria":"Aggiungi promemoria",fields,"Salva",async()=>{
    const client=ui.clienti.find(item=>item.id===(event?.clientId||val("calendarClient")));
    const title=val("calendarTitle"), date=val("calendarDate");
    if(!client||!title||!date)throw new Error("Indica cliente, titolo e data.");
    const record={id:event?.id||crypto.randomUUID(),title,date,detail:val("calendarNote")};
    await changeSection(client,"agenda",content=>({...content,items:[...(content.items||[]).filter(item=>item.id!==record.id),record]}));
    refreshSignals();
    ui.renderHomeCalendar(date);
  });
}
function deleteCalendarReminder(event){
  const client=ui.clienti.find(item=>item.id===event.clientId);
  if(!client)return;
  showModal("Elimina promemoria",`<p>${escape(event.title)} · ${escape(client.nome)}</p>`,"Elimina",async()=>{
    await changeSection(client,"agenda",content=>({...content,items:(content.items||[]).filter(item=>item.id!==event.id)}));
    refreshSignals();
    ui.renderHomeCalendar();
  });
}
let chatClient=null, inbox=[], inboxRequest=0, threadRequest=0, inboxLoaded=false;
const chatTime=(value)=>value?new Intl.DateTimeFormat("it-IT",{hour:"2-digit",minute:"2-digit"}).format(new Date(value)):"";
function paintChatContacts(){
  const list=$("chatContacts");
  if(!list)return;
  const search=val("chatSearch").toLocaleLowerCase("it");
  const contacts=inbox.filter(c=>c.nome.toLocaleLowerCase("it").includes(search)||c.email?.toLocaleLowerCase("it").includes(search));
  list.innerHTML=contacts.map(c=>`<button type="button" class="chat-contact" data-chat-id="${escape(c.id)}" aria-current="${chatClient===c.id}"><span class="chat-avatar">${escape(ui.initials(c.nome))}</span><span class="chat-contact-copy"><strong>${escape(c.nome)}</strong><small>${escape(c.latest_text||"Nessun messaggio")}</small></span><span class="chat-contact-meta">${chatTime(c.latest_at)}${c.unread?`<span class="chat-count" aria-label="${c.unread} non letti">${c.unread}</span>`:""}</span></button>`).join("")||'<p class="chat-empty">Nessuna conversazione trovata</p>';
  list.querySelectorAll("[data-chat-id]").forEach(button=>button.onclick=()=>openCoachChat(button.dataset.chatId));
}
async function refreshInbox(){
  const request=++inboxRequest;
  const data=checked(await supabase.rpc("coach_chat_inbox"));
  if(request!==inboxRequest)return;
  const byId=new Map(data.map(item=>[item.athlete_id,item]));
  const previous=new Map(inbox.map(item=>[item.id,item]));
  inbox=ui.clienti.map(c=>({...c,...byId.get(c.id)})).sort((a,b)=>
    Number(!!b.unread)-Number(!!a.unread)||(Date.parse(b.latest_at)||0)-(Date.parse(a.latest_at)||0)||a.nome.localeCompare(b.nome,"it"));
  const incoming=inboxLoaded&&inbox.find(item=>Number(item.unread||0)>Number(previous.get(item.id)?.unread||0)
    &&(document.hidden||ui.view!=="chat"||chatClient!==item.id));
  if(incoming){
    void alerts?.notify("chat",{title:"Nuovo messaggio",body:`${incoming.nome} ti ha scritto.`,
      systemBody:"Un cliente ti ha scritto.",action:"Apri chat",destination:"chat",clientId:incoming.id});
  }
  inboxLoaded=true;
  const total=inbox.reduce((sum,item)=>sum+Number(item.unread||0),0);
  const badge=$("coachChatUnread");
  badge.hidden=!total;badge.textContent=total>99?"99+":String(total);
  $("coachChat").setAttribute("aria-label",total?`Chat, ${total} non letti`:"Chat");
  paintChatContacts();
}
async function refreshCoachThread(){
  const log=$("chatLog"), client=chatClient;
  if(!log||!client)return;
  const request=++threadRequest;
  const messages=checked(await supabase.from("messages").select("*").eq("athlete_id",client).eq("channel","thread")
    .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(150)).reverse();
  if(request!==threadRequest||!log.isConnected||chatClient!==client)return;
  const atBottom=!log.dataset.loaded||log.scrollHeight-log.scrollTop-log.clientHeight<64;
  log.innerHTML=messages.map(m=>`<div class="chat-bubble${m.sender_id===uid?" mine":""}">${m.type==="urgenza"?"<strong>Urgenza</strong><br>":""}${escape(m.text)}<time datetime="${escape(m.created_at)}">${escape(displayDate(m.created_at))} · ${chatTime(m.created_at)}${m.sender_id===uid&&m.read_at?" · Letto":""}</time></div>`).join("")||'<p class="chat-empty">Nessun messaggio. Inizia la conversazione.</p>';
  log.dataset.loaded="1";
  if(atBottom)log.scrollTop=log.scrollHeight;
  if(!document.hidden&&messages.some(m=>m.sender_id!==uid&&!m.read_at)){
    await markChatRead(client,messages,uid);
    await refreshInbox();
  }
}
const chatDrafts=new Map();
function openCoachChat(clientId){
  chatClient=clientId;
  if(ui.view!=="chat"){ui.go("chat");return;}
  paintChatContacts();
  paintChatPanel();
}
function paintChatPanel(){
  const panel=$("chatPanel"), client=ui.clienti.find(c=>c.id===chatClient);
  if(!panel)return;
  $("chatShell").classList.toggle("has-chat",!!client);
  if(!client){panel.innerHTML='<p class="chat-empty">Seleziona un cliente</p>';return;}
  panel.innerHTML=`<div class="chat-title"><button type="button" class="back" data-mobile-back aria-label="Torna alle conversazioni">${ui.I.chevL}</button><span class="chat-avatar">${escape(ui.initials(client.nome))}</span><strong>${escape(client.nome)}</strong></div>
    <div class="chat-log" id="chatLog" role="log" aria-label="Messaggi"></div>
    <div class="chat-compose"><textarea id="chatText" rows="1" maxlength="4000" aria-label="Scrivi un messaggio" placeholder="Scrivi un messaggio…"></textarea><button type="button" id="chatSend" class="btn btn-primary">Invia</button></div><p id="chatStatus" class="chat-status" role="status"></p>`;
  panel.querySelector("[data-mobile-back]").onclick=()=>openCoachChat(null);
  const send=$("chatSend"), input=$("chatText"), status=$("chatStatus");
  input.value=chatDrafts.get(client.id)||"";
  input.oninput=()=>chatDrafts.set(client.id,input.value);
  input.onkeydown=event=>{
    if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){event.preventDefault();send.click();}
  };
  send.onclick=async()=>{
    const text=input.value.trim();
    if(!text||send.disabled)return;
    send.disabled=true;status.textContent="";
    try{
      await sendMessage(client.id,text);
      if(input.value.trim()===text){input.value="";chatDrafts.delete(client.id);}
      if(input.isConnected){input.focus();await refreshCoachThread();}
      await refreshInbox();
    }catch(error){status.textContent=friendlyAuthError(error);}
    finally{send.disabled=false;}
  };
  void refreshCoachThread().catch(error=>{status.textContent=friendlyAuthError(error);});
}
function renderInbox(){
  ui.main.innerHTML=ui.pageHead("Chat",button("chatNotify","Impostazioni notifiche"))+
    '<div class="chat-shell" id="chatShell"><aside class="chat-sidebar" aria-label="Conversazioni"><input id="chatSearch" type="search" aria-label="Cerca cliente" placeholder="Cerca cliente…"><div id="chatContacts" class="chat-contacts"></div></aside><section class="chat-panel" id="chatPanel"></section></div>';
  $("back").onclick=()=>ui.go("home");
  $("chatSearch").oninput=paintChatContacts;
  $("chatNotify").onclick=()=>ui.openNotificationSettings();
  paintChatContacts();
  paintChatPanel();
  void refreshInbox().catch(fail);
}
async function sendMessage(clientId,text){
  checked(await supabase.from("messages").insert({athlete_id:clientId,sender_id:uid,target_id:clientId,channel:"thread",text}));
}
function sendPriority(it,btn){
  btn.disabled=true;
  sendMessage(it.clientId,it.messaggio).then(()=>{
    it.stato="inviato";storeSignal(it);ui.fillPriorita();ui.toast("Messaggio inviato");
  }).catch(error=>{btn.disabled=false;fail(error);});
}
function storeSignal(it){
  if(!it?.key)return;
  if(it.stato)workspace.priority[it.key]={stato:it.stato,date:today()};
  else delete workspace.priority[it.key];
  if(it.messaggio)workspace.priority[it.key]={...workspace.priority[it.key],messaggio:it.messaggio};
  ui.scheduleSave();
}
function clientInfo(c){
  drawClient(c,"Informazioni generali",row(c.nome,c.email)+row("Accesso",c.attivo?"Attivo":"Sospeso")+button("mockAccess",c.attivo?"Sospendi accesso":"Riattiva accesso")+button("mockExport","Esporta dati")+button("mockDeleteClient","Elimina cliente"));
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
  else if(section==="storico-pesi")clientWeightHistory(c);
  else if(section==="progressi")listFiles(c,"progress","Progressi fisici");
  else if(section==="questionari")questionnaire(c);
  else if(section==="documenti")listFiles(c,"documents","Documenti");
  else if(section==="messaggi")openCoachChat(c.id);
  else if(section==="info")clientInfo(c);
  else return false;
  return true;
}

const weightNumber=new Intl.NumberFormat("it-IT",{maximumFractionDigits:2});
const weightSigned=new Intl.NumberFormat("it-IT",{signDisplay:"exceptZero",maximumFractionDigits:2});
const weightShortDate=new Intl.DateTimeFormat("it-IT",{day:"numeric",month:"short"});
const weightHistory=client=>athleteWeightHistory(snapshots.get(client.id));
const countLabel=(count,singular,plural)=>`${count} ${count===1?singular:plural}`;

function weightHistoryOverview(client){
  const {weighIns,exercises}=weightHistory(client), latest=weighIns[0];
  return `<button type="button" class="weight-overview" data-sec="storico-pesi">
    <span class="weight-overview-icon" aria-hidden="true">${ui.I.chart}</span>
    <span class="weight-overview-copy"><strong>Storico pesi</strong><small>${countLabel(exercises.length,"esercizio con serie","esercizi con serie")} · ${countLabel(weighIns.length,"pesata","pesate")}</small></span>
    ${latest?`<span class="weight-overview-last"><strong>${weightNumber.format(latest.v)} kg</strong><small>Ultima pesata</small></span>`:""}
    <span class="weight-overview-arrow" aria-hidden="true">${ui.I.chevR}</span>
  </button>`;
}

let weightTab="esercizi", weightPick=null, weightQuery="";
function clientWeightHistory(client){
  weightPick=null; weightQuery="";
  drawClient(client,"Storico pesi",'<div id="clientWeightHistory"></div>');
  paintWeightHistory(weightHistory(client),athleteSessions(snapshots.get(client.id)));
}

const kgText=(kg,perSide)=>kg===null?"—":kg===0?"C.L.":`${weightNumber.format(kg)} ${perSide?"kg/lato":"kg"}`;
function setsTable(sets,unit,perSide){
  return `<table class="weight-table"><thead><tr><th scope="col">Serie</th><th scope="col">Carico</th><th scope="col">${unit==="sec"?"Tempo":"Rip."}</th><th scope="col">RIR</th></tr></thead><tbody>
    ${sets.map(set=>`<tr><td>${escape(set.series)}</td><td>${kgText(set.kg,perSide)}</td><td>${set.reps===null?"—":weightNumber.format(set.reps)+(unit==="sec"?" s":"")}</td><td>${set.rir===null?"—":weightNumber.format(set.rir)}</td></tr>`).join("")}</tbody></table>`;
}
const bestSet=sets=>sets.filter(x=>x.kg!==null).sort((a,b)=>b.kg-a.kg||(b.reps??0)-(a.reps??0))[0];

function paintWeightHistory({weighIns,exercises},sessions=[]){
  const host=$("clientWeightHistory"); if(!host)return;
  const tabs=[["esercizi",`Esercizi · ${exercises.length}`],["sessioni",`Sessioni · ${sessions.length}`],["peso",`Peso corporeo · ${weighIns.length}`]];
  let body="";
  if(weightTab==="esercizi"){
    const exercise=weightPick&&exercises.find(item=>item.key===weightPick);
    if(exercise){
      body=`<button type="button" class="btn btn-ghost weight-backlist" id="weightBackList">${ui.I.chevL} Tutti gli esercizi</button>
        <h2>${escape(exercise.name)}${exercise.unit==="sec"?" · a tempo":""}${exercise.perSide?" · per lato":""}</h2>
        ${exercise.entries.map((entry,index)=>`<details class="weight-list" ${index===0?"open":""}>
          <summary>${displayDate(entry.ts)}${entry.title?` · ${escape(entry.title)}`:""}</summary>
          ${entry.program?`<p class="weight-session-program">${escape(entry.program)}</p>`:""}${setsTable(entry.sets,exercise.unit,exercise.perSide)}</details>`).join("")}`;
    }else{
      const q=weightQuery.toLocaleLowerCase("it");
      const shown=exercises.filter(item=>!q||item.name.toLocaleLowerCase("it").includes(q));
      body=exercises.length?`<label class="fld weight-search">Cerca esercizio<input class="inp" id="weightSearch" type="search" value="${escape(weightQuery)}" placeholder="Nome esercizio"></label>
        <div class="weight-picklist">${shown.map(item=>{const last=item.entries[0], top=bestSet(last.sets);
          return `<button type="button" class="weight-pick" data-ex="${escape(item.key)}"><span class="weight-pick-name">${escape(item.name)}</span>
            <span class="weight-pick-meta">${displayDate(last.ts)} · ${item.entries.length} ${item.entries.length===1?"seduta":"sedute"}${top?` · ${kgText(top.kg,item.perSide)} × ${top.reps===null?"—":weightNumber.format(top.reps)}`:""}</span>${ui.I.chevR}</button>`;}).join("")||'<p class="weight-empty">Nessun esercizio con questo nome.</p>'}</div>`
        :'<p class="weight-empty">Le serie compariranno qui dopo che il cliente avrà concluso un allenamento.</p>';
    }
  }else if(weightTab==="sessioni"){
    body=sessions.length?sessions.map((session,index)=>`<details class="weight-list weight-session" ${index===0?"open":""}>
      <summary><strong>${displayDate(session.ts)}</strong> · ${escape(session.title)}<span class="weight-session-count">${session.exercises.length} esercizi</span></summary>
      ${session.program?`<p class="weight-session-program">${escape(session.program)}${session.week?` · settimana ${session.week}`:""}${session.note?` · ${escape(session.note)}`:""}</p>`:""}
      ${session.exercises.map(ex=>`<div class="weight-session-ex"><h3>${escape(ex.name)}</h3>${setsTable(ex.sets,ex.unit,false)}${ex.note?`<p class="weight-session-program">${escape(ex.note)}</p>`:""}</div>`).join("")}
    </details>`).join(""):'<p class="weight-empty">Nessuna seduta registrata.</p>';
  }else{
    const [latest,first]=[weighIns[0],weighIns.at(-1)];
    const chartPoints=weighIns.slice(0,30).reverse().map(item=>({...item,l:weightShortDate.format(item.ts)}));
    body=latest?`<dl class="weight-stats"><div><dt>Ultima pesata</dt><dd>${weightNumber.format(latest.v)} kg</dd><small>${displayDate(latest.ts)}</small></div>
      ${weighIns.length>1?`<div><dt>Dalla prima pesata</dt><dd>${weightSigned.format(latest.v-first.v)} kg</dd><small>${displayDate(first.ts)}</small></div>`:""}</dl>
      ${chartPoints.length>1?`<figure class="weight-chart"><figcaption>Andamento delle pesate${weighIns.length>30?" · ultime 30":""}</figcaption>${ui.buildChart(chartPoints,{timeAxis:true})}</figure>`:""}
      <table class="weight-table"><thead><tr><th scope="col">Data</th><th scope="col">Peso</th></tr></thead><tbody>${weighIns.map(item=>
        `<tr><td>${displayDate(item.ts)}</td><td>${weightNumber.format(item.v)} kg</td></tr>`).join("")}</tbody></table>`
      :'<p class="weight-empty">Il cliente non ha ancora registrato pesate.</p>';
  }
  host.innerHTML=`<div class="subtabs" role="tablist">${tabs.map(([id,label])=>`<button type="button" role="tab" aria-selected="${weightTab===id}" class="${weightTab===id?"on":""}" data-wtab="${id}">${label}</button>`).join("")}</div>
    <section class="weight-panel">${body}</section>`;
  const again=()=>paintWeightHistory({weighIns,exercises},sessions);
  host.querySelectorAll("[data-wtab]").forEach(b=>b.onclick=()=>{weightTab=b.dataset.wtab;weightPick=null;again();});
  host.querySelectorAll("[data-ex]").forEach(b=>b.onclick=()=>{weightPick=b.dataset.ex;again();host.scrollIntoView({block:"start"});});
  const back=$("weightBackList"); if(back)back.onclick=()=>{weightPick=null;again();};
  const search=$("weightSearch");
  if(search)search.oninput=()=>{weightQuery=search.value;const pos=search.selectionStart;again();const next=$("weightSearch");next.focus();next.setSelectionRange(pos,pos);};
}

async function refreshSelectedSnapshot(client){
  if(ui.view!=="cliente"||ui.currentClient?.id!==client.id)return;
  const state=checked(await supabase.from("athlete_states").select("snapshot,revision").eq("user_id",client.id).maybeSingle());
  if(ui.view!=="cliente"||ui.currentClient?.id!==client.id)return;
  const before=weightHistory(client);
  if(!cacheClientSnapshot(client.id,state)||(!$("clientWeightHistory")&&!$("clientWeightOverview")))return;
  const after=weightHistory(client);
  if(JSON.stringify(before)===JSON.stringify(after))return;
  if($("clientWeightHistory"))paintWeightHistory(after,athleteSessions(snapshots.get(client.id)));
  else if($("clientWeightOverview"))ui.render();
}

function programHistory(c){
  const active=published.get(c.id);
  const ownDrafts=drafts.get(c.id)||[];
  const workouts=(snapshots.get(c.id)?.sessioni||[]).slice().sort((a,b)=>b.ts-a.ts);
  const {inCorso,concluse}=clientProgramList({snapshot:snapshots.get(c.id)||{},active,versions:versions.get(c.id)||[],today:today()});
  const entries=[...inCorso,...concluse].filter(r=>r.published);
  const head=`<div class="pthead pthead-wide"><div>Programma</div><div>Inizio</div><div>Fine</div><div>Stato</div><div>Completati</div><div>Saltati</div><div></div></div>`;
  const line=r=>{const i=entries.indexOf(r);
    return `<div class="ptrow ptrow-wide${r.ongoing?" ptrow-live":""}"><div class="ptc ptname">${escape(r.name)}${r.published?"":'<small class="ptsrc">da storico allenamenti</small>'}</div>
      <div class="ptc" data-l="Inizio">${displayDate(r.start)}</div><div class="ptc" data-l="Fine">${displayDate(r.end)}</div>
      <div class="ptc" data-l="Stato"><span class="pstat ${r.ongoing?"corso":"scaduta"}">${r.ongoing?"In corso":"Terminato"}</span>${r.expected?`<small class="ptsub">${r.done}/${r.expected}</small>`:""}</div>
      <div class="ptc" data-l="Completati">${r.done}</div><div class="ptc" data-l="Saltati">${r.skipped===null?"—":r.skipped}</div>
      <div class="ptc ptact">${r.published?button("mockVersion"+i,"Apri copia")+button("mockExportVersion"+i,"Esporta"):""}</div></div>`;};
  drawClient(c,"Programmazione",`<h2 class="ptgroup">In corso</h2><div class="ptable">${inCorso.length?head+inCorso.map(line).join(""):row("Nessuna programmazione in corso")}</div>
    <h2 class="ptgroup">Concluse</h2><div class="ptable">${concluse.length?head+concluse.map(line).join(""):row("Nessuna programmazione conclusa")}</div>
    ${ownDrafts.length?`<h2>Bozze del cliente</h2>${ownDrafts.map((d,i)=>row(d.program.nome||d.program.name||"Bozza",displayDate(d.updated_at),button("mockDraft"+i,"Apri bozza")+button("mockArchiveDraft"+i,"Archivia"))).join("")}`:""}`,button("mockProgramList","Apri Workout",true));
  $("mockProgramList").onclick=()=>ui.go("workout");
  entries.forEach((r,i)=>{
    const item=r.item;
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
  if(tab==="notifiche"){
    panel.innerHTML='<h2 class="set-title">Notifiche</h2><div id="coachAlertSettings"></div>';
    alerts.mount($("coachAlertSettings"));
    return;
  }
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

const biaFields={
  weightKg:"Peso (kg)",skeletalMuscleKg:"Massa muscolare (kg)",bodyFatMassKg:"Massa grassa (kg)",targetWeightKg:"Peso obiettivo (kg)",
  age:"Età",heightCm:"Altezza (cm)",bmi:"IMC",obesityDegreePercent:"Grado di obesità (%)",bodyFatPercent:"Grasso corporeo (%)",
  totalBodyWaterL:"Acqua corporea (L)",proteinKg:"Proteine (kg)",mineralsKg:"Minerali (kg)",visceralFatLevel:"Grasso viscerale",
  basalMetabolicRateKcal:"Metabolismo basale (kcal)",waistHipRatio:"Rapporto vita/fianchi",score:"Punteggio",
  weightControlKg:"Controllo peso (kg)",fatControlKg:"Controllo grasso (kg)",muscleControlKg:"Controllo muscolo (kg)"
};
const requiredBiaNumbers=new Set(["weightKg","skeletalMuscleKg","bodyFatMassKg"]);
function editBia(c,record){
  const revision=stateRevisions.get(c.id);
  const date=new Date(record.measuredAt);
  const local=Number.isFinite(date.valueOf())?new Date(date.valueOf()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):"";
  const fields=Object.entries(biaFields).map(([key,label])=>field("editBia_"+key,label,"text",record[key]??"",requiredBiaNumbers.has(key))).join("");
  const sex=`<label class="fld">Sesso<select class="sel" id="editBiaSex"><option value="">Non indicato</option><option value="male" ${record.sex==="male"?"selected":""}>Maschile</option><option value="female" ${record.sex==="female"?"selected":""}>Femminile</option></select></label>`;
  showModal("Modifica referto BIA",field("editBiaDate","Data e ora","datetime-local",local,true)+`<div class="bia-edit-grid">${sex}${fields}</div>`,"Salva modifiche",async()=>{
    const measuredAt=new Date(val("editBiaDate"));
    const values=Object.fromEntries(Object.keys(biaFields).map(key=>{
      const input=val("editBia_"+key);
      return [key,input===""?null:Number(input.replace(",","."))];
    }));
    if(!Number.isFinite(measuredAt.valueOf())||Object.values(values).some(n=>n!==null&&!Number.isFinite(n)))throw new Error("Controlla data e valori numerici.");
    try{
      await adminCall("updateBia",{clientUid:c.id,biaId:record.id,expectedRevision:revision,measuredAt:measuredAt.toISOString(),sex:val("editBiaSex")||null,...values});
    }catch(error){
      if(error.code==="aborted"){await loadClientRows(c);clientBia(c);}
      throw error;
    }
    await loadClientRows(c);clientBia(c);ui.toast("Referto aggiornato");
  });
}
function clientBia(c){
  const data=(snapshots.get(c.id)?.bia||[]).slice().sort((a,b)=>Date.parse(b.measuredAt)-Date.parse(a.measuredAt));
  const plots=[["weightKg","Peso"],["skeletalMuscleKg","Massa muscolare"],["fatFreeMassKg","Massa magra"]].map(([key,title])=>{
    const points=data.slice().reverse().filter(r=>r[key]!=null&&Number.isFinite(Number(r[key]))).map(r=>({v:Number(r[key]),l:displayDate(r.measuredAt)}));
    return points.length>1?`<section class="metric"><h3>${title}</h3>${ui.buildChart(points.slice(-12))}</section>`:"";
  }).join("");
  const records=data.map((r,i)=>row(displayDate(r.measuredAt),`Peso ${r.weightKg} kg · Muscolo ${r.skeletalMuscleKg} kg · Massa magra ${r.fatFreeMassKg??"—"} kg`,`<span class="bia-row-actions">${r.reportPath?button("mockBiaFile"+i,"Apri referto"):""}${r.id?button("mockBiaEdit"+i,"Modifica")+button("mockBiaDelete"+i,"Elimina"):""}</span>`)).join("");
  drawClient(c,"Referti BIA",plots+records||empty("Nessuna rilevazione"),button("mockBiaAdd","Carica referto",true)+button("mockBiaMetrics","Metriche")+(plots?button("mockBiaPrint","Stampa andamento"):""));
  $("mockBiaMetrics").onclick=()=>ui.renderCliMetriche(c);
  if(plots)$("mockBiaPrint").onclick=()=>window.print();
  data.forEach((r,i)=>{
    if(r.reportPath)$("mockBiaFile"+i).onclick=()=>openFile("bia-reports",r.reportPath).catch(fail);
    if(!r.id)return;
    $("mockBiaEdit"+i).onclick=()=>editBia(c,r);
    $("mockBiaDelete"+i).onclick=()=>showModal("Elimina referto",`<p>Eliminare il referto del ${escape(displayDate(r.measuredAt))}, il file originale e la sua anteprima?</p>`,"Elimina referto",async()=>{
      await adminCall("deleteBia",{clientUid:c.id,biaId:r.id});
      await loadClientRows(c);clientBia(c);ui.toast("Referto eliminato");
    });
  });
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
      workspaceRevision=saved.revision;const {programs,mealPlans,...rest}=saved.content;
      workspace={...workspace,...rest};
      replace(ui.programmi,programs||[]);replace(ui.pianiAlimentari,mealPlans||[]);
      for(const [id,value] of Object.entries(workspace.exerciseEdits)){
        const found=ui.libreria.find(ex=>ex.id===id);
        if(found)Object.assign(found,value);else ui.libreria.unshift(value);
      }
    }
    alerts=createNotifications({
      role:"coach",uid,
      types:[
        {id:"chat",label:"Nuovi messaggi",enabled:workspace.notifications?.[2] ?? true},
        {id:"calendar",label:"Calendario",detail:"Inizio e scadenza schede, avvisi a 7 giorni e promemoria del giorno.",enabled:workspace.notifications?.[0] ?? true}
      ],
      onOpen:openNotification,onChange:checkCalendarAlerts
    });
    await loadDirectory();
    workspaceSignature=JSON.stringify(workspacePayload());workspaceLoaded=true;
    const badge=document.createElement("div");
    badge.className="autosave";
    badge.innerHTML='<span class="as-dot"></span><span id="asTxt" role="status">Salvataggio automatico</span>';
    document.body.append(badge);
    $("brand").disabled=false;
    document.querySelector(".coach-chat-icon").innerHTML=ui.I.chat;
    $("coachChat").disabled=false;
    $("coachChat").onclick=()=>ui.go("chat");
    $("coachSettings").innerHTML=ui.I.gear;
    $("coachSettings").disabled=false;
    $("coachSettings").onclick=()=>ui.go("impostazioni");
    const [destination,clientId]=location.hash.slice(1).split("/");
    if(destination==="chat"||destination==="calendar")openNotification(destination,clientId);
    else ui.go("home");
    void refreshInbox().catch(fail);
    const refreshChat=()=>{void refreshInbox().catch(fail);if(ui.view==="chat")void refreshCoachThread().catch(fail);};
    document.addEventListener("visibilitychange",()=>{if(!document.hidden){refreshChat();checkCalendarAlerts();}});
    window.setInterval(checkCalendarAlerts,60000);
    navigator.serviceWorker?.addEventListener("message",event=>{
      if(event.data?.type==="open-chat")openNotification("chat");
      if(event.data?.type==="open-notification")openNotification(event.data.destination,event.data.clientId);
    });
    let update;
    const reload=()=>{clearTimeout(update);update=setTimeout(async()=>{try{await loadDirectory();if(["home","priorita"].includes(ui.view))ui.render();}catch(error){fail(error);}},300);};
    let feed=supabase.channel("coach-mockup:"+uid);
    for(const table of ["programs","coach_client_sections"])feed=feed.on("postgres_changes",{event:"*",schema:"public",table},reload);
    const refreshSelectedClient=()=>{
      if(ui.currentClient)void refreshSelectedSnapshot(ui.currentClient).catch(fail);
    };
    feed.on("postgres_changes",{event:"*",schema:"public",table:"athlete_states"},event=>{
      if((event.new?.user_id||event.old?.user_id)===ui.currentClient?.id)refreshSelectedClient();
    });
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshSelectedClient();});
    document.addEventListener("visibilitychange",()=>{
      if(!document.hidden&&$("mockAthletePhotos")&&ui.currentClient)void loadAthleteProgressPhotos(ui.currentClient);
    });
    feed.on("postgres_changes",{event:"*",schema:"public",table:"profiles"},async()=>{
      try{await loadDirectory();refreshChat();if(["home","clienti"].includes(ui.view))ui.render();}catch(error){fail(error);}
    }).on("postgres_changes",{event:"*",schema:"public",table:"messages"},event=>{
      if(event.new?.channel!=="thread")return;
      refreshChat();
      if(event.eventType==="INSERT"&&event.new.sender_id!==uid&&event.new.type==="urgenza")reload();
    }).subscribe(status=>{if(status==="SUBSCRIBED"){refreshChat();refreshSelectedClient();}});
  }catch(error){
    ui.main.innerHTML=empty("Connessione non riuscita",friendlyAuthError(error))+button("mockRetry","Riprova",true);
    $("mockRetry").onclick=()=>location.reload();
  }
}
function openNotification(destination,clientId){
  if(destination==="chat"){
    const client=ui.clienti.find(item=>item.id===clientId);
    if(client)openCoachChat(client.id);
    else ui.go("chat");
  }else if(destination==="calendar"){
    ui.go("home");
    ui.renderHomeCalendar(today());
    $("homeCalendar")?.scrollIntoView({block:"nearest"});
  }
}
window.CoachDB={saveWorkspace,saveProgram,assignProgram,publishNutrition,confirmNutritionDayDeletion,createClient,openClient,programHistory,clientSection,weightHistoryOverview,addMeasure,metricActions,createExercise,saveExercise,exerciseAttachments,settings,sendPriority,storeSignal,recipes,renderInbox,editCalendarReminder,deleteCalendarReminder};
$("coachLogout").onclick=signOutCoach;
void start();
