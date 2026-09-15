-- Il vincolo su `cervellone_fic_pending.tipo` non conosce le MODIFICHE, e il
-- tool nato per correggere un documento gia' creato non potrebbe nemmeno
-- salvare la propria anteprima.
--
-- ⚠️ E' la QUARTA volta in due giorni che questa riga si scrive per lo stesso
-- motivo (`pagamento_emessa`, `autofattura`, `spesa_ricevuta`, e adesso
-- `modifica_documento`): il tool si ferma PRIMA di parlare con Fatture in
-- Cloud, sul salvataggio del pending, e l'Ingegnere si vede rispondere
--
--     new row for relation "cervellone_fic_pending"
--     violates check constraint "cervellone_fic_pending_tipo_check"
--
-- Il valore nuovo e' `modifica_documento`: la richiesta di cambiare campi di un
-- documento EMESSO gia' esistente su Fatture in Cloud (autofattura TD17,
-- fattura, nota) che non sia ancora stato trasmesso allo SdI. Serve perche'
-- fino a oggi un documento sbagliato si poteva solo cancellare e rifare, e su
-- una serie di numerazione fiscale questo lascia un BUCO. Il codice lo usa in
-- `fic-write-tools.ts` (PendingTipo, compilaModificaDocumento, confirmFicStep2,
-- eliminaBozzaFic, A_CONFERMA_SINGOLA) col motore in `fic-modifica.ts`.
--
-- 🚨 Il vincolo si RISCRIVE PER INTERO: `check` non si aggiunge a pezzi. I sei
-- valori gia' ammessi vanno tutti ripetuti, altrimenti questa migrazione non
-- allarga il vincolo — lo restringe, e i tipi dimenticati smettono di
-- funzionare in silenzio.
--
-- Additiva e idempotente: si riscrive il vincolo con un valore in piu'.

alter table public.cervellone_fic_pending
  drop constraint if exists cervellone_fic_pending_tipo_check;

alter table public.cervellone_fic_pending
  add constraint cervellone_fic_pending_tipo_check
  check (tipo in ('fattura_emessa', 'rapporto_intervento', 'pagamento_ricevuta', 'pagamento_emessa', 'autofattura', 'spesa_ricevuta', 'modifica_documento'));
