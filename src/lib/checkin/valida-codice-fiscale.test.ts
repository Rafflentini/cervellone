/**
 * Validazione formale del codice fiscale inserito da chi fa il check-in.
 *
 * Il CF lo scrive l'ospite, o la persona che consegna le chiavi. E' un dato
 * copiato a mano da una tessera sanitaria: gli errori non sono rari, sono la
 * norma. E un CF sbagliato non si vede — entra in fattura, viene trasmesso, e
 * torna indietro come scarto giorni dopo, quando l'ospite se n'e' andato.
 *
 * Il carattere di controllo esiste proprio per questo: un solo carattere
 * sbagliato lo fa saltare. Per questo il test piu' importante qui non e' che un
 * CF valido passi, ma che OGNI singola storpiatura di un CF valido venga
 * respinta.
 */
import { describe, it, expect } from 'vitest'
import { validaCodiceFiscale, strutturaValida } from './valida-codice-fiscale'

const VALIDO = 'RSSMRA80A01H501U' // Mario Rossi, Roma, 01/01/1980 — riferimento pubblico

describe('un codice valido', () => {
  it('passa', () => {
    expect(validaCodiceFiscale(VALIDO).valido).toBe(true)
  })

  it('passa anche scritto male: minuscolo, con spazi', () => {
    const r = validaCodiceFiscale('  rssmra80a01h501u ')
    expect(r.valido).toBe(true)
    expect(r.normalizzato).toBe(VALIDO)
  })
})

describe('il carattere di controllo fa il suo mestiere', () => {
  it('respinge OGNI storpiatura di un solo carattere', () => {
    // 16 posizioni x tutte le sostituzioni plausibili. Se anche una passasse,
    // sarebbe un CF sbagliato accettato in silenzio.
    const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let provate = 0
    for (let i = 0; i < VALIDO.length; i++) {
      for (const ch of alfabeto) {
        if (ch === VALIDO[i]) continue
        const storpiato = VALIDO.substring(0, i) + ch + VALIDO.substring(i + 1)
        provate++
        expect(validaCodiceFiscale(storpiato).valido, `${storpiato} non doveva passare`).toBe(false)
      }
    }
    expect(provate).toBeGreaterThan(500)
  })

  it('respinge due caratteri scambiati fra loro', () => {
    // La trasposizione e' l'errore di battitura piu' comune.
    const scambiato = 'RSSMAR80A01H501U' // MRA -> MAR
    expect(validaCodiceFiscale(scambiato).valido).toBe(false)
  })
})

describe('lunghezza e forma', () => {
  it('respinge un codice troppo corto o troppo lungo', () => {
    expect(validaCodiceFiscale('RSSMRA80A01H501').valido).toBe(false)
    expect(validaCodiceFiscale('RSSMRA80A01H501UU').valido).toBe(false)
  })

  it('respinge la partita IVA messa nel campo sbagliato', () => {
    expect(validaCodiceFiscale('02232730768').valido).toBe(false)
  })

  it('respinge un mese inesistente', () => {
    // Le lettere ammesse sono solo ABCDEHLMPRST: la F non e' un mese.
    expect(strutturaValida('RSSMRA80F01H501U')).toBe(false)
  })

  it('respinge lettere dove vanno le cifre', () => {
    expect(strutturaValida('RSSMRAXXA01H501U')).toBe(false)
  })

  it('dice vuoto quando e vuoto, senza fingere un errore di forma', () => {
    const r = validaCodiceFiscale('')
    expect(r.valido).toBe(false)
    expect(r.errore).toContain('mancante')
  })
})

describe('omocodia', () => {
  it('accetta la forma con le lettere al posto delle cifre', () => {
    // Quando due persone otterrebbero lo stesso codice, l'Agenzia sostituisce
    // le cifre con lettere (0->L 1->M 2->N 3->P 4->Q 5->R 6->S 7->T 8->U 9->V).
    // Sono codici veri, di persone vere: rifiutarli per "forma" significa
    // impedire il check-in a chi ha quel codice.
    expect(strutturaValida('RSSMRAULALLMH5LMU')).toBe(false) // 17 caratteri: comunque no
    expect(strutturaValida('RSSMRAU0A0MH501U')).toBe(true)
  })
})

describe('coerenza con i dati anagrafici', () => {
  it('segnala quando la data di nascita non corrisponde al codice', () => {
    // Il codice e' formalmente valido ma appartiene a un'altra data: uno dei due
    // campi e' sbagliato, e la fattura andrebbe intestata male.
    const r = validaCodiceFiscale(VALIDO, { dataNascita: '1990-05-20', sesso: 'M' })
    expect(r.valido).toBe(true)
    expect(r.coerente).toBe(false)
    expect(r.avvisoCoerenza).toContain('data di nascita')
  })

  it('segnala quando il sesso non corrisponde', () => {
    const r = validaCodiceFiscale(VALIDO, { dataNascita: '1980-01-01', sesso: 'F' })
    expect(r.coerente).toBe(false)
    expect(r.avvisoCoerenza).toContain('sesso')
  })

  it('conferma quando tutto torna', () => {
    const r = validaCodiceFiscale(VALIDO, { dataNascita: '1980-01-01', sesso: 'M' })
    expect(r.coerente).toBe(true)
    expect(r.avvisoCoerenza).toBe('')
  })

  it('non si pronuncia sulla coerenza se non gli danno i dati', () => {
    const r = validaCodiceFiscale(VALIDO)
    expect(r.coerente).toBeUndefined()
  })
})
