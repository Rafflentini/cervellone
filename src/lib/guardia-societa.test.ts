import { describe, it, expect } from 'vitest'
import { verificaDatiSocietari, pivaNostre, messaggioBlocco } from './guardia-societa'
import { contieneComandoConCodice } from './comandi-uuid'

// Un uuid canonico qualunque: questi test provano il TESTO del messaggio, non
// la generazione del codice (quella e' in guardia-autorizzazioni.test.ts).
const UUID_DI_PROVA = '3f3fc82f-4daa-408e-9308-78effecc338e'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

describe('pivaNostre', () => {
  it('deriva dal registro, non da valori riscritti a mano', () => {
    const m = pivaNostre()
    expect(m.size).toBe(2)
    expect(m.get('02087420762')?.codice).toBe('restruktura')
    expect(m.get('02232730768')?.codice).toBe('larealestate')
  })
})

describe('verificaDatiSocietari — CONTROLLO NEGATIVO: il caso normale deve passare', () => {
  it('preventivo Restruktura con la P.IVA del COMMITTENTE nel corpo: passa', () => {
    const html = `<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>
      <div>Committente: Edil Limongi S.r.l. — P.IVA 01234567890</div>`
    expect(verificaDatiSocietari(html, RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento che non nomina nessuna partita IVA: passa', () => {
    expect(verificaDatiSocietari('<p>Relazione tecnica senza dati fiscali</p>', RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento La Real Estate con la SUA partita IVA: passa', () => {
    const html = `<h1>LA REAL ESTATE SRLS</h1><p>P.IVA 02232730768</p>`
    expect(verificaDatiSocietari(html, LAREALESTATE)).toEqual({ ok: true })
  })
})

describe('verificaDatiSocietari — CONTROLLO POSITIVO: il caso vero deve mordere', () => {
  it('IL DIFETTO DI OGGI: La Real Estate attiva, intestazione Restruktura cablata', () => {
    const html = `<div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762 — Villa d'Agri (PZ)</p></div>
      <h2>PREVENTIVO N. 1</h2>`
    const esito = verificaDatiSocietari(html, LAREALESTATE)
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('controllo positivo inerte: la guardia non ha morso')
    expect(esito.trovate).toEqual([{ piva: '02087420762', denominazione: 'RESTRUKTURA S.r.l.' }])
    expect(esito.attesa).toEqual(LAREALESTATE)
  })

  it('riconosce la P.IVA anche con prefisso IT', () => {
    const esito = verificaDatiSocietari('<p>IT02087420762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('riconosce la P.IVA anche con separatori', () => {
    const esito = verificaDatiSocietari('<p>P.IVA 02.087.420.762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('il messaggio di blocco NOMINA le due partite IVA: un rifiuto muto costringe a indovinare', () => {
    const esito = verificaDatiSocietari('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', LAREALESTATE)
    if (esito.ok) throw new Error('atteso blocco')
    const msg = messaggioBlocco(esito, UUID_DI_PROVA)
    expect(msg).toContain('02087420762')
    expect(msg).toContain('02232730768')
    expect(msg).toContain('LA REAL ESTATE SRLS')
  })

  // Task 12: il messaggio adesso PORTA un comando vero, /doc_ok_<codice>,
  // perche' la vecchia promessa ("dimmelo e lo genero comunque") non aveva
  // modo di essere mantenuta. Quel comando contiene per costruzione un
  // underscore — e' l'unico modo per essere tappabile su Telegram.
  //
  // Su Telegram i messaggi partono con parse_mode: 'Markdown'
  // (telegram-helpers.ts:37), dove `_` delimita il corsivo: due underscore
  // in un nome scritto in PROSA vengono RIMOSSI, non mostrati —
  // `imposta_societa_attiva` arrivava come `impostasocietaattiva`, un
  // comando che non esiste. Quindi l'invariante vera non e' "nessun
  // underscore in assoluto" (che oggi sarebbe falsa, ed e' giusto che lo
  // sia): e' "nessun identificatore snake_case NUDO nella prosa". Un comando
  // riconosciuto da `contieneComandoConCodice` non e' nudo: quella funzione
  // decide GIA' di spedire il messaggio in testo semplice
  // (telegram-helpers.ts), dove il Markdown non tocca nessun underscore.
  it('il messaggio contiene un comando /doc_ok_<codice> tappabile, non un underscore nudo nella prosa', () => {
    const esito = verificaDatiSocietari('<p>02087420762</p>', LAREALESTATE)
    if (esito.ok) throw new Error('atteso blocco')
    const msg = messaggioBlocco(esito, UUID_DI_PROVA)

    // Il messaggio va gia' incontro alla sua stessa difesa: contiene un
    // comando con codice, quindi telegram-helpers.ts lo spedira' SENZA
    // Markdown.
    expect(contieneComandoConCodice(msg)).toBe(true)

    // Tolti i comandi riconosciuti (doc_ok/doc_no), non deve restare NESSUN
    // altro underscore scritto a mano nella prosa.
    const senzaComandi = msg.replace(/\/doc_(ok|no)_[0-9a-f-]+/g, '')
    expect(senzaComandi).not.toMatch(/_/)
  })
})
