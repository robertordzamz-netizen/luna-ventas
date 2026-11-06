# Luna Ventas — TikTok OAuth Web

Backend independiente del sitio legal de GitHub Pages. No modifica `luna-syscom-gateway` ni `systemeets-web`. No publica contenido ni solicita permisos de publicación. No convierte esta conexión en una sesión de usuario del panel Luna Ventas.

## Rutas

| Ruta | Comportamiento |
| --- | --- |
| `GET /health` | Salud del proceso; no revela configuración ni credenciales. |
| `GET /auth/tiktok/start` | Crea estado compartido, cookie de navegador y redirige al Login Kit Web. No admite parámetros. |
| `GET /auth/tiktok/callback` | Valida y consume estado, intercambia código en servidor y persiste tokens cifrados. |

Origen configurado: `https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app`.

Callback previsto (registrar únicamente después del smoke test del despliegue):

`https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app/auth/tiktok/callback`

## Decisiones de seguridad

- Web confidencial: `state` de 256 bits + cookie `__Host-`, HttpOnly, Secure, SameSite=Lax; vencimiento de diez minutos. Estado y vínculo de navegador guardados solo como SHA-256. El callback requiere ambos.
- Cloud Storage privado, acceso uniforme y prevención de acceso público. La lectura se fija a una generación; el borrado condicionado a esa generación permite que una sola instancia consuma el estado. Un fallo posterior exige reiniciar la autorización.
- Sin memoria de proceso para estados, límites o tokens. Presupuesto compartido conservador de 20 inicios/hora (global para esta integración interna). Un atacante puede agotar ese presupuesto; para ampliar el uso, agregar acceso autenticado de Luna Ventas antes de aumentar el límite. No se confía en IPs aportadas por encabezados.
- Tokens con AES-256-GCM e identificadores HMAC, secreto de cifrado de 32 bytes de Secret Manager; asociación autenticada de cada ciphertext al ID de conexión. Tokens nunca en cookies, redirecciones, respuestas ni registros.
- Secret Manager inyecta Client Key, Client Secret y clave de cifrado como variables de entorno con versiones numéricas. Rotar la clave de cifrado requiere migrar los objetos existentes antes de retirar la versión anterior.
- Cuenta de servicio propia, permisos de objetos solamente en el depósito de esta integración y lectura solamente de sus tres secretos. Sin claves JSON de cuentas de servicio.
- URI de callback fija, HTTPS, sin consultas ni fragmentos. Sin retorno dinámico, sin scopes aportados por el navegador. Solo `user.info.basic`.
- Rechazo de parámetros duplicados, códigos malformados y callbacks sin cookie/estado; no se refleja el error del proveedor. Un código se decodifica exactamente una vez.
- Intercambio POST a endpoint fijo, sin seguir redirecciones, plazo de diez segundos y cuerpo limitado. Sin reintentos automáticos del canje de código.
- Registros de aplicación estructurados con eventos e ID aleatorio; no registrar URL, cuerpo, cookie, código, estado, open_id, tokens ni errores crudos.
- Cloud Run genera registros automáticos de solicitudes que incluyen consultas. Antes de activar OAuth debe existir una exclusión en `_Default` para registros `run.googleapis.com/requests`, limitada al servicio `luna-ventas-tiktok-auth` y las rutas `/auth/tiktok/`. Mantener los registros de eventos de aplicación y auditoría. Revisar cualquier nuevo destino de logs para aplicar la misma privacidad.
- Reglas de ciclo de vida eliminan objetos de estado/límite con antigüedad de un día; el vencimiento efectivo de estado se valida a los diez minutos aunque aún exista el objeto. Tokens se eliminan a los 366 días desde su última escritura. Soft delete de Google Cloud puede conservar objetos borrados durante su ventana configurada.

## Web frente a Desktop

Documentación oficial consultada el 28-10-2026:

