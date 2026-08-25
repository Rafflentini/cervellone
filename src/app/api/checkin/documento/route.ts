/**
 * api/checkin/documento — riceve la foto di un documento d'identita'.
 *
 * E' l'ingresso piu' delicato di tutto il sistema: da qui passa, da un telefono
 * qualunque, la fotografia della carta d'identita' di una persona che non
 * conosciamo. Le difese non sono facoltative:
 *
 *  - **solo per la propria scheda.** Un ospite non carica documenti al posto di
 *    un altro, e non ne vede nessuno: questa route non restituisce mai un file;
 *  - **tipi ammessi ristretti** a foto e PDF. Un caricamento libero e' un
 *    ingresso da cui passa un estraneo;
 *  - **tetto di dimensione**, sul file gia' ridotto dal telefono;
 *  - **limite di frequenza**, perche' un caricamento costa spazio e tempo;
 *  - **niente nei log** oltre l'esito: mai il contenuto, mai il nome dell'ospite.
 *
 * E, soprattutto: quello che entra qui ha una data di scadenza. La cancellazione
 * automatica e' costruita insieme a questa route, non aggiunta dopo.
 */

import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limiter'
import { risolviAccesso } from '@/lib/checkin/accesso'
import { leggiPratica } from '@/lib/checkin/pratica'
import { salvaDocumento, tipoAmmesso, MAX_BYTE, type Lato } from '@/lib/checkin/documenti'
import { aggiornaRiga } from '@/lib/checkin/foglio-google'
import { aRiga } from '@/lib/checkin/merge-pratica'
import {
  COL_OSPITI, SCHEDA_OSPITI, FOGLIO_CHECKIN_ID, CARTELLA_LA_REAL_ESTATE,
} from '@/lib/checkin/foglio-schema'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), s.get('p'), s.get('t'), s.get('o'))
  if (!accesso.ok || !accesso.id) {
    return NextResponse.json({ ok: false, errore: 'Collegamento non valido.' }, { status: 401 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'ignoto'
  if (!rateLimit(`doc_${ip}`, 60_000, 12)) {
    return NextResponse.json({ ok: false, errore: 'Troppi caricamenti in poco tempo.' }, { status: 429 })
  }

  const lato = s.get('lato') === 'retro' ? 'retro' : 'fronte'
  const progressivo = Number(s.get('prog') ?? '')
  if (!Number.isInteger(progressivo) || progressivo < 1) {
    return NextResponse.json({ ok: false, errore: 'Ospite non indicato.' }, { status: 400 })
  }

  // Un ospite carica SOLO per la propria scheda. Il controllo e' qui, non nella
  // pagina: il numero nella richiesta lo sceglie chi la manda.
  if (accesso.livello.tipo === 'ospite' && accesso.livello.progressivo !== progressivo) {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 403 })
  }

  const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!tipoAmmesso(mime)) {
    return NextResponse.json(
      { ok: false, errore: 'Manda una foto (JPG, PNG) oppure un PDF.' },
      { status: 415 },
    )
  }

  try {
    const contenuto = Buffer.from(await req.arrayBuffer())
    if (contenuto.length === 0) {
      return NextResponse.json({ ok: false, errore: 'File vuoto.' }, { status: 400 })
    }
    if (contenuto.length > MAX_BYTE) {
      return NextResponse.json(
        { ok: false, errore: 'Foto troppo pesante: riprova, verra ridotta dal telefono.' },
        { status: 413 },
      )
    }

    const pratica = await leggiPratica(accesso.id)
    if (!pratica) {
      return NextResponse.json({ ok: false, errore: 'Prenotazione non trovata.' }, { status: 404 })
    }

    const scheda = pratica.ospiti.find((x) => Number(x.dati['Progressivo']) === progressivo)
    if (!scheda) {
      return NextResponse.json(
        { ok: false, errore: 'Compila prima i tuoi dati, poi carica il documento.' },
        { status: 409 },
      )
    }

    const { fileId } = await salvaDocumento({
      idSoggiorno: accesso.id,
      unita: pratica.soggiorno['Unità'] ?? '',
      checkin: pratica.soggiorno['Check-in'] ?? '',
      codPrenotazione: pratica.soggiorno['Cod. prenotazione'] ?? '',
      progressivo,
      lato: lato as Lato,
      contenuto,
      mime,
      cartellaGenitore: CARTELLA_LA_REAL_ESTATE,
    })

    // Nel foglio va l'identificativo, MAI un collegamento condivisibile.
    const dati = { ...scheda.dati, [lato === 'retro' ? 'Doc retro' : 'Doc fronte']: fileId }
    await aggiornaRiga(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI, scheda.numeroRiga, aRiga(COL_OSPITI, dati))

    return NextResponse.json({ ok: true, lato, caricato: true })
  } catch (err) {
    // Nel log l'esito, non il contenuto: e' un documento d'identita'.
    console.error('[CHECKIN] caricamento documento fallito:', err instanceof Error ? err.message : 'errore')
    return NextResponse.json(
      { ok: false, errore: 'Non sono riuscito a salvare la foto. Riprova.' },
      { status: 500 },
    )
  }
}

