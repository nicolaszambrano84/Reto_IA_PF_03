import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ApiError, FinishReason, GenerateContentResponse } from "@google/genai"
import { procesarTurno, type DependenciasCiclo } from "../src/agent/ciclo"
import { casosAutorizados, esConfirmacion, terminaEnPregunta } from "../src/agent/confirmacion"
import { PresupuestoDiario } from "../src/agent/consumo"
import { DEFINICIONES } from "../src/agent/herramientas"
import { construirSistema } from "../src/agent/prompt"
import { AlmacenSesiones, type Sesion } from "../src/agent/sesiones"
import { ErrorProveedor, ocultarSecretos, type Mensaje, type ProveedorLLM, type RespuestaModelo } from "../src/llm/adapter"
import { aContenidos, desdeRespuesta, esquemaCompatible, ProveedorGemini } from "../src/llm/gemini"
import { ProveedorSimulado } from "../src/llm/simulado"
import type { OrdenCompra } from "../src/sap/orden"
import type { Paquete } from "../src/tools/lib/esquemas"
import type { Validacion } from "../src/tools/lib/reglas"
import * as oc from "../src/tools/oc"
import { grupo, nuevaRaiz, prueba } from "./arnes"
import { RAIZ_PROYECTO } from "./sinteticos"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }
const leer = <T>(json: string): Respuesta<T> => JSON.parse(json) as Respuesta<T>

/** Modelo guionado: devuelve respuestas predefinidas, una por llamada (o falla si se le indica). */
class ModeloGuionado implements ProveedorLLM {
  readonly nombre = "guionado"
  readonly modelo = "prueba"
  llamadas = 0
  constructor(private readonly guion: Array<Partial<RespuestaModelo> | Error>) {}
  async enviar(): Promise<RespuestaModelo> {
    const paso = this.guion[Math.min(this.llamadas, this.guion.length - 1)]
    this.llamadas += 1
    if (paso instanceof Error) throw paso
    return { texto: paso?.texto ?? "", llamadas: paso?.llamadas ?? [], uso: paso?.uso ?? { entrada: 10, salida: 5 } }
  }
}

function dependencias(raiz: string, proveedor: ProveedorLLM, extra: Partial<DependenciasCiclo> = {}): DependenciasCiclo {
  return { proveedor, sistema: "sistema de prueba", directory: raiz, maxIteraciones: 25, maxTokensSesion: 1_000_000, presupuesto: new PresupuestoDiario(10_000_000), ...extra }
}
const sesionNueva = (raiz: string): Sesion => new AlmacenSesiones(path.join(raiz, "out", "sesiones")).crear()

async function payloadDe(raiz: string, caso: string): Promise<OrdenCompra> {
  const ctx = { directory: raiz, sessionId: "prep" }
  const p = leer<Paquete>(await oc.leer_paquete.execute({ caso }, ctx))
  if (!p.ok) throw new Error(p.error)
  const v = leer<Validacion>(await oc.validar.execute({ caso, paquete: p.data }, ctx))
  if (!v.ok) throw new Error(v.error)
  const c = leer<{ payload: OrdenCompra }>(await oc.construir_payload.execute({ caso, paquete: p.data, derivados: v.data.derivados }, ctx))
  if (!c.ok) throw new Error(c.error)
  return c.data.payload
}