- [Login Kit Web](https://developers.tiktok.com/docs/en/login-kit-web): HTTPS estático y protección `state`.
- [User Access Token Management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management): `code_verifier` se requiere para móvil y Desktop; el flujo Web usa el secreto en servidor.
- [Login Kit Desktop](https://developers.tiktok.com/docs/en/login-kit-desktop): PKCE y opciones de retorno propias de Desktop. No se usan loopback ni PKCE Desktop en este backend Web.
- [Cloud Storage: precondiciones](https://docs.cloud.google.com/storage/docs/request-preconditions): consumo condicionado por generación.

## Ejecutar y probar

Node.js 22. `npm ci`, `npm test`, `npm run check`, `npm audit --omit=dev`.

Las pruebas usan HTTP local y el adaptador real con un depósito simulado que implementa generaciones. Cubren canje y persistencia cifrada, errores de proveedor, vencimiento, falta/falsificación/repetición de estado, cookies, carreras entre instancias, límites, redirecciones, cifrado, configuración y rotación del refresh token. No requieren credenciales reales ni llaman TikTok.

Variables de servidor:

| Variable | Origen |
| --- | --- |
| `PUBLIC_ORIGIN` | Origen público exacto HTTPS |
| `OAUTH_BUCKET` | `luna-ventas-tiktok-auth-852600734493` |
| `TIKTOK_CLIENT_KEY` | Secret `luna-ventas-tiktok-client-key` |
| `TIKTOK_CLIENT_SECRET` | Secret `luna-ventas-tiktok-client-secret` |
| `TOKEN_ENCRYPTION_KEY` | Secret `luna-ventas-tiktok-token-encryption`, base64 de 32 bytes aleatorios |

Nunca incluir valores de secretos en Git, archivos `.env` versionados, línea de comandos, capturas, incidencias o chats. Agregar versiones desde Secret Manager o mediante entrada estándar en un proceso local seguro.

## Despliegue

Proyecto `luna-cloud-510719`, región `us-central1`, servicio **existente** `luna-ventas-tiktok-auth`. Imagen desde este directorio y Dockerfile, instalación reproducible `npm ci`, usuario de contenedor sin privilegios, Node.js 22. Cuenta de servicio `luna-ventas-tiktok-auth@luna-cloud-510719.iam.gserviceaccount.com`. Máximo de dos instancias. No usar la cuenta de cómputo compartida del ejemplo.

1. Verificar cuenta activa, proyecto, servicio y revisión antes de cambiar nada.
2. Crear/verificar depósito privado, identidad exclusiva y secretos; asignar acceso al depósito y a esos secretos únicamente.
3. Aplicar `infra/lifecycle.json` y exclusión de registros de solicitudes OAuth.
4. Construir la imagen en el repositorio Artifact Registry `luna-ventas-tiktok-auth` con etiqueta derivada del commit.
5. Desplegar primero sin tráfico, fijando versiones numéricas de secretos, origen, depósito e identidad; verificar revisión lista.
6. Enviar tráfico a esa revisión y ejecutar `node scripts/smoke.js`. Si falla, volver a la revisión anterior; nunca registrar el callback como listo.
7. Registrar URI exacta en TikTok Developers Login Kit Web; realizar consentimiento real con la cuenta de prueba permitida. Esto requiere las credenciales y configuración de la misma aplicación/entorno TikTok.

## Refresh e integración futura

`src/refresh.js` ofrece un ayudante interno para renovar cinco minutos antes del vencimiento y conservar la nueva versión del refresh token. Usa un bloqueo compartido y escritura condicionada. No existe endpoint público para leer/renovar tokens. Un refresh ambiguo deja el bloqueo para revisión; puede requerir reautorizar y retirar el bloqueo tras confirmar que no quedan trabajadores en curso. No reintentar ni retirar el bloqueo sin investigar. No hay trabajo periódico porque todavía no hay un consumidor de API ni conexión con la identidad del panel local. Antes de añadirlo se requiere vincular cada conexión a un usuario autorizado del panel, definir desconexión/revocación y políticas de retención.

## Límites de validación

Un smoke test con rechazo/denegación simulada demuestra rutas, estado compartido y permisos de ejecución. No demuestra consentimiento ni canje real de TikTok. El consentimiento completo solo puede comprobarse después de registrar el callback y usar una cuenta autorizada por la aplicación TikTok. El sitio estático y la publicación de videos no se activan con este despliegue.
