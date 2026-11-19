/**
 * Exclusión mutua dentro del proceso: las operaciones con la misma clave se ejecutan una tras otra.
 * Evita que dos peticiones simultáneas (p. ej. un doble clic) creen dos OC o repitan un número.
 * En producción la garantía final la da SAP (referencia única); esto cubre el SAP simulado.
 */
const colas = new Map<string, Promise<void>>()

export async function conCandado<T>(clave: string, operacion: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve()
  let liberar: () => void = () => {}
  const turno = new Promise<void>((resolver) => {
    liberar = resolver
  })
  const cola = anterior.then(() => turno)
  colas.set(clave, cola)
  await anterior
  try {
    return await operacion()
  } finally {
    liberar()
    if (colas.get(clave) === cola) colas.delete(clave)
  }
}