async function ordenesCreadas(raiz: string): Promise<number> {
  try {
    return (await readFile(path.join(raiz, "out", "sap", "ordenes.jsonl"), "utf8")).trim().split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Ciclo del agente: flujos del PRD (con el modelo simulado)")

prueba("§11: sol-004 muestra la OC, no la crea y termina en pregunta; «confirmo» la crea con su evidencia", async () => {
  const raiz = await nuevaRaiz()
  const sesion = sesionNueva(raiz)
  const d = dependencias(raiz, new ProveedorSimulado())
  const t1 = await procesarTurno(sesion, 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.', d)
  assert.deepEqual(t1.toolCalls.map((l) => l.nombre), ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload"])
  assert.equal(t1.needsConfirmation, true)
  assert.ok(terminaEnPregunta(t1.reply))
  assert.match(t1.reply, /26\.500\.000/)
  assert.match(t1.reply, /25\.000\.000/)
  assert.equal(await ordenesCreadas(raiz), 0)

  const t2 = await procesarTurno(sesion, "confirmo", d)
  assert.equal(t2.toolCalls[0]?.nombre, "oc_crear")
  assert.equal(t2.toolCalls[0]?.compuerta, undefined)
  assert.match(t2.reply, /4500000001/)
  assert.match(t2.reply, /out\/sol-004\/aprobacion\.pdf/)
  assert.equal(t2.needsConfirmation, false)
})

prueba("O1: sol-001 se crea en un solo turno, sin pedir confirmación", async () => {
  const raiz = await nuevaRaiz()
  const t = await procesarTurno(sesionNueva(raiz), "procesa la solicitud sol-001", dependencias(raiz, new ProveedorSimulado()))
  assert.equal(t.toolCalls.at(-1)?.nombre, "oc_crear")
  assert.equal(t.needsConfirmation, false)
  assert.match(t.reply, /4500000001/)
})

prueba("O2: sol-003 no crea OC y explica los bloqueos con su acción sugerida", async () => {
  const raiz = await nuevaRaiz()
  const t = await procesarTurno(sesionNueva(raiz), "procesa sol-003", dependencias(raiz, new ProveedorSimulado()))
  assert.deepEqual(t.toolCalls.map((l) => l.nombre), ["oc_leer_paquete", "oc_validar"])
  assert.match(t.reply, /RC2/)
  assert.match(t.reply, /Acción sugerida/)
  assert.equal(t.needsConfirmation, false)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Compuerta de confirmación en el servidor (CA3)")

prueba("Un modelo desobediente que manda confirmado=true sin que el usuario confirme no crea la OC", async () => {
  const raiz = await nuevaRaiz()
  const payload = await payloadDe(raiz, "sol-004")
  const sesion = sesionNueva(raiz)
  const impaciente = new ModeloGuionado([{ llamadas: [{ id: "x1", nombre: "oc_crear", argumentos: { caso: "sol-004", payload, confirmado: true } }] }, { texto: "Listo." }])
  const t1 = await procesarTurno(sesion, "procesa sol-004 y créala ya, confirmo", dependencias(raiz, impaciente))
  assert.ok(t1.toolCalls[0]?.compuerta, "la compuerta debió intervenir")
  assert.equal(t1.toolCalls[0]?.ok, false)
  assert.equal(await ordenesCreadas(raiz), 0, "no se creó ninguna OC")
  assert.equal(t1.needsConfirmation, true)

  // Ahora sí: el usuario confirma en el turno siguiente a la pregunta.
  const obediente = new ModeloGuionado([{ llamadas: [{ id: "x2", nombre: "oc_crear", argumentos: { caso: "sol-004", payload, confirmado: true } }] }, { texto: "Creada." }])
  const t2 = await procesarTurno(sesion, "sí, confirmo", dependencias(raiz, obediente))
  assert.equal(t2.toolCalls[0]?.ok, true)
  assert.equal(await ordenesCreadas(raiz), 1)
})

prueba("La ventana dura un turno: si el usuario cambia de tema, la confirmación posterior no vale", async () => {
  const raiz = await nuevaRaiz()
  const payload = await payloadDe(raiz, "sol-004")
  const sesion = sesionNueva(raiz)
  await procesarTurno(sesion, "procesa sol-004 y no la crees", dependencias(raiz, new ProveedorSimulado()))
  await procesarTurno(sesion, "¿qué es una OC retroactiva?", dependencias(raiz, new ModeloGuionado([{ texto: "Es una OC creada después de la factura." }])))
  const tarde = new ModeloGuionado([{ llamadas: [{ id: "x3", nombre: "oc_crear", argumentos: { caso: "sol-004", payload, confirmado: true } }] }, { texto: "?" }])
  const t = await procesarTurno(sesion, "confirmo", dependencias(raiz, tarde))
  assert.ok(t.toolCalls[0]?.compuerta)
  assert.equal(await ordenesCreadas(raiz), 0)
})

prueba("Qué cuenta como confirmación (ante la duda, no confirma)", () => {
  for (const si of ["confirmo", "Sí, créala", "ok", "dale", "Procede con la OC", "de acuerdo, confirmo sol-004"]) assert.ok(esConfirmacion(si), si)
  for (const no of ["no", "No la crees todavía", "espera", "si quieres muéstrame otra vez", "cancela", "confirmo que no"]) assert.ok(!esConfirmacion(no), no)
})

prueba("Con varios casos pendientes hay que nombrar cuál se confirma", () => {
  const ventana = [
    { caso: "sol-004", solicitud_id: "SOL-2026-004" },
    { caso: "sol-005", solicitud_id: "SOL-2026-005" },
  ]
  assert.deepEqual(casosAutorizados("confirmo", ventana), [])
  assert.deepEqual(casosAutorizados("confirmo sol-005", ventana), [ventana[1]])
  assert.deepEqual(casosAutorizados("confirmo SOL-2026-004", ventana), [ventana[0]])
  assert.deepEqual(casosAutorizados("confirmo", [ventana[0]!]), [ventana[0]])
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Topes y errores (CA1, CA5, costo)")

prueba("CA1: al llegar al tope de iteraciones responde con lo hecho y lo que falta", async () => {
  const raiz = await nuevaRaiz()
  const enBucle = new ModeloGuionado([{ llamadas: [{ id: "b", nombre: "oc_leer_paquete", argumentos: { caso: "sol-001" } }] }])
  const t = await procesarTurno(sesionNueva(raiz), "procesa sol-001", dependencias(raiz, enBucle, { maxIteraciones: 3 }))
  assert.equal(t.toolCalls.length, 3)
  assert.match(t.reply, /tope de 3 iteraciones/)
  assert.match(t.reply, /Falta: oc_validar/)
})

prueba("CA5: un error del proveedor se explica en el chat y la sesión sigue viva", async () => {
  const raiz = await nuevaRaiz()
  const sesion = sesionNueva(raiz)
  const caido = new ModeloGuionado([new ErrorProveedor("Gemini no respondió en 45 s. Intenta de nuevo.")])
  const t1 = await procesarTurno(sesion, "procesa sol-001", dependencias(raiz, caido))
  assert.match(t1.reply, /No pude completar la respuesta: Gemini no respondió/)
  const t2 = await procesarTurno(sesion, "procesa sol-001", dependencias(raiz, new ProveedorSimulado()))
  assert.match(t2.reply, /4500000001/)
})

prueba("Topes de costo: por sesión y global por día", async () => {
  const raiz = await nuevaRaiz()
  const caro = new ModeloGuionado([{ llamadas: [{ id: "c", nombre: "oc_leer_paquete", argumentos: { caso: "sol-001" } }], uso: { entrada: 900, salida: 200 } }])
  const porSesion = await procesarTurno(sesionNueva(raiz), "procesa sol-001", dependencias(raiz, caro, { maxTokensSesion: 1000 }))
  assert.match(porSesion.reply, /tope de 1\.000 tokens/)
  const diario = new PresupuestoDiario(1000)
  const enOtraSesion = await procesarTurno(sesionNueva(raiz), "procesa sol-001", dependencias(raiz, caro, { presupuesto: diario }))
  assert.match(enOtraSesion.reply, /tope diario/)
})

prueba("Herramienta inexistente o argumentos inválidos: error al modelo, sin ejecutar nada", async () => {
  const raiz = await nuevaRaiz()
  const torpe = new ModeloGuionado([
    { llamadas: [{ id: "t1", nombre: "oc_borrar_todo", argumentos: {} }, { id: "t2", nombre: "oc_crear", argumentos: { caso: "sol-001", payload: { total: 1 } } }] },
    { texto: "Perdón, no pude." },
  ])
  const t = await procesarTurno(sesionNueva(raiz), "procesa sol-001", dependencias(raiz, torpe))
  assert.deepEqual(t.toolCalls.map((l) => l.ok), [false, false])
  assert.match(String(t.toolCalls[0]?.resultado), /no existe/)
  assert.match(String(t.toolCalls[1]?.resultado), /Argumentos inválidos para oc_crear/)
  assert.equal(await ordenesCreadas(raiz), 0)
  const log = await readFile(path.join(raiz, "out", "log.jsonl"), "utf8")
  assert.match(log, /oc_borrar_todo/)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
grupo("Adaptador LLM: Gemini sin red y prompt")

prueba("Las definiciones de herramientas se llaman oc_<export> y su JSON Schema es compatible", () => {
  assert.deepEqual(DEFINICIONES.map((d) => d.nombre), ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload", "oc_crear"])
  const texto = JSON.stringify(DEFINICIONES.map((d) => esquemaCompatible(d.parametros)))
  assert.ok(!texto.includes('"const"') && !texto.includes('"$schema"') && !texto.includes('"pattern"'))
  assert.ok(texto.includes('"enum":["1000"]'), "z.literal pasa a enum")
  assert.ok(texto.includes('"type":["string","null"]'), "nullable pasa a tipo con null")
})

prueba("Gemini: la respuesta del modelo se reenvía intacta (firmas de pensamiento) y los resultados van juntos", () => {
  const original = { role: "model", parts: [{ functionCall: { id: "f1", name: "oc_leer_paquete", args: { caso: "sol-001" } }, thoughtSignature: "firma-opaca" }] }
  const historial: Mensaje[] = [
    { rol: "usuario", texto: "procesa sol-001" },
    { rol: "asistente", texto: "", llamadas: [{ id: "f1", nombre: "oc_leer_paquete", argumentos: { caso: "sol-001" } }], crudo: { proveedor: "gemini", valor: original } },
    { rol: "herramienta", idLlamada: "f1", nombre: "oc_leer_paquete", resultado: '{"ok":true,"data":{"x":1}}' },
    { rol: "herramienta", idLlamada: "local-2", nombre: "oc_validar", resultado: "texto no JSON" },
  ]
  const contenidos = aContenidos(historial)
  assert.equal(contenidos.length, 3)
  assert.equal(contenidos[1], original, "mismo objeto, sin tocar")
  assert.deepEqual(contenidos[2]?.parts?.map((p) => p.functionResponse?.id), ["f1", undefined])
  assert.deepEqual(contenidos[2]?.parts?.[1]?.functionResponse?.response, { resultado: "texto no JSON" })
})

prueba("Gemini: interpreta llamadas, texto y uso de tokens de una respuesta", () => {
  const r = Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: "model", parts: [{ text: "Voy a leer." }, { functionCall: { name: "oc_leer_paquete", args: { caso: "sol-002" } } }] } }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 60 },
  })
  const salida = desdeRespuesta(r)
  assert.equal(salida.texto, "Voy a leer.")
  assert.equal(salida.llamadas[0]?.nombre, "oc_leer_paquete")
  assert.ok(salida.llamadas[0]?.id.startsWith("local-"))
  assert.deepEqual(salida.uso, { entrada: 1200, salida: 100 })
  assert.throws(() => desdeRespuesta(Object.assign(new GenerateContentResponse(), { candidates: [{ finishReason: "SAFETY" }] })), /SAFETY/)
})

prueba("Gemini: errores claros y sin la clave (429, 401) aunque el mensaje original la incluya", async () => {
  // Clave falsa con un largo distinto al de las reales, para no disparar escáneres de secretos.
  await verificarOcultamiento("AIzaClaveFalsaDePrueba000000")
  // Una clave con otro formato (sin el prefijo AIza) también debe ocultarse.
  await verificarOcultamiento("AQ.Ab8RN6FAKEclave-con.formato_distinto.0123456789xyz")
})

async function verificarOcultamiento(claveFalsa: string): Promise<void> {
  const gemini = new ProveedorGemini(claveFalsa, "gemini-prueba", { timeoutMs: 1000, pensamiento: "low" })
  // Se fuerza la falla sin red reemplazando la llamada del SDK.
  const cliente = clienteSimulable(gemini)
  for (const [estado, patron] of [[429, /cuota/], [401, /clave de Gemini no es válida/], [400, /rechazó la solicitud \(400\)/]] as const) {
    cliente.models.generateContentStream = () => Promise.reject(new ApiError({ status: estado, message: `fallo con key=${claveFalsa}` }))
    const error = await gemini.enviar([{ rol: "usuario", texto: "hola" }], []).then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    assert.match(error, patron)
    assert.ok(!error.includes(claveFalsa), "la clave no debe aparecer")
  }
  if (claveFalsa.startsWith("AIza")) assert.equal(ocultarSecretos(`x ${claveFalsa} y`), "x [clave oculta] y")
}

type Flujo = AsyncGenerator<GenerateContentResponse>
/** Acceso al cliente interno del adaptador para simular respuestas del SDK sin red. */
function clienteSimulable(gemini: ProveedorGemini): { models: { generateContentStream: () => Promise<Flujo> } } {
  return (gemini as unknown as { cliente: { models: { generateContentStream: () => Promise<Flujo> } } }).cliente
}
const trozo = (datos: Partial<GenerateContentResponse>) => Object.assign(new GenerateContentResponse(), datos)
async function* emitir(...trozos: GenerateContentResponse[]): Flujo {
  for (const t of trozos) yield t
}

prueba("Gemini: arma la respuesta del streaming conservando cada parte (texto, llamada y firma)", async () => {
  const gemini = new ProveedorGemini("clave-de-prueba-cualquiera", "gemini-prueba", { timeoutMs: 1000, pensamiento: "low" })
  clienteSimulable(gemini).models.generateContentStream = async () =>
    emitir(
      trozo({ candidates: [{ content: { role: "model", parts: [{ text: "Voy a " }] } }] }),
      trozo({ candidates: [{ content: { role: "model", parts: [{ text: "leer." }, { functionCall: { name: "oc_leer_paquete", args: { caso: "sol-001" } }, thoughtSignature: "firma" }] } }] }),
      trozo({ candidates: [{ content: { role: "model", parts: [] }, finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30 } }),
    )
  const r = await gemini.enviar([{ rol: "usuario", texto: "procesa sol-001" }], [])
  assert.equal(r.texto, "Voy a leer.")
  assert.equal(r.llamadas[0]?.nombre, "oc_leer_paquete")
  assert.deepEqual(r.uso, { entrada: 900, salida: 30 })
  const partes = (r.crudo?.valor as { parts: Array<{ thoughtSignature?: string }> }).parts
  assert.equal(partes.length, 3, "las partes se guardan tal cual llegaron")
  assert.equal(partes[2]?.thoughtSignature, "firma")
})

prueba("Gemini: una llamada sin respuesta se corta por plazo y se reintenta una vez", async () => {
  const gemini = new ProveedorGemini("clave-de-prueba-cualquiera", "gemini-prueba", { timeoutMs: 100, pensamiento: "low" })
  const cliente = clienteSimulable(gemini)
  const sinRespuesta = () => new Promise<Flujo>(() => {})
  const respuesta = trozo({ candidates: [{ content: { role: "model", parts: [{ text: "listo" }] } }] })

  let llamadas = 0
  cliente.models.generateContentStream = () => (++llamadas === 1 ? sinRespuesta() : Promise.resolve(emitir(respuesta)))
  assert.equal((await gemini.enviar([{ rol: "usuario", texto: "hola" }], [])).texto, "listo")
  assert.equal(llamadas, 2, "el primer intento se colgó y el segundo respondió")

  cliente.models.generateContentStream = sinRespuesta
  const error = await gemini.enviar([{ rol: "usuario", texto: "hola" }], []).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  assert.match(error, /no respondió tras 2 intentos/)
})

prueba("El system prompt sale de agent/prompt.md + src/knowledge/ordenes-compra.md", () => {
  const sistema = construirSistema(RAIZ_PROYECTO)
  assert.match(sistema, /^# Agente de órdenes de compra SAP/)
  assert.match(sistema, /# Conocimiento del proceso: órdenes de compra en SAP/)
})
