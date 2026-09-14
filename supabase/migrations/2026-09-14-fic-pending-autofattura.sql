-- Il vincolo su `cervellone_fic_pending.tipo` non conosce le AUTOFATTURE, e il
-- tool nato per compilarle non potrebbe nemmeno salvare la propria anteprima.
--
-- ⚠️ Questa riga esiste PRIMA del primo uso vero, e non e' un caso. Stasera
-- (14 settembre 2026) lo stesso identico vincolo ha bloccato
-- `segna_fatture_emesse_pagate`: il verbo era nato con il suo codice, i suoi
-- test e la sua doppia conferma, ma il valore `pagamento_emessa` non era
-- ammesso — e la migrazione non esisteva NEMMENO NEL REPO. L'Ingegnere si e'
-- visto rispondere:
--
--     new row for relation "cervellone_fic_pending"
--     violates check constraint "cervellone_fic_pending_tipo_check"
--
-- cioe' il tool si fermava PRIMA di parlare con Fatture in Cloud, sul
-- salvataggio dell'anteprima. Non era una deriva fra repo e database: era
-- un'omissione, e nessuno strumento la vedeva perche' il repo non prometteva
-- niente da confrontare.
--
-- Qui il valore nuovo e' `autofattura`: UN pending che contiene N autofatture
-- in reverse charge per le fatture estere (tipo FIC `self_supplier_invoice`),
-- con una conferma sola per tutto il gruppo. Il codice lo usa in
-- `fic-write-tools.ts` (PendingTipo, compilaAutofatture, confirmFicStep2,
-- eliminaBozzaFic).
--
-- Additiva e idempotente: si riscrive il vincolo con un valore in piu'.

alter table public.cervellone_fic_pending
  drop constraint if exists cervellone_fic_pending_tipo_check;

alter table public.cervellone_fic_pending
  add constraint cervellone_fic_pending_tipo_check
  check (tipo in ('fattura_emessa', 'rapporto_intervento', 'pagamento_ricevuta', 'pagamento_emessa', 'autofattura'));
