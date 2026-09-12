/**
 * I codici dei comandi: cliccabili con un tocco, e accettati in tre forme.
 *
 * Il difetto, misurato il 12 set 2026, aveva TRE cause una dietro l'altra:
 *
 *  1. **I trattini.** Telegram rende cliccabile un comando solo se e' fatto di
 *     `[A-Za-z0-9_]`: il client si fermava al primo `-` e toccando
 *     `/invia_d8f8ad16-29db-4bc2-b2d9-bf386f2b861c` mandava `/invia_d8f8ad16`.
 *  2. **La lunghezza.** Telegram riconosce come comando `/` + al massimo 32
 *     caratteri. `invia_` + 32 cifre fa 38: oltre il limite, quindi nemmeno
 *     cliccabile. Il codice emesso scende a 16 cifre — `invia_` + 16 = 22.
 *  3. **Il Markdown.** Due comandi nello stesso messaggio danno una coppia di
 *     `_`, che nel Markdown classico delimita il corsivo: Telegram li mangia e
 *     arriva `/inviaXXXX`. La cura sta in `telegram-helpers.ts` e usa
 *     `contieneComandoConCodice`, provata qui sotto.
 *
 * L'Ingegnere lavora dal telefono: «non riesco a usare i codici che il bot mi
 * da'».
 */
import { describe, it, expect } from 'vitest'
import {
  normalizzaUuid,
  codiceDaEmettere,
  comandoDaMostrare,
  comandoUuid,
  comandoPrefisso,
  comandoDalCodiceRotto,
  contieneComandoConCodice,
  intervalloPrefisso,
  risolviPrefisso,
  COMANDI_CON_CODICE,
  ORIGINE_CODICE,
  LUNGHEZZA_CODICE_BREVE,
} from './comandi-uuid'

const UUID = 'd8f8ad16-29db-4bc2-b2d9-bf386f2b861c'
const SENZA = 'd8f8ad1629db4bc2b2d9bf386f2b861c'
const BREVE = 'd8f8ad1629db4bc2' // le prime 16 cifre: la forma che il bot EMETTE

/** Le famiglie che un codice corto sa risolvere (tutte tranne i tre `fic_*`). */
const RISOLVIBILI = COMANDI_CON_CODICE.filter((n) => ORIGINE_CODICE[n] !== undefined)

