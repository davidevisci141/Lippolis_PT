# Audit iniziale e verifica

## Riscontri

- L'avvio atleta ricaricava dopo cambi di account o aggiornamenti realtime di stato e scheda. L'avvio salvava il marker remoto e richiamava `location.reload()`; i callback realtime ripetevano lo stesso schema. Le scritture di sincronizzazione potevano riattivare i callback e ricominciare il ciclo.
- Il costruttore era scollegato dal modello pubblicato: mostrava campi JSON e convertiva solo una parte dei metodi/serie. La pagina online riportata nello screenshot serviva risorse `program-v2`; nel codice aggiornato `inspectProgramDates` è importata esplicitamente.
- I blocchi avevano valori di esempio, cardinalità errata per alcuni metodi, target non neutri e controlli ripetuti. Le date venivano confrontate come istanti anziché come giorni di calendario.
- Il wrapper `<details>` aggiunto ai blocchi rendeva inefficaci selettori CSS che si aspettavano `header` come figlio diretto. Il titolo e i comandi andavano quindi su righe diverse.
- Non è presente un catalogo esercizi condiviso nel database; una libreria globale richiederebbe una migrazione e non è stata introdotta.

## Interventi per priorità

- **P0:** aggiornamenti remoti applicati in memoria senza reload; cambi di account aggiornano la chiave dati locale. Nessuna migrazione del database.
- **P1:** modello v2 condiviso, conteggi e validazione dei metodi, default vuoti, calcoli di volume/intensità/durata e date locali, stati bozza/versione e note comprimibili.
- **P2:** editor compatto con blocchi richiudibili, tabella interna scorrevole, riepilogo, pannello laterale a schede e layout responsive.
- **P3:** struttura, formule, limiti del catalogo e istruzioni test in `program-builder.md`.

## Limiti di verifica

Il browser automatico ha misurato il costruttore a 1920×1080, 1366×768 e 390×844. Non è stato possibile eseguire la matrice P0 autenticata di 60 secondi: manca una sessione atleta di test e non si deve inventare una credenziale. Il controllo automatico P0 eseguito è statico/unitario.
