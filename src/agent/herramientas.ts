import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter"
import { describirProblemas } from "../tools/lib/esquemas"
import { sha256 } from "../tools/lib/evidencia"
import { registrarLog } from "../tools/lib/registro"
import type { Contexto, Herramienta } from "../tools/lib/tipos"
import * as oc from "../tools/oc"

/**
 * Registro de herramientas: el modelo ve cada export de src/tools/oc.ts como `oc_<export>`
 * (contrato del PRD §6.2). El backend valida los argumentos con zod antes de ejecutar y, si no
 * cumplen, devuelve el error al modelo sin ejecutar nada.
 */

export interface HerramientaRegistrada {
  definicion: DefinicionHerramienta
  ejecutar(args: unknown, ctx: Contexto): Promise<string>
}

function registrar<A extends z.ZodRawShape>(archivo: string, exportado: string, h: Herramienta<A>): HerramientaRegistrada {
  const nombre = `${archivo}_${exportado}`
  const esquema = z.object(h.args)
  const { $schema: _version, ...parametros } = z.toJSONSchema(esquema, { io: "input" }) as Record<string, unknown>
  return {
    definicion: { nombre, descripcion: h.description, parametros },
    async ejecutar(args, ctx) {
      const r = esquema.safeParse(args)
      if (r.success) return h.execute(r.data, ctx)
      return rechazar(nombre, `Argumentos inválidos para ${nombre}: ${describirProblemas(r.error)}`, args, ctx)
    },
  }
}

// El tipo obliga a registrar cada export de src/tools/oc.ts: si se agrega una herramienta y no se registra, no compila.
const REGISTRO: { [K in keyof typeof oc]: HerramientaRegistrada } = {
  leer_paquete: registrar("oc", "leer_paquete", oc.leer_paquete),
  validar: registrar("oc", "validar", oc.validar),
  generar_evidencia: registrar("oc", "generar_evidencia", oc.generar_evidencia),
  construir_payload: registrar("oc", "construir_payload", oc.construir_payload),
  crear: registrar("oc", "crear", oc.crear),
}

export const HERRAMIENTAS: ReadonlyMap<string, HerramientaRegistrada> = new Map(Object.values(REGISTRO).map((h) => [h.definicion.nombre, h]))
export const DEFINICIONES: DefinicionHerramienta[] = [...HERRAMIENTAS.values()].map((h) => h.definicion)

/** Ejecuta una herramienta por nombre. Una herramienta inexistente también queda en el log (CA4). */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: Contexto): Promise<string> {
  const h = HERRAMIENTAS.get(nombre)
  if (h) return h.ejecutar(args, ctx)
  return rechazar(nombre, `La herramienta "${nombre}" no existe. Disponibles: ${[...HERRAMIENTAS.keys()].join(", ")}.`, args, ctx)
}

async function rechazar(nombre: string, error: string, args: unknown, ctx: Contexto): Promise<string> {
  let huella = "no-serializable"
  try {
    huella = sha256(JSON.stringify(args ?? null))
  } catch {
    // argumentos no serializables: se registra sin huella
  }
  await registrarLog(ctx.directory, { ts: new Date().toISOString(), sessionId: ctx.sessionId, herramienta: nombre, caso: null, ok: false, resumen: error, duracion_ms: 0, args_sha256: huella })
  return JSON.stringify({ ok: false, error })
}
