/**
 * of-stop (21.11.2026): `of-run.sh --stop <pid>` trifft den headless-run —
 * direkt oder unter der --wait-Shell — und sonst nichts.
 *
 * Die Auflösung läuft gegen eine Fake-Prozesstabelle; ein Fall startet echte
 * Prozesse (eine Shell namens of-run.sh mit einem bun-Kind, das sich als
 * headless-run.ts ausgibt) und stoppt sie über die CLI. Das Ledger geht in
 * ein Temp-Verzeichnis.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { procTabelle, skript, zielAufloesen, type Prozesse } from "./of-stop"

const SCRIPTS = import.meta.dir
let dirs: string[] = []
let prozesse: Bun.Subprocess[] = []
afterEach(() => {
  for (const p of prozesse) p.kill("SIGKILL")
  prozesse = []
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "of-stop-"))
  dirs.push(d)
  return d
}

function fake(tabelle: Record<number, { argv: string[]; ppid: number }>): Prozesse {
  return {
    argv: (pid) => tabelle[pid]?.argv,
    kinder: (pid) =>
      Object.entries(tabelle)
        .filter(([, p]) => p.ppid === pid)
        .map(([id]) => Number(id)),
  }
}

const HEADLESS = ["/home/u/.local/bin/bun", "/repo/packages/flow/scripts/headless-run.ts", "auto-orchestrator", "task"]
const WRAPPER = ["bash", "/repo/packages/flow/scripts/of-run.sh", "--wait", "auto-orchestrator", "task"]

describe("zielAufloesen", () => {
  it("headless-run selbst (detached) ist das Ziel", () => {
    expect(zielAufloesen(100, fake({ 100: { argv: HEADLESS, ppid: 1 } }))).toEqual({ ziel: 100 })
  })

  it("die --wait-Shell löst auf ihr headless-run-Kind auf", () => {
    const proc = fake({
      200: { argv: WRAPPER, ppid: 1 },
      201: { argv: ["sleep", "1"], ppid: 200 },
      202: { argv: HEADLESS, ppid: 200 },
    })
    expect(zielAufloesen(200, proc)).toEqual({ ziel: 202, ueber: 200 })
  })

  it("ein Zwischenprozess (setsid/nohup) kostet eine Ebene, nicht den Treffer", () => {
    const proc = fake({
      300: { argv: WRAPPER, ppid: 1 },
      301: { argv: ["setsid", "nohup"], ppid: 300 },
      302: { argv: HEADLESS, ppid: 301 },
    })
    expect(zielAufloesen(300, proc)).toEqual({ ziel: 302, ueber: 300 })
  })

  it("Shell ohne headless-run-Kind wird verweigert (Exit 2)", () => {
    const r = zielAufloesen(400, fake({ 400: { argv: WRAPPER, ppid: 1 } }))
    expect("code" in r && r.code).toBe(2)
  })

  it("fremder Prozess wird verweigert — auch wenn seine Argumente die Namen tragen", () => {
    const r = zielAufloesen(500, fake({ 500: { argv: ["vim", "headless-run.ts", "of-run.sh"], ppid: 1 } }))
    expect("code" in r && r.code).toBe(2)
    // Aufgabenwörter einer Shell entscheiden nicht, das Skript tut es.
    expect(skript(["bash", "/x/of-run.sh", "--wait", "p", "fix", "headless-run.ts"])).toBe("of-run.sh")
  })

  it("tote PID → Exit 1, unsinnige PID → Exit 2", () => {
    const tot = zielAufloesen(600, fake({}))
    expect("code" in tot && tot.code).toBe(1)
    const unsinn = zielAufloesen(1, fake({}))
    expect("code" in unsinn && unsinn.code).toBe(2)
  })
})

describe("of-stop CLI, echte Prozesse", () => {
  const cli = (pid: number, ledger: string) =>
    Bun.spawnSync([process.execPath, join(SCRIPTS, "of-stop.ts"), String(pid), "--wait-s", "5"], {
      env: { ...process.env, OPENFLOW_LEDGER: ledger },
    })

  it("--wait-Shell: SIGTERM erreicht das headless-run-Kind, Exit 0, Ledger-Zeile", async () => {
    const d = tmp()
    const wrapper = join(d, "of-run.sh")
    // Das Kind ist das Vordergrund-Kind der Shell, wie bei `of-run.sh --wait`.
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\n"$1" -e 'process.on("SIGTERM",()=>process.exit(143));setInterval(()=>{},1000)' headless-run.ts\necho "kind-ende $?"\n`,
    )
    chmodSync(wrapper, 0o755)
    const shell = Bun.spawn(["bash", wrapper, process.execPath], { stdout: "pipe" })
    prozesse.push(shell)
    const ledger = join(d, "ledger.jsonl")
    // Warten, bis das Kind steht.
    const kind = await (async () => {
      for (let i = 0; i < 100; i++) {
        const r = zielAufloesen(shell.pid, procTabelle)
        if ("ziel" in r) return r.ziel
        await Bun.sleep(50)
      }
      throw new Error("kein headless-run-Kind")
    })()
    expect(kind).not.toBe(shell.pid)
    const r = cli(shell.pid, ledger)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe(`gestoppt: ${kind}`)
    expect(await shell.exited).toBe(0)
    expect(await new Response(shell.stdout).text()).toContain("kind-ende 143")
    const zeile = JSON.parse(readFileSync(ledger, "utf8").trim())
    expect(zeile).toMatchObject({ event: "fabrik_stop", quelle: "of-stop.ts", pid: shell.pid, target: kind, ergebnis: "gestoppt" })
  })

  it("headless-run direkt: gestoppt; danach dieselbe PID → Exit 1", async () => {
    const d = tmp()
    const p = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)", "headless-run.ts"])
    prozesse.push(p)
    await Bun.sleep(200)
    const ledger = join(d, "ledger.jsonl")
    const r = cli(p.pid, ledger)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe(`gestoppt: ${p.pid}`)
    await p.exited
    expect(cli(p.pid, ledger).exitCode).toBe(1)
  })

  it("fremder lebender Prozess wird nicht angefasst (Exit 2)", async () => {
    const d = tmp()
    const p = Bun.spawn(["sleep", "30"])
    prozesse.push(p)
    const ledger = join(d, "ledger.jsonl")
    const r = cli(p.pid, ledger)
    expect(r.exitCode).toBe(2)
    expect(p.killed).toBe(false)
    expect(procTabelle.argv(p.pid)).toBeDefined()
    expect(existsSync(ledger)).toBe(false)
  })
})
