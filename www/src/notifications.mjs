const workerUrl = new URL("../chat-worker.js", import.meta.url);
const siteIcon = new URL("../icon-192.png", import.meta.url).href;

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* The current tab still keeps the preference in memory. */ }
}

function systemPermission() {
  return window.Notification && navigator.serviceWorker && window.isSecureContext ? Notification.permission : "unsupported";
}

let audio;
function resumeAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  try {
    audio ??= new Context();
    if (audio.state !== "running") return audio.resume().catch(() => {});
  } catch { /* An unavailable audio device must not block the notification. */ }
}

function playChime() {
  if (audio?.state !== "running") return;
  const start = audio.currentTime;
  for (const [offset, frequency] of [[0, 660], [0.11, 880]]) {
    const tone = audio.createOscillator(), gain = audio.createGain();
    const time = start + offset;
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.09, time + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.20);
    tone.connect(gain);
    gain.connect(audio.destination);
    tone.start(time);
    tone.stop(time + 0.21);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  }
}

function showBanner({ title, body, action, onClick }) {
  document.querySelector(".app-alert")?.remove();
  const banner = document.createElement("aside");
  banner.className = "app-alert";
  const copy = document.createElement("div");
  copy.setAttribute("role", "status");
  const heading = document.createElement("strong"), detail = document.createElement("p");
  heading.textContent = title;
  detail.textContent = body;
  copy.append(heading, detail);
  banner.append(copy);
  if (action) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "app-alert-action";
    open.textContent = action;
    open.onclick = () => { banner.remove(); onClick(); };
    banner.append(open);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Chiudi notifica");
  close.textContent = "×";
  close.onclick = () => banner.remove();
  banner.append(close);
  document.body.append(banner);
  setTimeout(() => banner.remove(), 9000);
}

async function getWorker() {
  const registration = await navigator.serviceWorker.getRegistration(workerUrl);
  if (registration?.active?.scriptURL === workerUrl.href) return registration;
  await navigator.serviceWorker.register(workerUrl);
  return navigator.serviceWorker.ready;
}

