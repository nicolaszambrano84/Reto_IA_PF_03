import { ErrorProveedor, type LlamadaHerramienta, type ProveedorLLM, type RespuestaModelo, type Uso } from "../llm/adapter"
import { casosAutorizados, preguntaConfirmacion, terminaEnPregunta, type Pendiente } from "./confirmacion"
import type { PresupuestoDiario } from "./consumo"
import { DEFINICIONES, ejecutarHerramienta } from "./herramientas"
import type { LlamadaVisible, Sesion } from "./sesiones"

/**
 * Ciclo del agente (PRD §6.3): mensaje del usuario → (modelo → herramientas)* → respuesta.
 * CA1 tope de iteraciones · CA2 los valores salen de herramientas (prompt + recálculo en cada una)
 * CA3 confirmación humana impuesta aquí, no solo en el prompt · CA4 cada llamada queda visible y
 * en out/log.jsonl · CA5 un error del proveedor se explica en el chat y la sesión sigue viva.
 */

export interface DependenciasCiclo {
  proveedor: ProveedorLLM
  sistema: string
  /** Raíz del proyecto (ctx.directory de las herramientas). */
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
  presupuesto: PresupuestoDiario
  /** Opcional (streaming): avisa cada paso mientras el turno avanza. */
  alEvento?: (evento: EventoCiclo) => void
}

export type EventoCiclo = { tipo: "pensando"; iteracion: number } | { tipo: "herramienta"; llamada: LlamadaVisible }

export interface RespuestaTurno {
  sessionId: string
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  pendientes: Pendiente[]
  avisos: string[]
  provider: string
  model: string
  tokens: Uso
}

const FLUJO = ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload", "oc_crear"]

export async function procesarTurno(sesion: Sesion, mensaje: string, d: DependenciasCiclo): Promise<RespuestaTurno> {
  const ahora = () => new Date().toISOString()
  // Ventana de confirmación de un solo turno: vale lo que se preguntó en la respuesta anterior.
  const autorizados = casosAutorizados(mensaje, sesion.pendientes)
  sesion.pendientes = []
  sesion.historial.push({ rol: "usuario", texto: mensaje })
  sesion.turnos.push({ rol: "usuario", texto: mensaje, ts: ahora() })

  const llamadas: LlamadaVisible[] = []
  const avisos: string[] = []
  const casos = new SeguimientoCasos()
  let reply = ""

  for (let iteracion = 1; ; iteracion++) {
    const tope = topeDeConsumo(sesion, d)
    if (tope) {
      reply = tope
      avisos.push(tope)
      break
    }
    if (iteracion > d.maxIteraciones) {
      reply = resumenPorTope(llamadas, d.maxIteraciones)
      break
    }
    d.alEvento?.({ tipo: "pensando", iteracion })
    let r: RespuestaModelo
    try {
      r = await d.proveedor.enviar([{ rol: "sistema", texto: d.sistema }, ...sesion.historial], DEFINICIONES)
    } catch (e) {
      reply = e instanceof ErrorProveedor ? `No pude completar la respuesta: ${e.message}` : "No pude completar la respuesta por un error inesperado del proveedor. Intenta de nuevo."
      avisos.push(reply)
      break
    }
    sesion.tokens.entrada += r.uso.entrada
    sesion.tokens.salida += r.uso.salida
    d.presupuesto.sumar(r.uso)
    sesion.historial.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas, ...(r.crudo ? { crudo: r.crudo } : {}) })
    if (r.llamadas.length === 0) {
      reply = r.texto
      break
    }
    for (const llamada of r.llamadas) {
      const visible = await ejecutarLlamada(llamada, autorizados, sesion, d.directory)
      llamadas.push(visible)
      casos.registrar(visible)
      d.alEvento?.({ tipo: "herramienta", llamada: visible })
    }
  }

  // CA3: si quedó algo esperando confirmación, el turno termina con una pregunta explícita.
  const pendientes = casos.pendientes()
  if (!reply.trim()) reply = "No obtuve texto del modelo en este turno."
  if (pendientes.length > 0 && !terminaEnPregunta(reply)) reply = `${reply.trim()}\n\n${preguntaConfirmacion(pendientes)}`
  // Si el turno terminó tras ejecutar herramientas (error o tope), se cierra con un mensaje del
  // asistente: algunos proveedores exigen alternar roles. La respuesta del modelo no se toca (va firmada).
  if (sesion.historial.at(-1)?.rol !== "asistente") sesion.historial.push({ rol: "asistente", texto: reply, llamadas: [] })
  sesion.pendientes = pendientes
  sesion.turnos.push({ rol: "asistente", texto: reply, ts: ahora(), llamadas, needsConfirmation: pendientes.length > 0, pendientes, avisos })

  return {
    sessionId: sesion.id,
    reply,
    toolCalls: llamadas,
    needsConfirmation: pendientes.length > 0,
    pendientes,
    avisos,
    provider: d.proveedor.nombre,
    model: d.proveedor.modelo,
    tokens: { ...sesion.tokens },
  }
}

// ── Compuerta de confirmación (CA3 en el servidor) ───────────────────────────────────────────

const NOTA_COMPUERTA =
  "Compuerta del servidor: se ignoró confirmado=true porque el usuario no confirmó este caso en su último mensaje en respuesta a una pregunta de confirmación."

