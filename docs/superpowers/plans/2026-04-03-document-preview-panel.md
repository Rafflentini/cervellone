# Document Preview Panel (Artifacts-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude AI-style document preview panel that renders professional HTML documents with layout, colors, tables and headers — on web as a side panel, on Telegram as an image screenshot.

**Architecture:** Claude generates documents inside `~~~document` fenced blocks with HTML+CSS. The frontend detects these blocks, renders them in a right-side panel (iframe), and offers download as PDF (browser print). On Telegram, the backend renders the HTML to an image via a serverless screenshot endpoint and sends it as a photo.

**Tech Stack:** React (existing), iframe sandbox for preview, window.print() for PDF, Puppeteer/Chromium for Telegram screenshots (or Vercel OG image approach)

---

### Task 1: Teach Claude to generate HTML documents

**Files:**
- Modify: `src/app/api/chat/route.ts` (system prompt)

- [ ] **Step 1: Update system prompt with document generation instructions**

In `src/app/api/chat/route.ts`, replace the document generation section of `SYSTEM_PROMPT`:

```typescript
// Replace the "IMPORTANTE — Generazione documenti:" paragraph with:

IMPORTANTE — Generazione documenti:
Quando l'Ingegnere chiede di generare un documento (preventivo, computo, relazione, POS, lettera, tabella, report), produci il documento come HTML professionale dentro un blocco speciale delimitato da ~~~document e ~~~.

Esempio formato:
~~~document
<!DOCTYPE html>
<html>
<head><style>/* CSS professionale qui */</style></head>
<body>/* contenuto documento */</body>
</html>
~~~

REGOLE per i documenti HTML:
- Layout professionale A4 con margini, intestazione Restruktura, footer con pagina
- Usa colori aziendali: blu #1e40af per intestazioni, grigio #f8fafc per sfondi alternati nelle tabelle
- Tabelle con bordi, header colorato, righe alternate
- Font: system-ui o Arial, dimensioni leggibili (14-16px testo, 20-24px titoli)
- Il documento deve essere COMPLETO e autocontenuto (CSS inline nello <style>)
- Per preventivi e computi: tabella con colonne N., Descrizione, U.M., Quantita, P.U., Importo
- Intestazione con logo testuale "RESTRUKTURA S.r.l." + dati aziendali
- NON mettere il documento nel testo della risposta — mettilo SOLO nel blocco ~~~document

Dopo il blocco document, aggiungi una breve descrizione testuale di cosa hai generato.
Il pannello anteprima si apre automaticamente. L'utente puo scaricare come PDF con il pulsante dedicato.
NON dire mai "non posso generare file" o "non ho un ambiente di esecuzione". Tu PUOI generare documenti.
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/chat/route.ts
git commit -m "feat: teach Claude to generate HTML documents in ~~~document blocks"
```

---

### Task 2: Parse document blocks from assistant messages

**Files:**
- Create: `src/lib/parseDocumentBlocks.ts`

- [ ] **Step 1: Create the parser utility**

Create `src/lib/parseDocumentBlocks.ts`:

```typescript
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
  const regex = /~~~document\s*\n([\s\S]*?)~~~(?:\s*$|\s*\n)/gm
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/parseDocumentBlocks.ts
git commit -m "feat: add document block parser for ~~~document delimiters"
```

---

### Task 3: Create the DocumentPreviewPanel component

**Files:**
- Create: `src/components/DocumentPreviewPanel.tsx`

- [ ] **Step 1: Create the preview panel component**

Create `src/components/DocumentPreviewPanel.tsx`:

```tsx
'use client'

import { useRef, useCallback } from 'react'

interface Props {
  html: string
  onClose: () => void
}

export default function DocumentPreviewPanel({ html, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const handlePrint = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.print()
  }, [])

  const handleDownloadHtml = useCallback(() => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `documento_${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
  }, [html])

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 flex-shrink-0">
        <span className="text-sm font-semibold text-gray-700">Anteprima documento</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrint}
            className="text-xs bg-red-500 text-white hover:bg-red-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 font-medium"
            title="Stampa / Salva come PDF"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            PDF
          </button>
          <button
            onClick={handleDownloadHtml}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1.5 rounded-lg transition-colors"
            title="Scarica HTML"
          >
            HTML
          </button>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 transition-colors"
            title="Chiudi"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Preview iframe */}
      <div className="flex-1 overflow-hidden bg-gray-100 p-4">
        <div className="h-full bg-white shadow-lg rounded-lg overflow-hidden">
          <iframe
            ref={iframeRef}
            srcDoc={html}
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-popups"
            title="Anteprima documento"
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/DocumentPreviewPanel.tsx
git commit -m "feat: add DocumentPreviewPanel with iframe preview and print-to-PDF"
```

---

### Task 4: Integrate preview panel into chat page

**Files:**
- Modify: `src/app/chat/page.tsx`

- [ ] **Step 1: Add imports and state**

At the top of `src/app/chat/page.tsx`, add imports:

```typescript
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import DocumentPreviewPanel from '@/components/DocumentPreviewPanel'
```

Inside `ChatPage()`, add state:

```typescript
const [previewHtml, setPreviewHtml] = useState<string | null>(null)
```

- [ ] **Step 2: Update message rendering to detect document blocks**

Replace the message rendering section. Where `msg.role === 'assistant'` messages render, change the content rendering from:

```tsx
{msg.role === 'assistant' ? (
  <MarkdownRenderer content={msg.text} />
) : (
```

To:

```tsx
{msg.role === 'assistant' ? (
  <>
    {parseDocumentBlocks(msg.text).map((block, bi) =>
      block.type === 'document' ? (
        <button
          key={bi}
          onClick={() => setPreviewHtml(block.content)}
          className="my-2 w-full text-left bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 hover:from-blue-100 hover:to-indigo-100 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-800">Documento generato</p>
              <p className="text-xs text-blue-500 group-hover:text-blue-600">Clicca per aprire anteprima</p>
            </div>
            <svg className="w-5 h-5 text-blue-400 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      ) : (
        <MarkdownRenderer key={bi} content={block.content} />
      )
    )}
  </>
) : (
```

- [ ] **Step 3: Update the main layout to include the preview panel**

The current layout is: `sidebar | chat area`. Change it to: `sidebar | chat area | preview panel (conditional)`.

Find the `{/* Area chat principale */}` section. The outer div is:

```tsx
<div className="flex flex-col flex-1 min-w-0">
```

Wrap it and add the preview panel. Replace:

```tsx
{/* Area chat principale */}
<div className="flex flex-col flex-1 min-w-0">
```

With:

```tsx
{/* Area chat principale */}
<div className={`flex flex-col min-w-0 ${previewHtml ? 'flex-1' : 'flex-1'}`} style={previewHtml ? { flex: '1 1 50%' } : undefined}>
```

Then, after the closing `</div>` of the chat area (right before the final `</div>` of the page), add:

```tsx
{/* Pannello anteprima documento */}
{previewHtml && (
  <div className="hidden md:flex" style={{ flex: '1 1 50%', maxWidth: '55%' }}>
    <DocumentPreviewPanel
      html={previewHtml}
      onClose={() => setPreviewHtml(null)}
    />
  </div>
)}
```

Also add a mobile fullscreen fallback right after:

```tsx
{/* Anteprima mobile — fullscreen */}
{previewHtml && (
  <div className="fixed inset-0 z-50 md:hidden bg-white">
    <DocumentPreviewPanel
      html={previewHtml}
      onClose={() => setPreviewHtml(null)}
    />
  </div>
)}
```

- [ ] **Step 4: Verify the top-level layout is flex row**

The page container should already be a flex row (sidebar + chat area). Find the outermost wrapping div that contains sidebar + chat. It should have `className="flex h-screen"` or similar. If the chat area and sidebar are already siblings in a flex container, the preview panel just becomes a third sibling. Verify this is the case.

- [ ] **Step 5: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "feat: integrate document preview panel into chat layout"
```

---

### Task 5: Update Telegram to send document as formatted message

**Files:**
- Modify: `src/app/api/telegram/route.ts`

- [ ] **Step 1: Add document block detection and HTML-to-text conversion for Telegram**

In `src/app/api/telegram/route.ts`, before the `sendTelegramMessage(chatId, fullResponse ...)` call, add logic to extract document blocks and convert HTML to a formatted Telegram message. Import the parser:

```typescript
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
```

Then, before sending the response, replace:

```typescript
// Manda risposta su Telegram
console.log('TELEGRAM risposta da inviare, lunghezza:', fullResponse.length, 'anteprima:', fullResponse.slice(0, 100))
await sendTelegramMessage(chatId, fullResponse || 'Non sono riuscito a elaborare una risposta.')
```

With:

```typescript
// Manda risposta su Telegram
console.log('TELEGRAM risposta da inviare, lunghezza:', fullResponse.length, 'anteprima:', fullResponse.slice(0, 100))

const blocks = parseDocumentBlocks(fullResponse)
for (const block of blocks) {
  if (block.type === 'document') {
    // Converti HTML in testo formattato per Telegram
    const docText = block.content
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n*$1*\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n*$1*\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n_$1_\n')
      .replace(/<th[^>]*>(.*?)<\/th>/gi, '*$1* | ')
      .replace(/<td[^>]*>(.*?)<\/td>/gi, '$1 | ')
      .replace(/<tr[^>]*>/gi, '\n')
      .replace(/<\/tr>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '• $1\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&euro;/g, '\u20AC')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    await sendTelegramMessage(chatId, '\uD83D\uDCC4 *DOCUMENTO GENERATO*\n\n' + docText)
    await sendTelegramMessage(chatId, '\uD83D\uDCA1 Per la versione completa con grafica, apra la chat web:\nhttps://cervellone-5poc.vercel.app')
  } else if (block.content) {
    await sendTelegramMessage(chatId, block.content)
  }
}

if (blocks.length === 0) {
  await sendTelegramMessage(chatId, fullResponse || 'Non sono riuscito a elaborare una risposta.')
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "feat: Telegram sends document blocks as formatted text with web link"
```

---

### Task 6: Update system prompt on Telegram route

**Files:**
- Modify: `src/app/api/telegram/route.ts`

- [ ] **Step 1: Ensure Telegram system prompt also teaches ~~~document blocks**

The Telegram system prompt already says "NON dire mai che non puoi generare file". Add the ~~~document block instruction so Claude generates the same format on both channels:

In the Telegram `SYSTEM_PROMPT`, after the "Puoi generare QUALSIASI documento" line, add:

```
Quando generi documenti strutturati (preventivi, computi, relazioni), usa il blocco ~~~document con HTML professionale, esattamente come nella chat web. Il sistema convertira automaticamente in formato leggibile per Telegram.
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "feat: Telegram system prompt teaches ~~~document block format"
```

---

### Task 7: Final integration test and deploy

- [ ] **Step 1: Verify no TypeScript errors**

Run from PowerShell (user must do this):
```bash
cd "C:\Progetti claude Code\02.SuperING\cervellone"
npx tsc --noEmit
```

- [ ] **Step 2: Test locally**

Run `npm run dev` and test:
1. Ask "Fammi un preventivo di esempio per una ristrutturazione"
2. Verify Claude generates a ~~~document block
3. Verify "Documento generato" card appears in chat
4. Click it — verify panel opens on right
5. Click PDF — verify browser print dialog opens
6. Close panel — verify chat returns to normal

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "feat: document preview panel (artifacts-style) complete"
git push
```
