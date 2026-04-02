// Tool custom per il Cervellone
// La ricerca web è ora gestita dal tool built-in di Anthropic (web_search_20250305)
// Qui restano solo i tool custom che richiedono esecuzione server-side

export const CUSTOM_TOOLS = [
  {
    name: 'read_webpage',
    description: 'Leggi il contenuto di una pagina web specifica. Usa questo strumento quando hai un URL e vuoi leggerne il contenuto completo (es. un bando, una normativa, un articolo, un documento ufficiale).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL completo della pagina da leggere',
        },
      },
      required: ['url'],
    },
  },
]

// Leggi contenuto di una pagina web — con estrazione migliorata
export async function executeReadWebpage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) return `Errore: ${res.status} ${res.statusText}`

    const html = await res.text()

    // Rimuovi script, style, nav, footer, header — estrai solo testo utile
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()

    // Limite più generoso — 25000 caratteri per catturare più contenuto
    const trimmed = text.length > 25000 ? text.slice(0, 25000) + '\n\n[...contenuto troncato]' : text

    return `Contenuto di ${url}:\n\n${trimmed}`
  } catch (err) {
    return `Errore lettura pagina: ${err}`
  }
}

// Esegui un tool custom
export async function executeTool(name: string, input: Record<string, string>): Promise<string> {
  switch (name) {
    case 'read_webpage':
      return executeReadWebpage(input.url)
    default:
      return `Tool "${name}" non riconosciuto.`
  }
}
