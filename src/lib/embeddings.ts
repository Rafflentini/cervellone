const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings'

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('OPENAI_API_KEY non configurata — embeddings disabilitati')
    return []
  }

  // Tronca a ~8000 token (~32000 caratteri) per sicurezza
  const truncated = text.slice(0, 32000)

  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: truncated,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('EMBEDDING errore:', res.status, errText)
    return []
  }

  const data = await res.json()
  console.log('EMBEDDING generato, dimensione:', data.data[0].embedding.length)
  return data.data[0].embedding
}
