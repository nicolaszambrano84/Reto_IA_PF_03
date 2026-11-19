import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { conCandado } from "../tools/lib/candado"
import { CONFIG } from "../tools/lib/configuracion"
import { cargarMaestros } from "../tools/lib/maestros"
import { leerTextoOpcional, rutaSalida } from "../tools/lib/rutas"
import { ErrorNegocio } from "../tools/lib/tipos"
import type { OrdenCompra, SapAdapter } from "./adapter"

/** Una línea de out/sap/ordenes.jsonl. */
const RegistroOrdenSchema = z.object({
  numero_oc: z.string().regex(/^\d+$/),
  fecha: z.string(),
  solicitud_id: z.string(),
  orden: z.unknown(),
})
type RegistroOrden = z.infer<typeof RegistroOrdenSchema>

/**
 * SAP simulado sobre archivos (PRD §7.4). Numera desde 4500000001 y escribe en out/sap/ordenes.jsonl.
 * El diseño del adaptador real (OData / BAPI / archivo de carga) está en SOLUCION.md.
 */
export class SapSimulado implements SapAdapter {
  constructor(private readonly directory: string) {}

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const { proveedores } = await cargarMaestros(this.directory)
    const proveedor = proveedores.find((p) => p.nit === nit)
    return proveedor ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const orden = (await this.leerOrdenes()).find((o) => o.solicitud_id === solicitud_id)
    return orden ? { numero_oc: orden.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return conCandado("sap-numeracion", async () => {
      const ordenes = await this.leerOrdenes()
      const solicitud_id = orden.referencia.solicitud_id
      // Defensa en profundidad: aunque la herramienta ya verificó, SAP tampoco acepta una referencia repetida.
      if (ordenes.some((o) => o.solicitud_id === solicitud_id)) {
        throw new ErrorNegocio(`SAP rechazó la orden: ya existe una OC para ${solicitud_id}.`)
      }
      const ultimo = Math.max(CONFIG.sap.numero_oc_inicial - 1, ...ordenes.map((o) => Number(o.numero_oc)))
      const registro = { numero_oc: String(ultimo + 1), fecha: new Date().toISOString(), solicitud_id, orden }
      const ruta = this.rutaOrdenes()
      await mkdir(path.dirname(ruta), { recursive: true })
      await appendFile(ruta, `${JSON.stringify(registro)}\n`, "utf8")
      return { numero_oc: registro.numero_oc, fecha: registro.fecha }
    })
  }

  private rutaOrdenes(): string {
    return rutaSalida(this.directory, "sap", "ordenes.jsonl")
  }

  /** Si el archivo está dañado no se adivina: es preferible fallar a repetir un número de OC. */
  private async leerOrdenes(): Promise<RegistroOrden[]> {
    const texto = await leerTextoOpcional(this.rutaOrdenes())
    if (!texto) return []
    return texto
      .split("\n")
      .filter((linea) => linea.trim() !== "")
      .map((linea, i) => {
        const registro = RegistroOrdenSchema.safeParse(intentarJson(linea))
        if (!registro.success) throw new ErrorNegocio(`out/sap/ordenes.jsonl está dañado en la línea ${i + 1}; no se crean OC para no repetir números.`)
        return registro.data
      })
  }
}

function intentarJson(linea: string): unknown {
  try {
    return JSON.parse(linea) as unknown
  } catch {
    return null
  }
}
