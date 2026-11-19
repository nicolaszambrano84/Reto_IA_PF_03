import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { crearServidor, type OpcionesApp } from "../src/app"
import { ProveedorSimulado } from "../src/llm/simulado"
import { grupo, nuevaRaiz, prueba } from "./arnes"
import { RAIZ_PROYECTO } from "./sinteticos"

/** Levanta el servidor real (con el modelo simulado) en un puerto libre y devuelve su URL base. */
async function levantar(extra: Partial<OpcionesApp> = {}): Promise<{ url: string; cerrar: () => Promise<void> }> {
  const raiz = await nuevaRaiz()
  const servidor = crearServidor({
    raiz,
    carpetaWeb: path.join(RAIZ_PROYECTO, "web"),
    proveedor: new ProveedorSimulado(),
    avisoProveedor: "modo de prueba",
    sistema: "sistema",
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    maxTokensDia: 10_000_000,
    mensajesPorMinuto: 50,
    confiarProxy: false,
    ...extra,
  })
  await new Promise<void>((listo) => servidor.listen(0, "127.0.0.1", listo))
  const { port } = servidor.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, cerrar: () => new Promise<void>((listo) => servidor.close(() => listo())) }
}

const json = (cuerpo: unknown, cabeceras: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...cabeceras },
  body: JSON.stringify(cuerpo),
})

grupo("Servidor HTTP (API del PRD §6.4 y controles de seguridad)")

prueba("POST /api/chat, GET /api/sessions/:id y GET /api/health", async () => {
  const s = await levantar()
  try {
    const salud = (await (await fetch(`${s.url}/api/health`)).json()) as Record<string, unknown>
    assert.deepEqual(salud, { ok: true, provider: "simulado", model: "reglas-deterministas" })
    const r = (await (await fetch(`${s.url}/api/chat`, json({ message: "procesa la solicitud sol-004" }))).json()) as Record<string, unknown>
    assert.equal(typeof r.sessionId, "string")
    assert.equal(r.needsConfirmation, true)
    assert.ok(Array.isArray(r.toolCalls) && r.toolCalls.length === 4)
    const historial = (await (await fetch(`${s.url}/api/sessions/${String(r.sessionId)}`)).json()) as { turnos: unknown[] }
    assert.equal(historial.turnos.length, 2)
  } finally {
    await s.cerrar()
  }
})

prueba("La API no expone la clave: /api/health y /api/config solo muestran proveedor y modelo", async () => {
  const s = await levantar({ claveAcceso: "clave-de-acceso-secreta" })
  try {
    const salud = await (await fetch(`${s.url}/api/health`)).text()
    assert.ok(!salud.includes("clave-de-acceso-secreta"))
    const config = await (await fetch(`${s.url}/api/config`, { headers: { "x-access-key": "clave-de-acceso-secreta" } })).text()
    assert.ok(!config.includes("clave-de-acceso-secreta"))
  } finally {
    await s.cerrar()
  }
})

prueba("Clave de acceso: sin ella o incorrecta → 401; correcta → 200", async () => {
  const s = await levantar({ claveAcceso: "clave-de-acceso-secreta" })
  try {
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "hola" }))).status, 401)
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "hola" }, { "x-access-key": "otra-clave-distinta" }))).status, 401)
    assert.equal((await fetch(`${s.url}/out/control.csv`)).status, 401)
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "hola" }, { "x-access-key": "clave-de-acceso-secreta" }))).status, 200)
    assert.equal((await fetch(`${s.url}/`)).status, 200, "el front es público: pide la clave al usuario")
  } finally {
    await s.cerrar()
  }
})

prueba("Falla cerrado: si se exige clave y no está configurada, la API se bloquea (503) en vez de quedar abierta", async () => {
  const s = await levantar({ exigirClave: true })
  try {
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "procesa sol-001" }))).status, 503)
    assert.equal((await fetch(`${s.url}/api/config`)).status, 503)
    assert.equal((await fetch(`${s.url}/out/control.csv`)).status, 503)
    assert.equal((await fetch(`${s.url}/api/health`)).status, 200, "la salud sigue respondiendo para la plataforma")
    assert.equal((await fetch(`${s.url}/`)).status, 200)
  } finally {
    await s.cerrar()
  }
})

prueba("Entradas inválidas: sin JSON → 415, JSON roto → 400, vacío → 400, enorme → 413, sesión inválida → 400", async () => {
  const s = await levantar()
  try {
    assert.equal((await fetch(`${s.url}/api/chat`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hola" })).status, 415)
    assert.equal((await fetch(`${s.url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{roto" })).status, 400)
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "   " }))).status, 400)
    assert.equal((await fetch(`${s.url}/api/chat`, json({ message: "x".repeat(70_000) }))).status, 413)
    assert.equal((await fetch(`${s.url}/api/chat`, json({ sessionId: "../../etc", message: "hola" }))).status, 400)
  } finally {
    await s.cerrar()
  }
})

prueba("Archivos de out/: se sirven solo los permitidos (sin traversal, sesiones ni logs)", async () => {
  const s = await levantar()
  try {
    await fetch(`${s.url}/api/chat`, json({ message: "procesa sol-001" }))
    const pdf = await fetch(`${s.url}/out/sol-001/aprobacion.pdf`)
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get("content-type"), "application/pdf")
    for (const ruta of ["/out/../package.json", "/out/%2e%2e/package.json", "/out/log.jsonl", "/out/sesiones/x.json", "/fixtures/reto-03/maestros/proveedores.json", "/src/config.ts"]) {
      assert.equal((await fetch(`${s.url}${ruta}`)).status, 404, ruta)
    }
  } finally {
    await s.cerrar()
  }
})

prueba("Cabeceras de seguridad: CSP, nosniff, frame-ancestors y sin caché en la API", async () => {
  const s = await levantar()
  try {
    const r = await fetch(`${s.url}/api/health`)
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/)
    assert.equal(r.headers.get("x-content-type-options"), "nosniff")
    assert.equal(r.headers.get("cache-control"), "no-store")
  } finally {
    await s.cerrar()
  }
})

prueba("Límite de mensajes por minuto por IP → 429", async () => {
  const s = await levantar({ mensajesPorMinuto: 2 })
  try {
    const estados = []
    for (let i = 0; i < 3; i++) estados.push((await fetch(`${s.url}/api/chat`, json({ message: "hola" }))).status)
    assert.deepEqual(estados, [200, 200, 429])
  } finally {
    await s.cerrar()
  }
})

prueba("Streaming: /api/chat/stream emite cada herramienta mientras ocurre y luego la respuesta", async () => {
  const s = await levantar()
  try {
    const texto = await (await fetch(`${s.url}/api/chat/stream`, json({ message: "procesa sol-002" }))).text()
    const eventos = [...texto.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])
    assert.deepEqual(eventos.filter((e) => e === "herramienta").length, 2)
    assert.equal(eventos.at(-1), "fin")
  } finally {
    await s.cerrar()
  }
})
