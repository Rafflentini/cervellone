export class BollettinoNotFoundError extends Error {
  constructor(message: string, public readonly date: string) {
    super(message)
    this.name = 'BollettinoNotFoundError'
  }
}

export class BollettinoFetchError extends Error {
  constructor(message: string, public readonly url: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'BollettinoFetchError'
  }
}
