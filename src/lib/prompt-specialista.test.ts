/**
 * src/lib/prompt-specialista.test.ts — il prompt di uno specialista.
 *
 * ⚠️ **La guardia che conta di più qui non è sul testo: è sulla PROVENIENZA.**
 *
 * Il blocco «principio fondamentale» è la regola che dice al bot di non
 * fermarsi davanti a un attrezzo che manca e — soprattutto — di **non
 * dichiarare assente un dato che non ha guardato**. È la regola nata dalla
 * fattura 2/1144, quella con «MP01 Contanti» scritto sopra, dichiarata vuota
 * per tre ore.
 *
 * Uno specialista ne ha bisogno **più** del coordinatore, perché ha meno
 * attrezzi e quindi più occasioni di arrendersi. Se quel blocco fosse una
 * COPIA, fra sei mesi il coordinatore avrebbe la versione aggiornata e la
 * contabile quella vecchia — e nessuno se ne accorgerebbe. I test qui sotto
 * provano che è lo stesso testo, non un testo uguale.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      b.order = vi.fn(() => b)
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
      b.insert = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }))
      return b
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))
vi.mock('./skills', () => ({ matchSkills: vi.fn().mockResolvedValue('') }))

import { getPromptSpecialista, principioFondamentale, getChatSystemPrompt } from './prompts'

const contabile = {
  nome: 'la contabile',
  quando: 'fatture, pagamenti, prima nota',
  toolDisponibili: ['fic_fatture_ricevute', 'fic_leggi_allegato_fattura'],
}

describe('⭐ il principio fondamentale e lo STESSO del coordinatore, non una copia', () => {
  it('il blocco estratto compare, identico, nel prompt vivo della chat', async () => {
    const blocco = principioFondamentale()
    expect(blocco.length).toBeGreaterThan(200)
    const promptVivo = await getChatSystemPrompt('ciao')
    // `toContain` sul testo INTERO del blocco: se qualcuno modificasse la
    // regola in un posto solo, questo morirebbe.
    expect(promptVivo).toContain(blocco)
  })

  it('e compare, lo stesso blocco, nel prompt dello specialista', () => {
    expect(getPromptSpecialista(contabile)).toContain(principioFondamentale())
  })

  it("la regola del 12 set 2026 c'e': «non c'e'» e «non l'ho letto» sono due cose diverse", () => {
    // E' la frase nata dalla fattura 2/1144, quella con «MP01 Contanti» scritto
    // sopra, dichiarata vuota per tre ore. Uno specialista senza questa regola
    // rifarebbe lo stesso errore piu' in fretta.
    const p = getPromptSpecialista(contabile)
    expect(p).toContain('NON DICHIARARE ASSENTE un dato che non hai GUARDATO')
    expect(p).toMatch(/MP01 Contanti/)
  })

  it('CONTROLLO POSITIVO — senza i marcatori si restituisce VUOTO, non mezza regola', () => {
    // Un principio troncato a meta' frase sarebbe peggio di nessun principio:
    // il modello leggerebbe «non dichiarare assente un dato che non hai» e si
    // fermerebbe li'. La funzione preferisce tacere.
    const blocco = principioFondamentale()
    expect(blocco.startsWith('=== IL PRINCIPIO FONDAMENTALE ===')).toBe(true)
    expect(blocco).not.toContain('=== fine principio fondamentale ===')
  })
})

describe('le tre cose che uno specialista deve sapere e il coordinatore no', () => {
  it('1. non parla all Ingegnere: la risposta la legge il coordinatore', () => {
    const p = getPromptSpecialista(contabile)
    expect(p).toMatch(/NON stai parlando con l'Ingegnere/)
    expect(p).toMatch(/COORDINATORE/)
  })

  it('2. PREPARA e non esegue: e gli si dice che e VOLUTO', () => {
    // La differenza fra «non puoi» e «non e' compito tuo» e' quella fra uno
    // specialista che si blocca e uno che prepara e lo dice. Il principio
    // fondamentale vale anche per lui.
    const p = getPromptSpecialista(contabile)
    expect(p).toMatch(/PREPARI, non esegui/)
    expect(p).toMatch(/e' VOLUTO/)
    expect(p).toMatch(/preparala e DILLO/)
  })

  it('3. se non ce la fa deve dire COSA HA PROVATO', () => {
    const p = getPromptSpecialista(contabile)
    expect(p).toMatch(/COSA HAI PROVATO/)
    expect(p).toMatch(/lascia il coordinatore al buio/)
  })

  it("gli attrezzi sono elencati per nome, e gli si dice di non cercarne altri", () => {
    // Allo specialista NON si dice «cercali con tool_search_tool_bm25»: non ne
    // ha altri e il tool non gli viene dichiarato. Dirglielo sarebbe la stessa
    // bugia gia' chiusa una volta sulla mappa dell'officina.
    const p = getPromptSpecialista(contabile)
    expect(p).toContain('fic_fatture_ricevute')
    expect(p).toContain('fic_leggi_allegato_fattura')
    expect(p).not.toContain('tool_search_tool_bm25')
    expect(p).toMatch(/non c'e' niente da cercare/)
  })

  it("⭐ un attrezzo mancante e' di un ALTRO, non un limite: e glielo si dice", () => {
    // Il principio fondamentale, tradotto per uno specialista. Senza questa
    // riga la contabile a cui serve una mail risponderebbe «non posso» — che e'
    // la frase che questo progetto combatte da mesi.
    const p = getPromptSpecialista(contabile)
    expect(p).toMatch(/NON e' un tuo limite/)
    expect(p).toMatch(/quale pezzo manca e a chi serve/)
  })
})

describe('il prompt dello specialista e CORTO: non paga il pavimento del coordinatore', () => {
  it('sta sotto i 4.000 caratteri', async () => {
    // Il coordinatore parte da ~17.371 token di prompt. Uno specialista non ha
    // bisogno di sapere come si impagina un preventivo: sa il suo mestiere.
    // Se un giorno questo prompt si gonfiasse, il vantaggio della delega
    // sparirebbe in silenzio — e il costo lo si scoprirebbe dalla bolletta.
    const p = getPromptSpecialista(contabile)
    expect(p.length).toBeLessThan(4000)
  })

  it('CONTROLLO POSITIVO — quello del coordinatore e molte volte piu lungo', async () => {
    // Senza, il test sopra proverebbe solo che una stringa e' una stringa.
    const specialista = getPromptSpecialista(contabile)
    const coordinatore = await getChatSystemPrompt('ciao')
    expect(coordinatore.length).toBeGreaterThan(specialista.length * 5)
  })
})
