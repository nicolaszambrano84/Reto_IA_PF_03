# SOLUCIÓN · Reto técnico 03: agente "Órdenes de Compra SAP"

Aquí explico cómo resolví el reto, qué decidí y por qué. Sigo el orden de la sección 9.1 del PRD, así que cada punto pedido tiene su apartado con el mismo número.

Para probarlo, el link y la clave de acceso están al inicio del [README](README.md). Sin clave de ningún proveedor, `bun install && bun run demo.ts` recorre los seis casos en segundos.

## 1. Problema en una frase y a quién le duele

Cada orden de compra se digita a mano en SAP y sus controles (proveedor, aprobador, montos) se revisan de memoria, lo que consume tiempo, deja pasar errores que aparecen en el cierre contable e impide medir cuántas OC se crean después de que llega la factura.

Le duele a la **analista administrativa**, que repite la digitación por cada factura; a **Contabilidad y Auditoría**, que corrigen errores y necesitan la evidencia de aprobación; y a la **dirección**, que no puede medir el desvío del proceso.

## 2. Arquitectura: dónde viven el prompt, el conocimiento y la ejecución

```
Navegador (web/)                  Backend Bun o Node 20+ (un solo proceso)                    Disco
┌───────────────┐ POST /api/chat ┌───────────────────────────────────────────────────┐
│ historial     │ ─────(SSE)───▶ │ src/app.ts       API, clave de acceso, límite IP, │
│ tarjetas de   │ ◀───────────── │                  CSP, lista blanca de out/        │
│ herramientas  │                │ src/agent/       ciclo (tope 25), compuerta de    │
│ banda de      │                │                  confirmación, sesiones, topes    │
│ confirmación  │                │ src/llm/         adapter.ts → gemini.ts           │──▶ API de Gemini
└───────────────┘                │                              → simulado.ts        │
                                 │ src/tools/oc.ts  5 herramientas con zod           │──▶ fixtures/ (solo lectura)
                                 │ src/sap/         SapAdapter → mock.ts             │──▶ out/ (escritura)
                                 └───────────────────────────────────────────────────┘
demo.ts, las pruebas y modulo/ importan las mismas herramientas, sin servidor ni modelo.
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Rol del agente, reglas que no rompe, flujo y formato de respuesta |
| Conocimiento | `src/knowledge/ordenes-compra.md` y `src/knowledge/reglas.json` | El proceso y los controles explicados para el modelo; tolerancias, unidades y acciones sugeridas que usan las herramientas |
| Ejecución | `src/tools/` y `src/sap/` | Lectura del paquete, reglas, payload, evidencia, log de control y SAP simulado |

El principio es simple: el modelo conversa y orquesta, las herramientas deciden y recalculan, y el servidor custodia la confirmación. Cambiar una regla de negocio es editar `reglas.json`; cambiar cómo responde el agente es editar `prompt.md`. Ninguno de los dos toca el servidor.

## 3. Ciclo del agente: bucle, tope de iteraciones y confirmación humana

```
al recibir un mensaje:
    autorizados = casos por los que el agente preguntó en el turno anterior, si este mensaje los confirma
    repetir (máximo 25 veces):
        si la sesión o el día superaron su tope de tokens → responder y salir
        respuesta = modelo(system prompt + historial, herramientas)
        si no pidió herramientas → esa es la respuesta; salir
        por cada llamada:
            si es oc_crear con confirmado=true y el caso no está autorizado → confirmado=false   (compuerta)
            validar argumentos con zod → ejecutar → resultado al historial y al chat
    si quedó un caso esperando confirmación y la respuesta no termina en pregunta → agregar la pregunta
