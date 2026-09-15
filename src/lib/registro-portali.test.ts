/**
 * src/lib/registro-portali.test.ts — il registro a stati, e le sue difese.
 *
 * Il difetto che chiude: il 15 settembre 2026, per quattro fatture Booking,
 * nessuno sapeva se un documento esistesse. L'id `552625594` e' stato
 * inseguito per un'ora prima di capire che non era mai stato creato — la POST
 * era fallita con un 422 e il tool aveva restituito un id di un tentativo
 * precedente.
 *
 * ⚠️ ACCANTO A OGNI DIFESA C'E' IL SUO CONTROLLO POSITIVO. Un registro che
 * rifiuta sempre, o che non avanza mai, supererebbe ogni test sulle guardie
 * senza servire a niente.
 *
 * Il finto Supabase qui sotto FA RISPETTARE il vincolo unico come lo fa il
 * database vero (errore `23505`): il file `.sql` e' il posto dove quel vincolo
 * e' dichiarato, e c'e' un test che lo legge dal disco.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

type Riga = Record<string, unknown> & { id: string }

const db = {
  righe: [] as Riga[],
  inseriti: [] as Riga[],
  aggiornati: [] as Record<string, unknown>[],
  erroreLettura: null as { message: string } | null,
  erroreScrittura: null as { message: string; code?: string } | null,
  /** Simula la corsa: la lettura non vede una riga che invece esiste. */
  ciecoVolte: 0,
}

function chiave(numero: unknown): string {
  return String(numero ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

vi.mock('./supabase', () => {
  const costruisci = () => {
    const filtri: Record<string, unknown> = {}
    let modo: 'select' | 'insert' | 'update' = 'select'
    let payload: Record<string, unknown> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: unknown) => { filtri[k] = v; return b }
    b.limit = () => b
    b.order = () => b
    b.gte = () => b
    b.lt = () => b
    b.insert = (row: Record<string, unknown>) => { modo = 'insert'; payload = row; return b }
    b.update = (row: Record<string, unknown>) => { modo = 'update'; payload = row; return b }
    b.maybeSingle = async () => {
      if (modo === 'insert') {
        if (db.erroreScrittura) return { data: null, error: db.erroreScrittura }
        // 🚨 IL VINCOLO DEL DATABASE, non un `if` applicativo: e' il database
        // che rifiuta la seconda riga, e il codice deve saperci convivere.
        const doppione = db.righe.some((r) =>
          r.societa === payload.societa && r.portale === payload.portale
          && chiave(r.numero_fattura) === chiave(payload.numero_fattura))
        if (doppione) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uniq_registro_portali_fattura"' } }
        }
        const riga = { note: null, id: `riga-${db.righe.length + 1}`, ...payload } as Riga
        db.righe.push(riga)
        db.inseriti.push(riga)
        return { data: { id: riga.id }, error: null }
      }
      if (modo === 'update') {
        if (db.erroreScrittura) return { data: null, error: db.erroreScrittura }
        const riga = db.righe.find((r) => r.id === filtri.id)
        if (!riga) return { data: null, error: null }
        Object.assign(riga, payload)
        db.aggiornati.push({ id: riga.id, ...payload })
        return { data: { id: riga.id }, error: null }
      }
      if (db.erroreLettura) return { data: null, error: db.erroreLettura }
      if (db.ciecoVolte > 0) { db.ciecoVolte -= 1; return { data: null, error: null } }
      const trovata = db.righe.find((r) =>
        Object.entries(filtri).every(([k, v]) => (k === 'numero_chiave' ? chiave(r.numero_fattura) === v : r[k] === v)))
      return { data: trovata ?? null, error: null }
    }
    return b
  }
  return { supabase: { from: () => costruisci() } }
})

import {
  aggiornaRegistroPortali,
  avvisoRegistroNonScritto,
  chiaveNumeroPortale,
  portaleDelFornitore,
  scadenzaInvio,
  statoRisultante,
} from './registro-portali'

const BASE = {
  societa: 'larealestate',
  fornitore: 'Booking.com B.V.',
  numero: '2568745896',
  data: '2026-08-01',
  dataRicezione: '2026-08-03',
  imponibile: 218.44,
}

beforeEach(() => {
  db.righe = []
  db.inseriti = []
  db.aggiornati = []
  db.erroreLettura = null
  db.erroreScrittura = null
  db.ciecoVolte = 0
})

