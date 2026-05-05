/**
 * lib/weather-tool.ts — Weather tool per Cervellone via Open-Meteo (gratis, no API key).
 *
 * Use case: l'Ingegnere chiede "che tempo fa oggi a Villa d'Agri", "pioggia
 * prevista per domani in cantiere", "neve a 1200m sull'Appennino lucano",
 * "vento sopra 50 km/h?". Importante per cantieri (ponteggi e sicurezza),
 * pianificazione trasferte, decisioni operative.
 *
 * API: Open-Meteo (https://open-meteo.com) — gratis, no key, 10k call/giorno.
 * - Forecast: temperatura, vento, pioggia, codice meteo
 * - Geocoding: nome località → lat/lon
 */

const GEO_API = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast'

// Default: Villa d'Agri (PZ), ufficio Restruktura
const DEFAULT_LAT = 40.3622
const DEFAULT_LON = 15.8400
const DEFAULT_NAME = "Villa d'Agri (PZ)"

// Decodifica codice meteo Open-Meteo (WMO Weather codes)
function decodeWeatherCode(code: number): string {
  if (code === 0) return 'sereno'
  if (code === 1) return 'prevalentemente sereno'
  if (code === 2) return 'parzialmente nuvoloso'
  if (code === 3) return 'coperto'
  if (code === 45 || code === 48) return 'nebbia'
  if (code >= 51 && code <= 55) return 'pioggia leggera'
  if (code >= 56 && code <= 57) return 'pioggia gelata'
  if (code >= 61 && code <= 65) return 'pioggia'
  if (code >= 66 && code <= 67) return 'pioggia gelata'
  if (code >= 71 && code <= 75) return 'neve'
  if (code === 77) return 'granuli di neve'
  if (code >= 80 && code <= 82) return 'rovesci di pioggia'
  if (code >= 85 && code <= 86) return 'rovesci di neve'
  if (code === 95) return 'temporale'
  if (code >= 96 && code <= 99) return 'temporale con grandine'
  return `codice meteo ${code}`
}

interface GeocodeResult {
  latitude: number
  longitude: number
  name: string
  admin1?: string  // regione/provincia
  country?: string
}

async function geocode(location: string): Promise<GeocodeResult | null> {
  try {
    const url = `${GEO_API}?name=${encodeURIComponent(location)}&count=1&language=it&format=json`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json() as { results?: GeocodeResult[] }
    return data.results?.[0] || null
  } catch (err) {
    console.error('[WEATHER] geocode error:', err)
    return null
  }
}