```

- **Tope de iteraciones:** 25 por turno, configurable. Si se alcanza, el agente responde qué hizo, qué falló y qué falta.
- **Confirmación humana:** la impone el servidor, no el prompt. Vengo de seguridad y sé que una política sin un control técnico detrás termina incumpliéndose.
  - El servidor recuerda qué casos quedaron pendientes y abre una ventana de un solo turno. Solo si el siguiente mensaje confirma ese caso, `oc_crear` puede recibir `confirmado: true`.
  - Si el modelo lo intenta antes, el servidor lo cambia a `false` y lo deja anotado en la llamada.
  - Ante la duda no confirma: una negación o un "si quieres…" no cuentan, y con varios casos pendientes hay que nombrar cuál.
  - En el chat, ese estado se ve en una banda naranja con el botón de confirmar.
- **Valores solo de herramientas:** cada herramienta recalcula desde los archivos del caso y rechaza el paquete, los derivados o el payload si el modelo los alteró.
- **Trazabilidad y errores:** cada llamada se ve en el chat mientras ocurre y queda en `out/log.jsonl`. Si Gemini falla o no responde, el agente lo dice en lenguaje claro y la sesión sigue: cada intento tiene un plazo de 30 s y se reintenta una vez.

## 4. Elección del modelo: proveedor, por qué y costo por caso

Elegí **Google Gemini 3.5 Flash-Lite** por costo, y porque esta tarea no necesita más. Las reglas, los cálculos y las validaciones los hacen las herramientas. Al modelo le toca entender lo que pide la analista, llamar cinco herramientas en un orden conocido y explicar los resultados.

Un modelo más grande no haría más correctos los controles, porque no los decide el modelo; solo subiría el costo y la latencia. Si algún día hiciera falta, se cambia con la variable `GEMINI_MODEL`.

Lo uso con el SDK oficial (`@google/genai`), en streaming, sin estado y con razonamiento bajo.

Costo medido con el modelo real (`bun run evaluar`), a precios del nivel pagado (US$ 0,30 por millón de tokens de entrada y US$ 2,50 de salida):

| Tipo de caso | Tokens (entrada / salida) | Costo |
|---|---|---|
| Bloqueado (sol-002, sol-003) | ~22.000 / ~1.200 | ~US$ 0,01 |
| Completo sin confirmación (sol-001) | ~43.000 / ~2.200 | ~US$ 0,018 |
| Completo con confirmación (sol-004, sol-005, sol-006) | 56.000–67.000 / 2.700–3.600 | US$ 0,023–0,029 |
| **Promedio de los 6 casos del PRD** | | **US$ 0,019** |

Procesar una OC cuesta entre uno y tres centavos de dólar. Un caso completo tarda entre 10 y 20 segundos en local; en el link gratuito de Render, cerca de un minuto. Con 500 OC al mes serían unos US$ 10.

## 5. Matriz de controles: RC1–RC10 y cuál fue la más difícil

Todas las reglas son funciones deterministas en `src/tools/lib/reglas.ts`. El modelo nunca decide si una regla pasa.

| Regla | Cómo la implementé | Tipo |
|---|---|---|
| RC1 | Busco por NIT (sin puntos ni dígito de verificación); sin NIT, por nombre normalizado. El estado lo responde `SapAdapter.consultarProveedor`. Si el NIT no existe pero el nombre coincide con otro proveedor, lo marco como posible suplantación | Bloqueo |
| RC2 | Exijo el correo, la palabra «Aprobado» sin negación ("No aprobado" no pasa) y que el remitente sea aprobador del centro de la solicitud | Bloqueo |
| RC3 | Comparo con el tope de ese aprobador en ese centro; si no tiene atribución, informo el tope máximo del centro y quién podría aprobar | Bloqueo |
| RC4 | La subárea pertenece al centro | Bloqueo |
| RC5 | `|cotización − solicitud| × 100 > 2 × solicitud`, en aritmética exacta para que un 2,00 % justo no falle por redondeo. Devuelvo ambos valores y la diferencia; sin cotización también pido confirmación | Confirmación |
| RC6 | Sin indicador de IVA, propongo el del proveedor y pido confirmación | Confirmación y derivado |
| RC7 | Sin condiciones de pago, uso las del proveedor y lo informo | Derivado |
| RC8 | Factura anterior a la solicitud: `retroactiva = true`, pido confirmación y queda en el log de control | Confirmación |
| RC9 | Comparo la fecha de la aprobación en su zona horaria (−05:00), no en UTC | Confirmación |
| RC10 | `|cantidad × valor unitario − valor total| ≤ 1` | Bloqueo |

Agregué tres controles que no cambian ningún caso del PRD: que el indicador de IVA y la condición de pago existan en sus maestros (SAP rechazaría la OC) y que el NIT de la cotización coincida con el del proveedor, una alerta clásica de fraude de proveedor. Cada regla tiene su prueba: los 6 casos del PRD y 15 variantes sintéticas.

**La más difícil fue RC2 con RC3 en sol-003.** Si el aprobador se busca en cualquier centro, `fvargas` aparece en CC-3030 con tope de 80 M y el caso de 74 M pasaría, así que la búsqueda tiene que limitarse al centro de la solicitud. Además, en CC-2020 nadie puede aprobar 74 M (el tope máximo es 30 M), y el correo dice que la compra es "para el equipo de preventa", que está en CC-3030. La herramienta bloquea, explica las dos salidas (corregir el centro de costo o escalar la aprobación) y deja la decisión a la persona. El agente nunca corrige el centro por su cuenta.

## 6. Diseño del adaptador SAP real

### Opción de integración y por qué

**OData `API_PURCHASEORDER_PROCESS_SRV`**, la API estándar de órdenes de compra de S/4HANA, expuesta a través de SAP Integration Suite o API Management, con una salida por archivo como plan B desde el primer día. Es una API soportada, usa REST/JSON y crea cabecera, posiciones e imputación en una sola llamada atómica. Si el SAP fuera ECC, usaría `BAPI_PO_CREATE1` detrás de un servicio interno.

Como la viabilidad no está confirmada, el agente solo conoce la interfaz `SapAdapter`: el simulado, el de OData o el de archivo cumplen el mismo contrato, y cambiar de uno a otro no toca las herramientas.

### Mapeo del payload a la estructura real

Con una inserción profunda sobre `A_PurchaseOrder`:

| Payload | SAP | Nota |
|---|---|---|
| `sociedad`, `organizacion_compras` | `CompanyCode`, `PurchasingOrganization` | `PurchaseOrderType = NB`; el grupo de compras sale de configuración |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda`, `condiciones_pago` | `DocumentCurrency`, `PaymentTerms` | |
| `referencia.solicitud_id` | `CorrespncExternalReference` | Clave de idempotencia |
| `posiciones[].numero`, `descripcion` | `PurchaseOrderItem`, `PurchaseOrderItemText` | |
| `cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` | UN → `EA`, H → `H`, MES → `MON` |
| `precio_unitario` | `NetPriceAmount` | SAP espera el precio neto; convierto desde el precio con IVA con la tasa del indicador |
| `indicador_iva` | `TaxCode` | |
| `centro_costo` | `AccountAssignmentCategory = K` y `to_AccountAssignment.CostCenter` | Cuenta de mayor, grupo de artículos y centro salen de configuración |
| `subarea` | Texto de posición | No hay campo estándar |
| Evidencia de aprobación | Adjunto al objeto `BUS2012` (`API_CV_ATTACHMENT_SRV`) | El SHA-256 va en la descripción |
| `excepciones` | Nota de cabecera | Qué se confirmó y quién |

