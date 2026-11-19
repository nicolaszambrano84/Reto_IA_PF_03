import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { OrdenCompra } from "../src/sap/orden"
import { CODIGOS_CONTROL } from "../src/tools/lib/configuracion"
import { celdaCsv } from "../src/tools/lib/control"
import type { Derivados, Paquete } from "../src/tools/lib/esquemas"
import { sha256, SEPARADOR, type ResultadoEvidencia } from "../src/tools/lib/evidencia"
import { contieneAprobacion } from "../src/tools/lib/paquete"
import type { Trazabilidad } from "../src/tools/lib/payload"
import type { Validacion } from "../src/tools/lib/reglas"
import { normalizarNit, parsearMonto, recortarDescripcion } from "../src/tools/lib/texto"
import type { Contexto } from "../src/tools/lib/tipos"
import * as oc from "../src/tools/oc"
import { grupo, nuevaRaiz, prueba } from "./arnes"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }
interface Creado {
  numero_oc: string
  idempotente: boolean
}
interface Construido {
  payload: OrdenCompra
  ruta_trazabilidad: string
}

const leer = <T>(json: string): Respuesta<T> => JSON.parse(json) as Respuesta<T>
const ctxDe = (directory: string): Contexto => ({ directory, sessionId: "pruebas" })

function exito<T>(r: Respuesta<T>): T {
  if (!r.ok) throw new Error(`se esperaba ok:true y llegó: ${r.error}`)
  return r.data
}
function fallo<T>(r: Respuesta<T>): string {
  if (r.ok) throw new Error("se esperaba ok:false y llegó ok:true")
  return r.error
}

/** leer → validar (y opcionalmente construir) un caso. */
async function evaluar(ctx: Contexto, caso: string): Promise<{ paquete: Paquete; v: Validacion }> {
  const paquete = exito(leer<Paquete>(await oc.leer_paquete.execute({ caso }, ctx)))
  const v = exito(leer<Validacion>(await oc.validar.execute({ caso, paquete }, ctx)))
  return { paquete, v }
}
async function construir(ctx: Contexto, caso: string): Promise<Construido & { paquete: Paquete; v: Validacion }> {
  const { paquete, v } = await evaluar(ctx, caso)
  const c = exito(leer<Construido>(await oc.construir_payload.execute({ caso, paquete, derivados: v.derivados }, ctx)))
  return { ...c, paquete, v }
}
const codigos = (lista: Array<{ codigo: string }>) => lista.map((x) => x.codigo)

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Oráculo de los 6 casos del PRD (O1–O4)")

const ESPERADO: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean; derivados: string[] }> = {
  "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, derivados: [] },
  "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, derivados: [] },
  "sol-003": { apta: false, bloqueos: ["RC2", "RC3"], confirmaciones: [], retroactiva: false, derivados: [] },
  "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, derivados: [] },
  "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, derivados: [] },
  "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false, derivados: ["indicador_iva", "condiciones_pago"] },
}

for (const [caso, e] of Object.entries(ESPERADO)) {
  prueba(`${caso}: apta=${e.apta} · bloqueos [${e.bloqueos}] · confirmaciones [${e.confirmaciones}] · retroactiva=${e.retroactiva}`, async () => {
    const { v } = await evaluar(ctxDe(await nuevaRaiz()), caso)
    assert.equal(v.apta, e.apta)
    assert.deepEqual(codigos(v.bloqueos), e.bloqueos)
    assert.deepEqual(codigos(v.confirmaciones), e.confirmaciones)
    assert.equal(v.retroactiva, e.retroactiva)
    assert.deepEqual(Object.keys(v.derivados), e.derivados)
    assert.equal(v.controles.length, CODIGOS_CONTROL.length, "se informan todas las reglas")
  })
}

prueba("sol-001 se crea sin intervención humana y una segunda vez devuelve la misma OC (O1, idempotencia)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload } = await construir(ctx, "sol-001")
  const primera = exito(leer<Creado>(await oc.crear.execute({ caso: "sol-001", payload }, ctx)))
  const segunda = exito(leer<Creado>(await oc.crear.execute({ caso: "sol-001", payload }, ctx)))
  assert.equal(primera.numero_oc, "4500000001")
  assert.equal(primera.idempotente, false)
  assert.equal(segunda.numero_oc, "4500000001")
  assert.equal(segunda.idempotente, true)
  const lineas = (await readFile(path.join(ctx.directory, "out", "sap", "ordenes.jsonl"), "utf8")).trim().split("\n")
  assert.equal(lineas.length, 1, "una sola OC en SAP")
})

