import { z } from "zod"
import { crearSap } from "../sap/fabrica"
import { OrdenCompraSchema } from "../sap/orden"
import { conCandado } from "./lib/candado"
import { registrarControl, type FilaControl } from "./lib/control"
import { ejecutar, type Exito } from "./lib/ejecucion"
import { DerivadosSchema, PaqueteSchema } from "./lib/esquemas"
import { calcularEvidencia, generarEvidencia } from "./lib/evidencia"
import { codigos, evaluarCaso, exigirIgual } from "./lib/flujo"
import { ignorarConfirmadoPor, ignorarTextosLibres } from "./lib/integridad"
import { leerPaquete } from "./lib/paquete"
import { construirOrden, exigirApta } from "./lib/payload"
import type { Validacion } from "./lib/reglas"
import { CasoSchema, escribirJson } from "./lib/rutas"
import { formatoMonto } from "./lib/texto"
import { ErrorNegocio, herramienta, identificadorSesion } from "./lib/tipos"

/**
 * Herramientas del agente (contrato del PRD §6.2). Cada export se ve en el modelo como `oc_<export>`.
 * Son la única fuente de valores que el agente puede afirmar. Cada una recalcula desde los archivos
 * del caso: lo que llega del modelo (paquete, derivados, payload) solo se acepta si coincide.
 */

const caso = CasoSchema.describe("Carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-001")
const paquete = PaqueteSchema.describe("Paquete exactamente como lo devolvió oc_leer_paquete, sin modificar")

// ── oc_leer_paquete (HU-1) ───────────────────────────────────────────────────────────────────

const argsLeerPaquete = { caso }

export const leer_paquete = herramienta({
  description:
    "Lee el correo de un caso y sus adjuntos (solicitud, cotización, aprobación y factura) y los devuelve normalizados; lo que falte queda en null.",
  args: argsLeerPaquete,
  execute: (args, ctx) =>
    ejecutar("oc_leer_paquete", argsLeerPaquete, args, ctx, async ({ caso }) => {
      const p = await leerPaquete(ctx.directory, caso)
      const adjuntos = p.faltantes.length ? `faltan: ${p.faltantes.join(", ")}` : "adjuntos completos"
      return { data: p, resumen: `${p.solicitud.solicitud_id} · ${p.solicitud.proveedor_nombre} · ${p.solicitud.moneda} ${formatoMonto(p.solicitud.valor_total)} · ${adjuntos}` }
    }),
})

// ── oc_validar (HU-2) ────────────────────────────────────────────────────────────────────────

const argsValidar = { caso, paquete }

export const validar = herramienta({
  description:
    "Valida el paquete contra los maestros y las reglas RC1–RC10: indica si la OC es apta, qué la bloquea, qué requiere confirmación humana y qué valores se completaron desde los maestros.",
  args: argsValidar,
  execute: (args, ctx) =>
    ejecutar("oc_validar", argsValidar, args, ctx, async ({ caso, paquete }) => {
      const sap = crearSap(ctx.directory)
      const { paquete: fuente, validacion: v } = await evaluarCaso(ctx.directory, caso, sap)
      exigirIgual("paquete", fuente, paquete, ignorarTextosLibres)
      const existente = await sap.buscarOrdenPorReferencia(v.solicitud_id)
      // Un intento que se detiene en la validación también queda en el log de control.
      if (!existente && (!v.apta || v.confirmaciones.length > 0)) {
        await registrarControl(ctx.directory, { ...filaBase(v), resultado: v.apta ? "pendiente" : "bloqueada", numero_oc: null })
      }
      return { data: { ...v, orden_existente: existente?.numero_oc ?? null }, resumen: resumenValidacion(v) }
    }),
})

// ── oc_generar_evidencia (HU-4) ──────────────────────────────────────────────────────────────

const argsEvidencia = { caso }

export const generar_evidencia = herramienta({
  description: "Genera la evidencia del correo de aprobación (out/<caso>/aprobacion.txt y aprobacion.pdf) con la huella SHA-256 de su contenido.",
  args: argsEvidencia,
  execute: (args, ctx) =>
    ejecutar("oc_generar_evidencia", argsEvidencia, args, ctx, async ({ caso }) => {
      const r = await generarEvidencia(ctx.directory, caso)
      return { data: r, resumen: `${r.ruta} y ${r.ruta_pdf} · sha256 ${r.sha256.slice(0, 12)}…` }
    }),
})

// ── oc_construir_payload (HU-3) ──────────────────────────────────────────────────────────────

const argsConstruir = {
  caso,
  paquete,
  derivados: DerivadosSchema.describe("Derivados exactamente como los devolvió oc_validar"),
}

