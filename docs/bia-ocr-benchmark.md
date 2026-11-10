# Benchmark OCR per referti InBody 120

## Dataset e tutela dei dati

Il test usa un referto InBody 120 fornito dall’utente. Il documento contiene un identificativo e misure corporee; l’immagine e l’OCR completo restano fuori dal repository. I test committabili usano soltanto fixture sintetiche di parole, posizioni e confidence.

## Confronto motori

| Motore locale | Esito sul campione | Note |
|---|---|---|
| RapidOCR 3.10, PP-OCRv6 small (ONNX) | Tutti i 20 token numerici/data inclusi nel confronto sono stati letti correttamente sul referto e sulle varianti provate. | Circa 4,7–5,4 s su CPU Windows; output con testo, poligono e confidence. |
| Tesseract.js 5 | Confidence globale 66; errori sui decimali (ad es. 84,9 letto come 849 e 4,64 come 464). | Esito insufficiente senza controlli supplementari. |
| PaddleOCR.js/PP-OCRv6 | Scelto per l’esecuzione browser locale e per l’output con bounding box. | Il parser è verificato con l’output RapidOCR del campione; l’esecuzione end-to-end del bundle Paddle nel browser va ricontrollata dopo aver pubblicato il bundle. |

Le varianti testate includono ritaglio delle bande nere, rotazione fino a ±5°, lieve sfocatura, JPEG di bassa qualità, variazione di luminosità/contrasto, ritaglio alternativo e lieve prospettiva. Il punteggio di confronto non equivale a una garanzia per ogni scansione. Le fixture del parser coprono anche altri campi del referto, ma il salvataggio richiede solo data, peso, massa muscolare scheletrica e massa grassa, controllati dal PT.

## Criterio operativo

Il modello non salva mai automaticamente. La schermata propone il peso e la massa muscolare dall’ultima riga dello storico InBody quando riesce a leggerli; il PT controlla i tre numeri principali sulla foto e li conferma. La massa magra viene calcolata come peso meno massa grassa. I parametri secondari si leggono dal referto originale archiviato privatamente.

## Limiti conosciuti

- Il benchmark OCR comparativo è stato eseguito con RapidOCR; il runtime di produzione usa PaddleOCR.js/PP-OCRv6. Il bundle va provato in browser reale e con altri modelli di referto prima di considerare misurata la sua precisione operativa.
- Fotografie molto inclinate, sfocate, ritagliate o con layout diverso possono generare valori OCR da correggere. La schermata mantiene visibili anteprima e riquadro di provenienza per aiutare il controllo manuale.
- La migration del bucket e i permessi Storage devono essere applicati prima dell’archiviazione. Se l’archiviazione è selezionata e il bucket non è configurato, il salvataggio viene interrotto.
