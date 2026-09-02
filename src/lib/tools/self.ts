import { supabase } from '../supabase'
import { sendTelegramMessage } from '../telegram-helpers'
import { promoteModel } from '../circuit-breaker'
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

export const SELF_TOOLS: ToolDefinition[] = [
  {
    name: 'modifica_skill',
    description: 'Modifica le istruzioni di una skill/reparto. Salva la versione precedente per rollback.',
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID skill: studio_tecnico, segreteria, cantieri, marketing, clienti, self' },
        nuove_istruzioni: { type: 'string', description: 'Le nuove istruzioni complete per la skill' },
        motivo: { type: 'string', description: 'Perche stai modificando la skill' },
      },
      required: ['skill_id', 'nuove_istruzioni', 'motivo'],
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
          description: 'Nuovo valore (stringa JSON). Es: "claude-opus-4-7" per modello, "200000" per thinking budget',
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
    description: `Promuove un nuovo modello Claude a default (model_default). L'attuale default diventa stable di backup. SOLO admin. Usa quando Anthropic rilascia una nuova versione e l'hai testata. Esempio: "claude-opus-4-8" o "claude-opus-5".`,
    input_schema: {
      type: 'object' as const,
      properties: {
        new_default: {
          type: 'string',
          description: 'Identificatore modello, es. "claude-opus-4-8". Deve iniziare con "claude-".',
        },
      },
      required: ['new_default'],
    },
  },
]

export async function executeSelfTools(name: string, input: Record<string, unknown>, _conversationId?: string): Promise<string | null> {
  switch (name) {
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
      const applica = input.applica !== false // default true

      try {
        // Interroga l'API Anthropic per i modelli disponibili
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
        })

        if (!response.ok) {
          return `Errore API Anthropic: HTTP ${response.status}. Impossibile controllare modelli disponibili.`
        }

        const data = await response.json() as { data?: Array<{ id: string; display_name?: string; created_at?: string }> }
        const models = data.data || []

        if (!models.length) {
          return 'Nessun modello trovato dall\'API Anthropic.'
        }

        // Filtra solo i modelli Claude rilevanti (no embedding, no legacy)
        const claudeModels = models
          .filter(m => m.id.startsWith('claude-') && !m.id.includes('embed'))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

        // Trova il miglior modello per famiglia
        const findBest = (family: string) => {
          const candidates = claudeModels.filter(m => m.id.includes(family))
          // Ordina per versione (il più recente = id più alto alfabeticamente per modelli con stesso prefisso)
          return candidates[0]?.id || null
        }

        const bestOpus = findBest('opus')
        const bestSonnet = findBest('sonnet')
        const bestHaiku = findBest('haiku')

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

        let report = `🔍 MODELLI CLAUDE DISPONIBILI (da API Anthropic):\n\n`
        report += `Opus: ${claudeModels.filter(m => m.id.includes('opus')).map(m => m.id).join(', ') || 'nessuno'}\n`
        report += `Sonnet: ${claudeModels.filter(m => m.id.includes('sonnet')).map(m => m.id).join(', ') || 'nessuno'}\n`
        report += `Haiku: ${claudeModels.filter(m => m.id.includes('haiku')).map(m => m.id).join(', ') || 'nessuno'}\n\n`

        report += `CONFIGURAZIONE ATTUALE:\n`
        report += `- model_default (conversazione): ${currentDefault}\n`
        report += `- model_complex (task pesanti): ${currentComplex}\n`
        report += `- model_digest (digestione file): ${currentDigest}\n\n`

        if (changes.length === 0) {
          report += `✅ SEI GIÀ AGGIORNATO — stai usando i modelli migliori disponibili.`
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
          report += `\n⏸️ Aggiornamento NON applicato (modalità anteprima). Richiama con applica=true per applicare.`
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
        return `❌ NON POSSO modificare prompt_extra: non ho il permesso di riscrivere il mio system prompt.

Esiste una protezione che scarta qualunque valore scritto da me: anche salvandolo, NON entrerebbe in nessuna conversazione. Non dire all'utente che è stato salvato — non lo sarebbe.

Cosa funziona davvero:
- \`ricorda\` — memoria esplicita, questa viene riletta davvero;
- \`registra_apprendimento\` — aggiunge una lezione a una procedura esistente;
- per una regola stabile nel prompt di sistema serve l'Ingegnere: la modifica va fatta da lui, non da me.`
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

      const { error } = await supabase
        .from('cervellone_skills')
        .update({
          istruzioni: nuoveIstruzioni,
          istruzioni_precedenti: current.istruzioni,
          versione: (current.versione || 1) + 1,
          updated_by: `cervellone: ${motivo.slice(0, 100)}`,
        })
        .eq('id', skillId)

      if (error) return `Errore modifica skill: ${error.message}`

      const { invalidateSkillCache } = await import('../skills')
      invalidateSkillCache()

      return `Skill "${skillId}" aggiornata (v${(current.versione || 1) + 1}). Motivo: ${motivo}`
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
