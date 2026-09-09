/**
 * src/lib/markdown-inline.test.ts
 *
 * Segnalato da Raffaele: nella chat web i link non sono cliccabili. Il bot ha
 * dato la colpa tre volte di fila al browser, alla sessione e ai permessi di
 * Drive — e nessuna delle tre era la causa.
 *
 * La causa: `renderInline` trasformava in `<a>` solo la forma markdown
 * `[testo](url)`. Un URL NUDO — `https://drive.google.com/file/d/…` — restava
 * testo. E il bot scrive URL nudi, col 👉 davanti.
 *
 * ⭐ Su Telegram non si nota, perche' e' il CLIENT di Telegram a rendere
 * cliccabili gli indirizzi da solo. Sul web non lo fa nessuno: stesso messaggio,
 * cliccabile su un canale e testo morto sull'altro. E' la solita divergenza fra
 * i due canali, nascosta dietro una cortesia che un canale offre e l'altro no.
 */
import { describe, it, expect } from 'vitest'
import { renderInline } from './markdown-inline'

const DRIVE = 'https://drive.google.com/file/d/1DdUqkR4DWEVVute0_Y7RByBeNECe1eWQ/view?usp=drivesdk'

describe('un indirizzo scritto nudo diventa cliccabile', () => {
  it('l URL nudo diventa un link', () => {
    const html = renderInline(`👉 ${DRIVE}`)

    expect(html).toContain(`href="${DRIVE}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('il link markdown continua a funzionare', () => {
    // CONTROLLO POSITIVO sull'estrazione: la regola che gia' c'era non deve
    // essersi persa per strada.
    const html = renderInline(`Ecco la [relazione](${DRIVE}) aggiornata`)

    expect(html).toContain(`href="${DRIVE}"`)
    expect(html).toContain('>relazione</a>')
  })

  it('un URL gia dentro un link markdown NON viene linkato due volte', () => {
    // E' il difetto che si crea curando l'altro: l'indirizzo dentro `href="…"`
    // e' esso stesso un URL, e una regola ingenua ci ricascherebbe sopra
    // producendo un `<a>` dentro un `<a>`.
    const html = renderInline(`[relazione](${DRIVE})`)

    expect(html.match(/<a /g) ?? []).toHaveLength(1)
    expect(html).not.toContain('<a href="https://drive.google.com/file/d/1DdUqkR4DWEVVute0_Y7RByBeNECe1eWQ/view?usp=drivesdk"><a')
  })

  it('un indirizzo dentro il TESTO di un link non genera un link annidato', () => {
    // Il caso che rende necessaria la guardia, e che il primo giro di mutazioni
    // ha scoperto scoperto: qui l'URL sta dentro il testo visibile dell'ancora,
    // seguito da uno spazio — quindi una regola ingenua lo aggancerebbe e
    // produrrebbe un `<a>` dentro un `<a>`, che il browser rende in modo
    // imprevedibile.
    const html = renderInline('[vedi https://esempio.it/doc per i dettagli](https://altro.it/x)')

    expect(html.match(/<a /g) ?? []).toHaveLength(1)
    expect(html).toContain('href="https://altro.it/x"')
  })

  it('la punteggiatura di fine frase resta fuori dal link', () => {
    // «Trova il file qui: https://esempio.it/doc.» — il punto finale non fa
    // parte dell'indirizzo, e dentro l'href romperebbe il collegamento.
    const html = renderInline('Il file sta qui: https://esempio.it/doc.')

    expect(html).toContain('href="https://esempio.it/doc"')
    expect(html).toContain('</a>.')
  })

  it('anche la parentesi di chiusura resta fuori', () => {
    const html = renderInline('(vedi https://esempio.it/doc)')

    expect(html).toContain('href="https://esempio.it/doc"')
    expect(html).toContain('</a>)')
  })

  it('CONTROLLO POSITIVO: un testo senza indirizzi non viene toccato', () => {
    // Senza questo, i test sopra passerebbero anche con un codice che infila
    // un <a> ovunque.
    const html = renderInline('Confermato con verifica reale della cartella.')

    expect(html).not.toContain('<a ')
    expect(html).toBe('Confermato con verifica reale della cartella.')
  })

  it('grassetto, corsivo e codice sopravvivono all estrazione', () => {
    // L'altro controllo positivo dell'estrazione: la funzione e' stata spostata
    // di file, e tutto il resto deve funzionare come prima.
    expect(renderInline('**forte**')).toContain('<strong>forte</strong>')
    expect(renderInline('~~tolto~~')).toContain('<del')
    expect(renderInline('`codice`')).toContain('<code')
  })
})
