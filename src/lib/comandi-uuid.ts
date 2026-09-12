/**
 * src/lib/comandi-uuid.ts — i codici dei comandi, una volta sola per i due canali.
 *
 * IL PROBLEMA, detto dall'Ingegnere il 12 set 2026: lavora dal telefono e «non
 * riesce a usare i codici che il bot gli da'». Le cause sono state TRE, e sono
 * state trovate una dietro l'altra:
 *
 *  1. **I trattini.** Telegram rende cliccabile un comando solo se e' fatto di
 *     `[A-Za-z0-9_]`: si fermava al primo `-` e toccando
 *     `/invia_d8f8ad16-29db-...` mandava `/invia_d8f8ad16` — troncato e inutile.
 *     Cura: emettere il codice senza trattini, accettarlo in entrambe le forme.
 *  2. **La lunghezza.** Telegram riconosce come comando `/` + al massimo **32
 *     caratteri**. `invia_` + 32 cifre esadecimali fa **38**: oltre il limite,
 *     quindi nemmeno cliccabile. Cura: il codice emesso si accorcia a **16
 *     cifre** (`LUNGHEZZA_CODICE_BREVE`), e `/invia_` + 16 fa **22**.
 *  3. **Il Markdown.** Un messaggio con due comandi porta due `_`, e nel
 *     Markdown classico una coppia di underscore delimita il corsivo: Telegram
 *     li mangia e all'Ingegnere arriva `/inviaXXXX`. Quella cura non sta qui ma
 *     in `telegram-helpers.ts`, e usa `contieneComandoConCodice` (sotto) per
 *     decidere quali messaggi partono SENZA `parse_mode`.
 *
 * ⚠️ Il ripiego senza `parse_mode` che esisteva in `sendTelegramMessageChecked`
 * NON copriva il caso 3: scatta quando Telegram *rigetta* il Markdown, e qui il
 * Markdown e' valido — lo rende, e basta.
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
 * Quante cifre esadecimali ha il codice che il bot EMETTE.
 *
 * Sedici, non trentadue: `/` + `invia_` + 32 fa 38 caratteri e Telegram si
 * ferma a 32, quindi il comando non diventa nemmeno cliccabile. Con 16 il
 * comando piu' lungo che emettiamo — `/accesso_ok2_` + 16 = 29 — resta sotto il
 * limite.
 *
 * Sedici cifre sono 2^64 valori: su una manciata di bozze contemporanee la
 * collisione e' irrilevante, e quando c'e' **non si indovina** — si dichiara
 * l'ambiguita' (vedi `risolviPrefisso`).
 */
export const LUNGHEZZA_CODICE_BREVE = 16

/** La forma del codice CORTO in un comando: 16 cifre esadecimali. */
const CODICE_BREVE = `([0-9a-f]{${LUNGHEZZA_CODICE_BREVE}})`

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

export type ComandoConCodice = (typeof COMANDI_CON_CODICE)[number]

/**
 * Dove vive la bozza di ogni famiglia di comandi: l'unico modo per risolvere un
 * codice CORTO e' cercare la riga il cui identificativo comincia con quelle 16
 * cifre, e per cercarla bisogna sapere in quale tabella e su quale colonna.
 *
 * ⚠️ Qui ci sono solo dati (due stringhe per famiglia), nessun accesso al
 * database: la lettura sta in `comandi-risolvi.ts`, così questo modulo resta
 * puro e testabile senza mock.
 *
 * 🚨 **L'assenza di una famiglia non e' una dimenticanza, e' la guardia.**
 * `codiceDaEmettere` accorcia il codice **solo** per le famiglie elencate qui:
 * una famiglia che non si sa risolvere continua a ricevere il codice LUNGO, e
 * non puo' quindi ritrovarsi con un codice corto che nessuno sa espandere.
 * Le tre famiglie `fic_*` sono fuori di proposito: quel flusso scrive i suoi
 * comandi a mano in `fic-write-tools.ts` senza passare da qui, e non va
 * toccato ([[cervellone-fic-ramo-non-mergiare]]).
 */
export const ORIGINE_CODICE: Partial<
  Record<ComandoConCodice, { tabella: string; colonna: string }>