prueba("sol-004 muestra ambos valores, no se crea sin confirmación y sí con confirmado=true (O3)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload, v } = await construir(ctx, "sol-004")
  assert.deepEqual(v.confirmaciones[0]?.valores, { solicitud: 25000000, cotizacion: 26500000, diferencia: 1500000, diferencia_pct: 6 })
  assert.match(fallo(leer(await oc.crear.execute({ caso: "sol-004", payload }, ctx))), /Pendiente de confirmación/)
  const creada = exito(leer<Creado>(await oc.crear.execute({ caso: "sol-004", payload, confirmado: true }, ctx)))
  assert.equal(creada.numero_oc, "4500000001")
  const precio = payload.posiciones[0]?.precio_unitario
  assert.equal(precio, 250000, "la OC queda por el valor de la solicitud, nunca por el de la cotización")
})

prueba("sol-005 se crea solo con confirmación y queda retroactiva=true en control.csv (O4)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload } = await construir(ctx, "sol-005")
  fallo(leer(await oc.crear.execute({ caso: "sol-005", payload }, ctx)))
  exito(leer<Creado>(await oc.crear.execute({ caso: "sol-005", payload, confirmado: true }, ctx)))
  const csv = await readFile(path.join(ctx.directory, "out", "control.csv"), "utf8")
  const filas = csv.trim().split("\r\n").map((l) => l.split(","))
  assert.deepEqual(filas[0], ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"])
  assert.deepEqual(filas.slice(1).map((f) => [f[0], f[1], f[3], f[5]]), [
    ["SOL-2026-005", "pendiente", "true", "RC8"],
    ["SOL-2026-005", "pendiente", "true", "RC8"],
    ["SOL-2026-005", "creada", "true", "RC8"],
  ])
})

prueba("sol-002 y sol-003 no crean OC y devuelven acción sugerida; oc_crear también se niega (O2)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  for (const caso of ["sol-002", "sol-003"]) {
    const { v } = await evaluar(ctx, caso)
    assert.ok(v.bloqueos.every((b) => b.accion_sugerida.length > 20), "cada bloqueo trae acción sugerida")
    fallo(leer(await oc.construir_payload.execute({ caso, paquete: (await evaluar(ctx, caso)).paquete, derivados: v.derivados }, ctx)))
  }
  // Aunque el modelo insista con un payload válido de otro caso, oc_crear revalida sol-003 y se niega.
  const { payload } = await construir(ctx, "sol-001")
  assert.match(fallo(leer(await oc.crear.execute({ caso: "sol-003", payload, confirmado: true }, ctx))), /No se crea la OC de SOL-2026-003/)
})

