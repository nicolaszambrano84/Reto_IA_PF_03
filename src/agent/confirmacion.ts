import { normalizarTexto } from "../tools/lib/texto"

/**
 * CA3, del lado del servidor: qué cuenta como confirmación del usuario. Ante la duda, NO confirma
 * (falla cerrado): una confirmación no reconocida solo hace que el agente vuelva a preguntar.
 */

export interface Pendiente {
  caso: string
  solicitud_id: string
}

/** Cualquier negación anula la confirmación ("no", "espera", "cancela", "todavía no"…). */
const NEGACION = /\b(no|nunca|cancela|cancelar|cancelo|espera|esperemos|detente|alto|rechazo|todavia no|aun no|mejor no)\b/
/** Confirmaciones explícitas, válidas en cualquier parte del mensaje. */
const AFIRMACION_FUERTE = /\b(confirmo|confirmado|confirmada|confirmamos|procede|procedamos|adelante|creala|crealas|autorizo|apruebo|hazlo|de acuerdo)\b/
/** Palabras cortas que solo cuentan al inicio del mensaje ("ok, créala", "dale"). */
const AFIRMACION_INICIAL = /^(ok|okay|dale|listo|correcto)\b/
/** "sí" afirmativo. Sin tilde, "si" es condicional ("si quieres…"): solo vale solo o con otra afirmación. */
const SI_CON_TILDE = /^sí(?=$|[\s,.!])/
const SI_SIN_TILDE = /^si(?:\s*[,.!]|\s*$|\s+(?:claro|dale|por favor)\b)/

export function esConfirmacion(texto: string): boolean {
  const t = normalizarTexto(texto)
  if (NEGACION.test(t)) return false
  return AFIRMACION_FUERTE.test(t) || AFIRMACION_INICIAL.test(t) || SI_CON_TILDE.test(texto.trim().toLowerCase()) || SI_SIN_TILDE.test(t)
}

/**
 * Casos que el usuario confirma con este mensaje. La ventana dura un turno: solo valen los casos
 * por los que el agente preguntó en su respuesta anterior. Con varios pendientes hay que nombrarlos.
 */
export function casosAutorizados(mensaje: string, ventana: Pendiente[]): Pendiente[] {
  if (ventana.length === 0 || !esConfirmacion(mensaje)) return []
  const t = normalizarTexto(mensaje)
  const nombrados = ventana.filter((p) => t.includes(p.caso.toLowerCase()) || t.includes(normalizarTexto(p.solicitud_id)))
  if (nombrados.length > 0) return nombrados
  return ventana.length === 1 ? ventana : []
}

export function preguntaConfirmacion(pendientes: Pendiente[]): string {
  const nombres = pendientes.map((p) => `${p.caso} (${p.solicitud_id})`).join(", ")
  if (pendientes.length === 1) {
    return `¿Confirmas la creación de la OC de ${nombres} con las excepciones indicadas? Responde «confirmo» para crearla o «no» para dejarla pendiente.`
  }
  return `Quedan pendientes de tu confirmación: ${nombres}. Indica cuál confirmas, por ejemplo «confirmo ${pendientes[0]?.caso ?? "sol-001"}».`
}

/** ¿La última línea con texto ya hace una pregunta? ("¿Confirmas…? Responde «confirmo»…" cuenta). */
export function terminaEnPregunta(texto: string): boolean {
  const ultima = texto.trim().split("\n").filter((l) => l.trim() !== "").at(-1) ?? ""
  return ultima.includes("?")
}
