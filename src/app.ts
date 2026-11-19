import { createHash, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import path from "node:path"
import { z } from "zod"
import { procesarTurno, type EventoCiclo, type RespuestaTurno } from "./agent/ciclo"
import { PresupuestoDiario } from "./agent/consumo"
import { AlmacenSesiones, IdSesionSchema, type Sesion } from "./agent/sesiones"
import type { ProveedorLLM } from "./llm/adapter"
import { describirProblemas } from "./tools/lib/esquemas"
import { listarCasos } from "./tools/lib/rutas"

/**
 * Servidor HTTP (PRD §6.4): API del chat, sesiones, salud, el front y los archivos de out/.
 * Sin frameworks: node:http funciona igual en Bun y en Node y reduce la superficie de ataque.
 */

export interface OpcionesApp {
  /** Raíz del proyecto: fixtures/ (lectura) y out/ (escritura). */
  raiz: string
  /** Carpeta del front (web/). */
  carpetaWeb: string
  proveedor: ProveedorLLM
  /** Aviso visible en el front (p. ej. modo simulado sin clave). */
  avisoProveedor: string | null
  sistema: string
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensDia: number
  mensajesPorMinuto: number
  /** Si se define, /api/* (salvo /api/health) y /out/* exigen la cabecera x-access-key. */
  claveAcceso?: string
  /** Si es true y no hay claveAcceso, la API queda bloqueada (falla cerrado) en vez de abierta. */
  exigirClave?: boolean
  /**
   * Número de proxies confiables delante de la app (0 = ninguno). La IP del cliente se toma de
   * X-Forwarded-For contando esos saltos desde la derecha. En Render son 2 (Cloudflare + su proxy).
   */
  proxiesConfiables: number
}

/** Intentos con una clave de acceso equivocada permitidos por IP antes de bloquearla (fuerza bruta). */
const MAX_FALLOS_CLAVE = 10
const VENTANA_FALLOS_CLAVE_MS = 15 * 60_000

const CuerpoChatSchema = z.object({
  sessionId: IdSesionSchema.optional(),
  message: z.string().trim().min(1, "el mensaje está vacío").max(4000, "el mensaje supera 4.000 caracteres"),
})

/** Solo se sirven estos archivos de out/ (nada de sesiones ni logs). */
const SALIDA_PERMITIDA = /^\/out\/(?:[a-z0-9][a-z0-9-]{0,63}\/(?:aprobacion\.(?:txt|pdf)|trazabilidad\.json)|control\.csv|sap\/ordenes\.jsonl)$/
const WEB: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/estilos.css": "estilos.css" }
const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
}

class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje)
  }
}

