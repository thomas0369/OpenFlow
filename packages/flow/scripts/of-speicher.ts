/**
 * of-speicher — Run-Log-Schreiben in den Flow-Store, geordnet und abwartbar.
 *
 * Anlass (Abnahme R3, B3-Neulauf 24.10.2026): Run `run-2026-10-24T13-27-49-240Z-wpfg9a`
 * endete PASS (Checkpoint `status: done`, Shell-Meldung PASS), der Flow-Store
 * führte ihn aber weiter als `running`. headless-run schickte den letzten PUT
 * mit `void` und rief direkt danach `process.exit` — die Anfrage starb mit dem
 * Prozess. Der Reaper räumte den fertigen Run 7 min später als Zombie ab
 * (`stopped`) und schrieb mangels Zuordnung eine Ledger-Zeile. Über alle 150
 * Runs mit Checkpoint: 2 mit Checkpoint `done` und Store ≠ `done`.
 *
 * Regel: Jeder PUT hängt an EINER Kette (Reihenfolge = Aufrufreihenfolge, ein
 * älterer Zwischenstand kann den Endstand nicht überholen), und vor dem Exit
 * wird die Kette mit Frist geleert. Ein Fehler bleibt eine Meldung, nie ein Wurf.
 */

export interface Speicher {
  /** Reiht `body` ein; die Zusage erfüllt sich, wenn dieser PUT (und alle davor) durch ist. */
  schreibe(body: unknown): Promise<void>
  /** Wartet höchstens `frist_ms`, bis alles Eingereihte durch ist. true = vollständig. */
  leeren(frist_ms: number): Promise<boolean>
}

export function speicherKette(put: (body: unknown) => Promise<unknown>, fehler: (e: unknown) => void = () => undefined): Speicher {
  let kette: Promise<void> = Promise.resolve()
  return {
    schreibe(body) {
      kette = kette.then(() => put(body)).then(
        () => undefined,
        (e) => fehler(e),
      )
      return kette
    },
    async leeren(frist_ms) {
      let zeit: ReturnType<typeof setTimeout> | undefined
      const ablauf = new Promise<false>((r) => (zeit = setTimeout(() => r(false), frist_ms)))
      const ok = await Promise.race([kette.then(() => true as const), ablauf])
      clearTimeout(zeit)
      return ok
    },
  }
}
