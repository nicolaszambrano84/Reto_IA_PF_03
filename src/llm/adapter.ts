/**
 * Interfaz propia del proveedor de lenguaje (PRD §6.1): enviar(mensajes, herramientas) → respuesta.
 * El ciclo del agente solo conoce estos tipos; cambiar de proveedor no toca el ciclo.
 */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
}

/** Contenido propio de un proveedor que debe devolverse tal cual (p. ej. firmas de pensamiento de Gemini). */
export interface ContenidoCrudo {
  proveedor: string
  valor: unknown
}

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; crudo?: ContenidoCrudo }
  | { rol: "herramienta"; idLlamada: string; nombre: string; resultado: string }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos, generado desde los esquemas zod. */
  parametros: Record<string, unknown>
}

export interface Uso {
  entrada: number
  salida: number
}

export interface RespuestaModelo {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: Uso
  crudo?: ContenidoCrudo
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo>
}

/** Error del proveedor con un mensaje apto para el chat: claro, sin claves ni trazas internas. */
export class ErrorProveedor extends Error {
  override name = "ErrorProveedor"

  /** `reintentable`: la llamada no obtuvo respuesta (cuelgue); vale la pena un nuevo intento. */
  constructor(
    mensaje: string,
    readonly reintentable = false,
  ) {
    super(mensaje)
  }
}

/** Oculta cualquier cosa con forma de clave de API antes de mostrar o registrar un error. */
export function ocultarSecretos(texto: string): string {
  return texto
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[clave oculta]")
    .replace(/((?:api[_-]?key|key|token|authorization)["'=:\s]+)[^\s"'&,;]+/gi, "$1[oculto]")
}
