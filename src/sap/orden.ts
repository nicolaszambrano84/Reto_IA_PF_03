import { z } from "zod"

/**
 * Payload de la orden de compra (PRD §7.4): esquema simplificado inspirado en la API de órdenes de
 * compra de SAP. Es el contrato con SAP, por eso vive en esta capa y lo importan las herramientas.
 */

export const UNIDADES = ["UN", "H", "MES"] as const
export type Unidad = (typeof UNIDADES)[number]

export const PosicionSchema = z.object({
  numero: z.number().int().positive().describe("Número de posición: 10, 20, 30…"),
  descripcion: z.string().min(1).max(40).describe("Texto breve SAP, máximo 40 caracteres"),
  cantidad: z.number().positive().describe("Cantidad"),
  unidad: z.enum(UNIDADES).describe("Unidad de medida: UN, H o MES"),
  precio_unitario: z.number().nonnegative().describe("Precio unitario"),
  centro_costo: z.string().min(1).describe("Centro de costo, p. ej. CC-1010"),
  subarea: z.string().min(1).describe("Subárea del centro de costo"),
  indicador_iva: z.string().min(1).describe("Código de IVA, p. ej. C1"),
})

export const OrdenCompraSchema = z.object({
  referencia: z
    .object({
      solicitud_id: z.string().min(1).describe("Solicitud de origen"),
      correo_id: z.string().min(1).describe("Correo de origen"),
      cotizacion_ref: z.string().nullable().default(null).describe("Número de la cotización, o null si no hubo"),
    })
    .describe("Referencias de origen de la orden"),
  sociedad: z.literal("1000").describe("Sociedad SAP"),
  organizacion_compras: z.literal("1000").describe("Organización de compras SAP"),
  proveedor: z
    .object({
      codigo_sap: z.string().min(1).describe("Código del proveedor en SAP"),
      nit: z.string().min(1).describe("NIT del proveedor"),
      nombre: z.string().min(1).describe("Razón social según el maestro"),
    })
    .describe("Proveedor según el maestro"),
  moneda: z.enum(["COP", "USD"]).describe("Moneda de la orden"),
  condiciones_pago: z.string().min(1).describe("Código de condición de pago, p. ej. Z030"),
  aprobador: z
    .object({
      email: z.string().min(1).describe("Correo de quien aprobó"),
      fecha_aprobacion: z.string().min(1).describe("Fecha y hora de la aprobación"),
      evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/).describe("SHA-256 de la evidencia de aprobación"),
    })
    .describe("Aprobación y huella de su evidencia"),
  posiciones: z.array(PosicionSchema).min(1).describe("Posiciones de la orden"),
  excepciones: z
    .array(
      z.object({
        codigo: z.string().min(1).describe("Regla que originó la excepción, p. ej. RC5"),
        detalle: z.string().min(1).describe("Qué se encontró"),
        confirmado_por: z.string().nullable().default(null).describe("Quién confirmó; null mientras no se confirme"),
      }),
    )
    .default([])
    .describe("Excepciones que requieren confirmación humana"),
})

export type OrdenCompra = z.infer<typeof OrdenCompraSchema>
