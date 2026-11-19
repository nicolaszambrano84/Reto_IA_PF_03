# Agente de órdenes de compra SAP · Reto técnico 03

Agente conversacional que lee el paquete de una solicitud de compra (solicitud, cotización, aprobación y, a veces, factura), lo valida contra los maestros con las reglas RC1–RC10, muestra la orden de compra tal como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Lo que no cumple control se devuelve a la analista con una acción sugerida; las excepciones solo se crean con su confirmación explícita.

El planteamiento completo de la solución está en [SOLUCION.md](SOLUCION.md).

## Link de prueba

| | |
|---|---|
| URL | https://reto03-ordenes-compra-e33s.onrender.com |
| Clave de acceso | `27ykEp8V_ZiiruPc9RHt82xl7HMeB_MU` (el chat la pide al entrar; en la API va en la cabecera `x-access-key`) |
| Modelo | Google Gemini (`gemini-3.5-flash-lite`) |

La clave es exclusiva de esta demo y se entrega aquí porque el PRD lo pide (§6.1 y §9.2). Solo abre el chat: no da acceso a la clave del modelo, que vive únicamente en el servidor. El uso queda acotado por el tope diario de tokens, el límite de mensajes por IP y el bloqueo tras 10 claves equivocadas. Se cambia en Render después de la evaluación, sin tocar el código.

El plan gratuito de Render duerme tras 15 minutos sin uso: la primera carga puede tardar cerca de un minuto.

Prueba sugerida (botón **Prompt de la demo (§11)** en el chat):

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Después responde «confirmo» (o usa el botón **Confirmar sol-004** de la banda naranja).

## Levantar en local (un comando)

Requisitos: [Bun](https://bun.sh) 1.1 o superior (también funciona con Node 20+).

```bash
bun install
bun run dev            # front + backend en http://localhost:3000
```

Con Node: `npm install && npm run dev:node`.

Sin clave de Gemini el agente arranca igual en **modo simulado** (reglas fijas, sin modelo de lenguaje) y lo avisa en pantalla. Para usar Gemini:

```bash
cp .env.example .env   # y completa GEMINI_API_KEY
bun run dev
```

## Variables de entorno

Todas son opcionales; los valores por defecto están en [.env.example](.env.example). Las claves solo viven en el backend: nunca llegan al front, a los logs ni a las respuestas de la API.

| Variable | Para qué | Por defecto |
|---|---|---|
| `GEMINI_API_KEY` | Clave de Google AI Studio | (sin clave: modo simulado) |
| `LLM_PROVIDER` | `auto`, `gemini` o `simulado` | `auto` |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-3.5-flash-lite` |
| `GEMINI_THINKING` | Nivel de razonamiento: `low`, `medium`, `high` | `low` |
| `LLM_TIMEOUT_MS` | Plazo por intento de llamada al modelo (si vence, se reintenta una vez) | `30000` |
| `MAX_ITERACIONES` | Tope de iteraciones modelo → herramientas por turno (CA1) | `25` |
| `MAX_TOKENS_SESION` | Tope de tokens por sesión | `400000` |
| `MAX_TOKENS_DIA` | Tope global de tokens por día (una sesión nueva no lo evita) | `3000000` |
| `MAX_MENSAJES_POR_MINUTO` | Mensajes por minuto por IP | `12` |
| `ACCESS_KEY` | Si se define (mínimo 16 caracteres), la API y `out/` exigen la cabecera `x-access-key` | (sin clave) |
| `EXIGIR_ACCESS_KEY` | `1` en despliegues públicos: si falta `ACCESS_KEY`, la API se bloquea en vez de quedar abierta | `0` |
| `TRUST_PROXY` | Número de proxies confiables delante de la app, para tomar la IP real del cliente de `X-Forwarded-For` contando desde la derecha. En Render: `2` (Cloudflare + su proxy) | `0` |
| `PORT` | Puerto HTTP | `3000` |

## Demo sin modelo

```bash
bun install && bun run demo.ts        # con Node: npx tsx demo.ts
```

Procesa los 6 casos llamando directo a las herramientas, sin servidor ni clave de ningún proveedor. Por caso imprime `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo. Muestra la idempotencia (sol-001 dos veces), la confirmación explícita de sol-004 y una sección de robustez (errores legibles, intento de salir de la carpeta del caso y un payload manipulado que se rechaza). Limpia `out/` al inicio y su salida es la misma en cada ejecución salvo las marcas de tiempo.

| Caso | Resultado |
|---|---|
| sol-001 | OC 4500000001 sin intervención; la segunda vez devuelve la misma (idempotente) |
| sol-002 | Bloqueada por RC1: el proveedor no existe |
| sol-003 | Bloqueada por RC2 y RC3: el aprobador no pertenece al centro y nadie en él tiene tope suficiente |
| sol-004 | Confirmación RC5 (cotización 26.500.000 frente a 25.000.000, 6 %); con confirmación, OC 4500000002 |
| sol-005 | Confirmación RC8: factura anterior a la solicitud, OC retroactiva; con confirmación, OC 4500000003 |
| sol-006 | Confirmación RC6: IVA tomado del maestro (C1) y pago derivado (Z030); con confirmación, OC 4500000004 |

## Pruebas y verificaciones

```bash
bun run test           # 80 pruebas: reglas, contrato de herramientas, seguridad, ciclo, servidor y módulo (sin modelo)
bun run typecheck      # TypeScript estricto, sin any
bun run modulo:check   # modulo/ coincide con las fuentes que usa la aplicación
bun run evaluar        # evaluación con Gemini real: 7 escenarios, tokens y costo (requiere GEMINI_API_KEY)
```

Con Node: `npm run test:node`. Cada push a `main` corre lo mismo en GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)), más una verificación de que no se subieron secretos, `.env`, `out/` ni `node_modules/`.

