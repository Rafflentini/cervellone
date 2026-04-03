'use client'

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  panel: ReactNode | null
  onClosePanel: () => void
  defaultPanelWidth?: number // percentuale, default 55
  minPanelWidth?: number    // percentuale, default 25
  maxPanelWidth?: number    // percentuale, default 75
}

export default function SplitPanel({
  children,
  panel,
  onClosePanel,
  defaultPanelWidth = 55,
  minPanelWidth = 25,
  maxPanelWidth = 75,
}: Props) {
  const [panelWidth, setPanelWidth] = useState(defaultPanelWidth)
  const [isOpen, setIsOpen] = useState(false)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Animazione apertura/chiusura
  useEffect(() => {
    if (panel) {
      // Piccolo delay per triggerare la transizione CSS
      requestAnimationFrame(() => setIsOpen(true))
    } else {
      setIsOpen(false)
    }
  }, [panel])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const percent = (x / rect.width) * 100
      const panelPercent = 100 - percent
      setPanelWidth(Math.min(maxPanelWidth, Math.max(minPanelWidth, panelPercent)))
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
  }, [maxPanelWidth, minPanelWidth])

  const showPanel = panel && isOpen

  return (
    <div ref={containerRef} className="flex flex-1 min-w-0 overflow-hidden">
      {/* Contenuto principale (chat) */}
      <div
        className="flex flex-col min-w-0 transition-all duration-300 ease-in-out"
        style={{ flex: showPanel ? `0 0 ${100 - panelWidth}%` : '1 1 auto' }}
      >
        {children}
      </div>

      {/* Drag handle */}
      {panel && (
        <div
          className={`hidden md:flex items-center justify-center flex-shrink-0 cursor-col-resize group transition-opacity duration-300 ${showPanel ? 'opacity-100 w-1.5' : 'opacity-0 w-0'}`}
          onMouseDown={handleMouseDown}
        >
          <div className="w-[3px] h-8 rounded-full bg-gray-300 group-hover:bg-blue-400 group-active:bg-blue-500 transition-colors" />
        </div>
      )}

      {/* Pannello preview */}
      {panel && (
        <div
          className={`hidden md:flex flex-col min-w-0 border-l border-gray-200 bg-white transition-all duration-300 ease-in-out overflow-hidden ${showPanel ? '' : 'opacity-0'}`}
          style={{
            flex: showPanel ? `0 0 ${panelWidth}%` : '0 0 0%',
          }}
        >
          {panel}
        </div>
      )}
    </div>
  )
}
