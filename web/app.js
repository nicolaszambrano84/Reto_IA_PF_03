/**
 * Front del agente de órdenes de compra (PRD §6.1): historial, entrada, indicador de "pensando",
 * cada llamada a herramienta (nombre, argumentos y resultado resumido) y la confirmación resaltada.
 * Sin dependencias ni compilación. Todo texto del servidor o del modelo se escapa antes de mostrarse
 * (defensa contra XSS); la CSP del servidor además prohíbe scripts en línea.
 */
"use strict"

const PROMPT_DEMO =
  'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.'

const estado = { sessionId: leerAlmacen("sessionId"), clave: leerAlmacen("claveAcceso") || "", ocupado: false }
const $ = (id) => document.getElementById(id)

// ── Arranque ─────────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  $("formulario").addEventListener("submit", (e) => {
    e.preventDefault()
    enviar($("mensaje").value)
  })
  $("mensaje").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      enviar($("mensaje").value)
    }
  })
  $("nueva-sesion").addEventListener("click", nuevaSesion)
  $("prompt-demo").addEventListener("click", () => {
    $("mensaje").value = PROMPT_DEMO
    $("mensaje").focus()
  })
  $("ver-control").addEventListener("click", () => abrirArchivo("out/control.csv"))
  $("chat").addEventListener("click", (e) => {
    const enlace = e.target.closest("a.archivo")
    if (enlace) {
      e.preventDefault()
      abrirArchivo(enlace.dataset.archivo)
    }
  })
  await cargarConfiguracion()
  if (estado.sessionId) await restaurarSesion(estado.sessionId)
})

async function cargarConfiguracion() {
  try {
    const r = await api("/api/config")
    if (!r.ok) return
    const cfg = await r.json()
    $("proveedor").textContent = `${cfg.provider} · ${cfg.model}`
    if (cfg.aviso) {
      $("aviso").textContent = cfg.aviso
      $("aviso").hidden = false
    }
    const casos = $("casos")
    casos.replaceChildren(...cfg.casos.map((caso) => boton(caso, "secundario", () => enviar(`Procesa la solicitud ${caso}`))))
  } catch {
    $("proveedor").textContent = "sin conexión"
  }
}

// ── Envío de mensajes (con streaming de eventos) ─────────────────────────────────────────────

async function enviar(texto) {
  const mensaje = texto.trim()
  if (estado.ocupado || !mensaje) return
  ocultarConfirmacion()
  agregarMensajeUsuario(mensaje)
  $("mensaje").value = ""
  const vista = nuevaRespuesta()
  ocupar(true)
  try {
    const r = await api("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(estado.sessionId ? { sessionId: estado.sessionId } : {}), message: mensaje }),
    })
    if (!r.ok) {
      const cuerpo = await r.json().catch(() => ({}))
      throw new Error(cuerpo.error || `El servidor respondió ${r.status}.`)
    }
    await leerEventos(r, {
      sesion: (d) => guardarSesion(d.sessionId),
      pensando: (d) => (vista.pensando.textContent = d.iteracion > 1 ? `Pensando… (paso ${d.iteracion})` : "Pensando…"),
      herramienta: (d) => vista.herramientas.append(tarjetaHerramienta(d.llamada)),
      fin: (d) => mostrarRespuesta(vista, d),
      error: (d) => mostrarError(vista, d.error),
    })
  } catch (e) {
    mostrarError(vista, e instanceof Error ? e.message : String(e))
  } finally {
    ocupar(false)
    bajar()
  }
}

/** Lee un flujo Server-Sent Events de un POST (EventSource solo admite GET). */
async function leerEventos(respuesta, manejadores) {
  const lector = respuesta.body.getReader()
  const decodificador = new TextDecoder()
  let pendiente = ""
  for (;;) {
    const { value, done } = await lector.read()
    if (done) break
    pendiente += decodificador.decode(value, { stream: true })
    let corte
    while ((corte = pendiente.indexOf("\n\n")) >= 0) {
      const bloque = pendiente.slice(0, corte)
      pendiente = pendiente.slice(corte + 2)
      const evento = /^event: (.+)$/m.exec(bloque)
      const datos = /^data: (.+)$/m.exec(bloque)
      if (evento && datos && manejadores[evento[1]]) manejadores[evento[1]](JSON.parse(datos[1]))
    }
  }
}

async function api(ruta, opciones = {}) {
  const headers = { ...(opciones.headers || {}) }
  if (estado.clave) headers["x-access-key"] = estado.clave
  const respuesta = await fetch(ruta, { ...opciones, headers })
  if (respuesta.status === 401 && (await pedirClave())) return api(ruta, opciones)
  return respuesta
}

function pedirClave() {
  return new Promise((resolver) => {
    const dialogo = $("dialogo-clave")
    $("clave").value = ""
    dialogo.addEventListener(
      "close",
      () => {
        const clave = $("clave").value.trim()
        const aceptada = dialogo.returnValue === "ok" && clave !== ""
        if (aceptada) {
          estado.clave = clave
          guardarAlmacen("claveAcceso", clave)
        }
        resolver(aceptada)
      },
      { once: true },
    )
    dialogo.showModal()
  })
}

