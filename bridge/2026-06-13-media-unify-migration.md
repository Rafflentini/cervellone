# Bridge — media-unify: migration prima del merge

## [Code] 20:44

[BLOCKED] Ho finito sul branch `feat/media-unify-commessa` (10 commit) la feature "documenti/video in commessa come le foto" + ricerca. È **flag-gated OFF** e NON ancora su `main`. Per andare avanti serve che tu applichi una migration in prod **PRIMA** del merge: il codice legge/scrive la colonna `kind` su `cervellone_foto_pending` in modo incondizionato, quindi deployare il codice prima della migration regredirebbe il path foto live.

**Cosa devi fare (in quest'ordine):**

1. **Applica la migration** in prod (progetto Supabase di Cervellone) col contenuto del file
   `supabase/migrations/2026-06-13-media-pending-unify.sql` (branch `feat/media-unify-commessa`).
   È **additiva e idempotente**: aggiunge a `cervellone_foto_pending` le colonne `kind` (default 'foto',
   check foto|video|doc), `batch_id`, `mime`; crea un indice; inserisce il flag di config
   `upload_batch_enabled`='false'; crea la tabella `cervellone_album_ack` (PK chat_id,batch_id) con RLS deny-all.
   Sicura da applicare SUBITO: il codice attualmente in prod non usa nessuna di queste colonne.

2. **Verifica** ed elenca qui sotto l'esito:
   - `cervellone_foto_pending` ha le colonne `kind`, `batch_id`, `mime`;
   - in `cervellone_config` esiste la riga `upload_batch_enabled` = `false`;
   - esiste la tabella `cervellone_album_ack`.

3. Quando confermi (1) e (2) OK, **Code** mergia `feat/media-unify-commessa` → `main` e fa il deploy
   (verifica READY + smoke). NON toccare tu il merge/deploy.

4. **Solo dopo** deploy verificato e quando Raffaele vuole ATTIVARE i documenti-in-commessa:
   metti `upload_batch_enabled` = `true` in `cervellone_config`. (Con flag OFF la feature è dormiente;
   `archivia_documento_commessa`/`cerca_media_archiviata` esistono ma i doc/video non entrano nel registro.)

@Raffaele: è un ALTER TABLE additivo + CREATE TABLE, reversibile e a impatto zero sul live (azione
richiesta esplicitamente). Conferma a Cowork di procedere col punto 1.

Dettagli completi: spec `docs/superpowers/specs/2026-06-13-upload-batch-registro-design.md` (sezione
"STATO IMPLEMENTAZIONE" + "DEPLOY-ORDER OBBLIGATORIO").
