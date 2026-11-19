import { z } from "zod"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  describirProblemas,
  IndicadorIvaSchema,
  ProveedorMaestroSchema,
  type CentroCosto,
  type CondicionPago,
  type IndicadorIva,
  type ProveedorMaestro,
} from "./esquemas"
import { leerJsonOpcional, rutaMaestro } from "./rutas"
import { ErrorNegocio } from "./tipos"

/** Maestros de SAP entregados como fixtures (en producción se consultarían en SAP en tiempo real). */
export interface Maestros {
  proveedores: ProveedorMaestro[]
  centros: CentroCosto[]
  indicadores: IndicadorIva[]
  condiciones: CondicionPago[]
}

export async function cargarMaestros(directory: string): Promise<Maestros> {
  const [proveedores, centros, indicadores, condiciones] = await Promise.all([
    leerMaestro(directory, "proveedores.json", z.array(ProveedorMaestroSchema)),
    leerMaestro(directory, "centros-costo.json", z.array(CentroCostoSchema)),
    leerMaestro(directory, "indicadores-iva.json", z.array(IndicadorIvaSchema)),
    leerMaestro(directory, "condiciones-pago.json", z.array(CondicionPagoSchema)),
  ])
  return { proveedores, centros, indicadores, condiciones }
}

async function leerMaestro<T>(directory: string, archivo: string, esquema: z.ZodType<T>): Promise<T> {
  const crudo = await leerJsonOpcional(rutaMaestro(directory, archivo))
  if (crudo === null) throw new ErrorNegocio(`Falta el maestro ${archivo} en fixtures/reto-03/maestros/.`)
  const resultado = esquema.safeParse(crudo)
  if (!resultado.success) throw new ErrorNegocio(`El maestro ${archivo} no tiene el formato esperado: ${describirProblemas(resultado.error)}`)
  return resultado.data
}
