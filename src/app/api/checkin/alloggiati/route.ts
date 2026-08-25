/**
 * api/checkin/alloggiati — il file da caricare sul Portale Alloggiati.
 *
 * Si chiede per DATA DI ARRIVO, perche' e' cosi' che funziona l'obbligo:
 * entro 24 ore da quando l'ospite e' arrivato (art. 109 T.U.L.P.S.). Chi lo usa
 * pensa "chi e' arrivato ieri", non "quale prenotazione".
 *
 * Restituisce sempre anche gli AVVISI, e li restituisce anche quando il file
 * esce. Un file che si scarica senza dire niente sembra pronto: se poi il
 * portale lo rifiuta, il tempo per rimediare e' gia' andato.
 *
 * Solo per chi gestisce: l'elenco di chi dorme in casa non e' cosa da ospiti.
 */

import { NextRequest, NextResponse } from 'next/server'
import { risolviAccesso } from '@/lib/checkin/accesso'
import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI, COL_SOGGIORNI, COL_OSPITI,
} from '@/lib/checkin/foglio-schema'
import { leggiTutto } from '@/lib/checkin/foglio-google'
import { aMappa } from '@/lib/checkin/merge-pratica'
import { leggiTabelle, chiaveLuogo } from '@/lib/checkin/foglio-lettura'
import { generaAlloggiati, type OspiteAlloggiati } from '@/lib/checkin/alloggiati'

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), null, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

  // Senza data si intende ieri: e' la domanda che ci si fa la mattina.
  const richiesta = s.get('data')?.trim()
  const data = richiesta || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return NextResponse.json({ ok: false, errore: 'Data non valida (aaaa-mm-gg).' }, { status: 400 })
  }

  try {
    const [soggiorni, ospiti, tabelle] = await Promise.all([
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI),
      leggiTabelle(),
    ])

    // Codice Portale a partire dalla denominazione. Le tabelle stanno nel
    // foglio proprio perche' vanno caricate dalle fonti ufficiali e aggiornate
    // senza rilasci.
    const codici = new Map<string, string>()
    for (const v of tabelle) if (v.alloggiati) codici.set(chiaveLuogo(v.denominazione), v.alloggiati)
    const codice = (denominazione: string) => codici.get(chiaveLuogo(denominazione)) ?? ''

    const perId = new Map<string, Record<string, string>>()
    for (const [i, r] of soggiorni.entries()) {
      if (i === 0) continue
      const m = aMappa(COL_SOGGIORNI, r)
      const id = String(m['ID Soggiorno'] ?? '').trim()
      if (id && String(m['Check-in'] ?? '').trim() === data) perId.set(id, m)
    }

    const daInviare: OspiteAlloggiati[] = []
    for (const [i, r] of ospiti.entries()) {
      if (i === 0) continue
      const o = aMappa(COL_OSPITI, r)
      const soggiorno = perId.get(String(o['ID Soggiorno'] ?? '').trim())
      if (!soggiorno) continue

      daInviare.push({
        tipoAlloggiato: o['Tipo alloggiato'] ?? '',
        dataArrivo: soggiorno['Check-in'] ?? '',
        notti: Number(soggiorno['Notti'] || 1),
        cognome: o['Cognome'] ?? '',
        nome: o['Nome'] ?? '',
        sesso: o['Sesso'] ?? '',
        dataNascita: o['Data nascita'] ?? '',
        codiceComuneNascita: o['Comune nascita'] ? codice(o['Comune nascita']) : '',
        provinciaNascita: o['Prov. nascita'] ?? '',
        codiceStatoNascita: o['Stato nascita'] ? codice(o['Stato nascita']) : '',
        codiceCittadinanza: o['Cittadinanza'] ? codice(o['Cittadinanza']) : '',
        tipoDocumento: o['Tipo documento'] ?? '',
        numeroDocumento: o['Numero documento'] ?? '',
        codiceLuogoRilascio: o['Luogo rilascio'] ? codice(o['Luogo rilascio']) : '',
      })
    }

    const file = generaAlloggiati(daInviare)

    // Con `?scarica=1` esce il file vero; altrimenti l'esito, che serve a
    // sapere PRIMA se vale la pena scaricarlo.
    if (s.get('scarica') === '1' && file.righe > 0) {
      return new NextResponse(file.contenuto, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="Alloggiati_${data.replace(/-/g, '')}.txt"`,
        },
      })
    }

    return NextResponse.json({
      ok: file.avvisi.length === 0,
      data,
      righe: file.righe,
      avvisi: file.avvisi,
      // Il portale rifiuta il file INTERO se una riga e' incompleta: dirlo qui
      // evita di scoprirlo con il cronometro delle 24 ore che gira.
      ...(file.avvisi.length > 0
        ? { attenzione: 'Il portale rifiuta il file intero se una riga e incompleta. Sistema prima gli avvisi.' }
        : {}),
    })
  } catch (err) {
    console.error('[CHECKIN] Alloggiati fallito:', err)
    return NextResponse.json({ ok: false, errore: 'Non sono riuscito a generare il file.' }, { status: 500 })
  }
}
