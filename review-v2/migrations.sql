-- ══════════════════════════════════════════════════════════════
-- CERVELLONE v2 — Database Migrations
-- Eseguire su Supabase SQL Editor nell'ordine
-- ══════════════════════════════════════════════════════════════

-- 1. REL-005: Aggiungere created_at a telegram_dedup (se mancante)
ALTER TABLE telegram_dedup 
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2. REL-005: Pulizia automatica dedup (eseguire manualmente periodicamente)
-- DELETE FROM telegram_dedup WHERE created_at < NOW() - INTERVAL '7 days';

-- 3. DAT-002: Indice vettoriale per embedding (quando > 10K righe)
-- CREATE INDEX IF NOT EXISTS idx_embeddings_vector 
-- ON embeddings USING hnsw (embedding vector_cosine_ops)
-- WITH (m = 16, ef_construction = 64);

-- 4. PER-003/FUN-004: Funzione RPC per ricerca prezziario avanzata
CREATE OR REPLACE FUNCTION search_prezziario(
  search_query TEXT,
  search_regione TEXT DEFAULT 'basilicata',
  max_results INT DEFAULT 10
) RETURNS TABLE (
  codice_voce TEXT,
  descrizione TEXT,
  unita_misura TEXT,
  prezzo NUMERIC,
  fonte TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT p.codice_voce, p.descrizione, p.unita_misura, p.prezzo, p.fonte
  FROM prezziario p
  WHERE p.regione = search_regione
    AND (
      p.descrizione ILIKE '%' || search_query || '%'
      OR p.codice_voce ILIKE '%' || search_query || '%'
    )
  ORDER BY
    CASE WHEN p.codice_voce ILIKE search_query || '%' THEN 0 ELSE 1 END,
    CASE WHEN p.descrizione ILIKE search_query THEN 0
         WHEN p.descrizione ILIKE search_query || '%' THEN 1
         ELSE 2 END,
    p.descrizione
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- 5. Indici per ricerca prezziario performante
CREATE INDEX IF NOT EXISTS idx_prezziario_regione ON prezziario(regione);
CREATE INDEX IF NOT EXISTS idx_prezziario_codice ON prezziario(codice_voce);
CREATE INDEX IF NOT EXISTS idx_prezziario_desc_trgm ON prezziario USING gin (descrizione gin_trgm_ops);
-- NOTA: il gin_trgm_ops richiede: CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 6. Indice per ricerca documenti
CREATE INDEX IF NOT EXISTS idx_documents_name ON documents USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);

-- 7. Indice per ricerca keyword negli embeddings
CREATE INDEX IF NOT EXISTS idx_embeddings_content_trgm ON embeddings USING gin (content gin_trgm_ops);