export function crearServidor(o: OpcionesApp): Server {
  const sesiones = new AlmacenSesiones(path.join(o.raiz, "out", "sesiones"))
  const presupuesto = new PresupuestoDiario(o.maxTokensDia)
  const limitador = new VentanaPorIp(o.mensajesPorMinuto, 60_000)
  const fallosClave = new VentanaPorIp(MAX_FALLOS_CLAVE, VENTANA_FALLOS_CLAVE_MS)

  /**
   * Clave de acceso con freno a la fuerza bruta: tras MAX_FALLOS_CLAVE intentos con una clave
   * equivocada, la IP queda bloqueada aunque después acierte (si no, el 200 delataría el acierto).
   * No enviar clave (primera carga del front) no cuenta como intento.
   */
  function rechazoDeClave(req: IncomingMessage): ErrorHttp | null {
    if (!o.claveAcceso) return null
    const ip = ipDe(req, o.proxiesConfiables)
    if (fallosClave.agotado(ip)) return new ErrorHttp(429, "Demasiados intentos con una clave de acceso inválida. Espera unos minutos.")
    if (claveValida(req, o.claveAcceso)) return null
    if (typeof req.headers["x-access-key"] === "string") fallosClave.registrar(ip)
    return new ErrorHttp(401, "Falta la clave de acceso o no es válida.")
  }

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cabecerasDeSeguridad(req, res)
    const ruta = new URL(req.url ?? "/", "http://localhost").pathname
    const metodo = req.method ?? "GET"

    if (metodo === "GET" && ruta === "/api/health") return responderJson(res, 200, { ok: true, provider: o.proveedor.nombre, model: o.proveedor.modelo })
    const web = WEB[ruta]
    if (metodo === "GET" && web) return servirArchivo(res, path.join(o.carpetaWeb, web))
    // Falla cerrado: un despliegue público que olvidó su clave no queda abierto (ni gasta la cuota del modelo).
    if (o.exigirClave && !o.claveAcceso) {
      return responderJson(res, 503, { error: "El servicio no tiene configurada su clave de acceso (ACCESS_KEY); la API está bloqueada hasta configurarla." })
    }
    const rechazo = rechazoDeClave(req)
    if (rechazo) return responderJson(res, rechazo.estado, { error: rechazo.message })

    if (metodo === "GET" && ruta === "/api/config") {
      return responderJson(res, 200, { provider: o.proveedor.nombre, model: o.proveedor.modelo, aviso: o.avisoProveedor, casos: await listarCasos(o.raiz) })
    }
    if (metodo === "POST" && ruta === "/api/chat") {
      const { sesion, mensaje } = await prepararTurno(req)
      return responderJson(res, 200, await ejecutarTurno(sesion, mensaje))
    }
    if (metodo === "POST" && ruta === "/api/chat/stream") return chatEnVivo(req, res)
    const sesionPedida = /^\/api\/sessions\/([^/]+)$/.exec(ruta)?.[1]
    if (metodo === "GET" && sesionPedida) {
      const sesion = await sesiones.obtener(decodeURIComponent(sesionPedida))
      if (!sesion) return responderJson(res, 404, { error: "No existe esa sesión." })
      return responderJson(res, 200, { id: sesion.id, creada: sesion.creada, turnos: sesion.turnos, pendientes: sesion.pendientes, tokens: sesion.tokens })
    }
    if (metodo === "GET" && SALIDA_PERMITIDA.test(ruta)) return servirArchivo(res, path.join(o.raiz, ...ruta.split("/").filter(Boolean)))
    return responderJson(res, 404, { error: "No encontrado." })
  }

  async function prepararTurno(req: IncomingMessage): Promise<{ sesion: Sesion; mensaje: string }> {
    if (!limitador.permitir(ipDe(req, o.proxiesConfiables))) throw new ErrorHttp(429, "Demasiados mensajes en poco tiempo. Espera un minuto.")
    const datos = CuerpoChatSchema.safeParse(await leerJson(req, 64 * 1024))
    if (!datos.success) throw new ErrorHttp(400, `Solicitud inválida: ${describirProblemas(datos.error)}`)
    const id = datos.data.sessionId
    const sesion = (id ? await sesiones.obtener(id) : undefined) ?? sesiones.crear(id)
    return { sesion, mensaje: datos.data.message }
  }

  async function ejecutarTurno(sesion: Sesion, mensaje: string, alEvento?: (e: EventoCiclo) => void): Promise<RespuestaTurno & { aviso: string | null }> {
    if (!sesiones.tomar(sesion.id)) throw new ErrorHttp(409, "Esta sesión ya está procesando un mensaje. Espera la respuesta.")
    try {
      const respuesta = await procesarTurno(sesion, mensaje, {
        proveedor: o.proveedor,
        sistema: o.sistema,
        directory: o.raiz,
        maxIteraciones: o.maxIteraciones,
        maxTokensSesion: o.maxTokensSesion,
        presupuesto,
        ...(alEvento ? { alEvento } : {}),
      })
      await sesiones.guardar(sesion)
      return { ...respuesta, aviso: o.avisoProveedor }
    } finally {
      sesiones.soltar(sesion.id)
    }
  }

  /** Igual que /api/chat, pero emite cada llamada a herramienta mientras ocurre (Server-Sent Events). */
  async function chatEnVivo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { sesion, mensaje } = await prepararTurno(req)
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" })
    const enviar = (evento: string, datos: unknown) => res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)
    const latido = setInterval(() => res.write(": latido\n\n"), 15000)
    try {
      enviar("sesion", { sessionId: sesion.id })
      enviar("fin", await ejecutarTurno(sesion, mensaje, (e) => enviar(e.tipo, e)))
    } catch (e) {
      enviar("error", { error: e instanceof ErrorHttp ? e.message : "Error interno del servidor." })
      if (!(e instanceof ErrorHttp)) console.error("Error en /api/chat/stream:", e instanceof Error ? e.message : e)
    } finally {
      clearInterval(latido)
      res.end()
    }
  }

  return createServer((req, res) => {
    atender(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end()
      if (e instanceof ErrorHttp) return responderJson(res, e.estado, { error: e.message })
      // Errores internos: detalle solo en la consola del servidor, nunca al cliente.
      console.error("Error interno:", e instanceof Error ? e.message : e)
      responderJson(res, 500, { error: "Error interno del servidor." })
    })
  })
}

