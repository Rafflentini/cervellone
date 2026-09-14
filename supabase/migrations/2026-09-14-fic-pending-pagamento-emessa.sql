-- Il vincolo su `cervellone_fic_pending.tipo` non conosceva gli INCASSI delle
-- fatture EMESSE, e il tool nato per registrarli non poteva nemmeno scrivere
-- la propria anteprima.
--
-- ⚠️ Cosa e' successo (14 settembre 2026). Il verbo `segna_fatture_emesse_pagate`
-- e' nato la notte del 13-14 col suo codice, i suoi test e la sua doppia
-- conferma — ma senza questa riga. Al primo uso vero l'Ingegnere si e' visto
-- rispondere:
--
--     new row for relation "cervellone_fic_pending"
--     violates check constraint "cervellone_fic_pending_tipo_check"
--
-- cioe' il tool si fermava PRIMA di parlare con Fatture in Cloud, sul
-- salvataggio dell'anteprima. Il codice usa `pagamento_emessa` in 8 punti
-- (`fic-write-tools.ts:41,48,59`); il vincolo ammetteva solo
-- `fattura_emessa`, `rapporto_intervento`, `pagamento_ricevuta`.
--
-- ⚠️ E NON era una deriva fra repo e database: la migrazione non esisteva
-- NEMMENO NEL REPO. Il guardiano acceso oggi confronta quello che il repo
-- promette con quello che il database ha, e qui il repo non prometteva niente.
-- Un'omissione, non una deriva — e nessuno strumento la vedeva.
--
-- Additiva e idempotente: si riscrive il vincolo con un valore in piu'.

alter table public.cervellone_fic_pending
  drop constraint if exists cervellone_fic_pending_tipo_check;

alter table public.cervellone_fic_pending
  add constraint cervellone_fic_pending_tipo_check
  check (tipo in ('fattura_emessa', 'rapporto_intervento', 'pagamento_ricevuta', 'pagamento_emessa'));
