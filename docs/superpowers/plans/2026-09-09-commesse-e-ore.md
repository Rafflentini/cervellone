# Commesse e ore — Piano di implementazione (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raccogliere le ore di ogni operaio su ogni commessa, senza compilazione manuale, prima che lo strumento attuale si spenga il 1 novembre 2026.

**Architecture:** Tre tabelle Postgres (`cervellone_commesse`, `cervellone_operai` + costi datati, `cervellone_timbrature`), la logica in moduli **puri** sotto `src/lib/commesse/` con i test accanto, due rotte API sottili, e una PWA a schermata singola per l'operaio. **La raccolta non passa dal modello**: la PWA scrive sulla tabella tramite le rotte, zero token e zero tool nuovi.

**Tech Stack:** Next.js (App Router) · Supabase Postgres · vitest · IndexedDB per la coda offline · nessuna libreria nuova in Fase 1.

**Spec:** `docs/superpowers/specs/2026-09-09-commesse-e-ore-design.md`

## Global Constraints

- **Scadenza dura: 1 novembre 2026.** Traguardo utile **metà ottobre**: i Task 1-6 devono essere in produzione entro quella data. I Task 7+ vengono dopo.
- **TDD sempre**, secondo `superpowers:test-driven-development`: test prima, si guarda fallire, poi il codice.
- **Mutation testing su ogni guardia.** ⚠️ I sorgenti sono **CRLF**: `perl -0pi` con pattern multiriga **non morde e dà un falso verde**. Usare `sed -i '<riga>s/.*/…/'` e **contare le occorrenze prima di leggere l'esito**.
- **I mock devono far rispettare i vincoli VERI del database** (violazione `23505`, CHECK constraint). Un mock che accetta tutto dice verde su codice rotto.
- **Verifica nel browser** dopo ogni Task che tocchi qualcosa di visibile, con `read_page` e non a occhio (`feedback_audit_anche_sul_browser`).
- **Le migrazioni non si applicano da sole**: le applica l'orchestratore su Supabase, **prima** di spingere il codice che le usa.
- **Una stima non si traveste mai da misura.** Ogni valore prodotto dal sistema e non dichiarato da una persona porta la propria provenienza.
- **Ogni numero dev'essere apribile**: mai un totale senza le sue componenti.
- **Niente tool nuovi per il modello in questa fase.**
- Codice e commenti **in italiano**, come il resto del repo. Commenti che dicono *perché*, non *cosa*.

---

## Struttura dei file

| File | Responsabilità |
|---|---|
| `supabase/migrations/2026-09-10-commesse.sql` | Tabella commesse |
| `supabase/migrations/2026-09-11-operai.sql` | Operai e costi orari datati |
| `supabase/migrations/2026-09-12-timbrature.sql` | Timbrature, correzioni, indici unici |
| `src/lib/commesse/commessa.ts` | Codice commessa, stati, transizioni. **Puro.** |
| `src/lib/commesse/costo-orario.ts` | Scelta del costo valido a una data. **Puro.** |
| `src/lib/commesse/turni.ts` | Regole del turno: apertura, chiusura, pausa, transito, somma ore. **Puro.** |
| `src/lib/commesse/db.ts` | Le sole letture/scritture su Supabase. Nessuna regola qui. |
| `src/lib/commesse/accesso-operaio.ts` | Chi è l'operaio che bussa. Riusa `confronto-costante.ts`. |
| `src/app/api/cantiere/timbra/route.ts` | POST: apre o chiude un turno |
| `src/app/api/cantiere/stato/route.ts` | GET: cosa mostrare all'operaio |
| `src/app/api/gestione/giornata/route.ts` | GET/PATCH: la giornata di tutti, e le correzioni |
| `src/app/cantiere/page.tsx` | La PWA dell'operaio |
| `src/app/cantiere/coda-offline.ts` | Accodamento locale e sincronizzazione |
| `src/app/cantiere/layout.tsx` | Manifesto PWA, icone, tema |
| `src/app/gestione-commesse/page.tsx` | Il gestionale (cantieri, giornata, correzioni) |

---

## Task 1: Anagrafica commesse

**Files:**
- Create: `supabase/migrations/2026-09-10-commesse.sql`
- Create: `src/lib/commesse/commessa.ts`
- Test: `src/lib/commesse/commessa.test.ts`

**Interfaces:**
- Produces: `type StatoCommessa = 'attivo' | 'archiviato'` · `transizioneValida(da, a): boolean` · `normalizzaCodice(grezzo: string): string | null` · `type Commessa`

- [ ] **Step 1: Scrivere la migrazione**

```sql
-- supabase/migrations/2026-09-10-commesse.sql
-- La commessa: il perno che oggi non esiste.
--
-- Misurato il 9 set 2026: non c'e' nessuna tabella di commesse. Il cantiere
-- compare come TESTO LIBERO in `project_state.cantiere` (2 righe) e in
-- `cervellone_foto_contesto.cantiere`. Ore, fatture e rapportini non hanno
-- niente a cui attaccarsi, e ogni numero calcolato su una stringa scritta a
-- mano eredita l'ambiguita' di quella stringa.
--
-- `raggio_m` e `tolleranza_viaggio_min` esistono da subito ma non servono
-- finche' la geolocalizzazione e' spenta: la posizione del CANTIERE non e' un
-- dato personale — e' un luogo di lavoro, come l'indirizzo su una fattura —
-- quindi si puo' compilare senza aspettare nessuna autorizzazione.

CREATE TABLE IF NOT EXISTS public.cervellone_commesse (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codice                  text NOT NULL UNIQUE,
  cliente                 text,
  descrizione             text,
  societa                 text NOT NULL DEFAULT 'restruktura',
  stato                   text NOT NULL DEFAULT 'attivo'
                            CHECK (stato IN ('attivo', 'archiviato')),
  con_trasferta           boolean NOT NULL DEFAULT false,
  indennita_trasferta_eur numeric(10,2),
  lat                     double precision,
  lon                     double precision,
  raggio_m                integer NOT NULL DEFAULT 500,
  tolleranza_viaggio_min  integer NOT NULL DEFAULT 30,
  creata_il               timestamptz NOT NULL DEFAULT now(),
  aggiornata_il           timestamptz NOT NULL DEFAULT now()
);

-- Chi ha archiviato o riattivato, e quando. NON e' burocrazia: la resa di un
-- cantiere chiuso a giugno e riaperto a settembre e' la somma di due periodi
-- diversi, e senza le date si confronterebbero mele con pere proprio nel
-- momento in cui quel dato serve per fare un prezzo.
CREATE TABLE IF NOT EXISTS public.cervellone_commesse_transizioni (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commessa_id  uuid NOT NULL REFERENCES public.cervellone_commesse(id) ON DELETE CASCADE,
  da_stato     text NOT NULL,
  a_stato      text NOT NULL,
  chi          text NOT NULL,
  quando       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cervellone_commesse ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cervellone_commesse_transizioni ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
// src/lib/commesse/commessa.test.ts
import { describe, it, expect } from 'vitest'
import { normalizzaCodice, transizioneValida } from './commessa'

describe('il codice della commessa e uno solo, scritto in un modo solo', () => {
  it('normalizza spazi e maiuscole', () => {
    expect(normalizzaCodice('  c2026-008 ')).toBe('C2026-008')
  })

  it('rifiuta cio che non e un codice', () => {
    // Il codice e' la CHIAVE su cui si appoggiano ore, fatture e rapportini.
    // Accettare testo libero qui rifarebbe il difetto che questa fase chiude.
    expect(normalizzaCodice('cantiere di Moliterno')).toBeNull()
    expect(normalizzaCodice('')).toBeNull()
  })
})

describe('gli stati della commessa', () => {
  it('si archivia e si riattiva', () => {
    expect(transizioneValida('attivo', 'archiviato')).toBe(true)
    expect(transizioneValida('archiviato', 'attivo')).toBe(true)
  })

  it('CONTROLLO POSITIVO: una transizione verso se stessi non e una transizione', () => {
    // Senza questo, il test sopra passerebbe con una funzione che ritorna
    // sempre true.
    expect(transizioneValida('attivo', 'attivo')).toBe(false)
    expect(transizioneValida('archiviato', 'archiviato')).toBe(false)
  })
})
```

