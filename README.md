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
