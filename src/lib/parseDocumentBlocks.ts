export interface DocumentBlock {
  type: 'text' | 'document'
  content: string
}

/**
 * Splits an assistant message into text parts and document (HTML) parts.
 * Document blocks are delimited by ~~~document and ~~~
 */
export function parseDocumentBlocks(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = []
  const regex = /~~~document\s*\n([\s\S]*?)~~~(?:\s*$|\s*\n|\s)/gm
  let lastIndex = 0

  let match
  while ((match = regex.exec(text)) !== null) {
    // Text before this document block
    const before = text.slice(lastIndex, match.index).trim()
    if (before) {
      blocks.push({ type: 'text', content: before })
    }
    // The document HTML
    blocks.push({ type: 'document', content: match[1].trim() })
    lastIndex = match.index + match[0].length
  }

  // Remaining text after last document block
  const remaining = text.slice(lastIndex).trim()
  if (remaining) {
    blocks.push({ type: 'text', content: remaining })
  }

  // If no document blocks found, return the whole thing as text
  if (blocks.length === 0) {
    blocks.push({ type: 'text', content: text })
  }

  return blocks
}