### Autenticación y dónde viven las credenciales

Con un usuario técnico de mínimo privilegio (solo crear y consultar OC en la sociedad 1000), mediante OAuth 2.0 *client credentials* o certificado X.509. Las credenciales viven en un gestor de secretos (Azure Key Vault o el servicio de destinos de BTP) y solo las usa el conector del servidor. Nunca están en el agente, en el prompt ni en el modelo: el modelo solo puede pedir `oc_crear`, y es la herramienta la que llama al conector.

### Idempotencia y errores parciales

1. Antes de crear, busco la OC por la referencia (`solicitud_id`); si existe, devuelvo ese número.
2. La creación es una sola llamada atómica: se crea todo o nada.
3. Si la llamada vence sin respuesta, no reintento a ciegas: primero vuelvo a buscar por referencia y solo creo si no existe.
4. Si la OC se creó pero falló el adjunto de la evidencia, la registro como "creada sin evidencia" y reintento solo ese paso, que también es idempotente. Una OC nunca se borra automáticamente.
5. Los mensajes de error de SAP se traducen a un texto claro para la analista; con la BAPI, cualquier error implica rollback.

### Plan B si la conexión no es viable

El agente sigue ahorrando lo más caro, que es validar:

- **OC lista para pegar:** se genera campo por campo en el orden de la transacción ME21N, con la evidencia lista. La analista la crea en SAP y le dicta al agente el número, que queda en el log de control.
- **Carga masiva:** las OC aprobadas se escriben en la plantilla del Migration Cockpit para cargarlas en lote.

## 7. Lectura del proceso: qué le diría a la dirección sobre las OC retroactivas

El caso sol-005 lo resume: la cotización es del 5 de agosto, la factura del 10, la solicitud del 27 y la aprobación del 28, con el mensaje "Ya llegó la factura, por favor crear la OC para poder radicarla". La compra se comprometió con el proveedor antes de existir la aprobación interna, y la OC solo dejó por escrito algo que ya había pasado.