- [ ] **Step 3: Eseguirlo e vederlo fallire**

Run: `npx vitest run src/lib/commesse/commessa.test.ts`
Expected: FAIL — `Cannot find module './commessa'`

- [ ] **Step 4: Scrivere il modulo minimo**

```typescript
// src/lib/commesse/commessa.ts
/**
 * La commessa: codice, stati, transizioni.
 *
 * Il codice e' la chiave su cui si appoggiano ore, fatture e rapportini.
 * Accettare testo libero qui rifarebbe esattamente il difetto che questa fase
 * chiude — un cantiere che e' una stringa scritta a mano, diversa ogni volta.
 */
export type StatoCommessa = 'attivo' | 'archiviato'

export interface Commessa {
  id: string
  codice: string
  cliente: string | null
  descrizione: string | null
  stato: StatoCommessa
  con_trasferta: boolean
  indennita_trasferta_eur: number | null
  raggio_m: number
  tolleranza_viaggio_min: number
}

/** Formato: una lettera, l'anno, un trattino, tre cifre. Es. `C2026-008`. */
const FORMATO_CODICE = /^[A-Z]\d{4}-\d{3}$/

export function normalizzaCodice(grezzo: string): string | null {
  const pulito = grezzo.trim().toUpperCase()
  return FORMATO_CODICE.test(pulito) ? pulito : null
}

export function transizioneValida(da: StatoCommessa, a: StatoCommessa): boolean {
  return da !== a
}
```

- [ ] **Step 5: Eseguirlo e vederlo passare**

Run: `npx vitest run src/lib/commesse/commessa.test.ts`
Expected: PASS (4 test)

- [ ] **Step 6: Mutazione — la normalizzazione accetta tutto**

```bash
cp src/lib/commesse/commessa.ts /tmp/c.o
L=$(grep -n "return FORMATO_CODICE.test(pulito)" src/lib/commesse/commessa.ts | cut -d: -f1)
sed -i "${L}s/.*/  return pulito \/\/ MUTATO/" src/lib/commesse/commessa.ts
grep -c MUTATO src/lib/commesse/commessa.ts   # DEVE dire 1
npx vitest run src/lib/commesse/commessa.test.ts   # DEVE fallire
cp /tmp/c.o src/lib/commesse/commessa.ts
md5sum src/lib/commesse/commessa.ts
```

- [ ] **Step 7: Applicare la migrazione su Supabase e verificarla**

L'orchestratore esegue il contenuto di `2026-09-10-commesse.sql` con `execute_sql`, poi:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'public.cervellone_commesse'::regclass;
```
Expected: PRIMARY KEY, UNIQUE su `codice`, CHECK su `stato`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-10-commesse.sql src/lib/commesse/
git commit -m "commesse: il perno che non esisteva"
```

---

## Task 2: Operai e costo orario datato

**Files:**
- Create: `supabase/migrations/2026-09-11-operai.sql`
- Create: `src/lib/commesse/costo-orario.ts`
- Test: `src/lib/commesse/costo-orario.test.ts`

**Interfaces:**
- Consumes: niente da Task 1
- Produces: `type CostoOrario = { costo_orario_eur: number; valido_dal: string }` · `costoValidoIl(costi: CostoOrario[], giorno: string): CostoOrario | null`

- [ ] **Step 1: Scrivere la migrazione**

```sql
-- supabase/migrations/2026-09-11-operai.sql
-- Chi lavora, e quanto costa un'ora del suo tempo.
--
-- Il costo e' in una tabella SEPARATA e DATATA. Con un solo numero per operaio,
-- al primo rinnovo del CCNL o al primo passaggio di livello tutta la storia dei
-- margini si riscriverebbe da sola, in silenzio: un cantiere chiuso a giugno
-- cambierebbe marginalita' a novembre senza che nessuno abbia toccato niente.
--
-- ⭐ Il metro con cui hai misurato va conservato insieme alla misura.

CREATE TABLE IF NOT EXISTS public.cervellone_operai (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL,
  cognome    text NOT NULL,
  livello    text,                       -- CCNL Edilizia Industria
  preposto   boolean NOT NULL DEFAULT false,
  attivo     boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL UNIQUE,       -- mai il token in chiaro
  creato_il  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cervellone_operai_costo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operaio_id        uuid NOT NULL REFERENCES public.cervellone_operai(id) ON DELETE CASCADE,
  costo_orario_eur  numeric(10,4) NOT NULL CHECK (costo_orario_eur > 0),
  valido_dal        date NOT NULL,
  note              text,
  creato_il         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operaio_id, valido_dal)
);

ALTER TABLE public.cervellone_operai ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cervellone_operai_costo ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
// src/lib/commesse/costo-orario.test.ts
import { describe, it, expect } from 'vitest'
import { costoValidoIl } from './costo-orario'

const COSTI = [
  { costo_orario_eur: 24.50, valido_dal: '2026-01-01' },
  { costo_orario_eur: 26.80, valido_dal: '2026-06-01' },
]

describe('il costo di un turno e quello in vigore IL GIORNO del turno', () => {
  it('un turno di marzo usa il costo di gennaio, non quello di giugno', () => {
    // E' il difetto che questa regola esiste per impedire: senza, al primo
    // rinnovo del CCNL la marginalita' dei cantieri gia' chiusi si riscrive da
    // sola, in silenzio.
    expect(costoValidoIl(COSTI, '2026-03-15')?.costo_orario_eur).toBe(24.50)
  })

  it('un turno di luglio usa il costo di giugno', () => {
    expect(costoValidoIl(COSTI, '2026-07-02')?.costo_orario_eur).toBe(26.80)
  })

  it('il giorno stesso in cui entra in vigore, vale il nuovo', () => {
    expect(costoValidoIl(COSTI, '2026-06-01')?.costo_orario_eur).toBe(26.80)
  })

  it('prima di qualunque costo NON si stima: si dichiara che non c e', () => {
    // Un margine calcolato su un costo inventato e' peggio di un margine che
    // dichiara di essere incompleto.
    expect(costoValidoIl(COSTI, '2025-12-31')).toBeNull()
  })

  it('CONTROLLO POSITIVO: con un costo solo lo trova comunque', () => {
    // Senza questo, i test sopra passerebbero anche con una funzione che
    // ritorna sempre null.
    expect(costoValidoIl([COSTI[0]], '2026-09-09')?.costo_orario_eur).toBe(24.50)
  })
})
```