export const construir_payload = herramienta({
  description:
    "Construye la orden de compra tal como quedaría en SAP (validada con su esquema) y guarda de dónde salió cada valor en out/<caso>/trazabilidad.json; no crea nada.",
  args: argsConstruir,
  execute: (args, ctx) =>
    ejecutar("oc_construir_payload", argsConstruir, args, ctx, async ({ caso, paquete, derivados }) => {
      const { paquete: fuente, validacion: v } = await evaluarCaso(ctx.directory, caso, crearSap(ctx.directory))
      exigirIgual("paquete", fuente, paquete, ignorarTextosLibres)
      exigirIgual("derivados", v.derivados, derivados)
      exigirApta(v)
      const evidencia = await calcularEvidencia(ctx.directory, caso)
      const { orden, trazabilidad } = construirOrden(caso, fuente, v, evidencia.sha256)
      const ruta = await escribirJson(ctx.directory, [caso, "trazabilidad.json"], trazabilidad)
      return {
        data: {
          payload: orden,
          ruta_trazabilidad: ruta,
          fuentes: Object.fromEntries(trazabilidad.campos.map((c) => [c.campo, c.fuente])),
          confirmaciones_pendientes: codigos(v.confirmaciones),
        },
        resumen: `${v.solicitud_id}: payload listo · trazabilidad en ${ruta}`,
      }
    }),
})

// ── oc_crear (HU-5) ──────────────────────────────────────────────────────────────────────────

const argsCrear = {
  caso,
  payload: OrdenCompraSchema.describe("Payload exactamente como lo devolvió oc_construir_payload"),
  confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
}

export const crear = herramienta({
  description:
    "Crea la OC en SAP solo si la solicitud es apta y, cuando hay excepciones, solo con confirmado=true; si ya existe una OC para la solicitud, devuelve esa misma (idempotente).",
  args: argsCrear,
  execute: (args, ctx) =>
    ejecutar("oc_crear", argsCrear, args, ctx, async ({ caso, payload, confirmado }) => {
      const sap = crearSap(ctx.directory)
      const { paquete: fuente, validacion: v } = await evaluarCaso(ctx.directory, caso, sap)
      const control = (resultado: FilaControl["resultado"], numero_oc: string | null = null, bloqueos = codigos(v.bloqueos)) =>
        registrarControl(ctx.directory, { ...filaBase(v), resultado, numero_oc, bloqueos })

      // 1. La herramienta revalida: no confía en lo que el modelo crea que pasó antes.
      if (!v.apta) {
        await control("bloqueada")
        throw new ErrorNegocio(`No se crea la OC de ${v.solicitud_id}: ${v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join(" ")}`)
      }
      // 2. Integridad: el payload debe ser exactamente el que se construyó desde las fuentes.
      const evidencia = await generarEvidencia(ctx.directory, caso)
      const { orden } = construirOrden(caso, fuente, v, evidencia.sha256)
      try {
        exigirIgual("payload", orden, payload, ignorarConfirmadoPor)
      } catch (e) {
        await control("bloqueada", null, ["INTEGRIDAD"])
        throw e
      }

      return conCandado(`oc:${v.solicitud_id}`, async (): Promise<Exito<ResultadoCreacion>> => {
        // 3. Idempotencia: la misma solicitud nunca genera una segunda OC.
        const existente = await sap.buscarOrdenPorReferencia(v.solicitud_id)
        if (existente) {
          await control("existente", existente.numero_oc)
          return {
            data: { numero_oc: existente.numero_oc, fecha: null, idempotente: true, evidencia: evidencia.ruta, evidencia_pdf: evidencia.ruta_pdf },
            resumen: `OC ${existente.numero_oc} ya existía (idempotente)`,
          }
        }
        // 4. Confirmación humana: con excepciones, solo se crea con confirmado=true.
        if (v.confirmaciones.length > 0 && confirmado !== true) {
          await control("pendiente")
          const lista = v.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" ")
          throw new ErrorNegocio(`Pendiente de confirmación, no se creó la OC. ${lista} Pregunta al usuario y vuelve a llamar con confirmado=true solo si lo confirma explícitamente.`)
        }
        const quien = `analista (sesión ${identificadorSesion(ctx)})`
        const final = { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: quien })) }
        const creada = await sap.crearOrden(final)
        await control("creada", creada.numero_oc)
        return {
          data: {
            numero_oc: creada.numero_oc,
            fecha: creada.fecha,
            idempotente: false,
            evidencia: evidencia.ruta,
            evidencia_pdf: evidencia.ruta_pdf,
            excepciones_confirmadas: codigos(v.confirmaciones),
            retroactiva: v.retroactiva,
          },
          resumen: `OC ${creada.numero_oc} creada para ${v.solicitud_id}`,
        }
      })
    }),
})

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────

/** Salida de oc_crear (PRD §6.2: numero_oc, fecha, idempotente) más la ruta de la evidencia. */
interface ResultadoCreacion {
  numero_oc: string
  /** Fecha de creación en SAP; null cuando la OC ya existía (SAP solo devuelve el número). */
  fecha: string | null
  idempotente: boolean
  evidencia: string
  evidencia_pdf: string
  excepciones_confirmadas?: string[]
  retroactiva?: boolean
}

function filaBase(v: Validacion): Omit<FilaControl, "resultado" | "numero_oc"> {
  return { solicitud_id: v.solicitud_id, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones) }
}

function resumenValidacion(v: Validacion): string {
  const bloqueos = codigos(v.bloqueos).join(", ") || "ninguno"
  const confirmaciones = codigos(v.confirmaciones).join(", ") || "ninguna"
  const estado = v.apta ? "apta" : "NO apta"
  return `${v.solicitud_id}: ${estado} · bloqueos: ${bloqueos} · confirmaciones: ${confirmaciones}${v.retroactiva ? " · retroactiva" : ""}`
}
