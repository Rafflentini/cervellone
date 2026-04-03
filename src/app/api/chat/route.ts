import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'
import { searchMemory, saveMessageWithEmbedding } from '@/lib/memory'
import { CUSTOM_TOOLS, executeTool } from '@/lib/tools'

const client = new Anthropic()

const SYSTEM_PROMPT = `Sei il Cervellone — l'assistente AI personale dell'Ing. Raffaele, titolare di Restruktura SRL.

Chi è Restruktura:
- Società di ingegneria: progettazione strutturale, direzione lavori, collaudi
- Impresa edile: ristrutturazioni, manutenzioni, cantieri
- PonteggioSicuro.it: noleggio ponteggi con servizio completo
- Sede operativa in Basilicata

Hai accesso a:
- Ricerca web in tempo reale
- Generazione documenti Word e Excel
- Un database di conoscenza che contiene documenti, analisi e conversazioni passate dell'Ingegnere. I dati rilevanti vengono caricati automaticamente qui sotto nella sezione "La tua memoria". Se contiene informazioni, USALE per rispondere.

Quando l'Ingegnere carica file nella chat:
- Analizzali, NON riscrivere il contenuto. Conferma brevemente cosa hai ricevuto e chiedi come aiutare.
- I file vengono salvati automaticamente nel database di conoscenza.

Se l'Ingegnere chiede informazioni che non trovi né nella sezione memoria né nella chat corrente, rispondi: "Non ho trovato queste informazioni. Potrebbe caricarle o darmi più contesto?"

Non menzionare MAI concetti come "MasterPrompt", "prompt di sistema", "sessione", "contesto tecnico del funzionamento". Non spiegare come funzioni internamente. Rispondi nel merito.

Dai del Lei all'Ingegnere. Rispondi in italiano.`

// Router automatico: Haiku classifica la complessità, sceglie il modello giusto
async function chooseModel(userQuery: string, hasFiles: boolean): Promise<{ model: string; thinking: number }> {
  // Se ci sono file allegati (PDF, immagini) → sempre Opus (analisi complessa)
  if (hasFiles) {
    return { model: 'claude-opus-4-6', thinking: 10000 }
  }

  // Domande molto brevi e semplici → Sonnet diretto (no classificazione)
  if (userQuery.length < 30 && !/calcol|analis|confront|scriv|genera|redigi|elabora/i.test(userQuery)) {
    return { model: 'claude-sonnet-4-6', thinking: 5000 }
  }

  // Per tutto il resto: chiedi a Haiku (velocissimo, ~0.1s, costa quasi niente)
  try {
    const classification = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: `Classifica questa richiesta. Rispondi SOLO con A o B.

A = semplice: saluti, domande brevi, informazioni generali, traduzioni, riassunti brevi
B = complessa: calcoli, analisi documenti, redazione documenti lunghi, ragionamento multi-step, confronti, normative, strategie, POS, computi, relazioni tecniche

Richiesta: "${userQuery.slice(0, 300)}"`,
      }],
    })

    const answer = classification.content[0].type === 'text' ? classification.content[0].text.trim() : 'B'

    if (answer === 'A') {
      console.log(`ROUTER: Sonnet (Haiku ha classificato come semplice)`)
      return { model: 'claude-sonnet-4-6', thinking: 5000 }
    }
  } catch {
    // Se Haiku fallisce, vai con Opus per sicurezza
  }

  console.log(`ROUTER: Opus (domanda complessa)`)
  return { model: 'claude-opus-4-6', thinking: 10000 }
}

