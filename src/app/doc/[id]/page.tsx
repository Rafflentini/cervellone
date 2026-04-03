'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'

export default function DocViewerPage() {
  const params = useParams()
  const id = params.id as string
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    fetch(`/api/doc/${id}`)
      .then(res => {
        if (!res.ok) throw new Error()
        return res.text()
      })
      .then(setHtml)
      .catch(() => setError(true))
  }, [id])

  const handlePrint = useCallback(() => {
    iframeRef.current?.contentWindow?.print()
  }, [])

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <p className="text-6xl mb-4">📄</p>
          <p className="text-xl font-semibold text-gray-700">Documento non trovato</p>
          <p className="text-gray-400 mt-2">Il link potrebbe essere scaduto o non valido.</p>
          <a href="/" className="mt-6 inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors">
            Vai alla chat
          </a>
        </div>
      </div>
    )
  }

  if (!html) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-500">Caricamento documento...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-800">📄 Cervellone</span>
          <span className="text-sm text-gray-400">Anteprima documento</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handlePrint}
            className="bg-red-500 text-white hover:bg-red-600 px-4 py-2 rounded-lg transition-colors flex items-center gap-2 font-medium text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Salva PDF
          </button>
          <a
            href="/"
            className="text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg transition-colors text-sm"
          >
            Vai alla chat
          </a>
        </div>
      </div>

      {/* Document preview */}
      <div className="flex-1 overflow-hidden p-6 flex justify-center">
        <div className="bg-white shadow-2xl rounded-lg overflow-hidden w-full max-w-4xl">
          <iframe
            ref={iframeRef}
            srcDoc={html}
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-popups"
            title="Documento"
          />
        </div>
      </div>
    </div>
  )
}
