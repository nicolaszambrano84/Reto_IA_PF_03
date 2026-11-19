import path from "node:path"
import type { z } from "zod"
import { PATRON_APROBADO, PATRONES_NEGACION } from "./configuracion"
import {
  AprobacionArchivoSchema,
  CorreoArchivoSchema,
  describirProblemas,
  SolicitudSchema,
  type AprobacionArchivo,
  type Paquete,
} from "./esquemas"
import { carpetaCaso, leerJsonOpcional, leerTextoOpcional } from "./rutas"
import { extraerCorreo, normalizarNit, normalizarTexto, parsearMonto, sumarDias } from "./texto"
import { ErrorNegocio } from "./tipos"

/**
 * HU-1: lee el correo y sus adjuntos y los normaliza (PRD §7.2).
 * - Falta el correo o la solicitud → error legible: sin ellos no hay nada que procesar (HU-6).
 * - Falta un adjunto (cotización, aprobación, factura) → null y se nombra en `faltantes`.
 * - Un documento ilegible (JSON malformado, monto no numérico) → error legible con qué pedir.
 */

const DOCUMENTOS = {
  correo: { archivo: "correo.json", nombre: "el correo de la solicitud" },
  solicitud: { archivo: "solicitud.json", nombre: "el Excel de solicitud (solicitud.xlsx)" },
  cotizacion: { archivo: "cotizacion.txt", nombre: "la cotización del proveedor (cotizacion.pdf)" },
  aprobacion: { archivo: "aprobacion.json", nombre: "el correo de aprobación del líder (aprobacion.eml)" },
  factura: { archivo: "factura.txt", nombre: "la factura (factura.pdf)" },
} as const
type Documento = keyof typeof DOCUMENTOS

export async function leerPaquete(directory: string, caso: string): Promise<Paquete> {
  const carpeta = await carpetaCaso(directory, caso)
  const [correoCrudo, solicitudCruda] = await Promise.all([leerJson(carpeta, "correo"), leerJson(carpeta, "solicitud")])
  const ausentes = presentes([correoCrudo === null && DOCUMENTOS.correo.nombre, solicitudCruda === null && DOCUMENTOS.solicitud.nombre])
  if (ausentes.length > 0) {
    throw new ErrorNegocio(`Paquete incompleto en ${caso}: falta ${ausentes.join(" y ")}. Pide al solicitante que lo reenvíe; sin ese documento no se puede procesar.`)
  }

  const correo = validarDocumento(CorreoArchivoSchema, correoCrudo, "correo")
  const solicitud = validarDocumento(SolicitudSchema, sinCamposVacios(solicitudCruda), "solicitud")
  const [cotizacion, aprobacion, factura] = await Promise.all([leerCotizacion(carpeta), leerAprobacion(carpeta), leerFactura(carpeta)])

  const adjuntos = (correo.adjuntos ?? []).map((a) => a.toLowerCase())
  const faltantes = presentes([
    cotizacion === null && DOCUMENTOS.cotizacion.nombre,
    aprobacion === null && DOCUMENTOS.aprobacion.nombre,
    factura === null && adjuntos.some((a) => a.startsWith("factura")) && DOCUMENTOS.factura.nombre,
  ])

  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion,
    aprobacion,
    factura,
    faltantes,
  }
}

/** Correo de aprobación tal como llegó (para la evidencia). Null si no existe. */
export async function leerAprobacionArchivo(directory: string, caso: string): Promise<AprobacionArchivo | null> {
  const crudo = await leerJson(await carpetaCaso(directory, caso), "aprobacion")
  return crudo === null ? null : validarDocumento(AprobacionArchivoSchema, crudo, "aprobacion")
}

