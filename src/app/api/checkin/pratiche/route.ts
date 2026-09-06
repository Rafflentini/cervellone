/**
 * api/checkin/pratiche — l'elenco delle prenotazioni, per chi gestisce.
 *
 * Serve a rispondere alle domande che ci si fa davvero: chi arriva domani, quali
 * check-in non sono completi, di chi manca cosa. Sono DOMANDE, non eventi: se
 * una settimana salta, la settimana dopo si vede lo stesso l'arretrato. Un
 * avviso perso invece non torna.
 *
 * Dal 25/08 l'elenco ha due VISTE — il lavoro aperto e l'archivio — perche'
 * con 5 appartamenti e affitti settimanali sono circa 150 prenotazioni l'anno,
 * e restituirle tutte a ogni caricamento significa due cose: che a meta'
 * stagione per vedere chi arriva domani si scorre sopra a tutta l'estate, e che
 * si calcola la firma di ogni collegamento di ogni ospite di ogni prenotazione
 * — centinaia di firme per aprire una pagina.
 *
 * Il confine fra le due viste sta in archivio.ts, ed e' provato li'. Qui si
 * legge il foglio e si applica: la regola che decide cosa sparisce dagli occhi
 * non deve stare in una route dove non si puo' provarla.
 *
 * Solo col token generale. L'elenco di chi dorme in casa, con le date e gli
 * importi, non e' cosa da ospiti.
 */

import { NextRequest, NextResponse } from 'next/server'
import { risolviAccesso } from '@/lib/checkin/accesso'
import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI, COL_SOGGIORNI, COL_OSPITI,
} from '@/lib/checkin/foglio-schema'
import { leggiTutto } from '@/lib/checkin/foglio-google'
import { aMappa } from '@/lib/checkin/merge-pratica'
import { linkPrenotazione, linkOspite } from '@/lib/checkin/token-prenotazione'
import {
  classifica, contaNumeri, indiceMesi, selezionaPratiche, statoFatturaDi,
  STATI_FATTURA, type StatoFattura, type Vista, type PraticaArchiviabile,
} from '@/lib/checkin/archivio'

/** Solo cio' che il chiamante puo' davvero aver chiesto. */
function comeVista(v: string | null): Vista {
  return v === 'archivio' ? 'archivio' : 'adesso'
}

