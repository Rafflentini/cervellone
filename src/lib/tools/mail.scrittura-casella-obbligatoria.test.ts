import { describe, it, expect } from 'vitest'
// ⚠️ Import da '../politica-caselle', MAI da './mail': un test che importa
// mail.ts si porta dietro googleapis e mezzo mondo — in questo repo e' gia'
// costato un test caduto per timeout (14 settembre 2026, vedi il commento in
// testa a politica-caselle.ts). casellaPerScrittura vive li' apposta.
import { casellaPerScrittura, TOOL_GMAIL_CHE_SCRIVONO } from '../politica-caselle'

describe('scrittura: la casella non si deduce', () => {
  it('🚨 senza casella si RIFIUTA, e dice quali sono', () => {
    const r = casellaPerScrittura({})

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.messaggio).toContain('larealestate')
      expect(r.messaggio).toContain('drive')
    }
  })

  it('🚨 una casella non valida NON diventa quella di Restruktura', () => {
    const r = casellaPerScrittura({ casella: 'inventata' })
    expect(r.ok).toBe(false)
  })

  it('CONTROLLO POSITIVO: con la casella indicata, passa', () => {
    // Senza questo, una funzione che rifiuta SEMPRE passerebbe i due test qui
    // sopra — e avremmo murato l'invio delle mail senza accorgercene.
    const r = casellaPerScrittura({ casella: 'larealestate' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.casella).toBe('larealestate')
  })

  it("l'elenco dei tool che scrivono copre invii, bozze, etichette e cestino", () => {
    // Un elenco che dimentica un tool lascia una porta aperta, e nessuno se ne
    // accorge finche' una mail non parte dall'indirizzo sbagliato.
    for (const nome of [
      'gmail_create_draft', 'gmail_send_draft', 'gmail_delete_draft',
      'gmail_apply_label', 'gmail_remove_label',
      'gmail_archive', 'gmail_trash', 'gmail_mark_read',
    ]) {
      expect(TOOL_GMAIL_CHE_SCRIVONO).toContain(nome)
    }
  })
})
