# Cervellone V10 — Skill modulari + context pulito

**Data:** 2026-04-18
**Stato:** Approvato

## Problema

Il Cervellone risponde peggio di claude.ai nonostante usi lo stesso modello. Cause:

1. System prompt da 4.200 char pieno di regole che Claude sa già fare
2. Router modelli con 20 regex fragili e inutili
3. History che re-invia documenti HTML interi (15K char ciascuno) ad ogni messaggio
4. RAG che cerca embeddings anche per "ciao" (500-2000ms latenza)
5. Nessun streaming su Telegram — Opus sembra "rotto" perché 40 sec di silenzio

## Architettura V10

### 1. System prompt minimale (~500 char)

```
Sei il Cervellone — coordinatore digitale di Restruktura SRL, Ing. Raffaele Lentini, Villa d'Agri (PZ).
Restruktura: ingegneria strutturale, direzione lavori, collaudi, impresa edile, PonteggioSicuro.it.

Hai memoria persistente, tool specializzati per ogni reparto, e puoi auto-aggiornarti.
Per documenti strutturati usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.

Dai del Lei all'Ingegnere. Rispondi in italiano.
```

Zero regole comportamentali. Le regole operative vivono nelle skill.

### 2. Skill modulari su Supabase

Tabella `cervellone_skills`:

```sql
CREATE TABLE cervellone_skills (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  descrizione TEXT NOT NULL,
  istruzioni TEXT NOT NULL,
  tool_names TEXT[],
  keywords TEXT[],
  versione INT DEFAULT 1,
  istruzioni_precedenti TEXT,       -- rollback
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT DEFAULT 'system'
);
```

Skill iniziali:

| id | nome | keywords |
|---|---|---|
| studio_tecnico | Studio Tecnico | preventivo, computo, CME, relazione, calcolo, progetto, DXF, perizia, verifica |
| segreteria | Segreteria | lettera, email, fattura, contabilità, riconciliazione, F24, Fatture in Cloud |
| cantieri | Cantieri | POS, sicurezza, SAL, cantiere, collaudo, DL |
| marketing | Marketing | post, social, Instagram, blog, SEO, brochure, PonteggioSicuro |
| clienti | Clienti | offerta, cliente, rapporto, sopralluogo |
| self | Autoconsapevolezza | modello, versione, aggiornamento, opus, come funzioni, comandi, help |

**Caricamento automatico:** il backend rileva keyword nel messaggio utente e inietta la skill nel system prompt PRIMA di chiamare Claude. Niente tool call extra, zero latenza aggiuntiva.

```
"Fammi un preventivo" → keyword "preventivo" → skill studio_tecnico iniettata
"Ciao" → nessuna keyword → solo prompt base (500 char)
```

**Auto-evoluzione:** tool `modifica_skill` per cambiare le istruzioni di un reparto. Versioning automatico con rollback.

### 3. Context management

**Compressione documenti:** i blocchi `~~~document` vengono SEMPRE sostituiti con un riferimento breve nell'history, sia web che Telegram:
```
[Documento generato: "Preventivo Rossi" — /doc/abc123]
```
Da 15.000 char a 60 char.

**History Telegram:** max 10 messaggi (da 20), con stessa compressione del web.

**No summarization:** i messaggi di testo restano interi. Il vero spreco erano i documenti HTML, non i messaggi.

### 4. Modello unico: Opus ovunque

Default: **Opus** (il più potente disponibile) su tutti i canali.
Configurabile dalla tabella `cervellone_config`.

Comandi override:
- `/sonnet` — scala a Sonnet (per risparmiare o per task semplici)
- `/opus` — torna a Opus
- `/modello` — mostra modello attivo

Thinking budget:
- Opus: 100.000 thinking, 128.000 max tokens
- Sonnet: 10.000 thinking, 32.000 max tokens

Nessun router. Nessuna regex. L'utente decide.

### 5. Streaming simulato su Telegram

Opus ci mette 30-60 secondi. Oggi l'utente vede silenzio. Fix:

1. Manda messaggio placeholder: "Sto elaborando..." → salva `message_id`
2. Claude streamma (già implementato in V8)
3. Ogni 3 secondi → `editMessageText` con testo accumulato
4. Se supera 4.000 char → manda nuovo messaggio, continua editing su quello
5. Fine stream → edit finale con risposta completa

L'utente vede le parole apparire in tempo reale. Nessun timeout possibile — il messaggio è già lì dal secondo 1.

### 6. RAG intelligente

- Skip per messaggi che sono saluti puri (`/^(ciao|buongiorno|grazie|ok|sì|no|va bene|perfetto)[\s!?.]*$/i`)
- Max 5 risultati (da 15)
- Ogni risultato troncato a 500 char
- Cache per sessione

### 7. Comandi Telegram

| Comando | Cosa fa |
|---|---|
| `/nuova` | Azzera conversazione (esiste già) |
| `/opus` | Scala a Opus |
| `/sonnet` | Scala a Sonnet |
| `/modello` | Mostra modello attivo |
| `/aggiorna` | Check e auto-update modelli |
| `/skill` | Lista skill disponibili |
| `/help` | Mostra lista comandi |
| `/id` | Mostra chat ID (esiste già) |

Hardcodati nel backend — risposta istantanea senza chiamare Claude.

### 8. Fix secondari

- **digest.ts:** eliminare seconda chiamata API di verifica
- **tools.ts:** CSS preventivo usa `cssCommon` (elimina 2.400 char duplicati)
- **chat/page.tsx:** rimuovere `saveMessage` frontend, tenere solo backend
- **tools.ts:** ridurre tool descriptions a 1 riga ciascuna

## Cosa NON cambia

- Tool operativi (genera_preventivo_completo, cerca_prezziario, ecc.)
- Frontend UI
- Schema Supabase (messaggi, conversazioni, documenti, embeddings)
- Logica tool preventivo/CME/QE (scoring, pricing, HTML generation)

## Ordine implementazione

1. Tabella `cervellone_skills` + populate con regole attuali
2. Backend: keyword detection + iniezione skill nel system prompt
3. Nuovo `prompts.ts` minimale
4. Eliminare router, semplificare `claude.ts`
5. Context management: compressione documenti web + Telegram
6. Streaming simulato Telegram (editMessageText)
7. Comandi Telegram (/opus, /sonnet, /help, /modello, /skill, /aggiorna)
8. Tool `modifica_skill` + versioning
9. RAG ottimizzata
10. Fix secondari (digest, CSS, doppio salvataggio, tool descriptions)

## Principi guida

- Il system prompt dice CHI SEI. Le skill dicono COME LAVORI.
- Claude è libero al 100%. Le regole arrivano solo quando servono.
- Niente router, niente regex di routing, niente logica hardcoded.
- Un solo modello (Opus), ovunque, con streaming.
- Aggiungere un reparto = aggiungere una riga in cervellone_skills.