Le diría a la dirección que una OC retroactiva no es un problema de digitación sino un control que se saltó: se gasta sin verificar presupuesto ni quién tiene atribución para aprobar, sin comparar precios, y el cruce entre orden, recepción y factura pierde sentido.

Propondría tres pasos:

1. **Medir primero.** El agente marca `retroactiva = true` en el log de control aunque la OC se cree. En un mes se sabe qué porcentaje de OC son retroactivas, por centro de costo, aprobador y proveedor. Con ese dato se decide la política de tolerarlas con marca o rechazarlas, que el PRD deja abierta.
2. **Atacar la causa.** Si se saltan la OC porque crearla es lento, el agente ya lo reduce a minutos. Para compras recurrentes, como la papelería del trimestre, conviene un contrato marco u OC abierta con el proveedor.
3. **Sin OC previa no se paga.** Una factura sin OC anterior queda retenida hasta que el líder del centro la regularice y justifique, con una vía rápida para urgencias reales.

El indicador para el comité sería el porcentaje mensual de OC retroactivas, con meta de reducción trimestral.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Cada herramienta recalcula desde las fuentes y rechaza datos alterados por el modelo | Confiar en lo que el modelo pasa entre herramientas | Elimina por diseño el riesgo de que el modelo "arregle" un monto. El costo es más tokens, porque el modelo reenvía datos |
| Confirmación impuesta en el servidor, con ventana de un turno | Confiar en la instrucción del prompt | Un prompt es una política, no un control. En la evaluación real, Gemini intentó crear una OC con una "confirmación" dada por adelantado y la compuerta lo bloqueó |
| Ciclo propio sobre la API sin estado de Gemini | Un framework de agentes o la API con estado | El PRD pide el ciclo en el backend e independiente del proveedor, y así la conversación no queda guardada en Google (`store: false`) |
| Parámetros de negocio en `reglas.json`, validados al arrancar | Escribirlos en el código | Cambiar una regla no toca el servidor; si el archivo está roto, el servicio no arranca en vez de operar con reglas corruptas |
| `oc_validar` registra en el log de control los intentos bloqueados y pendientes | Que solo registre `oc_crear` | Un caso bloqueado como sol-002 no puede tener payload, nunca llegaría a `oc_crear` y no quedaría medido |
| Modelo simulado detrás de la misma interfaz | Que la app falle sin clave | Permite probar sin gastar cuota, usar la app sin clave con aviso visible y demostrar que cambiar de proveedor no toca el ciclo |
| No validar el dígito de verificación del NIT | Validarlo con el algoritmo de la DIAN | 5 de los 6 NIT de las cotizaciones no lo cumplen (son ficticios); daría falsas alarmas |
| `node:http` sin framework y front sin dependencias | Express o React | Menos superficie de ataque, el mismo código en Bun y en Node y una CSP estricta |
| Si al despliegue le falta la clave del link, la API se bloquea | Arrancar abierta | Al verificar el link desde fuera lo encontré abierto, porque la variable quedó vacía en Render. Prefiero que un olvido de configuración bloquee el servicio a que exponga la cuota del modelo |
| La clave del link va en el README, como pide el PRD, y es exclusiva de la demo | Entregarla por un canal privado | El PRD la pide en el README. La traté como una clave de bajo valor: solo abre el chat, no da acceso a la clave del modelo ni a SAP, y el gasto queda acotado por el tope diario de tokens, el límite por IP y el bloqueo por intentos fallidos. Se rota en Render después de la evaluación sin tocar el código |
| IP del cliente contando los proxies desde la derecha de `X-Forwarded-For` | Tomar el primer valor de la cabecera | El proxy de Render agrega al final y no limpia lo que manda el cliente: con el primer valor, cambiar la cabecera en cada petición evadía el límite por IP. Con el último, todos los usuarios compartirían la IP de Cloudflare |
| Tras 10 claves equivocadas, la IP se bloquea 15 minutos aunque luego acierte | Solo responder 401 | Sin freno se puede adivinar la clave sin límite; si el bloqueo dejara pasar el acierto, el 200 lo delataría |

Las dependencias son las mínimas, con versión exacta y lockfile:

| Paquete | Para qué |
|---|---|
| `zod` | Esquemas de argumentos, del payload de SAP, de los maestros y de la configuración; mensajes de error en español |
| `@google/genai` | SDK oficial de Gemini. Su dependencia `protobufjs` trae un script de instalación que Bun bloquea; no lo necesita |
| `pdf-lib` | La evidencia en PDF; solo genera, nunca interpreta PDFs externos |
| `typescript`, `@types/node`, `tsx` | Desarrollo: chequeo de tipos y ejecución con Node 20+ |

## 9. Supuestos al interpretar el PRD

- **Rúbrica:** la ficha remite a "la rúbrica de la sección 10", pero esa sección es de riesgos. Me guié por lo que el PRD dice que evalúa.
- **Precios con IVA:** la solicitud y la cotización traen precios con IVA. El SAP simulado recibe el precio tal cual; el adaptador real lo convierte a neto.
- **Unidad de medida:** no viene en la solicitud. La derivo solo si la descripción dice "<cantidad> horas" o "<cantidad> meses"; si no, `UN`. Así sol-001 ("vigencia 12 meses", 120 licencias) queda en `UN` y sol-004 ("100 horas") en `H`.
- **Texto breve:** lo recorto a 40 caracteres en límite de palabra; el texto completo queda en la trazabilidad.
- **Fuentes de trazabilidad:** además de las del PRD uso `correo` y `aprobacion`, porque `correo_id` y el aprobador no vienen de la solicitud ni de la cotización.
- **Paquete:** agregué el número y la fecha de la cotización (necesarios para `cotizacion_ref`) y la lista de adjuntos faltantes.
- **Paquete incompleto:** sin correo o sin solicitud devuelvo `{ ok: false }`; si falta un adjunto queda en `null` y se nombra en `faltantes`.
- **Aprobación:** "No aprobado" o "rechazado" no aprueban aunque contengan la palabra.
- **Fechas:** la aprobación se compara en la zona horaria del correo. La validez de la cotización se informa pero no bloquea, porque no es una regla del PRD.
- **Topes:** asumí que están en COP; otra moneda requeriría la TRM.
- **Quién confirma:** sin autenticación, `confirmado_por` registra la sesión; en producción sería la identidad de SSO.
- **Log de control:** una fila por intento; un caso puede tener varias (pendiente y después creada) y vale la última.
- **Evidencia:** el SHA-256 cubre los encabezados y el cuerpo del correo, que es lo que aparece antes de la línea separadora en `aprobacion.txt`.

## 10. Cobertura y qué falta para producción

| Historia o requisito | Estado | Cómo lo verifiqué |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Prueba de adjunto ausente |
| HU-2 Validar contra maestros | Hecho | Los 6 casos del PRD y 15 variantes sintéticas |
| HU-3 Construir el payload | Hecho | Prueba de que todo valor del payload tiene fuente |
| HU-4 Evidencia | Hecho: txt y PDF | El hash se puede recalcular; el PDF sale idéntico en cada ejecución |
| HU-5 Crear la OC | Hecho | Idempotencia, también con llamadas simultáneas, y log de control |
| HU-6 Errores legibles | Hecho | Casos sin solicitud, con JSON roto, monto en texto y cotización ilegible |
| Front, ciclo, API y adaptador LLM | Hecho | 80 pruebas automáticas (también en CI en cada push), el front probado en navegador y evaluación con Gemini real |
| `oc_leer_excel` (P1 opcional) | No hecho | Prioricé el módulo reutilizable |
| Módulo reutilizable (bonus) | Hecho | Las pruebas fallan si se aparta de las fuentes que usa la app |

**Para producción falta:**
- el conector SAP real;
- leer el correo real (Microsoft Graph) y los adjuntos binarios;
- SSO con roles;
- base de datos para sesiones y log de control;
- envío de logs a un SIEM;
- solicitudes con varias posiciones;
- monedas extranjeras;
- adjuntar la evidencia en SAP;
- correr en varias instancias.

## 11. Uso de IA

| Asistente | Para qué |
|---|---|
| **Claude Code** | Análisis del PRD y de los fixtures, diseño, implementación, pruebas, verificación del front en navegador, evaluación con el modelo real y documentación. Al final, una revisión de seguridad y de cumplimiento del PRD antes de publicar el repositorio: exclusiones de Git, CI y despliegue en Render |
| **Gemini** | Una primera lectura del PRD para contrastar mi análisis y resolver dudas puntuales sobre su API |

