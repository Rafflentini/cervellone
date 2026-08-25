/**
 * api/cron/checkin-documenti — cancella le foto dei documenti scadute.
 *
 * E' la promessa che rende difendibile tutto il resto: le fotografie delle
 * carte d'identita' non sono un archivio, sono di passaggio. Se questo lavoro
 * non gira, la promessa e' falsa — e una promessa falsa sui dati personali di
 * terzi e' peggio che non averla fatta.
 *
 * Percio' qui, a differenza di altrove:
 *
 *  - si va avanti anche se una cancellazione fallisce, altrimenti una foto
 *    bloccherebbe tutte le altre;
 *  - si SVUOTANO anche le celle del foglio. Un identificativo che punta a un
 *    file che non c'e' piu' e' peggio di una cella vuota: sembra che il
 *    documento ci sia;
 *  - l'esito dice quante ne ha tolte e quante non ci e' riuscito, cosi' un
 *    guasto silenzioso non esiste.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI, COL_SOGGIORNI, COL_OSPITI,
} from '@/lib/checkin/foglio-schema'
import { leggiTutto, aggiornaRiga } from '@/lib/checkin/foglio-google'
import { aMappa, aRiga } from '@/lib/checkin/merge-pratica'
import { leggiConfig } from '@/lib/checkin/foglio-lettura'
import { scadutiDaCancellare, type PraticaConDocumenti } from '@/lib/checkin/conservazione'
import { eliminaDocumento } from '@/lib/checkin/documenti'

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, errore: 'non autorizzato' }, { status: 401 })
  }

  try {
    const [cfg, soggiorni, ospiti] = await Promise.all([
      leggiConfig(),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI),
    ])

    const giorni = Number(cfg.giorni_conservazione_documenti ?? '7')

    // Righe ospite raggruppate per pratica, con il numero di riga: serve dopo
    // per svuotare le celle.
    const perPratica = new Map<string, Array<{ numeroRiga: number; dati: Record<string, string> }>>()
    ospiti.forEach((r, idx) => {
      if (idx === 0) return
      const dati = aMappa(COL_OSPITI, r)
      const id = String(dati['ID Soggiorno'] ?? '').trim()
      if (!id) return
      const elenco = perPratica.get(id) ?? []
      elenco.push({ numeroRiga: idx + 1, dati })
      perPratica.set(id, elenco)
    })

    const pratiche: PraticaConDocumenti[] = soggiorni.slice(1).map((r) => {
      const s = aMappa(COL_SOGGIORNI, r)
      const id = String(s['ID Soggiorno'] ?? '').trim()
      const schede = perPratica.get(id) ?? []
      return {
        id,
        checkout: String(s['Check-out'] ?? ''),
        fileIds: schede.flatMap((x) => [x.dati['Doc fronte'], x.dati['Doc retro']])
          .map((x) => String(x ?? '').trim())
          .filter(Boolean),
      }
    })

    const scaduti = scadutiDaCancellare(pratiche, new Date(), giorni)

    let tolte = 0
    const nonRiuscite: string[] = []

    for (const pratica of scaduti) {
      for (const scheda of perPratica.get(pratica.id) ?? []) {
        const dati = { ...scheda.dati }
        let cambiata = false

        for (const colonna of ['Doc fronte', 'Doc retro'] as const) {
          const fileId = String(dati[colonna] ?? '').trim()
          if (!fileId) continue
          try {
            await eliminaDocumento(fileId)
            tolte++
          } catch {
            // Si svuota la cella lo stesso? No: se il file c'e' ancora, la
            // cella deve continuare a dirlo, altrimenti la foto resta su Drive
            // e nessuno sa piu' che esiste.
            nonRiuscite.push(`${pratica.id}/${colonna}`)
            continue
          }
          dati[colonna] = ''
          cambiata = true
        }

        if (cambiata) {
          await aggiornaRiga(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI, scheda.numeroRiga, aRiga(COL_OSPITI, dati))
        }
      }
    }

    console.log(`[CRON documenti] pratiche scadute=${scaduti.length} foto tolte=${tolte} non riuscite=${nonRiuscite.length}`)

    return NextResponse.json({
      ok: nonRiuscite.length === 0,
      giorniConservazione: giorni,
      praticheScadute: scaduti.length,
      fotoTolte: tolte,
      nonRiuscite,
    })
  } catch (err) {
    console.error('[CRON documenti] fallito:', err)
    return NextResponse.json({ ok: false, errore: 'pulizia non riuscita' }, { status: 500 })
  }
}
