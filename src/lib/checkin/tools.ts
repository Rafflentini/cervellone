/**
 * src/lib/checkin/tools.ts
 *
 * Gli strumenti del check-in de LA REAL ESTATE SRLS.
 *
 * Fino al 5 settembre 2026 ce n'era UNO SOLO — preparare il foglio — e quindi
 * per Cervellone questa societa' quasi non esisteva: non sapeva dire chi arriva
 * domani, quanto si e' incassato, quanta imposta versare. Tutto il valore
 * viveva nella pagina di gestione, che il bot non guarda.
 * [[cervellone-bot-cieco-sulle-automazioni]]
 */

import type { ToolDefinition } from '../tools/types'
import { inizializzaFoglioCheckin } from './foglio-init'
import { foglioGoogle } from './foglio-google'
import { FOGLIO_CHECKIN_ID } from './foglio-schema'
import { leggiPratiche, situazione, type PraticaLetta } from './lettura-pratiche'
import { leggiConfig, regoleDaConfig } from './foglio-lettura'
import { ripartisciImposta, scadenzaDichiarazione } from './imposta-mensile'

export const CHECKIN_TOOLS: ToolDefinition[] = [
  {
    name: 'checkin_prepara_foglio',
    description:
      "Prepara il foglio Google del check-in de LA REAL ESTATE: crea le schede Soggiorni, Ospiti, Config e Tabelle con le intestazioni corrette e i valori di partenza (unità, aliquota IVA, imposta di soggiorno di Maratea). È RIPETIBILE senza danno: le schede che già esistono e contengono dati non vengono toccate. Usalo quando l'Ingegnere chiede di preparare, inizializzare o sistemare il foglio dei check-in.",
    input_schema: {
      type: 'object',
      properties: {
        foglio_id: {
          type: 'string',
          description: `ID del foglio Google. Se omesso usa quello adottato (${FOGLIO_CHECKIN_ID}).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'affitti_situazione',
    description:
      "La fotografia degli affitti brevi de LA REAL ESTATE (Maratea): chi arriva nei prossimi giorni, chi è in casa adesso, quali check-in non sono completi, per quali soggiorni la comunicazione alla Questura (Portale Alloggiati) NON è ancora stata inviata, e quali fatture sono da preparare o da trasmettere. USALO ogni volta che l'Ingegnere chiede degli appartamenti, degli ospiti, degli arrivi, delle prenotazioni o dei check-in. ESITO: se compaiono soggiorni già iniziati senza comunicazione Alloggiati, DILLO PER PRIMO e cita gli ospiti: è l'art. 109 T.U.L.P.S., 24 ore dall'arrivo, e il ritardo non si recupera.",
    input_schema: {
      type: 'object',
      properties: {
        giorni: {
          type: 'integer',
          description: 'Quanti giorni in avanti guardare per gli arrivi. Default 7.',
        },
      },
      required: [],
    },
  },
  {
    name: 'affitti_imposta_soggiorno',
    description:
      "Calcola l'imposta di soggiorno di Maratea da DICHIARARE e VERSARE per un mese, con il dettaglio per prenotazione. La dichiarazione va fatta sul portale del Comune (applicativo Xenia/SISCOM) entro il giorno 16 del mese successivo, ANCHE SE A ZERO, e il versamento con PagoPA: omessa dichiarazione da 25 a 500 €, omesso versamento 30%. IMPORTANTE: i pernottamenti vengono contati nel mese in cui cadono DAVVERO, quindi un soggiorno a cavallo (es. 29/09→02/10) viene spezzato fra i due mesi — la pagina di gestione invece raggruppa per mese di arrivo, quindi i due numeri possono differire ed è giusto così. Usalo quando l'Ingegnere chiede dell'imposta di soggiorno, della tassa, della dichiarazione al Comune o di quanto deve versare.",
    input_schema: {
      type: 'object',
      properties: {
        mese: {
          type: 'string',
          description: "Mese di riferimento in forma AAAA-MM. Se omesso, il mese scorso.",
        },
      },
      required: [],
    },
  },
]

/**
 * Il mese scorso secondo il calendario ITALIANO.
 *
 * Con l'ora UTC, fra mezzanotte e le due del giorno 1 si sarebbe ancora nel
 * mese precedente: il cron delle 5 andrebbe bene, ma l'Ingegnere che chiede
 * "quanto devo versare" alla mezzanotte del 1° si sentirebbe rispondere sul
 * mese sbagliato.
 */
function meseScorso(): string {
  const oggiRoma = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
  const [anno, mese] = oggiRoma.split('-').map(Number)
  const p = new Date(Date.UTC(anno, mese - 2, 1))
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 'AAAA-MM' con un mese che esiste davvero: '2026-13' non e' un mese. */
function meseValido(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return false
  const m = Number(v.slice(5))
  return m >= 1 && m <= 12
}

function riga(p: PraticaLetta): string {
  return `${p.unita} · ${p.intestatario || '(intestatario mancante)'} · ${p.checkin} → ${p.checkout} · ${p.ospitiAttesi} ospiti`
}

export async function executeCheckinTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name === 'checkin_prepara_foglio') {
    const foglioId = typeof input.foglio_id === 'string' && input.foglio_id.trim()
      ? input.foglio_id.trim()
      : FOGLIO_CHECKIN_ID

    const esito = await inizializzaFoglioCheckin(foglioId, foglioGoogle)

    return JSON.stringify({
      ok: esito.ok,
      foglio_id: foglioId,
      url: `https://docs.google.com/spreadsheets/d/${foglioId}`,
      schede_create: esito.create,
      schede_gia_pronte: esito.giaPronte,
      ...(esito.errore ? { errore: esito.errore } : {}),
    })
  }

  if (name === 'affitti_situazione') {
    const giorni = typeof input.giorni === 'number' && input.giorni > 0 ? Math.trunc(input.giorni) : 7
    const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
    const pratiche = await leggiPratiche()
    const s = situazione(pratiche, oggi, giorni)

    const righe = [
      `LA REAL ESTATE — situazione al ${oggi} (${pratiche.length} prenotazioni in archivio)`,
      '',
      `IN CASA ADESSO: ${s.inCasa.length}`,
      ...s.inCasa.map((p) => `  - ${riga(p)}`),
      `IN ARRIVO nei prossimi ${giorni} giorni: ${s.inArrivo.length}`,
      ...s.inArrivo.map((p) => `  - ${riga(p)}`),
    ]

    // Prima gli adempimenti scoperti, poi il resto: sono le uniche voci con
    // una scadenza di legge alle spalle.
    if (s.alloggiatiDaInviare.length > 0) {
      righe.push('', `ATTENZIONE — COMUNICAZIONE ALLOGGIATI NON INVIATA per ${s.alloggiatiDaInviare.length} soggiorni gia iniziati (art. 109 T.U.L.P.S., 24 ore dall arrivo):`)
      righe.push(...s.alloggiatiDaInviare.map((p) => `  - ${riga(p)}`))
    }
    if (s.checkinIncompleti.length > 0) {
      righe.push('', `Check-in NON completi su soggiorni ancora aperti: ${s.checkinIncompleti.length}`)
      righe.push(...s.checkinIncompleti.map((p) => `  - ${riga(p)} (stato: ${p.statoCheckin})`))
    }
    righe.push(
      '',
      `Da fatturare (tocca a Cervellone): ${s.daFatturare.length}`,
      `Fatture compilate ma da trasmettere (tocca all Ingegnere): ${s.daInviareInFattura.length}`,
    )
    if (s.dateNonValide.length > 0) {
      // Escluse dai conti perche' non confrontabili, ma NON taciute: una riga
      // con le date scritte male e' una prenotazione che nessuno sta guardando.
      righe.push('', `ATTENZIONE: ${s.dateNonValide.length} prenotazioni hanno le date scritte male sul foglio (servono nella forma AAAA-MM-GG) e sono rimaste FUORI da tutti i conteggi qui sopra: ${s.dateNonValide.map((p) => `${p.id} (${p.unita}: "${p.checkin}" → "${p.checkout}")`).join(', ')}.`)
    }
    return righe.join('\n')
  }

  if (name === 'affitti_imposta_soggiorno') {
    const mese = meseValido(input.mese) ? input.mese : meseScorso()

    const [pratiche, cfg] = await Promise.all([leggiPratiche(), leggiConfig()])
    const regole = regoleDaConfig(cfg)

    const dettaglio: Array<{ p: PraticaLetta; notti: number; importo: number; aCavallo: boolean }> = []
    for (const p of pratiche) {
      const parti = ripartisciImposta(p.imposta, p.checkin, p.checkout, regole)
      const quota = parti.find((x) => x.mese === mese)
      if (!quota) continue
      dettaglio.push({ p, notti: quota.notti, importo: quota.importo, aCavallo: parti.length > 1 })
    }

    const totale = Math.round(dettaglio.reduce((s, d) => s + d.importo, 0) * 100) / 100
    const notti = dettaglio.reduce((s, d) => s + d.notti, 0)
    const aCavallo = dettaglio.filter((d) => d.aCavallo)
    // Al Comune si dichiarano le PRESENZE, cioe' i pernottamenti-PERSONA: due
    // ospiti per tre notti sono sei, non tre. Si ricavano dall'importo, che e'
    // gia' al netto delle esenzioni: contare le notti darebbe il numero
    // sbagliato proprio nel campo che finisce sul portale.
    const presenze = regole.tariffa > 0 ? Math.round(totale / regole.tariffa) : 0
    // Un soggiorno con notti tassabili ma imposta a zero puo' essere legittimo
    // (tutti minori) oppure un importo che dal foglio non e' stato letto.
    // Nel dubbio si dichiara: e' denaro di terzi.
    const zeroSospetti = dettaglio.filter((d) => d.notti > 0 && d.importo === 0)

    const righe = [
      `IMPOSTA DI SOGGIORNO — LA REAL ESTATE — mese ${mese}`,
      `Da dichiarare e versare entro il ${scadenzaDichiarazione(mese)} (portale del Comune di Maratea, Xenia/SISCOM; versamento con PagoPA).`,
      '',
      `TOTALE: ${totale.toFixed(2)} € — ${presenze} presenze (pernottamenti-persona), su ${notti} notti tassate e ${dettaglio.length} prenotazioni.`,
    ]

    if (zeroSospetti.length > 0) {
      righe.push('', `ATTENZIONE: ${zeroSospetti.length} soggiorni hanno notti tassabili ma imposta ZERO. Puo essere legittimo (tutti esenti), ma va verificato sul foglio: ${zeroSospetti.map((d) => `${d.p.unita} ${d.p.checkin}`).join(', ')}.`)
    }

    if (dettaglio.length === 0) {
      // La dichiarazione va fatta ANCHE a zero: tacere qui farebbe pensare che
      // non ci sia niente da fare, ed e' il contrario.
      righe.push('', 'Nessun pernottamento tassato in questo mese. La dichiarazione va presentata LO STESSO, indicando zero (artt. 6-7 del Regolamento): l omessa dichiarazione e sanzionata da 25 a 500 € anche se non c e nulla da versare.')
    } else {
      righe.push('', 'Dettaglio:')
      for (const d of dettaglio) {
        righe.push(`  - ${d.p.unita} · ${d.p.intestatario || '(senza intestatario)'} · ${d.p.checkin}→${d.p.checkout} · ${d.notti} notti · ${d.importo.toFixed(2)} €${d.aCavallo ? '  [soggiorno a cavallo fra due mesi: qui c e solo la parte di questo mese]' : ''}`)
      }
    }

    if (aCavallo.length > 0) {
      righe.push('', `NOTA: ${aCavallo.length} soggiorni sono a cavallo fra due mesi. Qui i pernottamenti sono contati nel mese in cui cadono DAVVERO, mentre la pagina di gestione raggruppa per mese di arrivo: se i due numeri non coincidono, quello giusto per il Comune e questo.`)
    }
    righe.push('', `Regole applicate: ${regole.tariffa.toFixed(2)} € a persona e a notte, primi ${regole.maxPernottamenti} pernottamenti, esenti fino a ${regole.esenzioneEtaMax} anni compiuti, stagione ${regole.stagioneDal}-${regole.stagioneAl}.`)

    return righe.join('\n')
  }

  return null
}
