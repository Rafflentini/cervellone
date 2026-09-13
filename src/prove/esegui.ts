/**
 * src/prove/esegui.ts — l'esecutore dei casi che richiedono il modello.
 *
 *   npx tsx --env-file=.env.local src/prove/esegui.ts --conferma
 *   npx tsx --env-file=.env.local src/prove/esegui.ts --conferma --modelli claude-opus-5,claude-sonnet-5
 *   npx tsx --env-file=.env.local src/prove/esegui.ts --conferma --caso modalita-pagamento-scritta-dal-fornitore
 *
 * ## ⚠️ Cosa questo esecutore PROVA, e cosa NON prova
 *
 * **Non riproduce una conversazione intera.** Per farlo servirebbero le
 * credenziali di Fatture in Cloud e di Google, che in locale non ci sono (sono
 * *Sensitive* su Vercel e tornano vuote), e servirebbe eseguire davvero le
 * scritture — cioe' toccare un gestionale fiscale per fare una prova. Non si fa.
 *
 * **Giudica il GIUDIZIO, con le carte vere in mano.** Dato il prompt vero,
 * l'elenco vero degli strumenti e i **risultati veri** che quei tool
 * restituirono quel giorno (`risposte_tool` nel caso), il modello gioca alcune
 * mani e alla fine dice qualcosa. E' quel qualcosa che viene giudicato.
 *
 * ⚠️ **La prima versione giudicava solo la PRIMA MOSSA, ed era troppo poco.**
 * Eseguita, ha dato «incerto» su entrambi i modelli: la prima mossa era
 * `richiama_memoria`, ragionevole e innocua. Ma il difetto del 12 settembre
 * 2026 **non stava alla prima mossa**: stava alla terza, quando il bot aveva in
 * mano `payment_account: null` e ne ha concluso «sulla fattura non c'e' scritta
 * nessuna modalita'». Una prova che si ferma prima del punto in cui il difetto
 * nasce non prova niente — e dava pure l'impressione di aver provato qualcosa.
 *
 * Quello che questo esecutore NON puo' dire: se poi porta a termine il lavoro
 * fino in fondo, con gli integratori veri. Quello lo dicono i casi
 * `deterministico`, che girano nella suite, e l'uso vero.
 *
 * ## Il giudizio
 *
 * Il verdetto lo da' un secondo modello, **con i criteri espliciti** `deve` e
 * `non_deve` del caso, e gli si impone di **citare l'evidenza**: un giudice che
 * dice «sembra corretto» senza citare non ha giudicato. Il giudice gira sempre
 * sul modello piu' forte, perche' giudicare e' il compito difficile.
 *
 * ## Il costo
 *
 * 5 casi x N modelli x 2 chiamate. Con 3 modelli: 30 chiamate, fra i 10 e i 40
 * dollari. **Si esegue quando serve decidere qualcosa**, non per abitudine: per
 * questo c'e' `--conferma`, e senza quello non parte.
 */
import Anthropic from '@anthropic-ai/sdk'
import { CASI_REALI, type CasoReale } from './casi-reali'
import { getToolDefinitions } from '../lib/tools'
import { NUCLEO_TOOL } from '../lib/tool-nucleo'
import { interruttoreAcceso } from '../lib/interruttori'
import { getTelegramSystemPrompt } from '../lib/prompts'

const client = new Anthropic()

/** Il modello che giudica. Il compito difficile va al modello migliore. */
const GIUDICE = 'claude-opus-5'

const MODELLI_DEFAULT = ['claude-opus-5', 'claude-sonnet-5']

interface Esito {
  caso: string
  modello: string
  conclusione: string
  tool_chiamati: string[]
  verdetto: 'passa' | 'fallisce' | 'incerto'
  perche: string
  token: number
  costo_stimato: number
}

function argomento(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * Il modello gioca fino a `giri_max` mani, con in mano le **carte vere** di
 * quel giorno.
 *
 * ⚠️ La prima versione giudicava solo la prima mossa, ed eseguita ha dato
 * «incerto» su entrambi i modelli: la prima mossa era `richiama_memoria`,
 * innocua. Il difetto del 12 set 2026 stava alla TERZA, con il risultato del
 * tool in mano. Una prova che si ferma prima del punto in cui il difetto nasce
 * non prova niente — e dava pure l'impressione di aver provato qualcosa.
 */
async function giocaLeMani(caso: CasoReale, modello: string, system: string, tools: unknown[]) {
  const giriMax = caso.giri_max ?? 1
  const messaggi: Anthropic.MessageParam[] = [{ role: 'user', content: caso.domanda }]
  const toolChiamati: string[] = []
  let token = 0
  let testo = ''

  for (let giro = 0; giro < giriMax; giro++) {
    const r = await client.messages.create({
      model: modello,
      max_tokens: 1500,
      system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      messages: messaggi,
    })
    token += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0)

    const testoGiro = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (testoGiro) testo = testoGiro

    const chiamate = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (chiamate.length === 0) break // ha finito: quello che ha detto e' il verdetto

    messaggi.push({ role: 'assistant', content: r.content })
    messaggi.push({
      role: 'user',
      content: chiamate.map((c) => {
        toolChiamati.push(c.name)
        const vera = caso.risposte_tool?.[c.name]
        return {
          type: 'tool_result' as const,
          tool_use_id: c.id,
          // ⚠️ Un tool senza risposta registrata DICHIARA di essere un
          // segnaposto. Mai un finto successo: un segnaposto scambiato per un
          // dato e' il difetto che stiamo misurando, e ricrearlo qui
          // renderebbe cieco il misuratore proprio dove deve vedere.
          content:
            vera ??
            JSON.stringify({
              ok: false,
              error:
                `[PROVA] Nessuna risposta registrata per ${c.name} in questo caso. ` +
                `Non e' un risultato vero: non dedurne niente.`,
            }),
        }
      }),
    })
  }

  return { testo, toolChiamati, token }
}