prueba("sol-003 sugiere revisar el centro de costo: fvargas sí aprueba en CC-3030", async () => {
  const { v } = await evaluar(ctxDe(await nuevaRaiz()), "sol-003")
  const rc2 = v.bloqueos.find((b) => b.codigo === "RC2")
  assert.match(rc2?.detalle ?? "", /sí es aprobador de CC-3030/)
  const rc3 = v.bloqueos.find((b) => b.codigo === "RC3")
  assert.match(rc3?.detalle ?? "", /tope máximo del centro es 30\.000\.000/)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Variantes sintéticas (cada rama de las reglas)")

const VARIANTES_ESPERADAS: Record<string, { bloqueos: string[]; confirmaciones: string[] }> = {
  "sint-sin-cotizacion": { bloqueos: [], confirmaciones: ["RC5"] },
  "sint-sin-aprobacion": { bloqueos: ["RC2"], confirmaciones: [] },
  "sint-no-aprobado": { bloqueos: ["RC2"], confirmaciones: [] },
  "sint-proveedor-inactivo": { bloqueos: ["RC1"], confirmaciones: [] },
  "sint-nit-homonimo": { bloqueos: ["RC1"], confirmaciones: [] },
  "sint-nit-distinto": { bloqueos: [], confirmaciones: ["RX3"] },
  "sint-excede-tope": { bloqueos: ["RC3"], confirmaciones: [] },
  "sint-subarea-invalida": { bloqueos: ["RC4"], confirmaciones: [] },
  "sint-total-incoherente": { bloqueos: ["RC10"], confirmaciones: [] },
  "sint-aprobacion-anterior": { bloqueos: [], confirmaciones: ["RC9"] },
  "sint-iva-invalido": { bloqueos: ["RX1"], confirmaciones: [] },
}

for (const [caso, e] of Object.entries(VARIANTES_ESPERADAS)) {
  prueba(`${caso}: bloqueos [${e.bloqueos}] · confirmaciones [${e.confirmaciones}]`, async () => {
    const { v } = await evaluar(ctxDe(await nuevaRaiz()), caso)
    assert.deepEqual(codigos(v.bloqueos), e.bloqueos)
    assert.deepEqual(codigos(v.confirmaciones), e.confirmaciones)
  })
}

prueba("sint-nit-homonimo alerta posible suplantación y sint-excede-tope dice quién puede aprobar", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  assert.match((await evaluar(ctx, "sint-nit-homonimo")).v.bloqueos[0]?.detalle ?? "", /coincide con TecnoSuministros/)
  assert.match((await evaluar(ctx, "sint-excede-tope")).v.bloqueos[0]?.detalle ?? "", /dgarcia@periferia-ficticia\.com/)
})

prueba("Un adjunto ausente queda en null y se nombra, sin lanzar excepción (HU-1)", async () => {
  const p = exito(leer<Paquete>(await oc.leer_paquete.execute({ caso: "sint-sin-cotizacion" }, ctxDe(await nuevaRaiz()))))
  assert.equal(p.cotizacion, null)
  assert.deepEqual(p.faltantes, ["la cotización del proveedor (cotizacion.pdf)"])
})

for (const [caso, patron] of [
  ["sint-sin-solicitud", /Paquete incompleto.*Pide al solicitante/],
  ["sint-json-malformado", /solicitud\.json no es un JSON válido.*Pide al solicitante/],
  ["sint-monto-texto", /valor_total: .*se esperaba número.*Pide al solicitante/],
  ["sint-cotizacion-ilegible", /cotizacion\.txt no tiene un TOTAL numérico.*Pide al proveedor/],
] as const) {
  prueba(`${caso}: error legible con qué pedir (HU-6)`, async () => {
    assert.match(fallo(leer(await oc.leer_paquete.execute({ caso }, ctxDe(await nuevaRaiz())))), patron)
  })
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Contrato de herramientas (PRD §6.2)")

const HERRAMIENTAS = Object.entries(oc)

prueba("Cada export tiene description de una frase, args zod con .describe() y execute", () => {
  assert.deepEqual(HERRAMIENTAS.map(([n]) => n).sort(), ["construir_payload", "crear", "generar_evidencia", "leer_paquete", "validar"])
  for (const [nombre, h] of HERRAMIENTAS) {
    assert.ok(h.description.length > 20 && h.description.split(/\.\s/).length === 1, `${nombre}: una sola frase`)
    for (const [campo, esquema] of Object.entries(h.args)) assert.ok(esquema.description, `${nombre}.${campo} sin .describe()`)
    assert.equal(typeof h.execute, "function")
  }
})

prueba("execute nunca lanza: con argumentos basura devuelve { ok:false, error } en texto", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  for (const basura of [null, undefined, 42, "texto", [], { caso: 7 }, { caso: "sol-001", paquete: "x", payload: 1, derivados: [] }]) {
    for (const [nombre, h] of HERRAMIENTAS) {
      const salida = await (h.execute as (a: unknown, c: Contexto) => Promise<string>)(basura, ctx)
      assert.equal(typeof salida, "string")
      const r = leer(salida)
      // Las que solo reciben `caso` aceptan el último (zod ignora campos de más); el resto debe fallar.
      const soloCaso = nombre === "leer_paquete" || nombre === "generar_evidencia"
      if (!(soloCaso && typeof basura === "object" && basura !== null && "caso" in basura && basura.caso === "sol-001")) {
        assert.equal(r.ok, false, `${nombre} con ${JSON.stringify(basura)}`)
        if (!r.ok) assert.ok(r.error.length > 10)
      }
    }
  }
})

prueba("execute nunca lanza aunque el contexto sea inválido (y avisa que no pudo escribir el log)", async () => {
  const avisos: string[] = []
  const original = console.error
  console.error = (...partes: unknown[]) => void avisos.push(partes.join(" "))
  try {
    const salida = await oc.leer_paquete.execute({ caso: "sol-001" }, { directory: "Z:/no/existe", sessionId: "x" })
    assert.equal(leer(salida).ok, false)
  } finally {
    console.error = original
  }
  assert.ok(avisos.some((a) => a.includes("out/log.jsonl")))
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Seguridad e integridad")

prueba("Path traversal: los casos no pueden salir de fixtures/reto-03/solicitudes/", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  for (const caso of ["../maestros", "..\\..\\Windows", "sol-001/../sol-002", "/etc/passwd", "C:\\Windows", ".", ""]) {
    fallo(leer(await oc.leer_paquete.execute({ caso }, ctx)))
    fallo(leer(await oc.generar_evidencia.execute({ caso }, ctx)))
  }
})

prueba("Un paquete alterado por el modelo se rechaza en oc_validar (p. ej. valor_total cambiado)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const paquete = exito(leer<Paquete>(await oc.leer_paquete.execute({ caso: "sol-004" }, ctx)))
  const alterado = structuredClone(paquete)
  alterado.solicitud.valor_total = 26500000
  assert.match(fallo(leer(await oc.validar.execute({ caso: "sol-004", paquete: alterado }, ctx))), /solicitud\.valor_total/)
})

prueba("Derivados alterados se rechazan en oc_construir_payload", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { paquete, v } = await evaluar(ctx, "sol-006")
  const alterados: Derivados = structuredClone(v.derivados)
  if (alterados.indicador_iva) alterados.indicador_iva.valor = "C0"
  assert.match(fallo(leer(await oc.construir_payload.execute({ caso: "sol-006", paquete, derivados: alterados }, ctx))), /indicador_iva\.valor/)
})