> = {
  // ⚠️ La chiave di questa tabella e' `uuid`, non `id`: e' il difetto A2 della
  // lista di controllo (un nome di colonna scritto a mano che non esiste).
  invia: { tabella: 'cervellone_email_pending_send', colonna: 'uuid' },
  annulla: { tabella: 'cervellone_email_pending_send', colonna: 'uuid' },
  conferma: { tabella: 'cervellone_doc_proposte', colonna: 'id' },
  ignora: { tabella: 'cervellone_doc_proposte', colonna: 'id' },
  accesso_ok2: { tabella: 'cervellone_drive_policy_pending', colonna: 'id' },
  accesso_ok: { tabella: 'cervellone_drive_policy_pending', colonna: 'id' },
  accesso_no: { tabella: 'cervellone_drive_policy_pending', colonna: 'id' },
  condividi_ok: { tabella: 'cervellone_share_proposte', colonna: 'id' },
  sal_ok2: { tabella: 'cervellone_sal_pending', colonna: 'id' },
  sal_ok: { tabella: 'cervellone_sal_pending', colonna: 'id' },
  sal_no: { tabella: 'cervellone_sal_pending', colonna: 'id' },
  regola_ok2: { tabella: 'cervellone_regole', colonna: 'id' },
  regola_ok: { tabella: 'cervellone_regole', colonna: 'id' },
  regola_no: { tabella: 'cervellone_regole', colonna: 'id' },
  regola_via: { tabella: 'cervellone_regole', colonna: 'id' },
}

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

/** Le 32 cifre esadecimali di un uuid, o `null` se non è un uuid canonico. */
function cifreDi(uuid: string): string | null {
  const soloHex = uuid.replace(/-/g, '')
  // ⚠️ Guardia trovata dai test: se l'identificativo NON è un uuid canonico
  // (32 cifre esadecimali), togliergli i trattini lo MUTILA — `id-1` diventa
  // `id1`, un codice che non corrisponde a niente. Togliamo i trattini solo
  // quando sappiamo di avere un uuid; tutto il resto passa intatto.
  if (!/^[0-9a-f]{32}$/i.test(soloHex)) return null
  return soloHex.toLowerCase()
}

/**
 * Il codice da mettere nel comando di QUESTA famiglia.
 *
 * - famiglia risolvibile (sta in `ORIGINE_CODICE`) → **16 cifre**, così il
 *   comando resta sotto i 32 caratteri di Telegram;
 * - famiglia non risolvibile → le 32 cifre senza trattini, come prima: un
 *   codice corto che nessuno sa espandere sarebbe inutilizzabile;
 * - identificativo che non è un uuid (`id-1`, `P1`) → **intatto**.
 */
export function codiceDaEmettere(nome: string, uuid: string): string {
  const cifre = cifreDi(uuid)
  if (cifre === null) return uuid
  const risolvibile = ORIGINE_CODICE[nome as ComandoConCodice] !== undefined
  return risolvibile ? cifre.slice(0, LUNGHEZZA_CODICE_BREVE) : cifre
}

/**
 * Il comando completo da mostrare all'utente, già pronto: `/invia_<16 hex>`.
 * Un posto solo da cui escono, così suggerimento e parser non possono
 * divergere.
 */
export function comandoDaMostrare(nome: string, uuid: string): string {
  return `/${nome}_${codiceDaEmettere(nome, uuid)}`
}

/**
 * Riconosce `/<nome>_<uuid>` in testa al messaggio nella forma LUNGA (32 cifre,
 * con o senza trattini) e ritorna l'uuid CANONICO pronto per il database.
 * `null` se il messaggio non è quel comando in quella forma.
 *
 * Il codice CORTO non si può risolvere qui — serve il database — e sta in
 * `comandoPrefisso` + `risolviPrefisso`.
 */
export function comandoUuid(testo: string, nome: string): string | null {
  const m = testo.match(new RegExp(`^/${nome}_${UUID_FLESSIBILE}\\b`, 'i'))
  if (!m) return null
  return normalizzaUuid(m[1])
}

/**
 * Riconosce `/<nome>_<16 cifre>` in testa al messaggio e ritorna quelle 16
 * cifre in minuscolo. `null` se non è quel comando in forma corta.
 *
 * ⚠️ Non collide con la forma lunga: dopo 16 cifre esadecimali di un codice da
 * 32 c'è un'altra cifra, che è un carattere di parola, e `\b` non morde. E un
 * uuid coi trattini ha un `-` alla nona posizione, quindi non arriva a 16 cifre
 * consecutive. Misurato dai test, non dedotto.
 */
export function comandoPrefisso(testo: string, nome: string): string | null {
  const m = testo.match(new RegExp(`^/${nome}_${CODICE_BREVE}\\b`, 'i'))
  if (!m) return null
  return m[1].toLowerCase()
}

/** L'esito della risoluzione di un codice corto contro le bozze esistenti. */
export type EsitoPrefisso =
  | { ok: true; uuid: string }
  | { ok: false; motivo: 'assente' }
  | { ok: false; motivo: 'ambiguo'; quanti: number }

