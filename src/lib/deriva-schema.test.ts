import { describe, it, expect } from 'vitest'
import { oggettiAttesi } from './deriva-schema'

describe('oggettiAttesi - cosa il repo PROMETTE che esista', () => {
  it('riconosce le cinque forme che sappiamo leggere', () => {
    const r = oggettiAttesi([{
      nome: '2026-01-01-prova.sql',
      sql: `
        CREATE TABLE IF NOT EXISTS tavola_uno (id bigint primary key);
        ALTER TABLE procedures ADD COLUMN IF NOT EXISTS output_preferences text[] NOT NULL DEFAULT '{}';
        ALTER TABLE gmail_processed_messages ADD PRIMARY KEY (message_id, bot_action);
        CREATE UNIQUE INDEX idx_prova ON tavola_uno (id);
        INSERT INTO cervellone_config (key, value) VALUES ('auto_debrief_enabled', 'false') ON CONFLICT (key) DO NOTHING;
      `,
    }])

    expect(r.oggetti).toContainEqual({ tipo: 'tabella', tabella: 'tavola_uno' })
    expect(r.oggetti).toContainEqual({ tipo: 'colonna', tabella: 'procedures', colonna: 'output_preferences' })
    expect(r.oggetti).toContainEqual({
      tipo: 'chiave_primaria', tabella: 'gmail_processed_messages', colonne: ['message_id', 'bot_action'],
    })
    expect(r.oggetti).toContainEqual({ tipo: 'indice', nome: 'idx_prova' })
    expect(r.oggetti).toContainEqual({ tipo: 'config', chiave: 'auto_debrief_enabled' })
  })

  it('quello che NON sa leggere lo DICHIARA, non lo ingoia', () => {
    // Senza questo, "nessuna deriva" finirebbe per voler dire "non ho guardato"
    // - che e' esattamente come output_preferences e' sopravvissuta tre mesi.
    const r = oggettiAttesi([{
      nome: '2026-01-02-strana.sql',
      sql: `CREATE OR REPLACE FUNCTION pippo() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;`,
    }])

    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toHaveLength(1)
    expect(r.nonInterpretate[0].file).toBe('2026-01-02-strana.sql')
    expect(r.nonInterpretate[0].testo).toContain('CREATE OR REPLACE FUNCTION')
  })

  it('i commenti SQL non diventano oggetti', () => {
    const r = oggettiAttesi([{
      nome: 'c.sql',
      sql: `-- ALTER TABLE finta ADD COLUMN IF NOT EXISTS bugiarda text;\nCREATE TABLE vera (id int);`,
    }])
    expect(r.oggetti).toEqual([{ tipo: 'tabella', tabella: 'vera' }])
  })

  it('DROP e ALTER ... DISABLE ROW LEVEL SECURITY non sono promesse: si dichiarano non lette', () => {
    // `2026-05-05-disable-rls-model-health.sql` e altre ~11 contengono questo
    // statement, e in produzione la realta' e' stata poi irrigidita al
    // contrario (RLS riacceso). Non e' una deriva da segnalare: e' una forma
    // che non sappiamo giudicare, e va detto invece che inventarsi un esito.
    const r = oggettiAttesi([{ nome: 'd.sql', sql: 'ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;' }])
    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO: un file vuoto non produce ne oggetti ne rumore', () => {
    // Senza questo, un parser che dichiara TUTTO non letto passerebbe il test
    // qui sopra e non troverebbe mai niente.
    const r = oggettiAttesi([{ nome: 'v.sql', sql: '   \n-- solo un commento\n' }])
    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toEqual([])
  })
})