describe('codiceDaEmettere — quello che il bot EMETTE', () => {
  it('emette SEDICI cifre, non trentadue', () => {
    expect(LUNGHEZZA_CODICE_BREVE).toBe(16)
    expect(codiceDaEmettere('invia', UUID)).toBe(BREVE)
    expect(codiceDaEmettere('invia', UUID)).toHaveLength(16)
  })

  it('il comando sta nei 32 caratteri che Telegram riconosce', () => {
    // È l'assert che lega la cura alla causa numero 2: `/invia_` + 32 cifre fa
    // 38 caratteri dopo la barra, e Telegram si ferma a 32 — il comando non
    // diventa nemmeno cliccabile.
    const comando = comandoDaMostrare('invia', UUID)
    expect(comando).toBe(`/invia_${BREVE}`)
    expect(comando.slice(1)).toHaveLength(22)
    for (const nome of RISOLVIBILI) {
      expect(comandoDaMostrare(nome, UUID).slice(1).length).toBeLessThanOrEqual(32)
    }
  })

  it('⚠️ MISURATO: i tre `fic_*` restano FUORI dal limite, e resta un difetto aperto', () => {
    // Non è un dettaglio da nascondere: `fic_ok2_` + 32 cifre fa 40 caratteri
    // dopo la barra, quindi su Telegram quei comandi NON sono cliccabili. Qui
    // non si accorciano perché nessuno saprebbe riespanderli — quel flusso
    // scrive i comandi a mano in `fic-write-tools.ts` e non va toccato in
    // questo commit ([[cervellone-fic-ramo-non-mergiare]]).
    // Il test esiste per non dimenticarlo: quando il flusso FIC si potrà
    // toccare, si aggiunge la sua riga in `ORIGINE_CODICE` e questo test cambia.
    for (const nome of ['fic_ok', 'fic_ok2', 'fic_no'] as const) {
      expect(comandoDaMostrare(nome, UUID).slice(1).length).toBeGreaterThan(32)
    }
  })

  it('il codice emesso è fatto SOLO di [A-Za-z0-9_], la condizione di Telegram', () => {
    // Causa numero 1: se qualcuno rimettesse i trattini nell'emissione, il
    // comando tornerebbe non cliccabile.
    for (const nome of COMANDI_CON_CODICE) {
      const c = comandoDaMostrare(nome, UUID)
      expect(c.slice(1)).toMatch(/^[A-Za-z0-9_]+$/)
      expect(c).not.toContain('-')
    }
  })

  it('un identificativo che NON è un uuid passa intatto, non mutilato', () => {
    // Trovato dai test esistenti: `id-1` sarebbe diventato `id1`, un codice che
    // non corrisponde a niente. Si accorcia solo ciò che si sa essere un uuid.
    expect(codiceDaEmettere('condividi_ok', 'id-1')).toBe('id-1')
    expect(codiceDaEmettere('condividi_ok', 'P1')).toBe('P1')
    expect(comandoDaMostrare('condividi_ok', 'id-1')).toBe('/condividi_ok_id-1')
  })

  it('🚨 una famiglia che NON si sa risolvere riceve il codice LUNGO', () => {
    // La guardia strutturale: un codice corto vale solo se qualcuno sa
    // riespanderlo. I tre `fic_*` non stanno in `ORIGINE_CODICE` — quel flusso
    // scrive i suoi comandi a mano e non va toccato — quindi qui continuano a
    // ricevere 32 cifre. Senza questa regola avrebbero un codice corto che
    // nessun ramo sa risolvere: peggio del difetto che stiamo chiudendo.
    for (const nome of ['fic_ok', 'fic_ok2', 'fic_no'] as const) {
      expect(ORIGINE_CODICE[nome]).toBeUndefined()
      expect(codiceDaEmettere(nome, UUID)).toBe(SENZA)
    }
    for (const nome of RISOLVIBILI) {
      expect(codiceDaEmettere(nome, UUID)).toBe(BREVE)
    }
  })

  it('ogni famiglia risolvibile dice tabella E colonna', () => {
    // A2 della lista tarata: un nome di colonna scritto a mano. La tabella
    // delle bozze mail ha la chiave `uuid`, non `id` — sbagliarla darebbe una
    // lettura vuota, cioè «non trovo la bozza».
    expect(ORIGINE_CODICE.invia).toEqual({
      tabella: 'cervellone_email_pending_send',
      colonna: 'uuid',
    })
    for (const nome of RISOLVIBILI) {
      expect(ORIGINE_CODICE[nome]!.tabella).toMatch(/^[a-z_]+$/)
      expect(ORIGINE_CODICE[nome]!.colonna).toMatch(/^[a-z_]+$/)
    }
  })
})

