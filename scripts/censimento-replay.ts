/**
 * CENSIMENTO, BRACCIO A — replay differenziale su traffico vero.
 *
 * Prende i PRIMI messaggi utente delle conversazioni reali (auto-contenuti per
 * definizione: non dipendono da un contesto precedente) e li rigioca DUE volte:
 * una con tutti i tool caricati come oggi, una col differimento. Poi confronta
 * quali tool sono stati chiamati.
 *
 * Limite dichiarato: sono ~22 richieste, non un campione. Non provano l'assenza
 * di regressioni; provano che sul traffico reale disponibile non se ne vedono.
 * Il modello non e' deterministico: una divergenza va GUARDATA, non contata.
 *
 * Run: npx tsx --env-file=.env.local scripts/censimento-replay.ts
 */
import fs, { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { getToolDefinitions } from '../src/lib/tools'
import { NUCLEO_TOOL, AVVISO_STRUMENTI_CERCABILI } from '../src/lib/tool-nucleo'

const MODEL = 'claude-sonnet-4-6'
const client = new Anthropic()
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)

// Il prompt vero, estratto dal sorgente: BASE_PROMPT e' un template literal
// statico senza interpolazioni (verificato: zero occorrenze di ${ fra le righe
// 129 e 380), quindi si puo' leggere come testo.
const righe = readFileSync('src/lib/prompts.ts', 'utf8').split(/\r?\n/)
const SYSTEM = righe.slice(128, 380).join('\n').replace(/^const BASE_PROMPT = `/, '').replace(/`$/, '')

const OGGI = getToolDefinitions() as unknown[]
const DIFFERITO = getToolDefinitions({ nucleo: NUCLEO_TOOL, ricerca: true }) as unknown[]

async function tooliChiamati(testo: string, elenco: unknown[], avvisa = false) {
  const r = await client.messages.create({
    model: MODEL, max_tokens: 3000, system: SYSTEM + (avvisa ? AVVISO_STRUMENTI_CERCABILI : ''), tools: elenco as never,
    messages: [{ role: 'user', content: testo }],
  })
  const blocchi = r.content as { type: string; name?: string; content?: { tool_references?: { tool_name: string }[] } }[]
  return {
    chiamati: blocchi.filter((b) => b.type === 'tool_use').map((b) => b.name!).sort(),
    cercati: blocchi.filter((b) => b.type === 'server_tool_use').length,
    trovati: blocchi.flatMap((b) => (b.type === 'tool_search_tool_result' ? (b.content?.tool_references ?? []) : [])).map((x) => x.tool_name),
    tok: r.usage.input_tokens,
  }
}

async function main() {
  // ⚠️ I messaggi arrivano da un file, NON da Supabase: senza SUPABASE_SERVICE_ROLE_KEY
  // il client ripiega su anonimo, RLS nega e la lettura torna VUOTA senza dire niente —
  // il guasto si traveste da "non c'e' nulla". Estratti a parte e passati come dato.
  const primi = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { testo: string }[]

  console.log(`${primi.length} primi messaggi auto-contenuti da rigiocare, x2 configurazioni\n`)
  let uguali = 0
  const divergenze: string[] = []
  let tokOggi = 0, tokDiff = 0

  for (const p of primi) {
    try {
      const a = await tooliChiamati(p.testo, OGGI)
      const b = await tooliChiamati(p.testo, DIFFERITO, true)
      tokOggi += a.tok; tokDiff += b.tok
      const stesso = JSON.stringify(a.chiamati) === JSON.stringify(b.chiamati)
      if (stesso) uguali++
      else divergenze.push(`«${p.testo.slice(0, 70)}»\n     oggi: [${a.chiamati.join(', ') || '-'}]\n     diff: [${b.chiamati.join(', ') || '-'}]  (ricerche: ${b.cercati}, trovati: ${b.trovati.join(',') || '-'})`)
      console.log(`${stesso ? 'uguale ' : 'DIVERGE'} | ${p.testo.slice(0, 60).replace(/\s+/g, ' ')}`)
    } catch (e) {
      divergenze.push(`ERRORE su «${p.testo.slice(0, 60)}»: ${String(e).slice(0, 140)}`)
      console.log(`ERRORE  | ${p.testo.slice(0, 60).replace(/\s+/g, ' ')}`)
    }
  }

  console.log(`\n--- ESITO ---`)
  console.log(`stesso insieme di tool: ${uguali}/${primi.length}`)
  console.log(`token in ingresso totali: oggi ${tokOggi} | differito ${tokDiff} | ${Math.round((1 - tokDiff / tokOggi) * 100)}% in meno`)
  if (divergenze.length) {
    console.log(`\n--- LE ${divergenze.length} DIVERGENZE, DA GUARDARE UNA PER UNA ---`)
    divergenze.forEach((d, i) => console.log(`\n${i + 1}. ${d}`))
  }
}
main()
