import type { SapAdapter } from "../../sap/adapter"
import { accion, CONFIG, nombreControl, type CodigoControl } from "./configuracion"
import type { CentroCosto, Derivado, Derivados, Paquete, ProveedorMaestro, Solicitud } from "./esquemas"
import type { Maestros } from "./maestros"
import { extraerCorreo, fechaLocal, formatoMonto, formatoPorcentaje, normalizarNit, normalizarNombre, normalizarTexto } from "./texto"

/**
 * HU-2: reglas de control RC1–RC10 (PRD §7.3) y tres controles adicionales (RX1–RX3).
 * Todo es determinista: mismas entradas → mismo resultado. El modelo nunca decide si una regla pasa.
 */

export type EstadoControl = "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"

export interface Control {
  codigo: CodigoControl
  regla: string
  estado: EstadoControl
  detalle: string
}

export interface Hallazgo {
  codigo: CodigoControl
  regla: string
  detalle: string
  accion_sugerida: string
  valores?: Record<string, string | number>
}

export interface ProveedorResuelto {
  codigo_sap: string
  nit: string
  nombre: string
  activo: boolean
  encontrado_por: "nit" | "nombre"
  condiciones_pago_default: string
  indicador_iva_default: string
}

export interface Validacion {
  solicitud_id: string
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  controles: Control[]
  proveedor: ProveedorResuelto | null
}

/** Resultado de buscar al proveedor (RC1). */
export interface BusquedaProveedor {
  criterio: "nit" | "nombre"
  nit_buscado: string | null
  proveedor: ProveedorResuelto | null
  /** Proveedor del maestro con el mismo nombre pero otro NIT: posible error o suplantación. */
  homonimo: ProveedorMaestro | null
}

/** RC1: por NIT si la solicitud lo trae; si no, por nombre normalizado. El estado lo responde SAP. */
export async function buscarProveedor(solicitud: Solicitud, maestros: Maestros, sap: SapAdapter): Promise<BusquedaProveedor> {
  const nitSolicitud = normalizarNit(solicitud.proveedor_nit)
  const criterio = nitSolicitud ? "nit" : "nombre"
  const nombre = normalizarNombre(solicitud.proveedor_nombre)
  const porNombre = maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombre) ?? null
  const nit = nitSolicitud ?? porNombre?.nit ?? null
  if (!nit) return { criterio, nit_buscado: null, proveedor: null, homonimo: null }

  const enSap = await sap.consultarProveedor(nit)
  const datos = maestros.proveedores.find((p) => p.nit === nit)
  const proveedor: ProveedorResuelto | null =
    enSap && datos
      ? {
          codigo_sap: enSap.codigo_sap,
          nit,
          nombre: datos.nombre,
          activo: enSap.activo,
          encontrado_por: criterio,
          condiciones_pago_default: datos.condiciones_pago_default,
          indicador_iva_default: datos.indicador_iva_default,
        }
      : null
  const homonimo = !proveedor && porNombre && porNombre.nit !== nit ? porNombre : null
  return { criterio, nit_buscado: nit, proveedor, homonimo }
}

interface Resultado {
  control: Control
  hallazgo?: Hallazgo
  derivado?: { campo: keyof Derivados; valor: Derivado }
}

export function evaluar(paquete: Paquete, maestros: Maestros, busqueda: BusquedaProveedor): Validacion {
  const s = paquete.solicitud
  const centro = maestros.centros.find((c) => c.centro_costo === s.centro_costo)
  const proveedor = busqueda.proveedor
  const dinero = (valor: number) => `${s.moneda} ${formatoMonto(valor)}`

  const resultados: Resultado[] = [
    rc1(busqueda, s),
    rc2(paquete, centro, maestros),
    rc3(paquete, centro, dinero),
    rc4(s, centro),
    rc5(paquete, dinero),
    rc6(s, proveedor, maestros),
    rc7(s, proveedor, maestros),
    rc8(paquete),
    rc9(paquete),
    rc10(s, dinero),
  ]
  const derivados: Derivados = {}
  for (const r of resultados) if (r.derivado) derivados[r.derivado.campo] = r.derivado.valor
  resultados.push(
    rx1(s.indicador_iva ?? derivados.indicador_iva?.valor ?? null, maestros),
    rx2(s.condiciones_pago ?? derivados.condiciones_pago?.valor ?? null, maestros),
    rx3(paquete, proveedor),
  )

  const hallazgos = (estado: EstadoControl) => resultados.flatMap((r) => (r.control.estado === estado && r.hallazgo ? [r.hallazgo] : []))
  const bloqueos = hallazgos("bloqueo")
  return {
    solicitud_id: s.solicitud_id,
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones: hallazgos("confirmacion"),
    derivados,
    retroactiva: esRetroactiva(paquete),
    controles: resultados.map((r) => r.control),
    proveedor,
  }
}