/** oc_crear con confirmado=true solo pasa si el usuario confirmó ese caso en este turno. */
function aplicarCompuerta(l: LlamadaHerramienta, autorizados: Pendiente[]): { argumentos: Record<string, unknown>; compuerta?: string } {
  if (l.nombre !== "oc_crear" || l.argumentos.confirmado !== true) return { argumentos: l.argumentos }
  if (autorizados.some((p) => p.caso === l.argumentos.caso)) return { argumentos: l.argumentos }
  return { argumentos: { ...l.argumentos, confirmado: false }, compuerta: NOTA_COMPUERTA }
}

async function ejecutarLlamada(l: LlamadaHerramienta, autorizados: Pendiente[], sesion: Sesion, directory: string): Promise<LlamadaVisible> {
  const { argumentos, compuerta } = aplicarCompuerta(l, autorizados)
  const inicio = Date.now()
  let salida = await ejecutarHerramienta(l.nombre, argumentos, { directory, sessionId: sesion.id })
  if (compuerta) salida = anteponerAlError(salida, compuerta)
  sesion.historial.push({ rol: "herramienta", idLlamada: l.id, nombre: l.nombre, resultado: salida })
  const r = interpretar(salida)
  return { id: l.id, nombre: l.nombre, argumentos, ok: r.ok, resultado: r.valor, duracionMs: Date.now() - inicio, ...(compuerta ? { compuerta } : {}) }
}

// ── Seguimiento de casos dentro del turno (qué queda esperando confirmación) ─────────────────

class SeguimientoCasos {
  private readonly estado = new Map<string, Pendiente & { pendiente: boolean }>()

  registrar(l: LlamadaVisible): void {
    const caso = typeof l.argumentos.caso === "string" ? l.argumentos.caso : null
    if (!caso) return
    const solicitud_id = solicitudDe(l.resultado) ?? this.estado.get(caso)?.solicitud_id ?? caso
    if (l.nombre === "oc_validar" && l.ok) this.estado.set(caso, { caso, solicitud_id, pendiente: validacionPendiente(l.resultado) })
    // Un payload construido y no creado espera la decisión de la analista ("no la crees hasta que confirme").
    if (l.nombre === "oc_construir_payload" && l.ok) this.estado.set(caso, { caso, solicitud_id, pendiente: true })
    if (l.nombre === "oc_crear") this.estado.set(caso, { caso, solicitud_id, pendiente: !l.ok && /Pendiente de confirmación/.test(String(l.resultado)) })
  }

  pendientes(): Pendiente[] {
    return [...this.estado.values()].filter((e) => e.pendiente).map(({ caso, solicitud_id }) => ({ caso, solicitud_id }))
  }
}

function validacionPendiente(data: unknown): boolean {
  if (!esObjeto(data)) return false
  return data.apta === true && Array.isArray(data.confirmaciones) && data.confirmaciones.length > 0 && !data.orden_existente
}

function solicitudDe(data: unknown): string | null {
  if (!esObjeto(data)) return null
  if (typeof data.solicitud_id === "string") return data.solicitud_id
  const payload = data.payload
  if (esObjeto(payload) && esObjeto(payload.referencia) && typeof payload.referencia.solicitud_id === "string") return payload.referencia.solicitud_id
  return null
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────

function topeDeConsumo(sesion: Sesion, d: DependenciasCiclo): string | null {
  if (sesion.tokens.entrada + sesion.tokens.salida >= d.maxTokensSesion) {
    return `Esta sesión alcanzó su tope de ${d.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
  }
  if (d.presupuesto.agotado()) return "Se alcanzó el tope diario de uso del modelo en este servidor. Intenta de nuevo mañana."
  return null
}

/** CA1: al llegar al tope, responde con lo que hizo y lo que faltó. */
function resumenPorTope(llamadas: LlamadaVisible[], maximo: number): string {
  const hechas = [...new Set(llamadas.filter((l) => l.ok).map((l) => l.nombre))]
  const fallidas = [...new Set(llamadas.filter((l) => !l.ok).map((l) => l.nombre))]
  const faltan = FLUJO.filter((f) => !hechas.includes(f))
  return [
    `Me detuve al alcanzar el tope de ${maximo} iteraciones de este turno.`,
    `Hecho: ${hechas.join(", ") || "nada"}.`,
    ...(fallidas.length ? [`Con error: ${fallidas.join(", ")}.`] : []),
    `Falta: ${faltan.join(", ") || "nada del flujo estándar"}.`,
    "Pídeme continuar si quieres que siga desde aquí.",
  ].join("\n")
}

function interpretar(salida: string): { ok: boolean; valor: unknown } {
  try {
    const v: unknown = JSON.parse(salida)
    if (esObjeto(v) && typeof v.ok === "boolean") return { ok: v.ok, valor: v.ok ? v.data : v.error }
  } catch {
    // salida no JSON: se muestra tal cual
  }
  return { ok: false, valor: salida }
}

function anteponerAlError(salida: string, nota: string): string {
  const r = interpretar(salida)
  return r.ok ? salida : JSON.stringify({ ok: false, error: `${nota} ${String(r.valor)}` })
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}