prueba("Un payload alterado se rechaza en oc_crear y queda como bloqueada por INTEGRIDAD", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload } = await construir(ctx, "sol-004")
  const alterado = structuredClone(payload)
  const posicion = alterado.posiciones[0]
  if (posicion) posicion.precio_unitario = 265000
  assert.match(fallo(leer(await oc.crear.execute({ caso: "sol-004", payload: alterado, confirmado: true }, ctx))), /posiciones\[0\]\.precio_unitario/)
  const csv = await readFile(path.join(ctx.directory, "out", "control.csv"), "utf8")
  assert.match(csv, /SOL-2026-004,bloqueada,,false,INTEGRIDAD,RC5/)
})

prueba("El modelo no decide quién confirmó: confirmado_por lo pone oc_crear con la sesión", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload } = await construir(ctx, "sol-004")
  const conNombre = structuredClone(payload)
  for (const e of conNombre.excepciones) e.confirmado_por = "Gerente General"
  exito(leer<Creado>(await oc.crear.execute({ caso: "sol-004", payload: conNombre, confirmado: true }, ctx)))
  const sap = await readFile(path.join(ctx.directory, "out", "sap", "ordenes.jsonl"), "utf8")
  assert.match(sap, /"confirmado_por":"analista \(sesión pruebas\)"/)
})

prueba("Concurrencia: tres oc_crear simultáneos de la misma solicitud crean una sola OC", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload } = await construir(ctx, "sol-001")
  const resultados = await Promise.all([1, 2, 3].map(async () => exito(leer<Creado>(await oc.crear.execute({ caso: "sol-001", payload }, ctx)))))
  assert.deepEqual(new Set(resultados.map((r) => r.numero_oc)), new Set(["4500000001"]))
  assert.equal(resultados.filter((r) => !r.idempotente).length, 1)
})

prueba("CSV: celdas protegidas contra inyección de fórmulas y escapadas según RFC 4180", () => {
  assert.equal(celdaCsv('=HYPERLINK("http://x","clic")'), `"'=HYPERLINK(""http://x"",""clic"")"`)
  assert.equal(celdaCsv("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0")
  assert.equal(celdaCsv("@SUM(1)"), "'@SUM(1)")
  assert.equal(celdaCsv("RC2|RC3"), "RC2|RC3")
  assert.equal(celdaCsv("a,b"), '"a,b"')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Evidencia, payload y trazabilidad")

prueba("El SHA-256 declarado en aprobacion.txt se puede verificar recalculándolo", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const ev = exito(leer<ResultadoEvidencia>(await oc.generar_evidencia.execute({ caso: "sol-001" }, ctx)))
  const texto = await readFile(path.join(ctx.directory, ev.ruta), "utf8")
  const contenido = texto.slice(0, texto.lastIndexOf(`\n${SEPARADOR}`))
  assert.equal(sha256(contenido), ev.sha256)
  assert.ok(texto.includes(ev.sha256))
})

prueba("La evidencia es determinista: el PDF sale idéntico en cada ejecución", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const a = exito(leer<ResultadoEvidencia>(await oc.generar_evidencia.execute({ caso: "sol-005" }, ctx)))
  const b = exito(leer<ResultadoEvidencia>(await oc.generar_evidencia.execute({ caso: "sol-005" }, ctx)))
  assert.equal(a.sha256_pdf, b.sha256_pdf)
  assert.equal((await readFile(path.join(ctx.directory, a.ruta_pdf))).subarray(0, 5).toString(), "%PDF-")
})

prueba("El payload apunta a la misma evidencia que se genera", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const ev = exito(leer<ResultadoEvidencia>(await oc.generar_evidencia.execute({ caso: "sol-006" }, ctx)))
  const { payload } = await construir(ctx, "sol-006")
  assert.equal(payload.aprobador.evidencia_sha256, ev.sha256)
})

