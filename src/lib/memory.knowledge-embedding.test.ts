/**
 * src/lib/memory.knowledge-embedding.test.ts
 *
 * La conoscenza dei file (`saveFileKnowledge`) non ha una riga in `messages`:
 * il vincolo del database ammette SOLO `user` e `assistant`.
 *
 *   messages_role_check  CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text]))
 *
 * Quelle insert sono sempre state rifiutate — in produzione `messages` contiene
 * zero righe `knowledge` — e finora era innocuo, perche' l'embedding si
 * generava lo stesso: in `embeddings` ce ne sono 909, l'ultimo del 3 set 2026.
 *
 * L'8 set 2026 il commit `7af006b` ha subordinato l'embedding all'esito della
 * riga (`if (salvato) await saveEmbeddingOnly(...)`). Da li' la conoscenza dei
 * file non viene piu' indicizzata, in silenzio: `supabase-js` non lancia, e
 * `saveMessageOnly` si limita a un `logWarn`.
 *
 * ⭐ Il mock qui sotto fa rispettare il vincolo VERO. Un mock che accetta
 * qualunque ruolo direbbe verde su un codice rotto: e' la differenza fra
 * misurare e guardare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserts: Record<string, unknown[]> = { messages: [], embeddings: [] }

/** I ruoli che il database accetta davvero in `messages`. */
const RUOLI_AMMESSI = ['user', 'assistant']

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  b.insert = vi.fn((row: Record<string, unknown>) => {
    if (table === 'messages' && !RUOLI_AMMESSI.includes(row.role as string)) {
      // Postgres NON lancia attraverso supabase-js: l'errore torna in `.error`.
      return Promise.resolve({
        data: null,
        error: {
          code: '23514',
          message:
            'new row for relation "messages" violates check constraint "messages_role_check"',
        },
      })
    }
    if (!inserts[table]) inserts[table] = []
    inserts[table].push(row)
    return Promise.resolve({ data: null, error: null })
  })
  b.select = vi.fn(() => b)
  b.eq = vi.fn(() => b)
  b.order = vi.fn(() => b)
  b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
  b.ilike = vi.fn(() => b)
  b.or = vi.fn(() => b)
  return b
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))

vi.mock('./embeddings', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}))

vi.mock('./telegram', () => ({ sendTelegramMessage: vi.fn() }))

import { saveFileKnowledge, saveMessageWithEmbedding } from './memory'

const CONTENUTO_FILE =
  'Capitolato speciale d appalto, articolo 12: la contabilita dei lavori e ' +
  'redatta per stati di avanzamento non inferiori al 20 per cento dell importo ' +
  'contrattuale, e ogni SAL e sottoscritto dal direttore dei lavori.'

describe('la conoscenza dei file finisce negli embedding anche senza riga in messages', () => {
  beforeEach(() => {
    inserts.messages = []
    inserts.embeddings = []
    vi.clearAllMocks()
  })

  it('saveFileKnowledge genera l embedding benche il database rifiuti role=knowledge', async () => {
    await saveFileKnowledge('conv-1', CONTENUTO_FILE, 'capitolato.pdf')

    // Il vincolo del database resta quello che e': la riga non entra.
    expect(inserts.messages).toHaveLength(0)

    // Ma la conoscenza deve essere comunque cercabile, altrimenti caricare un
    // file non serve a niente e nessuno se ne accorge.
    expect(inserts.embeddings).toHaveLength(1)
    expect(inserts.embeddings[0]).toMatchObject({ message_role: 'knowledge' })
    expect((inserts.embeddings[0] as { content: string }).content).toContain(
      '[File: capitolato.pdf]',
    )
  })

  it('saveMessageWithEmbedding con role=knowledge scrive il solo embedding, da QUALUNQUE canale', async () => {
    // La regola sta in un posto solo, perche' i due canali ci arrivano da due
    // punti diversi — `api/chat/route.ts` (web) e `agent-job.ts` (Telegram) —
    // e una regola scritta due volte e' una regola che prima o poi diverge.
    await saveMessageWithEmbedding('conv-1', 'knowledge', CONTENUTO_FILE)

    expect(inserts.messages).toHaveLength(0)
    expect(inserts.embeddings).toHaveLength(1)
    expect(inserts.embeddings[0]).toMatchObject({ message_role: 'knowledge' })
  })

  it('CONTROLLO POSITIVO: il mock sa davvero rifiutare, e per un ruolo ammesso la riga entra', async () => {
    // Senza questo, il test sopra passerebbe anche con un mock che non rifiuta
    // niente e con un codice che non scrive mai in `messages`.
    await saveMessageWithEmbedding('conv-1', 'assistant', CONTENUTO_FILE)

    expect(inserts.messages).toHaveLength(1)
    expect(inserts.messages[0]).toMatchObject({ role: 'assistant' })
    expect(inserts.embeddings).toHaveLength(1)
  })

  it('una risposta rifiutata dal database NON diventa memoria semantica', async () => {
    // Il rovescio della medaglia, che va tenuto fermo: per `user`/`assistant`
    // l'embedding resta subordinato alla riga. Se la riga non entra, la
    // risposta e' persa e un embedding senza messaggio sarebbe recuperabile da
    // `searchMemory` senza niente a cui appartenere.
    await saveMessageWithEmbedding('conv-1', 'ruolo-inesistente', CONTENUTO_FILE)

    expect(inserts.messages).toHaveLength(0)
    expect(inserts.embeddings).toHaveLength(0)
  })
})
