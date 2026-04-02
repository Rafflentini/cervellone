'use client'

import { useEffect, useRef } from 'react'

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderInline(text: string): string {
  return text
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    // Strikethrough
    .replace(/~~(.*?)~~/g, '<del class="text-gray-400">$1</del>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="mx-0.5 px-1.5 py-0.5 bg-gray-100 text-gray-800 rounded text-[13px] font-mono">$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">$1</a>')
    // Superscript
    .replace(/\^(.*?)\^/g, '<sup>$1</sup>')
}

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const html: string[] = []
  let inCodeBlock = false
  let codeContent = ''
  let codeLang = ''
  let inTable = false
  let tableRows: string[][] = []
  let inList = false
  let listType: 'ul' | 'ol' = 'ul'

  function flushList() {
    if (inList) {
      html.push(`</${listType}>`)
      inList = false
    }
  }

  function flushTable() {
    if (inTable && tableRows.length > 0) {
      let t = '<div class="overflow-x-auto my-3"><table class="w-full text-sm border-collapse">'
      // Header
      t += '<thead><tr>'
      tableRows[0].forEach(cell => {
        t += `<th class="text-left px-3 py-2 bg-gray-50 border-b-2 border-gray-200 font-semibold text-gray-700">${renderInline(cell.trim())}</th>`
      })
      t += '</tr></thead><tbody>'
      // Body (skip separator row)
      for (let i = 2; i < tableRows.length; i++) {
        const stripe = i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
        t += `<tr class="${stripe}">`
        tableRows[i].forEach(cell => {
          t += `<td class="px-3 py-2 border-b border-gray-100 text-gray-600">${renderInline(cell.trim())}</td>`
        })
        t += '</tr>'
      }
      t += '</tbody></table></div>'
      html.push(t)
      tableRows = []
      inTable = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        if (codeLang === 'mermaid') {
          // Blocco Mermaid — NON fare escape HTML, mermaid ha bisogno della sintassi raw
          const mermaidId = `mermaid-${Math.random().toString(36).slice(2, 8)}`
          html.push(`<div class="mermaid-block my-4 flex justify-center" id="${mermaidId}" data-mermaid="${codeContent.trimEnd().replace(/"/g, '&quot;')}">${codeContent.trimEnd()}</div>`)
        } else {
          const langLabel = codeLang ? `<div class="bg-gray-800 text-gray-400 px-4 py-1 text-xs font-mono">${codeLang}</div>` : ''
          html.push(`<div class="my-3 rounded-lg overflow-hidden border border-gray-200">${langLabel}<pre class="bg-gray-50 text-gray-800 px-4 py-3 overflow-x-auto text-[13px] leading-relaxed font-mono">${escapeHtml(codeContent.trimEnd())}</pre></div>`)
        }
        inCodeBlock = false
        codeContent = ''
        codeLang = ''
      } else {
        flushList()
        flushTable()
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      flushList()
      const cells = line.split('|').slice(1, -1)
      if (!inTable) inTable = true
      tableRows.push(cells)
      continue
    } else if (inTable) {
      flushTable()
    }

    // Empty line
    if (line.trim() === '') {
      flushList()
      continue
    }

    // Headings (h1-h6)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (headingMatch) {
      flushList()
      const level = headingMatch[1].length
      const text = headingMatch[2]
      const styles: Record<number, string> = {
        1: 'text-[18px] font-bold text-gray-900 mt-5 mb-2 pb-1.5 border-b border-gray-200',
        2: 'text-[16px] font-bold text-gray-800 mt-5 mb-2 pb-1 border-b border-gray-100',
        3: 'text-[15px] font-bold text-gray-800 mt-4 mb-1.5',
        4: 'text-[14px] font-bold text-gray-700 mt-3 mb-1',
        5: 'text-[13px] font-semibold text-gray-600 mt-2 mb-1',
        6: 'text-[13px] font-semibold text-gray-500 mt-2 mb-1',
      }
      html.push(`<h${level} class="${styles[level]}">${renderInline(text)}</h${level}>`)
      continue
    }

    // Horizontal rule
    if (line.match(/^-{3,}$/) || line.match(/^\*{3,}$/)) {
      flushList()
      html.push('<hr class="my-4 border-gray-200" />')
      continue
    }

    // Task list (checkbox)
    const taskMatch = line.match(/^[\s]*[-*]\s\[([ xX])\]\s(.*)/)
    if (taskMatch) {
      const checked = taskMatch[1] !== ' '
      const content = taskMatch[2]
      if (!inList) {
        inList = true
        listType = 'ul'
        html.push('<ul class="my-2 space-y-1">')
      }
      const checkbox = checked
        ? '<span class="text-green-500 mt-0.5">☑</span>'
        : '<span class="text-gray-400 mt-0.5">☐</span>'
      const textClass = checked ? 'text-gray-400 line-through' : ''
      html.push(`<li class="flex items-start gap-2">${checkbox}<span class="${textClass}">${renderInline(content)}</span></li>`)
      continue
    }

    // Unordered list
    if (line.match(/^[\s]*[-*]\s/)) {
      const indent = line.match(/^(\s*)/)?.[1]?.length || 0
      const content = line.replace(/^[\s]*[-*]\s/, '')
      if (!inList) {
        inList = true
        listType = 'ul'
        html.push('<ul class="my-2 space-y-1">')
      }
      const ml = indent > 0 ? ' ml-4' : ''
      html.push(`<li class="flex items-start gap-2${ml}"><span class="text-blue-500 mt-1.5 text-[6px]">●</span><span>${renderInline(content)}</span></li>`)
      continue
    }

    // Ordered list
    if (line.match(/^\s*\d+\.\s/)) {
      const content = line.replace(/^\s*\d+\.\s/, '')
      const num = line.match(/^\s*(\d+)\./)?.[1] || '1'
      if (!inList || listType !== 'ol') {
        flushList()
        inList = true
        listType = 'ol'
        html.push('<ol class="my-2 space-y-1">')
      }
      html.push(`<li class="flex items-start gap-2"><span class="text-blue-600 font-semibold text-[13px] min-w-[18px]">${num}.</span><span>${renderInline(content)}</span></li>`)
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList()
      html.push(`<blockquote class="my-2 pl-3 border-l-3 border-blue-300 text-gray-600 italic">${renderInline(line.slice(2))}</blockquote>`)
      continue
    }

    // Normal paragraph
    flushList()
    html.push(`<p class="my-1.5">${renderInline(line)}</p>`)
  }

  flushList()
  flushTable()

  return html.join('\n')
}

