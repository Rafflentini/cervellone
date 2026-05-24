import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Server-side: usa SERVICE_ROLE (bypassa RLS, autorizzato per logiche bot interne).
// Browser/client-side: usa ANON (SERVICE_ROLE_KEY non è nel bundle browser per definizione).
// Fallback ad ANON anche server-side se SERVICE_ROLE_KEY non è settata (dev locale).
//
// Modifica del 24 mag 2026 (RLS Fase 2/3): prima questo file ritornava sempre il client ANON,
// causando deny RLS sui ~22 consumer server-side. Audit conferma zero browser-side import di
// `@/lib/supabase` (i 6 "use client" file usano createClient inline). Pattern uniforme con
// src/lib/supabase-server.ts.
const isServer = typeof window === 'undefined'
const useServiceRole = isServer && !!serviceKey

const supabaseKey = useServiceRole ? serviceKey! : anonKey
const supabaseOptions = useServiceRole ? { auth: { persistSession: false } } : undefined

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, supabaseOptions)