/** RC8: hay factura y es anterior a la solicitud. */
export function esRetroactiva(paquete: Paquete): boolean {
  return paquete.factura !== null && paquete.factura.fecha < paquete.solicitud.fecha_solicitud
}

// ── Constructores de resultados ──────────────────────────────────────────────────────────────

function ok(codigo: CodigoControl, detalle: string): Resultado {
  return { control: { codigo, regla: nombreControl(codigo), estado: "ok", detalle } }
}

function noAplica(codigo: CodigoControl, detalle: string): Resultado {
  return { control: { codigo, regla: nombreControl(codigo), estado: "no_aplica", detalle } }
}

function excepcion(
  codigo: CodigoControl,
  estado: "bloqueo" | "confirmacion",
  detalle: string,
  accion_sugerida: string,
  valores?: Record<string, string | number>,
): Resultado {
  const regla = nombreControl(codigo)
  return { control: { codigo, regla, estado, detalle }, hallazgo: { codigo, regla, detalle, accion_sugerida, ...(valores ? { valores } : {}) } }
}

// ── Reglas del PRD ───────────────────────────────────────────────────────────────────────────

function rc1(b: BusquedaProveedor, s: Solicitud): Resultado {
  if (!b.proveedor) {
    const motivo =
      b.criterio === "nit"
        ? `El NIT ${b.nit_buscado} (${s.proveedor_nombre}) no existe en el maestro de proveedores.`
        : `La solicitud no trae NIT y «${s.proveedor_nombre}» no coincide con ningún proveedor del maestro.`
    if (b.homonimo) {
      const detalle = `${motivo} Ojo: el nombre coincide con ${b.homonimo.nombre} (NIT ${b.homonimo.nit}).`
      return excepcion("RC1", "bloqueo", detalle, accion("RC1", "homonimo"), { nit: b.nit_buscado ?? "", nit_maestro: b.homonimo.nit })
    }
    return excepcion("RC1", "bloqueo", motivo, accion("RC1", "inexistente"), { nit: b.nit_buscado ?? "", proveedor: s.proveedor_nombre })
  }
  const p = b.proveedor
  if (!p.activo) return excepcion("RC1", "bloqueo", `${p.nombre} (código SAP ${p.codigo_sap}) está inactivo en el maestro.`, accion("RC1", "inactivo"))
  const como = p.encontrado_por === "nit" ? `por NIT ${p.nit}` : "por nombre (la solicitud no trae NIT)"
  return ok("RC1", `${p.nombre}: código SAP ${p.codigo_sap}, encontrado ${como} y activo.`)
}

function rc2(paquete: Paquete, centro: CentroCosto | undefined, maestros: Maestros): Resultado {
  const a = paquete.aprobacion
  const cc = paquete.solicitud.centro_costo
  if (!a) return excepcion("RC2", "bloqueo", "No llegó el correo de aprobación del líder.", accion("RC2", "sin_aprobacion"))
  if (!a.aprobado) return excepcion("RC2", "bloqueo", `El correo de ${a.de} no contiene una aprobación explícita («Aprobado»).`, accion("RC2", "no_aprobado"))
  if (!centro) return excepcion("RC2", "bloqueo", `No se puede verificar al aprobador: el centro de costo ${cc} no existe en el maestro.`, accion("RC4", "centro_inexistente"))

  const aprobador = buscarAprobador(centro, a.de)
  if (aprobador) return ok("RC2", `Aprobado por ${aprobador.nombre ?? a.de} (${a.de}), aprobador de ${cc}.`)

  // El aprobador no está en este centro. Se informa dónde sí aprueba: suele delatar un centro de costo mal puesto.
  const lista = centro.aprobadores.map((x) => `${x.email} (tope ${formatoMonto(x.tope)})`).join(", ")
  const otros = maestros.centros.filter((c) => c.centro_costo !== cc && buscarAprobador(c, a.de))
  const pista = otros.map((c) => `${a.de} sí es aprobador de ${c.centro_costo}${c.nombre ? ` (${c.nombre})` : ""} con tope ${formatoMonto(buscarAprobador(c, a.de)?.tope ?? 0)}.`)
  const sugerencia = otros.length ? ` Si el gasto corresponde a ${otros.map((c) => c.centro_costo).join(" o ")}, el solicitante debe corregir el centro de costo en la solicitud.` : ""
  const detalle = `${a.de} no es aprobador de ${cc}${centro.nombre ? ` (${centro.nombre})` : ""}; aprobadores del centro: ${lista}. ${pista.join(" ")}`.trim()
  return excepcion("RC2", "bloqueo", detalle, accion("RC2", "no_autorizado") + sugerencia)
}

