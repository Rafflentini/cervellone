/**
 * I tool con cui Cervellone vede — e lancia — le proprie automazioni.
 *
 * ── Perche' esiste questo file (5 settembre 2026) ────────────────────────────
 * L'Ingegnere ha chiesto al bot di creare l'automazione delle fatture estere.
 * Il bot ha risposto che non ce l'aveva e non sapeva farla. Esisteva da maggio,
 * girava puntuale ogni mese, e non aveva mai raccolto niente.
 *
 * Il bot non ha mentito: era cieco. Cervellone conosce se stesso attraverso
 * l'elenco dei propri tool, e un cron NON e' un tool. Nessuna automazione
 * pianificata era raggiungibile o nominabile: dal suo punto di vista non
 * esistevano.
 *
 * Da qui due tool:
 *   - `elenca_automazioni`  — cosa gira da solo, quando, e SE ha lavorato
 *     davvero (non solo se e' partito: e' la differenza che ha nascosto il
 *     guasto delle fatture estere per quattro mesi). [[feedback_misura_non_e_dato]]
 *   - `raccogli_fatture_estere` — lanciare la raccolta senza aspettare il 1°.
 *
 * Un tool, e non un comando slash, perche' `getToolDefinitions()` non conosce i
 * canali: un tool nasce uguale su Telegram e sulla chat web per costruzione.
 * [[feedback_due_canali_equipollenti]]
 */
import { supabase } from '../supabase'
import type { ToolDefinition } from './types'

export type Automazione = {
  /** Il percorso in vercel.json: e' la chiave che lega registro e realta'. */
  percorso: string
  nome: string
  /** L'espressione cron, come sta in vercel.json. */
  pianificazione: string
  /** Quando gira, in italiano. Gli orari di Vercel sono UTC. */
  quando: string
  cosaFa: string
  /** Il tool con cui la si puo' lanciare a mano, se ce n'e' uno. */
  invocabile?: string
}

/**
 * Il registro delle automazioni.
 *
 * DEVE combaciare con `vercel.json`, ed esiste un test che lo verifica nei due
 * versi: un cron aggiunto senza registrarlo qui fa fallire la suite. Senza quel
 * test questo elenco diventerebbe la seconda cosa che racconta al bot una
 * verita' scaduta — ed e' esattamente il guasto che stiamo chiudendo.
 */
