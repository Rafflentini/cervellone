-- Il vincolo su `cervellone_fic_pending.tipo` non conosce le SPESE, e il tool
-- nato per registrarle non potrebbe nemmeno salvare la propria anteprima.
--
-- ⚠️ Questa riga esiste PRIMA del primo uso vero, ed e' la terza volta in due
-- giorni che la si scrive per lo stesso motivo. Il 14 settembre 2026 lo stesso
-- identico vincolo ha bloccato `segna_fatture_emesse_pagate`: il verbo era nato
-- con il suo codice, i suoi test e la sua conferma, ma il valore
-- `pagamento_emessa` non era ammesso — e la migrazione non esisteva NEMMENO NEL
-- REPO. L'Ingegnere si e' visto rispondere:
--
--     new row for relation "cervellone_fic_pending"
--     violates check constraint "cervellone_fic_pending_tipo_check"
--
-- cioe' il tool si fermava PRIMA di parlare con Fatture in Cloud, sul
-- salvataggio dell'anteprima. Non era una deriva fra repo e database: era
-- un'omissione, e nessuno strumento la vedeva perche' il repo non prometteva
-- niente da confrontare.
--
-- Qui il valore nuovo e' `spesa_ricevuta`: la fattura d'ACQUISTO di un
-- fornitore registrata come documento RICEVUTO su Fatture in Cloud (tipo FIC
-- `expense`), con il PDF della mail allegato e il piano pagamenti gia' saldato
-- per compensazione. E' la meta' mancante dell'integrazione TD17: senza, c'e'
-- l'IVA a debito dell'autofattura e nessuna fattura passiva a monte. Il codice
-- lo usa in `fic-write-tools.ts` (PendingTipo, compilaSpesaFornitore,
-- confirmFicStep2, eliminaBozzaFic) e in `conferma-fic.ts` (A_CONFERMA_SINGOLA).
--
-- 🚨 Il vincolo si RISCRIVE PER INTERO: `check` non si aggiunge a pezzi. I
-- cinque valori gia' ammessi vanno tutti ripetuti, altrimenti questa migrazione
-- non allarga il vincolo — lo restringe, e i tipi dimenticati smettono di
-- funzionare in silenzio.
--
-- Additiva e idempotente: si riscrive il vincolo con un valore in piu'.

alter table public.cervellone_fic_pending
  drop constraint if exists cervellone_fic_pending_tipo_check;

alter table public.cervellone_fic_pending
  add constraint cervellone_fic_pending_tipo_check
  check (tipo in ('fattura_emessa', 'rapporto_intervento', 'pagamento_ricevuta', 'pagamento_emessa', 'autofattura', 'spesa_ricevuta'));
