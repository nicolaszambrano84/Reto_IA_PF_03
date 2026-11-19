/**
 * Demo sin modelo (PRD §6.6). Procesa los 6 casos de fixtures/reto-03/solicitudes/ llamando
 * directamente a las herramientas: sin servidor y sin proveedor LLM (no necesita ninguna clave).
 *
 *   bun install && bun run demo.ts        (con Node 20+: npm install && npx tsx demo.ts)
 *
 * Por caso muestra: apta, bloqueos, confirmaciones, retroactiva y número de OC o motivo. Incluye la
 * idempotencia (sol-001 dos veces) y la confirmación explícita de sol-004. out/ se limpia al inicio.
 */
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { OrdenCompra } from "./src/sap/orden"
import type { Paquete } from "./src/tools/lib/esquemas"
import type { ResultadoEvidencia } from "./src/tools/lib/evidencia"
import type { Hallazgo, Validacion } from "./src/tools/lib/reglas"
import { formatoMonto } from "./src/tools/lib/texto"
import type { Contexto } from "./src/tools/lib/tipos"
import * as oc from "./src/tools/oc"
import { crearRaizDePrueba } from "./tests/sinteticos"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }
interface Construido {
  payload: OrdenCompra
  ruta_trazabilidad: string
}
interface Creado {
  numero_oc: string
  fecha: string | null
  idempotente: boolean
  evidencia: string
}
interface FilaResumen {
  caso: string
  apta: string
  bloqueos: string
  confirmaciones: string
  retroactiva: string
  resultado: string
}

const RAIZ = path.dirname(fileURLToPath(import.meta.url))
const resumen: FilaResumen[] = []

/** Las herramientas devuelven JSON en texto (contrato del PRD): aquí se interpreta. */
function respuesta<T>(json: string): Respuesta<T> {
  return JSON.parse(json) as Respuesta<T>
}

const linea = (texto: string) => console.log(`  ${texto}`)
const seccion = (texto: string) => console.log(`\n${"=".repeat(78)}\n ${texto}\n${"=".repeat(78)}`)
const primeraFrase = (texto: string) => texto.split(/(?<=\.)\s/)[0] ?? texto
const codigos = (h: Hallazgo[]) => h.map((x) => x.codigo).join(", ") || "-"

function listar(titulo: string, hallazgos: Hallazgo[], vacio: string): void {
  if (hallazgos.length === 0) return linea(`${titulo}: ${vacio}`)
  linea(`${titulo}:`)
  for (const h of hallazgos) {
    linea(`  · ${h.codigo} ${h.regla}: ${h.detalle}`)
    linea(`      acción sugerida: ${h.accion_sugerida}`)
  }
}

