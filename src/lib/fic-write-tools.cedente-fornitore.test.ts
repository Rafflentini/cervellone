/**
 * src/lib/fic-write-tools.cedente-fornitore.test.ts — su una TD17 la
 * controparte sta nell'elenco FORNITORI.
 *
 * ⚠️ Questa riga e' stata messa, tolta e rimessa in dodici ore. Il test esiste
 * perche' non venga tolta una terza volta senza sapere perche'.
 *
 * LE PROVE, raccolte il 15 settembre 2026 — tre, indipendenti:
 *  1. L'XML di un'integrazione TD17 valida: `CedentePrestatore` = fornitore
 *     estero, `CessionarioCommittente` = la societa' italiana.
 *  2. Il form di Fatture in Cloud per una TD17: il campo della controparte si
 *     chiama «Fornitore», e la pagina avvisa «per questo TD sei solo cliente».
 *  3. Il tentativo vero: l'anagrafica Booking.com B.V. sta nell'elenco
 *     FORNITORI (id 54043577) e, letta fra i clienti, risponde 404.
 *
 * ⚠️ LA PRIMA VOLTA ERA STATA MESSA MALE. La notte prima l'avevo cambiata
 * basandomi sull'etichetta «DESTINATARIO» stampata su un PDF — un sintomo, non
 * una fonte — e l'avevo poi tolta perche' l'elenco fornitori rispondeva 403:
 * all'app di Fatture in Cloud mancava lo scope `entity.suppliers`. Togliere
 * era giusto ALLORA (forzarla avrebbe bloccato tutto), rimetterla e' giusto
 * ORA che il permesso c'e'. La differenza fra le due volte non e' il codice:
 * e' che la seconda volta c'erano le prove.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sorgente = readFileSync(join(process.cwd(), 'src/lib/fic-write-tools.ts'), 'utf8')

describe('la controparte di una TD17 si cerca fra i FORNITORI', () => {
  it('🚨 compila_autofattura passa il segmento suppliers', () => {
    expect(sorgente).toContain("resolveEntitaFic(r.fornitore, societa, r.fornitoreId, 'suppliers')")
  })

  it('🚨 non resta nessuna risoluzione del fornitore senza segmento', () => {
    // La forma esatta del difetto: senza il quarto argomento si cade sul
    // predefinito `clients`, e un id dell elenco fornitori li' da 404.
    expect(sorgente).not.toContain('resolveEntitaFic(r.fornitore, societa, r.fornitoreId)')
  })

  it('anche la registrazione della SPESA cerca fra i fornitori', () => {
    expect(sorgente).toContain("intero(input.fornitore_id), 'suppliers')")
  })

  it('CONTROLLO POSITIVO: la fattura al CLIENTE continua a cercare fra i clienti', () => {
    // Senza questo, spostare tutto sui fornitori passerebbe i test qui sopra e
    // manderebbe ogni ospite degli affitti brevi nell elenco sbagliato.
    expect(sorgente).toContain('resolveEntitaFic(cliente, societa, clienteId)')
  })

  it('il rifiuto dice DOVE va creato il fornitore, non solo che manca', () => {
    expect(sorgente).toContain('va creato fra i FORNITORI')
  })
})
