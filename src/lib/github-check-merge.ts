/**
 * Il bot puo' mergiare questa PR?
 *
 * L'8 settembre 2026 ha mergiato su `main` una PR che non compilava. Il build
 * di Vercel falliva, il deploy non partiva, e per ore il bot e l'Ingegnere
 * hanno ragionato su codice che non era in produzione: il bot rigenerava un PDF,
 * vedeva la foto ancora rotta, e concludeva che il proprio fix "non funzionava
 * per quel file". Stava misurando codice che non era live.
 *
 * La CI esisteva dal 17 agosto e avrebbe visto l'errore. Il commento in cima a
 * `.github/workflows/ci.yml` diceva testualmente: "NON impostare questi job come
 * required status check finche' il bot che mergia le PR non e' stato adeguato".
 * Questo modulo e' quell'adeguamento.
 */

export type StatoCheck = {
  /** Esito complessivo riportato da GitHub. */
  stato: 'success' | 'failure' | 'pending'
  /** Quanti controlli non hanno ancora finito. */
  inCorso: number
  /** Nomi dei controlli falliti, per poterli dire invece di un "rosso" generico. */
  falliti: string[]
  /** Quanti controlli esistono in tutto. Zero significa che nessuno guarda. */
  totali: number
}

export type EsitoMerge = { mergia: boolean; motivo: string }

export function decidiSeMergiare(
  check: StatoCheck,
  opzioni: { forzato?: boolean } = {},
): EsitoMerge {
  if (opzioni.forzato) {
    return { mergia: true, motivo: 'Merge forzato su richiesta esplicita dell Ingegnere: i controlli non sono stati considerati.' }
  }

  // Nessun controllo NON e' un via libera. E' esattamente la situazione dell'8
  // settembre: si mergia senza che nessuno abbia guardato niente.
  if (check.totali === 0) {
    return {
      mergia: false,
      motivo: 'Nessun controllo automatico ha girato su questa PR. Non e\' un via libera: e\' che nessuno ha guardato. Attendere la CI, oppure chiedere all\'Ingegnere di forzare.',
    }
  }

  if (check.inCorso > 0 || check.stato === 'pending') {
    return {
      mergia: false,
      motivo: `${check.inCorso || 1} controlli ancora in corso. Si aspetta l'esito invece di tirare a indovinare.`,
    }
  }

  if (check.stato === 'failure' || check.falliti.length > 0) {
    const quali = check.falliti.length > 0 ? check.falliti.join(', ') : 'controlli automatici'
    return {
      mergia: false,
      motivo: `Controlli FALLITI: ${quali}. Mergiare adesso significa un build rotto su main, un deploy che non parte e la produzione ferma al commit di prima — senza che niente lo dica.`,
    }
  }

  return { mergia: true, motivo: `${check.totali} controlli verdi.` }
}
