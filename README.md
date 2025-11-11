# Cloudflare Workers OpenAPI 3.1

This is a Cloudflare Worker with OpenAPI 3.1 using [chanfana](https://github.com/cloudflare/chanfana) and [Hono](https://github.com/honojs/hono).

This is an example project made to be used as a quick start into building OpenAPI compliant Workers that generates the
`openapi.json` schema automatically from code and validates the incoming request to the defined parameters or request body.

## Get started

1. Sign up for [Cloudflare Workers](https://workers.dev). The free tier is more than enough for most use cases.
2. Clone this project and install dependencies with `npm install`
3. Run `wrangler login` to login to your Cloudflare account in wrangler
4. Run `wrangler deploy` to publish the API to Cloudflare Workers

## Project structure

1. Your main router is defined in `src/index.ts`.
2. Each endpoint has its own file in `src/endpoints/`.
3. For more information read the [chanfana documentation](https://chanfana.pages.dev/) and [Hono documentation](https://hono.dev/docs).

## Development

1. Run `wrangler dev` to start a local instance of the API.
2. Open `http://localhost:8787/` in your browser to see the Swagger interface where you can try the endpoints.
3. Changes made in the `src/` folder will automatically trigger the server to reload, you only need to refresh the Swagger interface.

# AgentMyPdf
Este proyecto es un API REST que te permite hacer preguntas QA a un llm rag .


## 🚀 Endpoints

### 1. POST /question
Crea una nueva pregunta para el agente. Retorna un `runId` para tracking.

```bash
curl -X POST http://localhost:8787/question \
  -H 'Content-Type: application/json' \
  -d '{"question":"¿Qué obligaciones tengo sobre protección de datos personales?"}'
```

**Respuesta:**
```json
{
  "success": true,
  "runId": "run-uuid",
  "status": "pending",
  "message": "Agent run created. Processing asynchronously."
}
```

### 2. GET /status/:runId
Consulta el estado de un run específico.

```bash
curl http://localhost:8787/status/run-uuid
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "id": "run-uuid",
    "question": "...",
    "status": "completed",
    "result": "...",
    "createdAt": 1699999999999,
    "completedAt": 1699999999999
  }
}
```

### 3. POST /seed
Carga documentos en la base de conocimiento (uso interno).

### 4. GET /ws - WebSocket (⭐ NUEVO)
Conexión WebSocket para recibir actualizaciones en tiempo real del agente.

**Protocolo:**
- Conecta a: `ws://localhost:8787/ws`
- Suscripción específica: `{"type": "subscribe", "runId": "run-uuid"}`
- Suscripción global (testing): `{"type": "subscribe", "runId": "all"}` ← ⭐ Recibe TODOS los runs
- Recibe actualizaciones automáticas cuando el agente progresa

**Ejemplo con websocat:**
```bash
# Instalar websocat: brew install websocat
websocat ws://localhost:8787/ws
```

Luego envía:
```json
{"type": "subscribe", "runId": "tu-run-id-aqui"}
```

### 5. GET /ws-client - Cliente Web
Interfaz web para probar el WebSocket fácilmente.

**Uso:**
1. Abre en tu navegador: `http://localhost:8787/ws-client`
2. Escribe tu pregunta legal
3. Click en "Send Question"
4. Observa las actualizaciones en tiempo real! 🎉

**⭐ Modo Testing:**
El cliente web se auto-suscribe a **TODOS** los runs al conectar (no necesitas especificar runId).
Esto es perfecto para testing - verás actualizaciones de cualquier pregunta que se ejecute.

## 🔌 WebSocket: Actualizaciones en Tiempo Real

En lugar de hacer polling constante a `/status/:runId`, puedes **suscribirte via WebSocket** y recibir actualizaciones automáticas:

**Ventajas:**
- ✅ Sin polling - actualizaciones instantáneas
- ✅ Menor latencia
- ✅ Menos requests al servidor
- ✅ Experiencia más fluida

**Flujo:**
```
1. POST /question → obtienes runId
2. Conectar WebSocket a /ws
3. Enviar {"type": "subscribe", "runId": "..."}
4. Recibir actualizaciones automáticamente:
   - status: "running", step: "embedding_complete"
   - status: "running", step: "documents_retrieved"
   - status: "completed", result: "..."
```

**Tipos de mensajes:**
```typescript
// Conexión
{ type: "connected", clientId: "...", timestamp: ... }

// Suscripción confirmada
{ type: "subscribed", runId: "...", timestamp: ... }

// Actualización del run
{ 
  type: "run_update",
  runId: "...",
  update: {
    status: "running" | "completed" | "failed",
    step: "started" | "embedding_complete" | "documents_retrieved",
    result?: "...",  // solo cuando completed
    totalTime?: 2847  // milisegundos
  }
}
```
