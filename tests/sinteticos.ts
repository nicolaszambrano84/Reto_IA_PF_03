import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Casos sintéticos para probar lo que los 6 fixtures no cubren (HU-6, ramas de cada regla, seguridad).
 * Nunca tocan fixtures/: se arma una raíz de proyecto aparte (copia de los fixtures + variantes) y las
 * herramientas trabajan sobre ella vía ctx.directory.
 */

export const RAIZ_PROYECTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

interface Variante {
  descripcion: string
  /** Cambios sobre solicitud.json; `null` borra el campo. */
  solicitud?: Record<string, unknown>
  /** Cambios sobre aprobacion.json. */
  aprobacion?: Record<string, unknown>
  /** Transformación del texto de la cotización. */
  cotizacion?: (texto: string) => string
  /** Archivos que se eliminan del caso. */
  sinArchivos?: string[]
  /** Contenido crudo que reemplaza un archivo (p. ej. JSON malformado). */
  crudos?: Record<string, string>
}

/** Todas parten de sol-001 (el caso limpio) y cambian una sola cosa. */
export const VARIANTES: Record<string, Variante> = {
  "sint-sin-cotizacion": { descripcion: "Falta la cotización: queda en null y RC5 pide confirmación", sinArchivos: ["cotizacion.txt"] },
  "sint-sin-aprobacion": { descripcion: "Falta el correo de aprobación: RC2 bloquea", sinArchivos: ["aprobacion.json"] },
  "sint-no-aprobado": {
    descripcion: "El líder escribe «No aprobado»: RC2 bloquea aunque contenga la palabra",
    aprobacion: { cuerpo: "No aprobado: este trimestre no hay presupuesto.\n\nMariana López" },
  },
  "sint-proveedor-inactivo": {
    descripcion: "Proveedor inactivo en el maestro: RC1 bloquea",
    solicitud: { proveedor_nombre: "Consultores Ágiles S.A.S.", proveedor_nit: "901777888" },
    cotizacion: (t) => t.replace("Proveedor: TecnoSuministros S.A.S.", "Proveedor: Consultores Ágiles S.A.S.").replace("NIT: 900.555.111-2", "NIT: 901.777.888-4"),
  },
  "sint-nit-homonimo": {
    descripcion: "NIT inexistente con el nombre de un proveedor registrado: RC1 bloquea y alerta de posible suplantación",
    solicitud: { proveedor_nit: "999888777" },
  },
  "sint-nit-distinto": {
    descripcion: "La cotización trae otro NIT: RX3 pide confirmación",
    cotizacion: (t) => t.replace("NIT: 900.555.111-2", "NIT: 900.999.888-1"),
  },
  "sint-excede-tope": {
    descripcion: "57 M con un aprobador de tope 50 M: RC3 bloquea y sugiere quién puede aprobar",
    solicitud: { cantidad: 600, valor_total: 57000000 },
    cotizacion: (t) => t.replace("TOTAL (IVA incluido): COP 11.400.000", "TOTAL (IVA incluido): COP 57.000.000"),
  },
  "sint-subarea-invalida": { descripcion: "Subárea de otro centro: RC4 bloquea", solicitud: { subarea: "Marketing" } },
  "sint-total-incoherente": {
    descripcion: "Cantidad × unitario ≠ total: RC10 bloquea",
    solicitud: { valor_total: 11500000 },
    cotizacion: (t) => t.replace("TOTAL (IVA incluido): COP 11.400.000", "TOTAL (IVA incluido): COP 11.500.000"),
  },
  "sint-aprobacion-anterior": {
    descripcion: "Aprobación anterior a la solicitud: RC9 pide confirmación",
    aprobacion: { fecha: "2026-08-19T09:00:00-05:00" },
  },
  "sint-iva-invalido": { descripcion: "Indicador de IVA inexistente: RX1 bloquea", solicitud: { indicador_iva: "C9" } },
  "sint-json-malformado": {
    descripcion: "solicitud.json malformado: error legible (HU-6)",
    crudos: { "solicitud.json": '{ "solicitud_id": "SOL-T-JSON", "valor_total": ' },
  },
  "sint-monto-texto": { descripcion: "Monto no numérico: error legible (HU-6)", solicitud: { valor_total: "once millones" } },
  "sint-sin-solicitud": { descripcion: "Paquete incompleto, sin solicitud: error legible (HU-6)", sinArchivos: ["solicitud.json"] },
  "sint-cotizacion-ilegible": {
    descripcion: "Cotización sin TOTAL: error legible (HU-6)",
    cotizacion: (t) => t.replace(/^TOTAL.*\n/m, ""),
  },
}

/** Crea en `destino` una raíz de proyecto con los fixtures reales y las variantes sintéticas. */
export async function crearRaizDePrueba(destino: string): Promise<string> {
  await rm(destino, { recursive: true, force: true })
  await copiarCarpeta(path.join(RAIZ_PROYECTO, "fixtures"), path.join(destino, "fixtures"))
  const solicitudes = path.join(destino, "fixtures", "reto-03", "solicitudes")
  let n = 0
  for (const [nombre, variante] of Object.entries(VARIANTES)) {
    n += 1
    await crearVariante(solicitudes, nombre, variante, `SOL-T-${String(n).padStart(3, "0")}`)
  }
  return destino
}

async function crearVariante(solicitudes: string, nombre: string, v: Variante, solicitudId: string): Promise<void> {
  const carpeta = path.join(solicitudes, nombre)
  await copiarCarpeta(path.join(solicitudes, "sol-001"), carpeta)
  await modificarJson(path.join(carpeta, "solicitud.json"), { solicitud_id: solicitudId, ...v.solicitud })
  if (v.aprobacion) await modificarJson(path.join(carpeta, "aprobacion.json"), v.aprobacion)
  if (v.cotizacion) {
    const ruta = path.join(carpeta, "cotizacion.txt")
    await writeFile(ruta, v.cotizacion(await readFile(ruta, "utf8")), "utf8")
  }
  for (const archivo of v.sinArchivos ?? []) await rm(path.join(carpeta, archivo), { force: true })
  for (const [archivo, contenido] of Object.entries(v.crudos ?? {})) await writeFile(path.join(carpeta, archivo), contenido, "utf8")
}

async function modificarJson(ruta: string, cambios: Record<string, unknown>): Promise<void> {
  const original: unknown = JSON.parse(await readFile(ruta, "utf8"))
  const base = typeof original === "object" && original !== null ? (original as Record<string, unknown>) : {}
  const resultado: Record<string, unknown> = { ...base }
  for (const [clave, valor] of Object.entries(cambios)) {
    if (valor === null) delete resultado[clave]
    else resultado[clave] = valor
  }
  await writeFile(ruta, JSON.stringify(resultado, null, 2), "utf8")
}

async function copiarCarpeta(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const entrada of await readdir(origen, { withFileTypes: true })) {
    const de = path.join(origen, entrada.name)
    const a = path.join(destino, entrada.name)
    if (entrada.isDirectory()) await copiarCarpeta(de, a)
    else await copyFile(de, a)
  }
}
