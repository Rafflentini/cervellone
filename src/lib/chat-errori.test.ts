import { describe, test, expect } from 'vitest'
import { messaggioErroreChat } from './chat-errori'

describe('messaggioErroreChat', () => {
  // IL DIFETTO (8 set 2026): `TypeError` E' una sottoclasse di `Error`, quindi
  // il ramo `err instanceof Error && err.message` prendeva anche la connessione
  // caduta e il ramo scritto apposta non si eseguiva MAI. Raffaele leggeva
  // `⚠️ Failed to fetch` (Chrome) e `⚠️ network error` (Safari) invece della
  // spiegazione. Misurato in produzione due volte in venti minuti.
  test.each([
    ['Failed to fetch', 'Chrome'],
    ['network error', 'Safari/iOS'],
    ['Load failed', 'Safari recente'],
  ])('connessione caduta (%s, %s): spiega cosa fare, non ripete il gergo del browser', (testo) => {
    const messaggio = messaggioErroreChat(new TypeError(testo), 0)
    expect(messaggio).toContain('Connessione persa')
    expect(messaggio).not.toContain(testo)
  })

  // CONTROLLO POSITIVO: gli errori con un messaggio SCRITTO PER L'UTENTE devono
  // continuare ad arrivargli interi. Il piu' importante e' il 413, che spiega
  // come ridurre i file: farlo sparire dietro un generico sarebbe una perdita.
  test('un errore con messaggio pensato per l Ingegnere arriva intero', () => {
    const err = new Error('I file sono troppo pesanti (6.2 MB).\nCarica da Telegram.')
    expect(messaggioErroreChat(err, 2)).toBe('⚠️ I file sono troppo pesanti (6.2 MB).\nCarica da Telegram.')
  })

  // Un errore che il SERVER ha risposto non e' una caduta di rete, anche se il
  // suo testo contiene la parola: il messaggio vero va letto, non sostituito.
  // (mutazione E4: allargare la guardia da TypeError a Error lo mangiava)
  test('un errore del server che nomina la connessione arriva intero', () => {
    const err = new Error('Errore server (500): database connection refused')
    expect(messaggioErroreChat(err, 0)).toContain('database connection refused')
  })

  test('errore senza messaggio, con file allegati: parla dei file', () => {
    expect(messaggioErroreChat({}, 3)).toContain('analisi dei file')
  })

  test('errore senza messaggio, senza file: messaggio generico', () => {
    expect(messaggioErroreChat({}, 0)).toBe('⚠️ Errore di connessione. Riprova.')
  })
})
