# Editar una encuesta que ya está recibiendo respuestas

Las respuestas se guardan por **ID de ítem**, así que editar la encuesta nunca modifica datos ya recogidos.
Cada guardado que cambia contenido sube `revision`; cada respuesta anota la `surveyRevision` que vio la persona
(columna `survey_revision` del CSV) y el constructor guarda un historial (`changeLog`) que sale en `metadata.txt`.

| Qué haces | Qué pasa con los datos |
|---|---|
| Cambiar el **texto** de una pregunta | Nada se rompe. Los exports muestran el texto actual; el texto anterior queda en el historial. |
| **Eliminar** una pregunta | Las respuestas anteriores se conservan y **siguen exportándose** (columna marcada "(eliminada en vN)"); las personas nuevas quedan con celdas vacías. La definición se guarda en `retiredItems`. |
| **Agregar** una pregunta | Las respuestas anteriores quedan con celda vacía en esa columna. |
| **Reordenar** | Cada respuesta guarda el orden que vio (`presentationOrder`); el orden nuevo aplica a las personas nuevas. La columna `presentation_order` del CSV es solo para administración. |
| Cambiar **tipo, códigos de opciones o el ID** | Es lo único peligroso: separa o reinterpreta datos antiguos. El constructor lo advierte y pide confirmación; lo normal es no hacerlo (crea una pregunta nueva). |
| Cambiar solo las **etiquetas** de las opciones (no los códigos) | Seguro. |
| Quien está respondiendo mientras editas | Termina con la versión que cargó; sus respuestas se guardan por ID igual que las demás. |

El panel avisa cuando una encuesta tiene varias versiones ("respuestas por versión: v1 (12), v2 (40)…"), para no
mezclarlas sin querer.

## Eliminar una encuesta

Solo la administración, desde `super.html` → **Eliminar…**. Borra la encuesta y todo lo registrado sobre ella:
respuestas, paradata, audios, marcas de exclusión, accesos de colegas y solicitudes de retiro. El **registro de
consentimientos** se conserva a menos que lo elijas explícitamente (es la prueba de que existió y se respetó el
consentimiento). Pide escribir el ID y recuerda descargar antes los datos. Requiere las reglas actualizadas
(`npx firebase-tools deploy --only firestore:rules --project samplux-lamp`).
