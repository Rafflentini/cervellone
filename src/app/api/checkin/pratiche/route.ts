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
    for (const [i, r] of ospiti.entries()) {
      if (i === 0) continue
      const id = String(aMappa(COL_OSPITI, r)['ID Soggiorno'] ?? '').trim()
      if (id) schedePerId.set(id, (schedePerId.get(id) ?? 0) + 1)
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
    const mesi = indiceMesi(tutte.filter((p) => classifica(p, oggi) === 'archivio'))
    const appartamenti = [...new Set(tutte.map((p) => p.unita).filter(Boolean))].sort()

    const scelte = selezionaPratiche(tutte, { vista, oggi, mese, unita, q, fattura, manca })

    // Le firme si calcolano SOLO su cio' che si mostra. Erano il costo
    // nascosto: un HMAC per ogni ospite di ogni prenotazione, a ogni apertura.
    const pratiche = (scelte as (PraticaArchiviabile & { m: Record<string, string> })[])
      .map(({ m, ...p }) => {
        const attesi = Number(m['N. ospiti'] || 0)
        const dichiarati = Number(m['Ospiti dichiarati'] || 0) || attesi
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
          linkOspiti: Array.from({ length: Math.max(dichiarati, 1) }, (_, i) => ({
            progressivo: i + 1,
            link: linkOspite(base, p.id, i + 1),
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