export const AUTOMAZIONI: Automazione[] = [
  {
    percorso: '/api/cron/canary',
    nome: 'sentinella del modello',
    pianificazione: '*/30 * * * *',
    quando: 'ogni 30 minuti',
    cosaFa: 'Quando il modello principale e stato messo da parte per guasti, riprova in sordina: tre prove riuscite di fila e lo rimette in servizio.',
  },
  {
    percorso: '/api/cron/gmail-morning',
    nome: 'riassunto posta del mattino',
    pianificazione: '0 6 * * 1-5',
    quando: 'giorni feriali alle 06:00 UTC',
    cosaFa: 'Legge la casella Gmail e manda su Telegram il riassunto della posta della giornata.',
  },
  {
    percorso: '/api/cron/gmail-alerts',
    nome: 'allarmi posta',
    pianificazione: '*/30 7-16 * * 1-5',
    quando: 'ogni 30 minuti, feriali dalle 07:00 alle 16:00 UTC',
    cosaFa: 'Controlla la Gmail e avvisa subito se arriva qualcosa di critico secondo le regole configurate.',
  },
  {
    percorso: '/api/cron/memoria-extract',
    nome: 'memoria della giornata',
    pianificazione: '30 21 * * *',
    quando: 'ogni sera alle 21:30 UTC',
    cosaFa: 'Riassume le conversazioni del giorno e aggiorna le entita menzionate: e la memoria di lungo periodo.',
  },
  {
    percorso: '/api/cron/self-audit',
    nome: 'controllo settimanale',
    pianificazione: '0 6 * * 1',
    quando: 'ogni lunedi alle 06:00 UTC',
    cosaFa: 'Passa in rassegna lo stato del sistema e segnala le anomalie, fra cui le scadenze gia passate ma ancora attive.',
  },
  {
    percorso: '/api/cron/monthly-foreign-invoices',
    nome: 'fatture estere',
    pianificazione: '0 8 1 * *',
    quando: 'il 1 di ogni mese alle 08:00 UTC',
    cosaFa: 'Cerca le fatture dei fornitori esteri del mese appena chiuso su TUTTE E TRE le caselle (info@, raffaele.lentini@, Gmail) e le inoltra raggruppate con oggetto "Fatture estere Restruktura <mese> <anno>".',
    invocabile: 'raccogli_fatture_estere',
  },
  {
    percorso: '/api/cron/expire-pending',
    nome: 'pulizia delle cose in sospeso',
    pianificazione: '0 */6 * * *',
    quando: 'ogni 6 ore',
    cosaFa: 'Chiude le mail rimaste in attesa di conferma oltre il tempo massimo e i lavori rimasti appesi.',
  },
  {
    percorso: '/api/cron/scadenze',
    nome: 'promemoria scadenze',
    pianificazione: '0 5 * * *',
    quando: 'ogni giorno alle 05:00 UTC',
    cosaFa: 'Manda il promemoria per le scadenze in arrivo. ATTENZIONE: guarda solo in avanti, una scadenza registrata gia passata non riceve promemoria (la segnala il controllo settimanale).',
  },
  {
    percorso: '/api/cron/mail-sentinella',
    nome: 'sentinella degli allegati',
    pianificazione: '0 6 * * *',
    quando: 'ogni giorno alle 06:00 UTC',
    cosaFa: 'Esamina gli allegati in arrivo, riconosce i documenti con una scadenza e propone di registrarla.',
  },
  {
    percorso: '/api/cron/contabilita-mensile',
    nome: 'contabilita del mese',
    pianificazione: '0 7 1 * *',
    quando: 'il 1 di ogni mese alle 07:00 UTC',
    cosaFa: 'Riconcilia i movimenti e aggiorna la prima nota del mese chiuso.',
  },
  {
    percorso: '/api/cron/checkin-documenti',
    nome: 'cancellazione documenti di identita',
    pianificazione: '0 3 * * *',
    quando: 'ogni notte alle 03:00 UTC',
    cosaFa: 'Cancella le foto dei documenti di identita scadute: e la promessa che rende difendibile la raccolta dei dati degli ospiti.',
  },
]

// ── La prova che ha lavorato, non solo che e' partita ────────────────────────

export type StatoAutomazione = {
  ultima_prova: string
  /** null quando non esiste una misura: dirlo e meglio che inventare un verde. */
  misurata: boolean
}

async function ultimaRiga(tabella: string, colonnaData: string): Promise<string | null> {
  const { data } = await supabase.from(tabella).select(colonnaData).order(colonnaData, { ascending: false }).limit(1)
  const riga = ((data ?? []) as unknown[])[0] as Record<string, string> | undefined
  return riga && riga[colonnaData] ? String(riga[colonnaData]) : null
}

async function valoreConfig(chiave: string): Promise<string | null> {
  const { data } = await supabase.from('cervellone_config').select('value').eq('key', chiave).maybeSingle()
  return (data as { value?: string } | null)?.value ?? null
}

/**
 * Per ogni automazione, la prova che ha prodotto qualcosa.
 *
 * Dove una prova non c'e', si dice. Un "tutto ok" non misurato e' peggio di un
 * "non lo so": e' il verde che ha coperto quattro mesi di zero.
 */
