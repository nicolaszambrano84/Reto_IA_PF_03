import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * System prompt = comportamiento (agent/prompt.md) + conocimiento del proceso
 * (src/knowledge/ordenes-compra.md). Ninguno de los dos está embebido en el código.
 */
export function construirSistema(raiz: string): string {
  const comportamiento = readFileSync(path.join(raiz, "agent", "prompt.md"), "utf8").trim()
  const conocimiento = readFileSync(path.join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf8").trim()
  return `${comportamiento}\n\n---\n\n${conocimiento}\n`
}
