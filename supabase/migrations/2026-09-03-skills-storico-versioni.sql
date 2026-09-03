-- Storico completo delle istruzioni delle skill.
--
-- Perche' esiste. `cervellone_skills` conserva UNA sola versione precedente, in
-- `istruzioni_precedenti`. Due modifiche di fila e l'originale e' perso per
-- sempre — e non e' teoria: al 3 settembre 2026 la skill `segreteria` e' alla
-- versione 3 con 1364 caratteri, mentre la precedente (v2) ne ha 3797. La v1
-- non esiste piu' da nessuna parte, e la v3 NON contiene piu' le istruzioni
-- sulle foto che la v2 aveva. E' l'incidente del 1 agosto, ancora leggibile nel
-- dato.
--
-- Da qui in avanti ogni versione viene appesa qui prima di essere sostituita:
-- niente si perde, e `ripristina_skill` puo' tornare indietro di piu' di un passo.

CREATE TABLE IF NOT EXISTS public.cervellone_skills_versioni (
  id            bigserial PRIMARY KEY,
  skill_id      text NOT NULL,
  versione      integer NOT NULL,
  istruzioni    text NOT NULL,
  updated_by    text,
  archiviata_il timestamptz NOT NULL DEFAULT now(),
  -- Una versione per skill non puo' esistere due volte: se un retry riscrivesse
  -- la stessa riga, lo storico direbbe due verita' diverse sullo stesso numero.
  CONSTRAINT cervellone_skills_versioni_unica UNIQUE (skill_id, versione)
);

CREATE INDEX IF NOT EXISTS cervellone_skills_versioni_skill_idx
  ON public.cervellone_skills_versioni (skill_id, versione DESC);

ALTER TABLE public.cervellone_skills_versioni ENABLE ROW LEVEL SECURITY;

-- Coerente con le altre 25 tabelle (RLS Fase 2/3): il bot scrive col service
-- role, che bypassa RLS. Nessuna policy per anon = nessun accesso dal browser.

-- Salvataggio di cio' che esiste ADESSO, prima che la prossima modifica lo
-- sovrascriva. Include la versione precedente ancora presente nell'unico slot:
-- e' l'ultima occasione per metterla al sicuro.
INSERT INTO public.cervellone_skills_versioni (skill_id, versione, istruzioni, updated_by)
SELECT id, versione, istruzioni, coalesce(updated_by, 'backfill 3 set 2026')
FROM public.cervellone_skills
WHERE istruzioni IS NOT NULL
ON CONFLICT (skill_id, versione) DO NOTHING;

INSERT INTO public.cervellone_skills_versioni (skill_id, versione, istruzioni, updated_by)
SELECT id, GREATEST(versione - 1, 1), istruzioni_precedenti,
       'backfill 3 set 2026: recuperata dall unico slot di backup'
FROM public.cervellone_skills
WHERE istruzioni_precedenti IS NOT NULL
  AND length(trim(istruzioni_precedenti)) > 0
  AND versione > 1
ON CONFLICT (skill_id, versione) DO NOTHING;
