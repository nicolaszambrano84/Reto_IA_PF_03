import {
  ApiError,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type Part,
} from "@google/genai"
import {
  ErrorProveedor,
  ocultarSecretos,
  type DefinicionHerramienta,
  type LlamadaHerramienta,
  type Mensaje,
  type ProveedorLLM,
  type RespuestaModelo,
} from "./adapter"

/**
 * Implementación del adaptador para Google Gemini con el SDK oficial (@google/genai), API
 * generateContent en streaming y sin estado: el historial vive en nuestro backend, no en Google.
 */

export interface OpcionesGemini {
  timeoutMs: number
  pensamiento: "low" | "medium" | "high"
}

const NIVELES = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const
/** Intentos ante una llamada sin respuesta (los 429 y 5xx los reintenta el SDK por su cuenta). */
const INTENTOS_ANTE_CUELGUE = 2

export class ProveedorGemini implements ProveedorLLM {
  readonly nombre = "gemini"
  private readonly cliente: GoogleGenAI
  /** Oculta la clave configurada en cualquier texto de error, sea cual sea su formato. */
  private readonly ocultar: (texto: string) => string

  constructor(
    apiKey: string,
    readonly modelo: string,
    private readonly opciones: OpcionesGemini,
  ) {
    this.ocultar = (texto) => ocultarSecretos(texto.split(apiKey).join("[clave oculta]"))
    this.cliente = new GoogleGenAI({
      apiKey,
      // Reintento con espera exponencial ante límites de uso (429) o caídas momentáneas (5xx).
      httpOptions: { timeout: opciones.timeoutMs, retryOptions: { attempts: 2, initialDelay: 2000, maxDelay: 8000, httpStatusCodes: [429, 500, 502, 503, 504] } },
    })
  }

  /**
   * En las pruebas con la clave real, algunas llamadas quedaron sin respuesta mientras las sanas tardan
   * 2–8 s. Por eso cada intento tiene un plazo corto y, si vence, se reintenta una vez.
   */
  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    for (let intento = 1; ; intento++) {
      try {
        return await this.intentar(mensajes, herramientas)
      } catch (e) {
        if (!(e instanceof ErrorProveedor) || !e.reintentable) throw e
        if (intento >= INTENTOS_ANTE_CUELGUE) {
          throw new ErrorProveedor(`Gemini no respondió tras ${INTENTOS_ANTE_CUELGUE} intentos. Intenta de nuevo en un momento.`)
        }
      }
    }
  }

  private async intentar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    // Plazo absoluto del intento. Se impone con Promise.race además de abortar la petición: así el
    // ciclo siempre avanza aunque el SDK no termine por su cuenta.
    const limiteMs = this.opciones.timeoutMs + Math.min(5000, this.opciones.timeoutMs)
    const controlador = new AbortController()
    let temporizador: ReturnType<typeof setTimeout> | undefined
    const vencido = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => {
        controlador.abort()
        rechazar(new ErrorProveedor(`Gemini no respondió en ${Math.round(limiteMs / 1000)} s.`, true))
      }, limiteMs)
    })
    const inicio = Date.now()
    let respuesta: GenerateContentResponse
    try {
      // Se usa la variante en streaming: en las pruebas con la clave real, la llamada sin streaming quedó
      // colgada de forma repetible en un caso (sol-001) que en streaming respondió en 5 s.
      const llamada = this.recibirCompleta({
        model: this.modelo,
        contents: aContenidos(mensajes),
        config: {
          systemInstruction: mensajes.flatMap((m) => (m.rol === "sistema" ? [m.texto] : [])).join("\n\n"),
          ...(herramientas.length > 0
            ? {
                tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: esquemaCompatible(h.parametros) })) }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
              }
            : {}),
          automaticFunctionCalling: { disable: true },
          // Sin continuaciones automáticas: el SDK podría reenviar sin límite si el modelo no termina.
          automaticContinuation: false,
          abortSignal: controlador.signal,
          thinkingConfig: { thinkingLevel: NIVELES[this.opciones.pensamiento] },
          maxOutputTokens: 8192,
          // Minimización de datos: pide a Google no registrar esta solicitud.
          store: false,
        },
      })
      respuesta = await Promise.race([llamada, vencido])
    } catch (e) {
      if (e instanceof ErrorProveedor) throw e
      throw describirFallo(e, this.opciones.timeoutMs, this.ocultar)
    } finally {
      clearTimeout(temporizador)
    }
    if (process.env.GEMINI_DEBUG === "1") diagnosticar(respuesta, Date.now() - inicio)
    return desdeRespuesta(respuesta)
  }

  /** Consume el streaming y arma una sola respuesta. Las partes se conservan tal cual (las firmas pueden venir en cualquiera). */
  private async recibirCompleta(parametros: GenerateContentParameters): Promise<GenerateContentResponse> {
    const partes: Part[] = []
    let ultimo: GenerateContentResponse | undefined
    for await (const trozo of await this.cliente.models.generateContentStream(parametros)) {
      ultimo = trozo
      partes.push(...(trozo.candidates?.[0]?.content?.parts ?? []))
    }
    const finishReason = ultimo?.candidates?.[0]?.finishReason
    return Object.assign(new GenerateContentResponse(), {
      candidates: [{ content: { role: "model", parts: partes }, ...(finishReason ? { finishReason } : {}) }],
      ...(ultimo?.usageMetadata ? { usageMetadata: ultimo.usageMetadata } : {}),
      ...(ultimo?.promptFeedback ? { promptFeedback: ultimo.promptFeedback } : {}),
    })
  }
}

