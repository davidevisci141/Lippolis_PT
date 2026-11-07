# LIPPOLIS PT

Applicazione Firebase con due ruoli interni:

- `coach` — Personal Trainer;
- `athlete` — Cliente.

L’accesso non propone la scelta del ruolo e non contiene registrazione pubblica. Il PT crea i clienti dal pannello tramite una Cloud Function autenticata; la funzione usa Firebase Admin SDK, crea Auth e profilo Firestore con lo stesso UID e non cambia la sessione del PT.

## Struttura

- `www/index.html`: login, recupero password e primo accesso;
- `www/athlete.html`: area atleta esistente, conservata e collegata a Firestore;
- `www/coach.html`: elenco e dettaglio clienti, account, schede e risultati;
- `www/src/`: autenticazione, sincronizzazione e logica delle due aree;
- `functions/`: backend amministrativo con Admin SDK;
- `firestore.rules`: isolamento clienti e protezione dei campi autorizzativi;
- `firestore.indexes.json`: indici per clienti, bozze e messaggi;
- `scripts/`: promozione controllata del primo PT e associazione di utenti preesistenti;
- `test/`: test unitari e test con Emulator Suite.

Non vengono versionati `node_modules`, cache Firebase, credenziali di servizio o password.

## Modello dati

```text
profiles/{uid}
  role: coach | athlete
  status: active | suspended | deleting
  trainerId: UID del PT                 # solo athlete
  onboardingComplete: boolean
  passwordBaselineAt: number            # solo controllo primo cambio password
  program/current                       # scheda pubblicata
  programVersions/{versionId}           # versioni sostituite
  state/app                             # stato atleta con revisione ottimistica
  messages/{messageId}                  # messaggi, diario, domande differite

coaches/{coachUid}/drafts/{draftId}      # bozze private del PT
adminOperations/{operationId}            # idempotenza/ripresa operazioni backend
```

La scheda pubblicata e i risultati restano distinti. Ogni allenamento concluso registra `programVersionId`; sostituire una scheda non modifica lo storico. La cache locale dell’area atleta è separata per UID e Firestore resta la fonte condivisa tra dispositivi.

## Configurazione Firebase necessaria

1. Crea/seleziona il progetto Firebase e registra un’app Web.
2. Copia la configurazione pubblica in `www/firebase-config.js`. Non inserire service-account JSON o chiavi Admin nel frontend.
3. Copia `functions/.env.example` in `functions/.env.PROJECT_ID` e inserisci nella variabile `IDENTITY_TOOLKIT_API_KEY` la stessa Web API key presente in `www/firebase-config.js`. La Functions la usa per verificare sul server il cambio della password iniziale.
4. In **Authentication > Sign-in method**, abilita Email/Password.
5. In **Authentication > Settings > User actions**, disabilita la creazione e l’eliminazione degli account da parte degli utenti finali. Firebase documenta questa opzione come protezione server-side (`auth/admin-restricted-operation`); la sola rimozione del form non è sufficiente.
6. Autorizza i domini usati da Hosting e l’URL di ritorno delle email di verifica/password.
7. Crea Firestore nella regione scelta e pubblica regole e indici.
8. Pubblica le Functions in `europe-west1`.

```powershell
npm install
npm --prefix functions install
npx firebase-tools login
npx firebase-tools use PROJECT_ID
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Le Functions richiedono il piano **Blaze** e un account di fatturazione collegato. Non attivare fatturazione senza autorizzazione. Budget e avvisi di spesa non sono un tetto rigido. Finché Blaze non è autorizzato, tutto il flusso può essere collaudato negli emulatori, ma creazione/sospensione/eliminazione client non funzioneranno in produzione.

## Primo Personal Trainer

Il primo PT non viene mai assegnato al primo visitatore. Crealo in Firebase Authentication, verifica manualmente email e UID, poi usa Application Default Credentials:

```powershell
gcloud auth application-default login
npm run firebase:promote-coach -- --project PROJECT_ID --uid UID_ESATTO --email EMAIL_ESATTA
```

Lo script interrompe l’operazione se UID ed email non corrispondono o l’email non è verificata.

Per associare un cliente preesistente:

```powershell
npm run firebase:link-client -- --project PROJECT_ID --trainer UID_PT --athlete UID_CLIENTE
```

## Primo accesso del cliente

1. Il PT crea il cliente e comunica manualmente email e password iniziale.
2. Il cliente accede, verifica l’email e imposta una password personale di almeno 12 caratteri.
3. `completeOnboarding` controlla sul server `emailVerified` e che `passwordUpdatedAt` sia successivo alla password iniziale.
4. Regole e backend negano i dati finché profilo, stato, verifica e onboarding non sono validi.

La password iniziale non viene salvata in Firestore, cache, log o esportazioni. Dopo la chiusura del risultato di creazione non è recuperabile dal pannello.

## Test

Test rapidi senza emulatori:

```powershell
npm test
npm --prefix functions test
```

Test integrati isolati (la versione corrente della Emulator Suite richiede Java 21 o superiore):

```powershell
npm run test:emulators
```

I test integrati creano un PT e due clienti di prova e verificano: UID Auth/profilo, idempotenza, isolamento A/B, campi protetti, onboarding, pubblicazione/versioni scheda, risultati e peso corporeo, sospensione immediata tramite regole, riattivazione ed eliminazione ricorsiva. Non usare account o dati reali.

Per provare manualmente l’interfaccia:

```powershell
npm run emulators
```

Apri `http://127.0.0.1:5000/?emulator=1`. L’uso degli emulatori può essere memorizzato con `localStorage.lippolis_use_emulators = "1"` soltanto nell’ambiente locale.

## Note operative

- La sospensione imposta prima `profiles/{uid}.status = suspended`; le regole leggono lo stato corrente e bloccano anche un ID token già emesso. In seguito Auth viene disabilitato e i refresh token revocati.
- La cancellazione marca `deleting`, blocca Auth, elimina ricorsivamente documento e sottocollezioni e infine elimina l’utente Auth. `adminOperations` conserva solo stato tecnico minimo per una ripresa controllata.
- La pagina PT carica all’avvio soltanto i profili sintetici; storico, pesi e messaggi vengono letti quando si seleziona un cliente.
- Le scritture dello stato atleta usano revisioni ottimistiche. Un conflitto non viene annunciato come salvato e richiede un ricaricamento.
- L’invio email personalizzato non è implementato. Verifica e recupero password usano le email standard Firebase; configurare mittente e template dalla console.