describe('quale portale, e quando scade', () => {
  it('riconosce Booking e Airbnb, comunque siano scritti', () => {
    expect(portaleDelFornitore('Booking.com B.V.')).toBe('booking')
    expect(portaleDelFornitore('BOOKING.COM BV')).toBe('booking')
    expect(portaleDelFornitore('Airbnb Ireland UC')).toBe('airbnb')
  })

  it('🚨 un fornitore che NON e un portale non entra nel registro', async () => {
    const esito = await aggiornaRegistroPortali({ ...BASE, fornitore: 'Studio Legale Rossi', stato: 'spesa_registrata' })
    expect(esito).toEqual({ ok: true, scritto: false, motivo: expect.stringContaining('non e\' un portale') })
    expect(db.inseriti).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO — lo stesso identico dato con Booking ci entra eccome', async () => {
    // Senza questo, il test sopra passerebbe anche se il registro non
    // scrivesse MAI niente per nessuno.
    const esito = await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata' })
    expect(esito.ok).toBe(true)
    expect(db.inseriti).toHaveLength(1)
  })

  it('la scadenza e il 15 del mese SUCCESSIVO alla ricezione, anche a cavallo d anno', () => {
    expect(scadenzaInvio('2026-08-03')).toBe('2026-09-15')
    expect(scadenzaInvio('2026-12-31')).toBe('2027-01-15')
    expect(scadenzaInvio('2026-01-01')).toBe('2026-02-15')
  })

  it('🚨 senza data di ricezione NON inventa una scadenza', () => {
    // Una scadenza calcolata su una data finta sposta in avanti un termine
    // vero: il registro direbbe «in tempo» proprio quando non lo e'.
    expect(scadenzaInvio(null)).toBeNull()
    expect(scadenzaInvio('')).toBeNull()
    expect(scadenzaInvio('03/08/2026')).toBeNull()
    expect(scadenzaInvio('2026-13-01')).toBeNull()
  })
})

describe('lo stato avanza solo in avanti, e da_verificare e un cartello', () => {
  it('avanza quando il fatto e piu avanti', () => {
    expect(statoRisultante('nuova', 'spesa_registrata')).toEqual({ stato: 'spesa_registrata', avanzato: true })
    expect(statoRisultante('spesa_registrata', 'td17_generata')).toEqual({ stato: 'td17_generata', avanzato: true })
  })

  it('🚨 un fatto arrivato TARDI non fa tornare indietro la riga', () => {
    // La spesa registrata DOPO l'integrazione e' il caso vero: senza il rango,
    // il registro tornerebbe a «spesa_registrata» e direbbe che la TD17 non c'e'.
    expect(statoRisultante('td17_generata', 'spesa_registrata')).toEqual({ stato: 'td17_generata', avanzato: false })
  })

  it('🚨 da_verificare vince, ed e appiccicoso', () => {
    expect(statoRisultante('td17_generata', 'da_verificare')).toEqual({ stato: 'da_verificare', avanzato: true })
    // Un fatto nuovo scrive i suoi campi ma NON toglie il cartello: chi l'ha
    // messo aveva visto qualcosa che nessuno ha ancora guardato.
    expect(statoRisultante('da_verificare', 'td17_generata')).toEqual({ stato: 'da_verificare', avanzato: false })
  })
})

describe('il vincolo unico: due volte la stessa fattura non fanno due righe', () => {
  it('la normalizzazione del numero e la stessa dell anti-doppione di FIC', () => {
    expect(chiaveNumeroPortale('FT 123/2026')).toBe('FT1232026')
    expect(chiaveNumeroPortale('ft123-2026')).toBe('FT1232026')
  })

  it('🚨 sta nel DATABASE: la migrazione dichiara l indice UNIQUE sulla chiave normalizzata', () => {
    // Un controllo applicativo si puo' dimenticare — basta un secondo punto di
    // ingresso. Questo test legge il vincolo dal file .sql: se qualcuno lo
    // toglie, la suite muore.
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase', 'migrations', '2026-09-15-registro-portali.sql'),
      'utf8',
    )
    expect(sql).toMatch(/create unique index[\s\S]*?cervellone_registro_portali\s*\(societa,\s*portale,\s*numero_chiave\)/i)
    // e `numero_chiave` dev'essere GENERATA dal database, con la stessa
    // normalizzazione di `chiaveNumeroPortale`: una colonna scritta a mano
    // potrebbe divergere dal numero vero.
    expect(sql).toMatch(/numero_chiave[\s\S]*?generated always as \(upper\(regexp_replace\(numero_fattura, '\[\^A-Za-z0-9\]', '', 'g'\)\)\) stored/i)
  })

  it('🚨 se il database rifiuta il doppione (23505), il registro aggiorna la riga che c e gia', async () => {
    await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata', spesaFicId: '435116342' })
    expect(db.righe).toHaveLength(1)

    // La corsa: la lettura non vede la riga (l'ha appena creata un altro
    // giro), l'insert parte e il VINCOLO DEL DATABASE morde.
    db.ciecoVolte = 1
    const esito = await aggiornaRegistroPortali({ ...BASE, numero: '2568-745-896', stato: 'td17_generata', td17FicId: '552625594' })

    expect(esito).toMatchObject({ ok: true, scritto: true })
    // Una riga sola: il doppione e' stato RIFIUTATO dal database, non evitato
    // da un controllo che qualcuno puo' dimenticare.
    expect(db.righe).toHaveLength(1)
    expect(db.righe[0].stato).toBe('td17_generata')
    expect(db.righe[0].td17_fic_id).toBe('552625594')
    expect(db.righe[0].spesa_fic_id).toBe('435116342')
  })

  it('CONTROLLO POSITIVO — due fatture DIVERSE fanno due righe', async () => {
    // Senza, un registro che rifiuta ogni inserimento passerebbe il test sopra.
    await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata' })
    await aggiornaRegistroPortali({ ...BASE, numero: '2568745897', stato: 'spesa_registrata' })
    expect(db.righe).toHaveLength(2)
  })
})

