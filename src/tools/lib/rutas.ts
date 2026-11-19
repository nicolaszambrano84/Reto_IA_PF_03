import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { normalizarSaltos } from "./texto"
import { ErrorNegocio } from "./tipos"

/**
 * Resolución de rutas con confinamiento: toda lectura queda dentro de fixtures/ y toda escritura
 * dentro de out/, partiendo de ctx.directory (la raíz del proyecto). Así un `caso` como
 * "../maestros" o "..\\..\\Windows" no puede salir de la carpeta permitida (path traversal).
 */

/** Nombre de carpeta de un caso: solo minúsculas, números y guiones (lista blanca). */
export const CasoSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "usa el nombre de la carpeta del caso, p. ej. sol-001 (solo minúsculas, números y guiones)")

const SOLICITUDES = ["fixtures", "reto-03", "solicitudes"] as const
const MAESTROS = ["fixtures", "reto-03", "maestros"] as const

/** Carpeta del caso, verificando que existe y que no sale de fixtures/reto-03/solicitudes/. */
export async function carpetaCaso(directory: string, caso: string): Promise<string> {
  if (!CasoSchema.safeParse(caso).success) throw new ErrorNegocio(`El caso "${caso}" no es válido: usa el nombre de la carpeta, p. ej. sol-001.`)
  const base = path.resolve(directory, ...SOLICITUDES)
  const carpeta = path.resolve(base, caso)
  if (path.dirname(carpeta) !== base || !(await esCarpeta(carpeta))) {
    throw new ErrorNegocio(`No existe el caso "${caso}" en fixtures/reto-03/solicitudes/. Casos disponibles: ${(await listarCasos(directory)).join(", ") || "ninguno"}.`)
  }
  // Defensa adicional: un enlace simbólico no puede apuntar fuera de la carpeta permitida.
  const [baseReal, carpetaReal] = await Promise.all([realpath(base), realpath(carpeta)])
  if (path.dirname(carpetaReal) !== baseReal) throw new ErrorNegocio(`El caso "${caso}" apunta fuera de la carpeta permitida.`)
  return carpeta
}

export function rutaMaestro(directory: string, archivo: string): string {
  return path.resolve(directory, ...MAESTROS, archivo)
}

/** Ruta dentro de out/ (la única carpeta donde se escribe). */
export function rutaSalida(directory: string, ...partes: string[]): string {
  const base = path.resolve(directory, "out")
  const destino = path.resolve(base, ...partes)
  if (destino !== base && !destino.startsWith(base + path.sep)) throw new ErrorNegocio("Ruta de salida fuera de out/.")
  return destino
}

/** Ruta relativa a la raíz con "/" (para mostrar al usuario y al modelo, nunca absoluta). */
export function rutaVisible(directory: string, absoluta: string): string {
  return path.relative(directory, absoluta).split(path.sep).join("/")
}

/** Escribe un JSON legible dentro de out/ y devuelve su ruta visible. */
export async function escribirJson(directory: string, partes: string[], valor: unknown): Promise<string> {
  const ruta = rutaSalida(directory, ...partes)
  await mkdir(path.dirname(ruta), { recursive: true })
  await writeFile(ruta, `${JSON.stringify(valor, null, 2)}\n`, "utf8")
  return rutaVisible(directory, ruta)
}

/** Carpetas de casos disponibles en fixtures/reto-03/solicitudes/. */
export async function listarCasos(directory: string): Promise<string[]> {
  try {
    const entradas = await readdir(path.resolve(directory, ...SOLICITUDES), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory() && CasoSchema.safeParse(e.name).success).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function esCarpeta(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).isDirectory()
  } catch {
    return false
  }
}

/** Texto del archivo, o null si no existe. Normaliza saltos de línea de Windows. */
export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return normalizarSaltos(await readFile(ruta, "utf8"))
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null
    throw e
  }
}

/** JSON del archivo, o null si no existe. Si el JSON está malformado, lanza un error legible. */
export async function leerJsonOpcional(ruta: string): Promise<unknown> {
  const texto = await leerTextoOpcional(ruta)
  if (texto === null) return null
  try {
    return JSON.parse(texto) as unknown
  } catch {
    // Mensaje propio: el del intérprete cambia entre Bun y Node y no le sirve a la analista.
    throw new ErrorNegocio(`${path.basename(ruta)} no es un JSON válido (está incompleto o mal formado).`)
  }
}