function rc3(paquete: Paquete, centro: CentroCosto | undefined, dinero: (v: number) => string): Resultado {
  const a = paquete.aprobacion
  if (!a || !a.aprobado) return noAplica("RC3", "Sin aprobación válida no hay tope que verificar (ver RC2).")
  if (!centro) return noAplica("RC3", "El centro de costo no existe (ver RC4).")
  const { valor_total: valor, centro_costo: cc } = paquete.solicitud
  const aprobador = buscarAprobador(centro, a.de)
  const suficientes = centro.aprobadores.filter((x) => x.tope >= valor)
  const quienes = suficientes.map((x) => `${x.email} (tope ${formatoMonto(x.tope)})`).join(", ")
  const topeMaximo = Math.max(0, ...centro.aprobadores.map((x) => x.tope))

  if (!aprobador) {
    const resto = suficientes.length
      ? `Pueden aprobarlo en ${cc}: ${quienes}.`
      : `Además, ningún aprobador de ${cc} puede aprobar ${dinero(valor)}: el tope máximo del centro es ${formatoMonto(topeMaximo)}.`
    const clave = suficientes.length ? "sin_atribucion" : "sin_tope_en_centro"
    return excepcion("RC3", "bloqueo", `${a.de} no tiene tope de aprobación en ${cc}. ${resto}`, accion("RC3", clave), { valor_total: valor, tope_maximo_centro: topeMaximo })
  }
  if (valor > aprobador.tope) {
    const resto = suficientes.length ? ` Pueden aprobarlo: ${quienes}.` : ` Ningún aprobador de ${cc} tiene tope suficiente.`
    const clave = suficientes.length ? "excede" : "sin_tope_en_centro"
    return excepcion("RC3", "bloqueo", `${dinero(valor)} supera el tope de ${a.de} en ${cc} (${formatoMonto(aprobador.tope)}).${resto}`, accion("RC3", clave), { valor_total: valor, tope: aprobador.tope })
  }
  return ok("RC3", `${dinero(valor)} está dentro del tope de ${a.de} en ${cc} (${formatoMonto(aprobador.tope)}).`)
}

function rc4(s: Solicitud, centro: CentroCosto | undefined): Resultado {
  if (!centro) return excepcion("RC4", "bloqueo", `El centro de costo ${s.centro_costo} no existe en el maestro.`, accion("RC4", "centro_inexistente"))
  const pertenece = centro.subareas.some((x) => normalizarTexto(x) === normalizarTexto(s.subarea))
  if (!pertenece) {
    const detalle = `La subárea «${s.subarea}» no pertenece a ${s.centro_costo}; subáreas válidas: ${centro.subareas.join(", ")}.`
    return excepcion("RC4", "bloqueo", detalle, accion("RC4", "subarea"))
  }
  return ok("RC4", `«${s.subarea}» pertenece a ${s.centro_costo}${centro.nombre ? ` (${centro.nombre})` : ""}.`)
}

