import type { Configuracion } from "../config"
import type { ProveedorLLM } from "./adapter"
import { ProveedorGemini } from "./gemini"
import { ProveedorSimulado } from "./simulado"

/** Elige el proveedor según la configuración. El ciclo del agente no sabe cuál quedó. */
export function crearProveedor(c: Configuracion): { proveedor: ProveedorLLM; aviso: string | null } {
  if (c.LLM_PROVIDER === "simulado") {
    return { proveedor: new ProveedorSimulado(), aviso: "Modo simulado: el agente responde con reglas fijas, sin modelo de lenguaje." }
  }
  if (c.GEMINI_API_KEY) {
    const opciones = { timeoutMs: c.LLM_TIMEOUT_MS, pensamiento: c.GEMINI_THINKING }
    return { proveedor: new ProveedorGemini(c.GEMINI_API_KEY, c.GEMINI_MODEL, opciones), aviso: null }
  }
  if (c.LLM_PROVIDER === "gemini") throw new Error("LLM_PROVIDER=gemini requiere GEMINI_API_KEY. Revisa .env.example.")
  return { proveedor: new ProveedorSimulado(), aviso: "No hay GEMINI_API_KEY: el agente funciona en modo simulado (reglas fijas, sin modelo de lenguaje)." }
}
