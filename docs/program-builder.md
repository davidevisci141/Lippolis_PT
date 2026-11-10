# Costruttore schede

## Moduli

- `www/coach.html`: struttura dell'area PT, componenti HTML e stili condivisi del pannello.
- `www/src/coach.mjs`: caricamento dei clienti, salvataggi/versioni, bozze e chiamate Supabase.
- `www/src/program-builder.mjs`: editor di settimane, sedute, blocchi, esercizi e serie.
- `www/src/workout-metrics.mjs`: modello v2, validazione e calcoli puri condivisi con l'area atleta.
- `www/src/athlete.mjs` e `www/athlete.html`: sincronizzazione e presentazione della scheda pubblicata sul lato atleta.
- Gli strumenti laterali hanno le schede Libreria, Volume e Progressione. La libreria è ricavata dalle schede caricate, non è un catalogo globale persistente.

## Calcoli

- Le serie utili sommano il peso configurato per ciascun tipo di serie; il riscaldamento vale zero per impostazione predefinita.
- Il volume per muscolo attribuisce una serie utile al muscolo primario e una quota configurabile ai secondari; nomi, maiuscole, accenti e sinonimi vengono normalizzati prima dell'aggregazione.
- L'intensità media considera le serie utili con target. RPE è convertito da RIR con `RPE = 10 - RIR`.
- La durata stimata usa ripetizioni (con stima configurabile per AMRAP), tempo di esecuzione, recuperi, cambi attrezzo e tempi di preparazione. È una stima; la disponibilità in minuti genera un avviso, non modifica la scheda.
- Gli intervalli di data si confrontano come giorni di calendario `YYYY-MM-DD`, senza interpretare le date come istanti UTC locali.

I range di volume predefiniti sono riferimenti modificabili, non indicazioni cliniche. Le prescrizioni non vengono generate automaticamente e i campi vuoti restano vuoti.

## Test

Eseguire `npm test` dalla radice del repository. I test `test/workout-metrics.test.cjs`, `test/program-builder-ui.test.cjs` e `test/athlete-reload.test.cjs` verificano calcoli/date, cardinalità dei metodi, prescrizioni neutre, componenti dell'interfaccia e assenza del reload nei listener di sincronizzazione.

Il database non è stato modificato in questo intervento. Il catalogo esercizi disponibile al costruttore viene appreso dalle schede già aperte/modificate; non esiste ancora un catalogo condiviso persistente tra clienti perché lo schema attuale non ne prevede uno.
