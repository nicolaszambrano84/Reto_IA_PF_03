/**
 * Herramientas del agente, importables sin el servidor (PRD §9.4).
 * Re-export directo: son exactamente las mismas que usa la aplicación, no una copia.
 * Leen fixtures/reto-03/ y escriben en out/ relativos a ctx.directory (la raíz del proyecto anfitrión).
 */
export * from "../../src/tools/oc"
