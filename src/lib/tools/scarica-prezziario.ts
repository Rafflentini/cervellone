import { supabase } from '@/lib/supabase'

export interface ScaricaPrezziarioInput {
  regione: string
  anno?: number
  url?: string
}

export interface ScaricaPrezziarioResult {
  success: boolean
  regione: string
  anno: number
  voci_salvate: number
  fonte: string
  errore?: string
}

interface VocePrezziario {
  codice_voce: string | null
  descrizione: string
  unita_misura: string | null
  prezzo: number
}

// Italian price format: "1.234,56" or "1234,56" or "1234.56"
function parseItalianPrice(raw: string): number | null {
  // Remove thousand separators (dots before a group of 3+ digits followed by comma or end)
  const cleaned = raw
    .trim()
    .replace(/\./g, (_, offset, str) => {
      // Keep dot only if it looks like a decimal separator (single dot near end)
      const afterDot = str.slice(offset + 1)
      if (/^\d{1,2}([,\s]|$)/.test(afterDot)) return '.'
      return ''
    })
    .replace(',', '.')

  const value = parseFloat(cleaned)
  if (isNaN(value) || value <= 0) return null
  return value
}

// Regex patterns to identify prezziario lines
// Typical format: CODE  DESCRIPTION  UNIT  PRICE
// e.g.: "01.A01.001  Demolizione di muratura  mc  45,50"
const CODE_PATTERN = /^([A-Z0-9]{1,4}[./][A-Z0-9./_-]{2,20})\s+/i
const PRICE_PATTERN = /(\d{1,6}(?:[.,]\d{3})*(?:[.,]\d{1,2}))\s*$/
const UNIT_PATTERN = /\b(mc|mq|ml|m\.l\.|kg|t|n\.?\s*r\.|nr|cad\.?|h|kw|kwh|l|m|cm|mm|m3|m2|m1|pz|corpo|vano|q\.le|ql)\b/i

function extractVoci(text: string): VocePrezziario[] {
  const voci: VocePrezziario[] = []
  const lines = text.split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.length < 10) continue

    // Must have a price at the end
    const priceMatch = line.match(PRICE_PATTERN)
    if (!priceMatch) continue

    const prezzo = parseItalianPrice(priceMatch[1])
    if (prezzo === null || prezzo > 999999) continue

    // Strip price from end to work on the rest
    const withoutPrice = line.slice(0, line.lastIndexOf(priceMatch[1])).trimEnd()

    // Try to find a unit of measure
    const unitMatch = withoutPrice.match(UNIT_PATTERN)
    const unita_misura = unitMatch ? unitMatch[0].toLowerCase().replace(/\s+/g, '') : null

    // Strip unit from the remainder
    const withoutUnit = unitMatch
      ? withoutPrice.slice(0, withoutPrice.lastIndexOf(unitMatch[0])).trimEnd()
      : withoutPrice

    // Try to find a codice voce at the start
    const codeMatch = withoutUnit.match(CODE_PATTERN)
    const codice_voce = codeMatch ? codeMatch[1] : null

    // Description is what remains after stripping the code
    const descrizione = codeMatch
      ? withoutUnit.slice(codeMatch[0].length).trim()
      : withoutUnit.trim()

    // Skip lines that don't look like real entries
    if (descrizione.length < 5) continue
    // Skip lines that are all numbers (table headers, page numbers, etc.)
    if (/^[\d\s.,]+$/.test(descrizione)) continue

    voci.push({ codice_voce, descrizione, unita_misura, prezzo })
  }

  return voci
}

