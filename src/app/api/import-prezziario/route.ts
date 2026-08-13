import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { validateAuth } from '@/lib/auth'

export const maxDuration = 300

type VoceRow = { codice_voce: string; descrizione: string; unita_misura: string; prezzo: number }

// --- helper condivisi per il parsing XML (prezzario regionale strutturato) ---
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
}
function cleanDesc(s: string): string {
  return decodeEntities(s || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function parseNum(s: string): number | null {
  const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'))
  return isNaN(v) ? null : v
}

/**
 * Parsa il prezzario regionale in formato XML strutturato
 * (Prezzario > Capitolo > Categoria > Voce > Sottovoce), come pubblicato
 * dalla Regione Basilicata. Concatena la descrizione della Voce madre con
 * quella della Sottovoce per non perdere il capoverso introduttivo.
 * codice_voce = <PREFIX><Cap>.<Cat>.<Voce>.<Sott>  (es. BAS26_E.03.068.01)
 */
function parsePrezziarioXml(xml: string, prefix: string): VoceRow[] {
  const out: VoceRow[] = []
  const tokenRe = /<(\/?)([A-Za-z]+)[^>]*>|([^<]+)/g
  const stack: string[] = []
  let capCode = '', catCode = '', voceCode = '', voceDescr = ''
  let voceUm = '', voceLeafPrezzo: number | null = null, voceHadSott = false
  let sott: { codice: string; descr: string; um: string; prezzo: number | null } | null = null

  const emit = (codice: string, descr: string, um: string, prezzo: number | null) => {
    if (prezzo === null || prezzo <= 0) return
    const d = cleanDesc(descr)
    if (!d) return
    out.push({ codice_voce: codice, descrizione: d.slice(0, 1000), unita_misura: (um || '').toLowerCase().slice(0, 20), prezzo: Math.round(prezzo * 100) / 100 })
  }

  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(xml)) !== null) {
    if (m[2] !== undefined) {
      const closing = m[1] === '/'
      const name = m[2]
      if (!closing) {
        stack.push(name)
        if (name === 'Capitolo') capCode = ''
        else if (name === 'Categoria') catCode = ''
        else if (name === 'Voce') { voceCode = ''; voceDescr = ''; voceUm = ''; voceLeafPrezzo = null; voceHadSott = false }
        else if (name === 'Sottovoce') sott = { codice: '', descr: '', um: '', prezzo: null }
      } else {
        if (name === 'Sottovoce' && sott) {
          voceHadSott = true
          const code = `${prefix}_${capCode}.${catCode}.${voceCode}.${sott.codice}`
          const full = voceDescr ? (sott.descr ? `${voceDescr} - ${sott.descr}` : voceDescr) : sott.descr
          emit(code, full, sott.um, sott.prezzo)
          sott = null
        } else if (name === 'Voce') {
          if (!voceHadSott && voceLeafPrezzo !== null) {
            emit(`${prefix}_${capCode}.${catCode}.${voceCode}`, voceDescr, voceUm, voceLeafPrezzo)
          }
        }
        stack.pop()
      }
    } else if (m[3] !== undefined) {
      const txt = m[3]
      if (!txt.trim()) continue
      const top = stack[stack.length - 1]
      const parent = stack[stack.length - 2]
      const gp = stack[stack.length - 3]
      if (top === 'codice') {
        if (parent === 'Capitolo') capCode = txt.trim()
        else if (parent === 'Categoria') catCode = txt.trim()
        else if (parent === 'Voce') voceCode = txt.trim()
        else if (parent === 'Sottovoce' && sott) sott.codice = txt.trim()
        else if (parent === 'unitaMisura') {
          if (gp === 'Sottovoce' && sott) sott.um = txt.trim()
          else if (gp === 'Voce') voceUm = txt.trim()
        }
      } else if (top === 'descrizione') {
        if (parent === 'Voce') voceDescr = (voceDescr ? voceDescr + ' ' : '') + txt.trim()
        else if (parent === 'Sottovoce' && sott) sott.descr = (sott.descr ? sott.descr + ' ' : '') + txt.trim()
      } else if (top === 'prezzo') {
        if (parent === 'Sottovoce' && sott) sott.prezzo = parseNum(txt)
        else if (parent === 'Voce') voceLeafPrezzo = parseNum(txt)
      }
    }
  }
  return out
}

// Importa prezziario da file ODS/CSV caricato, oppure da XML regionale via URL
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!validateAuth(authCookie?.value)) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { regione, anno, content, format, url } = await request.json()

  if (!regione || (!content && !url)) {
    return NextResponse.json({ error: 'Regione e contenuto (o url per format=xml) richiesti' }, { status: 400 })
  }

  const year = anno || new Date().getFullYear()
  let voci: VoceRow[] = []

  if (format === 'xml') {
    if (!url) return NextResponse.json({ error: 'url richiesto per format=xml' }, { status: 400 })
    let buf: Buffer
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/xml,text/xml,*/*',
        },
        redirect: 'follow',
      })
      if (!res.ok) return NextResponse.json({ error: `Download XML fallito: HTTP ${res.status}` }, { status: 502 })
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      return NextResponse.json({ error: `Download XML errore: ${e instanceof Error ? e.message : e}` }, { status: 502 })
    }
    // Prezzario Basilicata è UTF-16; fallback a UTF-8 se non sembra UTF-16.
    let xml = buf.toString('utf16le').replace(/^﻿/, '')
    if (!xml.includes('<Prezzario')) xml = buf.toString('utf8').replace(/^﻿/, '')
    const prefix = regione.slice(0, 3).toUpperCase() + String(year).slice(-2)
    voci = parsePrezziarioXml(xml, prefix)
  } else if (format === 'ods-text') {
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
        voci.push({ codice_voce: codice, descrizione: descrizione.slice(0, 1000), unita_misura: um, prezzo: Math.round(prezzo * 100) / 100 })
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
        voci.push({ codice_voce: codice, descrizione: descrizione.slice(0, 1000), unita_misura: um, prezzo: Math.round(prezzo * 100) / 100 })
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
