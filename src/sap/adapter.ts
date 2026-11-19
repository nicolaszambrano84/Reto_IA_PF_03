import type { OrdenCompra } from "./orden"

export type { OrdenCompra } from "./orden"

/**
 * Interfaz del adaptador SAP (obligatoria, PRD §7.4). Las herramientas solo conocen esta interfaz:
 * cambiar el SAP simulado por uno real (OData, BAPI o archivo de carga) no toca las herramientas.
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
