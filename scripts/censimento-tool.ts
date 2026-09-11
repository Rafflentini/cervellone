/**
 * CENSIMENTO DELLE CAPACITA' — differenziale.
 *
 * La domanda giusta NON e' «questo tool e' raggiungibile?» ma «il differimento ha
 * tolto qualcosa che oggi c'era?». Per questo ogni richiesta gira DUE volte: una
 * con tutti i tool caricati come oggi, una col differimento acceso.
 *
 * ⚠️ QUESTO SCRIPT E' STATO TARATO TRE VOLTE L'11 SETTEMBRE 2026, E OGNI VOLTA LA
 * RISPOSTA E' CAMBIATA. Non toccare i tre parametri qui sotto senza rileggere
 * `docs/superpowers/registri/2026-09-11-censimento-tool.md`:
 *
 *  1. `max_tokens: 3000` — a 500 la risposta veniva TRONCATA subito dopo la chiamata
 *     di ricerca, prima che i risultati arrivassero: sembrava che la ricerca tornasse
 *     vuota. Con 500, 4 tool risultavano falsamente irraggiungibili.
 *  2. Il system prompt e' il BASE_PROMPT VERO, non una riga inventata: il prompt vero
 *     elenca molti tool per nome, e una riga finta misura una macchina che non esiste.
 *  3. L'AVVISO va SOLO al braccio differito. Darlo anche a «oggi» sarebbe scorretto:
 *     oggi i tool sono tutti visibili e non c'e' niente da cercare.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/censimento-tool.ts            # tutti i differiti
 *   npx tsx --env-file=.env.local scripts/censimento-tool.ts --frasi    # le 9 frasi vere
 *   npx tsx --env-file=.env.local scripts/censimento-tool.ts nome1 nome2
 *
 * ⚠️ LIMITE DICHIARATO del modo «tutti»: le richieste sono derivate dalla prima frase
 * della descrizione del tool, quindi sono in parte CIRCOLARI e spesso non sono
 * nemmeno dei compiti. Il conteggio «gia' irraggiungibili oggi» NON e' significativo:
 * dice che quelle richieste sono scritte male, non che il bot non sappia farle.
 * L'unico numero difendibile e' il differenziale — il difetto della richiesta si
 * annulla da entrambe le parti. Il modo `--frasi` non ha questo limite.
 */
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { getToolDefinitions } from '../src/lib/tools'
import { NUCLEO_TOOL, AVVISO_STRUMENTI_CERCABILI } from '../src/lib/tool-nucleo'

const MODEL = 'claude-sonnet-4-6'
const client = new Anthropic()

// BASE_PROMPT e' un template literal statico senza interpolazioni (verificato:
// zero occorrenze di ${ fra le righe 129 e 380), quindi si legge come testo.
const righe = readFileSync('src/lib/prompts.ts', 'utf8').split(/\r?\n/)
const SYSTEM = righe.slice(128, 380).join('\n').replace(/^const BASE_PROMPT = `/, '').replace(/`$/, '')

const OGGI = getToolDefinitions() as { name: string; description?: string }[]
const DIFF = getToolDefinitions({ nucleo: NUCLEO_TOOL, ricerca: true }) as {
  name: string; description?: string; defer_loading?: boolean
}[]
const descrizioneDi = new Map(OGGI.map((d) => [d.name, d.description ?? '']))

/**
 * LE NOVE FRASI VERE, scritte a mano come le direbbe l'Ingegnere.
 * Sono la prova che ha stabilito le 5 capacita' perse (e, dopo la cura, il 9 su 9).
 * ⚠️ NON cancellarle: senza di queste il debito di `NUCLEO_DEBITO_RICERCA` non e'
 * pagabile, perche' non si potrebbe piu' riprodurre la misura che lo giustifica.
 */