- [ ] **Step 3: Eseguirlo e vederlo fallire**

Run: `npx vitest run src/lib/commesse/costo-orario.test.ts`
Expected: FAIL — `Cannot find module './costo-orario'`

- [ ] **Step 4: Scrivere il modulo minimo**

```typescript
// src/lib/commesse/costo-orario.ts
/**
 * Il costo orario in vigore a una data.
 *
 * Datato apposta: con un solo numero per operaio, al primo rinnovo del CCNL
 * tutta la storia dei margini si riscriverebbe da sola. Un cantiere chiuso a
 * giugno cambierebbe marginalita' a novembre senza che nessuno abbia toccato
 * niente, e nessuno se ne accorgerebbe.
 */
export interface CostoOrario {
  costo_orario_eur: number
  valido_dal: string   // YYYY-MM-DD
}

/**
 * Il costo con `valido_dal` piu' recente fra quelli **non successivi** al
 * giorno del turno. `null` se per quel giorno non ne esiste nessuno: in quel
 * caso il turno NON si valorizza con una stima — si elenca nella quadratura
 * mensile e lo si dice.
 */
export function costoValidoIl(costi: CostoOrario[], giorno: string): CostoOrario | null {
  const applicabili = costi
    .filter(c => c.valido_dal <= giorno)
    .sort((a, b) => (a.valido_dal < b.valido_dal ? 1 : -1))
  return applicabili[0] ?? null
}
```

- [ ] **Step 5: Eseguirlo e vederlo passare**

Run: `npx vitest run src/lib/commesse/costo-orario.test.ts`
Expected: PASS (5 test)

- [ ] **Step 6: Mutazione — il filtro sulla data cade**

```bash
cp src/lib/commesse/costo-orario.ts /tmp/co.o
L=$(grep -n "filter(c => c.valido_dal <= giorno)" src/lib/commesse/costo-orario.ts | cut -d: -f1)
sed -i "${L}s/.*/    .filter(() => true) \/\/ MUTATO/" src/lib/commesse/costo-orario.ts
grep -c MUTATO src/lib/commesse/costo-orario.ts   # DEVE dire 1
npx vitest run src/lib/commesse/costo-orario.test.ts   # DEVE fallire
cp /tmp/co.o src/lib/commesse/costo-orario.ts
```

- [ ] **Step 7: Applicare la migrazione e verificarla**

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'public.cervellone_operai_costo'::regclass;
```
Expected: UNIQUE `(operaio_id, valido_dal)`, CHECK `costo_orario_eur > 0`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-11-operai.sql src/lib/commesse/costo-orario.*
git commit -m "operai: il costo orario e datato, o la storia si riscrive da sola"
```

---

## Task 3: Le regole del turno

**Files:**
- Create: `supabase/migrations/2026-09-12-timbrature.sql`
- Create: `src/lib/commesse/turni.ts`
- Test: `src/lib/commesse/turni.test.ts`

**Interfaces:**
- Consumes: `Commessa` da Task 1
- Produces: `type TipoRiga = 'lavoro' | 'transito'` · `type OrigineFine = 'operaio' | 'sistema' | 'ufficio'` · `type Riga` · `prossimoGesto(stato): Gesto[]` · `oreDi(righe: Riga[]): { lavoro: number; transito: number }` · `chiusuraDimenticata(riga, fineStandard): Riga`

- [ ] **Step 1: Scrivere la migrazione**

