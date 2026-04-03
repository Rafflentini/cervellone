'use client'

import { useState, useRef, useCallback, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  panel: ReactNode | null
  onClosePanel: () => void
}

export default function SplitPanel({ children, panel, onClosePanel }: Props) {
  const [panelWidth, setPanelWidth] = useState(55)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const chatPercent = (x / rect.width) * 100
      const newPanelWidth = 100 - chatPercent
      setPanelWidth(Math.min(75, Math.max(25, newPanelWidth)))
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return (
    <div ref={containerRef} className="flex flex-1 min-w-0 h-full overflow-hidden">
      {/* Chat */}
      <div className="flex flex-col min-w-0 h-full" style={{ width: panel ? `${100 - panelWidth}%` : '100%' }}>
        {children}
      </div>

      {/* Drag handle + Panel — solo quando c'è qualcosa da mostrare */}
      {panel && (
        <>
          <div
            className="w-2 flex-shrink-0 cursor-col-resize flex items-center justify-center group hover:bg-gray-100 transition-colors"
            onMouseDown={handleMouseDown}
          >
            <div className="w-[3px] h-8 rounded-full bg-gray-300 group-hover:bg-blue-400 group-active:bg-blue-500 transition-colors" />
          </div>
          <div className="flex flex-col min-w-0 h-full border-l border-gray-200 bg-white overflow-hidden" style={{ width: `${panelWidth}%` }}>
            {panel}
          </div>
        </>
      )}
    </div>
  )
}
