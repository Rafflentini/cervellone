/**
 * src/lib/tools/registro-portali-tools.ts — leggere il registro, e verificarlo.
 *
 * Due tool, e nessuno dei due scrive.
 *
 * - `registro_portali_situazione` risponde alla domanda che il 15 settembre
 *   2026 non aveva risposta: «a che punto siamo?». Quante fatture in ogni
 *   stato, quali in ritardo, quali da verificare e PERCHE'.
 *
 * - `registro_portali_riconcilia` e' la difesa contro il registro che invecchia
 *   male: 🚨 IL REGISTRO NON E' LA VERITA', Fatture in Cloud lo e'. Rilegge da
 *   FIC i documenti che una riga CITA e dice se combaciano. Una riga che dice
 *   `td17_generata` e punta a un documento cancellato a mano lo scopre qui —
 *   altrove nessuno se ne accorgerebbe mai.
 */
import type { ToolDefinition } from './types'
import { supabase } from '@/lib/supabase'
import { ficGet, getCompanyId } from '@/lib/fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from '@/lib/societa'
import { TIPO_FIC_AUTOFATTURA, TIPO_FIC_SPESA } from '@/lib/fic-write-tools'
import {
  TABELLA_REGISTRO,
  PORTALI,
  STATI_AVANZAMENTO,
  DA_VERIFICARE,
  chiaveNumeroPortale,
  rangoStato,
} from '@/lib/registro-portali'

/** Oltre questo stato una fattura non e' piu' «in ritardo»: e' stata spedita. */
const RANGO_SPEDITA = rangoStato('td17_inviata')

/** Giorni entro cui una scadenza si chiama «vicina». */
const GIORNI_VICINA = 7

export interface RigaRegistroLetta {
  id: string
  societa: string
  portale: string
  struttura: string | null
  numero_fattura: string
  data_fattura: string
  data_ricezione: string | null
  imponibile: number | null
  iva: number | null
  regime: string | null
  stato: string
  spesa_fic_id: string | null
  td17_fic_id: string | null
  td17_numero: string | null
  stato_sdi: string | null
  scadenza_invio: string | null
  note: string | null
}

const CAMPI = 'id, societa, portale, struttura, numero_fattura, data_fattura, data_ricezione, imponibile, iva, regime, stato, spesa_fic_id, td17_fic_id, td17_numero, stato_sdi, scadenza_invio, note'

function oggiRoma(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function giorniDopo(iso: string, giorni: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + giorni)
  return d.toISOString().slice(0, 10)
}

