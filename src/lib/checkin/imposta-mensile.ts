/**
 * L'imposta di soggiorno spezzata sui mesi in cui i pernottamenti cadono
 * DAVVERO.
 *
 * ── Perche' serve ────────────────────────────────────────────────────────────
 * La pagina di gestione raggruppa le prenotazioni per mese di ARRIVO, ed e'
 * giusto cosi': "chi e' arrivato a settembre" e' la domanda di chi gestisce.
 * Ma la dichiarazione al Comune non chiede gli arrivi: chiede i
 * **pernottamenti del mese** (artt. 6-7 del Regolamento di Maratea, entro il
 * giorno 16 del mese successivo, anche a zero, con sanzione da 25 a 500 € piu'
 * il 30% dell'omesso versamento).
 *
 * Un soggiorno 29/09 → 02/10 sono tre notti: due di settembre e una di ottobre.
 * Dichiararle tutte a settembre e' una dichiarazione sbagliata in DUE mesi, e
 * l'errore ha esattamente l'aria di un dato giusto.
 *
 * ── Come si ripartisce ───────────────────────────────────────────────────────
 * Le notti tassate sono le PRIME `maxPernottamenti` del soggiorno (art. 5
 * lett. a: dal sesto pernottamento consecutivo si e' esenti), fra quelle che
 * cadono in stagione. L'imposta e' `tariffa x paganti x nottiTassabili`, cioe'
 * uniforme su ogni notte tassata: per ripartirla basta sapere in quale mese
 * cade ognuna. Non serve rileggere gli ospiti — e infatti non li si rilegge:
 * il totale gia' scritto sulla riga resta la verita', qui si decide solo dove
 * collocarlo.
 */
import type { RegoleImposta } from './imposta-soggiorno'

const MS_GIORNO = 86_400_000

function dataISO(v: string): Date | null {
  const s = String(v ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 'gg/mm' → [giorno, mese]. */
function ggmm(v: string): [number, number] {
  const [g, m] = String(v ?? '').split('/').map(Number)
  return [g || 1, m || 1]
}

/** Copia della regola di stagione di imposta-soggiorno.ts, sulla stessa forma. */
function notteInStagione(giorno: Date, regole: RegoleImposta): boolean {
  const [gVig, mVig, aVig] = String(regole.inVigoreDal ?? '').split('/').map(Number)
  if (aVig) {
    const vigore = new Date(Date.UTC(aVig, (mVig || 1) - 1, gVig || 1))
    if (giorno < vigore) return false
  }
  const anno = giorno.getUTCFullYear()
  const [gDal, mDal] = ggmm(regole.stagioneDal)
  const [gAl, mAl] = ggmm(regole.stagioneAl)
  const dal = new Date(Date.UTC(anno, mDal - 1, gDal))
  const al = new Date(Date.UTC(anno, mAl - 1, gAl, 23, 59, 59))
  return giorno >= dal && giorno <= al
}

export type NottiDelMese = { mese: string; notti: number }

/**
 * Le notti TASSATE del soggiorno, contate per mese di calendario ('AAAA-MM').
 * Una notte appartiene al mese del giorno in cui si dorme, non a quello
 * dell'arrivo.
 */
export function nottiTassatePerMese(
  checkin: string,
  checkout: string,
  regole: RegoleImposta,
): NottiDelMese[] {
  const ci = dataISO(checkin)
  const co = dataISO(checkout)
  if (!ci || !co) return []

  const notti = Math.round((co.getTime() - ci.getTime()) / MS_GIORNO)
  if (notti <= 0) return []

  // Solo le prime `maxPernottamenti`: dal sesto in poi si e' esenti.
  const daConteggiare = Math.min(notti, Math.max(0, regole.maxPernottamenti))

  const perMese = new Map<string, number>()
  for (let i = 0; i < daConteggiare; i++) {
    const notte = new Date(ci.getTime() + i * MS_GIORNO)
    if (!notteInStagione(notte, regole)) continue
    const mese = notte.toISOString().slice(0, 7)
    perMese.set(mese, (perMese.get(mese) ?? 0) + 1)
  }

  return [...perMese.entries()]
    .map(([mese, n]) => ({ mese, notti: n }))
    .sort((a, b) => a.mese.localeCompare(b.mese))
}

export type ImpostaDelMese = { mese: string; notti: number; importo: number }

/**
 * Ripartisce sull'arco dei mesi l'imposta GIA' calcolata per il soggiorno.
 *
 * Si parte dal totale scritto sulla riga e non lo si ricalcola: quel totale
 * tiene conto delle esenzioni per eta' e di quelle dichiarate a mano, che qui
 * non si vedono. Ricalcolarlo con meno informazioni vorrebbe dire produrre un
 * secondo numero, diverso dal primo e altrettanto plausibile.
 */
export function ripartisciImposta(
  impostaTotale: number,
  checkin: string,
  checkout: string,
  regole: RegoleImposta,
): ImpostaDelMese[] {
  const mesi = nottiTassatePerMese(checkin, checkout, regole)
  const totaleNotti = mesi.reduce((s, m) => s + m.notti, 0)
  if (totaleNotti === 0) return []

  const ripartito = mesi.map((m) => ({
    mese: m.mese,
    notti: m.notti,
    importo: arrotonda((impostaTotale * m.notti) / totaleNotti),
  }))

  // I centesimi persi negli arrotondamenti si rimettono sull'ultimo mese: la
  // somma delle parti deve fare ESATTAMENTE il totale, altrimenti la
  // dichiarazione e il versamento non tornano fra loro.
  const somma = arrotonda(ripartito.reduce((s, m) => s + m.importo, 0))
  const scarto = arrotonda(impostaTotale - somma)
  if (scarto !== 0 && ripartito.length > 0) {
    const ultimo = ripartito[ripartito.length - 1]
    ultimo.importo = arrotonda(ultimo.importo + scarto)
  }

  return ripartito
}

function arrotonda(n: number): number {
  return Math.round(n * 100) / 100
}

/** Il 16 del mese successivo: il termine di dichiarazione e versamento. */
export function scadenzaDichiarazione(mese: string): string {
  const [anno, m] = mese.split('-').map(Number)
  const dopo = new Date(Date.UTC(anno, m, 16))
  return dopo.toISOString().slice(0, 10)
}
