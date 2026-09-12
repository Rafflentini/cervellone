/**
 * I codici dei comandi: cliccabili con un tocco, e accettati in entrambe le forme.
 *
 * Il difetto, misurato il 12 set 2026: Telegram rende cliccabile un comando
 * solo se e' fatto di `[A-Za-z0-9_]`. I nostri codici erano UUID coi trattini,
 * quindi il client si fermava al primo `-` e toccando
 * `/invia_d8f8ad16-29db-4bc2-b2d9-bf386f2b861c` mandava `/invia_d8f8ad16`:
 * troncato, non corrispondente a niente, e passato al modello come una
 * richiesta nuova. L'Ingegnere lavora dal telefono: «non riesco a usare i
 * codici che il bot mi da'».
 */
import { describe, it, expect } from 'vitest'
import {
  normalizzaUuid,
  uuidPerComando,
  comandoDaMostrare,
  comandoUuid,
  comandoDalCodiceRotto,
  COMANDI_CON_CODICE,
} from './comandi-uuid'

const UUID = 'd8f8ad16-29db-4bc2-b2d9-bf386f2b861c'
const SENZA = 'd8f8ad1629db4bc2b2d9bf386f2b861c'

describe('uuidPerComando — quello che il bot EMETTE', () => {
  it('emette il codice senza trattini, così Telegram lo rende cliccabile', () => {
    expect(uuidPerComando(UUID)).toBe(SENZA)
  })

  it('il codice emesso è fatto SOLO di [A-Za-z0-9_], la condizione di Telegram', () => {
    // È questo l'assert che lega la cura alla causa: se qualcuno rimettesse i
    // trattini nell'emissione, il comando tornerebbe non cliccabile.
    const comando = comandoDaMostrare('invia', UUID)
    expect(comando).toBe(`/invia_${SENZA}`)
    expect(comando.slice(1)).toMatch(/^[A-Za-z0-9_]+$/)
    expect(comando).not.toContain('-')
  })

  it('un identificativo che NON è un uuid passa intatto, non mutilato', () => {
    // Trovato dai test esistenti: `id-1` sarebbe diventato `id1`, un codice che
    // non corrisponde a niente. Togliamo i trattini solo quando sappiamo di
    // avere un uuid canonico.
    expect(uuidPerComando('id-1')).toBe('id-1')
    expect(uuidPerComando('P1')).toBe('P1')
    expect(comandoDaMostrare('condividi_ok', 'id-1')).toBe('/condividi_ok_id-1')
  })

  it('vale per tutte le famiglie di comandi, non solo per invia', () => {
    for (const nome of COMANDI_CON_CODICE) {
      const c = comandoDaMostrare(nome, UUID)
      expect(c.slice(1)).toMatch(/^[A-Za-z0-9_]+$/)
      expect(c).not.toContain('-')
    }
  })
})

describe('comandoUuid — accetta ENTRAMBE le forme', () => {
  it('la forma NUOVA senza trattini', () => {
    expect(comandoUuid(`/invia_${SENZA}`, 'invia')).toBe(UUID)
  })

  it('la forma VECCHIA coi trattini: i comandi già mandati devono funzionare', () => {
    // Non è una gentilezza: nelle chat e nelle notifiche ci sono già comandi
    // col vecchio formato, e una bozza in attesa non si annulla perché abbiamo
    // cambiato il formato del codice.
    expect(comandoUuid(`/invia_${UUID}`, 'invia')).toBe(UUID)
  })

  it('entrambe le forme portano allo STESSO uuid canonico', () => {
    expect(comandoUuid(`/invia_${SENZA}`, 'invia')).toBe(comandoUuid(`/invia_${UUID}`, 'invia'))
  })

  it('maiuscole e testo dopo il comando non disturbano', () => {
    expect(comandoUuid(`/INVIA_${SENZA.toUpperCase()}`, 'invia')).toBe(UUID)
    expect(comandoUuid(`/invia_${SENZA} grazie`, 'invia')).toBe(UUID)
  })

  it('vale per tutte le famiglie, in entrambe le forme', () => {
    for (const nome of COMANDI_CON_CODICE) {
      expect(comandoUuid(`/${nome}_${SENZA}`, nome)).toBe(UUID)
      expect(comandoUuid(`/${nome}_${UUID}`, nome)).toBe(UUID)
    }
  })

  it('non confonde una famiglia con l\'altra', () => {
    expect(comandoUuid(`/annulla_${SENZA}`, 'invia')).toBeNull()
    expect(comandoUuid(`/invia_${SENZA}`, 'annulla')).toBeNull()
  })

  it('e non confonde /accesso_ok con /accesso_ok2', () => {
    expect(comandoUuid(`/accesso_ok2_${SENZA}`, 'accesso_ok')).toBeNull()
    expect(comandoUuid(`/accesso_ok_${SENZA}`, 'accesso_ok2')).toBeNull()
  })
})