function rc5(paquete: Paquete, dinero: (v: number) => string): Resultado {
  const s = paquete.solicitud
  const c = paquete.cotizacion
  if (!c) return excepcion("RC5", "confirmacion", `No llegó la cotización del proveedor; la solicitud es por ${dinero(s.valor_total)}.`, accion("RC5", "sin_cotizacion"), { solicitud: s.valor_total })
  if (c.moneda !== s.moneda) {
    return excepcion("RC5", "confirmacion", `La cotización está en ${c.moneda} y la solicitud en ${s.moneda}.`, accion("RC5", "moneda"), { moneda_solicitud: s.moneda, moneda_cotizacion: c.moneda })
  }
  const tolerancia = CONFIG.tolerancias.cotizacion_pct
  const diferencia = Math.abs(c.total - s.valor_total)
  const pct = s.valor_total > 0 ? (diferencia / s.valor_total) * 100 : diferencia === 0 ? 0 : 100
  const cual = c.numero ? `La cotización ${c.numero}` : "La cotización"
  // Comparación exacta (sin división) para que un 2,00 % justo no falle por redondeo de punto flotante.
  if (diferencia * 100 > tolerancia * s.valor_total) {
    const detalle = `${cual} suma ${dinero(c.total)} y la solicitud ${dinero(s.valor_total)}: diferencia de ${dinero(diferencia)} (${formatoPorcentaje(pct)}), mayor al ${tolerancia} % permitido.`
    return excepcion("RC5", "confirmacion", detalle, accion("RC5", "diferencia"), {
      solicitud: s.valor_total,
      cotizacion: c.total,
      diferencia,
      diferencia_pct: Number(pct.toFixed(2)),
    })
  }
  return ok("RC5", `${cual}: ${dinero(c.total)} frente a ${dinero(s.valor_total)} de la solicitud (${formatoPorcentaje(pct)}).`)
}

function rc6(s: Solicitud, p: ProveedorResuelto | null, maestros: Maestros): Resultado {
  if (s.indicador_iva) return ok("RC6", `Indicador ${s.indicador_iva}${descripcionIva(s.indicador_iva, maestros)} informado en la solicitud.`)
  if (!p) return noAplica("RC6", "La solicitud no trae indicador de IVA y no hay proveedor en el maestro para derivarlo (ver RC1).")
  const valor = p.indicador_iva_default
  const detalle = `La solicitud no trae indicador de IVA; se propone ${valor}${descripcionIva(valor, maestros)}, el valor por defecto del proveedor en el maestro (${p.nombre}).`
  return {
    ...excepcion("RC6", "confirmacion", detalle, accion("RC6", "derivado"), { indicador_iva: valor }),
    derivado: { campo: "indicador_iva", valor: { valor, fuente: "maestro.proveedores", regla: "RC6", detalle: `Indicador de IVA por defecto de ${p.nombre}` } },
  }
}

function rc7(s: Solicitud, p: ProveedorResuelto | null, maestros: Maestros): Resultado {
  if (s.condiciones_pago) return ok("RC7", `Condición ${s.condiciones_pago}${descripcionPago(s.condiciones_pago, maestros)} informada en la solicitud.`)
  if (!p) return noAplica("RC7", "La solicitud no trae condiciones de pago y no hay proveedor en el maestro para derivarlas (ver RC1).")
  const valor = p.condiciones_pago_default
  const detalle = `La solicitud no trae condiciones de pago; se usa ${valor}${descripcionPago(valor, maestros)}, la condición por defecto del proveedor en el maestro (${p.nombre}); solo se informa.`
  return {
    control: { codigo: "RC7", regla: nombreControl("RC7"), estado: "derivado", detalle },
    derivado: { campo: "condiciones_pago", valor: { valor, fuente: "maestro.proveedores", regla: "RC7", detalle: `Condición de pago por defecto de ${p.nombre}` } },
  }
}

function rc8(paquete: Paquete): Resultado {
  const f = paquete.factura
  const fechaSolicitud = paquete.solicitud.fecha_solicitud
  if (!f) return noAplica("RC8", "No llegó factura con el paquete.")
  if (esRetroactiva(paquete)) {
    const detalle = `La factura ${f.numero} es del ${f.fecha}, anterior a la solicitud (${fechaSolicitud}): la OC sería retroactiva.`
    return excepcion("RC8", "confirmacion", detalle, accion("RC8", "retroactiva"), { fecha_factura: f.fecha, fecha_solicitud: fechaSolicitud })
  }
  return ok("RC8", `La factura ${f.numero} (${f.fecha}) no es anterior a la solicitud (${fechaSolicitud}).`)
}

