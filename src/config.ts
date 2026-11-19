import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/**
 * Configuración del servidor, leída solo de variables de entorno (y de .env si existe).
 * Las claves nunca se escriben en logs ni respuestas; /api/health muestra solo proveedor y modelo.
 */

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Lee .env sin dependencias y sin pisar variables ya definidas (Bun ya lo carga; Node no). */
export function cargarArchivoEnv(ruta: string): void {
  if (!existsSync(ruta)) return
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linea)
    if (!m?.[1] || linea.trim().startsWith("#")) continue
    const valor = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2")
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor
  }
}

const entero = (minimo: number, porDefecto: number) => z.coerce.number().int().min(minimo).default(porDefecto)

const ConfigSchema = z.object({
  PORT: entero(1, 3000),
  /** auto = Gemini si hay clave; si no, el modelo simulado (sin LLM), con aviso visible. */
  LLM_PROVIDER: z.enum(["auto", "gemini", "simulado"]).default("auto"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_THINKING: z.enum(["low", "medium", "high"]).default("low"),
  /** Plazo por intento de llamada al modelo; si vence, se reintenta una vez. */
  LLM_TIMEOUT_MS: entero(1000, 30000),
  /** CA1: tope de iteraciones modelo → herramientas por turno. */
  MAX_ITERACIONES: entero(1, 25),
  /** Topes de costo: por sesión y global por día (una sesión nueva no salta el global). */
  MAX_TOKENS_SESION: entero(1000, 400000),
  MAX_TOKENS_DIA: entero(1000, 3000000),
  MAX_MENSAJES_POR_MINUTO: entero(1, 12),
  /** Si se define, /api/* y /out/* exigen la cabecera x-access-key. Mínimo 16 caracteres. */
  ACCESS_KEY: z.string().min(16).optional(),
  /** "1" en despliegues públicos: sin ACCESS_KEY la API queda bloqueada (falla cerrado) en vez de abierta. */
  EXIGIR_ACCESS_KEY: z.enum(["0", "1"]).default("0"),
  /** Proxies confiables delante de la app (0 = ninguno; Render = 2: Cloudflare + su proxy) para la IP del cliente. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
})

export type Configuracion = z.infer<typeof ConfigSchema>

export function leerConfiguracion(entorno: NodeJS.ProcessEnv = process.env): Configuracion {
  // Una variable vacía en .env ("GEMINI_API_KEY=") cuenta como no definida.
  const definidas = Object.fromEntries(Object.entries(entorno).filter(([, v]) => v !== undefined && v.trim() !== ""))
  const r = ConfigSchema.safeParse(definidas)
  if (!r.success) {
    // Se nombran las variables con problema, nunca sus valores.
    const variables = [...new Set(r.error.issues.map((i) => String(i.path[0])))].join(", ")
    throw new Error(`Configuración inválida en: ${variables}. Revisa .env.example.`)
  }
  return r.data
}
