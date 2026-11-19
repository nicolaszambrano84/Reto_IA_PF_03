import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as herramientasDelModulo from "../modulo/tools/oc"
import { diferenciasModulo } from "../scripts/modulo"
import * as herramientasDeLaApp from "../src/tools/oc"
import { grupo, prueba } from "./arnes"
import { RAIZ_PROYECTO } from "./sinteticos"

grupo("Bonus: modulo/ reutilizable (PRD §9.4)")

prueba("Las tres piezas de modulo/ coinciden con las fuentes que usa la aplicación (no hay copias divergentes)", async () => {
  assert.deepEqual(await diferenciasModulo(RAIZ_PROYECTO), [])
})

prueba("modulo/tools/oc.ts exporta exactamente los mismos objetos de herramienta que la app", () => {
  assert.deepEqual(Object.keys(herramientasDelModulo).sort(), Object.keys(herramientasDeLaApp).sort())
  for (const [nombre, h] of Object.entries(herramientasDeLaApp)) {
    assert.equal((herramientasDelModulo as Record<string, unknown>)[nombre], h, `${nombre} debe ser el mismo objeto`)
  }
})

prueba("agent.md y SKILL.md tienen el frontmatter pedido", async () => {
  const agente = await readFile(path.join(RAIZ_PROYECTO, "modulo", "agent.md"), "utf8")
  assert.match(agente, /^---\ndescription: .+\nmode: primary\npermission:\n {2}edit: deny\n {2}bash: deny\n---\n/)
  const skill = await readFile(path.join(RAIZ_PROYECTO, "modulo", "skill", "ordenes-compra", "SKILL.md"), "utf8")
  assert.match(skill, /^---\nname: ordenes-compra\ndescription: .+\n---\n/)
})
