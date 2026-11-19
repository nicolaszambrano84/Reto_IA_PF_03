import type { Uso } from "../llm/adapter"

/**
 * Tope global de tokens por día (control de costo). El tope por sesión solo no basta: cualquiera
 * puede abrir sesiones nuevas. Vive en memoria: un reinicio lo pone en cero (ver SOLUCION.md).
 */
export class PresupuestoDiario {
  private dia = ""
  private usados = 0

  constructor(private readonly maximo: number) {}

  agotado(): boolean {
    this.rotar()
    return this.usados >= this.maximo
  }

  sumar(uso: Uso): void {
    this.rotar()
    this.usados += uso.entrada + uso.salida
  }

  private rotar(): void {
    const hoy = new Date().toISOString().slice(0, 10)
    if (hoy !== this.dia) {
      this.dia = hoy
      this.usados = 0
    }
  }
}
