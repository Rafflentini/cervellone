/**
 * CENSIMENTO DELLE CAPACITA'. Per ognuno dei tool differiti chiede al modello
 * di fare quello che il tool dichiara di saper fare, e verifica che il tool
 * VENGA RAGGIUNTO — chiamato, oppure restituito dalla ricerca.
 *
 * Limite dichiarato: la richiesta e' derivata dalla descrizione del tool, quindi
 * la prova e' in parte circolare. Non dimostra che l'Ingegnere si farebbe capire;
 * dimostra che il tool e' RAGGIUNGIBILE. E' il minimo, non il massimo.
 *
 * Run: npx tsx --env-file=.env.local scripts/censimento-tool.ts
 */
import Anthropic from '@anthropic-ai/sdk'
import { getToolDefinitions } from '../src/lib/tools'
import { NUCLEO_TOOL } from '../src/lib/tool-nucleo'

const MODEL = 'claude-sonnet-4-6'
const client = new Anthropic()
const definizioni = getToolDefinitions({ nucleo: NUCLEO_TOOL, ricerca: true }) as {
  name: string; description?: string; defer_loading?: boolean
}[]
const daProvare = definizioni.filter((d) => d.defer_loading)

async function raggiungibile(nome: string, descrizione: string) {
  const compito = descrizione.split(/[.\n]/)[0].slice(0, 200)
  const r = await client.messages.create({
    model: MODEL, max_tokens: 400, tools: definizioni as never,
    system: 'Sei il coordinatore digitale di Restruktura. Hai a disposizione degli strumenti; se non li vedi, cercali. Esegui il compito senza fare domande.',
    messages: [{ role: 'user', content: `Compito: ${compito}` }],
  })
  const chiamati = (r.content as { type: string; name?: string }[])
    .filter((b) => b.type === 'tool_use').map((b) => b.name)
  const trovati = (r.content as { type: string; content?: { tool_references?: { tool_name: string }[] } }[])
    .flatMap((b) => (b.type === 'tool_search_tool_result' ? (b.content?.tool_references ?? []) : []))
    .map((x) => x.tool_name)
  return { chiamato: chiamati.includes(nome), trovato: trovati.includes(nome), chiamati, trovati }
}

async function main() {
  console.log(`censimento di ${daProvare.length} tool differiti su ${definizioni.length} totali\n`)
  const persi: string[] = []
  let chiamati = 0, soloTrovati = 0
  for (const d of daProvare) {
    try {
      const e = await raggiungibile(d.name, d.description ?? d.name)
      const esito = e.chiamato ? 'CHIAMATO' : e.trovato ? 'trovato' : '🚨 NON RAGGIUNTO'
      if (e.chiamato) chiamati++
      else if (e.trovato) soloTrovati++
      else persi.push(d.name)
      console.log(`${esito.padEnd(16)} ${d.name}`)
    } catch (err) {
      persi.push(d.name)
      console.log(`ERRORE          ${d.name}: ${String(err).slice(0, 120)}`)
    }
  }
  console.log(`\nchiamati: ${chiamati} | solo trovati: ${soloTrovati} | NON RAGGIUNTI: ${persi.length}`)
  if (persi.length) console.log('🚨 ' + persi.join(', '))
  process.exitCode = persi.length ? 1 : 0
}
main()
