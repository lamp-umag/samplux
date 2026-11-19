# Modo encuestador (`encuestador.html`)

Para aplicar una encuesta cara a cara en tablet o computador. Usa el mismo motor que `encuesta.html`.

- **Carrusel** de tarjetas, horizontal o vertical. Borde claro y punteado = aún no vista; punteado grueso =
  vista y sin responder; sólido grueso = respondida; recuadro grueso = la actual. Un contador "N sin responder"
  lleva a la primera pendiente; la pantalla de envío lista lo que falta y bloquea si faltan obligatorias.
- **Traspaso**: ítems marcados "Privada" y todas las tareas cognitivas pasan a una pantalla solo para la persona
  encuestada y se ocultan después a quien encuesta.
- **Sin conexión**: la app se guarda en el dispositivo (service worker `sw.js`) y cada caso se guarda primero
  en IndexedDB (`js/outbox.js`); se sube al volver internet. "Respaldo (.json)" exporta lo pendiente.
- **Datos**: cada respuesta lleva `interviewer` (código, lugar, sesión, n.º de caso, vista, saltos, ítems en
  traspaso) en su paradata → columnas `interviewer_*` del CSV; `null`/0 si fue autoadministrada.
- Teclado: 1–9 opción, Enter sigue, ← → cambian de pregunta.

## Probar

```bash
npx firebase-tools emulators:start --only firestore --project samplux-lamp   # terminal 1
npm start                                                                     # terminal 2
npm run seed                                                                  # terminal 3 (puerto 8080)
# abrir: http://localhost:5175/encuestador.html?survey=piloto&emulator=8080
#        http://localhost:5175/?survey=piloto&emulator=8080         (flujo del participante + comprobante)
#        http://localhost:5175/retirar.html?emulator=8080            (retiro con el código)
npm test && npm run test:rules
```
