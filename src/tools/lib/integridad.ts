/**
 * Integridad de datos en tránsito: el modelo pasa de una herramienta a otra el paquete, los derivados
 * y el payload. Cada herramienta los recalcula desde las fuentes y compara: si el modelo cambió un
 * valor (por error o por manipulación), se detecta aquí y no se usa (riesgo del PRD §10).
 */

/** Rutas donde `recibido` difiere de `esperado` (comparación profunda; `ignorar` excluye rutas). */
export function diferencias(esperado: unknown, recibido: unknown, ignorar: (ruta: string) => boolean = () => false, ruta = ""): string[] {
  if (ignorar(ruta)) return []
  if (Array.isArray(esperado) && Array.isArray(recibido)) {
    if (esperado.length !== recibido.length) return [`${ruta || "(raíz)"} (cantidad de elementos)`]
    return esperado.flatMap((e: unknown, i) => diferencias(e, recibido[i], ignorar, `${ruta}[${i}]`))
  }
  if (esObjeto(esperado) && esObjeto(recibido)) {
    const claves = [...new Set([...Object.keys(esperado), ...Object.keys(recibido)])]
    return claves.flatMap((k) => diferencias(esperado[k], recibido[k], ignorar, ruta ? `${ruta}.${k}` : k))
  }
  return Object.is(esperado, recibido) ? [] : [ruta || "(raíz)"]
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}

/** El texto libre (cotización, correo) no decide nada: siempre se usa el de la fuente, así que no se compara. */
export const ignorarTextosLibres = (ruta: string): boolean => ruta.endsWith(".texto")

/** Quién confirmó lo completa oc_crear con la sesión; lo que diga el modelo se ignora. */
export const ignorarConfirmadoPor = (ruta: string): boolean => /^excepciones\[\d+\]\.confirmado_por$/.test(ruta)
