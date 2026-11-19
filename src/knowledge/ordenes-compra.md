# Conocimiento del proceso: órdenes de compra en SAP

## El proceso

Cada compra llega a Administración por correo con un paquete: el Excel de solicitud, la cotización del proveedor y el correo de aprobación del líder (a veces también la factura). La analista crea la orden de compra (OC) en SAP con esos datos y adjunta el correo de aprobación como evidencia. El agente automatiza la lectura, la validación, la construcción y la creación de la OC; la analista conserva la decisión sobre las excepciones.

Actores: el **solicitante** envía el paquete; el **líder aprobador** responde «Aprobado»; la **analista administrativa** conversa con el agente y confirma excepciones; **Contabilidad y Auditoría** consumen el log de control `out/control.csv`.

## El paquete de un caso

- `correo`: id, remitente, asunto y fecha.
- `solicitud`: solicitud_id, solicitante, proveedor (nombre y NIT, que puede faltar), descripción, centro de costo, subárea, cantidad, valor unitario, valor total, moneda, indicador de IVA y condiciones de pago (ambos pueden faltar) y fecha de solicitud.
- `cotizacion`: número, fecha, proveedor, NIT, total con IVA, moneda y validez. Puede faltar (null).
- `aprobacion`: quién aprueba, cuándo y si el texto contiene una aprobación explícita. Puede faltar.
- `factura`: número, fecha y total. Solo llega en algunos casos.
- `faltantes`: adjuntos esperados que no llegaron.

## Maestros

- **Proveedores:** código SAP, NIT, nombre, condición de pago e indicador de IVA por defecto, activo o inactivo.
- **Centros de costo:** subáreas válidas y aprobadores con su tope de monto en ese centro.
- **Indicadores de IVA:** C0 excluido o no gravado, C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago:** Z000 pago inmediato; Z015, Z030 y Z060 días fecha factura.

## Controles

| Código | Qué verifica | Si no se cumple |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo |
| RC2 | Hay aprobación, dice «Aprobado» y viene de un aprobador del centro de costo | Bloqueo |
| RC3 | El valor total no supera el tope de ese aprobador en ese centro | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización y solicitud difieren como máximo 2 %; si no hay cotización, también se confirma | Confirmación |
| RC6 | Si falta el indicador de IVA, se toma el del proveedor | Confirmación y derivado |
| RC7 | Si faltan las condiciones de pago, se toman las del proveedor | Derivado (solo se informa) |
| RC8 | La factura es anterior a la solicitud: OC retroactiva | Confirmación y marca en el log |
| RC9 | La aprobación es del mismo día de la solicitud o posterior | Confirmación |
| RC10 | Cantidad × valor unitario = valor total (±1) | Bloqueo |
| RX1 | El indicador de IVA existe en el maestro | Bloqueo (control adicional) |
| RX2 | La condición de pago existe en el maestro | Bloqueo (control adicional) |
| RX3 | El NIT de la cotización coincide con el del proveedor | Confirmación (posible suplantación) |

- Un **bloqueo** impide crear la OC: se devuelve a la analista con la acción sugerida que trae cada hallazgo.
- Una **confirmación** permite crear la OC solo si la analista la confirma de forma explícita.
- Un **derivado** es un valor completado desde los maestros: siempre se informa.

## OC retroactiva

Ocurre cuando la factura llega antes que la solicitud: la compra se hizo sin el paso previo de cotización y aprobación, y la OC se crea solo para poder radicar la factura. La dirección quiere medir este desvío, por eso la OC queda con `retroactiva = true` en el log de control aunque se cree.

## La orden de compra en SAP

- Sociedad y organización de compras: 1000.
- Proveedor: código SAP, NIT y nombre según el maestro.
- Condiciones de pago e indicador de IVA: códigos SAP.
- Aprobador: correo, fecha y SHA-256 de la evidencia de aprobación.
- Posiciones: número (10, 20…), texto breve de máximo 40 caracteres, cantidad, unidad (UN, H o MES), precio unitario, centro de costo, subárea e indicador de IVA.
- Excepciones: las confirmaciones aceptadas y quién las confirmó.
- La OC se crea por el valor de la solicitud (el aprobado), nunca por el de la cotización.
- Una misma solicitud nunca genera dos OC: si ya existe, se devuelve el mismo número (idempotencia).

## Evidencia, trazabilidad y control

- **Evidencia:** `out/<caso>/aprobacion.txt` y `aprobacion.pdf`, con encabezados, cuerpo y la huella SHA-256 del contenido.
- **Trazabilidad:** `out/<caso>/trazabilidad.json` dice de dónde salió cada valor de la OC (solicitud, cotización, correo, aprobación, maestro o derivado).
- **Log de control:** una fila por intento en `out/control.csv` con solicitud_id, resultado (creada, existente, bloqueada o pendiente), número de OC, retroactiva, bloqueos, confirmaciones y fecha.
