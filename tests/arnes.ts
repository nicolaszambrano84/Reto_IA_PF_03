import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { crearRaizDePrueba } from "./sinteticos"

/**
 * Arnés mínimo de pruebas, sin dependencias: corre igual con Bun y con Node.
 * Cada prueba que escribe archivos usa su propia raíz temporal (copia de fixtures + casos sintéticos).
 */

type Cuerpo = () => Promise<void> | void
const pruebas: Array<{ grupo: string; nombre: string; cuerpo: Cuerpo }> = []
let grupoActual = ""

export function grupo(nombre: string): void {
  grupoActual = nombre
}

export function prueba(nombre: string, cuerpo: Cuerpo): void {
  pruebas.push({ grupo: grupoActual, nombre, cuerpo })
}

const temporales: string[] = []

/** Raíz de proyecto nueva y aislada para una prueba. */
export async function nuevaRaiz(): Promise<string> {
  const destino = await mkdtemp(path.join(os.tmpdir(), "reto03-"))
  temporales.push(destino)
  return crearRaizDePrueba(destino)
}

export async function ejecutarPruebas(): Promise<void> {
  let fallas = 0
  let grupoMostrado = ""
  for (const p of pruebas) {
    if (p.grupo !== grupoMostrado) {
      console.log(`\n${p.grupo}`)
      grupoMostrado = p.grupo
    }
    try {
      await p.cuerpo()
      console.log(`  ✔ ${p.nombre}`)
    } catch (e) {
      fallas += 1
      console.log(`  ✘ ${p.nombre}\n      ${e instanceof Error ? e.message.split("\n").join("\n      ") : String(e)}`)
    }
  }
  await Promise.all(temporales.map((t) => rm(t, { recursive: true, force: true })))
  console.log(`\n${pruebas.length - fallas}/${pruebas.length} pruebas correctas`)
  if (fallas > 0) process.exit(1)
}
