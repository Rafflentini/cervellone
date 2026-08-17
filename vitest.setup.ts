// Env dei test.
//
// ASSEGNAZIONE SECCA, NON `??=`. Con `??=` chi ha le env vere esportate nella
// shell (caso normale in locale: `.env.local` caricato, o variabili di sistema)
// NON otterrebbe gli stub: un test che dimenticasse `vi.mock('@/lib/supabase')`
// parlerebbe con Supabase di PRODUZIONE e ne scriverebbe le tabelle.
// Queste devono essere finte SEMPRE, qualunque cosa ci sia nell'ambiente.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-test-openai'
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-bot-token'

// Le restanti restano opzionali (`??=`): non aprono canali verso l'esterno e
// alcuni test locali possono volerle sovrascrivere dall'ambiente.
process.env.AUTH_SECRET ??= 'test-auth-secret'
process.env.APP_PASSWORD ??= 'test-app-password'
process.env.CRON_SECRET ??= 'test-cron-secret'
process.env.TELEGRAM_ALLOWED_IDS ??= '123456'
process.env.TELEGRAM_RAFFAELE_CHAT_ID ??= '123456'
process.env.ADMIN_CHAT_ID ??= '123456'