async function downloadFile(url: string): Promise<Buffer> {
  // User-Agent realistico — molti siti regionali bloccano richieste senza header
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,text/csv,text/plain,*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`Download fallito: HTTP ${response.status} — ${url}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

function isTextUrl(url: string): boolean {
  return /\.(csv|txt|tsv)(\?|#|$)/i.test(url)
}

async function extractText(buffer: Buffer, url: string): Promise<string> {
  if (isTextUrl(url)) {
    return buffer.toString('utf-8')
  }

  // Assume PDF — pdf-parse v2 uses named export with { data: buffer }
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
}

async function salvaInBatch(
  voci: VocePrezziario[],
  regione: string,
  anno: number,
  fonte: string,
  batchSize = 500,
): Promise<number> {
  let salvate = 0

  for (let i = 0; i < voci.length; i += batchSize) {
    const batch = voci.slice(i, i + batchSize)
    const rows = batch.map((v) => ({
      regione: regione.toLowerCase(),
      anno,
      codice_voce: v.codice_voce,
      descrizione: v.descrizione,
      unita_misura: v.unita_misura,
      prezzo: v.prezzo,
      fonte,
    }))

    const { error } = await supabase.from('prezziario').insert(rows)

    if (error) {
      console.log(`PREZZIARIO: errore batch ${i}–${i + batch.length}: ${error.message}`)
    } else {
      salvate += batch.length
      console.log(`PREZZIARIO: salvate ${salvate}/${voci.length} voci`)
    }
  }

  return salvate
}

// Tool per importare prezziario da testo (quando l'utente carica un PDF in chat)
export async function executeImportaPrezziario(
  input: { regione: string; anno?: number; testo: string },
): Promise<ScaricaPrezziarioResult> {
  const regione = input.regione.trim().toLowerCase()
  const anno = input.anno || new Date().getFullYear()
  const fonte = `Prezziario ${input.regione} ${anno} (caricato manualmente)`

  try {
    console.log(`PREZZIARIO IMPORT: parsing testo — ${input.testo.length} caratteri`)
    const voci = extractVoci(input.testo)
    console.log(`PREZZIARIO IMPORT: trovate ${voci.length} voci`)

    if (voci.length === 0) {
      return {
        success: false, regione, anno, voci_salvate: 0, fonte,
        errore: 'Nessuna voce trovata nel testo. Il formato potrebbe non essere supportato. Prova a copiare le righe della tabella con codice, descrizione, unità e prezzo.',
      }
    }

    const salvate = await salvaInBatch(voci, regione, anno, fonte)
    return { success: true, regione, anno, voci_salvate: salvate, fonte }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, regione, anno, voci_salvate: 0, fonte, errore: msg }
  }
}

export async function executeScaricaPrezziario(
  input: ScaricaPrezziarioInput,
): Promise<ScaricaPrezziarioResult> {
  const regione = input.regione.trim().toLowerCase()
  const anno = input.anno || new Date().getFullYear()

  if (!input.url) {
    return {
      success: false,
      regione,
      anno,
      voci_salvate: 0,
      fonte: '',
      errore:
        'URL non fornito. Usa web_search per trovare l\'URL del prezziario regionale ' +
        `(es. "prezziario regionale ${input.regione} ${anno} PDF download"), ` +
        'poi richiama scarica_prezziario con il campo url valorizzato.',
    }
  }

  const fonte = `Prezziario ${input.regione} ${anno}`

  try {
    console.log(`PREZZIARIO: download da ${input.url}`)
    const buffer = await downloadFile(input.url)
    console.log(`PREZZIARIO: scaricati ${(buffer.length / 1024).toFixed(1)} KB`)

    console.log(`PREZZIARIO: estrazione testo (${isTextUrl(input.url) ? 'testo' : 'PDF'})`)
    const text = await extractText(buffer, input.url)
    console.log(`PREZZIARIO: testo estratto — ${text.length} caratteri`)

    console.log(`PREZZIARIO: parsing voci`)
    const voci = extractVoci(text)
    console.log(`PREZZIARIO: trovate ${voci.length} voci candidate`)

    if (voci.length === 0) {
      return {
        success: false,
        regione,
        anno,
        voci_salvate: 0,
        fonte,
        errore:
          'Nessuna voce trovata nel documento. Il formato potrebbe non essere supportato ' +
          'oppure il PDF è scansionato (immagine). Prova con un file CSV/TXT se disponibile.',
      }
    }

    const salvate = await salvaInBatch(voci, regione, anno, fonte)
    console.log(`PREZZIARIO: completato — ${salvate} voci salvate per ${regione} ${anno}`)

    return {
      success: true,
      regione,
      anno,
      voci_salvate: salvate,
      fonte,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`PREZZIARIO: errore — ${msg}`)
    return {
      success: false,
      regione,
      anno,
      voci_salvate: 0,
      fonte,
      errore: msg,
    }
  }
}
