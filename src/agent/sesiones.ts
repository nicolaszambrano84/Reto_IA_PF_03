import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Mensaje, Uso } from "../llm/adapter"
import type { Pendiente } from "./confirmacion"

/** Sesiones del chat: en memoria y respaldadas en out/sesiones/<id>.json (el PRD no pide base de datos). */

/** Lista blanca del identificador: también es nombre de archivo, así que no admite "../" ni separadores. */
export const IdSesionSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "identificador de sesión inválido")

export interface LlamadaVisible {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  /** `data` si salió bien, o el texto del error. */
  resultado: unknown
  duracionMs: number
  /** Presente si la compuerta de confirmación del servidor cambió la llamada. */
  compuerta?: string
}

export interface Turno {
  rol: "usuario" | "asistente"
  texto: string
  ts: string
  llamadas?: LlamadaVisible[]
  needsConfirmation?: boolean
  pendientes?: Pendiente[]
  avisos?: string[]
}

export interface Sesion {
  id: string
  creada: string
  /** Historial que ve el modelo (incluye resultados completos de herramientas). */
  historial: Mensaje[]
  /** Historial visible para la persona (GET /api/sessions/:id). */
  turnos: Turno[]
  /** Casos por los que el agente preguntó en su última respuesta (ventana de confirmación). */
  pendientes: Pendiente[]
  tokens: Uso
}

export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(
    private readonly carpeta: string,
    private readonly maximoEnMemoria = 300,
  ) {}

  crear(id: string = randomUUID()): Sesion {
    const sesion: Sesion = { id, creada: new Date().toISOString(), historial: [], turnos: [], pendientes: [], tokens: { entrada: 0, salida: 0 } }
    this.sesiones.set(id, sesion)
    // Tope de memoria: se descarta la sesión más antigua (sigue en disco).
    if (this.sesiones.size > this.maximoEnMemoria) {
      const masAntigua = this.sesiones.keys().next().value
      if (masAntigua !== undefined) this.sesiones.delete(masAntigua)
    }
    return sesion
  }

  async obtener(id: string): Promise<Sesion | undefined> {
    if (!IdSesionSchema.safeParse(id).success) return undefined
    const enMemoria = this.sesiones.get(id)
    if (enMemoria) return enMemoria
    try {
      const guardada = JSON.parse(await readFile(this.ruta(id), "utf8")) as Sesion
      if (guardada.id !== id || !Array.isArray(guardada.historial) || !Array.isArray(guardada.turnos)) return undefined
      this.sesiones.set(id, guardada)
      return guardada
    } catch {
      return undefined
    }
  }

  async guardar(sesion: Sesion): Promise<void> {
    await mkdir(this.carpeta, { recursive: true })
    await writeFile(this.ruta(sesion.id), JSON.stringify(sesion), "utf8")
  }

  /** Una sesión procesa un solo mensaje a la vez (evita turnos cruzados y gasto duplicado). */
  tomar(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  soltar(id: string): void {
    this.ocupadas.delete(id)
  }

  private ruta(id: string): string {
    return path.join(this.carpeta, `${IdSesionSchema.parse(id)}.json`)
  }
}