/** Historial propio → contenidos de Gemini. Las respuestas del modelo se devuelven intactas (firmas de pensamiento). */
export function aContenidos(mensajes: Mensaje[]): Content[] {
  const contenidos: Content[] = []
  for (const m of mensajes) {
    if (m.rol === "sistema") continue
    if (m.rol === "usuario") {
      contenidos.push({ role: "user", parts: [{ text: m.texto }] })
    } else if (m.rol === "asistente") {
      const original = m.crudo?.proveedor === "gemini" && esContenido(m.crudo.valor) ? m.crudo.valor : null
      contenidos.push(original ?? { role: "model", parts: partesDelAsistente(m.texto, m.llamadas) })
    } else {
      const parte: Part = { functionResponse: { name: m.nombre, response: comoObjeto(m.resultado), ...(esIdLocal(m.idLlamada) ? {} : { id: m.idLlamada }) } }
      const ultimo = contenidos.at(-1)
      // Todas las respuestas de un mismo turno van juntas en un solo contenido del usuario.
      if (ultimo?.role === "user" && ultimo.parts?.every((p) => p.functionResponse)) ultimo.parts.push(parte)
      else contenidos.push({ role: "user", parts: [parte] })
    }
  }
  return contenidos
}

export function desdeRespuesta(r: GenerateContentResponse): RespuestaModelo {
  const candidato = r.candidates?.[0]
  const contenido = candidato?.content
  const partes = contenido?.parts ?? []
  const texto = partes
    .flatMap((p) => (typeof p.text === "string" && !p.thought ? [p.text] : []))
    .join("")
    .trim()
  const llamadas: LlamadaHerramienta[] = partes.flatMap((p, i) =>
    p.functionCall?.name ? [{ id: p.functionCall.id ?? `local-${i}-${Date.now()}`, nombre: p.functionCall.name, argumentos: p.functionCall.args ?? {} }] : [],
  )
  const uso = { entrada: r.usageMetadata?.promptTokenCount ?? 0, salida: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0) }

  if (!texto && llamadas.length === 0) {
    const bloqueo = r.promptFeedback?.blockReason
    const motivo = bloqueo ? `bloqueó la solicitud (${bloqueo})` : `terminó sin respuesta (${candidato?.finishReason ?? "sin motivo"})`
    throw new ErrorProveedor(`Gemini ${motivo}. Reformula el mensaje o intenta de nuevo.`)
  }
  return { texto, llamadas, uso, ...(contenido ? { crudo: { proveedor: "gemini", valor: contenido } } : {}) }
}

/**
 * JSON Schema de zod → subconjunto documentado por Gemini: `const` pasa a `enum`, las uniones con null
 * pasan a `type: [x, "null"]` y se quitan palabras clave no documentadas. La validación real la hace
 * zod en el servidor; esto solo orienta al modelo.
 */
const PERMITIDAS = new Set(["type", "description", "title", "properties", "required", "additionalProperties", "items", "enum", "format", "minimum", "maximum", "minItems", "maxItems", "anyOf"])