describe('un fatto NON verificato non fa avanzare niente', () => {
  it('🚨 rilettura che non conferma: stato fermo a da_verificare e motivo nelle note', async () => {
    await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata', spesaFicId: '435116342' })
    const esito = await aggiornaRegistroPortali({
      ...BASE,
      stato: 'da_verificare',
      nota: 'integrazione TD17 NON confermata dalla rilettura: 404. Fatture in Cloud aveva risposto con l\'id 552625594.',
    })

    expect(esito).toMatchObject({ ok: true, scritto: true, stato: 'da_verificare' })
    expect(db.righe[0].stato).toBe('da_verificare')
    expect(String(db.righe[0].note)).toContain('552625594')
    // 🚨 E l'id NON e' finito fra i documenti citati: il registro non deve
    // citare un documento che forse non esiste — e' l'errore di stamattina.
    expect(db.righe[0].td17_fic_id).toBeUndefined()
  })

  it('CONTROLLO POSITIVO — una rilettura che conferma fa avanzare e SCRIVE l id', async () => {
    await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata', spesaFicId: '435116342' })
    const esito = await aggiornaRegistroPortali({ ...BASE, stato: 'td17_generata', td17FicId: '552625594', td17Numero: '1/INT' })
    expect(esito).toMatchObject({ ok: true, scritto: true, stato: 'td17_generata', avanzato: true })
    expect(db.righe[0].td17_fic_id).toBe('552625594')
    expect(db.righe[0].td17_numero).toBe('1/INT')
  })

  it('la scadenza si scrive solo quando la ricezione c e', async () => {
    await aggiornaRegistroPortali({ ...BASE, dataRicezione: null, stato: 'spesa_registrata' })
    expect(db.righe[0].scadenza_invio).toBeUndefined()

    await aggiornaRegistroPortali({ ...BASE, numero: 'X-2', dataRicezione: '2026-08-03', stato: 'spesa_registrata' })
    expect(db.righe[1].scadenza_invio).toBe('2026-09-15')
  })
})

describe('un registro che mente e peggio di nessun registro', () => {
  it('🚨 la scrittura fallita torna ok:false, e l avviso porta l id del documento VERO', async () => {
    db.erroreScrittura = { message: 'connection reset' }
    const esito = await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata', spesaFicId: '435116342' })
    expect(esito.ok).toBe(false)

    const avviso = avvisoRegistroNonScritto(esito, { descrizione: 'la spesa Booking n.2568745896', ficId: '435116342' })
    expect(avviso).toContain('REGISTRO PORTALI NON AGGIORNATO')
    expect(avviso).toContain('435116342')
    expect(avviso).toContain('NON rifarlo')
  })

  it('CONTROLLO POSITIVO — quando la scrittura riesce non c e nessun avviso da dire', () => {
    const avviso = avvisoRegistroNonScritto(
      { ok: true, scritto: true, id: 'riga-1', stato: 'spesa_registrata', avanzato: true },
      { descrizione: 'la spesa', ficId: '435116342' },
    )
    expect(avviso).toBeNull()
  })

  it('🚨 una LETTURA fallita non si traveste da «non c e»: non si inserisce al buio', async () => {
    // Inserire dopo una lettura fallita creerebbe il doppione che il registro
    // esiste per evitare: il guasto che invece di chiudere APRE.
    db.erroreLettura = { message: 'timeout' }
    const esito = await aggiornaRegistroPortali({ ...BASE, stato: 'spesa_registrata' })
    expect(esito.ok).toBe(false)
    expect(db.inseriti).toHaveLength(0)
  })
})
