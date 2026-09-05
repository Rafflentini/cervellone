import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AUTOMAZIONI, AUTOMAZIONI_TOOLS } from './automazioni'

type CronVercel = { path: string; schedule: string }

function cronDaVercelJson(): CronVercel[] {
  const contenuto = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons?: CronVercel[] }
  return contenuto.crons ?? []
}

describe('registro delle automazioni', () => {
  // Il 5 settembre 2026 il bot ha risposto all'Ingegnere che NON aveva
  // l'automazione delle fatture estere e non sapeva costruirla. Girava da
  // maggio. Il motivo: Cervellone conosce se stesso attraverso l'elenco dei
  // propri tool, e un cron non e' un tool.
  //
  // Il registro chiude quel buco, ma un registro scritto a mano puo' scadere —
  // e un elenco che mente e' peggio di un elenco che manca. Questi test sono il
  // patto: se qualcuno aggiunge un cron senza registrarlo, la suite muore.

  it('ogni cron di vercel.json sta nel registro', () => {
    const mancanti = cronDaVercelJson()
      .map((c) => c.path)
      .filter((percorso) => !AUTOMAZIONI.some((a) => a.percorso === percorso))

    expect(mancanti, `automazioni pianificate ma non registrate: ${mancanti.join(', ')}`).toEqual([])
  })

  it('il registro non inventa automazioni che non esistono', () => {
    const percorsiVeri = new Set(cronDaVercelJson().map((c) => c.path))
    const inventate = AUTOMAZIONI.map((a) => a.percorso).filter((p) => !percorsiVeri.has(p))

    expect(inventate, `registrate ma non pianificate: ${inventate.join(', ')}`).toEqual([])
  })

  it("la pianificazione dichiarata e' quella vera, non una copia invecchiata", () => {
    const vere = new Map(cronDaVercelJson().map((c) => [c.path, c.schedule]))
    const discordanti = AUTOMAZIONI.filter((a) => vere.get(a.percorso) !== a.pianificazione).map(
      (a) => `${a.percorso}: registro "${a.pianificazione}" vs vercel.json "${vere.get(a.percorso)}"`,
    )

    expect(discordanti).toEqual([])
  })

  it('ogni automazione dice cosa fa e quando, in italiano', () => {
    for (const a of AUTOMAZIONI) {
      expect(a.nome.length, `nome vuoto per ${a.percorso}`).toBeGreaterThan(3)
      expect(a.quando.length, `quando vuoto per ${a.percorso}`).toBeGreaterThan(5)
      expect(a.cosaFa.length, `cosaFa troppo corto per ${a.percorso}`).toBeGreaterThan(30)
    }
  })

  it('le fatture estere si possono lanciare a richiesta, senza aspettare il 1 del mese', () => {
    const fatture = AUTOMAZIONI.find((a) => a.percorso === '/api/cron/monthly-foreign-invoices')

    expect(fatture?.invocabile).toBe('raccogli_fatture_estere')
    expect(AUTOMAZIONI_TOOLS.map((t) => t.name)).toContain('raccogli_fatture_estere')
  })

  it("il tool per elencarle esiste e dice esplicitamente di usarlo prima di negare l'esistenza di un'automazione", () => {
    const elenca = AUTOMAZIONI_TOOLS.find((t) => t.name === 'elenca_automazioni')

    expect(elenca).toBeDefined()
    // La descrizione e' l'unica cosa che il modello legge prima di decidere se
    // chiamare il tool: se non dice il PERCHE', l'errore del 5 settembre si
    // ripete anche col tool disponibile.
    expect(elenca!.description).toContain('NON compaiono nell elenco dei tool')
  })
})