// ── Sesión ───────────────────────────────────────────────────────────────────────────────────

function guardarSesion(id) {
  estado.sessionId = id
  guardarAlmacen("sessionId", id)
}

function nuevaSesion() {
  if (estado.ocupado) return
  estado.sessionId = null
  guardarAlmacen("sessionId", null)
  ocultarConfirmacion()
  $("chat").replaceChildren(elemento("div", "bienvenida", "Sesión nueva. Escribe, por ejemplo, «Procesa la solicitud sol-001»."))
}

async function restaurarSesion(id) {
  const r = await api(`/api/sessions/${encodeURIComponent(id)}`)
  if (!r.ok) return nuevaSesion()
  const sesion = await r.json()
  for (const turno of sesion.turnos) {
    if (turno.rol === "usuario") agregarMensajeUsuario(turno.texto)
    else mostrarRespuesta(nuevaRespuesta(turno.llamadas || []), { reply: turno.texto, needsConfirmation: false, pendientes: [] })
  }
  if (sesion.pendientes && sesion.pendientes.length > 0) mostrarConfirmacion(sesion.pendientes)
}

// ── Mensajes y llamadas a herramientas ───────────────────────────────────────────────────────

function agregarMensajeUsuario(texto) {
  document.querySelector(".bienvenida")?.remove()
  $("chat").append(elemento("div", "mensaje usuario", texto))
  bajar()
}

function nuevaRespuesta(llamadasPrevias = []) {
  const div = elemento("div", "mensaje asistente")
  const herramientas = elemento("div", "herramientas")
  herramientas.append(...llamadasPrevias.map(tarjetaHerramienta))
  const pensando = elemento("div", "pensando", "Pensando…")
  const texto = elemento("div", "texto")
  div.append(herramientas, pensando, texto)
  $("chat").append(div)
  bajar()
  return { div, herramientas, pensando, texto }
}

function mostrarRespuesta(vista, r) {
  vista.pensando.remove()
  vista.texto.innerHTML = markdown(r.reply || "")
  if (r.needsConfirmation) {
    vista.div.classList.add("espera-confirmacion")
    mostrarConfirmacion(r.pendientes || [])
  }
  bajar()
}

function mostrarError(vista, mensaje) {
  vista.pensando.remove()
  vista.div.classList.add("error")
  vista.texto.textContent = mensaje
}

/** Tarjeta desplegable por llamada: nombre, resultado resumido; al abrirla, argumentos y resultado completos. */
function tarjetaHerramienta(l) {
  const tarjeta = elemento("details", `herramienta${l.ok ? "" : " fallo"}${l.compuerta ? " compuerta" : ""}`)
  const resumen = elemento("summary")
  resumen.append(
    elemento("span", "", l.ok ? "✔" : "✘"),
    elemento("code", "", l.nombre),
    elemento("span", "resumen", resumirResultado(l)),
    elemento("span", "resumen", `${l.duracionMs} ms`),
  )
  if (l.compuerta) resumen.append(elemento("span", "marca-compuerta", "compuerta de confirmación"))
  const cuerpo = elemento("div", "cuerpo")
  if (l.compuerta) cuerpo.append(elemento("p", "marca-compuerta", l.compuerta))
  cuerpo.append(elemento("h4", "", "Argumentos"), elemento("pre", "", JSON.stringify(l.argumentos, null, 2)))
  cuerpo.append(elemento("h4", "", "Resultado"), elemento("pre", "", typeof l.resultado === "string" ? l.resultado : JSON.stringify(l.resultado, null, 2)))
  tarjeta.append(resumen, cuerpo)
  return tarjeta
}

function resumirResultado(l) {
  const r = l.resultado
  if (!l.ok) return primeraFrase(String(r))
  if (l.nombre === "oc_leer_paquete") return `${r.solicitud.solicitud_id} · ${r.solicitud.proveedor_nombre}${r.faltantes.length ? ` · faltan ${r.faltantes.length} adjuntos` : ""}`
  if (l.nombre === "oc_validar") {
    const lista = (h) => h.map((x) => x.codigo).join(", ") || "ninguna"
    return `${r.apta ? "apta" : "NO apta"} · bloqueos: ${lista(r.bloqueos)} · confirmaciones: ${lista(r.confirmaciones)}${r.retroactiva ? " · retroactiva" : ""}`
  }
  if (l.nombre === "oc_generar_evidencia") return `${r.ruta_pdf} · sha256 ${r.sha256.slice(0, 12)}…`
  if (l.nombre === "oc_construir_payload") return `payload listo · ${r.ruta_trazabilidad}`
  if (l.nombre === "oc_crear") return `OC ${r.numero_oc}${r.idempotente ? " (ya existía)" : " creada"}`
  return "ok"
}

// ── Confirmación (CA3) ───────────────────────────────────────────────────────────────────────