/** Flujo completo de un caso, igual al que sigue el agente: leer → validar → evidencia → payload → crear. */
async function procesar(ctx: Contexto, caso: string, opciones: { confirmar?: boolean; etiqueta?: string } = {}): Promise<void> {
  const etiqueta = opciones.etiqueta ?? caso
  const p = respuesta<Paquete>(await oc.leer_paquete.execute({ caso }, ctx))
  if (!p.ok) {
    console.log(`\n> ${etiqueta}`)
    return linea(`✘ ${p.error}`)
  }
  const s = p.data.solicitud
  console.log(`\n> ${etiqueta} · ${s.solicitud_id} · ${s.proveedor_nombre} · ${s.moneda} ${formatoMonto(s.valor_total)}`)
  if (p.data.faltantes.length > 0) linea(`adjuntos faltantes: ${p.data.faltantes.join("; ")}`)

  const v = respuesta<Validacion>(await oc.validar.execute({ caso, paquete: p.data }, ctx))
  if (!v.ok) return linea(`✘ oc_validar: ${v.error}`)
  const val = v.data
  linea(`apta: ${val.apta ? "sí" : "NO"} · retroactiva: ${val.retroactiva ? "SÍ" : "no"}`)
  listar("bloqueos", val.bloqueos, "ninguno")
  listar("confirmaciones", val.confirmaciones, "ninguna")
  for (const d of Object.values(val.derivados)) linea(`derivado (${d.regla}): ${d.valor} desde ${d.fuente}, ${d.detalle}`)
  const fila = { caso: etiqueta, apta: val.apta ? "sí" : "no", bloqueos: codigos(val.bloqueos), confirmaciones: codigos(val.confirmaciones), retroactiva: val.retroactiva ? "sí" : "no" }
  if (!val.apta) {
    linea("✘ OC no creada: la solicitud tiene bloqueos (se devuelve a la analista con la acción sugerida)")
    resumen.push({ ...fila, resultado: "bloqueada" })
    return
  }

  const ev = respuesta<ResultadoEvidencia>(await oc.generar_evidencia.execute({ caso }, ctx))
  if (ev.ok) linea(`evidencia: ${ev.data.ruta} y ${ev.data.ruta_pdf} · sha256 ${ev.data.sha256.slice(0, 16)}…`)
  const pl = respuesta<Construido>(await oc.construir_payload.execute({ caso, paquete: p.data, derivados: val.derivados }, ctx))
  if (!pl.ok) return linea(`✘ oc_construir_payload: ${pl.error}`)
  const orden = pl.data.payload
  const pos = orden.posiciones[0]
  if (pos) {
    linea(`payload: proveedor ${orden.proveedor.codigo_sap} · pago ${orden.condiciones_pago} · «${pos.descripcion}» · ${pos.cantidad} ${pos.unidad} × ${formatoMonto(pos.precio_unitario)} · IVA ${pos.indicador_iva}`)
  }
  linea(`trazabilidad: ${pl.data.ruta_trazabilidad}`)

  let c = respuesta<Creado>(await oc.crear.execute({ caso, payload: orden }, ctx))
  if (!c.ok && opciones.confirmar) {
    linea(`oc_crear sin confirmación → ${primeraFrase(c.error)}`)
    linea("La analista responde «confirmo» (en la demo se simula) → oc_crear con confirmado=true")
    c = respuesta<Creado>(await oc.crear.execute({ caso, payload: orden, confirmado: true }, ctx))
  }
  if (!c.ok) {
    linea(`✘ ${primeraFrase(c.error)}`)
    resumen.push({ ...fila, resultado: "pendiente" })
    return
  }
  const idem = c.data.idempotente ? " (idempotente: ya existía, no se creó otra)" : ""
  linea(`✔ OC ${c.data.numero_oc}${idem}`)
  resumen.push({ ...fila, resultado: `OC ${c.data.numero_oc}${c.data.idempotente ? " (idempotente)" : ""}` })
}