/** Il verdetto, con l'obbligo di citare. */
async function giudica(caso: CasoReale, mossa: { testo: string; toolChiamati: string[] }) {
  const prompt = [
    'Sei un giudice severo. Devi dire se la CONCLUSIONE di un assistente e\' corretta,',
    'dati i criteri espliciti qui sotto. Non sei gentile: un verdetto sbagliato costa',
    'piu\' di un verdetto duro.',
    '',
    `## La domanda dell'utente (parole vere, ${caso.quando})`,
    caso.domanda,
    '',
    '## Contesto',
    caso.contesto,
    '',
    '## Cosa era VERO (noto oggi, ignoto allora)',
    caso.cosa_era_vero,
    '',
    '## La risposta corretta DEVE:',
    ...caso.deve.map((d) => `- ${d}`),
    '',
    '## La risposta corretta NON DEVE:',
    ...caso.non_deve.map((d) => `- ${d}`),
    '',
    '## Cosa ha fatto il modello sotto esame (alcune mani, con i risultati veri dei tool)',
    `Strumenti chiamati: ${mossa.toolChiamati.length ? mossa.toolChiamati.join(', ') : 'NESSUNO'}`,
    'Testo prodotto:',
    mossa.testo || '(nessun testo)',
    '',
    '## Il tuo verdetto',
    'Rispondi ESATTAMENTE in questa forma, su due righe:',
    'VERDETTO: passa | fallisce | incerto',
    'PERCHE: una frase, che CITA cosa nel testo o negli strumenti ti ha portato al verdetto.',
    '',
    'Regole del verdetto:',
    '- "passa" solo se soddisfa i DEVE e non viola nessun NON DEVE.',
    '- "fallisce" se viola anche un solo NON DEVE. Un divieto violato non si compensa.',
    '- "incerto" se quello che ha detto non basta a decidere (per esempio: ha chiamato lo',
    '  strumento giusto ma non ha ancora detto niente). "incerto" e\' un verdetto onesto,',
    '  non una via di mezzo: usalo quando serve davvero.',
    '- Se citi qualcosa, citalo VERBATIM. Un giudizio senza citazione non vale.',
  ].join('\n')

  const r = await client.messages.create({
    model: GIUDICE,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  })
  const testo = r.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  const v = /VERDETTO:\s*(passa|fallisce|incerto)/i.exec(testo)?.[1]?.toLowerCase()
  // ⚠️ `PERCHE` con l'accento, senza, o con i due punti: alla prima esecuzione
  // il verdetto di Opus e' arrivato con la motivazione VUOTA perche' il giudice
  // aveva scritto «PERCHÉ:» e il pattern cercava solo «PERCHE». Un misuratore
  // che perde la motivazione restituisce un verdetto senza il perche' — cioe'
  // esattamente il difetto che va a caccia.
  const grezzo =
    /PERCH[EÉÈ]:?\s*([\s\S]+)/i.exec(testo)?.[1]?.trim() ??
    testo.replace(/VERDETTO:.*$/im, '').trim()
  const p = grezzo.split('\n').filter(Boolean)[0] ?? testo.slice(0, 200)
  return {
    verdetto: (v === 'passa' || v === 'fallisce' ? v : 'incerto') as Esito['verdetto'],
    perche: p,
    token: r.usage.input_tokens,
  }
}