## API

Si `ACCESS_KEY` está definida, todas las rutas salvo `/api/health` y el front exigen la cabecera `x-access-key` (sin ella o incorrecta: 401; tras 10 claves equivocadas desde una IP en 15 minutos: 429, aunque después acierte). Los cuerpos son JSON (`Content-Type: application/json`).

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendientes[], provider, model, tokens, avisos[] }` |
| `POST` | `/api/chat/stream` | Igual que `/api/chat`, en Server-Sent Events: `sesion`, `pensando`, `herramienta` (cada llamada al terminar) y `fin` (la respuesta completa) |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión: turnos con sus llamadas a herramientas, pendientes y tokens |
| `GET` | `/api/health` | `{ ok: true, provider, model }` (sin claves) |
| `GET` | `/api/config` | Proveedor, modelo, aviso y casos disponibles (lo usa el front) |
| `GET` | `/out/<caso>/aprobacion.pdf\|txt`, `/out/<caso>/trazabilidad.json`, `/out/control.csv`, `/out/sap/ordenes.jsonl` | Archivos generados (solo esta lista blanca) |

Cada elemento de `toolCalls` trae `nombre`, `argumentos`, `ok`, `resultado` (los datos o el error), `duracionMs` y, si la compuerta de confirmación intervino, `compuerta`.

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Procesa la solicitud sol-001"}'

# Contra el link público (con la clave de acceso)
curl -s https://reto03-ordenes-compra-e33s.onrender.com/api/health
curl -s -X POST https://reto03-ordenes-compra-e33s.onrender.com/api/chat \
  -H "Content-Type: application/json" -H "x-access-key: 27ykEp8V_ZiiruPc9RHt82xl7HMeB_MU" \
  -d '{"message":"Procesa la solicitud sol-002"}'
```

## Estructura

```
agent/prompt.md                    comportamiento del agente (system prompt)
src/knowledge/ordenes-compra.md    conocimiento del proceso (se agrega al system prompt)
src/knowledge/reglas.json          parámetros de negocio: tolerancias, unidades y acciones sugeridas
src/tools/oc.ts                    las 5 herramientas (cada export se ve como oc_<export>)
src/tools/lib/                     lectura del paquete, reglas RC1–RC10, payload, evidencia, control
src/sap/adapter.ts · mock.ts       interfaz SapAdapter del PRD y SAP simulado sobre out/sap/
src/llm/adapter.ts                 interfaz propia enviar(mensajes, herramientas)
src/llm/gemini.ts · simulado.ts    proveedor Gemini y modelo simulado
src/agent/                         ciclo del agente, compuerta de confirmación, sesiones y topes
src/app.ts · server.ts             servidor HTTP (API, seguridad, front) y punto de entrada
web/                               front de chat (HTML, CSS y JS sin dependencias)
fixtures/reto-03/                  entregados por Periferia, sin modificar
modulo/                            el agente empaquetado para otras plataformas (bonus)
demo.ts · tests/ · scripts/        demo sin modelo, pruebas y utilidades
Dockerfile · render.yaml           imagen sin privilegios y blueprint de Render
.github/workflows/ci.yml           CI: tipos, pruebas, demo, módulo y guarda de secretos
```

## Archivos que genera (`out/`)

| Archivo | Contenido |
|---|---|
| `out/<caso>/aprobacion.txt` y `.pdf` | Evidencia: encabezados y cuerpo del correo de aprobación y su SHA-256 |
| `out/<caso>/trazabilidad.json` | De dónde salió cada valor de la OC (solicitud, cotización, correo, aprobación, maestro o derivado) |
| `out/sap/ordenes.jsonl` | Órdenes creadas en el SAP simulado, numeradas desde 4500000001 |
| `out/control.csv` | Una fila por intento: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts` |
| `out/log.jsonl` | Una línea por llamada a herramienta |

Para verificar una evidencia, calcula el SHA-256 de todo lo que está antes de la línea de guiones en `aprobacion.txt`: debe ser igual al que aparece debajo.

## Módulo reutilizable (bonus)

`modulo/` contiene el agente listo para otra plataforma de agentes, sin depender de este servidor: `agent.md` (frontmatter con `description`, `mode: primary` y `permission` de solo lectura; cuerpo: el mismo system prompt), `tools/oc.ts` (re-exporta las mismas herramientas) y `skill/ordenes-compra/SKILL.md` (el mismo conocimiento del proceso). Se regenera con `bun run modulo` y las pruebas fallan si se aparta de las fuentes. Las herramientas leen `fixtures/reto-03/` y escriben en `out/` relativos a `ctx.directory` de la plataforma anfitriona.

## Despliegue (Render)

`render.yaml` define el servicio: Docker con usuario sin privilegios, plan gratuito, verificación de salud en `/api/health`, `EXIGIR_ACCESS_KEY=1` (sin clave la API se bloquea en vez de quedar abierta) y `TRUST_PROXY=2`. Cada push a `main` vuelve a desplegar.

1. En Render: **New → Blueprint →** conectar este repositorio (`main`).
2. Cuando lo pida, completar los dos secretos (nunca van en el repositorio):
   - `GEMINI_API_KEY`: clave de Google AI Studio, idealmente de un proyecto exclusivo y con límite de gasto.
   - `ACCESS_KEY`: la clave de acceso de la tabla de arriba.
3. Esperar el primer despliegue y verificar: `GET /api/health` responde `{ ok: true, provider: "gemini", … }`, y `GET /api/config` sin clave responde 401.

Para cambiar la clave de acceso: generar una nueva (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`), reemplazarla en **Environment** de Render y en este README.
