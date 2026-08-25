/**
 * I messaggi che partono all'apertura di una prenotazione.
 *
 * Il caso che conta e' il numero di telefono: WhatsApp lo vuole in una forma
 * precisa, e un numero scritto come lo scrive una persona — con spazi, con il
 * +39, senza prefisso — aprirebbe una chat vuota o quella sbagliata.
 */
import { describe, it, expect } from 'vitest'
import {
  numeroPerWhatsApp, linkWhatsApp, messaggioOspite, messaggioConsegnaChiavi, chiConsegnaLeChiavi,
} from './avvisi'

describe('il numero per WhatsApp', () => {
  it('toglie tutto cio che non e una cifra', () => {
    expect(numeroPerWhatsApp('+39 333 123 45 67')).toBe('393331234567')
    expect(numeroPerWhatsApp('(333) 123-4567')).toBe('393331234567')
  })

  it('aggiunge il 39 a un numero italiano scritto senza prefisso', () => {
    // E' come lo scrive chiunque copiandolo da Booking.
    expect(numeroPerWhatsApp('3331234567')).toBe('393331234567')
  })

  it('non tocca un numero che il prefisso ce l ha gia', () => {
    expect(numeroPerWhatsApp('393331234567')).toBe('393331234567')
  })

  it('lascia stare i numeri stranieri', () => {
    // Un tedesco: 49 e' il suo prefisso, non va ne tolto ne raddoppiato.
    expect(numeroPerWhatsApp('+49 170 1234567')).toBe('491701234567')
  })

  it('senza numero non inventa niente', () => {
    expect(numeroPerWhatsApp('')).toBe('')
    expect(numeroPerWhatsApp('non un numero')).toBe('')
  })
})

describe('il collegamento a WhatsApp', () => {
  it('porta il destinatario e il messaggio', () => {
    const l = linkWhatsApp('3331234567', 'ciao')
    expect(l).toContain('wa.me/393331234567')
    expect(l).toContain('text=ciao')
  })

  it('senza numero apre lo stesso, chiedendo a chi mandarlo', () => {
    // Meglio far scegliere il contatto che non avere il pulsante.
    expect(linkWhatsApp('', 'ciao')).toBe('https://wa.me/?text=ciao')
  })

  it('non lascia passare caratteri che romperebbero l indirizzo', () => {
    expect(linkWhatsApp('333', 'a b&c')).toContain('a%20b%26c')
  })
})

describe('i messaggi', () => {
  it("quello all'ospite porta il link e dice perche", () => {
    const m = messaggioOspite({ link: 'https://x.it/c?p=1', unita: 'Unità 2', checkin: '2026-09-20' })
    expect(m).toContain('https://x.it/c?p=1')
    expect(m).toContain('Unità 2')
    expect(m).toContain('20/09/2026')
    expect(m).toContain('Questura')
  })

  it('quello a chi consegna le chiavi dice chi arriva e quando', () => {
    const m = messaggioConsegnaChiavi({
      linkGestione: 'https://x.it/g', unita: 'Unità 1',
      checkin: '2026-09-20', checkout: '2026-09-23',
      ospiti: 3, intestatario: 'ROSSI MARIO',
    })
    expect(m).toContain('ROSSI MARIO')
    expect(m).toContain('20/09/2026')
    expect(m).toContain('23/09/2026')
    expect(m).toContain('3 ospiti')
    expect(m).toContain('https://x.it/g')
  })

  it('accorda il singolare con un ospite solo', () => {
    const m = messaggioConsegnaChiavi({
      linkGestione: 'x', unita: 'U', checkin: '2026-09-20', checkout: '2026-09-23',
      ospiti: 1, intestatario: 'X',
    })
    expect(m).toContain('1 ospite.')
  })

  it('senza nome non lascia un buco nel messaggio', () => {
    const m = messaggioConsegnaChiavi({
      linkGestione: 'x', unita: 'U', checkin: '2026-09-20', checkout: '2026-09-23',
      ospiti: 2, intestatario: '',
    })
    expect(m).toContain('Nome non indicato')
  })
})

describe('chi consegna le chiavi', () => {
  it('accoppia ogni nome col proprio numero', () => {
    expect(chiConsegnaLeChiavi('Anna | Sara', '3331111111|3332222222')).toEqual([
      { nome: 'Anna', telefono: '3331111111' },
      { nome: 'Sara', telefono: '3332222222' },
    ])
  })

  it('una sola persona si scrive senza barra, come si e sempre fatto', () => {
    expect(chiConsegnaLeChiavi('Anna', '3331111111')).toEqual([
      { nome: 'Anna', telefono: '3331111111' },
    ])
  })

  it('senza nessuno indicato non inventa una voce vuota', () => {
    expect(chiConsegnaLeChiavi('', '')).toEqual([])
    expect(chiConsegnaLeChiavi('  |  ', ' ')).toEqual([])
  })

  it('un nome senza numero resta senza numero, NON prende quello della collega', () => {
    // Il caso che conta davvero. Se l elenco piu corto facesse slittare
    // l accoppiamento, il riepilogo di una prenotazione — con nome dell ospite,
    // date e appartamento — partirebbe al numero di un altra persona.
    expect(chiConsegnaLeChiavi('Anna|Sara|Lucia', '3331111111')).toEqual([
      { nome: 'Anna', telefono: '3331111111' },
      { nome: 'Sara', telefono: '' },
      { nome: 'Lucia', telefono: '' },
    ])
  })

  it('un numero senza nome resta comunque contattabile', () => {
    expect(chiConsegnaLeChiavi('', '3331111111|3332222222')).toEqual([
      { nome: '', telefono: '3331111111' },
      { nome: '', telefono: '3332222222' },
    ])
  })
})
