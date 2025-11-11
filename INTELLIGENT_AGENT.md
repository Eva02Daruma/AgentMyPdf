# 🤖 IntelligentAgent - Cloudflare Agent con RAG

Implementación completa de un agente legal usando la librería oficial `agents` de Cloudflare.

## 📋 Características

### ✅ Patrones de Cloudflare Agents

- **State Management**: `this.state`, `this.setState()`, `onStateUpdate()`
- **RPC Methods**: Métodos `@callable` invocables vía WebSocket o HTTP
- **Streaming**: AsyncGenerator para respuestas en tiempo real
- **SQL Storage**: `this.sql` template tag para persistencia
- **Lifecycle Hooks**: `onStart()`, `onError()`, `onStateUpdate()`
- **WebSocket**: `onConnect()`, `onMessage()`, `onClose()` automático
- **HTTP Endpoints**: `onRequest()` para REST API

### 🔄 Pipeline RAG Completo

1. **Embedding Generation** - Workers AI (@cf/baai/bge-base-en-v1.5)
2. **Vector Search** - Cloudflare Vectorize
3. **Document Retrieval** - D1 Database
4. **Answer Generation** - Workers AI (@cf/meta/llama-4-scout-17b-16e-instruct)
5. **History Tracking** - SQL storage automático

## 🚀 Uso

### Opción 1: HTTP Streaming (Recomendado para testing)

```bash
curl -X POST http://localhost:8787/agents/intelligent-agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"¿Cómo cumplir con la ley de protección de datos personales?"}'
```

### Opción 2: WebSocket RPC (Recomendado para producción)

```javascript
// Cliente JavaScript
const ws = new WebSocket('ws://localhost:8787/agents/intelligent-agent');

ws.onopen = () => {
  // Llamar método askQuestion via RPC
  ws.send(JSON.stringify({
    type: 'rpc',
    id: crypto.randomUUID(),
    method: 'askQuestion',
    args: ['¿Cómo cumplir con la ley de protección de datos personales?']
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'rpc_response') {
    // Streaming chunks
    console.log(data.result);
  }
  
  if (data.type === 'cf_agent_state') {
    // Estado actualizado automáticamente
    console.log('State updated:', data.state);
  }
};
```

### Opción 3: React Client (usando @agents/client)

```tsx
import { useAgent } from '@agents/client';

function MyComponent() {
  const { stub, state } = useAgent({ 
    name: 'intelligent-agent' 
  });

  const askQuestion = async () => {
    // Llamar método callable directamente
    const result = await stub.askQuestion(
      '¿Cómo cumplir con la ley de protección de datos personales?'
    );
    
    console.log('Answer:', result.answer);
  };

  return (
    <div>
      <p>Total runs: {state.totalRuns}</p>
      <button onClick={askQuestion}>Ask Question</button>
    </div>
  );
}
```

## 📊 Métodos Callable (RPC)

### `askQuestion(question: string)`

Procesa una pregunta usando el pipeline RAG completo con streaming.

**Returns**: AsyncGenerator que yield chunks de progreso y devuelve `RAGResult`

**Ejemplo**:
```javascript
// Via WebSocket RPC
ws.send(JSON.stringify({
  type: 'rpc',
  id: 'req-1',
  method: 'askQuestion',
  args: ['Mi pregunta legal']
}));
```

### `getHistory(limit?: number)`

Obtiene el historial de ejecuciones del agente.

**Returns**: `{ runs: RAGResult[], totalRuns: number }`

### `getStatus()`

Obtiene el estado actual del agente.

**Returns**: `{ state: RAGAgentState, uptime: number, isHealthy: boolean }`

### `clearHistory()`

Limpia el historial de ejecuciones.

**Returns**: `{ success: boolean, message: string }`

## 🌐 HTTP Endpoints

### `POST /ask`

Pregunta con respuesta en streaming (plain text).

```bash
curl -X POST http://localhost:8787/agents/intelligent-agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Mi pregunta"}' \
  --no-buffer
```

### `GET /status`

Estado del agente (JSON).

```bash
curl http://localhost:8787/agents/intelligent-agent/status
```

### `GET /history`

Historial de ejecuciones (JSON).

