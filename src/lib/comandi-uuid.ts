/**
 * src/lib/comandi-uuid.ts — i codici dei comandi, una volta sola per i due canali.
 *
 * IL PROBLEMA, detto dall'Ingegnere il 12 set 2026: lavora dal telefono e «non
 * riesce a usare i codici che il bot gli da'». La causa e' precisa: Telegram
 * rende cliccabile un comando solo se e' fatto di `[A-Za-z0-9_]`. I nostri
 * codici sono UUID **coi trattini**, quindi Telegram si ferma al primo `-` e
 * toccando `/invia_d8f8ad16-29db-...` manda `/invia_d8f8ad16` — troncato e
 * inutile.
 *
 * LA CURA: emettere il codice SENZA trattini, e accettarlo in ENTRAMBE le
 * forme. Accettare entrambe non e' una gentilezza: i comandi con i trattini
 * sono gia' stati mandati in chat e nelle notifiche, e devono continuare a
 * funzionare — una bozza in attesa non si annulla perche' abbiamo cambiato il
 * formato del codice.
 *
 * PERCHE' STA QUI E NON NELLE DUE ROUTE: il parsing viveva in 15 copie — 14
 * regex in fila su `api/telegram/route.ts` e un helper su `api/chat/route.ts`.
 * Quindici copie sono quindici occasioni di correggerne quattordici, ed e'
 * esattamente il modo in cui in questo repo sono nate tutte le divergenze fra
 * i canali (vedi [[feedback_due_canali_equipollenti]]). Qui la regola sta
 * scritta una volta, e i due canali la importano.
 */

/**
 * Un uuid canonico 8-4-4-4-12 con i trattini FACOLTATIVI.
 *
 * Deliberatamente NON `[0-9a-f-]{32,36}`: quella forma accetta 33, 34, 35
 * caratteri, cioe' un codice TRONCATO o sporco che puo' essere normalizzato in
 * un uuid plausibile — che punta a UN'ALTRA bozza, e manda la mail sbagliata.
 * I gruppi a lunghezza fissa impongono invece **esattamente 32 cifre
 * esadecimali**, e quella e' l'invariante che rende sicuro l'allargamento: un
 * codice accettato non puo' mai portare a un uuid diverso da quello scritto.
 *
 * ⚠️ Misurato, non dedotto: questa forma accetta anche i trattini messi fuori
 * posto (`d8f8ad16-29db4bc2-b2d9-...`). Avevo scritto qui il contrario;
 * eseguendo, era falso. Non e' un problema — le cifre restano 32 e la
 * normalizzazione porta all'uuid voluto — ma il commento va detto giusto.
 */
const UUID_FLESSIBILE =
  '([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})'

/**
 * Rimette i trattini nella posizione canonica. Idempotente: un uuid che li ha
 * già torna identico. Serve perché la chiave in tutte le tabelle è l'uuid
 * canonico: il formato del comando cambia, quello del database no.
 */
export function normalizzaUuid(grezzo: string): string {
  const soloHex = grezzo.replace(/-/g, '').toLowerCase()
  if (soloHex.length !== 32) return grezzo.toLowerCase()
  return [
    soloHex.slice(0, 8),
    soloHex.slice(8, 12),
    soloHex.slice(12, 16),
    soloHex.slice(16, 20),
    soloHex.slice(20, 32),
  ].join('-')
}

/**
 * La forma da EMETTERE in un comando: senza trattini, così Telegram la rende
 * cliccabile con un tocco solo.
 */
export function uuidPerComando(uuid: string): string {
  const soloHex = uuid.replace(/-/g, '')
  // ⚠️ Guardia trovata dai test: se l'identificativo NON è un uuid canonico
  // (32 cifre esadecimali), togliergli i trattini lo MUTILA — `id-1` diventa
  // `id1`, un codice che non corrisponde a niente. Togliamo i trattini solo
  // quando sappiamo di avere un uuid; tutto il resto passa intatto.
  if (!/^[0-9a-f]{32}$/i.test(soloHex)) return uuid
  return soloHex.toLowerCase()
}

/**
 * Il comando completo da mostrare all'utente, già pronto: `/invia_<32 hex>`.
 * Un posto solo da cui escono, così suggerimento e parser non possono
 * divergere.
 */
export function comandoDaMostrare(nome: string, uuid: string): string {
  return `/${nome}_${uuidPerComando(uuid)}`
}

/**
 * Riconosce `/<nome>_<uuid>` in testa al messaggio, con o senza trattini, e
 * ritorna l'uuid CANONICO (coi trattini) pronto per il database. `null` se il
 * messaggio non è quel comando.
 */
export function comandoUuid(testo: string, nome: string): string | null {
  const m = testo.match(new RegExp(`^/${nome}_${UUID_FLESSIBILE}\\b`, 'i'))
  if (!m) return null
  return normalizzaUuid(m[1])
}

/**
 * Tutte le famiglie di comandi con un codice, su entrambi i canali. L'elenco
 * sta qui perché serve al riconoscimento del codice ROTTO (sotto), e perché un
 * elenco in un posto solo è l'unica forma che non divergerà.
 */
export const COMANDI_CON_CODICE = [
  'invia',
  'annulla',
  'conferma',
  'ignora',
  'accesso_ok2',
  'accesso_ok',
  'accesso_no',
  'condividi_ok',
  'fic_ok2',
  'fic_ok',
  'fic_no',
  'sal_ok2',
  'sal_ok',
  'sal_no',
  'regola_ok2',
  'regola_ok',
  'regola_no',
  'regola_via',
] as const

/**
 * Vera quando il messaggio COMINCIA come un nostro comando ma il codice non si
 * legge: `/invia_d8f8ad16` — cioè proprio quello che Telegram produce quando
 * l'Ingegnere tocca un comando coi trattini e il client lo tronca al primo `-`.
 *
 * 🚨 Senza questo, un comando troncato non corrisponde a nessun ramo e finisce
 * dritto al modello, che lo legge come una RICHIESTA NUOVA e riparte da zero:
 * è lo stesso silenzio di cui l'Ingegnere si è lamentato («non mi dice né che
 * non lo ha fatto né che problema ha»). Un codice illeggibile va DETTO.
 *
 * @returns il nome del comando riconosciuto, o `null` se non è un nostro comando
 */
export function comandoDalCodiceRotto(testo: string): string | null {
  for (const nome of COMANDI_CON_CODICE) {
    // `^/<nome>_` seguito da qualcosa che non è un uuid valido.
    if (!new RegExp(`^/${nome}_`, 'i').test(testo)) continue
    if (comandoUuid(testo, nome) !== null) return null // il codice si legge: tutto bene
    return nome
  }
  return null
}