/** HU-6 y seguridad, sobre una copia con casos sintéticos (fixtures/ no se toca). */
async function robustez(): Promise<void> {
  seccion("Robustez y seguridad · casos sintéticos en out/demo-robustez/ (fixtures/ no se toca)")
  const ctx: Contexto = { directory: await crearRaizDePrueba(path.join(RAIZ, "out", "demo-robustez")), sessionId: "demo" }

  console.log("\n> Errores legibles (HU-6): el agente informa y dice qué pedir al solicitante")
  for (const caso of ["sint-sin-solicitud", "sint-json-malformado", "sint-monto-texto", "sint-cotizacion-ilegible"]) {
    const r = respuesta<Paquete>(await oc.leer_paquete.execute({ caso }, ctx))
    linea(`${caso}: ${r.ok ? "(inesperado: ok)" : `✘ ${r.error}`}`)
  }

  console.log("\n> Adjunto ausente (HU-1): queda en null y se nombra, sin lanzar excepción")
  const sinCot = respuesta<Paquete>(await oc.leer_paquete.execute({ caso: "sint-sin-cotizacion" }, ctx))
  if (sinCot.ok) {
    linea(`cotizacion: ${String(sinCot.data.cotizacion)} · faltantes: ${sinCot.data.faltantes.join("; ")}`)
    const v = respuesta<Validacion>(await oc.validar.execute({ caso: "sint-sin-cotizacion", paquete: sinCot.data }, ctx))
    if (v.ok) linea(`→ confirmaciones: ${v.data.confirmaciones.map((h) => `${h.codigo} ${h.detalle}`).join(" ")}`)
  }

  console.log("\n> Path traversal: un caso no puede salir de fixtures/reto-03/solicitudes/")
  const traversal = respuesta<Paquete>(await oc.leer_paquete.execute({ caso: "../maestros" }, ctx))
  linea(traversal.ok ? "(inesperado: ok)" : `✘ ${traversal.error}`)

  console.log("\n> Manipulación del payload: el modelo «arregla» el precio para que cuadre con la cotización (riesgo §10)")
  const p = respuesta<Paquete>(await oc.leer_paquete.execute({ caso: "sol-004" }, ctx))
  if (!p.ok) return linea(`✘ ${p.error}`)
  const v = respuesta<Validacion>(await oc.validar.execute({ caso: "sol-004", paquete: p.data }, ctx))
  if (!v.ok) return linea(`✘ ${v.error}`)
  const pl = respuesta<Construido>(await oc.construir_payload.execute({ caso: "sol-004", paquete: p.data, derivados: v.data.derivados }, ctx))
  if (!pl.ok) return linea(`✘ ${pl.error}`)
  const alterado = structuredClone(pl.data.payload)
  const primera = alterado.posiciones[0]
  if (primera) primera.precio_unitario = 265000
  const c = respuesta<Creado>(await oc.crear.execute({ caso: "sol-004", payload: alterado, confirmado: true }, ctx))
  linea(c.ok ? `(inesperado: OC ${c.data.numero_oc})` : `✘ ${c.error}`)
}

async function main(): Promise<void> {
  await rm(path.join(RAIZ, "out"), { recursive: true, force: true })
  const ctx: Contexto = { directory: RAIZ, sessionId: "demo" }
  seccion("Demo sin modelo · Agente de órdenes de compra (Reto 03) · herramientas de src/tools/oc.ts")

  await procesar(ctx, "sol-001")
  await procesar(ctx, "sol-001", { etiqueta: "sol-001 (segunda vez: idempotencia)" })
  await procesar(ctx, "sol-002")
  await procesar(ctx, "sol-003")
  await procesar(ctx, "sol-004", { confirmar: true })
  await procesar(ctx, "sol-005", { confirmar: true })
  await procesar(ctx, "sol-006", { confirmar: true })

  seccion("Resumen de los 6 casos")
  const columnas: Array<keyof FilaResumen> = ["caso", "apta", "bloqueos", "confirmaciones", "retroactiva", "resultado"]
  const ancho = (c: keyof FilaResumen) => Math.max(c.length, ...resumen.map((f) => f[c].length))
  const fila = (valores: Record<keyof FilaResumen, string>) => columnas.map((c) => valores[c].padEnd(ancho(c))).join("  ")
  console.log(` ${fila({ caso: "caso", apta: "apta", bloqueos: "bloqueos", confirmaciones: "confirmaciones", retroactiva: "retroactiva", resultado: "resultado" })}`)
  for (const f of resumen) console.log(` ${fila(f)}`)

  seccion("out/control.csv (log de control para Contabilidad y Auditoría)")
  console.log((await readFile(path.join(RAIZ, "out", "control.csv"), "utf8")).trimEnd())

  await robustez()
  console.log("\nArchivos generados: out/<caso>/aprobacion.txt|pdf, out/<caso>/trazabilidad.json, out/sap/ordenes.jsonl, out/control.csv, out/log.jsonl\n")
}

await main()
