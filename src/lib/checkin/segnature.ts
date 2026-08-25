/**
 * src/lib/checkin/segnature.ts
 *
 * I campi che dichiarano compiuto un adempimento.
 *
 * Sono i piu' pericolosi del sottosistema, e per un motivo preciso: se
 * sbagliano, non falliscono. Restituiscono una riga che dice "fatto" per
 * qualcosa che nessuno ha fatto, e a valle non c'e' niente che possa
 * accorgersene — non un test, non un errore, non un avviso. Lo si scopre dal
 * commercialista, o quando la Questura chiede conto di un ritardo.
 *
 * Per questo la logica sta qui, pura e provata, e non dentro le route.
 */

import type { StatoFattura } from './archivio'

/**
 * La riga con lo stato della fattura aggiornato — e il vecchio SI/NO tenuto in
 * riga con lui.
 *
 * `Fattura emessa` esisteva prima di `Stato fattura`, e altro codice ci si
 * appoggia ancora: la cancellazione di una prenotazione lo interroga per
 * rifiutarsi di togliere una riga gia' fatturata. Tenerlo aggiornato altrove
 * significherebbe due scritture separate e la certezza che prima o poi ne
 * parta una sola. Si scrivono INSIEME, nella stessa riscrittura di riga.
 *
 * Il derivato e' solo EMESSA -> SI. COMPILATA resta NO, ed e' il cuore della
 * distinzione: una fattura preparata su Fatture in Cloud ma mai inviata non e'
 * emessa, e darla per tale renderebbe la prenotazione incancellabile e
 * fatturata agli occhi di chiunque legga il foglio.
 */
export function conStatoFattura(
  riga: Record<string, string>,
  stato: StatoFattura,
): Record<string, string> {
  return {
    ...riga,
    'Stato fattura': stato,
    'Fattura emessa': stato === 'EMESSA' ? 'SI' : 'NO',
  }
}

/**
 * Le prenotazioni che finiscono davvero nel file scaricato.
 *
 * Gli elenchi in ingresso sono PARALLELI: una voce per ogni riga del file,
 * cioe' per ogni ospite. Le prenotazioni con piu' ospiti compaiono piu' volte
 * e vanno segnate una sola.
 *
 * Il filtro per struttura non e' un dettaglio: i CIN sono tre e i file da
 * caricare sono tre. Segnare anche le prenotazioni delle altre strutture le
 * farebbe risultare a posto senza che nessuno abbia generato niente — e il
 * ritardo sulle 24 ore si scoprirebbe a scadenza passata.
 */
export function idNelFile(
  idPerOspite: readonly string[],
  strutturaPerOspite: readonly string[],
  soloStruttura: string,
): string[] {
  const visti = new Set<string>()
  const fuori: string[] = []

  for (const [i, id] of idPerOspite.entries()) {
    const pulito = String(id ?? '').trim()
    if (!pulito) continue
    if (soloStruttura && strutturaPerOspite[i] !== soloStruttura) continue
    if (visti.has(pulito)) continue
    visti.add(pulito)
    fuori.push(pulito)
  }

  return fuori
}
