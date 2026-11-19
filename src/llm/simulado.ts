import type { OrdenCompra } from "../sap/orden"
import type { Paquete } from "../tools/lib/esquemas"
import type { Hallazgo, Validacion } from "../tools/lib/reglas"
import { formatoMonto, normalizarTexto } from "../tools/lib/texto"
import type { LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaModelo } from "./adapter"

/**
 * Modelo simulado: misma interfaz que Gemini, pero decide con reglas fijas (sin LLM y sin costo).
 * Sirve para probar el ciclo, para usar la app sin clave (con aviso visible) y para demostrar que
 * cambiar de proveedor no toca el ciclo. Entiende "procesa la solicitud sol-004",
 * "no la crees hasta que confirme" y "confirmo".
 */

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }
interface Construido {
  payload: OrdenCompra
  ruta_trazabilidad: string
}
interface Creado {
  numero_oc: string
  idempotente: boolean
  evidencia_pdf: string
}
type Decision = { llamada: Omit<LlamadaHerramienta, "id"> } | { texto: string }

const AYUDA = "Indícame la solicitud a procesar, por ejemplo: «procesa la solicitud sol-001». (Modo simulado: respondo con reglas fijas, sin modelo de lenguaje.)"

export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "reglas-deterministas"
  private contador = 0

  async enviar(mensajes: Mensaje[]): Promise<RespuestaModelo> {
    const indice = mensajes.findLastIndex((m) => m.rol === "usuario")
    const ultimo = mensajes[indice]
    const texto = ultimo?.rol === "usuario" ? ultimo.texto : ""
    const decision = decidir(texto, mensajes.slice(0, Math.max(indice, 0)), resultadosPorHerramienta(mensajes.slice(indice + 1)))
    const uso = { entrada: 0, salida: 0 }
    if ("texto" in decision) return { texto: decision.texto, llamadas: [], uso }
    this.contador += 1
    return { texto: "", llamadas: [{ id: `sim-${this.contador}`, ...decision.llamada }], uso }
  }
}

function decidir(texto: string, previos: Mensaje[], r: Map<string, Respuesta<unknown>>): Decision {
  const pendiente = ultimoPayload(previos)
  const confirma = esAfirmacion(texto) && pendiente !== null && (casoEn(texto) ?? pendiente.caso) === pendiente.caso
  if (confirma && pendiente) {
    const creada = r.get("oc_crear") as Respuesta<Creado> | undefined
    if (!creada) return llamar("oc_crear", { caso: pendiente.caso, payload: pendiente.payload, confirmado: true })
    return { texto: creada.ok ? textoCreada(pendiente.caso, creada.data) : `No se creó la OC de ${pendiente.caso}: ${creada.error}` }
  }

  const caso = casoEn(texto)
  if (!caso) return { texto: AYUDA }
  const leer = r.get("oc_leer_paquete") as Respuesta<Paquete> | undefined
  if (!leer) return llamar("oc_leer_paquete", { caso })
  if (!leer.ok) return { texto: `No pude leer el paquete de ${caso}: ${leer.error}` }
  const validar = r.get("oc_validar") as Respuesta<Validacion & { orden_existente: string | null }> | undefined
  if (!validar) return llamar("oc_validar", { caso, paquete: leer.data })
  if (!validar.ok) return { texto: `No pude validar ${caso}: ${validar.error}` }
  const v = validar.data
  if (!v.apta) return { texto: textoBloqueos(caso, v) }
  if (!r.get("oc_generar_evidencia")) return llamar("oc_generar_evidencia", { caso })
  const construido = r.get("oc_construir_payload") as Respuesta<Construido> | undefined
  if (!construido) return llamar("oc_construir_payload", { caso, paquete: leer.data, derivados: v.derivados })
  if (!construido.ok) return { texto: `No pude construir la OC de ${caso}: ${construido.error}` }
  if (v.confirmaciones.length > 0 || pideEsperar(texto)) return { texto: textoPropuesta(caso, v, construido.data) }
  const creada = r.get("oc_crear") as Respuesta<Creado> | undefined
  if (!creada) return llamar("oc_crear", { caso, payload: construido.data.payload })
  return { texto: creada.ok ? `${textoPropuesta(caso, v, construido.data, false)}\n\n${textoCreada(caso, creada.data)}` : `No se creó la OC de ${caso}: ${creada.error}` }
}

// ── Lectura del historial ────────────────────────────────────────────────────────────────────