/**
 * Da 16 cifre all'uuid intero, cercando fra i candidati quello che COMINCIA con
 * quelle cifre.
 *
 * 🚨 **La guardia che conta.** Se il prefisso corrisponde a più di una bozza
 * NON si sceglie la più recente: si torna `ambiguo`, e chi chiama deve dirlo e
 * chiedere il codice lungo. Scegliere «la più recente» sarebbe esattamente il
 * difetto che l'invariante di questo modulo vieta — *un codice accettato non
 * può mai portare a un uuid diverso da quello scritto* — perché l'Ingegnere
 * tocca il comando di UNA bozza precisa e la mail partirebbe a un ALTRO
 * destinatario.
 *
 * L'invariante vale anche in caso di successo: l'uuid tornato comincia sempre
 * con le cifre scritte, perché è l'unica condizione con cui entra in `trovati`.
 */
export function risolviPrefisso(prefisso: string, candidati: string[]): EsitoPrefisso {
  const cercato = prefisso.replace(/-/g, '').toLowerCase()
  const trovati = new Set<string>()
  for (const candidato of candidati) {
    const piatto = String(candidato ?? '').replace(/-/g, '').toLowerCase()
    if (piatto.length === 32 && piatto.startsWith(cercato)) trovati.add(normalizzaUuid(piatto))
  }
  if (trovati.size === 0) return { ok: false, motivo: 'assente' }
  if (trovati.size > 1) return { ok: false, motivo: 'ambiguo', quanti: trovati.size }
  return { ok: true, uuid: [...trovati][0] }
}

/**
 * Gli estremi entro cui cercare un uuid che comincia con `prefisso`.
 *
 * Serve a interrogare il database per INTERVALLO (`>= da` e `<= a`) invece che
 * con un `like`: la colonna è di tipo `uuid` in Postgres, e `like` su `uuid` non
 * ha un operatore — fallirebbe. L'ordinamento degli uuid è quello dei byte,
 * quindi coincide con quello delle cifre esadecimali minuscole.
 */
export function intervalloPrefisso(prefisso: string): { da: string; a: string } {
  const cifre = prefisso.replace(/-/g, '').toLowerCase()
  const mancanti = 32 - cifre.length
  return {
    da: normalizzaUuid(cifre + '0'.repeat(mancanti)),
    a: normalizzaUuid(cifre + 'f'.repeat(mancanti)),
  }
}

/**
 * Vera se il testo contiene, in qualunque posizione, uno dei nostri comandi con
 * un codice attaccato.
 *
 * 🚨 A cosa serve: un messaggio così NON va mandato a Telegram con
 * `parse_mode: 'Markdown'`. Ogni comando porta un `_`, e due comandi nello
 * stesso messaggio — «Per inviare: /invia_… · Per annullare: /annulla_…» —
 * danno una COPPIA di underscore, che nel Markdown classico delimita il
 * corsivo: Telegram li mangia e all'Ingegnere arriva `/inviaXXXX`, un comando
 * che non esiste. Telegram rende cliccabile `/comando` anche nel testo
 * semplice, quindi il prezzo è il grassetto **di quei soli messaggi**.
 *
 * Deliberatamente larga (`[A-Za-z0-9_-]` dopo il `_`): prende anche i codici
 * che non sono uuid (`/condividi_ok_id-1`) e i comandi FIC scritti a mano, che
 * hanno lo stesso problema. Un falso positivo costa il grassetto di un
 * messaggio; un falso negativo costa un comando mutilato.
 */
export function contieneComandoConCodice(testo: string): boolean {
  return COMANDI_CON_CODICE.some((nome) =>
    new RegExp(`/${nome}_[A-Za-z0-9_-]`, 'i').test(testo),
  )
}

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
 * ⚠️ Un codice CORTO ben formato (16 cifre) di una famiglia risolvibile non è
 * «rotto»: è la forma che emettiamo noi. Senza questa riga il nostro stesso
 * comando si sarebbe autodenunciato come illeggibile.
 *
 * @returns il nome del comando riconosciuto, o `null` se non è un nostro comando
 */
export function comandoDalCodiceRotto(testo: string): string | null {
  for (const nome of COMANDI_CON_CODICE) {
    // `^/<nome>_` seguito da qualcosa che non è un codice valido.
    if (!new RegExp(`^/${nome}_`, 'i').test(testo)) continue
    if (comandoUuid(testo, nome) !== null) return null // il codice lungo si legge
    if (ORIGINE_CODICE[nome] !== undefined && comandoPrefisso(testo, nome) !== null) {
      return null // il codice corto si legge: lo risolve `comandi-risolvi.ts`
    }
    return nome
  }
  return null
}
