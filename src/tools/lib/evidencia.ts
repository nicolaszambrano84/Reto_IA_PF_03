import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib"
import type { AprobacionArchivo } from "./esquemas"
import { leerAprobacionArchivo } from "./paquete"
import { rutaSalida, rutaVisible } from "./rutas"
import { normalizarSaltos } from "./texto"
import { ErrorNegocio } from "./tipos"

/**
 * HU-4: evidencia de aprobación. El SHA-256 cubre exactamente el "contenido" (encabezados + cuerpo),
 * que es lo que va antes de la línea separadora en aprobacion.txt. Para verificarlo basta con
 * recalcular el hash de ese bloque. El PDF lleva el mismo contenido y la misma huella.
 */

export const SEPARADOR = "-".repeat(64)

export interface Evidencia {
  contenido: string
  sha256: string
}

export interface ResultadoEvidencia {
  ruta: string
  sha256: string
  ruta_pdf: string
  sha256_pdf: string
}

export function renderizarEvidencia(a: AprobacionArchivo): Evidencia {
  const lineas = [
    `De: ${a.de}`,
    `Para: ${a.para ?? "(no indicado)"}`,
    ...(a.cc && a.cc.length > 0 ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto ?? "(sin asunto)"}`,
    "",
    normalizarSaltos(a.cuerpo).trimEnd(),
  ]
  const contenido = lineas.join("\n")
  return { contenido, sha256: sha256(contenido) }
}

export function sha256(datos: string | Uint8Array): string {
  return createHash("sha256").update(datos).digest("hex")
}

export function textoEvidencia(ev: Evidencia, fuente: string): string {
  return [ev.contenido, SEPARADOR, `SHA-256 del contenido anterior (encabezados + cuerpo): ${ev.sha256}`, `Fuente: ${fuente}`, ""].join("\n")
}

/** Calcula la evidencia sin escribir archivos (para el payload). */
export async function calcularEvidencia(directory: string, caso: string): Promise<Evidencia> {
  return renderizarEvidencia(await aprobacionObligatoria(directory, caso))
}

/** Escribe out/<caso>/aprobacion.txt y aprobacion.pdf. Mismo correo → mismos archivos (determinista). */
export async function generarEvidencia(directory: string, caso: string): Promise<ResultadoEvidencia> {
  const aprobacion = await aprobacionObligatoria(directory, caso)
  const ev = renderizarEvidencia(aprobacion)
  const fuente = `fixtures/reto-03/solicitudes/${caso}/aprobacion.json`
  const pdf = await pdfEvidencia(ev, { titulo: `Evidencia de aprobación: ${aprobacion.asunto ?? caso}`, fecha: fechaValida(aprobacion.fecha), fuente })

  const carpeta = rutaSalida(directory, caso)
  await mkdir(carpeta, { recursive: true })
  const rutaTxt = path.join(carpeta, "aprobacion.txt")
  const rutaPdf = path.join(carpeta, "aprobacion.pdf")
  await Promise.all([writeFile(rutaTxt, textoEvidencia(ev, fuente), "utf8"), writeFile(rutaPdf, pdf)])
  return { ruta: rutaVisible(directory, rutaTxt), sha256: ev.sha256, ruta_pdf: rutaVisible(directory, rutaPdf), sha256_pdf: sha256(pdf) }
}

async function aprobacionObligatoria(directory: string, caso: string): Promise<AprobacionArchivo> {
  const aprobacion = await leerAprobacionArchivo(directory, caso)
  if (!aprobacion) {
    throw new ErrorNegocio(`El caso ${caso} no tiene correo de aprobación: no hay evidencia que generar. Pide al solicitante el correo de aprobación de su líder.`)
  }
  return aprobacion
}

// ── PDF (P1) ─────────────────────────────────────────────────────────────────────────────────

async function pdfEvidencia(ev: Evidencia, meta: { titulo: string; fecha: Date; fuente: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(aWinAnsi(meta.titulo))
  pdf.setSubject("Evidencia de aprobación de orden de compra")
  pdf.setAuthor("Agente de órdenes de compra (SAP simulado)")
  pdf.setCreator("reto-03")
  pdf.setProducer("reto-03 con pdf-lib")
  // Fechas fijas (las del correo): así el PDF es idéntico en cada ejecución.
  pdf.setCreationDate(meta.fecha)
  pdf.setModificationDate(meta.fecha)

  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  const hoja = crearHoja(pdf)
  hoja.escribir(meta.titulo, negrita, 13)
  hoja.espacio(6)
  for (const linea of ev.contenido.split("\n")) hoja.escribir(linea, normal, 10.5)
  hoja.espacio(4)
  hoja.regla()
  hoja.escribir("SHA-256 del contenido (encabezados + cuerpo):", negrita, 9)
  hoja.escribir(ev.sha256, mono, 8.5)
  hoja.escribir(`Fuente: ${meta.fuente}`, normal, 8.5)
  return pdf.save()
}

/** Escribe líneas en páginas A4, con salto de línea por ancho y página nueva cuando se llena. */
function crearHoja(pdf: PDFDocument) {
  const [ancho, alto, margen] = [595.28, 841.89, 56]
  let pagina = pdf.addPage([ancho, alto])
  let y = alto - margen

  function escribir(texto: string, fuente: PDFFont, tamano: number): void {
    for (const linea of envolver(aWinAnsi(texto), fuente, tamano, ancho - 2 * margen)) {
      if (y - tamano < margen) {
        pagina = pdf.addPage([ancho, alto])
        y = alto - margen
      }
      pagina.drawText(linea, { x: margen, y: y - tamano, size: tamano, font: fuente, color: rgb(0.1, 0.1, 0.1) })
      y -= tamano * 1.45
    }
  }
  function espacio(puntos: number): void {
    y -= puntos
  }
  function regla(): void {
    pagina.drawLine({ start: { x: margen, y }, end: { x: ancho - margen, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) })
    y -= 12
  }
  return { escribir, espacio, regla }
}

function envolver(texto: string, fuente: PDFFont, tamano: number, maximo: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (actual && fuente.widthOfTextAtSize(prueba, tamano) > maximo) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  lineas.push(actual)
  return lineas
}

/** Las fuentes estándar del PDF solo codifican WinAnsi: lo demás se reemplaza por "?" en vez de fallar. */
const EXTRA_WINANSI = new Set(Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"))
function aWinAnsi(texto: string): string {
  return Array.from(texto.replace(/\t/g, "    "))
    .map((c) => {
      const cp = c.codePointAt(0) ?? 63
      return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || EXTRA_WINANSI.has(c) ? c : "?"
    })
    .join("")
}

function fechaValida(texto: string): Date {
  const fecha = new Date(texto)
  return Number.isNaN(fecha.getTime()) ? new Date(0) : fecha
}
