import { task, metadata } from '@trigger.dev/sdk/v3'
import { callClaudeStreamTelegram } from '@/lib/claude'
import { editTelegramMessage, sendTelegramMessage } from '@/lib/telegram-helpers'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { supabase } from '@/lib/supabase'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = { role: string; content: any }

interface CervelloneLongTaskPayload {
  conversationId: string
  chatId: number
  placeholderMsgId: number | null
  userQuery: string
  history: AnyMessage[]
  systemPrompt: string
  fileDescription?: string
}

export const cervelloneLongTask = task({
  id: 'cervellone.long-task',
  maxDuration: 60 * 60, // 1 ora hard cap (override del default 3600 in config, esplicito)
  retry: { maxAttempts: 2 },
  run: async (payload: CervelloneLongTaskPayload) => {
    const { conversationId, chatId, placeholderMsgId, userQuery, history, systemPrompt } = payload

    metadata.set('status', 'avvio elaborazione')
    let lastEditText = ''

    const fullResponse = await callClaudeStreamTelegram(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: history as any,
        systemPrompt,
        userQuery,
        conversationId,
      },
      async (accumulated) => {
        metadata.set('progress_chars', accumulated.length)
        if (!placeholderMsgId) return
        const preview = accumulated.slice(0, 4000)
        if (preview === lastEditText) return
        lastEditText = preview
        await editTelegramMessage(chatId, placeholderMsgId, preview)
      },
    )

    metadata.set('status', 'invio risposta finale')

    // Parsing documenti generati e invio finale
    const responseBlocks = parseDocumentBlocks(fullResponse)
    const textParts: string[] = []

    for (const block of responseBlocks) {
      if (block.type === 'document') {
        const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'

        const { data: savedDoc } = await supabase
          .from('documents')
          .insert({
            name: title,
            content: block.content,
            conversation_id: conversationId,
            type: 'html',
            metadata: { source: 'telegram_long_task' },
          })
          .select('id')
          .single()

        const docUrl = savedDoc?.id
          ? `https://cervellone-5poc.vercel.app/doc/${savedDoc.id}`
          : 'https://cervellone-5poc.vercel.app'

        textParts.push(`📄 *${title}*\n👉 ${docUrl}`)
      } else if (block.content.trim()) {
        textParts.push(block.content)
      }
    }

    const finalText = textParts.join('\n\n') || fullResponse

    if (placeholderMsgId) {
      if (finalText.length <= 4000) {
        await editTelegramMessage(chatId, placeholderMsgId, finalText)
      } else {
        await editTelegramMessage(chatId, placeholderMsgId, finalText.slice(0, 4000))
        const remaining = finalText.slice(4000)
        if (remaining.trim()) await sendTelegramMessage(chatId, remaining)
      }
    } else {
      await sendTelegramMessage(chatId, finalText)
    }

    return { ok: true, length: fullResponse.length }
  },
})
