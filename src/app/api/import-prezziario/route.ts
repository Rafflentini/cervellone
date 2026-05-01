import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const maxDuration = 300

// Importa prezziario da file ODS/CSV caricato
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { regione, anno, content, format } = await request.json()

  if (!regione || !content) {
    return NextResponse.json({ error: 'Regione e contenuto richiesti' }, { status: 400 })
  }

  const year = anno || new Date().getFullYear()
  const voci: { codice_voce: string; descrizione: string; unita_misura: string; prezzo: number }[] = []

  if (format === 'ods-text') {
    // Contenuto già estratto come testo (righe separate da \n, celle da |)
    const lines = content.split('\n')
    for (const line of lines) {
      const cells = line.split(' | ').map((c: string) => c.trim())
      if (cells.length < 3) continue
      const codice = cells[0]
      if (!/^[A-Z]{2,5}\d{2}_/.test(codice)) continue
      const descrizione = cells[1]
      if (!descrizione || descrizione.length < 5) continue

      let prezzo = 0
      for (let i = 2; i < cells.length; i++) {
        const num = parseFloat(cells[i].replace(',', '.'))
        if (!isNaN(num) && num > 0 && num < 100000) { prezzo = num; break }
      }

      const um = cells.length > 2 ? cells[2].toLowerCase().slice(0, 20) : ''

      if (prezzo > 0) {
        voci.push({ codice_voce: codice, descrizione: descrizione.slice(0, 500), unita_misura: um, prezzo: Math.round(prezzo * 100) / 100 })
      }
    }
  } else {
    // CSV/testo raw
    const lines = content.split('\n')
    for (const line of lines) {
      const cells = line.split(/[;,\t]/).map((c: string) => c.trim().replace(/^"|"$/g, ''))
      if (cells.length < 3) continue
      const codice = cells[0]
      if (codice.length < 5 || /^(codice|code|#)/i.test(codice)) continue
      const descrizione = cells[1]

      let prezzo = 0
      let um = ''
      for (let i = 2; i < cells.length; i++) {
        const num = parseFloat(cells[i].replace(',', '.'))
        if (!isNaN(num) && num > 0 && num < 100000) { prezzo = num; break }
        if (!um && cells[i].length < 20 && cells[i].length > 0) um = cells[i].toLowerCase()
      }

      if (prezzo > 0 && descrizione && descrizione.length > 3) {
        voci.push({ codice_voce: codice, descrizione: descrizione.slice(0, 500), unita_misura: um, prezzo: Math.round(prezzo * 100) / 100 })
      }
    }
  }

  if (voci.length === 0) {
    return NextResponse.json({ success: false, error: 'Nessuna voce trovata nel file', voci_count: 0 })
  }

  // Elimina vecchie voci della stessa regione/anno
  await supabase.from('prezziario').delete().eq('regione', regione.toLowerCase()).eq('anno', year)

  // Importa in batch
  let salvate = 0
  const batchSize = 500
  const fonte = `Prezziario ${regione} ${year}`

  for (let i = 0; i < voci.length; i += batchSize) {
    const batch = voci.slice(i, i + batchSize).map(v => ({
      regione: regione.toLowerCase(),
      anno: year,
      codice_voce: v.codice_voce,
      descrizione: v.descrizione,
      unita_misura: v.unita_misura,
      prezzo: v.prezzo,
      fonte,
    }))

    const { error } = await supabase.from('prezziario').insert(batch)
    if (!error) salvate += batch.length
  }

  return NextResponse.json({ success: true, regione: regione.toLowerCase(), anno: year, voci_count: salvate, fonte })
}
