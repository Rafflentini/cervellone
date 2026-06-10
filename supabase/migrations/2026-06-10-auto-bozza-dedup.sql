-- D (P2) — Anti-race per le auto-bozze (artifact-capture).
--
-- Due turni concorrenti dello stesso bot possono inserire la STESSA auto-bozza
-- (stesso conversation_id + stesso content) prima che il dedup applicativo veda
-- la riga dell'altro turno. Aggiungiamo un indice unico PARZIALE che impedisce a
-- livello DB i duplicati esatti delle sole righe type='auto-bozza'.
--
-- md5(content) tiene l'indice compatto anche con content lunghi. Il filtro
-- WHERE type = 'auto-bozza' lascia liberi gli altri tipi di documento (html, ecc.).
--
-- Lato applicazione (captureArtifact) l'INSERT è tollerante alla unique violation
-- (Postgres 23505): la tratta come { saved: false, reason: 'duplicate' }, niente errore.
--
-- La colonna NON viene applicata al DB automaticamente: la applica l'orchestratore.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_auto_bozza_content
  ON public.documents (conversation_id, md5(content))
  WHERE type = 'auto-bozza';