```sql
-- supabase/migrations/2026-09-12-timbrature.sql
-- Un turno per riga. Un transito e' una riga come le altre, con `tipo` diverso
-- e la commessa di DESTINAZIONE: le ore di una commessa sono la somma di
-- lavoro + transito, e il prospetto le mostra distinte. Non serve una tabella a
-- parte e soprattutto non serve una regola di calcolo — il costo del viaggio e'
-- gia' dove deve stare.

CREATE TABLE IF NOT EXISTS public.cervellone_timbrature (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operaio_id    uuid NOT NULL REFERENCES public.cervellone_operai(id),
  commessa_id   uuid NOT NULL REFERENCES public.cervellone_commesse(id),
  tipo          text NOT NULL CHECK (tipo IN ('lavoro', 'transito')),
  inizio        timestamptz NOT NULL,
  fine          timestamptz,
  origine_fine  text CHECK (origine_fine IN ('operaio', 'sistema', 'ufficio')),
  stato         text NOT NULL DEFAULT 'aperto'
                  CHECK (stato IN ('aperto', 'chiuso', 'da_confermare', 'confermato')),
  client_msg_id text,
  posizione_esito text CHECK (posizione_esito IN ('dentro_area', 'fuori_area', 'non_attendibile')),
  raggio_applicato_m       integer,
  tolleranza_applicata_min integer,
  creata_il     timestamptz NOT NULL DEFAULT now()
);

-- La chiave d'invio: il telefono ne conia una per timbratura, ritenta quanto
-- vuole, il database ne accetta una sola. E' lo stesso meccanismo messo in
-- produzione sulla chat web il 9 set 2026 e provato contro il server vero.
-- PARZIALE, perche' una riga creata dall'ufficio non ha nessuna chiave.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_timbrature_client_msg_id
  ON public.cervellone_timbrature (operaio_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

-- Un operaio non puo' avere DUE righe aperte insieme. Il vincolo sta sul
-- database e non solo nell'app, perche' l'app gira su un telefono che puo'
-- essere offline e ritentare.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_timbrature_una_aperta
  ON public.cervellone_timbrature (operaio_id)
  WHERE fine IS NULL;

CREATE TABLE IF NOT EXISTS public.cervellone_timbrature_correzioni (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timbratura_id uuid NOT NULL REFERENCES public.cervellone_timbrature(id) ON DELETE CASCADE,
  campo         text NOT NULL,
  valore_prima  text,
  valore_dopo   text,
  chi           text NOT NULL,
  quando        timestamptz NOT NULL DEFAULT now(),
  motivo        text
);

ALTER TABLE public.cervellone_timbrature ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cervellone_timbrature_correzioni ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
// src/lib/commesse/turni.test.ts
import { describe, it, expect } from 'vitest'
import { oreDi, chiusuraDimenticata, prossimoGesto } from './turni'

const riga = (o: Partial<Parameters<typeof oreDi>[0][number]> = {}) => ({
  tipo: 'lavoro' as const,
  inizio: '2026-09-09T07:00:00Z',
  fine: '2026-09-09T12:00:00Z',
  commessa_id: 'c1',
  stato: 'chiuso' as const,
  origine_fine: 'operaio' as const,
  ...o,
})

describe('le ore di una commessa: lavoro e transito, distinti', () => {
  it('somma il lavoro', () => {
    expect(oreDi([riga()]).lavoro).toBe(5)
  })

  it('il transito finisce nelle ore della commessa di DESTINAZIONE, ma separato', () => {
    // Un cantiere lontano costa davvero di piu', e quella differenza deve
    // restare visibile nel numero su cui si decide se accettare lavori sulla
    // costa. Ma dev'essere anche distinguibile dal lavoro.
    const esito = oreDi([
      riga(),
      riga({ tipo: 'transito', inizio: '2026-09-09T12:30:00Z', fine: '2026-09-09T13:10:00Z' }),
    ])
    expect(esito.lavoro).toBe(5)
    expect(esito.transito).toBeCloseTo(40 / 60, 5)
  })

  it('un turno ancora aperto non si conta come se fosse chiuso', () => {
    expect(oreDi([riga({ fine: null })]).lavoro).toBe(0)
  })
})

describe('la pausa e il buco fra due turni: nessuna sottrazione', () => {
  it('due turni sullo stesso cantiere si sommano, e la pausa non si tocca', () => {
    // Dedurre un'ora fissa toglierebbe ore VERE a chi lavora durante la pausa,
    // ogni giorno, in silenzio. La pausa e' l'unico punto del sistema che puo'
    // togliere ore: dev'essere una dichiarazione dell'operaio, non un calcolo.
    const esito = oreDi([
      riga({ inizio: '2026-09-09T07:56:00Z', fine: '2026-09-09T12:56:00Z' }),
      riga({ inizio: '2026-09-09T13:59:00Z', fine: '2026-09-09T17:08:00Z' }),
    ])
    expect(esito.lavoro).toBeCloseTo(5 + 189 / 60, 5)
  })
})

describe('un turno dimenticato viene chiuso, ma non finge di essere timbrato', () => {
  it('la chiusura automatica dichiara di essere del SISTEMA', () => {
    const chiusa = chiusuraDimenticata(riga({ fine: null }), '2026-09-09T17:00:00Z')

    expect(chiusa.fine).toBe('2026-09-09T17:00:00Z')
    expect(chiusa.origine_fine).toBe('sistema')
    expect(chiusa.stato).toBe('da_confermare')
  })

  it('CONTROLLO POSITIVO: un turno gia chiuso dall operaio non viene toccato', () => {
    // Senza questo, il test sopra passerebbe anche con una funzione che marca
    // TUTTO come chiuso dal sistema — cancellando la differenza fra un'ora
    // timbrata e una stimata, che e' esattamente cio' che si vuole evitare.
    const gia = riga()
    expect(chiusuraDimenticata(gia, '2026-09-09T17:00:00Z')).toEqual(gia)
  })
})

describe('cosa puo fare l operaio, dato dov e', () => {
  it('a turno chiuso: entrare, o partire dal deposito', () => {
    expect(prossimoGesto('chiuso')).toEqual(['entra', 'parti-dal-deposito'])
  })

  it('a turno aperto: uscire, pausa, cambio cantiere', () => {
    expect(prossimoGesto('aperto')).toEqual(['esci', 'inizio-pausa', 'cambio-cantiere'])
  })

  it('in pausa: rientro, oppure uscire', () => {
    expect(prossimoGesto('in-pausa')).toEqual(['rientro', 'esci'])
  })

  it('in transito: sono arrivato, oppure ho cambiato idea', () => {
    expect(prossimoGesto('in-transito')).toEqual(['sono-arrivato', 'cambio-destinazione'])
  })
})
```

- [ ] **Step 3: Eseguirlo e vederlo fallire**

Run: `npx vitest run src/lib/commesse/turni.test.ts`
Expected: FAIL — `Cannot find module './turni'`

- [ ] **Step 4: Scrivere il modulo minimo**

```typescript
// src/lib/commesse/turni.ts
/**
 * Le regole del turno. Pure: entrano righe, escono numeri e decisioni.
 *
 * Nessuna di queste funzioni tocca il database o l'orologio: l'ora di chiusura
 * arriva da fuori, cosi' i test la fissano invece di inseguirla.
 */
export type TipoRiga = 'lavoro' | 'transito'
export type OrigineFine = 'operaio' | 'sistema' | 'ufficio'
export type StatoRiga = 'aperto' | 'chiuso' | 'da_confermare' | 'confermato'
export type StatoOperaio = 'chiuso' | 'aperto' | 'in-pausa' | 'in-transito'
export type Gesto =
  | 'entra' | 'parti-dal-deposito'
  | 'esci' | 'inizio-pausa' | 'cambio-cantiere'
  | 'rientro'
  | 'sono-arrivato' | 'cambio-destinazione'

export interface Riga {
  tipo: TipoRiga
  inizio: string
  fine: string | null
  commessa_id: string
  stato: StatoRiga
  origine_fine: OrigineFine | null
}

function ore(inizio: string, fine: string): number {
  return (Date.parse(fine) - Date.parse(inizio)) / 3_600_000
}

/**
 * Ore di lavoro e ore di transito, separate.
 *
 * La pausa non compare: e' il BUCO fra due righe, quindi non c'e' niente da
 * sottrarre. Dedurre un'ora fissa toglierebbe ore vere a chi lavora durante la
 * pausa, ogni giorno e in silenzio.
 */
export function oreDi(righe: Riga[]): { lavoro: number; transito: number } {
  let lavoro = 0
  let transito = 0
  for (const r of righe) {
    if (!r.fine) continue          // aperto: non si conta come chiuso
    const d = ore(r.inizio, r.fine)
    if (r.tipo === 'transito') transito += d
    else lavoro += d
  }
  return { lavoro, transito }
}

/**
 * Chiude un turno dimenticato, DICHIARANDO che l'ha chiuso il sistema.
 *
 * Le due alternative sono peggiori. Lasciarlo aperto significa una giornata di
 * lavoro che non esiste nel cruscotto e un margine sbagliato per difetto.
 * Chiuderlo in silenzio produce ore indistinguibili da quelle vere: fra sei
 * mesi si guarda un margine senza poter sapere quali ore sono state timbrate e
 * quali stimate.
 *
 * ⭐ Una stima non si traveste mai da misura.
 */
export function chiusuraDimenticata(riga: Riga, fineStandard: string): Riga {
  if (riga.fine) return riga
  return { ...riga, fine: fineStandard, origine_fine: 'sistema', stato: 'da_confermare' }
}

/** I gesti possibili, dato lo stato in cui si trova l'operaio. */
export function prossimoGesto(stato: StatoOperaio): Gesto[] {
  switch (stato) {
    case 'chiuso':      return ['entra', 'parti-dal-deposito']
    case 'aperto':      return ['esci', 'inizio-pausa', 'cambio-cantiere']
    case 'in-pausa':    return ['rientro', 'esci']
    case 'in-transito': return ['sono-arrivato', 'cambio-destinazione']
  }
}
```