export default function MarkdownRenderer({ content, className = '' }: { content: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const mermaidBlocks = containerRef.current.querySelectorAll('.mermaid-block')
    if (mermaidBlocks.length === 0) return

    // Carica mermaid da CDN e renderizza
    const renderMermaid = async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(window as any).mermaid) {
        const script = document.createElement('script')
        script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
        script.async = true
        await new Promise<void>((resolve) => {
          script.onload = () => resolve()
          document.head.appendChild(script)
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mermaid = (window as any).mermaid
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
        themeVariables: {
          primaryColor: '#3b82f6',
          primaryTextColor: '#1e293b',
          primaryBorderColor: '#93c5fd',
          lineColor: '#64748b',
          secondaryColor: '#f1f5f9',
          tertiaryColor: '#f8fafc',
          fontSize: '14px',
        },
      })

      mermaidBlocks.forEach(async (block) => {
        if (block.classList.contains('rendered')) return
        const code = (block.textContent || '').trim()
        if (!code) return
        const id = block.id || `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        try {
          const { svg } = await mermaid.render(id, code)
          block.innerHTML = svg
          block.classList.add('rendered')
        } catch (err) {
          console.error('Mermaid render error:', err)
          block.innerHTML = `<pre class="bg-gray-50 text-gray-600 p-4 rounded-lg text-sm font-mono overflow-x-auto border border-gray-200">${code}</pre>`
          block.classList.add('rendered')
        }
      })
    }

    renderMermaid()
  }, [content])

  return (
    <div
      ref={containerRef}
      className={`markdown-body text-[14px] leading-relaxed ${className}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  )
}
