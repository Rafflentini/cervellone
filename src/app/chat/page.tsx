'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import CervelloneLogo from '@/components/CervelloneLogo'
import MarkdownRenderer from '@/components/MarkdownRenderer'

type FileAttachment = {
  name: string
  mediaType: string
  data: string
  isImage: boolean
  isPdf: boolean
  isWord: boolean
  isZip: boolean
  preview: string
  extractedText?: string
}

type DisplayMessage = {
  role: 'user' | 'assistant'
  text: string
  files?: FileAttachment[]
}

type Conversation = {
  id: string
  title: string
  project_id: string | null
  created_at: string
  updated_at: string
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Costruisce il contenuto API per un messaggio — includeFiles=true solo per l'ultimo messaggio utente
function buildApiContent(msg: DisplayMessage, includeFiles: boolean = true) {
  if (!msg.files || msg.files.length === 0) return msg.text

  // Per messaggi vecchi: non mandare i file, solo il testo + riferimento ai nomi
  if (!includeFiles) {
    const fileNames = msg.files.map(f => f.name).join(', ')
    const ref = `[File allegati e già analizzati: ${fileNames}]`
    return msg.text ? `${ref}\n\n${msg.text}` : ref
  }

  // Per il messaggio corrente: manda i file veri
  const blocks: object[] = []
  for (const file of msg.files) {
    if (file.isImage && file.data) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } })
    } else if (file.isPdf && file.data && file.mediaType) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: file.mediaType, data: file.data } })
    } else if (file.isWord && file.extractedText) {
      blocks.push({ type: 'text', text: `[File Word: ${file.name}]\n\n${file.extractedText}` })
    }
  }
  // Sempre un blocco testo
  const fileNames = msg.files.map(f => f.name).join(', ') || ''
  const text = msg.text || `Analizza: ${fileNames}`
  blocks.push({ type: 'text', text })
  return blocks
}

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([])
  const [loading, setLoading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showProjectModal, setShowProjectModal] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [pendingZipFile, setPendingZipFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState({ phase: '', percent: 0, detail: '' })
  const [existingProjects, setExistingProjects] = useState<{ id: string; name: string; slug: string }[]>([])
  const [suggestedProject, setSuggestedProject] = useState<string | null>(null)
  // Conversazioni
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(false)

  const [isRecording, setIsRecording] = useState(false)
  const [audioLevels, setAudioLevels] = useState<number[]>([0, 0, 0, 0, 0])
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  // Carica lista conversazioni
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations')
      if (res.ok) {
        const data = await res.json()
        setConversations(data.conversations || [])
      }
    } catch { /* ignore */ }
  }, [])

  // Carica messaggi di una conversazione
  async function loadMessages(convId: string) {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`)
      if (res.ok) {
        const data = await res.json()
        const msgs: DisplayMessage[] = (data.messages || []).map((m: { role: 'user' | 'assistant'; content: string; files?: FileAttachment[] }) => ({
          role: m.role,
          text: m.content,
          files: m.files || undefined,
        }))
        setMessages(msgs)
      }
    } catch { /* ignore */ }
  }

  // Salva messaggio su Supabase
  async function saveMessage(convId: string, role: string, content: string, files?: FileAttachment[]) {
    try {
      await fetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          content,
          files: files ? files.map(f => ({ name: f.name, isImage: f.isImage, isPdf: f.isPdf, isWord: f.isWord })) : [],
        }),
      })
    } catch { /* ignore */ }
  }

  // Crea nuova conversazione
  async function createConversation(title?: string): Promise<string | null> {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || 'Nuova conversazione' }),
      })
      if (res.ok) {
        const data = await res.json()
        await loadConversations()
        return data.id
      }
    } catch { /* ignore */ }
    return null
  }

  // Apri conversazione
  async function openConversation(conv: Conversation) {
    setCurrentConvId(conv.id)
    await loadMessages(conv.id)
    setShowSidebar(false)
  }

  // Rinomina conversazione
  async function renameConversation(convId: string, currentTitle: string, e: React.MouseEvent) {
    e.stopPropagation()
    const newTitle = prompt('Nuovo nome:', currentTitle)
    if (!newTitle || newTitle === currentTitle) return
    try {
      await fetch(`/api/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      })
      await loadConversations()
    } catch { /* ignore */ }
  }

  // Cancella conversazione
  async function deleteConversation(convId: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('Cancellare questa conversazione?')) return
    try {
      await fetch(`/api/conversations/${convId}`, { method: 'DELETE' })
      if (currentConvId === convId) {
        setCurrentConvId(null)
        setMessages([])
      }
      await loadConversations()
    } catch { /* ignore */ }
  }

  // Nuova chat
  async function newChat() {
    setCurrentConvId(null)
    setMessages([])
    setShowSidebar(false)
  }

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function stopAudioAnalysis() {
    cancelAnimationFrame(animFrameRef.current)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    analyserRef.current = null
    setAudioLevels([0, 0, 0, 0, 0])
  }

  function startAudioAnalysis() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)
      analyserRef.current = analyser

      const bufferLength = analyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)

      function updateLevels() {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)
        // Prendi 5 bande di frequenza
        const bands = 5
        const bandSize = Math.floor(bufferLength / bands)
        const levels: number[] = []
        for (let b = 0; b < bands; b++) {
          let sum = 0
          for (let j = b * bandSize; j < (b + 1) * bandSize; j++) {
            sum += dataArray[j]
          }
          levels.push(Math.min(1, (sum / bandSize) / 180))
        }
        setAudioLevels(levels)
        animFrameRef.current = requestAnimationFrame(updateLevels)
      }
      updateLevels()
    }).catch(() => {})
  }

  function toggleVoice() {
    if (isRecording) {
      recognitionRef.current?.stop()
      stopAudioAnalysis()
      setIsRecording(false)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Il tuo browser non supporta il riconoscimento vocale. Usa Chrome o Edge.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'it-IT'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = ''
      let interimText = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText += result[0].transcript + ' '
        } else {
          interimText += result[0].transcript
        }
      }
      setInput(finalText + interimText)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
      }
    }

    recognition.onerror = () => {
      stopAudioAnalysis()
      setIsRecording(false)
    }

    recognition.onend = () => {
      stopAudioAnalysis()
      setIsRecording(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    startAudioAnalysis()
    setIsRecording(true)
  }

  function autoResize() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }

  async function processFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    const MAX_SIZE = 50 * 1024 * 1024  // 50MB per tutti i file
    const newAttachments: FileAttachment[] = []

    for (const file of files) {
      if (file.size > MAX_SIZE) {
        alert(`"${file.name}" è troppo grande (max 50MB)`)
        continue
      }

      const nameLower = file.name.toLowerCase()
      const isImage = file.type.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/.test(nameLower)
      const isPdf = file.type === 'application/pdf' ||
        nameLower.endsWith('.pdf')
      const isWord =
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        file.type === 'application/msword' ||
        nameLower.endsWith('.docx') ||
        nameLower.endsWith('.doc')
      const isZip = file.type === 'application/zip' ||
        file.type === 'application/x-zip-compressed' ||
        nameLower.endsWith('.zip')

      if (isZip) {
        setPendingZipFile(file)
        // Carica progetti esistenti per suggerimenti
        try {
          const res = await fetch('/api/projects')
          if (res.ok) {
            const data = await res.json()
            setExistingProjects(data.projects || [])
          }
        } catch { /* ignore */ }
        setShowProjectModal(true)
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }

      if (!isImage && !isPdf && !isWord) {
        alert(`Formato non supportato: ${file.name}\nSupportati: foto, PDF, Word, ZIP`)
        continue
      }

      if (isWord) {
        try {
          const mammoth = await import('mammoth')
          const arrayBuffer = await file.arrayBuffer()
          const result = await mammoth.extractRawText({ arrayBuffer })
          newAttachments.push({
            name: file.name, mediaType: file.type, data: '',
            isImage: false, isPdf: false, isWord: true, isZip: false,
            preview: '', extractedText: result.value,
          })
        } catch {
          alert(`Errore lettura file Word: ${file.name}`)
        }
      } else {
        const data = await fileToBase64(file)
        // Deriva il mediaType dal nome file se il browser non lo fornisce
        let mediaType = file.type
        if (!mediaType || mediaType === 'application/octet-stream') {
          if (isPdf) mediaType = 'application/pdf'
          else if (/\.(jpg|jpeg)$/i.test(file.name)) mediaType = 'image/jpeg'
          else if (/\.png$/i.test(file.name)) mediaType = 'image/png'
          else if (/\.gif$/i.test(file.name)) mediaType = 'image/gif'
          else if (/\.webp$/i.test(file.name)) mediaType = 'image/webp'
          else if (/\.svg$/i.test(file.name)) mediaType = 'image/svg+xml'
          else if (/\.bmp$/i.test(file.name)) mediaType = 'image/bmp'
        }
        newAttachments.push({
          name: file.name, mediaType, data,
          isImage, isPdf, isWord: false, isZip: false,
          preview: isImage ? `data:${mediaType};base64,${data}` : '',
        })
      }
    }

    setPendingFiles(prev => [...prev, ...newAttachments])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) processFiles(e.target.files)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
  }

  function removeFile(index: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  async function sendMessage() {
    const text = input.trim()
    if ((!text && pendingFiles.length === 0) || loading) return

    // Avviso se troppi file PDF/immagini — il context window ha un limite
    const heavyFiles = pendingFiles.filter(f => f.isPdf || f.isImage)
    if (heavyFiles.length > 3) {
      const proceed = confirm(
        `Stai allegando ${heavyFiles.length} file pesanti.\n` +
        `Per risultati migliori, carica 1-3 file alla volta.\n\n` +
        `Vuoi procedere comunque? (i file più grandi potrebbero essere troncati)`
      )
      if (!proceed) return
    }

    // Se non c'è una conversazione attiva, creane una
    let convId = currentConvId
    if (!convId) {
      convId = await createConversation(text.slice(0, 60))
      if (!convId) {
        alert('Errore nella creazione della conversazione')
        return
      }
      setCurrentConvId(convId)
    }

    const userMsg: DisplayMessage = { role: 'user', text, files: pendingFiles.length > 0 ? [...pendingFiles] : undefined }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setPendingFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)
    setMessages([...newMessages, { role: 'assistant', text: '' }])

    // Salva messaggio utente
    await saveMessage(convId, 'user', text, userMsg.files)

    // Solo l'ultimo messaggio utente manda i file reali — i precedenti mandano solo testo
    // Questo evita di ri-mandare milioni di caratteri base64 dei file vecchi
    const lastIdx = newMessages.length - 1
    const apiMessages = newMessages.map((m, idx) => ({
      role: m.role,
      content: buildApiContent(m, idx === lastIdx && m.role === 'user'),
    }))

    // DEBUG: log cosa viene mandato all'API
    for (const m of apiMessages) {
      if (Array.isArray(m.content)) {
        const types = m.content.map((b: Record<string, unknown>) => {
          if (b.type === 'document' || b.type === 'image') {
            const src = b.source as Record<string, unknown> | undefined
            return `${b.type}(data: ${src?.data ? String(src.data).length + ' chars' : 'VUOTO!'})`
          }
          return b.type
        })
        console.log(`SEND → ${m.role}: [${types.join(', ')}]`)
      } else {
        console.log(`SEND → ${m.role}: "${String(m.content).slice(0, 80)}"`)
      }
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, conversationId: convId }),
      })
      if (!res.ok) {
        if (res.status === 401) { router.push('/login'); return }
        throw new Error()
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
        setMessages([...newMessages, { role: 'assistant', text: fullText }])
      }
      // Salva risposta assistente
      await saveMessage(convId, 'assistant', fullText)
      // Auto-salva come documento su Supabase se è una risposta sostanziosa
      if (fullText.length > 300) {
        const docTitle = text.slice(0, 80) || 'Documento'
        fetch('/api/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: docTitle,
            content: fullText,
            conversationId: convId,
          }),
        }).catch(() => {})
      }
      await loadConversations()
    } catch {
      setMessages([...newMessages, { role: 'assistant', text: '⚠️ Errore di connessione. Riprova.' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  // Carica progetti esistenti
  async function refreshProjects() {
    try {
      const res = await fetch('/api/projects')
      if (res.ok) {
        const data = await res.json()
        setExistingProjects(data.projects || [])
      }
    } catch { /* ignore */ }
  }

  // Gestione progetto — mostra opzioni
  const [projectAction, setProjectAction] = useState<{ id: string; name: string } | null>(null)

  async function renameProject(projectId: string) {
    const newName = prompt('Nuovo nome del progetto:')
    if (!newName) return
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      await refreshProjects()
      setProjectAction(null)
    } catch { /* ignore */ }
  }

  async function mergeProjectInto(fromId: string) {
    const others = existingProjects.filter(p => p.id !== fromId)
    if (others.length === 0) { alert('Non ci sono altri progetti.'); return }
    const names = others.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
    const choice = prompt(`In quale progetto vuoi spostare la memoria?\n\n${names}\n\nScrivi il numero:`)
    if (!choice) return
    const idx = parseInt(choice) - 1
    if (idx < 0 || idx >= others.length) { alert('Scelta non valida.'); return }
    const target = others[idx]
    if (!confirm(`Spostare tutta la memoria in "${target.name}" e eliminare il nome sbagliato?`)) return
    try {
      await fetch(`/api/projects/${fromId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeIntoId: target.id }),
      })
      await refreshProjects()
      setProjectAction(null)
    } catch { /* ignore */ }
  }

  async function deleteProjectFull(projectId: string, projectName: string) {
    if (!confirm(`Eliminare "${projectName}" E tutta la sua memoria? Questa azione è irreversibile.`)) return
    try {
      await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      await refreshProjects()
      setProjectAction(null)
    } catch { /* ignore */ }
  }

  // Trova progetto simile tra quelli esistenti
  function findSimilarProject(name: string): string | null {
    if (!name.trim()) return null
    const input = name.toLowerCase().trim()
    for (const p of existingProjects) {
      const pName = p.name.toLowerCase()
      // Match esatto
      if (pName === input) return p.name
      // Match contenuto (una stringa contiene l'altra)
      if (pName.includes(input) || input.includes(pName)) return p.name
      // Match parole chiave (almeno 2 parole in comune)
      const inputWords = input.split(/\s+/).filter(w => w.length > 2)
      const pWords = pName.split(/\s+/).filter(w => w.length > 2)
      const common = inputWords.filter(w => pWords.some(pw => pw.includes(w) || w.includes(pw)))
      if (common.length >= 2) return p.name
    }
    return null
  }

  function handleProjectNameChange(value: string) {
    setProjectName(value)
    const similar = findSimilarProject(value)
    setSuggestedProject(similar)
  }

  async function uploadProjectZip() {
    if (!pendingZipFile || !projectName.trim()) return
    const isNoProject = projectName === '__nessun_progetto__'
    const finalName = isNoProject ? '__generale__' : (suggestedProject || projectName.trim())
    setUploading(true)
    setUploadProgress({ phase: 'Caricamento file...', percent: 5, detail: pendingZipFile.name })

    try {
      const formData = new FormData()
      formData.append('file', pendingZipFile)
      formData.append('project', finalName)
      if (isNoProject) formData.append('noProject', 'true')

      // Simula progresso durante l'upload e la digestione
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev.percent < 20) return { ...prev, phase: 'Caricamento file...', percent: prev.percent + 2 }
          if (prev.percent < 40) return { ...prev, phase: 'Estrazione contenuti...', percent: prev.percent + 1 }
          if (prev.percent < 70) return { ...prev, phase: 'Studio e digestione documenti...', percent: prev.percent + 0.5, detail: 'Claude sta leggendo ogni file...' }
          if (prev.percent < 85) return { ...prev, phase: 'Generazione embeddings...', percent: prev.percent + 0.3, detail: 'Salvataggio nella memoria...' }
          if (prev.percent < 95) return { ...prev, phase: 'Verifica qualità...', percent: prev.percent + 0.2, detail: 'Check di comprensione...' }
          return prev
        })
      }, 1000)

      const res = await fetch('/api/projects', { method: 'POST', body: formData })
      clearInterval(progressInterval)

      if (!res.ok) {
        setUploadProgress({ phase: 'Errore!', percent: 0, detail: 'Caricamento fallito' })
        throw new Error()
      }

      setUploadProgress({ phase: 'Completato!', percent: 100, detail: '' })
      const data = await res.json()

      setTimeout(() => {
        setMessages(prev => [
          ...prev,
          { role: 'user', text: isNoProject
          ? `Ho caricato ${data.filesExtracted} file per analisi (fuori progetto)`
          : `Ho caricato il progetto "${data.project}" (${data.filesExtracted} file)` },
          { role: 'assistant', text: (() => {
            const report = data.report || []
            const header = isNoProject
              ? `Ho studiato e memorizzato i file caricati (memoria generale).\n\n`
              : `Ho studiato e memorizzato il progetto "${data.project}".\n\n`
            const stats = `Totale: ${data.filesExtracted} file\n` +
              `✅ Studiati: ${data.filesDigested}\n` +
              `${data.filesPreserved ? `📋 Conservati intatti: ${data.filesPreserved}\n` : ''}` +
              `${data.filesFailed ? `❌ Non letti: ${data.filesFailed}\n` : ''}`
            const fileList = report.map((r: { name: string; status: string; method?: string; error?: string; chars?: number }) => {
              if (r.status === 'digested') return `- ${r.name} ✅ (${r.method}, ${r.chars} car)`
              if (r.status === 'preserved') return `- ${r.name} 📋 conservato${r.error ? ` — ${r.error}` : ''}`
              if (r.status === 'failed') return `- ${r.name} ❌ ${r.error}`
              return `- ${r.name} ⏭️ ${r.error || 'non supportato'}`
            }).join('\n')
            const failedFiles = report.filter((r: { status: string }) => r.status === 'failed')
            const warning = failedFiles.length > 0
              ? `\n\n⚠️ ${failedFiles.length} file non letti. Puoi ricaricarli singolarmente come allegato nella chat.`
              : ''
            return header + stats + `\n${fileList}` + warning + `\n\nChiedimi quello che vuoi.`
          })() },
        ])
        setUploading(false)
        setShowProjectModal(false)
        setProjectName('')
        setPendingZipFile(null)
        setSuggestedProject(null)
        setUploadProgress({ phase: '', percent: 0, detail: '' })
      }, 1000)
    } catch {
      alert('Errore durante il caricamento del progetto. Riprova.')
      setUploading(false)
      setUploadProgress({ phase: '', percent: 0, detail: '' })
    }
  }

  async function logout() {
    await fetch('/api/auth', { method: 'DELETE' })
    router.push('/login')
  }

  function getContextName(msgIndex?: number) {
    let context = 'documento'
    if (msgIndex !== undefined) {
      for (let j = msgIndex - 1; j >= 0; j--) {
        if (messages[j].role === 'user' && messages[j].text) {
          context = messages[j].text.slice(0, 50).replace(/[^a-zA-Z0-9àèéìòùÀÈÉÌÒÙ ]/g, '').trim().replace(/\s+/g, '_')
          break
        }
      }
    }
    return context
  }

  async function downloadAsDoc(text: string, format: 'docx' | 'xlsx', msgIndex?: number) {
    const context = getContextName(msgIndex)
    const dateStr = new Date().toISOString().slice(0, 10)
    const fileName = `${context}_${dateStr}`
    try {
      const res = await fetch('/api/generate-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: format, content: text, fileName }),
      })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileName}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Errore nella generazione del file')
    }
  }

  function downloadAsFile(text: string, format: 'txt' | 'md' | 'html', msgIndex?: number) {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    // Prendi il messaggio utente precedente come nome contesto
    let context = 'documento'
    if (msgIndex !== undefined) {
      for (let j = msgIndex - 1; j >= 0; j--) {
        if (messages[j].role === 'user' && messages[j].text) {
          context = messages[j].text.slice(0, 50).replace(/[^a-zA-Z0-9àèéìòùÀÈÉÌÒÙ ]/g, '').trim().replace(/\s+/g, '_')
          break
        }
      }
    }
    const filename = `${context}_${dateStr}.${format}`

    let content = text
    let mimeType = 'text/plain'

    if (format === 'html') {
      mimeType = 'text/html'
      // Converti markdown base in HTML
      content = `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><title>Documento Cervellone</title>
<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}h1,h2,h3{color:#1a1a1a}</style>
</head><body>${text
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/## (.*?)(<br>)/g, '<h2>$1</h2>')
        .replace(/# (.*?)(<br>)/g, '<h1>$1</h1>')
      }</body></html>`
    }

    const blob = new Blob([content], { type: mimeType + ';charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function formatDate(dateStr: string) {
    const d = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return 'Ora'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}min fa`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h fa`
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
  }

  return (
    <div className="flex h-full bg-gray-50">
      {/* Sidebar conversazioni */}
      <div className={`fixed inset-y-0 left-0 z-40 w-72 bg-gray-900 text-white transform transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 md:flex md:flex-col`}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="font-bold text-sm">Conversazioni</h2>
          <button onClick={newChat} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">
            + Nuova
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <p className="text-gray-500 text-xs text-center mt-8 px-4">Nessuna conversazione.<br />Inizia a scrivere!</p>
          )}
          {conversations.map(conv => (
            <div
              key={conv.id}
              onClick={() => openConversation(conv)}
              className={`group w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800 transition-colors cursor-pointer flex items-center ${currentConvId === conv.id ? 'bg-gray-800' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{conv.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{formatDate(conv.updated_at)}</p>
              </div>
              <button
                onClick={(e) => renameConversation(conv.id, conv.title, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 p-1 flex-shrink-0 transition-opacity"
                title="Rinomina"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={(e) => deleteConversation(conv.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 flex-shrink-0 transition-opacity"
                title="Cancella"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-700">
          <button onClick={logout} className="text-gray-400 hover:text-white text-sm transition-colors w-full text-left">Esci</button>
        </div>
      </div>

      {/* Overlay sidebar mobile */}
      {showSidebar && (
        <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setShowSidebar(false)} />
      )}

      {/* Area chat principale */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <header className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between shadow-md flex-shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setShowSidebar(!showSidebar)} className="md:hidden text-gray-400 hover:text-white">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <CervelloneLogo size={32} />
            <span className="font-bold text-lg">Cervellone</span>
          </div>
          <button onClick={newChat} className="text-gray-400 hover:text-white text-sm transition-colors">
            Nuova chat
          </button>
        </header>

        {/* Messages + drag area */}
        <div
          className={`relative flex-1 overflow-y-auto px-4 py-4 space-y-4 transition-colors ${isDragOver ? 'bg-blue-50' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className="absolute inset-0 flex items-center justify-center bg-blue-50/90 z-10 border-2 border-dashed border-blue-400 m-2 rounded-2xl pointer-events-none">
              <div className="text-center">
                <div className="text-5xl mb-2">📎</div>
                <p className="text-blue-600 font-semibold text-lg">Rilascia i file qui</p>
                <p className="text-blue-400 text-sm mt-1">Foto, PDF, Word o ZIP progetto</p>
              </div>
            </div>
          )}

          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16">
              <CervelloneLogo size={80} />
              <div>
                <p className="font-semibold text-gray-600 text-lg">Ciao Raffaele!</p>
                <p className="text-sm text-gray-400 mt-1">Come posso aiutarti oggi?</p>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs max-w-xs mx-auto">
                  {['Genera un POS cantiere', 'Aiutami con un computo metrico', 'Scrivi un post per i social', 'Calcola un preventivo ponteggi'].map(s => (
                    <button key={s} onClick={() => setInput(s)}
                      className="bg-white border border-gray-200 rounded-xl px-3 py-2 hover:bg-blue-50 hover:border-blue-200 transition-colors text-gray-600 text-left">
                      {s}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-300 mt-6">Puoi anche trascinare file o ZIP nella chat</p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`rounded-2xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'max-w-[80%] bg-blue-600 text-white rounded-br-sm px-4 py-3'
                  : 'max-w-[92%] bg-white text-gray-800 shadow-sm border border-gray-100 rounded-bl-sm px-5 py-4'
              }`}>
                {msg.files && msg.files.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {msg.files.map((f, fi) =>
                      f.isImage ? (
                        <img key={fi} src={f.preview} alt={f.name} className="max-h-40 max-w-full rounded-lg object-cover" />
                      ) : (
                        <div key={fi} className="flex items-center gap-1 bg-white/20 rounded-lg px-2 py-1 text-xs">
                          <span>{f.isPdf ? '📄' : '📝'}</span>
                          <span className="truncate max-w-[120px]">{f.name}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <MarkdownRenderer content={msg.text} />
                ) : (
                  <span className="whitespace-pre-wrap">{msg.text}</span>
                )}
                {msg.role === 'assistant' && loading && i === messages.length - 1 && msg.text === '' && (
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">•</span>
                    <span className="animate-bounce [animation-delay:0.1s]">•</span>
                    <span className="animate-bounce [animation-delay:0.2s]">•</span>
                  </span>
                )}
                {/* Bottoni scarica — solo su risposte assistente completate e con testo sostanzioso */}
                {msg.role === 'assistant' && msg.text.length > 200 && !(loading && i === messages.length - 1) && (
                  <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-gray-100">
                    <button onClick={() => downloadAsDoc(msg.text, 'docx', i)} className="text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1 font-medium">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      Word
                    </button>
                    <button onClick={() => downloadAsDoc(msg.text, 'xlsx', i)} className="text-xs bg-green-50 text-green-600 hover:bg-green-100 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1 font-medium">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      Excel
                    </button>
                    <button onClick={() => downloadAsFile(msg.text, 'txt', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                      TXT
                    </button>
                    <button onClick={() => downloadAsFile(msg.text, 'md', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                      MD
                    </button>
                    <button onClick={() => downloadAsFile(msg.text, 'html', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                      HTML
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="bg-white border-t border-gray-200 px-4 py-3 flex-shrink-0">
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 max-w-3xl mx-auto">
              {pendingFiles.map((f, i) => (
                <div key={i} className="relative">
                  {f.isImage ? (
                    <>
                      <img src={f.preview} alt={f.name} className="h-16 w-16 object-cover rounded-xl border border-gray-200" />
                      <button onClick={() => removeFile(i)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center">×</button>
                    </>
                  ) : (
                    <div className="flex items-center gap-1 bg-gray-100 rounded-xl px-3 py-2 text-xs text-gray-700 border border-gray-200">
                      <span>{f.isPdf ? '📄' : '📝'}</span>
                      <span className="truncate max-w-[100px]">{f.name}</span>
                      <button onClick={() => removeFile(i)} className="text-red-400 hover:text-red-600 ml-1">×</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 max-w-3xl mx-auto">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.docx,.doc,.zip"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="text-gray-400 hover:text-blue-500 disabled:opacity-40 flex-shrink-0 pb-3 transition-colors"
              title="Allega file (foto, PDF, Word, ZIP progetto)"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>

            <div className="flex items-end gap-1 flex-shrink-0 pb-3">
              <button
                onClick={toggleVoice}
                disabled={loading}
                className={`transition-colors ${isRecording ? 'text-red-500' : 'text-gray-400 hover:text-blue-500 disabled:opacity-40'}`}
                title={isRecording ? 'Ferma registrazione' : 'Dettatura vocale'}
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </button>
              {isRecording && (
                <div className="flex items-end gap-[3px] h-6">
                  {audioLevels.map((level, idx) => (
                    <div
                      key={idx}
                      className="w-[3px] rounded-full bg-red-500 transition-all duration-75"
                      style={{ height: `${Math.max(4, level * 24)}px` }}
                    />
                  ))}
                </div>
              )}
            </div>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize() }}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? 'Sto ascoltando...' : 'Scrivi un messaggio...'}
              rows={1}
              className={`flex-1 resize-none text-gray-900 placeholder-gray-500 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 max-h-40 ${isRecording ? 'bg-red-50 ring-2 ring-red-300' : 'bg-gray-100'}`}
            />
            <button
              onClick={sendMessage}
              disabled={loading || (!input.trim() && pendingFiles.length === 0)}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-full w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <svg className="w-5 h-5 rotate-90" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </div>
          <p className="text-center text-xs text-gray-400 mt-2">Invio per mandare • Shift+Invio per a capo • microfono per dettare • trascina file</p>
        </div>
      </div>

      {/* Modale nome progetto per ZIP */}
      {showProjectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            {!uploading ? (
              <>
                <h3 className="font-bold text-gray-900 text-lg mb-2">Carica progetto</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Stai caricando: <span className="font-medium">{pendingZipFile?.name}</span><br />
                  A quale progetto appartiene?
                </p>

                {/* Progetti esistenti */}
                {existingProjects.filter(p => p.slug !== '__generale__').length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs text-gray-400 mb-1.5">Progetti esistenti:</p>
                    <div className="space-y-1.5">
                      {existingProjects.filter(p => p.slug !== '__generale__').map(p => (
                        <div key={p.id}>
                          <div className={`flex items-center gap-1.5 text-xs rounded-lg border px-2.5 py-1.5 transition-colors ${
                            suggestedProject === p.name
                              ? 'bg-green-50 border-green-400 text-green-700'
                              : 'bg-gray-50 border-gray-200 text-gray-600'
                          }`}>
                            <button
                              onClick={() => { setProjectName(p.name); setSuggestedProject(p.name) }}
                              className="flex-1 text-left hover:text-blue-600 truncate"
                            >
                              {p.name}
                            </button>
                            <button
                              onClick={() => setProjectAction(projectAction?.id === p.id ? null : { id: p.id, name: p.name })}
                              className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                              title="Gestisci progetto"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                              </svg>
                            </button>
                          </div>
                          {/* Menu azioni progetto */}
                          {projectAction?.id === p.id && (
                            <div className="ml-2 mt-1 mb-1 space-y-1 animate-in">
                              <button
                                onClick={() => renameProject(p.id)}
                                className="w-full text-left text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                              >
                                ✏️ Rinomina progetto
                              </button>
                              <button
                                onClick={() => mergeProjectInto(p.id)}
                                className="w-full text-left text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                              >
                                🔀 Sposta memoria in altro progetto
                              </button>
                              <button
                                onClick={() => deleteProjectFull(p.id, p.name)}
                                className="w-full text-left text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                              >
                                🗑️ Elimina tutto (memoria inclusa)
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Opzione fuori progetto */}
                <button
                  onClick={() => { setProjectName('__nessun_progetto__'); setSuggestedProject(null) }}
                  className={`w-full text-left text-xs px-3 py-2 rounded-lg border mb-3 transition-colors ${
                    projectName === '__nessun_progetto__'
                      ? 'bg-gray-800 border-gray-700 text-white'
                      : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  Nessun progetto — solo analisi e memoria generale
                </button>

                <p className="text-xs text-gray-400 mb-1.5">{existingProjects.length > 0 ? 'Oppure crea nuovo:' : 'Nome progetto:'}</p>
                <input
                  type="text"
                  value={projectName === '__nessun_progetto__' ? '' : projectName}
                  onChange={(e) => handleProjectNameChange(e.target.value)}
                  placeholder="Es: Bando Fotovoltaico 2026"
                  disabled={projectName === '__nessun_progetto__'}
                  className={`w-full rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 mb-2 text-sm ${
                    projectName === '__nessun_progetto__' ? 'bg-gray-200 text-gray-400' : 'bg-gray-100 text-gray-900'
                  }`}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && projectName.trim()) uploadProjectZip() }}
                />

                {/* Suggerimento progetto simile */}
                {suggestedProject && suggestedProject !== projectName && (
                  <button
                    onClick={() => { setProjectName(suggestedProject); setSuggestedProject(suggestedProject) }}
                    className="w-full text-left text-xs bg-yellow-50 border border-yellow-300 text-yellow-800 rounded-lg px-3 py-2 mb-2 hover:bg-yellow-100 transition-colors"
                  >
                    Intendi <strong>{suggestedProject}</strong>? Clicca per aggiungere a quel progetto.
                  </button>
                )}

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => { setShowProjectModal(false); setPendingZipFile(null); setProjectName(''); setSuggestedProject(null) }}
                    className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl py-2.5 text-sm font-medium transition-colors"
                  >
                    Annulla
                  </button>
                  <button
                    onClick={uploadProjectZip}
                    disabled={!projectName.trim()}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
                  >
                    {suggestedProject ? 'Aggiungi al progetto' : 'Crea e carica'}
                  </button>
                </div>
              </>
            ) : (
              /* Barra di avanzamento elegante */
              <div className="py-2">
                <div className="flex items-center gap-3 mb-5">
                  <div className="relative w-10 h-10 flex-shrink-0">
                    <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                      <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
                      <circle cx="18" cy="18" r="15.5" fill="none" stroke="url(#progressGrad)" strokeWidth="2.5"
                        strokeDasharray={`${uploadProgress.percent * 0.974} 100`}
                        strokeLinecap="round" className="transition-all duration-700 ease-out" />
                      <defs>
                        <linearGradient id="progressGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#3b82f6" />
                          <stop offset="100%" stopColor="#8b5cf6" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-gray-700">{Math.round(uploadProgress.percent)}%</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{uploadProgress.phase}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{uploadProgress.detail}</p>
                  </div>
                </div>

                {/* Barra lineare sottile */}
                <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 via-violet-500 to-blue-500 bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite] transition-all duration-700 ease-out"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>

                {uploadProgress.percent === 100 && (
                  <p className="text-center text-xs text-violet-600 font-medium mt-4 animate-pulse">Completato!</p>
                )}

                <style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