- [ ] **Step 5: Eseguirlo e vederlo passare**

Run: `npx vitest run src/lib/commesse/turni.test.ts`
Expected: PASS (9 test)

- [ ] **Step 6: Tre mutazioni, tutte da uccidere**

```bash
cp src/lib/commesse/turni.ts /tmp/t.o

# A — la marcatura «chiuso dal sistema» sparisce
L=$(grep -n "origine_fine: 'sistema', stato: 'da_confermare'" src/lib/commesse/turni.ts | cut -d: -f1)
sed -i "${L}s/.*/  return { ...riga, fine: fineStandard } \/\/ MUTATO/" src/lib/commesse/turni.ts
grep -c MUTATO src/lib/commesse/turni.ts   # DEVE dire 1
npx vitest run src/lib/commesse/turni.test.ts   # DEVE fallire
cp /tmp/t.o src/lib/commesse/turni.ts

# B — chiude anche i turni gia' chiusi dall'operaio
L=$(grep -n "if (riga.fine) return riga" src/lib/commesse/turni.ts | cut -d: -f1)
sed -i "${L}s/.*/  \/\/ MUTATO: nessuna guardia/" src/lib/commesse/turni.ts
grep -c MUTATO src/lib/commesse/turni.ts   # DEVE dire 1
npx vitest run src/lib/commesse/turni.test.ts   # DEVE fallire
cp /tmp/t.o src/lib/commesse/turni.ts

# C — il transito viene contato come lavoro
L=$(grep -n "if (r.tipo === 'transito') transito += d" src/lib/commesse/turni.ts | cut -d: -f1)
sed -i "${L}s/.*/    if (false) transito += d \/\/ MUTATO/" src/lib/commesse/turni.ts
grep -c MUTATO src/lib/commesse/turni.ts   # DEVE dire 1
npx vitest run src/lib/commesse/turni.test.ts   # DEVE fallire
cp /tmp/t.o src/lib/commesse/turni.ts
md5sum src/lib/commesse/turni.ts
```

- [ ] **Step 7: Applicare la migrazione e provare i DUE indici sul database vero**

```sql
DO $$
DECLARE op uuid; co uuid; esito text;
BEGIN
  SELECT id INTO op FROM public.cervellone_operai LIMIT 1;
  SELECT id INTO co FROM public.cervellone_commesse LIMIT 1;

  INSERT INTO public.cervellone_timbrature (operaio_id, commessa_id, tipo, inizio, client_msg_id)
  VALUES (op, co, 'lavoro', now(), 'prova-chiave');

  BEGIN
    INSERT INTO public.cervellone_timbrature (operaio_id, commessa_id, tipo, inizio, client_msg_id)
    VALUES (op, co, 'lavoro', now(), 'prova-chiave');
    esito := 'CHIAVE NON RESPINTA — indice inefficace';
  EXCEPTION WHEN unique_violation THEN
    esito := 'chiave respinta OK; ';
  END;

  BEGIN
    INSERT INTO public.cervellone_timbrature (operaio_id, commessa_id, tipo, inizio)
    VALUES (op, co, 'lavoro', now());
    esito := esito || 'SECONDA APERTA NON RESPINTA — indice inefficace';
  EXCEPTION WHEN unique_violation THEN
    esito := esito || 'seconda riga aperta respinta OK';
  END;

  RAISE EXCEPTION 'ANNULLAMENTO VOLUTO — %', esito;
END $$;
```
Expected: l'errore riporta `chiave respinta OK; seconda riga aperta respinta OK`, e **niente resta scritto**. Verificare con `SELECT count(*) FROM public.cervellone_timbrature;`

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-12-timbrature.sql src/lib/commesse/turni.*
git commit -m "turni: le regole, e i due vincoli che stanno sul database"
```

---

## Task 4: Le rotte — timbra e stato

**Files:**
- Create: `src/lib/commesse/db.ts`
- Create: `src/lib/commesse/accesso-operaio.ts`
- Create: `src/app/api/cantiere/timbra/route.ts`
- Create: `src/app/api/cantiere/stato/route.ts`
- Test: `src/app/api/cantiere/timbra/route.test.ts`

**Interfaces:**
- Consumes: `prossimoGesto`, `Riga` da Task 3 · `Commessa` da Task 1
- Produces: rotta `POST /api/cantiere/timbra` con corpo `{ gesto: Gesto, commessaId?: string, clientMsgId: string }` · rotta `GET /api/cantiere/stato`

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
// src/app/api/cantiere/timbra/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

let righeInserite: Record<string, unknown>[] = []

/** Riproduce `uniq_timbrature_client_msg_id`: (operaio_id, client_msg_id). */
function violaChiave(row: Record<string, unknown>): boolean {
  if (!row.client_msg_id) return false
  return righeInserite.some(
    r => r.operaio_id === row.operaio_id && r.client_msg_id === row.client_msg_id,
  )
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        const dup = violaChiave(row)
        if (!dup) righeInserite.push(row)
        return {
          select: () => ({
            single: async () => dup
              ? { data: null, error: { code: '23505', message: 'duplicate key' } }
              : { data: { id: 'r-1', ...row }, error: null },
          }),
        }
      },
      select: () => {
        const b: Record<string, unknown> = {}
        b.eq = () => b
        b.is = () => b
        b.order = () => b
        b.limit = async () => ({ data: [], error: null })
        b.maybeSingle = async () => ({ data: null, error: null })
        return b
      },
    }),
  },
}))

function req(body: unknown, cookie?: string) {
  return {
    cookies: { get: () => (cookie ? { value: cookie } : undefined) },
    json: async () => body,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('POST /api/cantiere/timbra', () => {
  beforeEach(() => { righeInserite = [] })

  it('senza credenziale non si timbra', async () => {
    const { POST } = await import('./route')
    const r = await POST(req({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1' }), {} as never)
    expect(r.status).toBe(401)
  })

  it('la stessa timbratura inviata due volte scrive UNA riga sola', async () => {
    // La coda offline ritenta: senza la chiave, un ritentativo diventa una
    // seconda timbratura e le ore raddoppiano.
    const { POST } = await import('./route')
    const corpo = { gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1' }
    await POST(req(corpo, 'token-operaio-valido'), {} as never)
    await POST(req(corpo, 'token-operaio-valido'), {} as never)

    expect(righeInserite).toHaveLength(1)
  })

  it('il doppione NON e un errore per il telefono che lo manda', async () => {
    // Se il telefono riceve un 500 ritenta all'infinito e mostra un guasto che
    // non c'e': la timbratura E' salvata.
    const { POST } = await import('./route')
    const corpo = { gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1' }
    await POST(req(corpo, 'token-operaio-valido'), {} as never)
    const seconda = await POST(req(corpo, 'token-operaio-valido'), {} as never)

    expect(seconda.status).toBe(200)
  })

  it('CONTROLLO POSITIVO: due timbrature diverse restano due', async () => {
    const { POST } = await import('./route')
    await POST(req({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1' }, 'token-operaio-valido'), {} as never)
    await POST(req({ gesto: 'esci', commessaId: 'c1', clientMsgId: 'k2' }, 'token-operaio-valido'), {} as never)

    expect(righeInserite).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Eseguirlo e vederlo fallire**

Run: `npx vitest run "src/app/api/cantiere/timbra/route.test.ts"`
Expected: FAIL — modulo `./route` inesistente

- [ ] **Step 3: Scrivere `accesso-operaio.ts`**

```typescript
// src/lib/commesse/accesso-operaio.ts
/**
 * Chi sta bussando: dal cookie all'operaio.
 *
 * Le presenze di quattro dipendenti sono dati personali di lavoratori: non
 * possono stare dietro `APP_PASSWORD`, la chiave condivisa che apre anche
 * contabilita' e fatture — e che per giunta e' rimasta in chiaro in un
 * repository pubblico.
 *
 * Il token dell'operaio non si conserva in chiaro: sul database sta la sua
 * impronta, e il confronto passa da `confrontoCostante` (che ha gia' la guardia
 * sulla lunghezza: senza, un token con un accento faceva 500 invece di
 * «collegamento non valido»).
 */
