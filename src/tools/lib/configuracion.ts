import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * Carga src/knowledge/reglas.json (parámetros de negocio) y lo valida al arrancar.
 * Si alguien rompe el archivo, el proceso no arranca: es preferible a operar con reglas corruptas.
 */

/** Acciones sugeridas que el código usa. Si falta alguna en el JSON, la carga falla. */
const ACCIONES_REQUERIDAS = {
  RC1: ["inexistente", "homonimo", "inactivo"],
  RC2: ["sin_aprobacion", "no_aprobado", "no_autorizado"],
  RC3: ["excede", "sin_atribucion", "sin_tope_en_centro"],
  RC4: ["centro_inexistente", "subarea"],
  RC5: ["diferencia", "sin_cotizacion", "moneda"],
  RC6: ["derivado"],
  RC7: ["derivado"],
  RC8: ["retroactiva"],
  RC9: ["anterior", "ilegible"],
  RC10: ["incoherente"],
  RX1: ["invalido"],
  RX2: ["invalido"],
  RX3: ["distinto"],
} as const

export type CodigoControl = keyof typeof ACCIONES_REQUERIDAS
export const CODIGOS_CONTROL = Object.keys(ACCIONES_REQUERIDAS) as CodigoControl[]

const expresionRegular = z.string().refine((patron) => {
  try {
    new RegExp(patron)
    return true
  } catch {
    return false
  }
}, "expresión regular inválida")

const ConfiguracionSchema = z
  .object({
    descripcion: z.string(),
    organizacion: z.object({ sociedad: z.literal("1000"), organizacion_compras: z.literal("1000") }),
    sap: z.object({
      numero_oc_inicial: z.number().int().positive(),
      max_descripcion: z.number().int().min(10),
      paso_posicion: z.number().int().positive(),
    }),
    tolerancias: z.object({ cotizacion_pct: z.number().min(0), redondeo_total: z.number().min(0) }),
    aprobacion: z.object({ patron_aprobado: expresionRegular, patrones_negacion: z.array(expresionRegular) }),
    unidades: z.object({
      por_defecto: z.enum(["UN", "H", "MES"]),
      palabras: z.object({ H: z.array(z.string().min(1)), MES: z.array(z.string().min(1)) }),
    }),
    controles: z.record(z.string(), z.object({ nombre: z.string().min(1), acciones: z.record(z.string(), z.string().min(1)) })),
  })
  .superRefine((config, ctx) => {
    for (const codigo of CODIGOS_CONTROL) {
      for (const clave of ACCIONES_REQUERIDAS[codigo]) {
        if (!config.controles[codigo]?.acciones[clave]) {
          ctx.addIssue({ code: "custom", path: ["controles", codigo, "acciones", clave], message: "falta esta acción sugerida" })
        }
      }
    }
  })

export type Configuracion = z.infer<typeof ConfiguracionSchema>

function cargarConfiguracion(): Configuracion {
  const ruta = new URL("../../knowledge/reglas.json", import.meta.url)
  const resultado = ConfiguracionSchema.safeParse(JSON.parse(readFileSync(ruta, "utf8")))
  if (!resultado.success) {
    const problemas = resultado.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`src/knowledge/reglas.json no es válido: ${problemas}`)
  }
  return resultado.data
}

export const CONFIG: Configuracion = cargarConfiguracion()

export const PATRON_APROBADO = new RegExp(CONFIG.aprobacion.patron_aprobado)
export const PATRONES_NEGACION = CONFIG.aprobacion.patrones_negacion.map((p) => new RegExp(p))

/** Nombre legible de un control (p. ej. "Proveedor registrado y activo"). */
export function nombreControl(codigo: CodigoControl): string {
  return CONFIG.controles[codigo]?.nombre ?? codigo
}

/** Acción sugerida para una excepción; la clave se verifica en compilación y al cargar el JSON. */
export function accion<C extends CodigoControl>(codigo: C, clave: (typeof ACCIONES_REQUERIDAS)[C][number]): string {
  return CONFIG.controles[codigo]?.acciones[clave] ?? ""
}
