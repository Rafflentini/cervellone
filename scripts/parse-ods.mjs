// Parser ODS prezziario — prende SEMPRE l'ultima colonna numerica come prezzo
import { readFileSync, writeFileSync } from 'fs'
import JSZip from 'jszip'

const file = process.argv[2] || 'prezziario_basilicata_2025.ods'
const regione = process.argv[3] || 'basilicata'
const anno = parseInt(process.argv[4] || '2025')

const data = readFileSync(file)
const zip = await JSZip.loadAsync(data)
const xml = await zip.file('content.xml').async('string')

const rows = xml.match(/<table:table-row[^>]*>[\s\S]*?<\/table:table-row>/g) || []
console.log(`Totale righe XML: ${rows.length}`)

const voci = []
for (const row of rows) {
  const cells = []
  const re = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
  let m
  while ((m = re.exec(row)) !== null) {
    const attrs = m[1] || ''
    const content = (m[2] || '').replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&apos;/g,"'").trim()
    const valueMatch = attrs.match(/office:value="([^"]*)"/)
    const value = valueMatch ? valueMatch[1] : ''
    const repeatMatch = attrs.match(/table:number-columns-repeated="(\d+)"/)
    if (repeatMatch && !content && !value) {
      for (let i = 0; i < Math.min(parseInt(repeatMatch[1]), 10); i++) cells.push({ text: '', value: '' })
    } else {
      cells.push({ text: content, value })
    }
  }

  if (cells.length < 3) continue
  const codice = cells[0]?.text || ''
  const descrizione = cells[1]?.text || ''
  if (!/^[A-Z]{2,5}\d{2}_/.test(codice)) continue
  if (!descrizione || descrizione.length < 5) continue

  // Prendi l'ULTIMO valore numerico tra le celle — è il prezzo unitario
  // (La colonna prima è "Sicurezza inclusa" che NON è il prezzo)
  let prezzo = 0
  let um = cells[2]?.text || ''

  // Cerca dal fondo: l'ultimo valore numerico valido è il prezzo
  for (let i = cells.length - 1; i >= 2; i--) {
    const val = cells[i]?.value || cells[i]?.text || ''
    // Skip percentuali (contengono %)
    if (val.toString().includes('%')) continue
    const num = parseFloat(val.toString().replace(',', '.'))
    if (!isNaN(num) && num > 0 && num < 999999) {
      prezzo = num
      break
    }
  }

  if (prezzo > 0) {
    voci.push({
      codice_voce: codice,
      descrizione: descrizione.slice(0, 500),
      unita_misura: um.toLowerCase().slice(0, 20),
      prezzo: Math.round(prezzo * 100) / 100,
    })
  }
}

console.log(`Voci con prezzo estratte: ${voci.length}`)
console.log(`\nPrime 5:`)
for (const v of voci.slice(0, 5)) {
  console.log(`  ${v.codice_voce} | ${v.descrizione.slice(0, 50)} | ${v.unita_misura} | € ${v.prezzo}`)
}

// Verifica voce nota: BAS25_B.14.020.01 deve essere 62.14, non 18.36
const test = voci.find(v => v.codice_voce === 'BAS25_B.14.020.01')
if (test) console.log(`\n✅ VERIFICA: ${test.codice_voce} = € ${test.prezzo} (atteso: 62.14)`)

const test2 = voci.find(v => v.codice_voce === 'BAS25_A.01.001.01')
if (test2) console.log(`✅ VERIFICA: ${test2.codice_voce} = € ${test2.prezzo} (atteso: 61.77)`)

writeFileSync('prezziario_parsed.json', JSON.stringify({ regione, anno, voci_count: voci.length, voci }, null, 2))
console.log(`\nSalvato in prezziario_parsed.json`)