function mostrarConfirmacion(pendientes) {
  const nombres = pendientes.map((p) => `${p.caso} (${p.solicitud_id})`).join(", ")
  $("confirmacion-detalle").textContent = `Pendiente: ${nombres}. No se creará ninguna OC hasta que confirmes.`
  $("confirmacion-botones").replaceChildren(
    ...pendientes.map((p) => boton(`Confirmar ${p.caso}`, "confirmar", () => enviar(`Confirmo la creación de la OC de ${p.caso}.`))),
    boton("No crear", "secundario", () => enviar("No, déjala pendiente por ahora.")),
  )
  $("confirmacion").hidden = false
}

function ocultarConfirmacion() {
  $("confirmacion").hidden = true
}

// ── Archivos de out/ (evidencia, trazabilidad, log de control) ───────────────────────────────

async function abrirArchivo(ruta) {
  const r = await api(`/${ruta}`)
  if (!r.ok) return alert(`No se pudo abrir ${ruta} (${r.status}).`)
  const url = URL.createObjectURL(await r.blob())
  const enlace = document.createElement("a")
  enlace.href = url
  enlace.target = "_blank"
  enlace.rel = "noopener"
  if (ruta.endsWith(".csv")) enlace.download = "control.csv"
  enlace.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// ── Markdown seguro: primero se escapa todo, luego se aplica un subconjunto fijo ─────────────

function markdown(fuente) {
  const lineas = escapar(fuente).split("\n")
  const html = []
  let i = 0
  const esFila = (l) => /^\s*\|.*\|\s*$/.test(l || "")
  while (i < lineas.length) {
    const linea = lineas[i]
    if (esFila(linea) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] || "")) {
      const cabecera = celdas(linea)
      const filas = []
      i += 2
      while (esFila(lineas[i])) filas.push(celdas(lineas[i++]))
      const th = cabecera.map((c) => `<th>${enLinea(c)}</th>`).join("")
      const tr = filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`)
    } else if (/^\s*[-*] /.test(linea)) {
      const items = []
      while (/^\s*[-*] /.test(lineas[i] || "")) items.push(lineas[i++].replace(/^\s*[-*] /, ""))
      html.push(`<ul>${items.map((t) => `<li>${enLinea(t)}</li>`).join("")}</ul>`)
    } else if (/^\s*\d+\. /.test(linea)) {
      const items = []
      while (/^\s*\d+\. /.test(lineas[i] || "")) items.push(lineas[i++].replace(/^\s*\d+\. /, ""))
      html.push(`<ol>${items.map((t) => `<li>${enLinea(t)}</li>`).join("")}</ol>`)
    } else if (/^#{1,4} /.test(linea)) {
      const nivel = Math.min(6, linea.indexOf(" ") + 2)
      html.push(`<h${nivel}>${enLinea(linea.replace(/^#+ /, ""))}</h${nivel}>`)
      i++
    } else if (linea.trim() === "") {
      i++
    } else {
      const parrafo = []
      while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*([-*] |\d+\. |#{1,4} |\|)/.test(lineas[i])) parrafo.push(enLinea(lineas[i++]))
      if (parrafo.length === 0) parrafo.push(enLinea(lineas[i++]))
      html.push(`<p>${parrafo.join("<br>")}</p>`)
    }
  }
  return html.join("")
}

function celdas(fila) {
  return fila
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"))
}

/** Formato en línea sobre texto YA escapado. Las rutas de out/ se vuelven enlaces seguros (lista blanca). */
function enLinea(t) {
  return t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\b(out\/(?:[a-z0-9][a-z0-9-]*\/(?:aprobacion\.(?:pdf|txt)|trazabilidad\.json)|control\.csv))\b/g, '<a href="#" class="archivo" data-archivo="$1">$1</a>')
}

function escapar(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// ── Utilidades del DOM ───────────────────────────────────────────────────────────────────────

/** Crea un elemento con texto plano (textContent: nunca interpreta HTML). */
function elemento(etiqueta, clase = "", texto) {
  const el = document.createElement(etiqueta)
  if (clase) el.className = clase
  if (texto !== undefined) el.textContent = texto
  return el
}

function boton(texto, clase, alHacerClic) {
  const b = elemento("button", clase, texto)
  b.type = "button"
  b.addEventListener("click", alHacerClic)
  return b
}

function ocupar(valor) {
  estado.ocupado = valor
  $("enviar").disabled = valor
  for (const b of document.querySelectorAll("#casos button, #confirmacion-botones button")) b.disabled = valor
}

function bajar() {
  const chat = $("chat")
  chat.scrollTop = chat.scrollHeight
}

function primeraFrase(t) {
  return t.split(/(?<=\.)\s/)[0] || t
}

function leerAlmacen(clave) {
  try {
    return sessionStorage.getItem(clave)
  } catch {
    return null
  }
}

function guardarAlmacen(clave, valor) {
  try {
    if (valor === null) sessionStorage.removeItem(clave)
    else sessionStorage.setItem(clave, valor)
  } catch {
    // sin almacenamiento disponible: la sesión vive solo en esta pestaña
  }
}