// ── Utilidades HTTP ──────────────────────────────────────────────────────────────────────────

function cabecerasDeSeguridad(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  if (req.headers["x-forwarded-proto"] === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000")
}

function responderJson(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function servirArchivo(res: ServerResponse, ruta: string): Promise<void> {
  try {
    const contenido = await readFile(ruta)
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(ruta)] ?? "application/octet-stream", "Cache-Control": "no-store" })
    res.end(contenido)
  } catch {
    responderJson(res, 404, { error: "No encontrado." })
  }
}

/** Comparación en tiempo constante (sobre los hashes, para no filtrar ni siquiera el largo de la clave). */
function claveValida(req: IncomingMessage, clave: string): boolean {
  const recibida = req.headers["x-access-key"]
  if (typeof recibida !== "string") return false
  const huella = (t: string) => createHash("sha256").update(t).digest()
  return timingSafeEqual(huella(recibida), huella(clave))
}

/** Exigir application/json obliga al navegador a una verificación previa (CORS) en peticiones de otros sitios: protege contra CSRF. */
async function leerJson(req: IncomingMessage, maximo: number): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new ErrorHttp(415, "El cuerpo debe ser JSON (Content-Type: application/json).")
  }
  const partes: Buffer[] = []
  let total = 0
  for await (const parte of req as AsyncIterable<Buffer | string>) {
    const bloque = typeof parte === "string" ? Buffer.from(parte) : parte
    total += bloque.length
    if (total > maximo) throw new ErrorHttp(413, `El cuerpo supera ${Math.round(maximo / 1024)} KB.`)
    partes.push(bloque)
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8")) as unknown
  } catch {
    throw new ErrorHttp(400, "El cuerpo no es un JSON válido.")
  }
}

/**
 * IP del cliente para los límites. Cada proxy AGREGA al final de X-Forwarded-For la IP que se le
 * conectó, y lo que está a la izquierda lo pudo escribir el propio cliente. Por eso se cuentan los
 * saltos desde la derecha (como `trust proxy N` en Express) y nunca se toma el primer valor: un
 * atacante podría falsificarlo en cada petición y evadir el límite.
 * En Render: Cliente → Cloudflare → proxy de Render → app, y X-Forwarded-For = "<cliente>, <Cloudflare>".
 */
export function ipDe(req: Pick<IncomingMessage, "headers" | "socket">, proxiesConfiables: number): string {
  const directa = req.socket.remoteAddress ?? "desconocida"
  const reenviada = req.headers["x-forwarded-for"]
  if (proxiesConfiables < 1 || typeof reenviada !== "string") return directa
  const saltos = reenviada.split(",").map((ip) => ip.trim()).filter(Boolean)
  return saltos[Math.max(0, saltos.length - proxiesConfiables)] ?? directa
}

/** Ventana deslizante por IP: límite de mensajes al chat y de intentos fallidos de clave. */
class VentanaPorIp {
  private readonly marcas = new Map<string, number[]>()

  constructor(
    private readonly maximo: number,
    private readonly ventanaMs: number,
  ) {}

  /** ¿La IP ya agotó su cupo en la ventana? (no registra nada) */
  agotado(ip: string): boolean {
    return this.recientes(ip).length >= this.maximo
  }

  registrar(ip: string): void {
    const recientes = this.recientes(ip)
    recientes.push(Date.now())
    // Tope de memoria: con IP no falsificable, llenar el mapa exige miles de IP reales.
    if (this.marcas.size > 10_000) this.marcas.clear()
    this.marcas.set(ip, recientes)
  }

  /** Registra el evento solo si cabe en el cupo. */
  permitir(ip: string): boolean {
    if (this.agotado(ip)) return false
    this.registrar(ip)
    return true
  }

  private recientes(ip: string): number[] {
    const ahora = Date.now()
    return (this.marcas.get(ip) ?? []).filter((t) => ahora - t < this.ventanaMs)
  }
}
