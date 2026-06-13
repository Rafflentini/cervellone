import { describe, it, expect } from 'vitest'
import { splitRecentOlder, clusterByTime, type PendingRow } from './foto-archive-pending'

// Helper: costruisce una PendingRow deterministica da un ISO timestamp.
function row(id: string, createdAt: string): PendingRow {
  return { id, drive_file_id: `drv-${id}`, filename: `${id}.jpg`, created_at: createdAt, stato: 'in_attesa' }
}

// "Ora" di riferimento deterministica per tutti i test di split.
const NOW_ISO = '2026-06-13T12:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

describe('splitRecentOlder', () => {
  it('riga di 10h fa → recent', () => {
    const r = row('a', '2026-06-13T02:00:00.000Z') // 10h prima di NOW
    const { recent, older } = splitRecentOlder([r], NOW_MS)
    expect(recent.map(x => x.id)).toEqual(['a'])
    expect(older).toEqual([])
  })

  it('riga di 50h fa → older', () => {
    const r = row('b', '2026-06-11T10:00:00.000Z') // 50h prima di NOW
    const { recent, older } = splitRecentOlder([r], NOW_MS)
    expect(recent).toEqual([])
    expect(older.map(x => x.id)).toEqual(['b'])
  })

  it('vuoto → { recent: [], older: [] }', () => {
    const { recent, older } = splitRecentOlder([], NOW_MS)
    expect(recent).toEqual([])
    expect(older).toEqual([])
  })

  it('separa correttamente un mix recenti/vecchie preservando le righe', () => {
    const rows = [
      row('recent1', '2026-06-13T08:00:00.000Z'), // 4h fa
      row('old1', '2026-06-10T12:00:00.000Z'),    // 72h fa
      row('recent2', '2026-06-13T11:00:00.000Z'), // 1h fa
    ]
    const { recent, older } = splitRecentOlder(rows, NOW_MS)
    expect(recent.map(x => x.id).sort()).toEqual(['recent1', 'recent2'])
    expect(older.map(x => x.id)).toEqual(['old1'])
  })

  it('created_at non parsabile → trattata come older (conservativo)', () => {
    const r = row('bad', 'not-a-date')
    const { recent, older } = splitRecentOlder([r], NOW_MS)
    expect(recent).toEqual([])
    expect(older.map(x => x.id)).toEqual(['bad'])
  })
})

describe('clusterByTime', () => {
  it('5 righe entro 1 minuto → 1 gruppo', () => {
    const rows = [
      row('1', '2026-06-13T10:00:00.000Z'),
      row('2', '2026-06-13T10:00:10.000Z'),
      row('3', '2026-06-13T10:00:20.000Z'),
      row('4', '2026-06-13T10:00:40.000Z'),
      row('5', '2026-06-13T10:00:55.000Z'),
    ]
    const groups = clusterByTime(rows)
    expect(groups.length).toBe(1)
    expect(groups[0].length).toBe(5)
  })

  it('3 righe + gap 10 min + 2 righe → 2 gruppi', () => {
    const rows = [
      row('a1', '2026-06-13T10:00:00.000Z'),
      row('a2', '2026-06-13T10:00:30.000Z'),
      row('a3', '2026-06-13T10:01:00.000Z'),
      // gap di 10 minuti
      row('b1', '2026-06-13T10:11:00.000Z'),
      row('b2', '2026-06-13T10:11:20.000Z'),
    ]
    const groups = clusterByTime(rows)
    expect(groups.length).toBe(2)
    expect(groups[0].map(r => r.id)).toEqual(['a1', 'a2', 'a3'])
    expect(groups[1].map(r => r.id)).toEqual(['b1', 'b2'])
  })

  it('1 riga → 1 gruppo', () => {
    const groups = clusterByTime([row('solo', '2026-06-13T10:00:00.000Z')])
    expect(groups.length).toBe(1)
    expect(groups[0].map(r => r.id)).toEqual(['solo'])
  })

  it('vuoto → []', () => {
    expect(clusterByTime([])).toEqual([])
  })

  it('ordina per tempo anche se l\'input è disordinato', () => {
    const rows = [
      row('late', '2026-06-13T10:11:00.000Z'),
      row('early', '2026-06-13T10:00:00.000Z'),
    ]
    const groups = clusterByTime(rows)
    expect(groups.length).toBe(2)
    expect(groups[0].map(r => r.id)).toEqual(['early'])
    expect(groups[1].map(r => r.id)).toEqual(['late'])
  })
})
