import { supabase } from '../supabase'
import { sendTelegramMessage } from '../telegram-helpers'
import { promoteModel, assertModelloEsiste } from '../circuit-breaker'
import { migliorePerFamiglia, formatModelliDisponibili, famigliaDi } from '../model-families'
import type { ToolDefinition } from './types'

/**
 * Notifica all'Ingegnere il cambio modello — Telegram (immediato) + webchat
 * (inserisce assistant message nelle ultime 5 conversazioni web non-Telegram,
 * così appare in cronologia al prossimo apri-chat).
 */
async function notifyModelChange(noticeText: string): Promise<void> {
  // Telegram immediato all'admin. Fallback a TELEGRAM_ALLOWED_IDS[0] se ADMIN_CHAT_ID
  // non configurato (single-user setup tipico).
  let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (!adminChat) {
    const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
    adminChat = parseInt(firstAllowed || '0', 10)
  }
  if (adminChat) {
    await sendTelegramMessage(adminChat, noticeText).catch((err) => {
      console.error('Notify Telegram failed:', err)
    })
  }

  // Webchat: insert assistant message in ultime 5 conv web
  try {
    const { data: webConvs } = await supabase
      .from('conversations')
      .select('id')
      .neq('title', '💬 Telegram')
      .order('created_at', { ascending: false })
      .limit(5)

    if (webConvs && webConvs.length > 0) {
      const inserts = webConvs.map((c: { id: string }) => ({
        conversation_id: c.id,
        role: 'assistant',
        content: noticeText,
      }))
      await supabase.from('messages').insert(inserts)
    }
  } catch (err) {
    console.error('Notify webchat failed:', err)
  }
}

/**
 * La stringa che una giornata scrive quando non è successo NIENTE. Fino al 3 set
 * 2026 veniva scritta anche quando l'estrazione non aveva prodotto nulla: le due
 * cose erano indistinguibili nel database, ed è per questo che 927 messaggi sono
 * rimasti archiviati come giornate vuote per mesi.
 */
const RIASSUNTO_VUOTO = 'Nessuna attività rilevante'