const FRASI_VERE: [string, string][] = [
  ['riconcilia_automatico', 'Riconcilia i movimenti del conto con le fatture di agosto.'],
  ['modello_attivo', 'Che modello di documento sto usando adesso?'],
  ['checkin_prepara_foglio', 'Preparami il foglio per il check-in degli appartamenti.'],
  ['cervellone_check_aggiornamenti', 'Controlla se sono usciti modelli Claude piu nuovi di quello che usi.'],
  ['affitti_imposta_soggiorno', 'Quanto devo versare di imposta di soggiorno per agosto a Maratea?'],
  ['affitti_situazione', 'Come vanno gli affitti brevi? Chi arriva nei prossimi giorni?'],
  ['read_email', 'Leggimi le ultime mail non lette sulla casella info.'],
  ['lista_scadenze', 'Quali scadenze ho nei prossimi 30 giorni?'],
  ['archivia_foto', 'Archivia le foto che ti ho mandato nel cantiere C2026-006.'],
]

async function prova(testo: string, elenco: unknown[], avvisa: boolean) {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 3000, // vedi nota 1 in testa: NON abbassare
    system: SYSTEM + (avvisa ? AVVISO_STRUMENTI_CERCABILI : ''),
    tools: elenco as never,
    messages: [{ role: 'user', content: testo }],
  })
  const b = r.content as { type: string; name?: string; content?: { tool_references?: { tool_name: string }[] } }[]
  return {
    chiamati: b.filter((x) => x.type === 'tool_use').map((x) => x.name!),
    trovati: b.flatMap((x) => (x.type === 'tool_search_tool_result' ? (x.content?.tool_references ?? []) : [])).map((x) => x.tool_name),
    tok: r.usage.input_tokens,
  }
}

async function main() {
  const argomenti = process.argv.slice(2)
  const soloFrasi = argomenti[0] === '--frasi'
  const casi: [string, string][] = soloFrasi
    ? FRASI_VERE
    : (argomenti.length ? argomenti : DIFF.filter((d) => d.defer_loading).map((d) => d.name))
        .map((n) => [n, `Compito: ${(descrizioneDi.get(n) ?? n).split(/[.\n]/)[0].slice(0, 200)}`] as [string, string])

  console.log(`${casi.length} casi, x2 configurazioni${soloFrasi ? ' — FRASI VERE (nessuna circolarita)' : ' — richieste derivate dalle descrizioni (CIRCOLARI, vedi nota in testa)'}\n`)
  let persi = 0, ok = 0, neanche = 0, tokOggi = 0, tokDiff = 0
  const elencoPersi: string[] = []

  for (const [nome, testo] of casi) {
    try {
      const a = await prova(testo, OGGI, false)
      const b = await prova(testo, DIFF, true)
      tokOggi += a.tok; tokDiff += b.tok
      const oggiOk = a.chiamati.includes(nome), diffOk = b.chiamati.includes(nome)
      let esito: string
      if (oggiOk && diffOk) { esito = 'ok in entrambe'; ok++ }
      else if (oggiOk && !diffOk) { esito = '🚨 PERSO'; persi++; elencoPersi.push(nome) }
      else if (!oggiOk && !diffOk) { esito = 'ne oggi ne diff'; neanche++ }
      else { esito = 'solo differito'; ok++ }
      console.log(`${esito.padEnd(18)} ${nome}`)
      if (oggiOk && !diffOk) console.log(`                   oggi:[${a.chiamati.join(',')}] diff:[${b.chiamati.join(',') || '-'}] trovati:[${b.trovati.slice(0, 6).join(',') || '-'}]`)
    } catch (e) {
      console.log(`ERRORE             ${nome}: ${String(e).slice(0, 120)}`)
    }
  }

  console.log(`\n=== ESITO ===`)
  console.log(`ok: ${ok} | 🚨 PERSI: ${persi} | irraggiungibili gia oggi (numero NON significativo nel modo derivato): ${neanche}`)
  if (elencoPersi.length) {
    console.log(`🚨 ${elencoPersi.join(', ')}`)
    console.log(`\n⚠️ Prima di chiamarli persi: rilancia ognuno almeno 3 volte. Il modello non e'`)
    console.log(`   deterministico e un fallimento 1 volta su 3 e' rumore, non una capacita' persa.`)
  }
  console.log(`token in ingresso: oggi ${tokOggi} | differito ${tokDiff} | ${Math.round((1 - tokDiff / tokOggi) * 100)}% in meno`)
  process.exitCode = persi ? 1 : 0
}
main()
