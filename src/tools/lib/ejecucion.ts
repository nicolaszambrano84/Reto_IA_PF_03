import { z } from "zod"
import { describirProblemas } from "./esquemas"
import { sha256 } from "./evidencia"
import { registrarLog } from "./registro"
import { CasoSchema } from "./rutas"
import { ErrorNegocio, identificadorSesion, type Contexto } from "./tipos"

/**
 * Envoltorio común de todas las herramientas (contrato del PRD §6.2):
 * 1. valida los argumentos con zod (aunque el servidor ya lo hizo: demo.ts y modulo/ llaman directo);
 * 2. nunca lanza: todo termina en `{ ok: true, data }` o `{ ok: false, error }` serializado;
 * 3. deja una línea en out/log.jsonl (CA4).
 */

export interface Exito<T> {
  data: T
  /** Una línea para el log de auditoría. */
  resumen: string
}

export async function ejecutar<A extends z.ZodRawShape, T>(
  nombre: string,
  esquema: A,
  crudo: unknown,
  ctx: Contexto,
  cuerpo: (args: z.infer<z.ZodObject<A>>) => Promise<Exito<T>>,
): Promise<string> {
  const inicio = Date.now()
  let respuesta: { ok: true; data: T } | { ok: false; error: string }
  let resumen: string

  const args = z.object(esquema).safeParse(crudo)
  if (!args.success) {
    resumen = `Argumentos inválidos para ${nombre}: ${describirProblemas(args.error)}`
    respuesta = { ok: false, error: resumen }
  } else {
    try {
      const resultado = await cuerpo(args.data)
      respuesta = { ok: true, data: resultado.data }
      resumen = resultado.resumen
    } catch (e) {
      resumen = mensajeDeError(nombre, e)
      respuesta = { ok: false, error: resumen }
    }
  }

  await registrarLog(ctx.directory, {
    ts: new Date(inicio).toISOString(),
    sessionId: identificadorSesion(ctx),
    herramienta: nombre,
    caso: casoDe(crudo),
    ok: respuesta.ok,
    resumen,
    duracion_ms: Date.now() - inicio,
    args_sha256: huella(crudo),
  })
  return JSON.stringify(respuesta)
}

/** Errores de negocio tal cual; los inesperados, sin trazas internas y recortados. */
function mensajeDeError(nombre: string, e: unknown): string {
  if (e instanceof ErrorNegocio) return e.message
  const detalle = e instanceof Error ? e.message : String(e)
  return `Error inesperado en ${nombre}: ${detalle.slice(0, 300)}`
}

function casoDe(crudo: unknown): string | null {
  if (typeof crudo !== "object" || crudo === null || !("caso" in crudo)) return null
  const caso = crudo.caso
  return typeof caso === "string" && CasoSchema.safeParse(caso).success ? caso : null
}

function huella(crudo: unknown): string {
  try {
    return sha256(JSON.stringify(crudo ?? null))
  } catch {
    return "no-serializable"
  }
}
