-- Aggiunge colonna keywords alla tabella procedures (FIX A1 — crea_procedura).
-- Contiene array di alias/parole-chiave per il riconoscimento data-driven del tipo-task.
-- La colonna NON viene applicata al DB automaticamente: la applica l'orchestratore.
ALTER TABLE public.procedures
  ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]'::jsonb;
