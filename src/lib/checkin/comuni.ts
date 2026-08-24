/**
 * src/lib/checkin/comuni.ts
 *
 * I comuni italiani: nome, sigla di provincia, codice catastale, CAP.
 *
 * Stanno nel CODICE e non nel foglio. Il foglio e' il posto dove l'Ingegnere
 * mette mano, e nessuno mette mano a ottomila righe: ce le troverebbe soltanto
 * fra i piedi, e il foglio diventerebbe lento da aprire sul telefono, che e'
 * dove serve. La scheda `Tabelle` resta per le ECCEZIONI, e quelle vincono su
 * queste (vedi `cercaLuogo`).
 *
 * Due proprieta' misurate sui dati, non supposte:
 *
 *  - **44 comuni su 7904 hanno piu' di un CAP** (Roma 82, Milano 42). Per quelli
 *    il CAP qui e' VUOTO. Sceglierne uno a caso significherebbe scrivere in
 *    fattura un indirizzo sbagliato che sembra giusto — e un indirizzo che
 *    sembra giusto non lo ricontrolla nessuno.
 *  - **Sei nomi sono condivisi da due comuni diversi**, con codice catastale
 *    diverso: CALLIANO (AT/TN), CASTRO (BG/LE), LIVO (CO/TN), PEGLIO (CO/PU),
 *    SAMONE (TO/TN), SAN TEODORO (ME/SS). Cercare per solo nome vorrebbe dire
 *    restituire il codice fiscale di un'altra persona. Per questo la ricerca
 *    accetta la sigla, e l'elenco mostra sempre "NOME (SIGLA)".
 */

import comuniGrezzi from './dati/comuni.json'

export interface Comune {
  nome: string
  sigla: string
  catastale: string
  /** Vuoto quando il comune ha piu' di un CAP: va scritto a mano. */
  cap: string
}

/** [nome, sigla, catastale, cap] — formato compatto per non gonfiare il bundle. */
type RigaComune = [string, string, string, string]

let cache: Comune[] | null = null

export function tuttiIComuni(): Comune[] {
  if (!cache) {
    cache = (comuniGrezzi as RigaComune[]).map(([nome, sigla, catastale, cap]) => ({
      nome, sigla, catastale, cap,
    }))
  }
  return cache
}

/** Confronto insensibile ad accenti, apostrofi, spazi e maiuscole. */
export function chiave(s: string): string {
  return String(s || '')
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, 'A').replace(/[ÈÉÊË]/g, 'E').replace(/[ÌÍÎÏ]/g, 'I')
    .replace(/[ÒÓÔÕÖ]/g, 'O').replace(/[ÙÚÛÜ]/g, 'U')
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * Cerca i comuni il cui nome comincia con `q`, poi quelli che lo contengono.
 * Chi digita "mar" cerca quasi sempre Maratea, non Casalmaggiore: mettere prima
 * le corrispondenze iniziali evita di dover scorrere.
 */
export function cercaComuni(q: string, limite = 20): Comune[] {
  const k = chiave(q)
  if (k.length < 2) return []

  const inizio: Comune[] = []
  const dentro: Comune[] = []
  for (const c of tuttiIComuni()) {
    const kc = chiave(c.nome)
    if (kc.startsWith(k)) inizio.push(c)
    else if (kc.includes(k)) dentro.push(c)
    if (inizio.length >= limite) break
  }
  return [...inizio, ...dentro].slice(0, limite)
}

/**
 * Il comune esatto. `sigla` e' facoltativa, ma senza di essa un nome omonimo
 * resta ambiguo: in quel caso si restituisce null invece di scegliere.
 */
export function trovaComune(nome: string, sigla?: string): Comune | null {
  const k = chiave(nome)
  const candidati = tuttiIComuni().filter((c) => chiave(c.nome) === k)
  if (candidati.length === 0) return null
  if (candidati.length === 1) return candidati[0]

  const s = chiave(sigla ?? '')
  if (!s) return null // omonimi senza provincia: non si tira a indovinare
  return candidati.find((c) => chiave(c.sigla) === s) ?? null
}

/** Etichetta mostrata nell'elenco: il nome da solo non basta per gli omonimi. */
export function etichetta(c: Comune): string {
  return `${c.nome} (${c.sigla})`
}