export const SELF_TOOLS: ToolDefinition[] = [
  {
    name: 'memoria_giornate_da_rielaborare',
    description: 'Elenca le giornate in cui ci sono stati messaggi ma la memoria non ha estratto nulla (riassunto "Nessuna attività rilevante" o marcato come non riuscito). Usa questo tool quando l\'Ingegnere chiede "cosa manca nella memoria", "quali giornate sono da rielaborare", o prima di rielaborare la memoria, per sapere da dove partire.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'memoria_rielabora',
    description: 'Rilancia l\'estrazione della memoria per UNA giornata passata, sovrascrivendo il riassunto esistente. Usa questo tool quando l\'Ingegnere chiede di rielaborare/recuperare la memoria di un giorno. Costa una chiamata al modello (qualche centesimo) e richiede fino a un minuto: una giornata per volta. Riporta sempre cosa è uscito, cosi si vede se è servito.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Giornata da rielaborare, formato YYYY-MM-DD (es. 2026-08-05)' },
      },
      required: ['data'],
    },
  },
  {
    name: 'modifica_skill',
    description: 'Modifica le istruzioni di una skill/reparto. Salva la versione precedente per rollback.',
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID skill: studio_tecnico, segreteria, cantieri, marketing, clienti, self' },
        nuove_istruzioni: { type: 'string', description: 'Le nuove istruzioni complete per la skill' },
        motivo: { type: 'string', description: 'Perche stai modificando la skill' },
        conferma_riduzione: { type: 'boolean', description: 'Metti true SOLO se vuoi davvero accorciare drasticamente la skill e hai riportato il testo COMPLETO. Serve perche una riscrittura piu corta del 40% e quasi sempre un riassunto involontario che cancella istruzioni.' },
      },
      required: ['skill_id', 'nuove_istruzioni', 'motivo'],
    },
  },
  {
    name: 'storico_skill',
    description: 'Mostra tutte le versioni passate delle istruzioni di una skill, con dimensione e data. Usa questo tool quando l\'Ingegnere chiede cosa c\'era scritto prima in una skill, o quando sospetta che delle istruzioni siano state perse.',
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID skill: studio_tecnico, segreteria, cantieri, marketing, clienti, self' },
        versione: { type: 'number', description: 'Opzionale: se indicata, mostra il TESTO completo di quella versione invece dell\'elenco' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'ripristina_skill',
    description: 'Riporta una skill a una versione precedente delle sue istruzioni. Usa questo tool quando delle istruzioni sono state perse o una modifica ha peggiorato il comportamento. La versione attuale viene archiviata prima, quindi il ripristino e reversibile.',
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID skill' },
        versione: { type: 'number', description: 'Numero di versione da ripristinare (vedi storico_skill)' },
        motivo: { type: 'string', description: 'Perche si torna indietro' },
      },
      required: ['skill_id', 'versione', 'motivo'],
    },
  },
  {
    name: 'cervellone_info',
    description: 'Mostra la tua configurazione attuale: modello AI, versione, tool disponibili, parametri. Usa questo tool quando qualcuno ti chiede "che modello sei?", "come funzioni?", "che tool hai?", o qualsiasi domanda su te stesso.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cervellone_check_aggiornamenti',
    description: 'Controlla se sono disponibili modelli Claude più recenti e aggiorna automaticamente la configurazione. Interroga l\'API Anthropic per la lista modelli disponibili, confronta con quelli in uso, e si auto-aggiorna ai migliori. Usa questo tool periodicamente o quando senti parlare di nuovi modelli Claude.',
    input_schema: {
      type: 'object',
      properties: {
        applica: {
          type: 'boolean',
          description: 'Se true, applica gli aggiornamenti trovati. Se false, mostra solo cosa cambierebbe (default: true)',
        },
      },
      required: [],
    },
  },
  {
    name: 'cervellone_modifica',
    description: 'Modifica la tua configurazione: cambia modello AI, parametri di thinking, versione, o aggiungi istruzioni personalizzate. Usa questo per auto-migliorarti o quando l\'Ingegnere ti chiede di cambiare qualcosa di te stesso.',
    input_schema: {
      type: 'object',
      properties: {
        chiave: {
          type: 'string',
          description: 'Chiave config da modificare: model_default, model_complex, model_digest, version, thinking_budget_default, thinking_budget_medium, thinking_budget_high, max_tokens_default, max_tokens_medium, max_tokens_high, prompt_extra, nome, descrizione',
        },
        valore: {
          type: 'string',
          description: 'Nuovo valore (stringa JSON). Es: "claude-opus-5" per modello, "200000" per thinking budget',
        },
        motivo: {
          type: 'string',
          description: 'Perché stai facendo questa modifica (viene salvato nel log)',
        },
      },
      required: ['chiave', 'valore', 'motivo'],
    },
  },
  {
    name: 'promuovi_modello',
    // "SOLO admin" era prosa: nessun controllo a runtime lo applicava. Meglio
    // dire il vero — l'id viene verificato contro l'API, ma la DECISIONE di
    // cambiare modello resta dell'Ingegnere, e costa.
    description: `Promuove un nuovo modello Claude a default (model_default). L'attuale default diventa stable di backup. NON usarlo di tua iniziativa: cambiare modello cambia i costi, e lo decide l'Ingegnere — serve una sua richiesta esplicita. L'id viene verificato contro l'elenco dell'API Anthropic: se non esiste, la promozione viene rifiutata. Esempio: "claude-opus-5".`,
    input_schema: {
      type: 'object' as const,
      properties: {
        new_default: {
          type: 'string',
          description: 'Identificatore modello, es. "claude-opus-5". Deve iniziare con "claude-" ed esistere davvero nell\'elenco dell\'API Anthropic.',
        },
      },
      required: ['new_default'],
    },
  },
]