prueba("Todo valor del payload es trazable a una fuente (HU-3)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  for (const caso of ["sol-001", "sol-004", "sol-005", "sol-006"]) {
    const { payload, ruta_trazabilidad } = await construir(ctx, caso)
    const traza = JSON.parse(await readFile(path.join(ctx.directory, ruta_trazabilidad), "utf8")) as Trazabilidad
    const rastreados = new Set(traza.campos.map((c) => c.campo))
    for (const hoja of hojas(payload)) assert.ok(rastreados.has(hoja), `${caso}: ${hoja} sin fuente`)
  }
})

prueba("Unidad y texto breve: sol-001 queda en UN aunque diga «12 meses»; sol-004 en H", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const uno = (await construir(ctx, "sol-001")).payload.posiciones[0]
  const cuatro = (await construir(ctx, "sol-004")).payload.posiciones[0]
  assert.equal(uno?.unidad, "UN")
  assert.equal(cuatro?.unidad, "H")
  assert.equal(uno?.descripcion, "Renovación licencias antivirus")
  assert.ok((cuatro?.descripcion.length ?? 99) <= 40)
})

prueba("sol-006 usa C1 y Z030 del maestro y la trazabilidad lo dice", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  const { payload, ruta_trazabilidad } = await construir(ctx, "sol-006")
  assert.equal(payload.posiciones[0]?.indicador_iva, "C1")
  assert.equal(payload.condiciones_pago, "Z030")
  const traza = JSON.parse(await readFile(path.join(ctx.directory, ruta_trazabilidad), "utf8")) as Trazabilidad
  assert.equal(traza.campos.find((c) => c.campo === "condiciones_pago")?.fuente, "maestro.proveedores")
})

prueba("Cada llamada queda en out/log.jsonl con sesión, herramienta y resultado (CA4)", async () => {
  const ctx = ctxDe(await nuevaRaiz())
  await evaluar(ctx, "sol-001")
  const lineas = (await readFile(path.join(ctx.directory, "out", "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(lineas.map((l) => l.herramienta), ["oc_leer_paquete", "oc_validar"])
  assert.ok(lineas.every((l) => l.sessionId === "pruebas" && l.ok === true && typeof l.args_sha256 === "string"))
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Utilidades")

prueba("Aprobación: «Aprobado» sí; «No aprobado», «rechazado» o «desaprobado» no", () => {
  for (const si of ["Aprobado, proceder.", "Aprobado.", "APROBADO por 25 millones", "aprobada la compra"]) assert.ok(contieneAprobacion(si), si)
  for (const no of ["No aprobado: falta presupuesto", "Queda rechazado", "Desaprobado", "No se aprueba", "Revisa y me cuentas"]) assert.ok(!contieneAprobacion(no), no)
})

prueba("Montos, NIT y texto breve", () => {
  assert.equal(parsearMonto("11.400.000"), 11400000)
  assert.equal(parsearMonto("1.234,56"), 1234.56)
  assert.equal(parsearMonto("once"), null)
  assert.equal(normalizarNit("900.555.111-2"), "900555111")
  assert.equal(normalizarNit("900555111"), "900555111")
  assert.equal(recortarDescripcion("Bolsa de 100 horas de arquitectura de nube para migración", 40), "Bolsa de 100 horas de arquitectura")
})

/** Rutas de todas las hojas de un objeto: "posiciones[0].cantidad", … */
function hojas(valor: unknown, ruta = ""): string[] {
  if (Array.isArray(valor)) return valor.flatMap((v: unknown, i) => hojas(v, `${ruta}[${i}]`))
  if (typeof valor === "object" && valor !== null) return Object.entries(valor).flatMap(([k, v]) => hojas(v, ruta ? `${ruta}.${k}` : k))
  return [ruta]
}
