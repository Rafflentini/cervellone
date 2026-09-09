'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import CervelloneLogo from '@/components/CervelloneLogo'

// Client Supabase per upload diretto dal browser (bypassa il limite 4.5MB di Vercel)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseClient = createClient(supabaseUrl, supabaseAnonKey)
import MarkdownRendererBase from '@/components/MarkdownRenderer'

const MarkdownRenderer = React.memo(MarkdownRendererBase, (prev, next) => prev.content === next.content)
import DocumentPreviewPanel from '@/components/DocumentPreviewPanel'
import SplitPanel from '@/components/SplitPanel'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { staNelTettoKeepalive } from '@/lib/chat-save-limits'
import {
  decidiDopoRiconoscimento,
  componiTestoDettatura,
  MAX_REGISTRAZIONE_MS,
} from '@/lib/dettatura'
import { messaggioErroreChat } from '@/lib/chat-errori'

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
  uploadUrl?: string // Per file grandi caricati su Supabase Storage
}

type DisplayMessage = {
  role: 'user' | 'assistant'
  text: string
  files?: FileAttachment[]
  /**
   * Avvisi scritti dalla pagina, non dal modello: "Connessione persa", "I file
   * sono troppo pesanti". Restano sotto gli occhi dell'Ingegnere ma NON vanno
   * spediti al modello come se fossero una sua risposta — glielo farebbero
   * credere di aver fallito, e rifarebbe un lavoro che il server ha finito.
   */
  soloLocale?: boolean
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
    if (file.uploadUrl) {
      // File grande caricato su Storage — manda URL per download server-side
      blocks.push({ type: 'text', text: `[FILE_URL:${file.uploadUrl}:${file.name}:${file.mediaType}]` })
    } else if (file.isImage && file.data) {
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

  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [audioLevels, setAudioLevels] = useState<number[]>([0, 0, 0, 0, 0])
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)
  // Registrazione dell'audio dettato: gira sullo STESSO stream gia' aperto per
  // l'animazione delle barrette, quindi non chiede un secondo permesso al
  // microfono. Serve a far trascrivere la dettatura dal server, con lo stesso
  // motore di Telegram — il riconoscimento del browser resta solo per mostrare
  // le parole mentre si parla. Vedi src/app/api/trascrivi/route.ts.
  // Messaggi scritti mentre il bot stava ancora rispondendo. Il ref e' la fonte
  // di verita' (le closure di sendMessage vedono lo stato vecchio); `coda` serve
  // solo a mostrarli.
  const codaRef = useRef<Array<{ text: string; files: FileAttachment[] }>>([])
  const [coda, setCoda] = useState<string[]>([])
  const recorderRef = useRef<MediaRecorder | null>(null)
  const pezziAudioRef = useRef<Blob[]>([])
  const inizioRegistrazioneRef = useRef<number>(0)
  const [trascrizioneInCorso, setTrascrizioneInCorso] = useState(false)
  // True sui browser senza SpeechRecognition: si registra e trascrive il server,
  // quindi non compare testo mentre si parla e va detto all'utente.
  const [soloRegistrazione, setSoloRegistrazione] = useState(false)
  const timerRegistrazioneRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Chi comanda la fine della dettatura. Il riconoscimento del browser chiude da
  // solo a ogni pausa di silenzio: se lasciassimo decidere lui, una dettatura
  // lunga finirebbe a meta'. Questi tre ref dicono se l'Ingegnere vuole ancora
  // registrare, da quando, e cosa ha gia' dettato prima dell'ultima pausa.
  const vuoleRegistrareRef = useRef(false)
  const inizioDettaturaRef = useRef<number>(0)
  const testoFissatoRef = useRef('')
  /** L'ultimo testo dato per definitivo dalla sessione di riconoscimento in corso. */
  const ultimoFinaleRef = useRef('')
  /** Quando e' partita la sessione di riconoscimento corrente (non la dettatura). */
  const inizioSessioneRef = useRef<number>(0)
  /** Sessioni chiuse subito, di fila, senza aver riconosciuto una sola parola. */
  const riavviiRapidiRef = useRef(0)
  /**
   * Cresce a ogni avvio e a ogni stop. Serve a riconoscere uno stream aperto da
   * una dettatura ormai abbandonata: `getUserMedia` puo' risolvere dopo lo stop.
   */
  const generazioneDettaturaRef = useRef(0)

  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const batchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingTextRef = useRef('')
  const router = useRouter()

  // Il salvataggio d'emergenza alla chiusura della pagina non c'e' piu': dall'8
  // set 2026 la risposta la scrive il SERVER (`api/chat/route.ts`), che la
  // scrive per intero anche se il browser sparisce a meta' streaming.
  //
  // Toglierlo non e' una perdita, e' una correzione: il beacon partiva a meta'
  // streaming, cioe' PRIMA del server, quindi la deduplica a 5 minuti della
  // route non poteva vederlo — e siccome il testo parziale non e' mai identico
  // a quello completo, non lo avrebbe scartato comunque. Il risultato erano DUE
  // righe: una mutilata e una intera, e la mutilata rientrava anche nel
  // contesto del modello al turno dopo.

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
  async function saveMessage(
    convId: string,
    role: string,
    content: string,
    files?: FileAttachment[],
    /**
     * Chiave d'invio: un id coniato una volta sola per QUESTO invio. Se la
     * stessa richiesta parte due volte — un ritentativo, un doppio click, una
     * corsa fra due percorsi — la seconda porta la stessa chiave e l'indice
     * unico parziale sul database la scarta. E' l'equipollente di
     * `telegram_dedup`, che su Telegram tiene da sei mesi mentre qui non c'era
     * niente: 85 domande scritte due volte fra aprile e agosto.
     *
     * Due invii DIVERSI hanno due chiavi, quindi un "ok" scritto davvero due
     * volte passa. E' per questo che la dedup non puo' stare sul contenuto.
     */
    clientMsgId?: string,
  ) {
    try {
      const corpo = JSON.stringify({
        role,
        content,
        files: files ? files.map(f => ({ name: f.name, isImage: f.isImage, isPdf: f.isPdf, isWord: f.isWord })) : [],
        ...(clientMsgId ? { clientMsgId } : {}),
      })

      // `keepalive` fa sopravvivere la richiesta alla chiusura della pagina, ma
      // il browser lo paga con un tetto di ~64KB sul corpo — e quel tetto vale
      // SEMPRE, non solo durante la chiusura. Attivarlo indiscriminatamente
      // farebbe fallire in silenzio il salvataggio di ogni risposta lunga anche
      // a scheda aperta. La soglia e in `chat-save-limits`, dove ha dei test.
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: staNelTettoKeepalive(corpo),
        body: corpo,
      })
      // `fetch` non lancia sui 4xx/5xx. Senza questo controllo un rifiuto della
      // route spariva in silenzio: da quando la RISPOSTA la scrive il server,
      // una domanda persa qui lascerebbe in `messages` una risposta orfana.
      if (!res.ok) {
        console.warn(`[chat] messaggio non salvato (${role}): HTTP ${res.status}`)
      }
    } catch (err) {
      // Non piu ingoiato: un messaggio che non si salva e una perdita, e va
      // almeno lasciata a log invece di sparire senza traccia.
      console.warn(`[chat] messaggio non salvato (${role}): ${err instanceof Error ? err.message : String(err)}`)
    }
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
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      })
    }, 100)
  }, [messages])

  // Uscendo dalla chat mentre si detta, il riconoscimento e il MediaRecorder
  // restavano vivi e nessuno poteva piu' fermarli: il pulsante non c'e' piu'.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    vuoleRegistrareRef.current = false
    try { recognitionRef.current?.stop() } catch { /* gia' fermo */ }
    recognitionRef.current = null
    // Zittisce `onstop` PRIMA di fermare il registratore: altrimenti fermarlo
    // farebbe partire una trascrizione sul server per una pagina che non c'e'
    // piu' — pagata, e con nessuno a leggerne il risultato.
    if (recorderRef.current) recorderRef.current.onstop = null
    stopAudioAnalysis()
  }, [])

  function stopAudioAnalysis() {
    // Invalida qualunque `getUserMedia` ancora in volo: lo stream che arrivera'
    // dopo si accorgera' di appartenere a una dettatura gia' chiusa.
    generazioneDettaturaRef.current++
    if (timerRegistrazioneRef.current) {
      clearTimeout(timerRegistrazioneRef.current)
      timerRegistrazioneRef.current = null
    }
    cancelAnimationFrame(animFrameRef.current)
    // PRIMA il registratore, poi le tracce: fermare lo stream per primo lascia
    // MediaRecorder senza l'ultimo blocco di audio, e la dettatura arriverebbe
    // al server troncata sul finale — cioe' proprio dove di solito sta la parte
    // che conta ("...e mandalo a Blasi").
    if (recorderRef.current) {
      try { if (recorderRef.current.state !== 'inactive') recorderRef.current.stop() } catch { /* gia' fermo */ }
      recorderRef.current = null
    }
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

  /**
   * Manda al server la dettatura appena registrata e, se torna qualcosa di
   * meglio, sostituisce il testo nella casella.
   *
   * Perche' sostituire e non aggiungere: il riconoscimento del browser e quello
   * del server hanno ascoltato lo STESSO audio. Quello del server conosce i nomi
   * veri dei clienti e dei cantieri e scarta le frasi che il trascrittore
   * inventa sul silenzio, quindi vince lui. Se pero' non ha capito nulla, si
   * tiene quello che aveva scritto il browser: non si peggiora mai.
   */
  async function trascriviDalServer(blob: Blob, durataSec: number) {
    if (blob.size === 0) return
    setTrascrizioneInCorso(true)
    try {
      const form = new FormData()
      form.append('audio', blob, 'dettatura.webm')
      form.append('durata', String(durataSec))
      const res = await fetch('/api/trascrivi', { method: 'POST', body: form })
      const esito = await res.json().catch(() => null)
      if (esito?.testo) {
        setInput(esito.testo)
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
        }
      }
    } catch {
      // Il testo del browser resta: una trascrizione mancata non deve
      // cancellare quello che l'Ingegnere ha appena dettato.
    } finally {
      setTrascrizioneInCorso(false)
    }
  }

  function startAudioAnalysis() {
    // `getUserMedia` e' asincrona e puo' metterci parecchio (il browser chiede
    // il permesso). Se nel frattempo l'Ingegnere preme stop, `stopAudioAnalysis`
    // non trova ancora niente da fermare: senza questa generazione lo stream si
    // aprirebbe DOPO, con il microfono acceso a tempo indeterminato, il pulsante
    // gia' tornato a riposo e nemmeno il tetto armato.
    const generazione = ++generazioneDettaturaRef.current
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (generazione !== generazioneDettaturaRef.current) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      streamRef.current = stream

      // Registrazione parallela sullo stesso stream. Best-effort: se il browser
      // non supporta MediaRecorder resta la dettatura del browser, come prima.
      try {
        pezziAudioRef.current = []
        inizioRegistrazioneRef.current = Date.now()
        const rec = new MediaRecorder(stream)
        rec.ondataavailable = (e) => { if (e.data.size > 0) pezziAudioRef.current.push(e.data) }
        rec.onstop = () => {
          const durata = (Date.now() - inizioRegistrazioneRef.current) / 1000
          const blob = new Blob(pezziAudioRef.current, { type: rec.mimeType || 'audio/webm' })
          pezziAudioRef.current = []
          void trascriviDalServer(blob, durata)
        }
        recorderRef.current = rec
        rec.start()
      } catch {
        recorderRef.current = null
      }
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

  /** Fa partire il tetto: oltre i 5 minuti la dettatura si chiude comunque. */
  function armaTettoDettatura() {
    if (timerRegistrazioneRef.current) clearTimeout(timerRegistrazioneRef.current)
    timerRegistrazioneRef.current = setTimeout(() => {
      vuoleRegistrareRef.current = false
      recognitionRef.current?.stop()
      stopAudioAnalysis()
      setIsRecording(false)
    }, MAX_REGISTRAZIONE_MS)
  }

  function toggleVoice() {
    if (isRecording) {
      // PRIMA si dichiara che non si vuole piu' registrare, poi si ferma il
      // riconoscimento: altrimenti il suo `onend` lo farebbe ripartire.
      vuoleRegistrareRef.current = false
      recognitionRef.current?.stop()
      stopAudioAnalysis()
      setIsRecording(false)
      return
    }

    vuoleRegistrareRef.current = true
    inizioDettaturaRef.current = Date.now()
    testoFissatoRef.current = ''
    // Va azzerato anche questo, non solo testoFissatoRef: altrimenti l'ultima
    // frase della dettatura PRECEDENTE resta qui dentro e alla prima pausa di
    // questa riaffiora nella casella ("manda il computo a Blasi buongiorno").
    ultimoFinaleRef.current = ''
    riavviiRapidiRef.current = 0

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      // Niente riconoscimento nel browser (Firefox, Safari vecchi): si registra
      // e basta, e trascrive il server — lo stesso motore di Telegram.
      //
      // Prima qui c'era `alert('Usa Chrome o Edge')`. Aveva senso finche' la
      // trascrizione avveniva SOLO nel browser; da quando esiste /api/trascrivi
      // quel messaggio nega una funzione che c'e'. Si perde solo il testo che
      // compare mentre si parla: la trascrizione arriva quando si smette.
      setSoloRegistrazione(true)
      startAudioAnalysis()
      setIsRecording(true)
      // Nel modo normale e' il riconoscimento del browser a chiudere da solo sul
      // silenzio. Qui non c'e' nessuno a farlo: senza un tetto, un microfono
      // dimenticato aperto registra finche' la pagina resta viva.
      armaTettoDettatura()
      return
    }

    setSoloRegistrazione(false)
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
      // `event.results` riparte da zero a ogni riavvio: quello detto prima
      // dell'ultima pausa vive in testoFissatoRef.
      ultimoFinaleRef.current = finalText
      // Si e' sentita una parola: la catena di riavvii a vuoto e' spezzata.
      riavviiRapidiRef.current = 0
      setInput(componiTestoDettatura(testoFissatoRef.current, finalText, interimText))
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
      }
    }

    /**
     * Il riconoscimento del browser e' finito (pausa di silenzio, errore
     * passeggero, oppure stop dell'Ingegnere). Decide `decidiDopoRiconoscimento`:
     * la registrazione VERA non si ferma per una pausa.
     */
    const dopoRiconoscimento = (esito: Parameters<typeof decidiDopoRiconoscimento>[0]) => {
      // Una sessione chiusa entro un secondo dall'avvio non ha ascoltato niente:
      // e' un giro a vuoto. Se se ne accumulano troppi di fila si smette.
      const durataSessione = Date.now() - inizioSessioneRef.current
      riavviiRapidiRef.current = durataSessione < 1000 ? riavviiRapidiRef.current + 1 : 0

      const azione = decidiDopoRiconoscimento(
        esito,
        {
          utenteVuoleRegistrare: vuoleRegistrareRef.current,
          msTrascorsi: Date.now() - inizioDettaturaRef.current,
          // Doppio tap: questo evento puo' arrivare da una sessione gia'
          // sostituita. Non deve toccare la dettatura nuova.
          eLaSessioneCorrente: recognitionRef.current === recognition,
          riavviiRapidiConsecutivi: riavviiRapidiRef.current,
        },
        MAX_REGISTRAZIONE_MS,
      )
      if (azione === 'ignora') return
      if (azione === 'ferma') {
        vuoleRegistrareRef.current = false
        stopAudioAnalysis()
        setIsRecording(false)
        return
      }
      // Si riparte: il testo gia' riconosciuto diventa definitivo, perche' i
      // results della sessione nuova ricominciano vuoti.
      testoFissatoRef.current = componiTestoDettatura(
        testoFissatoRef.current,
        ultimoFinaleRef.current,
        '',
      )
      ultimoFinaleRef.current = ''
      try {
        inizioSessioneRef.current = Date.now()
        recognition.start()
      } catch {
        // Il browser non lo ha ancora rilasciato: la registrazione continua
        // comunque, si perde solo il testo mostrato mentre si parla.
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      dopoRiconoscimento({ tipo: 'errore', codice: event.error })
    }

    recognition.onend = () => {
      dopoRiconoscimento({ tipo: 'fine' })
    }

    recognitionRef.current = recognition
    inizioSessioneRef.current = Date.now()
    recognition.start()
    startAudioAnalysis()
    setIsRecording(true)
    // Il tetto vale anche qui. Prima stava SOLO nel ramo senza riconoscimento:
    // sul browser "supportato" a chiudere era la pausa di silenzio, e una
    // dettatura lunga non arrivava in fondo.
    armaTettoDettatura()
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

      // Accetta spreadsheet, testo, e qualsiasi altro formato
      const isSpreadsheetOrText = /\.(xlsx|xls|ods|csv|txt|dwg|dxf|json|xml|html|htm|md|rtf|odt|ppt|pptx|odp|svg|tiff|tif|heic)$/i.test(nameLower)
      const isGenericFile = !isImage && !isPdf && !isWord && !isSpreadsheetOrText && !isZip

      if (isSpreadsheetOrText || isGenericFile) {
        // Qualsiasi file non-immagine/non-PDF: prova a leggerlo come testo
        try {
          const text = await file.text()
          if (text && text.length > 50) {
            newAttachments.push({
              name: file.name, mediaType: file.type || 'text/plain', data: '',
              isImage: false, isPdf: false, isWord: true, isZip: false,
              preview: '', extractedText: `[File: ${file.name}]\n\n${text.slice(0, 200000)}`,
            })
          } else {
            // File binario — manda come base64
            const data = await fileToBase64(file)
            newAttachments.push({
              name: file.name, mediaType: file.type || 'application/octet-stream', data,
              isImage: false, isPdf: false, isWord: true, isZip: false,
              preview: '', extractedText: `[File binario: ${file.name}, ${(file.size / 1024).toFixed(0)} KB]`,
            })
          }
        } catch {
          alert(`Errore lettura file: ${file.name}`)
        }
      } else if (isWord) {
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

  /**
   * Solo i FILE ci interessano. Senza questo controllo, `preventDefault` su
   * tutta la colonna impedirebbe anche di trascinare del TESTO nella casella —
   * da un messaggio della chat o da un'altra finestra — e farebbe lampeggiare
   * l'invito "Rilascia i file qui" per una selezione di parole.
   */
  const staTrascinandoFile = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  function handleDragOver(e: React.DragEvent) {
    if (!staTrascinandoFile(e)) return
    e.preventDefault()
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    // Ora che la zona di rilascio e' tutta la colonna, `dragleave` scatta a ogni
    // passaggio da un figlio all'altro. Senza questa guardia l'invito
    // "Rilascia i file qui" lampeggerebbe mentre si attraversa la pagina.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setIsDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    if (!staTrascinandoFile(e)) return
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
  }

  function removeFile(index: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  async function sendMessage(daCoda?: { text: string; files: FileAttachment[] }) {
    const text = (daCoda?.text ?? input).trim()
    const files = daCoda?.files ?? pendingFiles
    if (!text && files.length === 0) return

    // Un messaggio scritto MENTRE il bot lavora non si perde: va in coda e parte
    // appena il turno finisce.
    //
    // Prima qui c'era `|| loading` nella guardia sopra: premere Invio durante
    // l'elaborazione non faceva assolutamente NIENTE, in silenzio. Su Telegram
    // lo stesso messaggio finisce in `telegram_coda` (fix del 2 settembre) e
    // viene ripreso dopo — un'altra funzione costruita per un canale solo.
    // Vedi [[feedback_due_canali_equipollenti]].
    if (loading && !daCoda) {
      codaRef.current = [...codaRef.current, { text, files: [...files] }]
      setCoda(codaRef.current.map((m) => m.text))
      setInput('')
      setPendingFiles([])
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }

    // L'abort vale solo per un turno che si sta SOSTITUENDO, non per i messaggi
    // in coda: annullarlo qui ucciderebbe la risposta che il bot sta scrivendo.
    if (abortControllerRef.current && !daCoda) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    // Avviso se troppi file PDF/immagini — il context window ha un limite
    const heavyFiles = files.filter(f => f.isPdf || f.isImage)
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

    const userMsg: DisplayMessage = { role: 'user', text, files: files.length > 0 ? [...files] : undefined }
    const newMessages = [...messages, userMsg]
    setInput('')
    setPendingFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)
    setMessages([...newMessages, { role: 'assistant', text: '' }])

    // Salva messaggio utente.
    //
    // La chiave si conia QUI, una volta per messaggio: identifica l'intenzione
    // dell'Ingegnere, non la chiamata di funzione. Cosi' un ritentativo della
    // stessa POST — la rete che ripete, `keepalive` che rispedisce — non scrive
    // una seconda riga, mentre due messaggi davvero distinti restano distinti.
    const chiaveInvio =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    await saveMessage(convId, 'user', text, userMsg.files, chiaveInvio)

    // Per file grandi (>3MB base64 = ~2MB reali): carica su Supabase Storage direttamente dal browser
    if (userMsg.files) {
      for (const file of userMsg.files) {
        if (file.data && file.data.length > 3 * 1024 * 1024 && (file.isPdf || file.isImage)) {
          try {
            const binary = atob(file.data)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            const blob = new Blob([bytes], { type: file.mediaType })
            const storagePath = `${Date.now()}_${file.name}`
            const { error: uploadErr } = await supabaseClient.storage.from('uploads').upload(storagePath, blob, { contentType: file.mediaType })
            if (!uploadErr) {
              const { data: urlData } = await supabaseClient.storage.from('uploads').createSignedUrl(storagePath, 86400)
              if (urlData?.signedUrl) {
                file.uploadUrl = urlData.signedUrl
                file.data = '' // Libera memoria
              }
            }
          } catch { /* fallback: manda base64 */ }
        }
      }
    }

    // Solo l'ultimo messaggio utente manda i file reali — i precedenti mandano solo testo
    // I messaggi assistant vecchi: comprimi i blocchi ~~~document (HTML enorme) in un riferimento breve
    // Gli avvisi scritti dalla pagina (connessione persa, file troppo pesanti)
    // NON vanno al modello: non sono sue risposte, e spedirglieli gli farebbe
    // credere di aver fallito un turno che il server ha invece completato.
    const daMandare = newMessages.filter(m => !m.soloLocale)
    const lastIdx = daMandare.length - 1
    const apiMessages = daMandare.map((m, idx) => {
      const isLast = idx === lastIdx
      let content = buildApiContent(m, isLast && m.role === 'user')
      // Comprimi blocchi ~~~document nei messaggi assistant NON ultimi
      if (m.role === 'assistant' && !isLast && typeof content === 'string') {
        content = content.replace(/~~~document\n[\s\S]*?~~~(?:\n|$)/g, '[Documento già generato — visibile nel pannello anteprima]\n')
      }
      return { role: m.role, content }
    })

    // Serve solo a MOSTRARE il testo mentre arriva. Dall'8 set 2026 non e' piu'
    // questo il punto che salva la risposta: la scrive il server in
    // `api/chat/route.ts`, per intero e anche se il browser sparisce a meta'.
    let fullText = ''

    try {
      const jsonBody = JSON.stringify({ messages: apiMessages, conversationId: convId })

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody,
        signal: abortControllerRef.current?.signal,
      })
      if (!res.ok) {
        if (res.status === 401) { router.push('/login'); return }
        if (res.status === 413) {
          const bodySizeMB = (new Blob([jsonBody]).size / (1024 * 1024)).toFixed(1)
          throw new Error(
            `I file sono troppo pesanti (${bodySizeMB} MB).\n\n` +
            `⚠️ Vercel è probabilmente sul piano Hobby (limite 4.5 MB per richiesta).\n` +
            `Con il piano Pro il limite sale a 100 MB.\n\n` +
            `💡 Cosa fare:\n` +
            `• Verifica il piano Vercel su vercel.com/dashboard\n` +
            `• Oppure carica il file da Telegram (nessun limite di body)\n` +
            `• Oppure comprimi il PDF e riprova`
          )
        }
        const errorText = await res.text().catch(() => '')
        throw new Error(errorText || `Errore server (${res.status})`)
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()

      pendingTextRef.current = ''

      // Batch: accumula chunk e aggiorna stato ogni 50ms invece di ogni singolo chunk
      const flushBatch = () => {
        if (pendingTextRef.current) {
          fullText += pendingTextRef.current
          pendingTextRef.current = ''
          const textSnapshot = fullText
          setMessages([...newMessages, { role: 'assistant', text: textSnapshot }])
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pendingTextRef.current += decoder.decode(value, { stream: true })
        if (!batchTimeoutRef.current) {
          batchTimeoutRef.current = setTimeout(() => {
            batchTimeoutRef.current = null
            flushBatch()
          }, 50)
        }
      }
      // Flush finale — assicura che tutto il testo venga mostrato
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current)
        batchTimeoutRef.current = null
      }
      flushBatch()
      // La risposta NON la salva il browser: la scrive il server in
      // `api/chat/route.ts`, per intero e con i link ai documenti.
      // Aggiorna lista conversazioni (senza ricaricare messaggi)
      loadConversations().catch(() => {})
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Risposta interrotta dall'Ingegnere. Non si salva niente da qui: il
        // server sta comunque portando a termine il turno e scrivera' lui la
        // riga, intera. Salvare anche il parziale farebbe due righe, e quella
        // mutilata rientrerebbe nel contesto del modello al turno dopo.
        return
      }
      console.error('CHAT errore:', err)
      const fileCount = userMsg.files?.length || 0
      // `soloLocale`: l'avviso resta a schermo ma non viene spedito al modello
      // al turno dopo. Senza, il modello riceverebbe "⚠️ Connessione persa"
      // come propria risposta precedente e rifarebbe un lavoro che il server ha
      // invece portato a termine e salvato.
      //
      // Prima qui c'era una rilettura dal DB, ed era peggio del male: su un 413
      // ("i file sono troppo pesanti") il server non ha scritto NIENTE, quindi
      // la rilettura cancellava dallo schermo la spiegazione appena mostrata e
      // lasciava la domanda seguita dal vuoto.
      setMessages([...newMessages, {
        role: 'assistant',
        text: messaggioErroreChat(err, fileCount),
        soloLocale: true,
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  // Drena la coda quando il turno finisce. Sta in un effetto e non nel `finally`
  // di sendMessage per un motivo preciso: dentro il finally `loading` e' ancora
  // `true` nello stato React (setLoading e' asincrono), quindi la chiamata
  // ricorsiva rimetterebbe il messaggio in coda invece di mandarlo — un ciclo
  // infinito silenzioso.
  useEffect(() => {
    if (loading) return
    if (codaRef.current.length === 0) return
    const prossimo = codaRef.current[0]
    codaRef.current = codaRef.current.slice(1)
    setCoda(codaRef.current.map((m) => m.text))
    void sendMessage(prossimo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

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
    <div className="flex h-full bg-white">
      {/* Sidebar conversazioni */}
      <div className={`fixed inset-y-0 left-0 z-40 w-72 bg-white border-r border-gray-200 text-gray-800 transform transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 md:flex md:flex-col`}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <CervelloneLogo size={28} />
            <span className="font-bold text-sm text-gray-800">Cervellone</span>
          </div>
          <button onClick={newChat} className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs px-3 py-1.5 rounded-lg transition-colors">
            + Nuova
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <p className="text-gray-400 text-xs text-center mt-8 px-4">Nessuna conversazione.<br />Inizia a scrivere!</p>
          )}
          {conversations.map(conv => (
            <div
              key={conv.id}
              onClick={() => openConversation(conv)}
              className={`group w-full text-left px-3 py-3 border-b border-gray-100 hover:bg-gray-100 transition-colors cursor-pointer flex items-center rounded-lg mx-1 ${currentConvId === conv.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate text-gray-800">{conv.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">{formatDate(conv.updated_at)}</p>
              </div>
              <button
                onClick={(e) => renameConversation(conv.id, conv.title, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-500 p-1 flex-shrink-0 transition-opacity"
                title="Rinomina"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={(e) => deleteConversation(conv.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-500 p-1 flex-shrink-0 transition-opacity"
                title="Cancella"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-100">
          <button onClick={logout} className="text-gray-500 hover:text-gray-700 text-sm transition-colors w-full text-left">Esci</button>
        </div>
      </div>

      {/* Overlay sidebar mobile */}
      {showSidebar && (
        <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setShowSidebar(false)} />
      )}

      {/* Split: chat + pannello anteprima (stile Claude AI artifacts) */}
      <SplitPanel
        panel={previewHtml ? (
          <DocumentPreviewPanel
            html={previewHtml}
            onClose={() => setPreviewHtml(null)}
          />
        ) : null}
        onClosePanel={() => setPreviewHtml(null)}
      >
      {/* Area chat principale — ed e' anche la zona di rilascio dei file.
          Gli handler stavano SOLO sull'elenco dei messaggi: trascinando una
          foto sulla casella di testo, o sulla riga in fondo, non succedeva
          niente (anzi, senza `preventDefault` il browser provava ad aprire il
          file). Qui coprono tutta la colonna, casella compresa. */}
      <div
        className="flex flex-col min-w-0 h-full"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Hamburger mobile + Esci (sempre visibile su mobile, dove la sidebar e' nascosta) */}
        <div className="md:hidden flex items-center justify-between px-4 py-2 flex-shrink-0">
          <button onClick={() => setShowSidebar(!showSidebar)} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <button onClick={logout} className="text-sm font-medium text-gray-600 hover:text-red-600 border border-gray-300 rounded-lg px-3 py-1 transition-colors">Esci</button>
        </div>

        {/* Messages + drag area */}
        <div
          className={`relative flex-1 overflow-y-auto px-4 py-6 space-y-6 transition-colors ${isDragOver ? 'bg-blue-50' : ''}`}
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
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16 max-w-3xl mx-auto">
              <CervelloneLogo size={80} />
              <div>
                <p className="font-semibold text-gray-700 text-xl">Ciao Raffaele!</p>
                <p className="text-sm text-gray-400 mt-1">Come posso aiutarti oggi?</p>
                <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
                  {['Genera un POS cantiere', 'Aiutami con un computo metrico', 'Scrivi un post per i social', 'Calcola un preventivo ponteggi'].map(s => (
                    <button key={s} onClick={() => setInput(s)}
                      className="bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-blue-300 hover:bg-blue-50 transition-colors text-gray-600 text-left text-sm">
                      {s}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-300 mt-6">Puoi anche trascinare file o ZIP nella chat</p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} max-w-3xl mx-auto`}>
              {/* Avatar assistente */}
              {msg.role === 'assistant' && (
                <div className="flex-shrink-0 mr-3 mt-1">
                  <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center">
                    <CervelloneLogo size={18} />
                  </div>
                </div>
              )}
              <div className={`${
                msg.role === 'user'
                  ? 'max-w-[75%]'
                  : 'max-w-[85%] flex-1 min-w-0'
              }`}>
                {/* Label "Tu" per messaggi utente */}
                {msg.role === 'user' && (
                  <p className="text-xs text-gray-500 font-medium mb-1 text-right">Tu</p>
                )}
                <div className={`rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-gray-100 text-gray-800 rounded-br-sm px-4 py-3'
                    : 'text-gray-800 px-1 py-1'
                }`}>
                  {msg.files && msg.files.length > 0 && (
                    <div className={`mb-2 flex flex-wrap gap-2 ${msg.role === 'user' ? '' : 'px-3'}`}>
                      {msg.files.map((f, fi) =>
                        f.isImage ? (
                          <img key={fi} src={f.preview} alt={f.name} className="max-h-40 max-w-full rounded-lg object-cover" />
                        ) : (
                          <div key={fi} className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${
                            msg.role === 'user' ? 'bg-gray-200/60 text-gray-600' : 'bg-gray-100 text-gray-600'
                          }`}>
                            <span>{f.isPdf ? '📄' : '📝'}</span>
                            <span className="truncate max-w-[120px]">{f.name}</span>
                          </div>
                        )
                      )}
                    </div>
                  )}
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
                    <span className="whitespace-pre-wrap">{msg.text}</span>
                  )}
                  {msg.role === 'assistant' && loading && i === messages.length - 1 && msg.text === '' && (
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce">•</span>
                      <span className="animate-bounce [animation-delay:0.1s]">•</span>
                      <span className="animate-bounce [animation-delay:0.2s]">•</span>
                    </span>
                  )}
                  {msg.role === 'assistant' && msg.text.length > 200 && !(loading && i === messages.length - 1) && (
                    <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-gray-100">
                      <button onClick={() => downloadAsFile(msg.text, 'txt', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                        TXT
                      </button>
                      <button onClick={() => downloadAsFile(msg.text, 'md', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
                        MD
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input floating */}
        <div className="px-4 py-4 flex-shrink-0">
          {/* File pendenti */}
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

          <input
            ref={fileInputRef}
            type="file"
            accept="*/*"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />

          {/* Messaggi in coda: scritti mentre il bot stava ancora rispondendo.
              Mostrarli e' il punto — altrimenti sembrano spariti, che e'
              esattamente com'era prima (l'Invio non faceva nulla, in silenzio). */}
          {coda.length > 0 && (
            <div className="max-w-3xl mx-auto mb-2 space-y-1">
              {coda.map((testo, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-500 bg-gray-100 rounded-xl px-3 py-2">
                  <span className="shrink-0">⏳ In coda</span>
                  <span className="truncate">{testo}</span>
                </div>
              ))}
            </div>
          )}

          {/* Box input floating */}
          <div className="max-w-3xl mx-auto border border-gray-300 rounded-2xl shadow-sm bg-white px-4 py-3 focus-within:border-blue-400 focus-within:shadow-md transition-all">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize() }}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? (soloRegistrazione ? 'Sto registrando... (il testo arriva quando smetti)' : 'Sto ascoltando...') : trascrizioneInCorso ? 'Sto trascrivendo...' : 'Scrivi un messaggio...'}
              rows={1}
              className={`w-full resize-none text-gray-900 placeholder-gray-400 text-sm outline-none bg-transparent max-h-40 ${isRecording ? 'placeholder-red-400' : ''}`}
            />
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors"
                  title="Allega file"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>
                <button
                  onClick={toggleVoice}
                  disabled={loading}
                  className={`transition-colors ${isRecording ? 'text-red-500' : 'text-gray-400 hover:text-gray-600 disabled:opacity-40'}`}
                  title={isRecording ? 'Ferma registrazione' : 'Dettatura vocale'}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </button>
                {isRecording && (
                  <div className="flex items-end gap-[3px] h-5">
                    {audioLevels.map((level, idx) => (
                      <div
                        key={idx}
                        className="w-[3px] rounded-full bg-red-500 transition-all duration-75"
                        style={{ height: `${Math.max(4, level * 20)}px` }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() && pendingFiles.length === 0}
                className="bg-gray-800 hover:bg-gray-900 disabled:opacity-30 text-white rounded-full w-8 h-8 flex items-center justify-center transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </button>
            </div>
          </div>
          <p className="text-center text-xs text-gray-400 mt-2">Invio per mandare · Shift+Invio per a capo · trascina file nella chat</p>
        </div>
      </div>
      </SplitPanel>

      {/* Anteprima mobile — fullscreen */}
      {previewHtml && (
        <div className="fixed inset-0 z-50 md:hidden bg-white">
          <DocumentPreviewPanel
            html={previewHtml}
            onClose={() => setPreviewHtml(null)}
          />
        </div>
      )}

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
