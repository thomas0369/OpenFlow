/**
 * Synthetischer auto-orchestrator-Lauf mit den GEMESSENEN Abschnittsgrößen des
 * A/B-Laufs F-A1-1 vom 24.10.2026 (Byte UTF-8): boss 10 075, worker-1 5 025,
 * worker-2 6 823, worker-3 4 130, critic 4 468 — Summe 30 521, über 25 KB.
 * Der Inhalt ist erfunden (das Repo ist öffentlich), nur Größe, Rolle und
 * Reihenfolge stammen aus dem echten Log. Mit dem alten Schnitt am Dateiende
 * fehlte in genau diesem Lauf die Kritik ganz.
 */
export const A1_1_GROESSEN = { boss: 10_075, "worker-1": 5_025, "worker-2": 6_823, "worker-3": 4_130, critic: 4_468 }

/** Text von genau `n` Byte: Kopfzeile, Füllung mit Umlauten (2-Byte-Zeichen), Endmarke. */
export function textVon(n: number, kopf: string, ende: string): string {
  const rumpf = `${kopf}\n\n`
  const schluss = `\n${ende}`
  let fuell = n - Buffer.byteLength(rumpf + schluss, "utf8")
  let mitte = ""
  const satz = "Befund mit Beleg in Datei:Zeile, geprüft über Stichprobe. "
  while (fuell >= Buffer.byteLength(satz, "utf8")) {
    mitte += satz
    fuell -= Buffer.byteLength(satz, "utf8")
  }
  mitte += "x".repeat(fuell)
  return rumpf + mitte + schluss
}

export function a1Lauf(groessen: Record<string, number> = A1_1_GROESSEN) {
  const rolle = (id: string) => (id === "boss" ? "orchestrator" : id === "critic" ? "critic" : "subagent")
  const kopf: Record<string, string> = { boss: "SYNTHESE: 10 von 14 Workern haben einen Canary.", critic: "VERDICT: ANNEHMBAR — kein Beleg widerlegt." }
  return {
    id: "run-A1",
    pipeline: "auto-orchestrator",
    status: "done",
    started: 1_000,
    finished: 590_000,
    nodes: Object.entries(groessen).map(([id, n]) => ({
      id,
      role: rolle(id),
      status: "done",
      output: textVon(n, kopf[id] ?? `Bericht ${id}`, `ENDE-${id}`),
    })),
  }
}
