/**
 * Congela in JSON quello che le migrazioni del repo promettono.
 *
 * Si rigenera con `npm run genera:attesi` ogni volta che si aggiunge una
 * migrazione. Se ci si dimentica, `deriva-schema-attesi.test.ts` fa morire la
 * suite: un elenco scritto a mano invecchia in silenzio, ed e' esattamente il
 * difetto che questo guardiano esiste per uccidere.
 */
import fs from 'fs'
import path from 'path'
import { oggettiAttesi } from '../src/lib/deriva-schema'

const CARTELLA = path.join(process.cwd(), 'supabase', 'migrations')
const USCITA = path.join(process.cwd(), 'src', 'lib', 'deriva-schema-attesi.json')

const nomi = fs.readdirSync(CARTELLA).filter((n) => n.endsWith('.sql')).sort()
const risultato = oggettiAttesi(
  nomi.map((nome) => ({ nome, sql: fs.readFileSync(path.join(CARTELLA, nome), 'utf8') })),
)

fs.writeFileSync(USCITA, JSON.stringify(risultato, null, 2) + '\n', 'utf8')
console.log(
  `[attesi] ${nomi.length} migrazioni -> ${risultato.oggetti.length} oggetti attesi, `
  + `${risultato.nonInterpretate.length} statement non interpretati.`,
)