/** RC2: el cuerpo dice "Aprobado" y no lo niega ("No aprobado", "rechazado"…). */
export function contieneAprobacion(cuerpo: string): boolean {
  const texto = normalizarTexto(cuerpo)
  return PATRON_APROBADO.test(texto) && !PATRONES_NEGACION.some((p) => p.test(texto))
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const proveedor = /^Proveedor:\s*(.+)$/m.exec(texto)?.[1]?.trim()
  const total = /^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/m.exec(texto)
  const monto = total?.[2] ? parsearMonto(total[2]) : null
  if (!proveedor || !total?.[1] || monto === null) {
    const falta = proveedor ? "un TOTAL numérico" : "el nombre del proveedor"
    throw new ErrorNegocio(`cotizacion.txt no tiene ${falta} legible. Pide al proveedor una cotización formal con proveedor, NIT y total.`)
  }
  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m.exec(texto)?.[1] ?? null
  const dias = /^Validez de la oferta:\s*(\d+)\s*d[ií]as/im.exec(texto)?.[1]
  return {
    proveedor,
    nit: normalizarNit(/^NIT:\s*([\d.-]+)/m.exec(texto)?.[1]),
    total: monto,
    moneda: total[1],
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
    numero: /^COTIZACI[ÓOóo]N\s+(\S+)/m.exec(texto)?.[1] ?? null,
    fecha,
  }
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> {
  const numero = /\bNo\.\s*([A-Z0-9][A-Z0-9-]*)/.exec(texto)?.[1]
  const fecha = /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  const total = /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m.exec(texto)?.[1]
  const monto = total ? parsearMonto(total) : null
  if (!numero || !fecha || monto === null) {
    throw new ErrorNegocio("factura.txt no tiene número, fecha de emisión y total legibles. Pide al solicitante la factura completa.")
  }
  return { numero, fecha, total: monto }
}

async function leerCotizacion(carpeta: string): Promise<Paquete["cotizacion"]> {
  const texto = await leerTextoOpcional(path.join(carpeta, DOCUMENTOS.cotizacion.archivo))
  return texto === null ? null : parsearCotizacion(texto)
}

async function leerFactura(carpeta: string): Promise<Paquete["factura"]> {
  const texto = await leerTextoOpcional(path.join(carpeta, DOCUMENTOS.factura.archivo))
  return texto === null ? null : parsearFactura(texto)
}

async function leerAprobacion(carpeta: string): Promise<Paquete["aprobacion"]> {
  const crudo = await leerJson(carpeta, "aprobacion")
  if (crudo === null) return null
  const a = validarDocumento(AprobacionArchivoSchema, crudo, "aprobacion")
  return { de: extraerCorreo(a.de), fecha: a.fecha, aprobado: contieneAprobacion(a.cuerpo), texto: a.cuerpo }
}

/** Lee un JSON del caso; si está malformado, el error dice qué pedir al solicitante. */
async function leerJson(carpeta: string, doc: Documento): Promise<unknown> {
  try {
    return await leerJsonOpcional(path.join(carpeta, DOCUMENTOS[doc].archivo))
  } catch (e) {
    if (e instanceof ErrorNegocio) throw new ErrorNegocio(`${e.message} Pide al solicitante reenviar ${DOCUMENTOS[doc].nombre}.`)
    throw e
  }
}

function validarDocumento<T>(esquema: z.ZodType<T>, valor: unknown, doc: Documento): T {
  const resultado = esquema.safeParse(valor)
  if (resultado.success) return resultado.data
  const { archivo, nombre } = DOCUMENTOS[doc]
  throw new ErrorNegocio(`${archivo} no tiene el formato esperado: ${describirProblemas(resultado.error)}. Pide al solicitante corregir y reenviar ${nombre}.`)
}

/** Deja solo los textos de una lista de "texto o false". */
function presentes(lista: Array<string | false>): string[] {
  return lista.filter((x): x is string => x !== false)
}

/** Una celda vacía del Excel llega como "" o null: se trata como campo ausente. */
function sinCamposVacios(valor: unknown): unknown {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) return valor
  return Object.fromEntries(Object.entries(valor).filter(([, v]) => v !== null && v !== ""))
}
