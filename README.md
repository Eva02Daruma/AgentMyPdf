
> **Agentic system for legal document compliance Q&A using Cloudflare Workers, AI, and RAG**

Este es un sistema agentico inteligente que puede leer y razonar sobre documentos legales , proporcionando respuestas precisas basadas en compliance y regulaciones.

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions](#-design-decisions)
- [Data Extraction & RAG Pipeline](#-data-extraction--rag-pipeline)
- [Model Usage](#-model-usage)
- [Agent Architecture](#-agent-architecture)
- [Getting Started](#-getting-started)
- [Testing the Project](#-testing-the-project)
- [API Endpoints](#-api-endpoints)
- [Trade-offs & Considerations](#-trade-offs--considerations)

---

## 🏗️ Architecture Overview

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER REQUEST                              │
│                   POST /question {"question": "..."}             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE WORKER (Hono)                       │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  1. Validate Request                                    │    │
│  │  2. Create runId                                        │    │
│  │  3. Queue to IntelligentAgent (Durable Object)         │    │
│  │  4. Return 202 Accepted + statusUrl                    │    │
│  └────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│           INTELLIGENT AGENT (Durable Object + Agents SDK)       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  GUARDRAIL: Relevance Check                             │  │
│  │  • LLM classifies if question is compliance-related     │  │
│  │  • Rejects casual greetings, off-topic questions        │  │
│  └─────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  RAG PIPELINE (Structured Reasoning)                    │  │
│  │                                                           │  │
│  │  PHASE 1: EXTRACTION                                     │  │
│  │  └─ Tool: Text Embedding Generator                      │  │
│  │     └─ Workers AI (@cf/baai/bge-base-en-v1.5)          │  │
│  │                                                           │  │
│  │  PHASE 2: SEARCH                                         │  │
│  │  └─ Tool: Vector Similarity Search                      │  │
│  │     └─ Vectorize (top-10 semantic search)              │  │
│  │                                                           │  │
│  │  PHASE 3: RETRIEVAL                                      │  │
│  │  └─ Tool: Document Retriever                            │  │
│  │     └─ D1 Database (structured docs + metadata)        │  │
│  │                                                           │  │
│  │  PHASE 4: GENERATION                                     │  │
│  │  └─ Tool: LLM Answer Generator                          │  │
│  │     └─ Workers AI (@cf/meta/llama-4-scout-17b...)      │  │
│  │     └─ Chain-of-thought prompting                       │  │
│  │                                                           │  │
│  │  PHASE 5: EVALUATION                                     │  │
│  │  └─ Quality checks (content, citations, relevance)      │  │
│  └─────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  PERSISTENCE                                             │  │
│  │  • Store in agent_runs table (D1)                       │  │
│  │  • Track metrics, tools used, latency                   │  │
│  │  • Update agent state                                   │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   USER POLLS STATUS                              │
│              GET /status/:runId → returns answer                 │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Cloudflare Worker (Hono)**: HTTP API layer
2. **IntelligentAgent (Durable Object)**: Agentic processing with state management
3. **Workers AI**: Embeddings + LLM inference
4. **Vectorize**: Semantic vector search
5. **D1 Database**: Document storage + run history
6. **AI Gateway**: Observability and caching

---

## 🎯 Design Decisions

### 1. **Cloudflare Agents SDK over Custom Implementation**

**Decision**: Use Cloudflare's official Agents SDK instead of building a custom agent system.

**Rationale**:
- ✅ Built-in state management with automatic persistence
- ✅ RPC support for direct method calls
- ✅ WebSocket integration for real-time updates
- ✅ SQL storage integrated (no external DB needed)
- ✅ Follows Cloudflare best practices

**Implementation**: `IntelligentAgent` extends `Agent<Env, RAGAgentState>`

### 2. **Durable Objects for Stateful Agent**

**Decision**: Use Durable Objects to manage agent state and ensure consistency.

**Rationale**:
- ✅ Single instance ensures no race conditions
- ✅ Built-in persistence (state survives restarts)
- ✅ Co-location with data (SQL, state in same location)
- ✅ Can run long operations without timeouts

### 3. **Asynchronous Processing**

**Decision**: Return immediately (202 Accepted) and process in background.

**Rationale**:
- ✅ Agent runs can take 10+ seconds
- ✅ User doesn't need to keep connection open
- ✅ Resilient to network issues
- ✅ Can handle multiple requests concurrently

**Implementation**:
```typescript
// POST /question returns immediately
{ "runId": "...", "statusUrl": "/status/run-xxx" }

// Agent processes in background using ctx.waitUntil
await agent.processQuestion({ question, runId });
```

### 4. **Guardrails for Compliance Focus**

**Decision**: Add LLM-based relevance filter before RAG pipeline.

**Rationale**:
- ✅ Prevents hallucinations on irrelevant questions
- ✅ Saves compute (no embedding/search for "Hello")
- ✅ Clear user feedback for off-topic questions
- ✅ Aligns with compliance Q&A purpose

**Implementation**:
- Uses separate LLM call with binary classification
- Low temperature (0.1) for consistent filtering
- Fast response (~500ms)

### 5. **Structured Reasoning with Tool Tracking**

**Decision**: Explicit phases with tool usage metrics.

**Rationale**:
- ✅ Observable reasoning process
- ✅ Easy to debug which phase failed
- ✅ Metrics for optimization
- ✅ Matches interview requirements

**Phases**:
1. **Guardrail**: Relevance Check (optional)
2. **Extraction**: Generate question embedding
3. **Search**: Vector similarity in Vectorize
4. **Retrieval**: Fetch full documents from D1
5. **Generation**: LLM answer with chain-of-thought
6. **Evaluation**: Quality assessment

### 6. **Chain-of-Thought Prompting**

**Decision**: Structured prompts following Cloudflare best practices.

**Rationale**:
- ✅ Better reasoning quality
- ✅ Explicit citation requirements
- ✅ Metadata context (relevance scores)
- ✅ Output format specification

---

## 📊 Data Extraction & RAG Pipeline

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
