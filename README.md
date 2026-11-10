# LIPPOLIS PT

Applicazione per Personal Trainer e clienti con backend Supabase gratuito e frontend statico pubblicato su Firebase Hosting (piano Spark).

## Architettura

- Supabase Auth: accesso email/password e recupero password;
- PostgreSQL: profili, schede, risultati, messaggi e revisioni;
- Row Level Security: ogni cliente legge soltanto i propri dati; il PT legge i clienti assegnati;
- Supabase Realtime: aggiornamenti di schede, progressi e messaggi;
- Edge Function `admin-api`: creazione, sospensione, riattivazione, esportazione ed eliminazione account;
- Firebase Hosting: contiene soltanto i file statici in `www/` e non richiede Blaze.

La Secret key Supabase non deve mai essere inserita nel browser, nel repository o in `www/supabase-config.js`.

## Struttura

- `www/`: login e aree PT/atleta;
- `www/src/supabase.mjs`: client pubblico e chiamate all’Edge Function;
- `supabase/migrations/`: schema PostgreSQL, funzioni atomiche e policy RLS;
- `supabase/functions/admin-api/`: backend privilegiato;
- `supabase/functions/_shared/validation.mjs`: validazione condivisa e testata;
- `supabase/seed-coach.example.sql`: creazione controllata del primo PT;
- `test/`: test di validazione, migrazione e sicurezza statica.

## Configurazione Supabase

1. Crea un progetto gratuito su Supabase e scegli una regione europea.
2. Apri **SQL Editor**, incolla ed esegui `supabase/migrations/202611070001_initial_schema.sql`.
3. Apri **Project Settings > API** e copia in `www/supabase-config.js`:
   - Project URL nel campo `url`;
   - Publishable key nel campo `publishableKey`.
4. In **Authentication > URL Configuration** imposta:
   - Site URL: `https://lippolispt.web.app`;
   - Redirect URLs: `https://lippolispt.web.app/**` e, se usato, `https://lippolispt.firebaseapp.com/**`.
5. In **Authentication > Providers > Email** lascia attivo Email/Password. La registrazione pubblica deve restare disabilitata.
6. Collega la cartella locale al progetto e pubblica la funzione:

```powershell
npx supabase login
npx supabase link --project-ref IL_PROJECT_REF
npx supabase functions deploy admin-api
```

Le variabili `SUPABASE_URL` e `SUPABASE_SECRET_KEYS` sono fornite automaticamente alla funzione ospitata. Non creare file con la Secret key.

## Primo Personal Trainer

1. In **Supabase > Authentication > Users**, scegli **Add user > Create new user**.
2. Inserisci email e password del PT e attiva **Auto Confirm User**.
3. Apri `supabase/seed-coach.example.sql`, sostituisci `NOME_PT`, `COGNOME_PT` ed `EMAIL_PT_DA_SOSTITUIRE`.
4. Esegui lo script nel SQL Editor.

Il primo visitatore non viene mai promosso automaticamente a PT.

## Primo accesso cliente

1. Il PT crea il cliente dal proprio pannello e comunica email e password iniziale.
2. L’account viene autorizzato dal PT e non può essere creato dal sito pubblico.
3. Al primo accesso il cliente deve impostare una password personale di almeno 12 caratteri.
4. Solo dopo il completamento dell’onboarding le policy consentono l’accesso ai dati atleta.

La password iniziale non viene salvata nel database, nei log, nella cache o nelle esportazioni.

## Pubblicazione del sito

Firebase viene usato soltanto come hosting statico gratuito:

```powershell
npm install
npx firebase-tools login
npm run deploy:hosting
```

Non occorre attivare Blaze, Firestore o Cloud Functions nel progetto Firebase.

## Test

Test rapidi:

```powershell
npm test
```

Test locale completo del database (richiede Docker e Supabase CLI):

```powershell
npm run supabase:start
npm run supabase:test
```

Per servire il frontend statico:

```powershell
npm run serve
```

## Garanzie applicative

- le policy RLS verificano account attivo, ruolo e associazione PT-cliente;
- la scrittura dello stato atleta usa una revisione atomica e segnala i conflitti tra dispositivi;
- la pubblicazione di una scheda è transazionale e conserva la versione precedente;
- sospensione ed eliminazione passano esclusivamente dall’Edge Function autenticata;
- la cancellazione dell’utente Auth elimina a cascata i dati esclusivi del cliente;
- l’area atleta e la cache locale esistente restano operative.

### Schede e allenamenti

