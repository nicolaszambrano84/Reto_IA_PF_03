/**
 * Genera modulo/ (bonus, PRD §9.4) desde las MISMAS fuentes que usa la aplicación:
 *   modulo/agent.md                      = frontmatter + agent/prompt.md (idéntico)
 *   modulo/skill/ordenes-compra/SKILL.md = frontmatter + src/knowledge/ordenes-compra.md (idéntico)
 *   modulo/tools/oc.ts                   = re-exporta src/tools/oc.ts (no es una copia)
 *
 *   bun run modulo          regenera las piezas
 *   bun run modulo:check    falla si modulo/ quedó distinto de las fuentes (también lo verifican las pruebas)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const FRONTMATTER_AGENTE = `---
description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de una solicitud (solicitud, cotización, aprobación y factura); bloquea lo que no cumple control y pide confirmación humana para las excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---
`

const FRONTMATTER_SKILL = `---
name: ordenes-compra
description: Proceso de órdenes de compra de Periferia en SAP (documentos del paquete, maestros, controles RC1-RC10, OC retroactivas, campos de la OC, evidencia y trazabilidad). Úsalo al procesar solicitudes de compra con las herramientas oc_*.
---
`

const HERRAMIENTAS = `/**
 * Herramientas del agente, importables sin el servidor (PRD §9.4).
 * Re-export directo: son exactamente las mismas que usa la aplicación, no una copia.
 * Leen fixtures/reto-03/ y escriben en out/ relativos a ctx.directory (la raíz del proyecto anfitrión).
 */
export * from "../../src/tools/oc"
`

/** Contenido que debe tener cada pieza de modulo/ según las fuentes actuales. */
export async function piezasEsperadas(raiz: string = RAIZ): Promise<Record<string, string>> {
  const prompt = await readFile(path.join(raiz, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return {
    "modulo/agent.md": `${FRONTMATTER_AGENTE}\n${prompt}`,
    "modulo/skill/ordenes-compra/SKILL.md": `${FRONTMATTER_SKILL}\n${conocimiento}`,
    "modulo/tools/oc.ts": HERRAMIENTAS,
  }
}

/** Piezas de modulo/ que no coinciden con las fuentes (vacío = sincronizado). */
export async function diferenciasModulo(raiz: string = RAIZ): Promise<string[]> {
  const distintas: string[] = []
  for (const [ruta, esperado] of Object.entries(await piezasEsperadas(raiz))) {
    const actual = await readFile(path.join(raiz, ruta), "utf8").catch(() => null)
    if (actual !== esperado) distintas.push(ruta)
  }
  return distintas
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const distintas = await diferenciasModulo()
    if (distintas.length > 0) {
      console.error(`modulo/ no coincide con las fuentes: ${distintas.join(", ")}. Ejecuta: bun run modulo`)
      process.exit(1)
    }
    console.log("modulo/ coincide con agent/prompt.md, src/knowledge/ordenes-compra.md y src/tools/oc.ts")
    return
  }
  for (const [ruta, contenido] of Object.entries(await piezasEsperadas())) {
    await mkdir(path.dirname(path.join(RAIZ, ruta)), { recursive: true })
    await writeFile(path.join(RAIZ, ruta), contenido, "utf8")
    console.log(`escrito ${ruta}`)
  }
}

// Solo se ejecuta como comando; las pruebas importan las funciones sin disparar main().
const esComando = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (esComando) await main()