import crypto from 'crypto'
import { confrontoCostante } from '@/lib/confronto-costante'

export function improntaToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function tokenCorrisponde(token: string, improntaAttesa: string): boolean {
  return confrontoCostante(improntaToken(token), improntaAttesa)
}
```

- [ ] **Step 4: Scrivere la rotta minima**

```typescript
// src/app/api/cantiere/timbra/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { operaioDalCookie } from '@/lib/commesse/db'

export async function POST(request: NextRequest) {
  const operaio = await operaioDalCookie(request.cookies.get('cervellone_operaio')?.value)
  if (!operaio) {
    return NextResponse.json({ errore: 'Collegamento non valido.' }, { status: 401 })
  }

  const { gesto, commessaId, clientMsgId, posizioneEsito } = await request.json()

  const { error } = await supabase
    .from('cervellone_timbrature')
    .insert({
      operaio_id: operaio.id,
      commessa_id: commessaId,
      tipo: gesto === 'parti-dal-deposito' || gesto === 'cambio-cantiere' ? 'transito' : 'lavoro',
      inizio: new Date().toISOString(),
      client_msg_id: clientMsgId ?? null,
      posizione_esito: posizioneEsito ?? null,
    })
    .select()
    .single()

  if (error) {
    // 23505 = la stessa timbratura e' gia' arrivata. Non e' un guasto: e' il
    // telefono che ha ritentato, e la riga c'e'. Rispondere 500 lo farebbe
    // ritentare all'infinito mostrando un errore che non esiste.
    if (error.code === '23505') return NextResponse.json({ ok: true, duplicato: true })
    return NextResponse.json({ errore: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Eseguirlo e vederlo passare**

Run: `npx vitest run "src/app/api/cantiere/"`
Expected: PASS (4 test)

- [ ] **Step 6: Mutazione — la chiave non arriva al database**

```bash
R=src/app/api/cantiere/timbra/route.ts
cp "$R" /tmp/r.o
L=$(grep -n "client_msg_id: clientMsgId ?? null" "$R" | cut -d: -f1)
sed -i "${L}s/.*/      client_msg_id: null, \/\/ MUTATO/" "$R"
grep -c MUTATO "$R"   # DEVE dire 1
npx vitest run "src/app/api/cantiere/"   # DEVE fallire
cp /tmp/r.o "$R"
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/commesse/ src/app/api/cantiere/
git commit -m "cantiere: la rotta che timbra, con la chiave d'invio"
```

---

## Task 5: La PWA dell'operaio

**Files:**
- Create: `src/app/cantiere/layout.tsx`
- Create: `src/app/cantiere/page.tsx`
- Create: `src/app/cantiere/coda-offline.ts`
- Test: `src/app/cantiere/coda-offline.test.ts`
- Create: `public/cantiere/manifest.json`, icone 192/512 e apple-touch-icon

**Interfaces:**
- Consumes: `POST /api/cantiere/timbra`, `GET /api/cantiere/stato` da Task 4 · `prossimoGesto` da Task 3
- Produces: niente per i task successivi

- [ ] **Step 1: Scrivere il test della coda offline**

```typescript
// src/app/cantiere/coda-offline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { accoda, daSincronizzare, marcaInviata, prossimaDaInviare } from './coda-offline'

describe('la coda offline: in Val d Agri il campo va e viene', () => {
  beforeEach(() => { localStorage.clear() })

  it('una timbratura senza rete resta sul telefono', () => {
    accoda({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1', quando: '2026-09-09T07:00:00Z' })
    expect(daSincronizzare()).toBe(1)
  })

  it('quando e stata inviata sparisce dalla coda', () => {
    accoda({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1', quando: '2026-09-09T07:00:00Z' })
    marcaInviata('k1')
    expect(daSincronizzare()).toBe(0)
  })

  it('la chiave sopravvive all accodamento: e cio che impedisce il doppione', () => {
    // Il telefono ritenta finche' non passa. Senza la chiave, ogni ritentativo
    // diventerebbe una timbratura in piu' e le ore raddoppierebbero.
    accoda({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1', quando: '2026-09-09T07:00:00Z' })
    expect(prossimaDaInviare()?.clientMsgId).toBe('k1')
  })

  it('CONTROLLO POSITIVO: due timbrature diverse restano due in coda', () => {
    accoda({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1', quando: '2026-09-09T07:00:00Z' })
    accoda({ gesto: 'esci', commessaId: 'c1', clientMsgId: 'k2', quando: '2026-09-09T12:00:00Z' })
    expect(daSincronizzare()).toBe(2)
  })

  it('l ordine si rispetta: si invia prima quella piu vecchia', () => {
    // Invertire l'ordine produrrebbe un'uscita prima dell'entrata, e il
    // vincolo del database la respingerebbe lasciando la coda bloccata.
    accoda({ gesto: 'entra', commessaId: 'c1', clientMsgId: 'k1', quando: '2026-09-09T07:00:00Z' })
    accoda({ gesto: 'esci', commessaId: 'c1', clientMsgId: 'k2', quando: '2026-09-09T12:00:00Z' })
    expect(prossimaDaInviare()?.clientMsgId).toBe('k1')
  })
})
```

- [ ] **Step 2: Eseguirlo e vederlo fallire**

Run: `npx vitest run src/app/cantiere/coda-offline.test.ts`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Scrivere `coda-offline.ts`**

```typescript
// src/app/cantiere/coda-offline.ts
/**
 * La coda delle timbrature non ancora arrivate al server.
 *
 * In Val d'Agri e sulla costa di Maratea la copertura dati e' discontinua. Per
 * l'operaio deve essere invisibile: tocca, ha timbrato, punto. L'unico segnale
 * e' una riga discreta che sparisce da sola quando torna la rete.
 *
 * ⚠️ NON si usa la memoria della pagina. La coda della chat web vive in una
 * variabile del browser, e chiudendo la scheda i messaggi spariscono senza
 * lasciare traccia: e' un difetto aperto e documentato, e non va ripetuto qui
 * — dove il dato perso sono le ore di lavoro di una persona.
 */
export interface TimbraturaInCoda {
  gesto: string
  commessaId: string
  clientMsgId: string
  quando: string
}

const CHIAVE = 'cantiere.coda'

function leggi(): TimbraturaInCoda[] {
  try {
    return JSON.parse(localStorage.getItem(CHIAVE) ?? '[]') as TimbraturaInCoda[]
  } catch {
    return []
  }
}

function scrivi(righe: TimbraturaInCoda[]): void {
  try { localStorage.setItem(CHIAVE, JSON.stringify(righe)) } catch { /* niente spazio */ }
}

export function accoda(t: TimbraturaInCoda): void {
  scrivi([...leggi(), t])
}

export function daSincronizzare(): number {
  return leggi().length
}

/** La piu' vecchia: invertire l'ordine metterebbe un'uscita prima dell'entrata. */
export function prossimaDaInviare(): TimbraturaInCoda | null {
  return leggi()[0] ?? null
}

export function marcaInviata(clientMsgId: string): void {
  scrivi(leggi().filter(t => t.clientMsgId !== clientMsgId))
}
```

- [ ] **Step 4: Eseguirlo e vederlo passare**

Run: `npx vitest run src/app/cantiere/coda-offline.test.ts`
Expected: PASS (5 test)

⚠️ Se `localStorage` non esiste nell'ambiente di test, aggiungere `environment: 'jsdom'` **solo per questo file** con `// @vitest-environment jsdom` in testa, senza toccare la configurazione globale.

- [ ] **Step 5: Mutazione — l'ordine della coda si inverte**

```bash
C=src/app/cantiere/coda-offline.ts
cp "$C" /tmp/co.o
L=$(grep -n "return leggi()\[0\] ?? null" "$C" | cut -d: -f1)
sed -i "${L}s/.*/  const r = leggi(); return r[r.length - 1] ?? null \/\/ MUTATO/" "$C"
grep -c MUTATO "$C"   # DEVE dire 1
npx vitest run src/app/cantiere/coda-offline.test.ts   # DEVE fallire
cp /tmp/co.o "$C"
```

- [ ] **Step 6: Scrivere la schermata**

Una schermata sola che cambia stato, secondo la sezione 5 della specifica. Vincoli:
- `ENTRA — sono in cantiere` / `PARTO DAL DEPOSITO →` a turno chiuso, con la lista delle commesse **attive** e **l'ultima usata in cima**;
- `ESCI` / `INIZIO PAUSA` / `Cambio cantiere →` a turno aperto;
- `RIENTRO` / `ESCI` in pausa; `SONO ARRIVATO` / `Ho cambiato idea →` in transito;
- una riga discreta *«N timbrature da inviare»* quando `daSincronizzare() > 0`;
- **nessuna** conferma, nessuna nota, nessun riepilogo: ogni cosa in piu' e' un motivo per non usarla.

- [ ] **Step 7: Manifesto e icone**

Copiare lo schema di `public/checkin/` (`manifest`, `icona-192.png`, `icona-512.png`, `apple-touch-icon.png`) e il `layout.tsx` del check-in, che gia' fa questo lavoro.

⚠️ **Su iPhone l'app va aggiunta alla Home da Safari**, non dal browser interno di WhatsApp — dove «Aggiungi a Home» non esiste. È l'inciampo gia' capitato consegnando il gestionale a Luciana. Va scritto nelle istruzioni di consegna, e l'installazione va fatta **insieme agli operai**, non mandando un link.

- [ ] **Step 8: Verifica nel browser, con `read_page`**

Aprire `/cantiere` con un token operaio di prova e verificare:
1. a turno chiuso compaiono **due** pulsanti d'ingresso;
2. dopo `ENTRA` la schermata mostra `ESCI`, `INIZIO PAUSA`, `Cambio cantiere` — letti dall'albero della pagina, **non a occhio**;
3. con la rete spenta (`Network: offline` negli strumenti) una timbratura accoda e compare la riga *«1 timbratura da inviare»*;
4. riaccendendo la rete la riga sparisce e in tabella c'e' **una riga sola**.

- [ ] **Step 9: Commit**

```bash
git add src/app/cantiere/ public/cantiere/
git commit -m "cantiere: la schermata dell'operaio, e la coda che non vive nella pagina"
```

---

## Task 6: Il gestionale — la giornata e le correzioni

**Files:**
- Create: `src/app/api/gestione/giornata/route.ts`
- Create: `src/app/gestione-commesse/page.tsx`
- Test: `src/app/api/gestione/giornata/route.test.ts`

**Interfaces:**
- Consumes: `Riga`, `oreDi` da Task 3
- Produces: `PATCH /api/gestione/giornata` con corpo `{ timbraturaId, campo, valoreDopo, motivo }`

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
// src/app/api/gestione/giornata/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

let correzioni: Record<string, unknown>[] = []
let righeAggiornate: Record<string, unknown>[] = []

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: { id: 't1', inizio: '2026-09-09T07:00:00Z' }, error: null })
      b.insert = async (row: Record<string, unknown>) => {
        if (tabella === 'cervellone_timbrature_correzioni') correzioni.push(row)
        return { data: null, error: null }
      }
      b.update = (row: Record<string, unknown>) => {
        righeAggiornate.push(row)
        const u: Record<string, unknown> = {}
        u.eq = async () => ({ data: null, error: null })
        return u
      }
      return b
    },
  },
}))