export function esquemaCompatible(esquema: unknown): unknown {
  if (Array.isArray(esquema)) return esquema.map(esquemaCompatible)
  if (typeof esquema !== "object" || esquema === null) return esquema
  const original = esquema as Record<string, unknown>
  const opciones = Array.isArray(original.anyOf) ? (original.anyOf as unknown[]) : null
  if (opciones && opciones.length === 2 && opciones.some(esNulo)) {
    const otro = opciones.find((o) => !esNulo(o))
    const base = esquemaCompatible(otro) as Record<string, unknown>
    return { ...base, type: [base.type, "null"], ...(original.description ? { description: original.description } : {}) }
  }
  const salida: Record<string, unknown> = {}
  for (const [clave, valor] of Object.entries(original)) {
    if (clave === "const") salida.enum = [valor]
    else if (clave === "properties" && typeof valor === "object" && valor !== null) {
      salida.properties = Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, esquemaCompatible(v)]))
    } else if (PERMITIDAS.has(clave)) salida[clave] = esquemaCompatible(valor)
  }
  return salida
}

/** GEMINI_DEBUG=1: motivo de finalización y tamaños, sin contenido (para diagnosticar sin exponer datos). */
function diagnosticar(r: GenerateContentResponse, ms: number): void {
  const candidato = r.candidates?.[0]
  const partes = candidato?.content?.parts ?? []
  const llamadas = partes.flatMap((p) => (p.functionCall ? [`${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {}).length} car.)`] : []))
  const u = r.usageMetadata
  console.error(
    `[gemini] ${ms} ms · fin=${candidato?.finishReason ?? "?"} · entrada=${u?.promptTokenCount ?? 0} salida=${u?.candidatesTokenCount ?? 0} pensamiento=${u?.thoughtsTokenCount ?? 0} · llamadas=${llamadas.join(", ") || "ninguna"} · texto=${partes.reduce((n, p) => n + (p.text?.length ?? 0), 0)} car.`,
  )
}

function esNulo(valor: unknown): boolean {
  return typeof valor === "object" && valor !== null && (valor as Record<string, unknown>).type === "null"
}

function partesDelAsistente(texto: string, llamadas: LlamadaHerramienta[]): Part[] {
  const partes: Part[] = texto ? [{ text: texto }] : []
  for (const l of llamadas) partes.push({ functionCall: { name: l.nombre, args: l.argumentos, ...(esIdLocal(l.id) ? {} : { id: l.id }) } })
  return partes
}

/** Ids que generamos nosotros cuando el modelo no envía uno: no se devuelven a Gemini. */
function esIdLocal(id: string): boolean {
  return id.startsWith("local-")
}

function esContenido(valor: unknown): valor is Content {
  return typeof valor === "object" && valor !== null && Array.isArray((valor as Content).parts)
}

function comoObjeto(resultado: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(resultado)
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) return valor as Record<string, unknown>
  } catch {
    // no es JSON: se envía como texto
  }
  return { resultado }
}

/** Traduce fallas de red o del API a un mensaje claro para el chat (CA5). Nunca incluye la clave. */
function describirFallo(e: unknown, timeoutMs: number, ocultar: (texto: string) => string): ErrorProveedor {
  if (e instanceof ApiError) {
    if (e.status === 429) return new ErrorProveedor("Gemini rechazó la solicitud por límite de uso (cuota). Espera un momento y vuelve a intentar.")
    if (e.status === 401 || e.status === 403) return new ErrorProveedor("La clave de Gemini no es válida o no tiene permisos. Revisa GEMINI_API_KEY en el servidor.")
    if (e.status >= 500) return new ErrorProveedor(`Gemini no está disponible en este momento (${e.status}). Intenta de nuevo en unos segundos.`)
    return new ErrorProveedor(`Gemini rechazó la solicitud (${e.status}): ${ocultar(e.message).slice(0, 240)}`)
  }
  const nombre = e instanceof Error ? e.name : ""
  const texto = e instanceof Error ? e.message : String(e)
  if (nombre === "AbortError" || nombre === "TimeoutError" || /timed? ?out|aborted/i.test(texto)) {
    return new ErrorProveedor(`Gemini no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`)
  }
  return new ErrorProveedor(`No se pudo contactar a Gemini: ${ocultar(texto).slice(0, 240)}`)
}
