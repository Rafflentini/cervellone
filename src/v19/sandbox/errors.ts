export class SandboxDisabledError extends Error {
  constructor(message?: string) {
    super(message ?? 'E2B sandbox disabilitata. Set E2B_FEATURE=on per abilitare.')
    this.name = 'SandboxDisabledError'
  }
}

export class SandboxKeyMissingError extends Error {
  constructor(message?: string) {
    super(message ?? 'E2B_API_KEY non configurata su Vercel + .env.local.')
    this.name = 'SandboxKeyMissingError'
  }
}

export class SandboxConnectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'SandboxConnectionError'
  }
}
