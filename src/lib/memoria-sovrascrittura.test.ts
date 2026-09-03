/**
 * Le due regole che impediscono alla memoria di cancellare se stessa.
 * Trovate da un audit del 3 settembre 2026, dopo la ricostruzione a mano.
 */
import { describe, it, expect } from 'vitest'
import { puoSovrascrivereGiornataVuota, fondiEntita } from './memoria-sovrascrittura'

describe('puoSovrascrivereGiornataVuota — una rielaborazione a mani vuote non cancella la conoscenza', () => {
  it('RIFIUTA di sovrascrivere una giornata ricostruita i cui messaggi non ci sono piu', () => {
    // Il caso vero: 3 giugno 2026, 60 messaggi dichiarati, 0 righe rimaste in
    // `messages`. Rielaborandola si tornerebbe a "Nessuna attivita rilevante".
    const esistente = {
      summary_text: 'DISASTRO POS: il bot ha perso i documenti dell Ingegnere e li ha rigenerati a modo suo.',
      message_count: 60,
    }

    expect(puoSovrascrivereGiornataVuota(esistente)).toBe(false)
  })

  it('CONSENTE di scrivere una giornata mai vista', () => {
    // CONTROLLO POSITIVO: senza questo, una guardia che rifiuta SEMPRE
    // passerebbe il test qui sopra e bloccherebbe l estrazione notturna.
    expect(puoSovrascrivereGiornataVuota(null)).toBe(true)
  })

  it('CONSENTE di sovrascrivere una giornata davvero vuota', () => {
    expect(puoSovrascrivereGiornataVuota({ summary_text: 'Nessuna attività rilevante', message_count: 0 })).toBe(true)
  })

  it('CONSENTE di sovrascrivere il segnaposto anche se il conteggio dice che i messaggi c erano', () => {
    // E la riga che mentiva: 927 messaggi archiviati come "nessuna attivita".
    // Quella stringa non e conoscenza: riscriverla non perde niente.
    const bugia = { summary_text: 'Nessuna attività rilevante | Nessuna attività rilevante', message_count: 74 }

    expect(puoSovrascrivereGiornataVuota(bugia)).toBe(true)
  })

  it('CONSENTE di sovrascrivere un estrazione dichiarata fallita', () => {
    const fallita = { summary_text: '⚠️ Estrazione non riuscita: 40 messaggi, nessun riassunto prodotto.', message_count: 40 }

    expect(puoSovrascrivereGiornataVuota(fallita)).toBe(true)
  })

  it('RIFIUTA anche quando il riassunto vero e mescolato al segnaposto', () => {
    // Caso reale del 1 settembre: inizia con due segnaposto e poi ha contenuto.
    const misto = { summary_text: 'Nessuna attività rilevante | Recovery automatico del modello dopo 3 canary OK', message_count: 12 }

    expect(puoSovrascrivereGiornataVuota(misto)).toBe(false)
  })
})

describe('fondiEntita — una menzione nuova non cancella lo storico', () => {
  it('conserva i contesti gia presenti e aggiunge il nuovo', () => {
    const esistente = { mention_count: 3, contexts_json: ['contesto vecchio'], last_seen_at: '2026-08-19' }

    const out = fondiEntita(esistente, 'contesto nuovo', '2026-09-03')

    expect(out.contexts_json).toEqual(['contesto vecchio', 'contesto nuovo'])
    expect(out.mention_count).toBe(4)
    expect(out.last_seen_at).toBe('2026-09-03')
  })

  it('la prima menzione in assoluto parte da 1', () => {
    const out = fondiEntita(null, 'primo contesto', '2026-09-03')

    expect(out.mention_count).toBe(1)
    expect(out.contexts_json).toEqual(['primo contesto'])
  })

  it('rielaborare due volte la stessa giornata NON conta due volte', () => {
    const esistente = { mention_count: 5, contexts_json: ['gia visto'], last_seen_at: '2026-09-03' }

    const out = fondiEntita(esistente, 'gia visto', '2026-09-03')

    expect(out.mention_count).toBe(5)
    expect(out.contexts_json).toEqual(['gia visto'])
  })

  it('non duplica un contesto identico gia registrato', () => {
    const esistente = { mention_count: 2, contexts_json: ['stesso testo'], last_seen_at: '2026-08-01' }

    const out = fondiEntita(esistente, 'stesso testo', '2026-09-03')

    expect(out.contexts_json).toEqual(['stesso testo'])
    expect(out.mention_count).toBe(3)
  })

  it('tiene gli ultimi 8 contesti, non fa crescere la colonna senza fine', () => {
    const dieci = Array.from({ length: 10 }, (_, i) => `contesto ${i}`)
    const esistente = { mention_count: 10, contexts_json: dieci, last_seen_at: '2026-08-01' }

    const out = fondiEntita(esistente, 'contesto nuovo', '2026-09-03')

    expect(out.contexts_json).toHaveLength(8)
    expect(out.contexts_json.at(-1)).toBe('contesto nuovo')
    expect(out.contexts_json).not.toContain('contesto 0')
  })

  it('sopravvive a un contexts_json corrotto senza perdere la menzione nuova', () => {
    const rotto = { mention_count: 2, contexts_json: 'non e un array', last_seen_at: '2026-08-01' }

    const out = fondiEntita(rotto, 'contesto nuovo', '2026-09-03')

    expect(out.contexts_json).toEqual(['contesto nuovo'])
    expect(out.mention_count).toBe(3)
  })
})