describe('correggere non sovrascrive', () => {
  beforeEach(() => { correzioni = []; righeAggiornate = [] })

  it('la correzione conserva il valore di PRIMA, e chi l ha fatta', async () => {
    // Un'ora finisce in una busta paga e in un margine: si deve poter risalire
    // a chi l'ha decisa.
    const { PATCH } = await import('./route')
    await PATCH({
      cookies: { get: () => ({ value: 'token-master' }) },
      json: async () => ({
        timbraturaId: 't1', campo: 'inizio',
        valoreDopo: '2026-09-09T07:30:00Z', motivo: 'aveva scordato di timbrare',
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(correzioni).toHaveLength(1)
    expect(correzioni[0]).toMatchObject({
      campo: 'inizio',
      valore_prima: '2026-09-09T07:00:00Z',
      valore_dopo: '2026-09-09T07:30:00Z',
    })
    expect(correzioni[0].chi).toBeTruthy()
  })

  it('la riga corretta dichiara di essere stata toccata dall UFFICIO', async () => {
    const { PATCH } = await import('./route')
    await PATCH({
      cookies: { get: () => ({ value: 'token-master' }) },
      json: async () => ({ timbraturaId: 't1', campo: 'inizio', valoreDopo: '2026-09-09T07:30:00Z' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(righeAggiornate[0]).toMatchObject({ origine_fine: 'ufficio' })
  })

  it('CONTROLLO POSITIVO: senza credenziale non si corregge niente', async () => {
    const { PATCH } = await import('./route')
    const r = await PATCH({
      cookies: { get: () => undefined },
      json: async () => ({ timbraturaId: 't1', campo: 'inizio', valoreDopo: 'x' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(r.status).toBe(401)
    expect(correzioni).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Eseguirlo e vederlo fallire**

Run: `npx vitest run "src/app/api/gestione/giornata/route.test.ts"`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Scrivere la rotta**

Legge la riga com'è **prima**, scrive la correzione in `cervellone_timbrature_correzioni` (campo, valore prima, valore dopo, chi, quando, motivo), **poi** aggiorna la riga marcandola `origine_fine = 'ufficio'`. Se la scrittura della correzione fallisce, **non si aggiorna niente**: meglio una correzione rifiutata di una modifica senza traccia.

- [ ] **Step 4: Eseguirlo e vederlo passare**

Run: `npx vitest run "src/app/api/gestione/"`
Expected: PASS (3 test)

- [ ] **Step 5: Mutazione — la traccia della correzione sparisce**

```bash
R=src/app/api/gestione/giornata/route.ts
cp "$R" /tmp/g.o
L=$(grep -n "valore_prima" "$R" | head -1 | cut -d: -f1)
sed -i "${L}s/.*/      valore_prima: null, \/\/ MUTATO/" "$R"
grep -c MUTATO "$R"   # DEVE dire 1
npx vitest run "src/app/api/gestione/"   # DEVE fallire
cp /tmp/g.o "$R"
```

- [ ] **Step 6: Scrivere la schermata del gestionale**

Tre cose, secondo la sezione 6 della specifica:
1. **la giornata di tutti**, con ogni turno marcato per provenienza (timbrato / chiuso dal sistema / corretto dall'ufficio) e i `da_confermare` visibili a colpo d'occhio;
2. **la correzione** di inizio, fine o commessa, che apre il dialogo del motivo;
3. **l'elenco cantieri** con crea, archivia e riattiva.

Funziona **sia da cellulare sia da PC**: stessa pagina, layout che si adatta.

- [ ] **Step 7: Verifica nel browser con `read_page`**

Aprire `/gestione-commesse`, correggere un orario, e verificare che la riga mostri la marcatura «corretto dall'ufficio» e che in `cervellone_timbrature_correzioni` ci sia la riga col valore di prima.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/gestione/ src/app/gestione-commesse/
git commit -m "gestionale: la giornata di tutti, e la correzione che non sovrascrive"
```

---

## Task 7: La chiusura dei turni dimenticati (cron)

**Files:**
- Create: `src/app/api/cron/turni-aperti/route.ts`
- Modify: `vercel.json` (aggiungere il cron)
- Test: `src/app/api/cron/turni-aperti/route.test.ts`

**Interfaces:**
- Consumes: `chiusuraDimenticata` da Task 3

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
// src/app/api/cron/turni-aperti/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

let aggiornamenti: Record<string, unknown>[] = []

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.is = () => b
      b.lt = () => b
      b.limit = async () => ({
        data: [{ id: 't1', inizio: '2026-09-09T07:00:00Z', fine: null, tipo: 'lavoro', stato: 'aperto', commessa_id: 'c1', origine_fine: null }],
        error: null,
      })
      b.update = (row: Record<string, unknown>) => {
        aggiornamenti.push(row)
        const u: Record<string, unknown> = {}
        u.eq = async () => ({ data: null, error: null })
        return u
      }
      return b
    },
  },
}))

describe('il cron che chiude i turni dimenticati', () => {
  beforeEach(() => { aggiornamenti = [] })

  it('chiude, e DICHIARA che l ha chiuso il sistema', async () => {
    const { GET } = await import('./route')
    await GET({ headers: { get: () => process.env.CRON_SECRET ?? '' } } as never)

    expect(aggiornamenti[0]).toMatchObject({
      origine_fine: 'sistema',
      stato: 'da_confermare',
    })
  })

  it('CONTROLLO POSITIVO: senza il segreto del cron non tocca niente', async () => {
    const { GET } = await import('./route')
    const r = await GET({ headers: { get: () => 'sbagliato' } } as never)

    expect(r.status).toBe(401)
    expect(aggiornamenti).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Eseguirlo e vederlo fallire**

Run: `npx vitest run "src/app/api/cron/turni-aperti/route.test.ts"`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Scrivere il cron**

Usa `chiusuraDimenticata` di Task 3. L'orario di fine standard è un parametro di sistema (punto aperto della specifica). Chiude **solo** i turni con `fine IS NULL` iniziati prima di oggi.

- [ ] **Step 4: Eseguirlo e vederlo passare**

Run: `npx vitest run "src/app/api/cron/turni-aperti/"`
Expected: PASS (2 test)

- [ ] **Step 5: Aggiungere il cron a `vercel.json`**

```json
{ "path": "/api/cron/turni-aperti", "schedule": "0 21 * * *" }
```

⚠️ Esiste già un test che confronta il registro delle automazioni con `vercel.json` **nei due versi** (`automazioni.test.ts`): va aggiornato anche il registro, altrimenti quel test — che funziona — diventa rosso.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/turni-aperti/ vercel.json src/lib/tools/automazioni.ts
git commit -m "turni dimenticati: chiusi, e marcati come chiusi dal sistema"
```

---

## Dopo il 1 novembre — non in questa consegna

QR all'ingresso · geolocalizzazione con i tre esiti · trasferta e indennità · transito con tolleranza e notifiche · valorizzazione delle ore col costo orario · quadratura mensile · rapportino del preposto · DDT.

Niente di quello che si raccoglie nel frattempo va perso: le ore restano e si valorizzano quando la tabella dei costi è pronta.

---

## Autoverifica del piano (svolta)

**Copertura della specifica.** Sezione 4 (modello dati) → Task 1, 2, 3. Sezione 5 (PWA) → Task 5. Sezione 6 (ufficio) → Task 6. Decisione 3.2 (costo datato) → Task 2. 3.8 (turno dimenticato) → Task 3 + Task 7. 3.9 (pausa) → Task 3. 3.11-ter (stati) → Task 1. 3.13 (correzione tracciata) → Task 6. Sezione 9 (verifica) → mutazioni in ogni task + verifica browser nei Task 5 e 6.

**Fuori da questa consegna, dichiarato:** 3.4 e 3.4-bis (geolocalizzazione, QR), 3.5-3.7 (esiti e raggio), 3.10-3.11 (transito, tolleranza), 3.11-bis (trasferta), 3.11-quater (DDT), sezione 10 (rapportino). Le colonne che li reggono esistono già nelle migrazioni dei Task 1 e 3, quindi si accendono senza rifare niente.

**Coerenza dei tipi.** `Riga`, `TipoRiga`, `OrigineFine`, `StatoRiga`, `Gesto` sono definiti in Task 3 e usati con gli stessi nomi in 4, 6, 7. `Commessa` e `StatoCommessa` in Task 1. `CostoOrario` in Task 2, non usato prima della valorizzazione (fuori consegna).

**Segnaposto:** nessuno. Gli Step 3 e 6 dei Task 6 e 7 descrivono la schermata invece di darne il codice, ed è deliberato: sono interfacce, e il loro contratto verificabile sta nei test degli step precedenti.