export async function statoAutomazione(a: Automazione): Promise<StatoAutomazione> {
  try {
    switch (a.percorso) {
      case '/api/cron/monthly-foreign-invoices': {
        // Un conteggio CUMULATIVO non e' una prova che l'automazione lavori
        // adesso: dice solo che ha lavorato una volta, chissa' quando. Il
        // 5 set 2026 questa riga diceva "5 fatture raccolte in tutto" e il
        // modello ne ha dedotto che l'automazione funzionava — mentre 4 di
        // quelle 5 righe erano il recupero fatto A MANO e registrato a
        // posteriori. Una guardia contro i silenzi che si racconta una mezza
        // verita' e' essa stessa un silenzio. [[feedback_misura_non_e_dato]]
        const { data } = await supabase
          .from('cervellone_email_invoices_log')
          .select('month_ref, forwarded_at, forwarded_message_id')
          .order('forwarded_at', { ascending: false })
        const righe = (data ?? []) as Array<{ month_ref: string; forwarded_at: string; forwarded_message_id: string | null }>
        // Le righe scritte a mano per registrare un recupero manuale NON sono
        // lavoro dell'automazione: contarle insieme alle altre e' proprio cio'
        // che ha ingannato la lettura.
        const automatiche = righe.filter((r) => !String(r.forwarded_message_id ?? '').startsWith('recupero-manuale'))
        const manuali = righe.length - automatiche.length
        if (automatiche.length === 0) {
          return {
            misurata: true,
            ultima_prova: `NESSUNA fattura raccolta dall automazione${manuali > 0 ? ` (le ${manuali} in archivio sono recuperi fatti a mano)` : ''}. Se il mese scorso ce n erano, l automazione NON sta lavorando.`,
          }
        }
        const ultima = automatiche[0]
        const giorniFa = Math.floor((Date.now() - new Date(ultima.forwarded_at).getTime()) / 86_400_000)
        const mesiCoperti = [...new Set(automatiche.map((r) => r.month_ref))].sort()
        // Gira una volta al mese: oltre ~45 giorni di silenzio o ha smesso di
        // funzionare, oppure sono davvero due mesi senza fatture estere.
        const vecchia = giorniFa > 45
        return {
          misurata: true,
          ultima_prova:
            `${automatiche.length} fatture raccolte dall automazione` +
            (manuali > 0 ? ` (piu ${manuali} recuperate a mano, non contate)` : '') +
            `; ultima ${giorniFa} giorni fa, mesi coperti: ${mesiCoperti.join(', ')}` +
            (vecchia ? '. ATTENZIONE: gira ogni mese, ma l ultima raccolta e vecchia: da controllare.' : ''),
        }
      }
      case '/api/cron/memoria-extract': {
        const q = await ultimaRiga('cervellone_memoria_extraction_runs', 'completed_at')
        return { misurata: true, ultima_prova: q ? `ultima estrazione ${q}` : 'nessuna estrazione registrata' }
      }
      case '/api/cron/self-audit': {
        const q = await ultimaRiga('cervellone_audit_runs', 'completed_at')
        return { misurata: true, ultima_prova: q ? `ultimo controllo ${q}` : 'nessun controllo registrato' }
      }
      case '/api/cron/gmail-alerts': {
        const q = await valoreConfig('gmail_alert_check_last_run')
        return { misurata: true, ultima_prova: q ? `ultima lettura Gmail ${q}` : 'nessuna lettura registrata' }
      }
      case '/api/cron/gmail-morning': {
        const q = await valoreConfig('gmail_summary_last_run')
        return { misurata: true, ultima_prova: q ? `ultimo riassunto ${q}` : 'nessun riassunto registrato' }
      }
      default:
        return { misurata: false, ultima_prova: 'nessuna misura disponibile: non so dire se abbia prodotto qualcosa' }
    }
  } catch (err) {
    return { misurata: false, ultima_prova: `misura non riuscita: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const AUTOMAZIONI_TOOLS: ToolDefinition[] = [
  {
    name: 'elenca_automazioni',
    description:
      'Elenca TUTTE le automazioni pianificate di Cervellone (i lavori che partono da soli a orari fissi): cosa fanno, quando girano, e la prova che hanno prodotto qualcosa davvero. USALO SEMPRE prima di rispondere a domande come "hai un automazione per X?", "puoi automatizzare X?", "esiste gia qualcosa che fa X?" — le automazioni pianificate NON compaiono nell elenco dei tool, quindi senza questo tool non le vedi e rischi di dire che non esistono mentre girano da mesi. Se una automazione risulta senza prove di aver prodotto nulla, DILLO all Ingegnere: e il modo in cui un guasto silenzioso si fa notare.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'raccogli_fatture_estere',
    description:
      'Raccoglie le fatture dei fornitori esteri di un mese da tutte e tre le caselle (info@, raffaele.lentini@, Gmail) e le inoltra raggruppate a raffaele.lentini@ con oggetto "Fatture estere Restruktura <mese> <anno>". Normalmente parte da sola il 1 di ogni mese: questo tool serve per lanciarla a richiesta o per un mese passato. Con prova=true NON invia nulla e si limita a dire cosa troverebbe: usalo per primo quando l Ingegnere chiede di controllare. ESITO: se la risposta segnala "zero riconosciute" su caselle non vuote, oppure una casella non raggiungibile, riportalo TESTUALMENTE — non dire solo "fatto".',
    input_schema: {
      type: 'object',
      properties: {
        mese: { type: 'string', description: 'Mese di riferimento in forma AAAA-MM. Se manca, il mese scorso.' },
        prova: { type: 'boolean', description: 'true = non invia nulla, dice solo cosa troverebbe.' },
      },
    },
  },
]

function meseScorso(oggi = new Date()): string {
  const p = new Date(Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth() - 1, 1))
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function executeAutomazioniTools(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name === 'elenca_automazioni') {
    const righe: string[] = [`Cervellone ha ${AUTOMAZIONI.length} automazioni pianificate:`, '']
    for (const a of AUTOMAZIONI) {
      const stato = await statoAutomazione(a)
      righe.push(`• ${a.nome} — ${a.quando}`)
      righe.push(`  ${a.cosaFa}`)
      righe.push(`  Prova che lavora: ${stato.ultima_prova}`)
      if (a.invocabile) righe.push(`  Si puo lanciare a richiesta con il tool ${a.invocabile}.`)
      righe.push('')
    }
    righe.push(
      'Nota: queste NON sono tool, sono lavori pianificati. Per cambiarle serve una modifica al codice (vercel.json + la rotta corrispondente).',
    )
    return righe.join('\n')
  }

  if (name === 'raccogli_fatture_estere') {
    const mese = typeof input.mese === 'string' && /^\d{4}-\d{2}$/.test(input.mese) ? input.mese : meseScorso()
    const prova = input.prova === true
    // L'import e' qui dentro e non in cima perche' la routine tira dentro IMAP,
    // Gmail e SMTP: caricarla all'avvio rallenterebbe ogni conversazione, anche
    // quelle che non parlano di fatture.
    const { runMonthlyForeignInvoices } = await import('@/v19/routines/monthly-foreign-invoices')
    const r = await runMonthlyForeignInvoices({ month_ref: mese, dry_run: prova })

    const righe = [
      `Fatture estere ${mese}${prova ? ' (PROVA: non ho inviato nulla)' : ''}:`,
      `Esaminati ${r.esaminati} messaggi. Riconosciute ${r.candidates.length}. Inoltrate ${r.forwarded.length}.`,
      `Per casella — ${r.per_casella.map((c) => `${c.casella}: ${c.inoltrate}/${c.riconosciute} su ${c.esaminati}`).join(' · ')}`,
    ]
    if (r.nessun_risultato) {
      righe.push(
        `ATTENZIONE: zero fatture riconosciute su ${r.esaminati} messaggi. Non e normale: probabile whitelist mittenti da aggiornare.`,
      )
    }
    if (r.whitelist_vuota) righe.push('ATTENZIONE: nessun mittente configurato, il filtro non poteva far passare nulla.')
    if (r.troncato) righe.push(`ATTENZIONE: lettura parziale (${r.totale_in_casella} messaggi): alcune fatture potrebbero non essere state viste.`)
    for (const c of r.caselle_fallite) righe.push(`ATTENZIONE: casella ${c.casella} non raggiungibile (${c.errore}): li dentro non ho guardato.`)
    for (const n of r.non_inoltrate) righe.push(`ATTENZIONE: fattura riconosciuta ma non inoltrata (${n.casella}/${n.chiave}, stato ${n.stato}).`)
    for (const e of r.errori_registro) righe.push(`ATTENZIONE: inoltro riuscito ma non registrato (${e.casella}/${e.chiave}): il mese prossimo potrebbe ripartire doppio.`)
    if (r.fallback_warnings.length > 0) {
      const mittenti = [...new Set(r.fallback_warnings.map((f) => f.from))].slice(0, 8)
      righe.push(`Mittenti con allegato e parola "fattura" ma NON riconosciuti: ${mittenti.join(', ')}. Chiedi all Ingegnere se vanno aggiunti.`)
    }
    if (r.forwarded.length > 0) {
      righe.push('Inoltrate:')
      for (const f of r.forwarded) righe.push(`  - ${f.from} (da ${f.casella})`)
    }
    return righe.join('\n')
  }

  return null
}