// Auto-detect e importa skill/prompt strutturati in memoria
async function detectAndImportSkills(text: string, conversationId: string): Promise<string | null> {
  // Rileva pattern skill: "SKILL \d+" con separatori ════ o più sezioni strutturate
  const hasSkillPattern = /SKILL\s+\d+/i.test(text)
  const hasSeparators = (text.match(/[═]{4,}|[─]{4,}|[━]{4,}/g) || []).length >= 2
  const hasSections = (text.match(/^#{1,3}\s+.+/gm) || []).length >= 3

  if (!hasSkillPattern && !hasSeparators && !hasSections) return null
  if (text.length < 500) return null // Troppo corto per essere un prompt strutturato

  // Splitta per sezioni — prova prima con separatori ════, poi con ## heading
  let sections: { title: string; content: string }[] = []

  if (hasSeparators) {
    // Split per blocchi tra separatori
    const parts = text.split(/[═]{4,}|[─]{4,}|[━]{4,}/)
    let currentTitle = ''
    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      // Se è solo un titolo (corto, tipo "SKILL 1 – WORKFLOW PREVENTIVO")
      if (trimmed.length < 150 && /SKILL|REGOL|PRINCIPI|NOTE|FORMATO/i.test(trimmed)) {
        currentTitle = trimmed
      } else if (trimmed.length > 100) {
        const title = currentTitle || trimmed.split('\n')[0].slice(0, 80)
        sections.push({ title, content: currentTitle ? `${currentTitle}\n\n${trimmed}` : trimmed })
        currentTitle = ''
      }
    }
  }

  // Fallback: split per ## heading
  if (sections.length < 2 && hasSections) {
    const headingParts = text.split(/^(?=#{1,3}\s+)/m)
    sections = headingParts
      .filter(p => p.trim().length > 100)
      .map(p => {
        const firstLine = p.split('\n')[0].replace(/^#+\s*/, '').trim()
        return { title: firstLine.slice(0, 80), content: p.trim() }
      })
  }

  if (sections.length < 2) return null

  // Salva ogni sezione come knowledge separato
  const saved: string[] = []
  for (const section of sections) {
    const label = `[SKILL importata] ${section.title}`
    const fullContent = `${label}\n\n${section.content}`
    await saveMessageWithEmbedding(conversationId, 'knowledge', fullContent)
    saved.push(section.title)
    console.log(`SKILL IMPORT: salvata "${section.title}" (${section.content.length} chars)`)
  }

  return `Ho importato ${saved.length} skill in memoria:\n${saved.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nOra posso usarle in qualsiasi conversazione futura.`
}

export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const body = await request.json()
  const { messages: rawMessages, conversationId } = body

  // DEBUG: log cosa arriva dal frontend
  console.log('CHAT ricevuto:', rawMessages?.length, 'messaggi')
  for (const m of (rawMessages || [])) {
    if (Array.isArray(m?.content)) {
      const types = m.content.map((b: { type: string; source?: { data?: string } }) => {
        if (b.type === 'document' || b.type === 'image') {
          return `${b.type}(data: ${b.source?.data ? b.source.data.length + ' chars' : 'VUOTO'})`
        }
        return b.type
      })
      console.log(`  → ${m.role}: [${types.join(', ')}]`)
    } else {
      console.log(`  → ${m.role}: "${String(m?.content).slice(0, 80)}"`)
    }
  }

  // Filtra messaggi vuoti o malformati
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = (rawMessages as any[]).filter((m: any) => {
    if (!m || !m.role || !m.content) return false
    if (typeof m.content === 'string') return m.content.trim().length > 0
    if (Array.isArray(m.content)) {
      const validBlocks = m.content.filter((b: any) => {
        if (!b || !b.type) return false
        if (b.type === 'text') return b.text && b.text.trim().length > 0
        return true
      })
      if (validBlocks.length === 0) return false
      m.content = validBlocks
      return true
    }
    return false
  })

  if (messages.length === 0) {
    return new Response('Non ho ricevuto messaggi validi. Riprova.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // Assicura che il primo messaggio sia dell'utente
  if (messages[0]?.role !== 'user') {
    messages.unshift({ role: 'user', content: '(continua la conversazione)' })
  }

  // Safeguard context window — taglia i messaggi VECCHI, mai l'ultimo
  // L'ultimo messaggio (con eventuali file) va SEMPRE mandato
  const MAX_CONTEXT_CHARS = 500000
  if (messages.length > 1) {
    let totalChars = 0
    // Conta l'ultimo messaggio (sempre incluso)
    const lastMsg = messages[messages.length - 1]
    const lastMsgChars = typeof lastMsg.content === 'string' ? lastMsg.content.length
      : Array.isArray(lastMsg.content) ? JSON.stringify(lastMsg.content).length : 0
    totalChars = lastMsgChars

    // Poi aggiungi messaggi dal penultimo indietro finché c'è spazio
    let startIdx = messages.length - 1
    for (let i = messages.length - 2; i >= 0; i--) {
      const content = messages[i].content
      const msgChars = typeof content === 'string' ? content.length
        : Array.isArray(content) ? JSON.stringify(content).length : 0
      if (totalChars + msgChars > MAX_CONTEXT_CHARS) break
      totalChars += msgChars
      startIdx = i
    }
    if (startIdx > 0) {
      messages.splice(0, startIdx)
      if (messages[0]?.role !== 'user') {
        messages.unshift({ role: 'user', content: '(conversazione precedente omessa per lunghezza)' })
      }
    }
  }

  // Prendi l'ultimo messaggio dell'utente
  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'user')
  const userQuery = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : lastUserMsg?.content?.find((b: { type: string }) => b.type === 'text')?.text || ''

  // Controlla se ci sono file allegati nell'ultimo messaggio
  const hasFiles = Array.isArray(lastUserMsg?.content) &&
    lastUserMsg.content.some((b: { type: string }) => b.type === 'image' || b.type === 'document')

  // Auto-detect e importa skill strutturate in memoria
  let skillImportMessage: string | null = null
  if (conversationId && userQuery.length > 500) {
    skillImportMessage = await detectAndImportSkills(userQuery, conversationId)
  }

  // Router automatico: sceglie Sonnet o Opus in base alla complessità
  const { model: MODEL, thinking: THINKING_BUDGET } = await chooseModel(userQuery, hasFiles)

  const MAX_TOKENS = 16000

  // Cerca nella memoria
  const memoryContext = await searchMemory(userQuery)

  // Salva embedding utente in background
  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // Se sono state importate skill, aggiungi istruzione per Claude di confermare
  const skillNotice = skillImportMessage
    ? `\n\n# IMPORTAZIONE SKILL COMPLETATA\nL'utente ha incollato un prompt strutturato con skill professionali. Sono state salvate ${skillImportMessage.split('\n').length - 2} sezioni in memoria permanente. Nella tua risposta, CONFERMA all'utente che hai importato le skill e elenca i nomi. Poi chiedi come vuole procedere.`
    : ''
  const fullSystemPrompt = SYSTEM_PROMPT + skillNotice + memoryContext

  // Tools: ricerca web built-in + tool custom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    },
    ...CUSTOM_TOOLS,
  ]

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let currentMessages = [...messages] as any[]
        let maxIterations = 15

        while (maxIterations > 0) {
          maxIterations--

          // Configura la chiamata — thinking potrebbe non essere compatibile con documenti/immagini in alcune versioni
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const streamParams: any = {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: fullSystemPrompt,
            messages: currentMessages,
            tools,
          }

          // Abilita thinking solo se non ci sono file (per evitare incompatibilità API)
          if (!hasFiles) {
            streamParams.thinking = {
              type: 'enabled',
              budget_tokens: THINKING_BUDGET,
            }
          }

          const stream = client.messages.stream(streamParams)

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullResponse += event.delta.text
              controller.enqueue(encoder.encode(event.delta.text))
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (event.type === 'content_block_start' && (event as any).content_block?.type === 'server_tool_use') {
              const searchLabel = '\n\n🔍 *Cerco informazioni...*\n\n'
              fullResponse += searchLabel
              controller.enqueue(encoder.encode(searchLabel))
            }
          }

          const finalMessage = await stream.finalMessage()
          let hasCustomToolUse = false
          const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []

          for (const block of finalMessage.content) {
            if (block.type === 'tool_use') {
              hasCustomToolUse = true
              const actionLabel = `\n\n🌐 *Leggo: ${(block.input as { url?: string }).url}...*\n\n`
              fullResponse += actionLabel
              controller.enqueue(encoder.encode(actionLabel))

              console.log(`TOOL: ${block.name}`, block.input)
              const result = await executeTool(block.name, block.input as Record<string, string>)
              console.log(`TOOL risultato: ${result.slice(0, 200)}...`)

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              })
            }
          }

          if (!hasCustomToolUse || finalMessage.stop_reason === 'end_turn') {
            break
          }

          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: finalMessage.content },
            { role: 'user', content: toolResults },
          ]
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error('CHAT errore completo:', err)
        // Messaggi leggibili con suggerimenti operativi
        let userMsg = errMsg
        if (errMsg.includes('Could not process image') || errMsg.includes('invalid_image')) {
          userMsg = 'Uno dei file immagine non è leggibile.\n\n💡 Cosa fare:\n• Converti l\'immagine in PNG o JPG prima di caricarla\n• Se è uno screenshot, rifallo a risoluzione più bassa\n• Prova a caricare un file alla volta per capire quale dà problemi'
        } else if (errMsg.includes('document') && errMsg.includes('too large')) {
          userMsg = 'Il documento è troppo pesante per essere analizzato.\n\n💡 Cosa fare:\n• Comprimi il PDF (es. con iLovePDF o Smallpdf)\n• Carica il file come progetto ZIP — viene elaborato in background senza limiti di pagine\n• Dividi il PDF in parti più piccole'
        } else if (errMsg.includes('rate_limit') || errMsg.includes('overloaded')) {
          userMsg = 'Claude è momentaneamente sovraccarico.\n\n💡 Cosa fare:\n• Aspetta 10-15 secondi e riprova\n• Se hai allegato file, prova senza e caricali dopo'
        } else if (errMsg.includes('timeout') || errMsg.includes('TIMEOUT')) {
          userMsg = 'La richiesta ha impiegato troppo tempo.\n\n💡 Cosa fare:\n• Carica i file uno alla volta — ogni analisi viene salvata in memoria\n• Per documenti lunghi, usa la funzione "Carica progetto ZIP"\n• Prova a fare una domanda più specifica sul documento'
        } else if (errMsg.includes('invalid_request') || errMsg.includes('too many images')) {
          userMsg = 'Troppi file in una sola richiesta.\n\n💡 Cosa fare:\n• Carica 1-2 file alla volta — li ricorderò tutti grazie alla memoria\n• Per tanti file insieme, mettili in uno ZIP e usa "Carica progetto"'
        }
        controller.enqueue(encoder.encode(`\n\n⚠️ ${userMsg}`))
      } finally {
        controller.close()
        if (conversationId && fullResponse) {
          // Salva la risposta dell'assistente in memoria
          saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})

          // Se c'erano file nell'ultimo messaggio, salva anche il contenuto analizzato come conoscenza persistente
          if (hasFiles && fullResponse.length > 200) {
            const fileInfo = Array.isArray(lastUserMsg?.content)
              ? lastUserMsg.content
                .filter((b: { type: string }) => b.type === 'document' || b.type === 'image')
                .map((_: unknown, i: number) => `file_${i + 1}`)
                .join(', ')
              : 'file allegato'
            const knowledgeContent = `[Analisi di ${fileInfo} dalla chat]\n\nDomanda: ${userQuery}\n\nAnalisi:\n${fullResponse.slice(0, 10000)}`
            saveMessageWithEmbedding(conversationId, 'knowledge', knowledgeContent).catch(() => {})
            console.log('MEMORY: salvata analisi file in memoria persistente')
          }
        }
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  })
}
