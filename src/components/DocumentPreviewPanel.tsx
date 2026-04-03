'use client'

import { useRef, useCallback } from 'react'

interface Props {
  html: string
  onClose: () => void
}

export default function DocumentPreviewPanel({ html, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const handlePrint = useCallback(() => {
    // Apri il documento in una nuova finestra per la stampa (il sandbox dell'iframe blocca window.print)
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.onload = () => {
      printWindow.print()
    }
  }, [html])

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
