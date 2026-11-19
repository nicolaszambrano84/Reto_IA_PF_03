import type { z } from "zod"

/** Contexto que recibe cada herramienta (contrato del PRD §6.2). */
export interface Contexto {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí; nunca se usan rutas absolutas. */
  directory: string
  /** Sesión del chat que pidió la ejecución (en la demo: "demo"). */
  sessionId: string
}

/** Forma de una herramienta según el contrato del PRD: el modelo la ve como `oc_<export>`. */
export interface Herramienta<A extends z.ZodRawShape> {
  /** Una frase: es lo único que el modelo lee para decidir cuándo llamarla. */
  description: string
  /** Esquemas zod de los argumentos, con `.describe()` en cada campo. */
  args: A
  /** Devuelve JSON serializado `{ ok: true, data }` o `{ ok: false, error }`. Nunca lanza. */
  execute(args: z.infer<z.ZodObject<A>>, ctx: Contexto): Promise<string>
}

/** Solo ayuda al tipado: devuelve la herramienta tal cual, sin agregar comportamiento. */
export function herramienta<A extends z.ZodRawShape>(definicion: Herramienta<A>): Herramienta<A> {
  return definicion
}

/** Error esperado del negocio: su mensaje se muestra tal cual al usuario (sin trazas internas). */
export class ErrorNegocio extends Error {
  override name = "ErrorNegocio"
}

/**
 * Identificador de la sesión. Acepta también `sessionID`, el nombre que usan algunas plataformas de
 * agentes, para que el módulo reutilizable funcione fuera de este servidor.
 */
export function identificadorSesion(ctx: Contexto): string {
  const alterno = (ctx as Contexto & { sessionID?: unknown }).sessionID
  return ctx.sessionId || (typeof alterno === "string" ? alterno : "") || "sin-sesion"
}
