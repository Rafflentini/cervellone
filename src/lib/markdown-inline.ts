/**
 * src/lib/markdown-inline.ts — la formattazione dentro una riga di testo.
 *
 * Estratta da `components/MarkdownRenderer.tsx` per poterla collaudare: qui la
 * regola e' pura, entra testo grezzo ed esce HTML.
 *
 * Il motivo dell'estrazione e' un difetto segnalato dall'Ingegnere: nella chat
 * web i link non erano cliccabili. Diventavano `<a>` solo nella forma markdown
 * `[testo](url)`, mentre il bot scrive URL NUDI («👉 https://drive.google…»),
 * che restavano testo morto.
 *
 * ⭐ Su Telegram il difetto non si vedeva, perche' e' il CLIENT di Telegram a
 * rendere cliccabili gli indirizzi da solo. Sul web non lo faceva nessuno.
 * Stesso messaggio, cliccabile su un canale e inerte sull'altro: la solita
 * divergenza fra i due canali, nascosta dietro una cortesia che un canale
 * offre gratis e l'altro no.
 */

/** Un `<a>…</a>` gia' costruito: ci si passa sopra senza toccarlo. */
const ANCORA_ESISTENTE = /(<a\b[^>]*>.*?<\/a>)/g

/**
 * Un indirizzo scritto nudo nel testo.
 *
 * La punteggiatura di fine frase NON fa parte dell'indirizzo: «il file sta qui:
 * https://esempio.it/doc.» finirebbe con un href rotto dal punto. Per questo la
 * coda `[.,;:!?)]` viene lasciata fuori dal collegamento.
 */
const URL_NUDO = /(https?:\/\/[^\s<>"']+?)([.,;:!?)]*)(?=\s|$)/g

/** Rende cliccabili gli URL nudi, senza toccare i link gia' costruiti. */
function collegaUrlNudi(html: string): string {
  return html
    .split(ANCORA_ESISTENTE)
    .map((pezzo) => {
      // I pezzi dispari sono le ancore gia' esistenti: un URL dentro `href="…"`
      // e' esso stesso un URL, e una regola ingenua ci ricadrebbe sopra
      // producendo un `<a>` dentro un `<a>`.
      if (pezzo.startsWith('<a ')) return pezzo
      return pezzo.replace(
        URL_NUDO,
        (_intero, indirizzo, coda) =>
          `<a href="${indirizzo}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline break-all">${indirizzo}</a>${coda}`,
      )
    })
    .join('')
}

/** Grassetto, corsivo, barrato, codice, link e apici dentro una riga. */
export function renderInline(text: string): string {
  const conMarkdown = text
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    // Strikethrough
    .replace(/~~(.*?)~~/g, '<del class="text-gray-400">$1</del>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="mx-0.5 px-1.5 py-0.5 bg-gray-100 text-gray-800 rounded text-[13px] font-mono">$1</code>')
    // Links markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">$1</a>')
    // Superscript
    .replace(/\^(.*?)\^/g, '<sup>$1</sup>')

  // Per ultimo, cosi' i link markdown sono gia' ancore e vengono saltati.
  return collegaUrlNudi(conMarkdown)
}