function euro(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(2).replace('.', ',')} €`
}

function intestazioneRiga(r: RigaRegistroLetta): string {
  return `${r.portale} n.${r.numero_fattura} del ${r.data_fattura}`
    + (r.struttura ? ` (${r.struttura})` : '')
    + ` — ${euro(r.imponibile)}`
}

/** L'ultima riga della nota: il motivo piu' recente, senza vomitare lo storico. */
function ultimaNota(note: string | null): string {
  if (!note) return 'nessun motivo scritto'
  const righe = note.split('\n').map((s) => s.trim()).filter(Boolean)
  return righe.length > 0 ? righe[righe.length - 1] : 'nessun motivo scritto'
}

export async function situazioneRegistro(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
  oggi: string = oggiRoma(),
): Promise<string> {
  const s = getSocieta(societa)

  let q = supabase
    .from(TABELLA_REGISTRO)
    .select(CAMPI)
    // Societa' dalla CONVERSAZIONE, non dall'input: da un contesto Restruktura
    // non si leggono le fatture de La Real Estate. Stessa regola dei tool FIC.
    .eq('societa', societa)
    .order('data_fattura', { ascending: false })
    .limit(200)

  const portale = typeof input.portale === 'string' ? input.portale.trim().toLowerCase() : ''
  if (portale) {
    if (!(PORTALI as readonly string[]).includes(portale)) {
      return `Portale «${portale}» sconosciuto: i portali del registro sono ${PORTALI.join(', ')}. Non ho letto niente.`
    }
    q = q.eq('portale', portale)
  }

  const mese = typeof input.mese === 'string' ? input.mese.trim() : ''
  if (mese) {
    if (!/^\d{4}-\d{2}$/.test(mese)) {
      return `Il mese va scritto YYYY-MM (es. 2026-08), non «${mese}». Non ho letto niente.`
    }
    const primo = `${mese}-01`
    // Il primo del mese dopo, senza aritmetica sui giorni.
    const anno = Number(mese.slice(0, 4))
    const m = Number(mese.slice(5, 7))
    const dopo = m === 12 ? `${anno + 1}-01-01` : `${anno}-${String(m + 1).padStart(2, '0')}-01`
    q = q.gte('data_fattura', primo).lt('data_fattura', dopo)
  }

  const statoChiesto = typeof input.stato === 'string' ? input.stato.trim() : ''
  if (statoChiesto) {
    const validi = [...STATI_AVANZAMENTO, DA_VERIFICARE] as readonly string[]
    if (!validi.includes(statoChiesto)) {
      return `Stato «${statoChiesto}» sconosciuto: gli stati sono ${validi.join(', ')}. Non ho letto niente.`
    }
    q = q.eq('stato', statoChiesto)
  }

  const { data, error } = await q
  if (error) {
    // 🚨 Un registro che non si legge NON e' un registro vuoto: dire «nessuna
    // fattura» qui sarebbe il guasto che invece di chiudere APRE.
    return `NON sono riuscito a leggere il registro dei portali, quindi NON so dire a che punto siamo.\nMotivo: ${error.message}`
  }

  const righe = (data ?? []) as unknown as RigaRegistroLetta[]
  const filtri = [portale ? `portale ${portale}` : null, mese ? `mese ${mese}` : null, statoChiesto ? `stato ${statoChiesto}` : null]
    .filter(Boolean).join(', ')

  if (righe.length === 0) {
    return `Registro portali di ${s.denominazione}${filtri ? ` (${filtri})` : ''}: NESSUNA riga.\n`
      + 'Attenzione: non vuol dire che non ci siano fatture di commissioni — vuol dire che nel registro non ne risulta nessuna. '
      + 'Il registro si popola quando registra_spesa_fornitore o compila_autofattura creano un documento e la rilettura lo conferma.'
  }

  const perStato = new Map<string, number>()
  for (const r of righe) perStato.set(r.stato, (perStato.get(r.stato) ?? 0) + 1)

  const limite = giorniDopo(oggi, GIORNI_VICINA)
  const inRitardo: string[] = []
  const inScadenza: string[] = []
  const senzaScadenza: string[] = []
  for (const r of righe) {
    if (rangoStato(r.stato) >= RANGO_SPEDITA && r.stato !== DA_VERIFICARE) continue
    if (!r.scadenza_invio) {
      // ⚠️ Una scadenza che non si puo' calcolare si DICE. Tacerla farebbe
      // sembrare in regola una riga di cui nessuno sa il termine.
      senzaScadenza.push(`- ${intestazioneRiga(r)} — stato ${r.stato}: manca la data di ricezione, quindi NON so quando scade l'invio.`)
      continue
    }
    if (r.scadenza_invio < oggi) inRitardo.push(`- ${intestazioneRiga(r)} — stato ${r.stato}, scadenza ${r.scadenza_invio} GIA' PASSATA`)
    else if (r.scadenza_invio <= limite) inScadenza.push(`- ${intestazioneRiga(r)} — stato ${r.stato}, scadenza ${r.scadenza_invio}`)
  }

  const daVerificare = righe
    .filter((r) => r.stato === DA_VERIFICARE)
    .map((r) => `- ${intestazioneRiga(r)} — ${ultimaNota(r.note)}`)

  const conteggi = [...STATI_AVANZAMENTO, DA_VERIFICARE]
    .filter((st) => (perStato.get(st) ?? 0) > 0)
    .map((st) => `${st}: ${perStato.get(st)}`)
    .join(' · ')

  return [
    `REGISTRO PORTALI — ${s.denominazione}${filtri ? ` (${filtri})` : ''}: ${righe.length} fatture.`,
    `A che punto siamo: ${conteggi}`,
    inRitardo.length > 0 ? `\n🚨 IN RITARDO (${inRitardo.length}) — scadenza passata e non ancora inviata:\n${inRitardo.join('\n')}` : null,
    inScadenza.length > 0 ? `\n⚠️ IN SCADENZA entro ${GIORNI_VICINA} giorni (${inScadenza.length}):\n${inScadenza.join('\n')}` : null,
    senzaScadenza.length > 0 ? `\n⚠️ SENZA SCADENZA CALCOLABILE (${senzaScadenza.length}):\n${senzaScadenza.join('\n')}` : null,
    daVerificare.length > 0 ? `\n🚨 DA VERIFICARE (${daVerificare.length}) — col motivo:\n${daVerificare.join('\n')}` : null,
    '\nIl registro NON e\' la verita\': Fatture in Cloud lo e\'. Se una riga sembra strana, passala a registro_portali_riconcilia.',
  ].filter(Boolean).join('\n')
}