export function createNotifications({ role, uid, types, onOpen, onChange }) {
  const key = `lippolis-notifications:${role}:${uid}`;
  const defaults = { sound: true };
  for (const type of types) defaults[type.id] = type.enabled;
  let overrides = {}, preferences;
  let panel, activationBanner, busy = false, checkingCalendar = false, feedback = "";
  const refresh = () => {
    overrides = readLocal(key, overrides);
    preferences = { ...defaults, enabled: role === "athlete" && systemPermission() === "granted", ...overrides };
    return preferences;
  };
  const save = (updates) => {
    refresh();
    overrides = { ...overrides, ...updates };
    writeLocal(key, overrides);
  };
  function unlockAudio() {
    if (refresh().enabled && preferences.sound) resumeAudio();
  }
  document.addEventListener("click", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });
  window.addEventListener("focus", paintStatus);
  window.addEventListener("storage", event => { if (event.key === key) paintStatus(); });

  async function notify(type, event) {
    if (!refresh().enabled || !preferences[type] || (event.backgroundOnly && !document.hidden)) return false;
    const sound = preferences.sound && !event.silent;
    if (!document.hidden) {
      showBanner({ ...event, onClick: () => onOpen(event.destination, event.clientId) });
      if (sound) playChime();
      return true;
    }
    if (systemPermission() !== "granted") return false;
    try {
      const registration = await getWorker();
      if (!refresh().enabled || !preferences[type]) return false;
      await registration.showNotification(event.title, {
        body: event.systemBody || event.body, icon: siteIcon,
        tag: `lippolis-${type}-${role}`, renotify: true,
        silent: !preferences.sound || !!event.silent,
        data: { role, destination: event.destination, clientId: event.clientId }
      });
      return true;
    } catch (error) {
      console.warn("Notifica di sistema non disponibile", error);
      return false;
    }
  }

  async function authorize() {
    if (busy) return;
    busy = true;
    feedback = "";
    paintStatus();
    if (refresh().sound) resumeAudio();
    try {
      if (systemPermission() === "default") await Notification.requestPermission();
      save({ enabled: true });
      if (systemPermission() === "granted") await getWorker();
    } catch {
      feedback = "Il browser non ha attivato le notifiche di sistema.";
    } finally {
      busy = false;
      paintStatus();
      onChange?.();
    }
  }

  function mountActivationBanner(container) {
    activationBanner = container;
    container.querySelector("button").onclick = authorize;
    document.addEventListener("visibilitychange", () => { if (!document.hidden) paintStatus(); });
    if (systemPermission() !== "unsupported" && navigator.permissions) {
      void navigator.permissions.query({ name: "notifications" }).then(status => {
        status.addEventListener("change", paintStatus);
      }).catch(() => {});
    }
    paintStatus();
  }

  function paintActivationBanner(permission) {
    if (!activationBanner?.isConnected) return;
    activationBanner.hidden = !busy && !feedback && preferences.enabled && (permission === "granted" || permission === "unsupported");
    if (activationBanner.hidden) return;
    const message = activationBanner.querySelector("p");
    const blocked = permission === "denied";
    const appOnly = blocked || permission === "unsupported";
    activationBanner.querySelector("h2").textContent = blocked ? "Notifiche bloccate nel browser" : "Attiva le notifiche";
    message.textContent = feedback || (blocked
      ? "Apri le impostazioni del sito nel browser e consenti le notifiche per riceverle anche in secondo piano."
      : "Ricevi un avviso quando il tuo PT ti scrive o pubblica una nuova scheda.");
    const button = activationBanner.querySelector("button");
    button.hidden = blocked && preferences.enabled;
    button.disabled = busy;
    button.textContent = busy ? "Attivazione…" : appOnly ? "Attiva gli avvisi nell’app" : "Attiva notifiche";
  }

  function paintStatus() {
    refresh();
    const permission = systemPermission();
    paintActivationBanner(permission);
    if (!panel?.isConnected) return;
    const status = panel.querySelector("[data-alert-status]");
    status.textContent = feedback || (!preferences.enabled ? "Attiva gli avvisi su questo dispositivo." : ({
      granted: "Il browser ha autorizzato le notifiche di sistema.",
      default: "Autorizza il browser per ricevere gli avvisi anche in un’altra scheda.",
      denied: "Il browser ha bloccato gli avvisi di sistema. Puoi riabilitarli dalle impostazioni del sito.",
      unsupported: "Su questo dispositivo gli avvisi compaiono dentro l’app."
    })[permission]);
    const enable = panel.querySelector("[data-alert-enable]");
    enable.textContent = preferences.enabled ? "Disattiva notifiche" : "Attiva notifiche";
    enable.disabled = busy;
    panel.querySelector("[data-alert-test]").disabled = !preferences.enabled;
    const allow = panel.querySelector("[data-alert-allow]");
    allow.hidden = !preferences.enabled || permission !== "default";
    allow.disabled = busy;
    for (const input of panel.querySelectorAll("[data-alert-pref]")) input.checked = !!preferences[input.dataset.alertPref];
  }

  function mount(container) {
    panel = container;
    container.innerHTML = `
      <div class="alert-settings">
        <p data-alert-status role="status"></p>
        <div class="alert-settings-actions">
          <button type="button" data-alert-enable></button>
          <button type="button" data-alert-allow hidden>Autorizza il browser</button>
          <button type="button" data-alert-test>Prova notifica</button>
        </div>
        <label><input type="checkbox" data-alert-pref="sound"><span><strong>Suono</strong></span></label>
        ${types.map(type => `<label><input type="checkbox" data-alert-pref="${type.id}"><span><strong>${type.label}</strong>${type.detail ? `<small>${type.detail}</small>` : ""}</span></label>`).join("")}
      </div>`;
    container.querySelector("[data-alert-enable]").onclick = () => {
      if (!refresh().enabled) return authorize();
      save({ enabled: false });
      feedback = "Notifiche disattivate su questo dispositivo.";
      document.querySelector(".app-alert")?.remove();
      paintStatus();
      if (systemPermission() === "granted") {
        void navigator.serviceWorker.getRegistration(workerUrl).then(async registration => {
          const notifications = await registration?.getNotifications() || [];
          for (const notification of notifications) {
            if (notification.tag.endsWith("-" + role)) notification.close();
          }
        }).catch(() => {});
      }
    };
    container.querySelector("[data-alert-allow]").onclick = authorize;
    container.querySelector("[data-alert-test]").onclick = async () => {
      if (!refresh().enabled) return;
      const ready = preferences.sound && resumeAudio();
      showBanner({ title: "Notifica di prova", body: "Gli avvisi a comparsa sono attivi." });
      await ready;
      if (preferences.sound) playChime();
    };
    for (const input of container.querySelectorAll("[data-alert-pref]")) input.onchange = () => {
      save({ [input.dataset.alertPref]: input.checked });
      if (input.dataset.alertPref === "sound" && input.checked) resumeAudio();
      onChange?.();
    };
    paintStatus();
  }

  async function calendar(date, events) {
    if (checkingCalendar || !events.length || !refresh().enabled || !preferences.calendar) return;
    const dayKey = key + ":calendar";
    const previous = readLocal(dayKey, {});
    const seen = new Set(previous.date === date && Array.isArray(previous.ids) ? previous.ids : []);
    const pending = events.filter(event => !seen.has(event.id));
    if (!pending.length) return;
    const body = pending.length === 1 ? pending[0].title : `${pending.length} eventi in calendario oggi.`;
    checkingCalendar = true;
    try {
      const sent = await notify("calendar", { title: "Calendario PT", body,
        systemBody: "Hai eventi in calendario oggi.", action: "Apri calendario", destination: "calendar" });
      if (sent) writeLocal(dayKey, { date, ids: [...seen, ...pending.map(event => event.id)] });
    } finally { checkingCalendar = false; }
  }
  return { mount, mountActivationBanner, notify, calendar };
}