export async function executeSelfTools(name: string, input: Record<string, unknown>, _conversationId?: string): Promise<string | null> {
  switch (name) {
    case 'memoria_giornate_da_rielaborare': {
      // Il filtro guarda il CONTENUTO, non il vuoto: quelle righe non sono
      // vuote, contengono 26 caratteri che dicono una cosa falsa. Un controllo
      // su `summary_text is null or = ''` non ne troverebbe nemmeno una.
      const { data, error } = await supabase
        .from('cervellone_summary_giornaliero')
        .select('data, message_count, summary_text')
        .gt('message_count', 0)
        .order('data', { ascending: false })

      if (error) return `Non riesco a leggere lo stato della memoria: ${error.message}`
      const daFare = (data ?? []).filter((r: { summary_text?: string | null }) => {
        const t = String(r.summary_text ?? '')
        // Il riassunto è fatto solo di "Nessuna attività rilevante" ripetuto (le
        // parti vengono unite con " | "), oppure è il marcatore di fallimento.
        const resto = t.replace(new RegExp(`${RIASSUNTO_VUOTO}( \\| )?`, 'g'), '').trim()
        return resto === '' || t.startsWith('⚠️ Estrazione non riuscita')
      })

      if (daFare.length === 0) return 'Nessuna giornata da rielaborare: tutte quelle con messaggi hanno un riassunto.'

      const messaggiTotali = daFare.reduce((s: number, r: { message_count?: number }) => s + (r.message_count ?? 0), 0)
      const righe = daFare
        .map((r: { data: string; message_count?: number }) => `• ${r.data} — ${r.message_count ?? 0} messaggi`)
        .join('\n')
      return `${daFare.length} giornate da rielaborare, ${messaggiTotali} messaggi in tutto:\n${righe}\n\nPer recuperarne una: memoria_rielabora con quella data. Una per volta.`
    }

    case 'memoria_rielabora': {
      const data = String(input.data ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return 'Mi serve la data nel formato YYYY-MM-DD (es. 2026-08-05).'
      }
      // Solo giornate CHIUSE: rielaborare oggi produrrebbe un riassunto parziale
      // e sposterebbe il segnaposto su una giornata non finita.
      const oggi = new Date().toISOString().slice(0, 10)
      if (data >= oggi) {
        return `${data} non è ancora una giornata chiusa: la memoria si estrae il giorno dopo. Riprova domani, o scegli una data passata.`
      }

      const { runMemoriaExtract } = await import('../memoria-extract')
      // forced = true: salta l'idempotenza E non sposta il segnaposto del cron.
      // Senza, una rielaborazione a mano farebbe credere al giro automatico della
      // notte di aver già fatto il suo lavoro.
      const esito = await runMemoriaExtract(data, true)

      if (!esito.ok) return `Rielaborazione di ${data} fallita: ${esito.error ?? 'motivo non riportato'}`

      const { data: riga } = await supabase
        .from('cervellone_summary_giornaliero')
        .select('summary_text, message_count')
        .eq('data', data)
        .maybeSingle()
      const riassunto = String(riga?.summary_text ?? '')

      // L'esito dice cosa e' USCITO, non solo che il comando e' andato: un
      // "fatto" su un riassunto ancora vuoto e' la stessa bugia di prima.
      const nonRiuscita = riassunto.startsWith('⚠️ Estrazione non riuscita') || riassunto === RIASSUNTO_VUOTO
      const testa = nonRiuscita
        ? `⚠️ ${data} rielaborata, ma NON è uscito niente di nuovo.`
        : `✅ ${data} rielaborata.`
      return [
        testa,
        `Messaggi letti: ${riga?.message_count ?? esito.conversations}`,
        `Conversazioni: ${esito.conversations} · entità estratte: ${esito.entities}`,
        esito.skipped_chunks ? `Parti scartate: ${esito.skipped_chunks}` : null,
        `Costo: ${esito.cost_usd.toFixed(4)} $`,
        '',
        `Riassunto ora in memoria:\n${riassunto.slice(0, 1200)}`,
      ].filter(Boolean).join('\n')
    }

    case 'cervellone_info': {
      const { data: config } = await supabase
        .from('cervellone_config')
        .select('key, value, updated_at, updated_by')
        .order('key')

      if (!config?.length) return 'Configurazione non disponibile.'

      const configMap: Record<string, unknown> = {}
      for (const row of config) {
        configMap[row.key] = row.value
      }

      // prompt_extra: mostrare il valore grezzo del DB e' fuorviante, perche' se
      // e' stato scritto dal bot il guardrail di provenienza lo scarta e in
      // conversazione non arriva. Lo strumento deve riportare cio' che e' ATTIVO,
      // non cio' che e' memorizzato: e' esattamente la divergenza che ha reso
      // invisibile l'incidente del 1 settembre.
      const promptExtraRow = config.find(r => r.key === 'prompt_extra')
      const promptExtraSelfWritten = String(promptExtraRow?.updated_by ?? '').startsWith('cervellone')
      const promptExtraRaw = String(promptExtraRow?.value ?? '').trim()
      const promptExtraStato = !promptExtraRaw
        ? '(nessuna)'
        : promptExtraSelfWritten
          ? `(NON ATTIVE — scritte da me, quindi scartate dal guardrail di provenienza. In conversazione non arrivano.) Testo memorizzato: ${promptExtraRaw}`
          : promptExtraRaw

      // Percorso assoluto e NON '../tools': da src/lib/tools/self.ts quello relativo
      // può risolvere sia a src/lib/tools.ts sia alla directory src/lib/tools/, e
      // funziona solo perché quest'ultima non ha un index.ts. Aggiungerne uno —
      // mossa naturale dopo un refactor come questo — farebbe puntare l'import al
      // barrel, con getAllToolNames undefined e cervellone_info rotto a runtime.
      // Il typecheck non lo intercetterebbe se il barrel ri-esportasse i moduli.
      const { getAllToolNames } = await import('@/lib/tools')
      const toolNames = getAllToolNames()

      return `🧠 CERVELLONE — CONFIGURAZIONE ATTUALE

IDENTITÀ:
- Nome: ${configMap.nome || 'Cervellone'}
- Descrizione: ${configMap.descrizione || 'CEO digitale Restruktura'}
- Versione: ${configMap.version || '1.0.0'}

MODELLI AI:
- Conversazione standard: ${configMap.model_default}
- Task complessi (preventivi, relazioni, analisi): ${configMap.model_complex}
- Digestione documenti: ${configMap.model_digest}

PARAMETRI THINKING:
- Standard: budget ${configMap.thinking_budget_default}, max tokens ${configMap.max_tokens_default}
- Medio: budget ${configMap.thinking_budget_medium}, max tokens ${configMap.max_tokens_medium}
- Alto: budget ${configMap.thinking_budget_high}, max tokens ${configMap.max_tokens_high}

TOOL DISPONIBILI:
${toolNames.map(t => `- ${t}`).join('\n')}
- web_search (built-in Anthropic)

ISTRUZIONI EXTRA: ${promptExtraStato}

ULTIMA MODIFICA CONFIG:
${config.map(r => `- ${r.key}: aggiornato ${new Date(r.updated_at).toLocaleString('it')} da ${r.updated_by}`).join('\n')}

Puoi modificare qualsiasi parametro con il tool cervellone_modifica.`
    }

    case 'cervellone_check_aggiornamenti': {
      let applica = input.applica !== false // default true

      try {
        // Interroga l'API Anthropic per i modelli disponibili.
        // limit=100: senza, l'API pagina col default e un modello puo' restare
        // fuori pagina — un'altra via per cui l'elenco "completo" non lo e'.
        const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
        })

        if (!response.ok) {
          return `Errore API Anthropic: HTTP ${response.status}. Impossibile controllare modelli disponibili.`
        }

        const data = await response.json() as {
          data?: Array<{ id: string; display_name?: string; created_at?: string }>
          has_more?: boolean
        }
        const models = data.data || []
        // Se ne restano fuori, dirlo: un elenco parziale presentato come
        // completo e' il difetto che ha causato l'incidente Fable.
        const paginaIncompleta = data.has_more === true
        // Se l'elenco non basta per concludere, non basta nemmeno per SCRIVERE:
        // dire "questo elenco non e' completo" e promuovere sulla sua base nello
        // stesso respiro era incoerente.
        if (paginaIncompleta) applica = false

        if (!models.length) {
          return 'Nessun modello trovato dall\'API Anthropic.'
        }

        // Filtra solo i modelli Claude rilevanti (no embedding, no legacy)
        const claudeModels = models
          .filter(m => m.id.startsWith('claude-') && !m.id.includes('embed'))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

        const bestOpus = migliorePerFamiglia(claudeModels, 'opus')
        const bestSonnet = migliorePerFamiglia(claudeModels, 'sonnet')

        // Leggi config attuale
        const { data: config } = await supabase
          .from('cervellone_config')
          .select('key, value')

        const configMap: Record<string, string> = {}
        if (config) {
          for (const row of config) {
            configMap[row.key] = String(row.value).replace(/"/g, '')
          }
        }

        const currentDefault = configMap.model_default || 'sconosciuto'
        const currentComplex = configMap.model_complex || 'sconosciuto'
        const currentDigest = configMap.model_digest || 'sconosciuto'

        // Strategia: default=miglior Sonnet, complex=miglior Opus, digest=miglior Sonnet
        const newDefault = bestSonnet || currentDefault
        const newComplex = bestOpus || bestSonnet || currentComplex
        const newDigest = bestSonnet || currentDigest

        const changes: Array<{ key: string; from: string; to: string }> = []
        if (newDefault !== currentDefault) changes.push({ key: 'model_default', from: currentDefault, to: newDefault })
        if (newComplex !== currentComplex) changes.push({ key: 'model_complex', from: currentComplex, to: newComplex })
        if (newDigest !== currentDigest) changes.push({ key: 'model_digest', from: currentDigest, to: newDigest })

        // Le famiglie in uso si RICAVANO da cio' che la config scrive davvero,
        // non si elencano a mano: una lista scritta a mano tornava a dire che
        // haiku e' "in uso" mentre nessuna chiave la usa piu' — lo stesso
        // difetto dell'elenco hardcoded, in scala minore.
        // Dai valori CORRENTI, non da quelli proposti: il warning dice "la
        // configurazione non usa", cioe' parla del presente. Derivandolo dai
        // nuovi, con un cambio in sospeso il report diceva "non uso fable" tre
        // righe sopra "model_complex: claude-fable-5-1" — report contro realta',
        // la stessa classe di difetto che questo modulo esiste per chiudere.
        const FAMIGLIE_IN_USO = [...new Set(
          [currentDefault, currentComplex, currentDigest]
            .filter(m => m && m !== 'sconosciuto')
            .map(m => famigliaDi(m)),
        )]

        let report = formatModelliDisponibili(claudeModels, FAMIGLIE_IN_USO, models.length)
        if (paginaIncompleta) {
          report += `\n⚠️ L'API dice che ci sono ALTRI modelli oltre a questi: l'elenco sopra NON è completo. Non concludere che un modello non esiste solo perché non è qui.\n`
        }
        report += '\n'

        report += `CONFIGURAZIONE ATTUALE:\n`
        report += `- model_default (conversazione): ${currentDefault}\n`
        report += `- model_complex (task pesanti): ${currentComplex}\n`
        report += `- model_digest (digestione file): ${currentDigest}\n\n`

        if (changes.length === 0) {
          // "Aggiornato" vale DENTRO le famiglie che uso. Dire "sto usando i
          // modelli migliori disponibili" mentre ne esiste una piu' capace che
          // non guardo e' esattamente la frase che ha fatto sbagliare il bot.
          // Set vuoto = non ho potuto leggere la config, non "sono aggiornato su
          // niente": la frase con le parentesi vuote sarebbe un'affermazione di
          // completezza su un insieme vuoto.
          report += FAMIGLIE_IN_USO.length > 0
            ? `✅ AGGIORNATO nelle famiglie che uso (${FAMIGLIE_IN_USO.join(', ')}): sto già usando le versioni più recenti.`
            : `⚠️ Non ho potuto leggere quali modelli sto usando: non posso dire se sono aggiornato.`
          return report
        }

        report += `📦 AGGIORNAMENTI DISPONIBILI:\n`
        for (const c of changes) {
          report += `- ${c.key}: ${c.from} → ${c.to}\n`
        }

        if (applica) {
          for (const c of changes) {
            await supabase
              .from('cervellone_config')
              .update({
                value: c.to,
                updated_by: `auto-update: ${c.from} → ${c.to}`,
              })
              .eq('key', c.key)
          }
          report += `\n✅ AGGIORNAMENTO APPLICATO — i nuovi modelli sono attivi dalla prossima richiesta.`

          // Notifica utente su Telegram + webchat (FIX W1.1: trasparenza cambi modello)
          const noticeLines = changes.map((c) => `• *${c.key}*: ${c.from} → *${c.to}*`).join('\n')
          const noticeText =
            `🆕 *Cervellone aggiornato a un nuovo modello AI*\n\n` +
            `${noticeLines}\n\n` +
            `Le capability del nuovo modello vengono rilevate automaticamente. ` +
            `Dalla prossima richiesta utilizzo i nuovi modelli.`
          await notifyModelChange(noticeText)

          // Invalida cache config + capability per pickup immediato
          try {
            const { invalidateConfigCache, invalidateModelCapsCache } = await import('../claude')
            invalidateConfigCache()
            invalidateModelCapsCache()
          } catch (err) {
            console.error('Cache invalidation failed (non-critical):', err)
          }
        } else {
          // Biforcato sul motivo: se a bloccare e' stata la paginazione, dire
          // "richiama con applica=true" a chi lo aveva GIA' passato e' un invito
          // a rifare la stessa cosa all'infinito.
          report += paginaIncompleta
            ? `\n⏸️ Aggiornamento NON applicato: l'elenco dei modelli è incompleto, non è una base sicura per cambiare configurazione.`
            : `\n⏸️ Aggiornamento NON applicato (modalità anteprima). Richiama con applica=true per applicare.`
        }

        return report

      } catch (err) {
        return `Errore durante il check aggiornamenti: ${(err as Error).message}`
      }
    }

    case 'cervellone_modifica': {
      const chiave = input.chiave as string
      const valore = input.valore as string
      const motivo = input.motivo as string

      const CHIAVI_VALIDE = [
        'model_default', 'model_complex', 'model_digest', 'version',
        'thinking_budget_default', 'thinking_budget_medium', 'thinking_budget_high',
        'max_tokens_default', 'max_tokens_medium', 'max_tokens_high',
        'prompt_extra', 'nome', 'descrizione',
      ]

      if (!CHIAVI_VALIDE.includes(chiave)) {
        return `Chiave "${chiave}" non valida. Chiavi disponibili: ${CHIAVI_VALIDE.join(', ')}`
      }

      // prompt_extra NON è scrivibile da qui, e va detto invece di fingere.
      // getPromptExtra() (src/lib/prompts.ts) scarta il valore se `updated_by`
      // inizia per "cervellone", e questo tool firma sempre così: la scrittura
      // riusciva, veniva sempre scartata, e la risposta diceva "attiva dalla
      // prossima richiesta". Il 1 settembre 2026 l'Ingegnere si è sentito dire
      // "salvato per tutte le sessioni future" di una regola mai entrata in un
      // prompt. Il guardrail è giusto — il bot non deve poter riscrivere il
      // proprio system prompt — quindi si corregge la bugia, non la difesa.
      // Non scriviamo nemmeno in DB: un valore lì dentro verrebbe riletto da
      // cervellone_info come se fosse attivo.
      if (chiave === 'prompt_extra') {
        const { proponiRegola } = await import('../regole-proposte')
        const p = await proponiRegola(valore, motivo, 'cervellone_modifica')
        if (!p) {
          return '❌ Non sono riuscito a preparare la proposta. Riprova con un testo non vuoto.'
        }
        return `📝 REGOLA PREPARATA, NON ANCORA ATTIVA.

"${p.testo}"

Non posso attivarla da solo: le mie istruzioni permanenti le conferma l'Ingegnere, altrimenti basterebbe una mail o un documento che leggo per riscrivermi le regole.

DILLO ESATTAMENTE COSÌ all'Ingegnere — non dire che è già salvata:
"Per renderla valida sempre, confermi con /regola_ok_${p.id} — oppure /regola_no_${p.id} se non la vuole."

Una volta confermata vale in tutte le conversazioni. Le regole attive si vedono con /regole.`
      }

      // Le chiavi che contengono un id di modello passano dalla STESSA verifica
      // di promuovi_modello. Senza, la difesa proteggeva una porta mentre quella
      // accanto restava spalancata: questo tool scriveva model_default senza
      // nemmeno controllare il prefisso, nello stesso file, 120 righe piu' su.
      // E qui non c'e' nemmeno la semantica di backup — model_stable non viene
      // aggiornato, quindi un id sbagliato non avrebbe nulla su cui ripiegare.
      if (chiave === 'model_default' || chiave === 'model_complex' || chiave === 'model_digest') {
        try {
          await assertModelloEsiste(valore.replace(/"/g, '').trim())
        } catch (err) {
          return `❌ ${err instanceof Error ? err.message : String(err)}`
        }
      }

      // Parsa il valore come JSON
      let jsonValue: unknown
      try {
        jsonValue = JSON.parse(valore)
      } catch {
        // Se non è JSON valido, wrappa come stringa
        jsonValue = valore
      }

      const { error } = await supabase
        .from('cervellone_config')
        .update({
          value: jsonValue,
          updated_by: `cervellone: ${motivo.slice(0, 100)}`,
        })
        .eq('key', chiave)

      if (error) {
        return `Errore modifica config: ${error.message}`
      }

      // Notifica utente se cambiato un modello (FIX W1.1: trasparenza cambi modello)
      if (chiave.startsWith('model_')) {
        const noticeText =
          `🆕 *Cervellone aggiornato — modello cambiato manualmente*\n\n` +
          `• *${chiave}*: nuovo valore *${String(jsonValue).replace(/"/g, '')}*\n` +
          `• Motivo: ${motivo}\n\n` +
          `Le capability del nuovo modello vengono rilevate automaticamente. ` +
          `Dalla prossima richiesta utilizzo il nuovo modello.`
        await notifyModelChange(noticeText)
        try {
          const { invalidateConfigCache, invalidateModelCapsCache } = await import('../claude')
          invalidateConfigCache()
          invalidateModelCapsCache()
        } catch (err) {
          console.error('Cache invalidation failed (non-critical):', err)
        }
      }

      return `✅ CONFIGURAZIONE AGGIORNATA
- Chiave: ${chiave}
- Nuovo valore: ${JSON.stringify(jsonValue)}
- Motivo: ${motivo}

La modifica è attiva dalla prossima richiesta.`
    }

    case 'modifica_skill': {
      const skillId = input.skill_id as string
      const nuoveIstruzioni = input.nuove_istruzioni as string
      const motivo = input.motivo as string

      const { data: current } = await supabase
        .from('cervellone_skills')
        .select('istruzioni, versione')
        .eq('id', skillId)
        .single()

      if (!current) return `Skill "${skillId}" non trovata.`

      const attuali = String(current.istruzioni ?? '')
      const versioneAttuale = current.versione || 1

      // GUARDIA ANTI-RIASSUNTO. E' accaduto davvero: il 1 agosto 2026 la skill
      // `segreteria` e' passata da 3797 a 1364 caratteri (‑64%) e con quella
      // riscrittura sono sparite le istruzioni sulle foto. Nessuno l'ha fermato,
      // e con un solo slot di backup la versione buona era a una modifica dalla
      // cancellazione definitiva.
      //
      // Il caso e' riconoscibile: chi AGGIUNGE una regola non dimezza il testo.
      // Una riscrittura molto piu' corta e' quasi sempre un riassunto
      // involontario, quindi si chiede conferma esplicita invece di obbedire.
      const SOGLIA_RIDUZIONE = 0.6
      const LUNGHEZZA_MINIMA_PER_GUARDIA = 500
      const riduzioneSospetta =
        attuali.length >= LUNGHEZZA_MINIMA_PER_GUARDIA &&
        nuoveIstruzioni.length < attuali.length * SOGLIA_RIDUZIONE
      if (riduzioneSospetta && input.conferma_riduzione !== true) {
        const perc = Math.round((1 - nuoveIstruzioni.length / attuali.length) * 100)
        return [
          `⚠️ Modifica NON applicata: le nuove istruzioni sono piu' corte del ${perc}% (${attuali.length} → ${nuoveIstruzioni.length} caratteri).`,
          `Una riscrittura cosi' piu' breve cancella istruzioni invece di aggiungerne: e' quello che il 1 agosto ha fatto sparire le regole sulle foto dalla skill "segreteria".`,
          `Se volevi AGGIUNGERE qualcosa, rimanda il testo COMPLETO — le istruzioni attuali piu' la modifica.`,
          `Se volevi davvero accorciarla, richiama il tool con conferma_riduzione = true.`,
        ].join('\n')
      }

      // Lo storico si scrive PRIMA di sovrascrivere, e in una tabella dedicata:
      // `istruzioni_precedenti` tiene un solo passo, quindi due modifiche di fila
      // perdevano l'originale per sempre.
      const { error: storicoErr } = await supabase
        .from('cervellone_skills_versioni')
        .upsert({
          skill_id: skillId,
          versione: versioneAttuale,
          istruzioni: attuali,
          updated_by: `sostituita da: ${motivo.slice(0, 100)}`,
        }, { onConflict: 'skill_id,versione', ignoreDuplicates: true })

      // Se lo storico non si scrive, NON si procede. Sovrascrivere senza una
      // copia e' esattamente il guasto: meglio una modifica rifiutata che una
      // versione perduta.
      if (storicoErr) {
        return `⚠️ Modifica NON applicata: non riesco ad archiviare la versione attuale (${storicoErr.message}). Senza copia di sicurezza non sovrascrivo.`
      }

      const { error } = await supabase
        .from('cervellone_skills')
        .update({
          istruzioni: nuoveIstruzioni,
          istruzioni_precedenti: attuali,
          versione: versioneAttuale + 1,
          updated_by: `cervellone: ${motivo.slice(0, 100)}`,
        })
        .eq('id', skillId)

      if (error) return `Errore modifica skill: ${error.message}`

      const { invalidateSkillCache } = await import('../skills')
      invalidateSkillCache()

      const delta = nuoveIstruzioni.length - attuali.length
      return `Skill "${skillId}" aggiornata (v${versioneAttuale + 1}, ${delta >= 0 ? '+' : ''}${delta} caratteri). Versione ${versioneAttuale} archiviata nello storico. Motivo: ${motivo}`
    }

    case 'storico_skill': {
      const skillId = String(input.skill_id ?? '')
      const versioneChiesta = typeof input.versione === 'number' ? input.versione : undefined

      if (versioneChiesta !== undefined) {
        const { data: v } = await supabase
          .from('cervellone_skills_versioni')
          .select('istruzioni, archiviata_il, updated_by')
          .eq('skill_id', skillId)
          .eq('versione', versioneChiesta)
          .maybeSingle()
        if (!v) return `Versione ${versioneChiesta} di "${skillId}" non trovata nello storico.`
        return `Skill "${skillId}" v${versioneChiesta} (archiviata ${String(v.archiviata_il).slice(0, 10)}):\n\n${v.istruzioni}`
      }

      const { data: versioni, error } = await supabase
        .from('cervellone_skills_versioni')
        .select('versione, istruzioni, archiviata_il, updated_by')
        .eq('skill_id', skillId)
        .order('versione', { ascending: false })

      if (error) return `Non riesco a leggere lo storico: ${error.message}`
      if (!versioni?.length) return `Nessuna versione in storico per "${skillId}".`

      const righe = versioni.map((v: { versione: number; istruzioni: string; archiviata_il: string; updated_by?: string }) =>
        `• v${v.versione} — ${String(v.istruzioni ?? '').length} caratteri — ${String(v.archiviata_il).slice(0, 10)}${v.updated_by ? ` — ${String(v.updated_by).slice(0, 70)}` : ''}`
      ).join('\n')
      return `Storico di "${skillId}":\n${righe}\n\nPer leggerne una: storico_skill con quella versione. Per tornarci: ripristina_skill.`
    }

    case 'ripristina_skill': {
      const skillId = String(input.skill_id ?? '')
      const versione = Number(input.versione)
      const motivo = String(input.motivo ?? 'ripristino')
      if (!Number.isInteger(versione) || versione < 1) return 'Mi serve il numero di versione da ripristinare (vedi storico_skill).'

      const { data: daRipristinare } = await supabase
        .from('cervellone_skills_versioni')
        .select('istruzioni')
        .eq('skill_id', skillId)
        .eq('versione', versione)
        .maybeSingle()
      if (!daRipristinare) return `Versione ${versione} di "${skillId}" non trovata nello storico.`

      const { data: current } = await supabase
        .from('cervellone_skills')
        .select('istruzioni, versione')
        .eq('id', skillId)
        .single()
      if (!current) return `Skill "${skillId}" non trovata.`

      const versioneAttuale = current.versione || 1
      // Anche il ripristino archivia prima: tornare indietro deve poter essere
      // annullato, altrimenti si sposta soltanto il punto in cui si perde roba.
      const { error: storicoErr } = await supabase
        .from('cervellone_skills_versioni')
        .upsert({
          skill_id: skillId,
          versione: versioneAttuale,
          istruzioni: String(current.istruzioni ?? ''),
          updated_by: `sostituita da ripristino a v${versione}: ${motivo.slice(0, 80)}`,
        }, { onConflict: 'skill_id,versione', ignoreDuplicates: true })
      if (storicoErr) {
        return `⚠️ Ripristino NON eseguito: non riesco ad archiviare la versione attuale (${storicoErr.message}).`
      }

      const testo = String(daRipristinare.istruzioni ?? '')
      // Il guard anti-riassunto NON si applica qui: il testo non arriva dal
      // modello, arriva dallo storico, ed e' una richiesta esplicita.
      const { error } = await supabase
        .from('cervellone_skills')
        .update({
          istruzioni: testo,
          istruzioni_precedenti: String(current.istruzioni ?? ''),
          versione: versioneAttuale + 1,
          updated_by: `ripristino a v${versione}: ${motivo.slice(0, 100)}`,
        })
        .eq('id', skillId)
      if (error) return `Errore ripristino: ${error.message}`

      const { invalidateSkillCache } = await import('../skills')
      invalidateSkillCache()

      return `✅ Skill "${skillId}" riportata al testo della v${versione} (${testo.length} caratteri), salvata come v${versioneAttuale + 1}. La versione ${versioneAttuale} resta nello storico, quindi il ripristino e' annullabile.`
    }

    case 'promuovi_modello': {
      try {
        const result = await promoteModel(input.new_default as string)
        return `🚀 Promozione completata.\nNuovo default: ${result.newDefault}\nNuovo stable: ${result.newStable}\nVecchio stable archiviato: ${result.oldStable}`
      } catch (err) {
        return `Errore promozione: ${err instanceof Error ? err.message : err}`
      }
    }

    default:
      return null
  }
}
