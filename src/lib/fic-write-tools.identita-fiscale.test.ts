/**
 * src/lib/fic-write-tools.identita-fiscale.test.ts — la P.IVA del cedente
 * estero non e' grafica.
 *
 * ⚠️ Il difetto, 15 settembre 2026. `resolveEntitaFic` leggeva la scheda
 * INTERA dall'anagrafica di Fatture in Cloud e poi teneva solo `id` e `name`,
 * lasciando a FIC il compito di ricostruire il resto partendo dall'id — un
 * meccanismo che nessuno aveva mai verificato.
 *
 * Su una fattura italiana non si notava. Su un'integrazione TD17 il cedente e'
 * Booking.com B.V. con partita IVA comunitaria NL805734958B01: senza quella, il
 * documento non e' valido. I dati erano gia' in mano, letti due righe sopra, e
 * venivano buttati via.
 *
 * ⚠️ Solo i campi VALORIZZATI: spedire una stringa vuota a Fatture in Cloud
 * non vuol dire «lascia stare», vuol dire «cancella quello che c'e'».
 */
import { describe, it, expect } from 'vitest'
import { identitaFiscalePerTest } from './fic-write-tools'

const BOOKING = {
  id: 113683279,
  name: 'Booking.com B.V.',
  vat_number: 'NL805734958B01',
  address_street: 'Oosterdokskade 163',
  address_postal_code: '1011 DL',
  address_city: 'Amsterdam',
  country: 'Paesi Bassi',
  // Campi che FIC restituisce vuoti su un fornitore estero: non devono viaggiare.
  tax_code: '',
  address_province: null,
}

describe('l identita fiscale del cedente viaggia sul documento', () => {
  it('🚨 la partita IVA comunitaria e l indirizzo ci sono', () => {
    const identita = identitaFiscalePerTest(BOOKING)

    expect(identita.vat_number).toBe('NL805734958B01')
    expect(identita.address_street).toBe('Oosterdokskade 163')
    expect(identita.address_city).toBe('Amsterdam')
    expect(identita.country).toBe('Paesi Bassi')
  })

  it('🚨 i campi VUOTI non viaggiano: una stringa vuota cancella, non «lascia stare»', () => {
    const identita = identitaFiscalePerTest(BOOKING)

    expect('tax_code' in identita).toBe(false)
    expect('address_province' in identita).toBe(false)
  })

  it('CONTROLLO POSITIVO: una scheda senza dati fiscali non inventa niente', () => {
    // Senza questo, un helper che restituisse valori predefiniti passerebbe i
    // test qui sopra e metterebbe dati finti su un documento fiscale.
    expect(identitaFiscalePerTest({ id: 5, name: 'Mario Rossi' })).toEqual({})
    expect(identitaFiscalePerTest(undefined)).toEqual({})
  })
})
