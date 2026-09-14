import { describe, it, expect } from 'vitest'
import { getCasella, listaCaselle, caselleDiTrasporto, risolviCasella } from './caselle'
import { ACCOUNT_KEYS } from '@/v19/tools/email/config'

describe('il registro delle caselle', () => {
  it('ha quattro caselle, e ciascuna sa a quale societa appartiene', () => {
    const tutte = listaCaselle()
    expect(tutte).toHaveLength(4)
    expect(tutte.map((c) => c.chiave).sort()).toEqual(['drive', 'info', 'larealestate', 'raffaele'])
    expect(getCasella('larealestate').societa).toBe('larealestate')
    expect(getCasella('drive').societa).toBe('restruktura')
    expect(getCasella('info').societa).toBe('restruktura')
  })

  it('🚨 dichiara il NOME della credenziale, mai il suo valore', () => {
    // Stessa regola di societa.ts: i segreti non stanno in un registro.
    expect(getCasella('larealestate').accountEmail).toBe('larealestate.amministrazione@gmail.com')
    expect(getCasella('drive').accountEmail).toBe('restruktura.drive@gmail.com')
    // Le TopHost non hanno un account Google, e non devono fingere di averlo.
    expect(getCasella('info').accountEmail).toBeUndefined()
  })

  it('divide le caselle per trasporto', () => {
    expect(caselleDiTrasporto('google').map((c) => c.chiave).sort()).toEqual(['drive', 'larealestate'])
    expect(caselleDiTrasporto('tophost').map((c) => c.chiave).sort()).toEqual(['info', 'raffaele'])
  })

  it('🚨 le chiavi TopHost sono LE STESSE di AccountKey, non altre', () => {
    // Due elenchi della stessa cosa divergono al primo cambiamento: qui si
    // controlla che il registro nuovo ABBIA ASSORBITO quello vecchio invece di
    // affiancarglisi. In questo repo il terzo posto dove la stessa verita' e'
    // scritta diversa e' la ferita che si riapre di continuo.
    //
    // ⚠️ Fino al 14 settembre 2026 il lato destro era un letterale
    // `['info', 'raffaele']` scritto QUI: una TERZA copia, non un confronto —
    // sarebbe rimasta verde anche se `AccountKey` fosse cambiato (audit
    // avversariale). `ACCOUNT_KEYS` e' un valore a runtime che il compilatore
    // obbliga a combaciare con `AccountKey` (vedi config.ts): un confronto
    // vero, non una promessa.
    const daTrasporto: string[] = caselleDiTrasporto('tophost').map((c) => c.chiave).sort()
    const daAccountKey: string[] = [...ACCOUNT_KEYS].sort()
    expect(daTrasporto).toEqual(daAccountKey)
  })

  it('riconosce la casella nominata nel testo, e NON indovina', () => {
    expect(risolviCasella('guarda su info@')).toBe('info')
    expect(risolviCasella('nella casella di la real estate')).toBe('larealestate')
    expect(risolviCasella('cerca nella posta')).toBeNull()
    // Due nominate = ambiguo = null. Meglio chiedere che sceglierne una.
    expect(risolviCasella('confronta info@ e raffaele.lentini@')).toBeNull()
  })

  it('🚨 NON scatta sull\'indirizzo di un terzo (falso positivo)', () => {
    // `\bdrive@` e `\braffaele@` sono suffissi larghi: scattano anche
    // sull'indirizzo di una persona che non ha nulla a che fare con le nostre
    // caselle. Qui un falso positivo e' peggio di un mancato riconoscimento:
    // fa credere che l'Ingegnere abbia nominato una casella che non ha nominato.
    expect(risolviCasella('scrivi a marco.drive@gmail.com')).toBeNull()
    expect(risolviCasella('scrivi a mario.raffaele@x.com')).toBeNull()
  })
})
