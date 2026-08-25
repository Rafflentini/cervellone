/**
 * api/checkin/pratiche — l'elenco delle prenotazioni, per chi gestisce.
 *
 * Serve a rispondere alle domande che ci si fa davvero: chi arriva domani, quali
 * check-in non sono completi, di chi manca cosa. Sono DOMANDE, non eventi: se
 * una settimana salta, la settimana dopo si vede lo stesso l'arretrato. Un
 * avviso perso invece non torna.
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

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), null, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

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

    const pratiche = soggiorni.slice(1)
      .map((r) => aMappa(COL_SOGGIORNI, r))
      .filter((m) => String(m['ID Soggiorno'] ?? '').trim())
      .map((m) => {
        const id = String(m['ID Soggiorno']).trim()
        const attesi = Number(m['N. ospiti'] || 0)
        const dichiarati = Number(m['Ospiti dichiarati'] || 0) || attesi

        return {
          id,
          unita: m['Unità'] ?? '',
          portale: m['Portale'] ?? '',
          codPrenotazione: m['Cod. prenotazione'] ?? '',
          checkin: m['Check-in'] ?? '',
          checkout: m['Check-out'] ?? '',
          intestatario: m['Intestatario fattura'] ?? '',
          importo: m['Importo lordo €'] ?? '',
          imposta: m['Imposta soggiorno €'] ?? '',
          attesi,
          dichiarati,
          compilate: schedePerId.get(id) ?? 0,
          stato: m['Stato check-in'] || 'DA COMPILARE',
          daCompletare: m['Da completare'] ?? '',
          inviatoAlloggiati: String(m['Inviato Alloggiati'] ?? '').toUpperCase() === 'SI',
          fatturaEmessa: String(m['Fattura emessa'] ?? '').toUpperCase() === 'SI',
          link: linkPrenotazione(base, id),
          linkOspiti: Array.from({ length: Math.max(dichiarati, 1) }, (_, i) => ({
            progressivo: i + 1,
            link: linkOspite(base, id, i + 1),
          })),
        }
      })
      // Le piu' recenti in cima: e' li' che si guarda.
      .sort((a, b) => (a.checkin < b.checkin ? 1 : a.checkin > b.checkin ? -1 : 0))

    return NextResponse.json({ ok: true, pratiche })
  } catch (err) {
    console.error('[CHECKIN] elenco pratiche fallito:', err)
    return NextResponse.json({ ok: false, errore: 'Non riesco a leggere il foglio.' }, { status: 500 })
  }
}
