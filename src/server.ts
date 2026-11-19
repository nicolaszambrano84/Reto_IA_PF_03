import path from "node:path"
import { construirSistema } from "./agent/prompt"
import { crearServidor } from "./app"
import { cargarArchivoEnv, leerConfiguracion, RAIZ } from "./config"
import { crearProveedor } from "./llm/proveedor"

/**
 * Punto de entrada:  bun run dev  (o con Node 20+: npm run dev:node).
 * Levanta en un solo proceso el backend (API + ciclo del agente) y el front de chat.
 */
cargarArchivoEnv(path.join(RAIZ, ".env"))
const config = leerConfiguracion()
const { proveedor, aviso } = crearProveedor(config)

const servidor = crearServidor({
  raiz: RAIZ,
  carpetaWeb: path.join(RAIZ, "web"),
  proveedor,
  avisoProveedor: aviso,
  sistema: construirSistema(RAIZ),
  maxIteraciones: config.MAX_ITERACIONES,
  maxTokensSesion: config.MAX_TOKENS_SESION,
  maxTokensDia: config.MAX_TOKENS_DIA,
  mensajesPorMinuto: config.MAX_MENSAJES_POR_MINUTO,
  ...(config.ACCESS_KEY ? { claveAcceso: config.ACCESS_KEY } : {}),
  exigirClave: config.EXIGIR_ACCESS_KEY === "1",
  proxiesConfiables: config.TRUST_PROXY,
})

if (config.EXIGIR_ACCESS_KEY === "1" && !config.ACCESS_KEY) {
  console.error("ATENCIÓN: EXIGIR_ACCESS_KEY=1 pero falta ACCESS_KEY. La API queda bloqueada (503) hasta configurarla.")
}

servidor.listen(config.PORT, () => {
  console.log(`Agente de órdenes de compra en http://localhost:${config.PORT}`)
  console.log(`Proveedor: ${proveedor.nombre} (${proveedor.modelo})${config.ACCESS_KEY ? " · protegido con clave de acceso" : ""}`)
  if (aviso) console.log(`Aviso: ${aviso}`)
})

process.on("SIGTERM", () => servidor.close(() => process.exit(0)))