function rc9(paquete: Paquete): Resultado {
  const a = paquete.aprobacion
  const fechaSolicitud = paquete.solicitud.fecha_solicitud
  if (!a) return noAplica("RC9", "Sin correo de aprobación (ver RC2).")
  // Se compara la fecha tal como está escrita en la zona horaria del correo (Colombia, -05:00), no en UTC.
  const fechaAprobacion = fechaLocal(a.fecha)
  if (!fechaAprobacion) return excepcion("RC9", "confirmacion", `No se pudo leer la fecha de la aprobación («${a.fecha}»).`, accion("RC9", "ilegible"))
  if (fechaAprobacion < fechaSolicitud) {
    const detalle = `La aprobación (${fechaAprobacion}) es anterior a la solicitud (${fechaSolicitud}).`
    return excepcion("RC9", "confirmacion", detalle, accion("RC9", "anterior"), { fecha_aprobacion: fechaAprobacion, fecha_solicitud: fechaSolicitud })
  }
  return ok("RC9", `Aprobación del ${fechaAprobacion}, igual o posterior a la solicitud (${fechaSolicitud}).`)
}

function rc10(s: Solicitud, dinero: (v: number) => string): Resultado {
  const calculado = s.cantidad * s.valor_unitario
  const diferencia = Math.abs(calculado - s.valor_total)
  if (diferencia > CONFIG.tolerancias.redondeo_total) {
    const detalle = `${s.cantidad} × ${dinero(s.valor_unitario)} = ${dinero(calculado)}, pero el valor total es ${dinero(s.valor_total)} (diferencia ${dinero(diferencia)}).`
    return excepcion("RC10", "bloqueo", detalle, accion("RC10", "incoherente"), { calculado, valor_total: s.valor_total })
  }
  return ok("RC10", `${s.cantidad} × ${dinero(s.valor_unitario)} = ${dinero(s.valor_total)}.`)
}

// ── Controles adicionales (no están en el PRD; no cambian el resultado de los 6 casos) ───────

function rx1(codigo: string | null, maestros: Maestros): Resultado {
  if (!codigo) return noAplica("RX1", "No hay indicador de IVA que verificar (ver RC6).")
  const indicador = maestros.indicadores.find((i) => i.codigo === codigo)
  if (!indicador) {
    const validos = maestros.indicadores.map((i) => i.codigo).join(", ")
    return excepcion("RX1", "bloqueo", `El indicador de IVA ${codigo} no existe en el maestro (válidos: ${validos}).`, accion("RX1", "invalido"))
  }
  return ok("RX1", `${codigo} = ${indicador.descripcion}.`)
}

function rx2(codigo: string | null, maestros: Maestros): Resultado {
  if (!codigo) return noAplica("RX2", "No hay condición de pago que verificar (ver RC7).")
  const condicion = maestros.condiciones.find((c) => c.codigo === codigo)
  if (!condicion) {
    const validas = maestros.condiciones.map((c) => c.codigo).join(", ")
    return excepcion("RX2", "bloqueo", `La condición de pago ${codigo} no existe en el maestro (válidas: ${validas}).`, accion("RX2", "invalido"))
  }
  return ok("RX2", `${codigo} = ${condicion.descripcion}.`)
}

function rx3(paquete: Paquete, p: ProveedorResuelto | null): Resultado {
  const nitCotizacion = paquete.cotizacion?.nit
  if (!nitCotizacion) return noAplica("RX3", "No hay NIT de cotización que comparar.")
  if (!p) return noAplica("RX3", "Sin proveedor en el maestro (ver RC1).")
  if (nitCotizacion !== p.nit) {
    const detalle = `La cotización trae el NIT ${nitCotizacion}, distinto al de ${p.nombre} (${p.nit}).`
    return excepcion("RX3", "confirmacion", detalle, accion("RX3", "distinto"), { nit_cotizacion: nitCotizacion, nit_proveedor: p.nit })
  }
  return ok("RX3", `La cotización trae el NIT ${nitCotizacion} de ${p.nombre}.`)
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────

function buscarAprobador(centro: CentroCosto, correo: string) {
  return centro.aprobadores.find((x) => extraerCorreo(x.email) === correo)
}

function descripcionIva(codigo: string, maestros: Maestros): string {
  const indicador = maestros.indicadores.find((i) => i.codigo === codigo)
  return indicador ? ` (${indicador.descripcion})` : ""
}

function descripcionPago(codigo: string, maestros: Maestros): string {
  const condicion = maestros.condiciones.find((c) => c.codigo === codigo)
  return condicion ? ` (${condicion.descripcion})` : ""
}
