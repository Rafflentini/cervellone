'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import CervelloneLogo from '@/components/CervelloneLogo'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push('/chat')
    } else {
      setError('Password errata. Riprova.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-gray-900">
      <div className="w-full max-w-sm mx-4">
        <div className="text-center mb-8">
          <div className="mb-4"><CervelloneLogo size={96} /></div>
          <h1 className="text-3xl font-bold text-white">Cervellone</h1>
          <p className="text-gray-400 mt-2">Assistente AI personale</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-2xl p-6 shadow-xl">
          <label className="block text-sm text-gray-400 mb-2">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full bg-gray-700 text-white rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            autoFocus
          />
          {error && (
            <p className="text-red-400 text-sm mb-4">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-xl py-3 transition-colors"
          >
            {loading ? 'Accesso...' : 'Accedi'}
          </button>
        </form>
      </div>
    </div>
  )
}
