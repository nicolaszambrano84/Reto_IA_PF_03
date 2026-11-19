import { OrdenCompraSchema, type OrdenCompra, type Unidad } from "../../sap/orden"
import { CONFIG } from "./configuracion"
import { describirProblemas, type Paquete } from "./esquemas"
import type { Validacion } from "./reglas"
import { normalizarTexto, recortarDescripcion } from "./texto"
import { ErrorNegocio } from "./tipos"

/**
 * HU-3: arma la orden de compra (PRD §7.4) y, a la vez, la trazabilidad de cada valor.
 * Cada campo se escribe con t(campo, valor, fuente, origen): es imposible poner un valor sin decir
 * de dónde salió. Las fuentes `correo` y `aprobacion` amplían la lista del PRD (ver SOLUCION.md).
 */

export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | "maestro.proveedores" | "derivado"

export interface Rastro {
  campo: string
  valor: string | number | null
  fuente: Fuente
  origen: string
  transformacion?: string
}

export interface Trazabilidad {
  caso: string
  solicitud_id: string
  campos: Rastro[]
}

interface ValorConFuente {
  valor: string
  fuente: Fuente
  origen: string
}

/** Solo se construye el payload de una solicitud apta. */
export function exigirApta(v: Validacion): void {
  if (!v.apta) {
    const motivos = v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join(" ")
    throw new ErrorNegocio(`La solicitud ${v.solicitud_id} no es apta, no se construye la OC. ${motivos}`)
  }
}

export function construirOrden(caso: string, paquete: Paquete, v: Validacion, evidenciaSha256: string): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  exigirApta(v)
  const proveedor = v.proveedor
  const aprobacion = paquete.aprobacion
  if (!proveedor || !aprobacion) throw new ErrorNegocio("Falta el proveedor o la aprobación validados; no se construye la OC.")
  const s = paquete.solicitud
  const campos: Rastro[] = []
  const t = <V extends string | number | null>(campo: string, valor: V, fuente: Fuente, origen: string, transformacion?: string): V => {
    campos.push({ campo, valor, fuente, origen, ...(transformacion ? { transformacion } : {}) })
    return valor
  }

  const delMaestro = `proveedores.json, NIT ${proveedor.nit}`
  const constante = "constante organizacional (src/knowledge/reglas.json)"
  const iva: ValorConFuente = s.indicador_iva
    ? { valor: s.indicador_iva, fuente: "solicitud", origen: "solicitud.json → indicador_iva" }
    : { valor: v.derivados.indicador_iva?.valor ?? "", fuente: "maestro.proveedores", origen: `${delMaestro} → indicador_iva_default (RC6)` }
  const pago: ValorConFuente = s.condiciones_pago
    ? { valor: s.condiciones_pago, fuente: "solicitud", origen: "solicitud.json → condiciones_pago" }
    : { valor: v.derivados.condiciones_pago?.valor ?? "", fuente: "maestro.proveedores", origen: `${delMaestro} → condiciones_pago_default (RC7)` }
  const max = CONFIG.sap.max_descripcion
  const descripcion = recortarDescripcion(s.descripcion, max)
  const unidad = derivarUnidad(s.descripcion, s.cantidad, paquete.cotizacion?.texto ?? null)
  const cotizacion = paquete.cotizacion

  const orden = {
    referencia: {
      solicitud_id: t("referencia.solicitud_id", s.solicitud_id, "solicitud", "solicitud.json → solicitud_id"),
      correo_id: t("referencia.correo_id", paquete.correo.id, "correo", "correo.json → id"),
      cotizacion_ref: cotizacion
        ? t("referencia.cotizacion_ref", cotizacion.numero, "cotizacion", "cotizacion.txt → número del encabezado")
        : t("referencia.cotizacion_ref", null, "derivado", "no llegó cotización (RC5)"),
    },
    sociedad: t("sociedad", CONFIG.organizacion.sociedad, "derivado", constante),
    organizacion_compras: t("organizacion_compras", CONFIG.organizacion.organizacion_compras, "derivado", constante),
    proveedor: {
      codigo_sap: t("proveedor.codigo_sap", proveedor.codigo_sap, "maestro.proveedores", delMaestro),
      nit: t("proveedor.nit", proveedor.nit, "maestro.proveedores", delMaestro),
      nombre: t("proveedor.nombre", proveedor.nombre, "maestro.proveedores", delMaestro),
    },
    moneda: t("moneda", s.moneda, "solicitud", "solicitud.json → moneda"),
    condiciones_pago: t("condiciones_pago", pago.valor, pago.fuente, pago.origen),
    aprobador: {
      email: t("aprobador.email", aprobacion.de, "aprobacion", "aprobacion.json → de"),
      fecha_aprobacion: t("aprobador.fecha_aprobacion", aprobacion.fecha, "aprobacion", "aprobacion.json → fecha"),
      evidencia_sha256: t("aprobador.evidencia_sha256", evidenciaSha256, "derivado", `SHA-256 del contenido de out/${caso}/aprobacion.txt`),
    },
    posiciones: [
      {
        numero: t("posiciones[0].numero", CONFIG.sap.paso_posicion, "derivado", "convención SAP: posiciones de 10 en 10"),
        descripcion: t(
          "posiciones[0].descripcion",
          descripcion,
          "solicitud",
          "solicitud.json → descripcion",
          descripcion !== s.descripcion ? `texto breve SAP de máximo ${max} caracteres; original: «${s.descripcion}»` : undefined,
        ),
        cantidad: t("posiciones[0].cantidad", s.cantidad, "solicitud", "solicitud.json → cantidad"),
        unidad: t("posiciones[0].unidad", unidad.valor, "derivado", unidad.origen),
        precio_unitario: t("posiciones[0].precio_unitario", s.valor_unitario, "solicitud", "solicitud.json → valor_unitario (IVA incluido, como en la cotización)"),
        centro_costo: t("posiciones[0].centro_costo", s.centro_costo, "solicitud", "solicitud.json → centro_costo (validado con centros-costo.json)"),
        subarea: t("posiciones[0].subarea", s.subarea, "solicitud", "solicitud.json → subarea (validada con centros-costo.json)"),
        indicador_iva: t("posiciones[0].indicador_iva", iva.valor, iva.fuente, iva.origen),
      },
    ],
    excepciones: v.confirmaciones.map((h, i) => ({
      codigo: t(`excepciones[${i}].codigo`, h.codigo, "derivado", `oc_validar → ${h.codigo}`),
      detalle: t(`excepciones[${i}].detalle`, h.detalle, "derivado", `oc_validar → ${h.codigo}`),
      confirmado_por: t(`excepciones[${i}].confirmado_por`, null, "derivado", "se completa cuando la analista confirma (oc_crear)"),
    })),
  }

  const validada = OrdenCompraSchema.safeParse(orden)
  if (!validada.success) throw new ErrorNegocio(`La OC no cumple el esquema de SAP: ${describirProblemas(validada.error)}.`)
  return { orden: validada.data, trazabilidad: { caso, solicitud_id: s.solicitud_id, campos } }
}