describe('comandoUuid — accetta le due forme LUNGHE', () => {
  it('la forma senza trattini', () => {
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

  it('vale per tutte le famiglie, in entrambe le forme lunghe', () => {
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

describe('comandoPrefisso — la terza forma, quella CORTA', () => {
  it('legge le 16 cifre che il bot emette', () => {
    expect(comandoPrefisso(`/invia_${BREVE}`, 'invia')).toBe(BREVE)
    expect(comandoPrefisso(`/INVIA_${BREVE.toUpperCase()}`, 'invia')).toBe(BREVE)
    expect(comandoPrefisso(`/invia_${BREVE} grazie`, 'invia')).toBe(BREVE)
  })

  it('vale per tutte le famiglie', () => {
    for (const nome of COMANDI_CON_CODICE) {
      expect(comandoPrefisso(`/${nome}_${BREVE}`, nome)).toBe(BREVE)
    }
  })

  it('NON morde su un codice lungo: le tre forme non si sovrappongono', () => {
    // Misurato, non dedotto: dopo 16 cifre di un codice da 32 c'è un'altra
    // cifra, che è un carattere di parola, e `\b` non morde. Un uuid coi
    // trattini ha un `-` alla nona posizione e non arriva a 16 consecutive.
    expect(comandoPrefisso(`/invia_${SENZA}`, 'invia')).toBeNull()
    expect(comandoPrefisso(`/invia_${UUID}`, 'invia')).toBeNull()
  })

  it('e nemmeno su 15 o 17 cifre', () => {
    expect(comandoPrefisso(`/invia_${BREVE.slice(0, 15)}`, 'invia')).toBeNull()
    expect(comandoPrefisso(`/invia_${BREVE}f`, 'invia')).toBeNull()
  })

  it('⭐ le TRE forme risolvono sullo STESSO uuid', () => {
    // Il cuore dell'allargamento: 32 coi trattini (i comandi vecchi già in
    // chat), 32 senza (quelli emessi prima di questo commit), 16 (quelli di
    // adesso). Tre scritture, un solo uuid.
    const daLungoTrattini = comandoUuid(`/invia_${UUID}`, 'invia')
    const daLungoPiatto = comandoUuid(`/invia_${SENZA}`, 'invia')
    const daCorto = risolviPrefisso(comandoPrefisso(`/invia_${BREVE}`, 'invia')!, [UUID])
    expect(daLungoTrattini).toBe(UUID)
    expect(daLungoPiatto).toBe(UUID)
    expect(daCorto).toEqual({ ok: true, uuid: UUID })
  })
})

describe('risolviPrefisso — 🚨 l\'ambiguità si DICHIARA, non si indovina', () => {
  const GEMELLO = 'd8f8ad16-29db-4bc2-0000-000000000001' // stesse prime 16 cifre
  const ALTRO = '11111111-2222-3333-4444-555555555555'

  it('un solo candidato: risolve', () => {
    expect(risolviPrefisso(BREVE, [UUID, ALTRO])).toEqual({ ok: true, uuid: UUID })
  })

  it('nessun candidato: lo dice, non inventa', () => {
    expect(risolviPrefisso(BREVE, [ALTRO])).toEqual({ ok: false, motivo: 'assente' })
    expect(risolviPrefisso(BREVE, [])).toEqual({ ok: false, motivo: 'assente' })
  })

  it('🚨 DUE candidati: ambiguo, e NON la più recente', () => {
    // La guardia che conta. L'Ingegnere tocca il comando di UNA bozza precisa:
    // scegliere «la più recente» manderebbe la mail a un ALTRO destinatario.
    // I candidati arrivano dal database ordinati per data — il più recente
    // primo — quindi un'implementazione che «sceglie il primo» passerebbe i
    // test qui sopra e morirebbe solo qui.
    const esito = risolviPrefisso(BREVE, [UUID, GEMELLO])
    expect(esito.ok).toBe(false)
    expect(esito).toMatchObject({ motivo: 'ambiguo', quanti: 2 })
    // e in nessun caso torna un uuid
    expect(esito).not.toHaveProperty('uuid')
  })

  it('l\'ordine dei candidati non cambia l\'esito: ambiguo in entrambi i versi', () => {
    expect(risolviPrefisso(BREVE, [GEMELLO, UUID])).toMatchObject({ motivo: 'ambiguo' })
    expect(risolviPrefisso(BREVE, [UUID, GEMELLO])).toMatchObject({ motivo: 'ambiguo' })
  })

  it('la stessa bozza ripetuta non è un\'ambiguità', () => {
    // Il database può tornare la stessa riga scritta in due modi (coi trattini
    // e senza): sono un uuid solo, non due bozze.
    expect(risolviPrefisso(BREVE, [UUID, SENZA, UUID.toUpperCase()])).toEqual({
      ok: true,
      uuid: UUID,
    })
  })

  it('⭐ L\'INVARIANTE: un codice accettato non porta MAI a un uuid diverso', () => {
    // È l'invariante di questo modulo, e vale anche coi 16: l'uuid tornato
    // comincia sempre con le cifre scritte. Provata su tutti i prefissi di
    // lunghezza 16 di un mucchio di uuid, contro un mucchio di candidati.
    const candidati = [
      UUID,
      GEMELLO,
      ALTRO,
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'd8f8ad16-29db-4bc3-b2d9-bf386f2b861c', // vicinissimo: differisce alla 16ª
    ]
    for (const atteso of candidati) {
      const prefisso = atteso.replace(/-/g, '').slice(0, LUNGHEZZA_CODICE_BREVE)
      const esito = risolviPrefisso(prefisso, candidati)
      if (esito.ok) {
        // le cifre lette sono le stesse scritte, nello stesso ordine
        expect(esito.uuid.replace(/-/g, '').startsWith(prefisso)).toBe(true)
      } else {
        // l'unica alternativa lecita è dichiararsi ambiguo o assente
        expect(['ambiguo', 'assente']).toContain(esito.motivo)
      }
    }
  })

  it('CONTROLLO POSITIVO: su questi candidati la risoluzione riesce davvero', () => {
    // Senza, il test dell'invariante qui sopra passerebbe anche se
    // `risolviPrefisso` dicesse SEMPRE «ambiguo»: un test che non misura.
    expect(risolviPrefisso(ALTRO.replace(/-/g, '').slice(0, 16), [UUID, ALTRO])).toEqual({
      ok: true,
      uuid: ALTRO,
    })
  })
})

describe('intervalloPrefisso — cercare per intervallo, non con un like', () => {
  it('dà gli estremi canonici del prefisso', () => {
    expect(intervalloPrefisso(BREVE)).toEqual({
      da: 'd8f8ad16-29db-4bc2-0000-000000000000',
      a: 'd8f8ad16-29db-4bc2-ffff-ffffffffffff',
    })
  })

  it('l\'uuid cercato cade dentro l\'intervallo, e uno vicino fuori', () => {
    // La colonna è di tipo `uuid` in Postgres: `like` non ha operatore e
    // fallirebbe. Gli uuid si ordinano per byte, quindi come le cifre esadecimali.
    const { da, a } = intervalloPrefisso(BREVE)
    expect(UUID >= da && UUID <= a).toBe(true)
    expect('d8f8ad16-29db-4bc3-0000-000000000000' <= a).toBe(false)
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

describe('contieneComandoConCodice — quali messaggi NON portano il Markdown', () => {
  it('vero se il messaggio porta un comando, in qualunque forma', () => {
    expect(contieneComandoConCodice(`Per inviare: /invia_${BREVE}`)).toBe(true)
    expect(contieneComandoConCodice(`Per inviare: /invia_${SENZA}`)).toBe(true)
    expect(contieneComandoConCodice(`Per inviare: /invia_${UUID}`)).toBe(true)
    // anche i comandi FIC, scritti a mano altrove e con lo stesso problema
    expect(contieneComandoConCodice(`1a conferma -> /fic_ok_${UUID}`)).toBe(true)
    // e anche gli identificativi che non sono uuid
    expect(contieneComandoConCodice('Confermi: /condividi_ok_id-1')).toBe(true)
  })

  it('lo trova anche in mezzo a un messaggio lungo, su più righe', () => {
    const messaggio = [
      '📧 Vuoi che invii questa mail?',
      'Oggetto: Due contratti',
      `✅ Per inviare: ${comandoDaMostrare('invia', UUID)}`,
      `❌ Per annullare: ${comandoDaMostrare('annulla', UUID)}`,
    ].join('\n')
    // ⭐ È IL messaggio del difetto: due comandi, due underscore, e il Markdown
    // li leggeva come coppia di delimitatori del corsivo.
    expect(messaggio.match(/_/g)).toHaveLength(2)
    expect(contieneComandoConCodice(messaggio)).toBe(true)
  })

  it('CONTROLLO POSITIVO: falso su un messaggio normale, che il grassetto lo usa', () => {
    // Senza questo, una funzione che dicesse sempre `true` toglierebbe il
    // Markdown a TUTTI i messaggi e passerebbe il test qui sopra.
    expect(contieneComandoConCodice('Ho archiviato il documento in *Contabilità*.')).toBe(false)
    expect(contieneComandoConCodice('')).toBe(false)
    expect(contieneComandoConCodice('/regole')).toBe(false)
    expect(contieneComandoConCodice('/reset')).toBe(false)
    expect(contieneComandoConCodice('Le invio pure la mail, d\'accordo?')).toBe(false)
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

  it('⚠️ e il codice CORTO che emettiamo NOI non è «rotto»', () => {
    // Senza questa riga il nostro stesso comando si autodenuncerebbe come
    // illeggibile, e l'Ingegnere si sentirebbe dire «codice non valido» sul
    // comando che gli abbiamo appena mandato.
    for (const nome of RISOLVIBILI) {
      expect(comandoDalCodiceRotto(comandoDaMostrare(nome, UUID))).toBeNull()
    }
  })

  it('un codice corto di una famiglia NON risolvibile resta «rotto»', () => {
    // I `fic_*` non emettono codici corti: 16 cifre lì non sarebbero
    // risolvibili da nessuno, quindi vanno dichiarate — non ingoiate.
    expect(comandoDalCodiceRotto(`/fic_ok_${BREVE}`)).toBe('fic_ok')
  })

  it('un messaggio normale non è un comando rotto', () => {
    expect(comandoDalCodiceRotto('invia pure la mail')).toBeNull()
    expect(comandoDalCodiceRotto('/start')).toBeNull()
    expect(comandoDalCodiceRotto('')).toBeNull()
  })
})