/** Último resultado de cada herramienta en el turno actual. */
function resultadosPorHerramienta(turno: Mensaje[]): Map<string, Respuesta<unknown>> {
  const mapa = new Map<string, Respuesta<unknown>>()
  for (const m of turno) if (m.rol === "herramienta") mapa.set(m.nombre, JSON.parse(m.resultado) as Respuesta<unknown>)
  return mapa
}

/** El último payload construido en turnos anteriores (lo que se confirmaría con "confirmo"). */
function ultimoPayload(previos: Mensaje[]): { caso: string; payload: OrdenCompra } | null {
  const casos = new Map<string, string>()
  let ultimo: { caso: string; payload: OrdenCompra } | null = null
  for (const m of previos) {
    if (m.rol === "asistente") for (const l of m.llamadas) if (typeof l.argumentos.caso === "string") casos.set(l.id, l.argumentos.caso)
    if (m.rol === "herramienta" && m.nombre === "oc_construir_payload") {
      const r = JSON.parse(m.resultado) as Respuesta<Construido>
      const caso = casos.get(m.idLlamada)
      if (r.ok && caso) ultimo = { caso, payload: r.data.payload }
    }
    if (m.rol === "herramienta" && m.nombre === "oc_crear" && (JSON.parse(m.resultado) as Respuesta<Creado>).ok) ultimo = null
  }
  return ultimo
}

function casoEn(texto: string): string | null {
  return /\bsol-\d{3}\b/i.exec(texto)?.[0].toLowerCase() ?? null
}

function esAfirmacion(texto: string): boolean {
  const t = normalizarTexto(texto)
  return !/\bno\b/.test(t) && /\b(si|confirmo|confirmado|procede|adelante|creala|dale|ok)\b/.test(t)
}

function pideEsperar(texto: string): boolean {
  return /no la crees|no crees|no la crear|sin crear|hasta que (yo )?(lo )?confirme|todavia no/.test(normalizarTexto(texto))
}

function llamar(nombre: string, argumentos: Record<string, unknown>): Decision {
  return { llamada: { nombre, argumentos } }
}

// ── Textos de respuesta (Markdown) ───────────────────────────────────────────────────────────

const celda = (t: string | number) => String(t).replace(/\|/g, "\\|").replace(/\n/g, " ")

function lista(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => `- **${h.codigo} · ${h.regla}:** ${h.detalle}\n  - Acción sugerida: ${h.accion_sugerida}`).join("\n")
}

function textoBloqueos(caso: string, v: Validacion): string {
  return [`**${caso} (${v.solicitud_id}) no es apta: no se crea la OC.**`, "", "Bloqueos:", lista(v.bloqueos)].join("\n")
}

function textoPropuesta(caso: string, v: Validacion, c: Construido, preguntar = true): string {
  const o = c.payload
  const filas = o.posiciones.map((p) => `| ${p.numero} | ${celda(p.descripcion)} | ${p.cantidad} ${p.unidad} | ${formatoMonto(p.precio_unitario)} | ${p.centro_costo} / ${celda(p.subarea)} | ${p.indicador_iva} |`)
  const pasaron = v.controles.filter((x) => x.estado === "ok").map((x) => x.codigo)
  const partes = [
    `**OC propuesta para ${caso} (${o.referencia.solicitud_id})**`,
    "",
    `Proveedor ${o.proveedor.codigo_sap} · ${celda(o.proveedor.nombre)} (NIT ${o.proveedor.nit}) · ${o.moneda} · pago ${o.condiciones_pago} · aprobó ${o.aprobador.email}`,
    "",
    "| Pos. | Texto breve | Cantidad | Precio unitario | Centro / subárea | IVA |",
    "|---|---|---|---|---|---|",
    ...filas,
    "",
    `Validaciones que pasaron: ${pasaron.join(", ") || "ninguna"}. Trazabilidad: ${c.ruta_trazabilidad}.`,
  ]
  for (const d of Object.values(v.derivados)) partes.push(`Derivado de maestros (${d.regla}): ${d.valor}, ${d.detalle}.`)
  if (v.confirmaciones.length > 0) partes.push("", "Requiere tu confirmación:", lista(v.confirmaciones))
  if (preguntar) partes.push("", `¿Confirmas la creación de la OC de ${caso}? Responde «confirmo» para crearla.`)
  return partes.join("\n")
}

function textoCreada(caso: string, c: Creado): string {
  const idem = c.idempotente ? " (ya existía: no se creó otra)" : ""
  return `✔ OC **${c.numero_oc}** para ${caso}${idem}. Evidencia: ${c.evidencia_pdf}.`
}