- Il PT salva le modifiche in `program_drafts`. Una bozza resta privata del PT; il pulsante **Pubblica** la promuove in modo transazionale alla scheda corrente in `programs` e conserva la versione precedente.
- L’area atleta legge la scheda pubblicata da `programs` e si aggiorna quando viene pubblicata una nuova versione. Il cliente non deve importare un backup.
- Le sedute completate vengono sincronizzate in `athlete_states.snapshot.sessioni`; il pannello PT legge lo stesso storico per mostrare allenamenti, pesate, check-in e carichi.
- Le date delle settimane mancanti vengono ricavate dal periodo della scheda. Il client completa anche i campi di presentazione delle schede precedenti che non li avevano.

### Costruttore di schede v2

Il costruttore usa le tabelle esistenti: le bozze restano in `program_drafts`, la scheda pubblicata in `programs`, le versioni precedenti in `program_versions`. La struttura annidata è JSONB (`settimane → giorni → blocks → exercises → sets`); non duplica clienti né sedute completate. Il modulo condiviso `www/src/workout-metrics.mjs` è importato anche dalla Edge Function: in salvataggio e pubblicazione il server convalida i dati e rigenera `calculated`, ignorando eventuali totali inviati dal browser. Il flusso di salvataggio controlla la revisione attesa; la migration aggiunge anche scrittura atomica e registro delle azioni per salvataggio, archivio e pubblicazione.

Formule implementate nell’editor e nel calcolo server:

- **Serie utili:** somma le righe prescritte, tranne `warmup`; per drop, mini-set e gruppi cluster il peso iniziale è 1 per riga. Le impostazioni `usefulSetWeights` possono assegnare valori tra 0 e 1.
- **Durata:** ripetizioni medie × somma delle quattro fasi del tempo (`X` vale 1 secondo; tempo mancante usa `secondsPerRep`, predefinito 3). AMRAP/cedimento usa `amrapReps`, predefinito 10. Aggiunge i recuperi, il recupero dei giri solo alla fine di superserie/circuiti e la preparazione di 45 secondi ai cambi esercizio; aggiunge 30 secondi al primo esercizio quando cambia attrezzo. Non aggiunge recupero al termine della seduta. Il risultato mostrato è arrotondato a 5 minuti e marcato `≈`.
- **Intensità media:** media aritmetica dei RIR delle serie utili con target; RPE visualizzato = `10 − RIR`. La scala non trasforma i valori salvati.
- **Volume:** 1 serie al muscolo primario e 0,5 ai secondari. I range iniziali modificabili sono punti di partenza generali, non indicazioni cliniche; gli avvisi non spostano serie automaticamente.
- **Barre settimanali:** serie utili divise per il massimo della scheda o per il target manuale; intensità = RPE medio diviso 10 o target manuale diviso 10.
- **Date:** settimana `i` automatica parte da `Dal + 7 × i` e termina dopo sei giorni, limitata a `Al`. Le date manuali non vengono ricalcolate; intervalli invertiti, sovrapposti o discontinui bloccano la pubblicazione. Copertura incompleta o numero di settimane non coerente con il periodo è mostrato come avviso.

Il formato v2 è descritto in [`docs/workout-program-v2.schema.json`](docs/workout-program-v2.schema.json). L’importazione mantiene il vecchio formato e converte anche il formato esteso non versionato con `metodo`, `gruppo` e `serie` come elenco di righe; mostra l’anteprima prima di applicare i dati e conserva il JSON originale in `legacyBackup`.

Migrazione ripetibile delle schede già presenti (prima esegui solo l’anteprima; le variabili vanno impostate nella sessione locale, mai nel browser o nel repository):

```powershell
$env:SUPABASE_URL = "https://IL_PROJECT_REF.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "LA_SECRET_KEY_DEL_PROGETTO"
node scripts/migrate-programs-v2.mjs
node scripts/migrate-programs-v2.mjs --apply
```

Lo script considera `programs`, `program_versions` e `program_drafts`, non tocca `athlete_states.snapshot.sessioni` e conserva il documento sorgente per il ripristino. Se il report segnala errori, correggi i record indicati prima di ripetere `--apply`.

**Limiti del costruttore in questa versione:** le schede vengono salvate e pubblicate, e il cliente le legge nella stessa area Workout già esistente. L’esecuzione dell’atleta continua a registrare lo storico nel formato compatibile `athlete_states.snapshot.sessioni`; non sono state introdotte tabelle `workout_sessions`/`session_sets`. La libreria centralizzata di esercizi con ricerca/video, upload video, progressioni con anteprima, anteprima atleta in sola lettura e test end-to-end di ogni pulsante non sono ancora collegati. Le note tecniche restano nel JSON della scheda ma l’interfaccia atleta non le mostra.