Las decisiones de fondo fueron mías: el proveedor y el modelo, el runtime (Bun compatible con Node) y el alcance (los obligatorios, el PDF y el módulo). Mi criterio para aceptar una propuesta fue poder explicarla y que tuviera una prueba que la respaldara.

**Qué descarté o corregí:**
- **Usar `gemini-3.8-flash` como modelo por defecto:** con mi clave no respondía, y Flash-Lite sí, a menor costo.
- **Confiar en el timeout del SDK:** una llamada quedó colgada más de 6 minutos. Lo reemplacé por un plazo propio por intento, con un reintento.
- **Usar la llamada sin streaming de Gemini:** se colgaba siempre con el mismo caso, que en streaming respondía en 5 s. Cambié el adaptador a streaming.
- **Exigir que el modelo reenviara el paquete completo:** el modelo omitía los campos nulos y la validación lo rechazaba. Acepté valores por defecto sin debilitar la verificación de integridad.
- **Cerrar todos los procesos del navegador al terminar la prueba del front:** lo cambié por cerrar solo los procesos propios.
- **Aceptar "si" como confirmación:** sin tildes, el "si quieres…" se confundía con un "sí". Una prueba lo detectó y ajusté la regla.
- **Tomar la IP del cliente del primer valor de `X-Forwarded-For`:** en la revisión de seguridad antes de publicar el repositorio salió que en Render ese valor lo escribe el propio cliente, así que el límite por IP se podía evadir. Lo cambié por contar los proxies desde la derecha y agregué el bloqueo por intentos fallidos de la clave de acceso, con sus pruebas.
- **La primera explicación de por qué fallaban las pruebas en el CI:** Claude Code atribuyó la falla al formato de números según el idioma del sistema, y no era eso. En vez de seguir adivinando, hice que el CI publicara cada prueba fallida como anotación. Así apareció la causa real: una prueba usaba una ruta que solo es inválida en Windows. El cambio de formato lo dejé porque igual hace el resultado independiente del sistema.
- **Dejar que el modelo armara la tabla de la OC:** en una prueba con Gemini se saltó `oc_construir_payload` e inventó el texto breve y la unidad. Ahora el prompt solo le permite mostrar la OC con los valores del payload, y la evaluación verifica el texto breve exacto.

## 12. Riesgos de llevarlo a producción y cómo los mitigaría

| Riesgo | Mitigación |
|---|---|
| Inyección de instrucciones en correos o cotizaciones | El texto de los documentos es dato, no instrucción. El modelo solo puede pedir 5 herramientas acotadas y crear exige la compuerta del servidor |
| Que el agente actúe más allá de lo debido | Mínimo privilegio: sin shell, sin red y sin escritura fuera de `out/`; crear la OC pasa por la regla de la herramienta y por la compuerta del servidor |
| Que el modelo invente o altere valores | Recalculo e integridad en cada herramienta, trazabilidad por campo, payload validado con el esquema de SAP y la OC solo se muestra con los valores del payload. Lo que se crea en SAP nunca sale del texto del modelo |
| Que la respuesta del modelo inyecte código en el chat | El front escapa todo y la CSP prohíbe scripts en línea |
| Fuga de la clave del modelo o de SAP | Solo en variables del servidor o en un gestor de secretos; se oculta en errores y logs; `.env` fuera de Git |
| Datos enviados a un tercero (Google) | Solo el caso en curso y `store: false`; en producción, capa de pago o Vertex AI con acuerdo de tratamiento de datos (Ley 1581) |
| Consumo sin límite | Topes de tokens por sesión y por día, límite por IP (con la IP real, no la que declara el cliente), clave de acceso (si falta en el despliegue, la API se bloquea) y límite de gasto en el proveedor |
| La clave del link es pública por estar en el README | Es exclusiva de la demo y no da acceso a ningún otro secreto; el bloqueo por intentos fallidos, los topes de tokens y el límite por IP acotan su abuso; se rota al terminar la evaluación. En producción no habría clave compartida, sino SSO |
| Proveedor caído o lento | Plazo por intento con reintento y mensaje claro; la lógica de negocio no depende del modelo |
| OC duplicadas | Idempotencia por `solicitud_id`; en SAP real, referencia única y búsqueda antes de cualquier reintento |
| Suplantación de proveedor o de aprobador | RC1, RC2 y el control de NIT de la cotización; los cambios de datos se verifican por un canal conocido |
| El link gratuito se duerme | Abrirlo unos minutos antes de la defensa; en producción, una instancia siempre activa |