type EsitoLettura =
  | { trovato: true; doc: Record<string, unknown> }
  | { trovato: false; motivo: string }
  | { incerto: true; motivo: string }

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

async function leggiDocumento(
  collezione: 'issued_documents' | 'received_documents',
  id: string,
  societa: CodiceSocieta,
): Promise<EsitoLettura> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { incerto: true, motivo: company.error }
  const r = await ficGet(
    `/c/${company.id}/${collezione}/${encodeURIComponent(id)}`,
    collezione === 'received_documents' ? { fieldset: 'detailed' } : undefined,
    societa,
  )
  if (!r.ok) {
    // 🚨 UN 404 E' UN FATTO («non c'e' piu'»); ogni altro guasto e' un «non lo
    // so» e non deve travestirsi da documento sparito, altrimenti un token
    // scaduto farebbe dichiarare cancellati tutti i documenti dell'anno.
    if (/\b404\b/.test(r.error)) return { trovato: false, motivo: r.error }
    return { incerto: true, motivo: r.error }
  }
  const doc = asObject(asObject(r.data).data ?? r.data)
  if (!doc.id) return { trovato: false, motivo: 'Fatture in Cloud ha risposto senza documento' }
  return { trovato: true, doc }
}

function stringa(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function numero(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export async function riconciliaRegistro(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  const s = getSocieta(societa)
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const num = typeof input.numero === 'string' ? input.numero.trim() : ''
  if (!id && !num) {
    return 'Serve `numero` (della fattura del portale) oppure `id` (della riga del registro): non indovino quale riga vuoi riconciliare. Non ho letto niente.'
  }

  let q = supabase.from(TABELLA_REGISTRO).select(CAMPI).eq('societa', societa).limit(5)
  if (id) q = q.eq('id', id)
  else q = q.eq('numero_chiave', chiaveNumeroPortale(num))
  const portale = typeof input.portale === 'string' ? input.portale.trim().toLowerCase() : ''
  if (portale) q = q.eq('portale', portale)

  const { data, error } = await q
  if (error) return `NON sono riuscito a leggere il registro, quindi non ho riconciliato niente.\nMotivo: ${error.message}`

  const righe = (data ?? []) as unknown as RigaRegistroLetta[]
  if (righe.length === 0) {
    return `Nel registro di ${s.denominazione} non c'e' nessuna riga per ${id ? `id ${id}` : `la fattura n.${num}`}. `
      + 'Non vuol dire che il documento non esista su Fatture in Cloud: vuol dire che il registro non lo conosce.'
  }
  if (righe.length > 1) {
    return `Nel registro ci sono ${righe.length} righe per la fattura n.${num} (portali diversi): `
      + `${righe.map((r) => `${r.portale} → id ${r.id}`).join(', ')}. Richiamami con \`portale\` o con l'\`id\` della riga.`
  }

  const r = righe[0]
  const esiti: string[] = []
  let divergenze = 0
  const diverge = (testo: string) => { divergenze++; esiti.push(`🚨 ${testo}`) }

  // --- La SPESA (documento RICEVUTO) ---
  if (r.spesa_fic_id) {
    const letto = await leggiDocumento('received_documents', r.spesa_fic_id, societa)
    if ('incerto' in letto) {
      esiti.push(`⚠️ SPESA id ${r.spesa_fic_id}: non sono riuscito a leggerla su Fatture in Cloud (${letto.motivo}). NON concludo niente su di lei.`)
    } else if (!letto.trovato) {
      diverge(`SPESA id ${r.spesa_fic_id}: su Fatture in Cloud NON C'E' PIU' (${letto.motivo}). Il registro cita un documento che non esiste.`)
    } else {
      const tipo = stringa(letto.doc.type)
      const numeroDoc = stringa(letto.doc.invoice_number)
      const netto = numero(letto.doc.amount_net)
      esiti.push(`✅ SPESA id ${r.spesa_fic_id}: c'e' su Fatture in Cloud.`)
      if (tipo && tipo !== TIPO_FIC_SPESA) diverge(`SPESA id ${r.spesa_fic_id}: su FIC risulta di tipo «${tipo}», non ${TIPO_FIC_SPESA}.`)
      if (numeroDoc && chiaveNumeroPortale(numeroDoc) !== chiaveNumeroPortale(r.numero_fattura)) {
        diverge(`SPESA id ${r.spesa_fic_id}: su FIC il numero del fornitore e' «${numeroDoc}», il registro dice «${r.numero_fattura}».`)
      }
      if (netto !== null && r.imponibile !== null && Math.abs(netto - Number(r.imponibile)) > 0.01) {
        diverge(`SPESA id ${r.spesa_fic_id}: su FIC l'imponibile e' ${euro(netto)}, il registro dice ${euro(Number(r.imponibile))}.`)
      }
    }
  } else if (rangoStato(r.stato) >= rangoStato('spesa_registrata')) {
    diverge(`il registro dice «${r.stato}» ma non porta nessun id della spesa: lo stato dichiara un documento che la riga non sa nominare.`)
  } else {
    esiti.push('— SPESA: la riga non ne cita nessuna, e lo stato non ne promette.')
  }

  // --- L'INTEGRAZIONE TD17 (documento EMESSO) ---
  if (r.td17_fic_id) {
    const letto = await leggiDocumento('issued_documents', r.td17_fic_id, societa)
    if ('incerto' in letto) {
      esiti.push(`⚠️ TD17 id ${r.td17_fic_id}: non sono riuscito a leggerla su Fatture in Cloud (${letto.motivo}). NON concludo niente su di lei.`)
    } else if (!letto.trovato) {
      diverge(`TD17 id ${r.td17_fic_id}: su Fatture in Cloud NON C'E' PIU' (${letto.motivo}). Il registro cita un documento che non esiste — probabilmente cancellato a mano.`)
    } else {
      const tipo = stringa(letto.doc.type)
      const numeroDoc = stringa(letto.doc.number)
      const serie = stringa(letto.doc.numeration)
      const stato = stringa(asObject(letto.doc.ei_data).status) ?? stringa(letto.doc.ei_status)
      esiti.push(`✅ TD17 id ${r.td17_fic_id}: c'e' su Fatture in Cloud${numeroDoc ? ` (n. ${numeroDoc}${serie ? `/${serie}` : ''})` : ''}.`)
      if (tipo && tipo !== TIPO_FIC_AUTOFATTURA) diverge(`TD17 id ${r.td17_fic_id}: su FIC risulta di tipo «${tipo}», non ${TIPO_FIC_AUTOFATTURA}.`)
      if (stato) {
        esiti.push(`   Stato SdI su Fatture in Cloud: «${stato}»${r.stato_sdi ? ` — il registro dice «${r.stato_sdi}»` : ' — il registro non lo registra'}.`)
      }
    }
  } else if (rangoStato(r.stato) >= rangoStato('td17_generata')) {
    diverge(`il registro dice «${r.stato}» ma non porta nessun id dell'integrazione TD17: lo stato dichiara un documento che la riga non sa nominare.`)
  } else {
    esiti.push('— TD17: la riga non ne cita nessuna, e lo stato non ne promette.')
  }

  return [
    `RICONCILIAZIONE — ${s.denominazione} — ${intestazioneRiga(r)}`,
    `Riga del registro: id ${r.id}, stato «${r.stato}»${r.scadenza_invio ? `, scadenza invio ${r.scadenza_invio}` : ', scadenza invio non calcolabile'}.`,
    '',
    ...esiti,
    '',
    divergenze === 0
      ? '✅ REGISTRO E FATTURE IN CLOUD COMBACIANO su tutto quello che ho potuto leggere.'
      : `🚨 ${divergenze} DIVERGENZE. Fatture in Cloud e' la verita', il registro no: va allineato il REGISTRO, non il documento.`,
    'Non ho scritto niente: ne\' sul registro, ne\' su Fatture in Cloud.',
    r.stato === DA_VERIFICARE ? `⚠️ La riga porta il cartello «da_verificare»: ${ultimaNota(r.note)}` : null,
  ].filter(Boolean).join('\n')
}

export const REGISTRO_PORTALI_TOOLS: ToolDefinition[] = [
  {
    name: 'registro_portali_situazione',
    description:
      "A CHE PUNTO SIAMO con le fatture di COMMISSIONE dei portali (Booking.com, Airbnb): una riga per fattura del fornitore, con lo STATO dell adempimento. USALO quando l Ingegnere chiede «le commissioni Booking a che punto sono?», «quali fatture dei portali sono ancora da integrare?», «cosa e in ritardo?». RISPONDE con: quante fatture in ogni stato (nuova, spesa_registrata, td17_generata, td17_inviata, sdi_consegnata, chiusa, da_verificare), quali sono IN RITARDO (scadenza dell invio passata e integrazione non ancora spedita), quali scadono entro sette giorni, quali NON hanno una scadenza calcolabile perche manca la data di ricezione, e quali sono DA VERIFICARE col motivo scritto. La scadenza dell invio e il giorno 15 del mese successivo alla RICEZIONE della fattura estera. 🚨 IL REGISTRO NON E LA VERITA: Fatture in Cloud lo e. Questo tool dice cosa risulta A CERVELLONE — se una riga sembra strana passala a registro_portali_riconcilia, che rilegge i documenti veri. ⚠️ Se il registro non si legge il tool lo DICE: «nessuna riga» e «non sono riuscito a leggere» non sono la stessa cosa. Legge solo la societa della conversazione.",
    input_schema: {
      type: 'object',
      properties: {
        portale: { type: 'string', enum: [...PORTALI], description: 'Filtra su un portale solo. Omesso: tutti.' },
        mese: { type: 'string', description: 'Mese della DATA FATTURA, YYYY-MM (es. 2026-08). Omesso: tutte le fatture.' },
        stato: {
          type: 'string',
          enum: [...STATI_AVANZAMENTO, DA_VERIFICARE],
          description: 'Filtra su uno stato solo. Omesso: tutti gli stati, col riepilogo per stato.',
        },
      },
    },
  },
  {
    name: 'registro_portali_riconcilia',
    description:
      "CONTROLLA che una riga del registro dei portali dica la verita, rileggendo da Fatture in Cloud i documenti che CITA: la spesa (documento ricevuto) e l integrazione TD17 (documento emesso). USALO quando una riga sembra strana, quando l Ingegnere chiede «ma questo documento esiste davvero?», e prima di dire che un adempimento e concluso. SCOPRE: un documento cancellato a mano su Fatture in Cloud che il registro continua a citare; uno stato che promette un documento di cui la riga non porta l id; un numero o un imponibile che su FIC sono diversi da quelli scritti nel registro; il tipo di documento sbagliato. RIPORTA anche lo stato SdI che Fatture in Cloud dichiara. 🚨 NON SCRIVE NIENTE, ne sul registro ne su Fatture in Cloud: dice cosa non torna e chi ha ragione — Fatture in Cloud e la verita, il registro no, quindi si allinea il REGISTRO. ⚠️ Distingue «il documento non c e piu» (404) da «non sono riuscito a leggerlo» (token, rete, 429): il secondo NON e un documento sparito e il tool non lo dichiara tale. Serve numero (della fattura del portale, non dell autofattura) oppure id della riga.",
    input_schema: {
      type: 'object',
      properties: {
        numero: { type: 'string', description: 'Numero della fattura DEL PORTALE, come sta sul documento del fornitore. Punteggiatura e maiuscole non contano.' },
        id: { type: 'string', description: 'Id della riga del registro, se lo hai da registro_portali_situazione. Alternativo a numero.' },
        portale: { type: 'string', enum: [...PORTALI], description: 'Serve solo se lo stesso numero esiste su piu portali.' },
      },
    },
  },
]

export async function executeRegistroPortaliTools(
  name: string,
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string | null> {
  try {
    if (name === 'registro_portali_situazione') return await situazioneRegistro(input, societa)
    if (name === 'registro_portali_riconcilia') return await riconciliaRegistro(input, societa)
    return null
  } catch (err) {
    return `Il registro dei portali non ha risposto: ${err instanceof Error ? err.message : String(err)}. Non ho scritto niente.`
  }
}