function comeStatoFattura(v: string | null): StatoFattura | undefined {
  const s = String(v ?? '').trim().toUpperCase()
  return (STATI_FATTURA as readonly string[]).includes(s) ? (s as StatoFattura) : undefined
}

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), null, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

  const vista = comeVista(s.get('vista'))
  const mese = /^\d{4}-\d{2}$/.test(s.get('mese') ?? '') ? (s.get('mese') as string) : undefined
  const unita = s.get('unita')?.trim() || undefined
  const q = s.get('q')?.trim() || undefined
  const fattura = comeStatoFattura(s.get('fattura'))
  const chiesto = s.get('manca')
  const manca = chiesto === 'checkin' || chiesto === 'questura' ? chiesto : undefined
  const oggi = new Date().toISOString().slice(0, 10)

  try {
    const [soggiorni, ospiti] = await Promise.all([
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI),
    ])

    const schedePerId = new Map<string, number>()
    /*
      I progressivi che esistono davvero, prenotazione per prenotazione.

      Servono a generare i collegamenti giusti: i numeri non sono contigui —
      tolto un ospite restano l'1 e il 3 — e costruire i link contando 1, 2, 3
      significherebbe consegnare all'ospite 3 il collegamento della scheda 2.
    */
    const progressiviPerId = new Map<string, Set<number>>()
    for (const [i, r] of ospiti.entries()) {
      if (i === 0) continue
      const m = aMappa(COL_OSPITI, r)
      const id = String(m['ID Soggiorno'] ?? '').trim()
      if (!id) continue
      schedePerId.set(id, (schedePerId.get(id) ?? 0) + 1)
      const n = Number(String(m['Progressivo'] ?? '').trim())
      if (Number.isInteger(n) && n > 0) {
        const s = progressiviPerId.get(id) ?? new Set<number>()
        s.add(n)
        progressiviPerId.set(id, s)
      }
    }

    const base = req.nextUrl.origin

    /*
      Prima la parte leggera: tutte le righe, ma senza le firme dei
      collegamenti. Serve per contare e per costruire l'indice dei mesi, e
      contare deve costare poco perche' si conta SEMPRE su tutto.
    */
    const tutte = soggiorni.slice(1)
      .map((r) => aMappa(COL_SOGGIORNI, r))
      .filter((m) => String(m['ID Soggiorno'] ?? '').trim())
      .map((m): PraticaArchiviabile & { m: Record<string, string> } => ({
        id: String(m['ID Soggiorno']).trim(),
        unita: m['Unità'] ?? '',
        intestatario: m['Intestatario fattura'] ?? '',
        codPrenotazione: m['Cod. prenotazione'] ?? '',
        checkin: m['Check-in'] ?? '',
        checkout: m['Check-out'] ?? '',
        notti: m['Notti'] ?? '',
        imposta: m['Imposta soggiorno €'] ?? '',
        stato: m['Stato check-in'] || 'DA COMPILARE',
        inviatoAlloggiati: String(m['Inviato Alloggiati'] ?? '').toUpperCase() === 'SI',
        statoFattura: statoFatturaDi(m),
        m,
      }))

    // I numeri in cima valgono su TUTTO: cambiare vista non deve cambiarli.
    const numeri = contaNumeri(tutte, oggi)
    /*
      L'indice dei mesi si calcola su TUTTE le prenotazioni.

      Prima si calcolava solo su quelle archiviate — cioe' gia' `CHECKIN OK`
      **e** gia' spuntate come caricate in Questura. Il totale dell'imposta di
      soggiorno che compariva accanto al mese era quindi una somma parziale, e
      niente a schermo lo diceva: il 7 settembre, con gli arretrati di agosto
      appena inseriti, avrebbe detto "agosto 2026 · 0 prenotazioni" mentre
      quelle persone hanno dormito qui e l'imposta si versa entro il 16.

      Un numero fiscale non puo' dipendere dalla spunta di un adempimento
      diverso.
    */
    const mesi = indiceMesi(tutte)
    const appartamenti = [...new Set(tutte.map((p) => p.unita).filter(Boolean))].sort()

    const scelte = selezionaPratiche(tutte, { vista, oggi, mese, unita, q, fattura, manca })

    // Le firme si calcolano SOLO su cio' che si mostra. Erano il costo
    // nascosto: un HMAC per ogni ospite di ogni prenotazione, a ogni apertura.
    const pratiche = (scelte as (PraticaArchiviabile & { m: Record<string, string> })[])
      .map(({ m, ...p }) => {
        const attesi = Number(m['N. ospiti'] || 0)
        /*
          I link degli ospiti seguono il numero PRENOTATO, non quello delle
          schede gia' compilate.

          Regressione introdotta il 6 set 2026 e trovata da un audit poche ore
          dopo: rendendo `Ospiti dichiarati` un conteggio scritto dal server
          (le schede davvero compilate), questa riga faceva scendere il numero
          di link a uno appena il primo ospite salvava — e i collegamenti per
          gli altri sparivano dalla pagina proprio nel momento in cui il
          gestore doveva mandarli.
        */
        const dichiarati = Math.max(Number(m['Ospiti dichiarati'] || 0), attesi, 1)

        const numeri = new Set(progressiviPerId.get(p.id) ?? [])
        const quanti = Math.max(attesi, 1)
        // Il tetto e' una cintura: nessuna prenotazione ha duecento ospiti, e
        // un ciclo che dipende da un dato del foglio non deve poter girare a
        // vuoto se quel dato e' assurdo.
        for (let n = 1; numeri.size < quanti && n <= 200; n++) numeri.add(n)

        return {
          ...p,
          portale: m['Portale'] ?? '',
          importo: m['Importo lordo €'] ?? '',
          attesi,
          dichiarati,
          compilate: schedePerId.get(p.id) ?? 0,
          daCompletare: m['Da completare'] ?? '',
          fileAlloggiatiDel: m['File Alloggiati del'] ?? '',
          nFattura: m['N. fattura'] ?? '',
          dataFattura: m['Data fattura'] ?? '',
          link: linkPrenotazione(base, p.id),
          linkOspiti: [...numeri].sort((a, b) => a - b).map((n) => ({
            progressivo: n,
            link: linkOspite(base, p.id, n),
          })),
        }
      })

    return NextResponse.json({
      ok: true,
      vista,
      oggi,
      numeri,
      mesi,
      appartamenti,
      totale: tutte.length,
      pratiche,
    })
  } catch (err) {
    console.error('[CHECKIN] elenco pratiche fallito:', err)
    return NextResponse.json(
      { ok: false, errore: 'Non sono riuscito a leggere le prenotazioni.' },
      { status: 500 },
    )
  }
}
