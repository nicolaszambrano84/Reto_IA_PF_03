import type { SapAdapter } from "./adapter"
import { SapSimulado } from "./mock"

/**
 * Punto único donde se elige la implementación de SAP. Hoy siempre es el simulado; el adaptador
 * real (diseñado en SOLUCION.md) se conectaría aquí sin tocar las herramientas.
 */
export function crearSap(directory: string): SapAdapter {
  return new SapSimulado(directory)
}
