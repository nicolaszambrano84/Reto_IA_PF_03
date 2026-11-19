import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { rutaSalida } from "./rutas"

/**
 * CA4: cada llamada a herramienta deja una línea en out/log.jsonl. No guarda los argumentos completos
 * (pueden ser grandes); guarda su huella SHA-256 para poder correlacionarlos si hace falta.
 */
export interface EntradaLog {
  ts: string
  sessionId: string
  herramienta: string
  caso: string | null
  ok: boolean
  resumen: string
  duracion_ms: number
  args_sha256: string
}

export async function registrarLog(directory: string, entrada: EntradaLog): Promise<void> {
  try {
    const ruta = rutaSalida(directory, "log.jsonl")
    await mkdir(path.dirname(ruta), { recursive: true })
    await appendFile(ruta, `${JSON.stringify(entrada)}\n`, "utf8")
  } catch (e) {
    // El registro nunca debe tumbar una herramienta, pero la falla no se oculta.
    console.error("No se pudo escribir out/log.jsonl:", e instanceof Error ? e.message : e)
  }
}