```bash
curl http://localhost:8787/agents/intelligent-agent/history
```

## 📦 State Schema

```typescript
interface RAGAgentState {
  totalRuns: number;
  lastQuestion?: string;
  lastRunId?: string;
  lastRunStatus?: 'pending' | 'running' | 'completed' | 'failed';
  documentsRetrieved?: number;
  lastUpdated: number;
}
```

El estado se sincroniza automáticamente con todos los clientes WebSocket conectados.

## 🔧 Configuración en wrangler.jsonc

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "INTELLIGENT_AGENT",
        "class_name": "IntelligentAgent"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["IntelligentAgent"]
    }
  ]
}
```

## 🎯 Ventajas vs Durable Object tradicional

| Característica | Durable Object | Cloudflare Agent |
|---------------|----------------|------------------|
| State Management | Manual (KV/SQL) | Automático (`this.state`) |
| WebSocket RPC | Manual | Decorador `@callable` |
| State Sync | Manual broadcast | Automático |
| SQL Queries | Verboso | Template tag `this.sql` |
| Streaming | Manual TransformStream | AsyncGenerator |
| HTTP + WS | Dos handlers separados | Unificado |

## 📝 Ejemplo Completo de Streaming

```javascript
// El método askQuestion es un AsyncGenerator
async function* askQuestion(question) {
  yield "🚀 Starting...\n";
  
  const embedding = await generateEmbedding(question);
  yield "✅ Embedding generated\n";
  
  const docs = await searchDocs(embedding);
  yield "✅ Found documents\n";
  
  for await (const chunk of streamAnswer(question, docs)) {
    yield chunk; // Stream respuesta palabra por palabra
  }
  
  return { answer: fullAnswer, status: 'completed' };
}
```

Esto hace que el cliente reciba updates en tiempo real conforme el agente progresa.

## 🧪 Testing

### 1. Iniciar el servidor

```bash
npm run dev
```

### 2. Probar HTTP streaming

```bash
curl -X POST http://localhost:8787/agents/intelligent-agent/ask \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Si tengo una empresa de software medioambiental para salmoneras, en el sur de chile, que sugerencias tienes de como puedo cumplir con la ley de protección de datos personales?"
  }' \
  --no-buffer
```

### 3. Probar WebSocket (usando websocat)

```bash
echo '{"type":"rpc","id":"1","method":"askQuestion","args":["¿Qué es la Ley Fintech?"]}' | \
  websocat ws://localhost:8787/agents/intelligent-agent
```

## 🎨 Arquitectura

```
┌─────────────────────────────────────────┐
│         Client (HTTP/WebSocket)         │
└──────────────┬──────────────────────────┘
               │
               ├─ POST /ask → onRequest()
               │
               └─ WS RPC → @callable methods
                           │
┌──────────────┴──────────────────────────┐
│      IntelligentAgent (Cloudflare)      │
│                                          │
│  • State Management (this.state)        │
│  • SQL Storage (this.sql)               │
│  • WebSocket Broadcasting               │
│  • AsyncGenerator Streaming             │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
   ┌───▼───┐      ┌────▼────┐      ┌──────▼──────┐
   │  AI   │      │Vectorize│      │      D1     │
   │Embed  │      │ Search  │      │  Documents  │
   └───┬───┘      └────┬────┘      └──────┬──────┘
       │               │                   │
       └───────────────┴───────────────────┘
                       │
                  RAG Pipeline
```

## 📚 Referencias

- [Cloudflare Agents Docs](https://developers.cloudflare.com/agents/)
- [Agent Class Internals](https://developers.cloudflare.com/agents/concepts/agent-class/)
- [Agents NPM Package](https://www.npmjs.com/package/agents)
- [Agent Patterns](https://developers.cloudflare.com/agents/patterns/)

## 🔑 Key Takeaways

1. **`@callable`** permite RPC automático via WebSocket
2. **`this.state` + `this.setState()`** maneja persistencia automáticamente
3. **AsyncGenerator** permite streaming natural
4. **`this.sql`** template tag simplifica queries SQL
5. **`onConnect/onMessage/onClose`** manejan WebSocket automáticamente
6. **State broadcasting** es automático a todos los clientes
