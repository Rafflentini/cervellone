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
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI, SCHEDA_STRUTTURE,
  COL_SOGGIORNI, COL_OSPITI,
} from '@/lib/checkin/foglio-schema'
import { leggiTutto } from '@/lib/checkin/foglio-google'
import { aMappa } from '@/lib/checkin/merge-pratica'
import { leggiTabelle, chiaveLuogo } from '@/lib/checkin/foglio-lettura'
import { generaAlloggiati, type OspiteAlloggiati } from '@/lib/checkin/alloggiati'
import { tuttiIComuni } from '@/lib/checkin/comuni'
import { idNelFile } from '@/lib/checkin/segnature'
import { segnaSoggiorno } from '@/lib/checkin/pratica'

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), null, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

  /** Facoltativo: limita a un solo appartamento. Vedi il commento sotto. */
  const soloStruttura = s.get('struttura')?.trim() ?? ''

  // Senza data si intende ieri: e' la domanda che ci si fa la mattina.
  const richiesta = s.get('data')?.trim()
  const data = richiesta || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return NextResponse.json({ ok: false, errore: 'Data non valida (aaaa-mm-gg).' }, { status: 400 })
  }

  try {
    const [soggiorni, ospiti, tabelle, strutture] = await Promise.all([
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_OSPITI),
      leggiTabelle(),
      leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_STRUTTURE),
    ])

    /*
      Il codice del Portale a partire dalla denominazione, cercato in
      quest'ordine:

        1. la scheda `Tabelle` del foglio — che e' il posto delle ECCEZIONI e
           degli stati esteri, e vince su tutto: se un codice va corretto, si
           corregge li' senza aspettare un rilascio;
        2. l'elenco dei comuni incorporato, con i codici ufficiali della
           Questura uniti alle anagrafiche.

      Chi non si trova in nessuno dei due non riceve un codice vuoto in
      silenzio: viene segnalato col suo nome.
    */
    const daFoglio = new Map<string, string>()
    for (const v of tabelle) if (v.alloggiati) daFoglio.set(chiaveLuogo(v.denominazione), v.alloggiati)

    const daCodice = new Map<string, string>()
    for (const c of tuttiIComuni()) if (c.alloggiati) daCodice.set(chiaveLuogo(c.nome), c.alloggiati)

    const codice = (denominazione: string) =>
      daFoglio.get(chiaveLuogo(denominazione)) ?? daCodice.get(chiaveLuogo(denominazione)) ?? ''

    const perId = new Map<string, Record<string, string>>()
    for (const [i, r] of soggiorni.entries()) {
      if (i === 0) continue
      const m = aMappa(COL_SOGGIORNI, r)
      const id = String(m['ID Soggiorno'] ?? '').trim()
      if (!id || String(m['Check-in'] ?? '').trim() !== data) continue
      // Le credenziali del Portale sono PER STRUTTURA: se gli appartamenti
      // sono registrati separatamente, ognuno ha il suo account e vuole il
      // suo file. Il tracciato non porta un codice struttura — la struttura
      // e' l'account con cui si carica.
      perId.set(id, m)
    }

    /*
      A quale STRUTTURA appartiene un appartamento.

      Cinque appartamenti, tre CIN: il raggruppamento non e' per appartamento.
      Le credenziali del Portale sono per struttura, quindi raggruppare per
      appartamento produrrebbe cinque file dove ne servono tre, da caricare su
      account che non esistono.

      Finche' il CIN non e' compilato si ripiega sul nome dell'appartamento: il
      sistema funziona lo stesso, solo diviso piu' del necessario.
    */
    const strutturaDi = new Map<string, string>()
    for (const [i, r] of strutture.entries()) {
      if (i === 0) continue
      const appartamento = String(r[0] ?? '').trim()
      const cin = String(r[1] ?? '').trim()
      if (appartamento && cin) strutturaDi.set(chiaveLuogo(appartamento), cin)
    }
    const struttura = (u: string) =>
      strutturaDi.get(chiaveLuogo(u)) ?? (String(u || '').trim() || 'Senza appartamento')

    const daInviare: OspiteAlloggiati[] = []
    /** Per ogni ospite, la struttura a cui va comunicato. */
    const strutturaPerOspite: string[] = []
    /** Per ogni ospite, la prenotazione da cui viene: serve a segnarla dopo. */
    const idPerOspite: string[] = []

    for (const [i, r] of ospiti.entries()) {
      if (i === 0) continue
      const o = aMappa(COL_OSPITI, r)
      const soggiorno = perId.get(String(o['ID Soggiorno'] ?? '').trim())
      if (!soggiorno) continue

      strutturaPerOspite.push(struttura(String(soggiorno['Unità'] ?? '')))
      idPerOspite.push(String(o['ID Soggiorno'] ?? '').trim())
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

    /*
      Senza `scarica` si restituisce il quadro DIVISO PER APPARTAMENTO.

      Non e' una comodita': le credenziali del Portale sono per struttura
      ricettiva, e qui le strutture sono tre. Un totale unico farebbe credere
      che basti un caricamento solo — e quel malinteso si scopre col cronometro
      delle 24 ore che gira.
    */
    /** Solo gli ospiti di una struttura, mantenendo l'ordine. */
    const soloDi = (nome: string) =>
      daInviare.filter((_, i) => strutturaPerOspite[i] === nome)

    if (s.get('scarica') !== '1') {
      const nomi = [...new Set(strutturaPerOspite)].sort((a, b) => a.localeCompare(b))

      const gruppi = nomi.map((nome) => {
        const f = generaAlloggiati(soloDi(nome))
        // Quali appartamenti finiscono in questa struttura: serve a capire a
        // colpo d'occhio se il CIN e' stato compilato o si sta ripiegando.
        const appartamenti = [...new Set(
          [...perId.values()]
            .map((m) => String(m['Unità'] ?? '').trim())
            .filter((u) => struttura(u) === nome && u),
        )]
        return {
          struttura: nome,
          appartamenti,
          righe: f.righe,
          avvisi: f.avvisi,
          pronto: f.avvisi.length === 0,
        }
      })

      const tuttiGliAvvisi = gruppi.flatMap((g) => g.avvisi)

      return NextResponse.json({
        ok: tuttiGliAvvisi.length === 0,
        data,
        righe: daInviare.length,
        // Un file per struttura: il totale unico farebbe credere che basti un
        // caricamento solo, e quel malinteso si scopre col cronometro che gira.
        gruppi,
        avvisi: tuttiGliAvvisi,
        ...(tuttiGliAvvisi.length > 0
          ? { attenzione: 'Il portale rifiuta il file intero se una riga e incompleta. Sistema prima gli avvisi.' }
          : {}),
      })
    }

    const file = generaAlloggiati(soloStruttura ? soloDi(soloStruttura) : daInviare)

    // Con `?scarica=1` esce il file vero; altrimenti l'esito, che serve a
    // sapere PRIMA se vale la pena scaricarlo.
    if (s.get('scarica') === '1' && file.righe > 0) {
      /*
        Si annota che il file e' stato GENERATO, e si annota solo questo.

        Non "inviato": scaricare un file non adempie a niente, il caricamento
        sul Portale e' un altro gesto e lo fa una persona. Scrivere qui
        "inviato" sarebbe il solito passaggio che sembra fatto — con la
        differenza che qui la scadenza e' di 24 ore e non si recupera.

        L'annotazione NON puo' far fallire lo scaricamento: se il foglio non
        risponde si perde una data di comodo, se il file non esce si perde
        l'adempimento. Non c'e' partita, e per questo l'errore finisce nel log
        e il file parte lo stesso.
      */
      const daSegnare = idNelFile(idPerOspite, strutturaPerOspite, soloStruttura)
      const oggi = new Date().toISOString().slice(0, 10)
      await Promise.all(daSegnare.map(async (id) => {
        try {
          await segnaSoggiorno(id, { 'File Alloggiati del': oggi })
        } catch (err) {
          console.error(`[CHECKIN] segnatura file Questura non riuscita su ${id}:`, err)
        }
      }))

      return new NextResponse(file.contenuto, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="Alloggiati_${data.replace(/-/g, '')}${soloStruttura ? '_' + soloStruttura.replace(/[^A-Za-z0-9]/g, '') : ''}.txt"`,
        },
      })
    }

    return NextResponse.json({
      ok: file.avvisi.length === 0,
      data,
      ...(soloStruttura ? { struttura: soloStruttura } : {}),
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