### Attivazione del costruttore aggiornato

1. Esegui la nuova migration `supabase/migrations/202611100003_program_builder_audit.sql` nel SQL Editor Supabase o con la CLI collegata al progetto.
2. Pubblica la Edge Function aggiornata sul progetto corretto: `npx supabase functions deploy admin-api --remote=aftvzsrbowpwvvbgvzta`.
3. Pubblica i file statici su Firebase Hosting: `npm run deploy:hosting`.
4. Nel pannello PT salva una bozza, ricarica la pagina e verifica che appaia nell’elenco bozze; poi pubblicala e controlla l’area Workout del cliente.

## Referti InBody 120

- Il PT può caricare JPG, PNG, WebP, HEIC o PDF (massimo 15 MB). Se il PDF contiene testo selezionabile, viene letto senza OCR; altrimenti il documento viene elaborato nel browser con PaddleOCR.js/PP-OCRv6, senza inviare l’immagine a un servizio OCR. Le risorse del modello vengono scaricate dal mirror ufficiale PaddlePaddle, ma il file del cliente resta locale durante l’estrazione.
- La schermata mostra l’anteprima normalizzata e permette di verificare data, peso, massa muscolare scheletrica e massa grassa. Il peso propone il valore dell’ultima riga dello storico InBody quando riconosciuta; il PT deve comunque controllare i tre valori sulla foto e confermare prima del salvataggio.
- La schermata principale mostra peso, massa muscolare e massa magra, calcolata come peso meno massa grassa. Gli altri parametri e il referto originale sono consultabili separatamente. Il server valida i valori essenziali e rifiuta misure fuori intervallo o date duplicate.
- Dopo la conferma, l’originale e una copia JPEG visualizzabile vengono sempre salvati nel bucket Supabase privato. La foto appare nella finestra dei dettagli; il collegamento all’originale è firmato e a scadenza. Solo il PT assegnato e il cliente possono leggerli. Eliminando il cliente, il backend rimuove entrambi.
- La migration crea il bucket privato, i permessi e un limite di 10 salvataggi BIA per PT ogni 10 minuti. Il bucket applica un massimo di 15 MB e accetta solo i formati previsti.

### Attivazione dopo l’aggiornamento

1. Se non lo hai già fatto, applica `supabase/migrations/202611090001_bia_reports.sql` al progetto Supabase; poi applica `supabase/migrations/202611100001_bia_report_previews.sql` (SQL Editor oppure Supabase CLI collegata al progetto). La seconda aggiorna la policy dello storage per la copia JPEG.
2. Pubblica la Edge Function aggiornata: `npx supabase functions deploy admin-api`.
3. Installa le dipendenze e pubblica Hosting con `npm install` e `npm run deploy:hosting`; lo script rigenera prima il bundle OCR necessario in `www/vendor/bia-runtime/`.
4. In **Storico e misure**, carica il referto e verifica data, peso, massa muscolare scheletrica e massa grassa guardando la foto. Conferma la casella dopo aver controllato i tre numeri e premi **Conferma e salva**. Dopo il salvataggio, la foto è visibile da **Altri dati e referto** e i valori principali e i grafici compaiono nello storico.
5. Per una scheda, il PT compila o importa il JSON, preme **Salva bozza** per conservarla oppure **Pubblica** per assegnarla al cliente. Il cliente la trova nella scheda **Workout** appena entra o dopo l’aggiornamento automatico.

Il report InBody contiene dati personali e di salute. Prima dell’uso reale il titolare deve documentare base giuridica, informativa, accessi, durata di conservazione e cancellazione secondo la normativa applicabile. Il codice non invia i documenti a servizi OCR esterni; i file conservati sono comunque trattati dal progetto Supabase configurato. Le quote del piano gratuito sono limitate e vanno controllate nel dashboard; caricare molti originali può esaurire lo spazio disponibile.

### Benchmark e limiti

`docs/bia-ocr-benchmark.md` riporta il confronto OCR e le trasformazioni eseguite sul referto fornito. La suite automatica usa fixture sintetiche di parole e riquadri, non conserva l’immagine reale: così il referto con ID e dati corporei non finisce nel repository. Le misure RapidOCR/PP-OCRv6 sono una selezione comparativa; non garantiscono la lettura perfetta di ogni foto futura. I controlli bloccanti e la correzione manuale restano obbligatori.