async function main() {
  if (!process.argv.includes('--conferma')) {
    console.log('')
    console.log('Questo esecutore fa chiamate VERE al modello e costa denaro.')
    console.log('Stima: 5 casi x N modelli x 2 chiamate. Con 2 modelli, circa 10-25 dollari.')
    console.log('')
    console.log('  npx tsx --env-file=.env.local src/prove/esegui.ts --conferma')
    console.log('')
    process.exit(1)
  }

  const modelli = (argomento('modelli') ?? MODELLI_DEFAULT.join(',')).split(',').map((m) => m.trim())
  /**
   * ⚠️ **Perché le ripetizioni non sono un lusso.**
   *
   * Le prime due esecuzioni di questo esecutore, stesso caso e stessi modelli,
   * hanno dato risultati OPPOSTI: Opus «incerto» poi «fallisce», Sonnet
   * «fallisce» poi «passa». Stavo per concludere che un modello si comportasse
   * meglio dell'altro — da **un** campione.
   *
   * Il comportamento di un modello e' stocastico: una singola esecuzione non e'
   * una misura, e' un aneddoto con l'aria di un dato. Un insieme di prove che
   * gira una volta sola produce rumore che sembra segnale, ed e' peggio di non
   * averlo — perche' ci si decide sopra.
   */
  const ripetizioni = Math.max(1, Number(argomento('ripetizioni') ?? 3))
  const soloCaso = argomento('caso')
  const casi = CASI_REALI.filter(
    (c) => c.livello === 'richiede_modello' && (!soloCaso || c.id === soloCaso),
  )

  if (casi.length === 0) {
    console.error('Nessun caso da eseguire.')
    process.exit(1)
  }

  console.log('')
  console.log(
    `Casi: ${casi.length} · Modelli: ${modelli.join(', ')} · Ripetizioni: ${ripetizioni} · Giudice: ${GIUDICE}`,
  )
  console.log('  legenda:  + passa   X fallisce   ? incerto   ! errore')
  console.log('')

  const esiti: Esito[] = []
  for (const caso of casi) {
    // Il prompt e gli strumenti sono quelli VERI: se cambiano, cambia la prova.
    const system = await getTelegramSystemPrompt(caso.domanda, [])
    const tools = getToolDefinitions(
      interruttoreAcceso('TOOL_DEFER') ? { nucleo: NUCLEO_TOOL, ricerca: true } : undefined,
    )

    for (const modello of modelli) {
      process.stdout.write(`  ${caso.id.padEnd(42)} ${modello.padEnd(20)} `)
      for (let i = 0; i < ripetizioni; i++) {
        try {
          const mossa = await giocaLeMani(caso, modello, system, tools)
          const g = await giudica(caso, mossa)
          esiti.push({
            caso: caso.id,
            modello,
            conclusione: (mossa.testo || '(solo strumenti)').slice(0, 160).replace(/\n/g, ' '),
            tool_chiamati: mossa.toolChiamati,
            verdetto: g.verdetto,
            perche: g.perche,
            token: mossa.token,
            costo_stimato: 0,
          })
          process.stdout.write(
            g.verdetto === 'passa' ? '+' : g.verdetto === 'fallisce' ? 'X' : '?',
          )
        } catch (e) {
          process.stdout.write('!')
          if (process.env.PROVE_VERBOSE) console.error(e instanceof Error ? e.message : e)
        }
      }
      console.log('')
    }
  }

  console.log('')
  console.log('═══ ESITO ═══')
  console.log('')
  for (const m of modelli) {
    const suoi = esiti.filter((e) => e.modello === m)
    const passa = suoi.filter((e) => e.verdetto === 'passa').length
    const fallisce = suoi.filter((e) => e.verdetto === 'fallisce').length
    const incerti = suoi.filter((e) => e.verdetto === 'incerto').length
    const tasso = suoi.length ? Math.round((passa / suoi.length) * 100) : 0
    console.log(
      `${m.padEnd(22)} passa ${passa}/${suoi.length} (${tasso}%) · fallisce ${fallisce} · incerti ${incerti} · ` +
        `token medi ${Math.round(suoi.reduce((n, e) => n + e.token, 0) / Math.max(suoi.length, 1)).toLocaleString('it')}`,
    )
  }

  // ⚠️ Il verdetto che conta e' la STABILITA', non il singolo esito: un caso
  // che a volte passa e a volte no e' un difetto che aspetta il giorno storto.
  console.log('')
  console.log('═══ STABILITA PER CASO ═══')
  for (const caso of casi) {
    for (const m of modelli) {
      const suoi = esiti.filter((e) => e.caso === caso.id && e.modello === m)
      if (suoi.length < 2) continue
      const distinti = new Set(suoi.map((e) => e.verdetto))
      if (distinti.size > 1) {
        console.log(
          `  ⚠️ INSTABILE  ${caso.id} · ${m} → ${suoi.map((e) => e.verdetto).join(', ')}`,
        )
      } else {
        console.log(`  stabile      ${caso.id} · ${m} → ${[...distinti][0]}`)
      }
    }
  }

  console.log('')
  console.log('═══ CASO PER CASO ═══')
  for (const e of esiti) {
    console.log('')
    console.log(`${e.caso} · ${e.modello} → ${e.verdetto.toUpperCase()}`)
    console.log(`  strumenti: ${e.tool_chiamati.length ? e.tool_chiamati.join(', ') : 'NESSUNO'}`)
    console.log(`  perche:    ${e.perche}`)
    console.log(`  ha detto:  ${e.conclusione}`)
  }
  console.log('')
  console.log('⚠️ Questo misura il GIUDIZIO con le carte vere in mano, non se porta a termine il lavoro.')
  console.log('')
}

main().catch((e) => {
  console.error('ESECUZIONE FALLITA:', e instanceof Error ? e.message : e)
  process.exit(1)
})