describe('comandoUuid — un codice ROTTO non deve somigliare a uno buono', () => {
  // Il rischio vero di allargare il formato: un codice TRONCATO che viene
  // normalizzato in un uuid plausibile punterebbe a un'altra bozza, e
  // manderebbe la mail sbagliata. Deve non corrispondere a niente.
  const rotti = [
    `/invia_d8f8ad16`, // esattamente quello che produce il tap su un codice coi trattini
    `/invia_${SENZA.slice(0, 31)}`, // 31 cifre: una in meno
    `/invia_${SENZA}ff`, // 34 cifre: due in più
    `/invia_${SENZA}f`, // 33 cifre: una in più
    `/invia_`,
    `/invia_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz`, // non esadecimale
  ]
  for (const testo of rotti) {
    it(`NON riconosce: "${testo}"`, () => {
      expect(comandoUuid(testo, 'invia')).toBeNull()
    })
  }

  it('MISURATO: i trattini fuori posto sono accettati, e va bene così', () => {
    // Avevo scritto nel commento del modulo che questa forma veniva rifiutata.
    // Eseguendo, non è vero: `[8]-?[4]-?[4]-?[4]-?[12]` la accetta. Ho corretto
    // il commento, non il codice, perché il comportamento è quello giusto:
    // conta che le cifre esadecimali siano ESATTAMENTE 32, e allora la
    // normalizzazione porta comunque all'uuid voluto. Non c'è modo di arrivare
    // a un uuid DIVERSO da quello scritto, che è il solo rischio che conta.
    expect(comandoUuid('/invia_d8f8ad16-29db4bc2-b2d9-bf386f2b861c', 'invia')).toBe(UUID)
  })

  it('nessun codice accettato può puntare a un uuid diverso da quello scritto', () => {
    // L'invariante che rende sicuro l'allargamento del formato.
    for (const testo of [`/invia_${SENZA}`, `/invia_${UUID}`, '/invia_d8f8ad16-29db4bc2-b2d9-bf386f2b861c']) {
      const letto = comandoUuid(testo, 'invia')
      expect(letto).not.toBeNull()
      // le cifre esadecimali lette sono le stesse scritte, nello stesso ordine
      expect(letto!.replace(/-/g, '')).toBe(testo.slice('/invia_'.length).replace(/-/g, ''))
    }
  })
})

describe('normalizzaUuid', () => {
  it('rimette i trattini al posto giusto', () => {
    expect(normalizzaUuid(SENZA)).toBe(UUID)
  })

  it('è idempotente: un uuid già canonico torna identico', () => {
    expect(normalizzaUuid(UUID)).toBe(UUID)
    expect(normalizzaUuid(normalizzaUuid(SENZA))).toBe(UUID)
  })

  it('abbassa le maiuscole (il database ha gli uuid minuscoli)', () => {
    expect(normalizzaUuid(SENZA.toUpperCase())).toBe(UUID)
  })
})

describe('comandoDalCodiceRotto — un codice illeggibile va DETTO, non ignorato', () => {
  it('riconosce il troncamento di Telegram e nomina il comando', () => {
    // Senza questo il messaggio finisce al modello, che lo legge come una
    // richiesta nuova e riparte da zero: è il silenzio di cui l'Ingegnere si è
    // lamentato.
    expect(comandoDalCodiceRotto('/invia_d8f8ad16')).toBe('invia')
    expect(comandoDalCodiceRotto('/annulla_d8f8ad16')).toBe('annulla')
    expect(comandoDalCodiceRotto('/fic_ok2_abc')).toBe('fic_ok2')
  })

  it('CONTROLLO POSITIVO: un comando col codice BUONO non è «rotto»', () => {
    // Senza questo assert, una funzione che dicesse sempre «rotto»
    // passerebbe il test sopra e intercetterebbe ogni comando valido.
    expect(comandoDalCodiceRotto(`/invia_${SENZA}`)).toBeNull()
    expect(comandoDalCodiceRotto(`/invia_${UUID}`)).toBeNull()
    for (const nome of COMANDI_CON_CODICE) {
      expect(comandoDalCodiceRotto(`/${nome}_${SENZA}`)).toBeNull()
    }
  })

  it('un messaggio normale non è un comando rotto', () => {
    expect(comandoDalCodiceRotto('invia pure la mail')).toBeNull()
    expect(comandoDalCodiceRotto('/start')).toBeNull()
    expect(comandoDalCodiceRotto('')).toBeNull()
  })
})
