/**
 * Ejecuta todas las pruebas:  bun run test   (con Node: npm run test:node)
 * No usan ningún modelo de lenguaje ni clave de proveedor.
 */
import { ejecutarPruebas } from "./arnes"
import "./herramientas.prueba"
import "./ciclo.prueba"
import "./servidor.prueba"
import "./modulo.prueba"

await ejecutarPruebas()
