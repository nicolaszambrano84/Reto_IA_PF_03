import { appendFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { conCandado } from "./candado"
import { rutaSalida } from "./rutas"

/**
 * HU-5: log de control out/control.csv, que consumen Contabilidad y Auditoría.
 * Una fila por intento. Un mismo caso puede tener varias (pendiente → creada); vale la última.
 * - oc_validar registra los intentos que se detienen ahí: bloqueada o pendiente.
 * - oc_crear registra cada llamada: creada, existente (idempotencia), pendiente o bloqueada.
 */

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente"

export interface FilaControl {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

export const COLUMNAS_CONTROL = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

export async function registrarControl(directory: string, fila: FilaControl): Promise<void> {
  const ruta = rutaSalida(directory, "control.csv")
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
  await conCandado("control-csv", async () => {
    await mkdir(path.dirname(ruta), { recursive: true })
    const encabezado = (await existe(ruta)) ? "" : `${COLUMNAS_CONTROL.join(",")}\r\n`
    await appendFile(ruta, `${encabezado}${valores.map(celdaCsv).join(",")}\r\n`, "utf8")
  })
}

/**
 * Celda CSV según RFC 4180 y protegida contra inyección de fórmulas (OWASP "CSV Injection"):
 * un valor que empieza por = + - @ se antepone con ' para que Excel no lo ejecute como fórmula.
 * Importa porque solicitud_id viene de un Excel externo.
 */
export function celdaCsv(valor: string): string {
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor
  return /[",\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}
