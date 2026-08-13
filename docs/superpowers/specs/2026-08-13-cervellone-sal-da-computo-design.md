# SAL da computo — Design

**Data:** 2026-08-13
**Stato:** approvato (brainstorming)
**Contesto:** Cervellone deve generare uno Stato Avanzamento Lavori (SAL) a partire dal computo di una commessa, raggruppando le lavorazioni in gruppi coerenti, chiedendo la percentuale di avanzamento per gruppo, calcolando gli importi maturati secondo i termini del contratto, e salvando il documento approvato nella cartella `05_Contabilita Lavori` della commessa.

## Obiettivo

Dato il computo di una commessa (es. C2026-008 — Cond. E. Fermi, € 59.065,00, 42 voci), produrre un SAL n°N con:
- avanzamento per **gruppi di lavorazione coerenti** (10-15, non le singole 42 voci, non le 5 macro-categorie);
- importi **maturato a oggi / nel periodo** calcolati in modo **deterministico** (mai aritmetica dell'LLM);
- struttura economica (ritenuta, anticipazione, IVA) **derivata dal Contratto d'Appalto** della commessa;
- output **XLSX + PDF**, salvato in `05_Contabilita Lavori` dopo **doppia conferma**.

## Principio architetturale

**Calcoli in codice, dialogo all'LLM.** L'LLM gestisce la conversazione (propone i gruppi, raccoglie le percentuali, mostra le anteprime); tutti i numeri (maturati, ritenute, IVA, totali) sono prodotti da un **tool deterministico**. Motivazione: i valori di un SAL finiscono in un certificato di pagamento e devono essere esatti.

## Scelte confermate (brainstorming)

| Tema | Scelta |
|------|--------|
| Granularità | Gruppi coerenti proposti dal bot (~10-15), rivedibili dall'utente. NON tutte le voci, NON le macro-categorie. |
| Tipo SAL | Progressivo **manuale**: numerato; l'utente fornisce l'importo del SAL precedente; nessuna persistenza dello storico SAL. |
| Economia | Derivata dal **Contratto d'Appalto** (IVA, ritenuta a garanzia, anticipazione/acconto e suo recupero). Se il contratto non specifica → chiede all'utente. |
| Output | **XLSX + PDF**, doppia conferma (`/sal_ok_<id>`), salvataggio in `05_Contabilita Lavori/<commessa>`. |

## Componenti

### ① Estrazione computo → voci strutturate
- Individua la commessa e legge il computo (PDF in `05_Contabilita Lavori`, come già fa il bot).
- Estrae le voci strutturate: `codice, descrizione, quantità, prezzo_unitario, importo`.
- **Salvaguardia (obbligatoria):** verifica che `Σ importo_voci ≈ totale_computo` (tolleranza pochi euro per arrotondamenti). Se non riconcilia, **ferma e avvisa** ("estrazione incompleta/errata: Σ voci = X ≠ totale Y"), non procede con numeri sbagliati.
- Nota: l'estrazione da PDF è la parte più fragile. Se disponibile una versione XLSX del computo, preferirla. La riconciliazione col totale è il gate di qualità.

### ② Raggruppamento in gruppi coerenti
- L'LLM propone una mappatura `voce → gruppo` con gruppi coerenti (es. Ponteggio, Piattaforma aerea, Gronde/scossaline, Ripristino aggetti, Ripristino facciata, Ringhiere, Impianto elettrico…).
- Ogni gruppo ha `importo_contrattuale = Σ importo voci assegnate`.
- **Salvaguardia:** `Σ importo_gruppi = totale_computo` (ogni voce in esattamente un gruppo).
- L'utente rivede: sposta voci, unisce/divide gruppi, rinomina. Approva.

### ③ Parametri economici dal contratto
- Legge il Contratto d'Appalto della commessa ed estrae: `iva_perc`, `ritenuta_garanzia_perc` (se prevista), `anticipazione` (importo o %, e se va recuperata all'ultimo SAL).
- Mostra i parametri estratti per conferma. Se un dato manca nel contratto, lo chiede.

### ④ Calcolo SAL — tool deterministico
Input: gruppi con `importo_contrattuale` e `percentuale_avanzamento`, `sal_precedente` (importo, fornito dall'utente), parametri economici, flag `is_ultimo_sal`.
Calcolo:
1. Per gruppo: `maturato_a_oggi = importo_contrattuale × percentuale`.
2. `totale_maturato_a_oggi = Σ maturato_a_oggi_gruppi`.
3. `maturato_nel_periodo = totale_maturato_a_oggi − sal_precedente`.
4. `ritenuta_periodo = maturato_nel_periodo × ritenuta_garanzia_perc` (se prevista). Il tool riporta anche la ritenuta cumulata a titolo informativo (`totale_maturato_a_oggi × ritenuta_garanzia_perc`).
5. Recupero anticipazione: se `is_ultimo_sal` e presente → `recupero_anticipazione = importo anticipazione` (altrimenti 0).
6. `imponibile_certificato = maturato_nel_periodo − ritenuta_periodo − recupero_anticipazione`.
7. `iva = imponibile_certificato × iva_perc`; `totale_certificato = imponibile_certificato + iva`.
- Tutti gli importi arrotondati a 2 decimali; il tool ritorna un oggetto strutturato (nessun testo di calcolo dall'LLM).

### ⑤ Documento + salvataggio
- `genera_xlsx` (tabella: gruppo | importo contrattuale | % | maturato a oggi | maturato periodo; sezione riepilogo economico) + `genera_pdf` (SAL n°N intestato commessa, da firmare).
- Documento creato come **pending** con id → anteprima all'utente → `/sal_ok_<id>` → salvataggio in `05_Contabilita Lavori/<commessa>` su Drive.
- Nome file: `SAL_<n>_<commessa>_<data>.pdf/.xlsx`.

## Nuovi tool (bozza)
- `sal_estrai_computo(commessa)` → voci strutturate + riconciliazione totale.
- `sal_calcola(commessa, gruppi[{nome, importo_contrattuale, percentuale}], sal_precedente, params_economici, numero_sal, is_ultimo_sal)` → SAL calcolato (deterministico) + genera XLSX/PDF pending.
- `sal_conferma(id)` → salva in Drive `05_Contabilita Lavori`.
- Il raggruppamento (② ) e la lettura contratto (③) sono guidati dal prompt usando tool esistenti (drive_read_pdf/office) + un passaggio LLM; gli importi per gruppo restano somme deterministiche calcolate nel tool.

## Fuori scope (YAGNI)
- Persistenza storico SAL (scelta: progressivo manuale).
- Contabilità analitica per singola voce.
- Trasmissione/firma digitale del SAL.
- Registro contabile / libretto delle misure completo.

## Regole del prompt (da aggiungere)
- Procedura SAL: estrai→riconcilia→raggruppa→conferma gruppi→leggi contratto→conferma parametri→raccogli %→`sal_calcola`→anteprima→`/sal_ok`.
- Mai inventare numeri: importi solo dal ritorno di `sal_calcola`. Se la riconciliazione del computo fallisce, dillo e fermati (coerente con la regola anti-hallucination link/numeri).

## Testing
- Unit deterministici su `sal_calcola`: casi con/senza ritenuta, con/senza anticipazione, ultimo vs intermedio, SAL precedente 0 e >0. Verifica arrotondamenti e che `Σ gruppi` quadri.
- Test riconciliazione estrazione (Σ voci vs totale) con un computo campione.