/**
 * Unidad de medida (no viene en la solicitud). Solo es H o MES si la descripción dice
 * "<cantidad> horas/meses" o si el ítem de la cotización empieza con esa palabra. Así "vigencia
 * 12 meses" con cantidad 120 (licencias) queda en UN y "100 horas" con cantidad 100 queda en H.
 */
export function derivarUnidad(descripcion: string, cantidad: number, textoCotizacion: string | null): { valor: Unidad; origen: string } {
  const texto = normalizarTexto(descripcion)
  const numero = String(cantidad).replace(".", "[.,]")
  for (const [unidad, palabras] of unidadesConfiguradas()) {
    const palabra = palabras.find((p) => new RegExp(`\\b${numero}\\s+${escaparRegex(p)}\\b`).test(texto))
    if (palabra) return { valor: unidad, origen: `la descripción dice «${cantidad} ${palabra}»` }
  }
  const item = textoCotizacion ? /^\s*1\.\s*([^|\n]+)/m.exec(textoCotizacion)?.[1]?.trim() : undefined
  const primeraPalabra = item ? normalizarTexto(item).split(" ")[0] : undefined
  for (const [unidad, palabras] of unidadesConfiguradas()) {
    if (primeraPalabra && palabras.includes(primeraPalabra)) return { valor: unidad, origen: `el ítem de la cotización empieza por «${item?.split(" ")[0]}»` }
  }
  const defecto = CONFIG.unidades.por_defecto
  return { valor: defecto, origen: `la descripción no dice «${cantidad} horas» ni «${cantidad} meses» → ${defecto}` }
}

function unidadesConfiguradas(): Array<[Unidad, string[]]> {
  return [
    ["H", CONFIG.unidades.palabras.H],
    ["MES", CONFIG.unidades.palabras.MES],
  ]
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
