import type { SapAdapter } from "../../sap/adapter"
import type { Paquete } from "./esquemas"
import { diferencias } from "./integridad"
import { cargarMaestros, type Maestros } from "./maestros"
import { leerPaquete } from "./paquete"
import { buscarProveedor, evaluar, type Hallazgo, type Validacion } from "./reglas"
import { ErrorNegocio } from "./tipos"

/** Pasos que comparten varias herramientas: leer las fuentes del caso y evaluarlas. */

export interface CasoEvaluado {
  paquete: Paquete
  maestros: Maestros
  validacion: Validacion
}

/** Lee el caso desde las fuentes (nunca desde lo que diga el modelo) y aplica las reglas. */
export async function evaluarCaso(directory: string, caso: string, sap: SapAdapter): Promise<CasoEvaluado> {
  const [paquete, maestros] = await Promise.all([leerPaquete(directory, caso), cargarMaestros(directory)])
  const busqueda = await buscarProveedor(paquete.solicitud, maestros, sap)
  return { paquete, maestros, validacion: evaluar(paquete, maestros, busqueda) }
}

/** Rechaza datos que el modelo alteró entre una herramienta y otra. */
export function exigirIgual(que: string, esperado: unknown, recibido: unknown, ignorar?: (ruta: string) => boolean): void {
  const difs = diferencias(esperado, recibido, ignorar)
  if (difs.length === 0) return
  const lista = difs.slice(0, 5).join(", ") + (difs.length > 5 ? "…" : "")
  throw new ErrorNegocio(
    `Los datos de «${que}» no coinciden con las fuentes del caso (${lista}). Por seguridad no se usan: vuelve a llamar a la herramienta anterior y pasa su resultado sin modificar.`,
  )
}

export function codigos(hallazgos: Hallazgo[]): string[] {
  return hallazgos.map((h) => h.codigo)
}
