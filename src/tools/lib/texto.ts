/** Utilidades de normalización de texto, montos, NIT y fechas. Funciones puras. */

/** Quita tildes y diacríticos: "Papelería" → "Papeleria". */
export function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** Minúsculas, sin tildes y con espacios simples. Para comparar textos escritos por personas. */
export function normalizarTexto(texto: string): string {
  return sinTildes(texto).toLowerCase().replace(/\s+/g, " ").trim()
}

/** Solo letras y números: "TecnoSuministros S.A.S." → "tecnosuministrossas". Para comparar nombres. */
export function normalizarNombre(texto: string): string {
  return normalizarTexto(texto).replace(/[^a-z0-9]/g, "")
}

/**
 * NIT base sin puntos ni dígito de verificación: "900.555.111-2" → "900555111".
 * El dígito de verificación no se valida: en los fixtures no cumple el algoritmo de la DIAN.
 */
export function normalizarNit(texto: string | null | undefined): string | null {
  if (!texto) return null
  const limpio = texto.replace(/[^\d-]/g, "")
  const conDigito = /^(\d+)-\d$/.exec(limpio)
  const base = conDigito?.[1] ?? limpio.replace(/-/g, "")
  return base.length > 0 ? base : null
}

/** Correo en minúsculas, aceptando "Nombre <correo@dominio>" o solo el correo. */
export function extraerCorreo(texto: string): string {
  const entreAngulos = /<([^>]+)>/.exec(texto)
  return (entreAngulos?.[1] ?? texto).trim().toLowerCase()
}

/** Monto en formato colombiano o simple: "11.400.000" → 11400000; "1.234,56" → 1234.56. Null si no es un monto. */
export function parsearMonto(texto: string): number | null {
  const s = texto.trim().replace(/\s/g, "")
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."))
  if (/^\d+(,\d+)?$/.test(s)) return Number(s.replace(",", "."))
  if (/^\d+\.\d{1,2}$/.test(s)) return Number(s)
  return null
}

/**
 * Fecha AAAA-MM-DD tal como está escrita en su propia zona horaria.
 * "2026-08-26T18:45:00-05:00" → "2026-08-26" (en UTC ya sería otro día si fuera más tarde).
 */
export function fechaLocal(texto: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(texto.trim())
  return m?.[1] ?? null
}

/** Suma días a una fecha AAAA-MM-DD. */
export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Palabras que no deben quedar colgando al final de un texto recortado. */
const PALABRAS_DE_ENLACE = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "o", "para", "con", "en", "a", "al", "por", "sin"])

/** Texto breve de SAP: máximo `max` caracteres, recortado en límite de palabra y sin conectores colgando. */
export function recortarDescripcion(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const ultimoEspacio = limpio.slice(0, max + 1).lastIndexOf(" ")
  const palabras = (ultimoEspacio > max / 2 ? limpio.slice(0, ultimoEspacio) : limpio.slice(0, max)).split(" ")
  while (palabras.length > 1 && PALABRAS_DE_ENLACE.has(normalizarTexto(palabras.at(-1) ?? ""))) palabras.pop()
  return palabras.join(" ").replace(/[\s,;:.-]+$/, "")
}

/** Monto legible con separador de miles colombiano: 26500000 → "26.500.000". */
export function formatoMonto(valor: number): string {
  const [entero = "0", decimales] = Math.abs(valor).toFixed(2).split(".")
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  const signo = valor < 0 ? "-" : ""
  return decimales && decimales !== "00" ? `${signo}${conMiles},${decimales}` : `${signo}${conMiles}`
}

/** Porcentaje con dos decimales y coma decimal: 6 → "6,00 %". */
export function formatoPorcentaje(valor: number): string {
  return `${valor.toFixed(2).replace(".", ",")} %`
}

/** Normaliza saltos de línea de Windows y quita la marca BOM. */
export function normalizarSaltos(texto: string): string {
  return texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
}