async function getForecast(lat: number, lon: number, days = 1): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
      timezone: 'Europe/Rome',
      forecast_days: String(Math.min(Math.max(days, 1), 7)),
      wind_speed_unit: 'kmh',
    })
    const url = `${FORECAST_API}?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) {
      const body = await res.text()
      return `Errore Open-Meteo: HTTP ${res.status} — ${body.slice(0, 200)}`
    }
    return await res.text()  // raw JSON, parsato sotto
  } catch (err) {
    console.error('[WEATHER] forecast error:', err)
    return null
  }
}

interface ForecastResponse {
  current?: {
    time?: string
    temperature_2m?: number
    relative_humidity_2m?: number
    weather_code?: number
    wind_speed_10m?: number
    wind_direction_10m?: number
    precipitation?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_sum?: number[]
    wind_speed_10m_max?: number[]
  }
}

export async function weatherNow(input: { location?: string; days?: string }): Promise<string> {
  const location = (input.location || '').trim()
  const days = parseInt(input.days || '1', 10) || 1

  let lat = DEFAULT_LAT
  let lon = DEFAULT_LON
  let name = DEFAULT_NAME

  if (location && location.toLowerCase() !== "villa d'agri" && location.toLowerCase() !== 'ufficio') {
    const geo = await geocode(location)
    if (!geo) {
      return `Località "${location}" non trovata. Riprovi con un nome più preciso (es. "Roma", "Potenza", "Marsico Nuovo PZ").`
    }
    lat = geo.latitude
    lon = geo.longitude
    name = `${geo.name}${geo.admin1 ? ` (${geo.admin1})` : ''}${geo.country && geo.country !== 'Italia' ? `, ${geo.country}` : ''}`
  }

  const raw = await getForecast(lat, lon, days)
  if (!raw) return 'Servizio meteo temporaneamente non disponibile.'
  if (raw.startsWith('Errore')) return raw

  let data: ForecastResponse
  try {
    data = JSON.parse(raw) as ForecastResponse
  } catch {
    return 'Risposta meteo non parseabile.'
  }

  const lines: string[] = [`📍 *Meteo ${name}* (${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E)`]

  if (data.current) {
    const c = data.current
    lines.push('')
    lines.push(`*Adesso:*`)
    if (typeof c.temperature_2m === 'number') lines.push(`- Temperatura: ${c.temperature_2m.toFixed(1)}°C`)
    if (typeof c.weather_code === 'number') lines.push(`- Condizioni: ${decodeWeatherCode(c.weather_code)}`)
    if (typeof c.relative_humidity_2m === 'number') lines.push(`- Umidità: ${c.relative_humidity_2m}%`)
    if (typeof c.wind_speed_10m === 'number') lines.push(`- Vento: ${c.wind_speed_10m.toFixed(0)} km/h`)
    if (typeof c.precipitation === 'number' && c.precipitation > 0) lines.push(`- Pioggia in corso: ${c.precipitation} mm`)
  }

  if (data.daily?.time && data.daily.time.length > 0) {
    lines.push('')
    lines.push(`*Previsione ${data.daily.time.length} giorni:*`)
    for (let i = 0; i < data.daily.time.length; i++) {
      const date = data.daily.time[i]
      const code = data.daily.weather_code?.[i]
      const tMax = data.daily.temperature_2m_max?.[i]
      const tMin = data.daily.temperature_2m_min?.[i]
      const rain = data.daily.precipitation_sum?.[i]
      const wind = data.daily.wind_speed_10m_max?.[i]

      const desc = typeof code === 'number' ? decodeWeatherCode(code) : '—'
      const range = (typeof tMin === 'number' && typeof tMax === 'number')
        ? `${tMin.toFixed(0)}/${tMax.toFixed(0)}°C`
        : ''
      const rainStr = (typeof rain === 'number' && rain > 0) ? `, pioggia ${rain.toFixed(1)}mm` : ''
      const windStr = (typeof wind === 'number' && wind > 30) ? `, vento max ${wind.toFixed(0)}km/h ⚠️` : ''

      lines.push(`- ${date}: ${desc} ${range}${rainStr}${windStr}`)
    }
  }

  return lines.join('\n')
}

// Definizione tool per Anthropic API
export const WEATHER_TOOLS = [
  {
    name: 'weather_now',
    description: `Restituisce le condizioni meteo correnti e la previsione fino a 7 giorni per una località italiana o europea. Default: Villa d'Agri (PZ) sede Restruktura. Usa per: cantiere oggi (vento, pioggia, ghiaccio), pianificazione trasferte, sicurezza ponteggi (vento >50 km/h critico), valutazioni climatiche progetti edili.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        location: {
          type: 'string',
          description: 'Località (es. "Villa d\'Agri", "Potenza", "Roma", "Marsico Nuovo"). Opzionale: se omesso usa Villa d\'Agri (sede ufficio Restruktura).',
        },
        days: {
          type: 'string',
          description: 'Numero giorni di previsione (1-7). Default 1 (solo oggi).',
        },
      },
      required: [],
    },
  },
]

export async function executeWeatherTool(
  name: string,
  input: Record<string, string>,
): Promise<string> {
  if (name === 'weather_now') {
    return weatherNow(input)
  }
  return `Tool meteo "${name}" non riconosciuto.`
}
