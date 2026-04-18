import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const DIGEST_PROMPT = `Sei un sistema di analisi documentale per una società di ingegneria.

Il tuo compito è STUDIARE a fondo il documento e produrre un DIGEST della conoscenza contenuta.

## Istruzioni

1. LEGGI tutto il contenuto, parola per parola
2. COMPRENDI ogni concetto, dato, norma, procedura, decisione, scadenza
3. CLASSIFICA il documento: va DIGERITO o va CONSERVATO INTATTO?
4. PRODUCI un digest chiaro con TUTTE le informazioni rilevanti

## Classificazione: DIGERIRE o CONSERVARE?

Rispondi con una riga iniziale:

CLASSIFICAZIONE: DIGERIRE
oppure
CLASSIFICAZIONE: CONSERVARE — [motivo]

Un documento va CONSERVATO INTATTO se è:
- Un MODULO UFFICIALE da compilare (allegati di bandi, modelli ministeriali, istanze)
- Un DOCUMENTO con carta intestata di un ente che andrà firmato/protocollato
- Un TEMPLATE che deve mantenere la sua forma esatta per essere valido
- Un ALLEGATO OBBLIGATORIO di un bando/procedura che va presentato così com'è
- Un FORMULARIO con campi da riempire
- Un documento legale/contrattuale che non può essere riformulato

Se classifichi come CONSERVARE, produci comunque un breve digest del contenuto.

## Come scrivere il digest

Organizza le informazioni nel modo PIÙ NATURALE per questo specifico tipo di documento. Non forzare sezioni che non servono.

Ad esempio:
- Un bando avrà scadenze, requisiti, importi, documenti richiesti
- Una relazione tecnica avrà dati tecnici, calcoli, parametri, conclusioni
- Un preventivo avrà voci, importi, condizioni
- Un verbale avrà decisioni, presenti, azioni da fare
- Una normativa avrà articoli, obblighi, sanzioni

Usa titoli ### per organizzare le sezioni. Scegli tu quali servono.

## Regole
- NON omettere NESSUN dato concreto (numeri, date, nomi, codici, importi)
- NON riassumere troppo — meglio essere prolisso che perdere informazioni
- Se il documento contiene tabelle, riproduci i dati
- Se cita norme, riporta l'esatto riferimento (legge, articolo, comma)
- Ogni informazione deve essere nel digest: se non è nel digest, è persa per sempre
- Scrivi in italiano`

export type DigestResult = {
  digest: string
  shouldPreserve: boolean
  preserveReason: string
}

// Digerisce un documento e produce un digest strutturato
export async function digestDocument(content: string, fileName: string): Promise<DigestResult> {
  const { getConfig } = await import('./claude')
  const cfg = await getConfig()
  const digestModel = cfg.model_digest || 'claude-sonnet-4-6'

  const message = await client.messages.create({
    model: digestModel,
    max_tokens: 12000,
    system: DIGEST_PROMPT,
    messages: [{
      role: 'user',
      content: `Studia e digerisci questo documento.\n\nNome file: ${fileName}\n\n---\n\n${content}`
    }],
  })

  const digest = message.content[0].type === 'text' ? message.content[0].text : ''

  // Controlla se il file va conservato
  const shouldPreserve = digest.includes('CLASSIFICAZIONE: CONSERVARE')
  let preserveReason = ''
  if (shouldPreserve) {
    const match = digest.match(/CLASSIFICAZIONE: CONSERVARE\s*—?\s*(.*)/)
    preserveReason = match ? match[1].trim() : 'Documento da conservare intatto'
  }

  // Verifica di comprensione — solo se il documento è abbastanza lungo da giustificarla
  if (content.length > 3000 && !shouldPreserve) {
    const check = await client.messages.create({
      model: digestModel,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `Ecco un documento originale e il suo digest. Verifica che il digest contenga TUTTE le informazioni importanti. Se manca qualcosa, aggiungilo.

DOCUMENTO ORIGINALE:
${content.slice(0, 30000)}

DIGEST PRODOTTO:
${digest}

Rispondi SOLO con le eventuali integrazioni in formato:
### INTEGRAZIONI
[informazioni mancanti]

Se il digest è completo, rispondi: COMPLETO`
        }
      ],
    })

    const checkResult = check.content[0].type === 'text' ? check.content[0].text : ''

    if (checkResult.trim() !== 'COMPLETO') {
      return { digest: digest + '\n\n' + checkResult, shouldPreserve, preserveReason }
    }
  }

  return { digest, shouldPreserve, preserveReason }
}

// Spezza il digest in chunk per gli embeddings
// Chunk più grandi = contesto più coerente per ogni embedding
export function chunkDigest(digest: string, maxChars: number = 3000): string[] {
  const sections = digest.split(/(?=### )/)
  const chunks: string[] = []

  for (const section of sections) {
    if (section.trim().length === 0) continue
    if (section.length <= maxChars) {
      chunks.push(section.trim())
    } else {
      // Spezza sezioni lunghe per paragrafi
      const paragraphs = section.split('\n\n')
      let current = ''
      for (const p of paragraphs) {
        if ((current + '\n\n' + p).length > maxChars && current.length > 0) {
          chunks.push(current.trim())
          current = p
        } else {
          current = current ? current + '\n\n' + p : p
        }
      }
      if (current.trim()) chunks.push(current.trim())
    }
  }

  return chunks
}
