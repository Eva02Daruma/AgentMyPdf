import { Agent, callable } from "agents";
import type { Env } from "./types";

// ============================================================================
// TYPES
// ============================================================================

export type AgentRunStatus = "pending" | "running" | "completed" | "failed";

export interface RAGAgentState {
  totalRuns: number;
  lastQuestion?: string;
  lastRunId?: string;
  lastRunStatus?: AgentRunStatus;
  documentsRetrieved?: number;
  lastDocumentSources?: string[]; // Track document sources for context
  lastSearchScore?: number; // Track search quality
  lastUpdated: number;
}

interface RAGResult {
  runId: string;
  question: string;
  answer: string;
  documentsUsed: number;
  status: AgentRunStatus;
  toolsUsed: string[];
  toolCallCount: number;
  latencyMs: number;
  createdAt: number;
  completedAt: number;
}

// Track tools and reasoning steps
interface ToolMetrics {
  name: string;
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  result?: any;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const TEXT_GENERATION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const GATEWAY_ID = "agentmypdf";

// ============================================================================
// CLOUDFLARE AGENT - RAG for Legal Documents
// ============================================================================

/**
 * IntelligentAgent - Cloudflare Agent con RAG Pipeline
 *
 * Implementa un sistema de preguntas y respuestas sobre documentos legales usando:
 * - Cloudflare Agents SDK (con state management, RPC, WebSockets)
 * - RAG (Retrieval Augmented Generation)
 * - Workers AI para embeddings y generación
 * - Vectorize para búsqueda semántica
 * - D1 para almacenamiento de documentos
 * - Streaming de respuestas
 */
export class IntelligentAgent extends Agent<Env, RAGAgentState> {
  // Estado inicial del agente
  initialState: RAGAgentState = {
    totalRuns: 0,
    lastUpdated: Date.now(),
  };

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================

  /**
   * Se ejecuta cuando el agente inicia (primera vez o después de hibernación)
   */
  async onStart() {
    console.log("🤖 IntelligentAgent started");
    console.log("📊 Current state:", this.state);

    // Inicializar tablas SQL para historial de ejecuciones y métricas
    try {
      this.sql`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT,
          documents_used INTEGER,
          status TEXT NOT NULL,
          tools_used TEXT,
          tool_call_count INTEGER DEFAULT 0,
          latency_ms INTEGER,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `;

      console.log("✅ Database tables initialized successfully");
    } catch (error) {
      console.error("❌ Error initializing tables:", error);
    }
  }

  /**
   * Manejador de errores del agente
   */
  onError(connectionOrError: any, error?: unknown) {
    console.error("❌ Agent error:", error || connectionOrError);
    // No lanzar para evitar que el agente se detenga
  }

  /**
   * Se ejecuta cuando el estado cambia
   */
  onStateUpdate(state: RAGAgentState, source: any) {
    console.log("📝 State updated from:", source);
    // Broadcast automático a todos los clientes WebSocket conectados
  }

  // ============================================================================
  // CALLABLE METHODS (RPC via WebSocket o HTTP)
  // ============================================================================

  /**
   * Método principal: Procesa una pregunta usando RAG pipeline
   * Callable via WebSocket RPC o HTTP
   * Returns streaming generator that yields progress updates
   */
  @callable({ description: "Process a legal question using RAG pipeline" })
  async *askQuestion(
    question: string,
    runId?: string
  ): AsyncGenerator<string, RAGResult, unknown> {
    // Use provided runId or generate new one
    const finalRunId = runId || `run-${crypto.randomUUID()}`;
    const startTime = Date.now();
    const toolsUsed: string[] = [];
    let toolCallCount = 0;

    // Asegurar que las tablas existen antes de procesar
    await this.ensureTablesExist();

    // Actualizar estado
    this.setState({
      totalRuns: this.state.totalRuns + 1,
      lastQuestion: question,
      lastRunId: finalRunId,
      lastRunStatus: "running",
      lastUpdated: Date.now(),
    });

    try {
      yield `🚀 [${finalRunId}] Iniciando análisis de pregunta...\n\n`;

      // === GUARDRAIL: RELEVANCE CHECK ===
      console.log("\n=== RELEVANCE CHECK ===");
      yield `🔍 [GUARDRAIL] Verificando relevancia de la pregunta...\n`;

      const isRelevant = await this.isComplianceRelated(question);

      if (!isRelevant) {
        console.log("❌ Question is NOT compliance-related, returning early");
        yield `⚠️ Pregunta no relacionada con compliance legal detectada.\n\n`;

        const notRelevantAnswer = `La entrada proporcionada no parece ser una pregunta válida relacionada con el ámbito de compliance o aseguramiento de calidad.
        
Solo puedo responder preguntas relacionadas con:
- Leyes de protección de datos
- Compras públicas (Ley 19.886)
- Protección de consumidores (Ley 19.496)  
- Responsabilidad penal empresarial (Ley 20.393)
- Regulaciones financieras (UAF, CMF)
- Normativas Fintech

Por favor, formule una pregunta específica sobre estas temáticas.`;

        // Save to database even for non-relevant questions
        try {
          this.sql`
            INSERT INTO agent_runs (
              id, question, answer, documents_used, status, 
              tools_used, tool_call_count, latency_ms,
              created_at, completed_at
            )
            VALUES (
              ${finalRunId}, ${question}, ${notRelevantAnswer}, ${0}, ${"completed"},
              ${JSON.stringify(["Relevance Filter"])}, ${1}, ${Date.now() - startTime},
              ${startTime}, ${Date.now()}
            )
          `;
        } catch (error) {
          console.error("Error saving non-relevant run:", error);
        }

        this.setState({
          ...this.state,
          lastRunStatus: "completed",
          lastUpdated: Date.now(),
        });

        return {
          runId: finalRunId,
          question,
          answer: notRelevantAnswer,
          documentsUsed: 0,
          status: "completed",
          toolsUsed: ["Relevance Filter"],
          toolCallCount: 1,
          latencyMs: Date.now() - startTime,
          createdAt: startTime,
          completedAt: Date.now(),
        };
      }

      yield `✅ Pregunta relevante para compliance. Procediendo con búsqueda...\n\n`;

      // === STRUCTURED REASONING: WORD INDEXING PHASE ===
      console.log("\n=== WORD INDEXING PHASE ===");
      yield `🔤 [TOOL: Word Indexing] Generando índice de palabras relacionadas (Prioritizado)...\n`;
      const indexingStart = Date.now();
      const { specific, context } = await this.generateWordIndexing(question);
      const indexingLatency = Date.now() - indexingStart;
      toolsUsed.push("Word Indexing");
      toolCallCount++;
      
      yield `✅ Palabras Clave (Alta Prioridad): ${specific.join(", ")}\n`;
      yield `✅ Contexto (Baja Prioridad): ${context.join(", ")}\n`;
      yield `⏱️ Indexación completada en ${indexingLatency}ms\n\n`;
      
      console.log(`Tool: Word Indexing - Latency: ${indexingLatency}ms`);
      console.log(`Specific: ${specific.join(", ")}`);
      console.log(`Context: ${context.join(", ")}`);

      // === STRUCTURED REASONING: EXTRACTION PHASE ===
      console.log("\n=== EXTRACTION PHASE ===");

      // TOOL 1: Text Embedding Generator
      yield `📊 [TOOL: Text Embedding Generator] Generando embedding de la pregunta (con contexto enriquecido)...\n`;
      const embeddingStart = Date.now();
      
      // Enhance query with related words for better semantic matching
      // We emphasize specific terms by placing them first and labeling them
      const enhancedQuery = `${question}
      
CONCEPTOS CLAVE (Alta Relevancia): ${specific.join(", ")}
CONTEXTO GENERAL: ${context.join(", ")}`;
      
      const queryEmbedding = await this.generateEmbedding(enhancedQuery);
      const embeddingLatency = Date.now() - embeddingStart;
      toolsUsed.push("Text Embedding Generator");
      toolCallCount++;
      yield `✅ Embedding generado (${queryEmbedding.length} dimensiones) en ${embeddingLatency}ms\n\n`;
      console.log(
        `Tool: Text Embedding Generator - Latency: ${embeddingLatency}ms`
      );

      // === STRUCTURED REASONING: SEARCH PHASE ===
      console.log("\n=== SEARCH PHASE ===");

      // TOOL 2: Vector Similarity Search
      yield `🔍 [TOOL: Vector Similarity Search] Buscando en Vectorize...\n`;
      const searchStart = Date.now();
      const searchResults = await this.searchVectors(queryEmbedding);
      const searchLatency = Date.now() - searchStart;
      toolsUsed.push("Vector Similarity Search");
      toolCallCount++;
      yield `✅ Encontrados ${searchResults.length} resultados en ${searchLatency}ms\n\n`;
      
      // Calculate Relevance Metrics
      const topMatch = searchResults.length > 0 ? searchResults[0] : null;
      const topScore = topMatch ? (topMatch.score || 0) : 0;
      const avgScore = searchResults.length > 0 
        ? searchResults.reduce((sum, r) => sum + (r.score || 0), 0) / searchResults.length 
        : 0;

      // Relevance Confidence (percentage)
      const relevanceConfidence = (topScore * 100).toFixed(1);
      
      console.log(`Tool: Vector Similarity Search - Latency: ${searchLatency}ms`);
      console.log(`📊 Search Metrics: Top Score=${topScore.toFixed(4)}, Avg Score=${avgScore.toFixed(4)}`);
      
      yield `📊 Probabilidad de información relevante: ${relevanceConfidence}%\n`;
      
      if (topScore < 0.7) {
         yield `⚠️ Advertencia: La relevancia de los documentos es baja (< 70%). La respuesta podría ser limitada.\n`;
      }
      yield `\n`;

      // === STRUCTURED REASONING: RETRIEVAL PHASE ===
      console.log("\n=== RETRIEVAL PHASE ===");

      // TOOL 3: Document Retriever
      yield `📚 [TOOL: Document Retriever] Recuperando de D1 Database...\n`;
      const retrieveStart = Date.now();
      const documents = await this.retrieveDocuments(searchResults);
      const retrieveLatency = Date.now() - retrieveStart;
      toolsUsed.push("Document Retriever");
      toolCallCount++;
      yield `✅ Recuperados ${documents.length} documentos en ${retrieveLatency}ms\n\n`;
      console.log(`Tool: Document Retriever - Latency: ${retrieveLatency}ms`);

      // Actualizar estado con documentos recuperados y metadata relevante
      const uniqueSources = [...new Set(documents.map((d) => d.source))];

      this.setState({
        ...this.state,
        documentsRetrieved: documents.length,
        lastDocumentSources: uniqueSources,
        lastSearchScore: avgScore,
      });

      // === STRUCTURED REASONING: GENERATION PHASE ===
      console.log("\n=== GENERATION PHASE ===");

      // TOOL 4: LLM Answer Generator
      yield `📝 [TOOL: LLM Answer Generator] Generando respuesta con LLM...\n`;
      const generationStart = Date.now();

      const systemPrompt = `Eres un asistente experto en Aseguramiento de calidad QA. Tu deber es usar la informacion para asegurar el control de calidad. Responde basándote EXCLUSIVAMENTE en los documentos proporcionados y SIEMPRE cita las fuentes.`;

      const userPrompt = this.buildPrompt(question, documents);

      const llmResponse = await this.env.AI.run(
        TEXT_GENERATION_MODEL,
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 1024,
          temperature: 0.3,
        },
        { gateway: { id: GATEWAY_ID } }
      );

      const generationLatency = Date.now() - generationStart;
      toolsUsed.push("LLM Answer Generator");
      toolCallCount++;
      console.log(
        `Tool: LLM Answer Generator - Latency: ${generationLatency}ms`
      );

      // Extraer la respuesta del formato correcto
      let fullAnswer = "";
      if (typeof llmResponse === "object" && llmResponse !== null) {
        if ("response" in llmResponse) {
          fullAnswer = (llmResponse as any).response;
        } else if (
          "choices" in llmResponse &&
          Array.isArray((llmResponse as any).choices)
        ) {
          const choices = (llmResponse as any).choices;
          if (choices.length > 0 && choices[0].message?.content) {
            fullAnswer = choices[0].message.content;
          }
        }
      }

      if (!fullAnswer) {
        fullAnswer = "No se pudo generar una respuesta válida del modelo.";
        console.error(
          "LLM Response structure:",
          JSON.stringify(llmResponse).slice(0, 500)
        );
      }

      // === EVALUATION PHASE === Evaluar la calidad de la respuesta
      console.log("\n=== EVALUATION PHASE ===");
      yield `🔍 [EVALUATION] Evaluando calidad de la respuesta...\n`;

      const evaluationStart = Date.now();
      const hasRelevantContent =
        fullAnswer.length > 50 && !fullAnswer.includes("No se pudo generar");
      const citesDocuments =
        /\[Documento \d+\]/.test(fullAnswer) || /documento/i.test(fullAnswer);
      const addressesQuestion = question
        .split(" ")
        .some(
          (word) =>
            word.length > 3 &&
            fullAnswer.toLowerCase().includes(word.toLowerCase())
        );

      const evaluationScore = {
        hasContent: hasRelevantContent,
        citesSource: citesDocuments,
        relevant: addressesQuestion,
        overallQuality:
          hasRelevantContent && addressesQuestion
            ? "GOOD"
            : "NEEDS_IMPROVEMENT",
      };

      const evaluationLatency = Date.now() - evaluationStart;
      console.log(
        `Evaluation completed in ${evaluationLatency}ms - Quality: ${evaluationScore.overallQuality}`
      );

      const completedAt = Date.now();
      const totalLatency = completedAt - startTime;

      console.log("\n=== METRICS SUMMARY ===");
      console.log(`Total Latency: ${totalLatency}ms`);
      console.log(`Tools Used: ${toolsUsed.join(", ")}`);
      console.log(`Tool Call Count: ${toolCallCount}`);
      console.log(`Documents Retrieved: ${documents.length}`);

      // Save to database with all metrics
      try {
        this.sql`
          INSERT INTO agent_runs (
            id, question, answer, documents_used, status, 
            tools_used, tool_call_count, latency_ms,
            created_at, completed_at
          )
          VALUES (
            ${finalRunId}, ${question}, ${fullAnswer}, ${documents.length}, ${"completed"},
            ${JSON.stringify(toolsUsed)}, ${toolCallCount}, ${totalLatency},
            ${startTime}, ${completedAt}
          )
        `;
        console.log(`✅ Run ${finalRunId} saved to database successfully`);
      } catch (saveError) {
        console.error(
          `❌ Error saving run ${finalRunId} to database:`,
          saveError
        );
      }

      // Actualizar estado final
      this.setState({
        ...this.state,
        lastRunStatus: "completed",
        lastUpdated: completedAt,
      });

      yield `\n📊 === EXECUTION METRICS ===\n`;
      yield `⏱️ Total Latency: ${totalLatency}ms\n`;
      yield `🔧 Tools Used: ${toolCallCount} (${toolsUsed.join(", ")})\n`;
      yield `📄 Documents Used: ${documents.length}\n`;
      yield `✅ Status: COMPLETED\n`;

      return {
        runId: finalRunId,
        question,
        answer: fullAnswer,
        documentsUsed: documents.length,
        status: "completed",
        toolsUsed,
        toolCallCount,
        latencyMs: totalLatency,
        createdAt: startTime,
        completedAt,
      };
    } catch (error) {
      console.error(`❌ [${finalRunId}] Error:`, error);

      this.setState({
        ...this.state,
        lastRunStatus: "failed",
        lastUpdated: Date.now(),
      });

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      yield `\n❌ Error: ${errorMsg}\n`;

      throw error;
    }
  }

  /**
   * Obtener historial de ejecuciones
   */
  @callable({ description: "Get agent run history" })
  async getHistory(limit: number = 10) {
    try {
      // Asegurar que la tabla existe
      await this.ensureTablesExist();

      const runs = this.sql<any>`
        SELECT 
          id,
          question,
          answer,
          documents_used,
          status,
          tools_used,
          tool_call_count,
          latency_ms,
          created_at,
          completed_at
        FROM agent_runs 
        ORDER BY created_at DESC 
        LIMIT ${limit}
      `;

      // Parse tools_used JSON string back to array
      const parsedRuns = runs.map((run: any) => ({
        ...run,
        tools_used: run.tools_used ? JSON.parse(run.tools_used) : [],
      }));

      return {
        runs: parsedRuns,
        totalRuns: this.state.totalRuns,
      };
    } catch (error) {
      console.error("Error getting history:", error);
      return {
        runs: [],
        totalRuns: this.state.totalRuns,
        error:
          error instanceof Error ? error.message : "Failed to retrieve history",
      };
    }
  }

  /**
   * Obtener estado actual del agente
   */
  @callable({ description: "Get current agent state" })
  async getStatus() {
    return {
      state: this.state,
      uptime: Date.now() - this.state.lastUpdated,
      isHealthy: true,
    };
  }

  /**
   * Limpiar historial
   */
  @callable({ description: "Clear agent history" })
  async clearHistory() {
    this.sql`DELETE FROM agent_runs`;

    this.setState({
      totalRuns: 0,
      lastQuestion: undefined,
      lastRunId: undefined,
      lastRunStatus: undefined,
      documentsRetrieved: undefined,
      lastUpdated: Date.now(),
    });

    return { success: true, message: "History cleared" };
  }

  /**
   * Procesa una pregunta en background (llamado vía RPC desde Worker)
   * Este método se ejecuta asíncrónicamente y persiste el resultado
   * NOTA: Se llama directamente vía RPC, no usa queue system para evitar problemas de routing
   */
  async processQuestion(payload: { question: string; runId: string }) {
    console.log(`🚀 [${payload.runId}] Processing question in background`);

    // Asegurarnos de que la tabla existe antes de procesar
    await this.ensureTablesExist();

    // Ejecutar el procesamiento en background sin bloquear
    // Usamos ctx.waitUntil para que continúe incluso si la request termina
    this.ctx.waitUntil(
      (async () => {
        try {
          // Ejecutar el pipeline RAG completo
          for await (const chunk of this.askQuestion(
            payload.question,
            payload.runId
          )) {
            // Los chunks se loguean pero no se envían al cliente
            // ya que esto corre en background
            if (typeof chunk === "string") {
              // Solo loguear progreso importante, no cada chunk
              if (
                chunk.includes("✅") ||
                chunk.includes("🚀") ||
                chunk.includes("❌")
              ) {
                console.log(chunk.trim());
              }
            }
          }

          console.log(`✅ [${payload.runId}] Question processed successfully`);
        } catch (error) {
          console.error(
            `❌ [${payload.runId}] Error processing question:`,
            error
          );
        }
      })()
    );

    // Retornar inmediatamente sin esperar el resultado
    return {
      success: true,
      runId: payload.runId,
      message: "Processing started in background",
    };
  }

  /**
   * Asegurar que las tablas SQL existen
   */
  private async ensureTablesExist() {
    try {
      // Verificar si la tabla existe
      const tables = this.sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='agent_runs'
      `;

      if (tables.length === 0) {
        console.log("📊 Creating agent_runs table...");
        this.sql`
          CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            question TEXT NOT NULL,
            answer TEXT,
            documents_used INTEGER,
            status TEXT NOT NULL,
            tools_used TEXT,
            tool_call_count INTEGER DEFAULT 0,
            latency_ms INTEGER,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
          )
        `;
        console.log("✅ Table agent_runs created successfully");
      }
    } catch (error) {
      console.error("❌ Error ensuring tables exist:", error);
    }
  }

  /**
   * Verifica si una pregunta está relacionada con compliance legal
   * Usa LLM para clasificación inteligente
   */
  private async isComplianceRelated(question: string): Promise<boolean> {
    console.log(
      `Verificando relevancia de la pregunta con isComplianceRelated: ${question}`
    );
    const classificationPrompt = `Eres un clasificador de preguntas para un sistema de compliance QA.
Tu tarea es determinar si es una pregunta dentro de los temas de compliance, negocio o procedimientos.

PREGUNTA: "${question}"

Analiza si la pregunta menciona leyes, regulaciones, normativas, métodos, procedimientos, criterios de negocio, precios o estándares.
Se DEBEN considerar relevantes las preguntas sobre:
- Criterios para determinar precios o costos.
- Procedimientos operativos o comerciales.
- Regulaciones legales o normativas.
- Métodos de cálculo o estándares de la industria.

Preguntas NO relacionadas incluyen saludos, temas personales o chistes.

Responde con un objeto JSON que tenga la propiedad "is_compliance" como booleano.`;

    try {
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        {
          messages: [
            {
              role: "system",
              content:
                'Eres un clasificador binario. Responde en formato JSON.',
            },
            { role: "user", content: classificationPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: {
                is_compliance: {
                  type: "boolean",
                  description: "Indicates if the question is related to compliance/law"
                }
              },
              required: ["is_compliance"],
            },
          },
          max_tokens: 100,
          temperature: 0.1,
        },
        { gateway: { id: GATEWAY_ID } }
      );

      // Extract response
      let isCompliance = true; // Default to true (safe fallback)
      
      if (typeof response === "object" && response !== null) {
        // Handle Cloudflare AI response structure
        let jsonResponse: any = null;
        
        // Try to parse the response content
        if ("response" in response) {
           // Sometimes it comes as a stringified JSON
           const rawResponse = (response as any).response;
           try {
             jsonResponse = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
           } catch (e) {
             console.warn("Failed to parse JSON from response string:", rawResponse);
           }
        } else if ("choices" in response && Array.isArray((response as any).choices)) {
           const choices = (response as any).choices;
           if (choices.length > 0 && choices[0].message?.content) {
             const rawResponse = choices[0].message.content;
             try {
               jsonResponse = JSON.parse(rawResponse);
             } catch (e) {
               console.warn("Failed to parse JSON from choices:", rawResponse);
             }
           }
        }

        // Check the boolean property
        if (jsonResponse && typeof jsonResponse.is_compliance === 'boolean') {
          isCompliance = jsonResponse.is_compliance;
        } else {
          // Fallback text analysis if JSON parsing fails or property missing
          console.log("JSON schema parsing failed or missing property, falling back to safe mode (true)");
        }
      }

      console.log(`Classification for "${question}": ${isCompliance}`);
      return isCompliance;
    } catch (error) {
      console.error("Error in compliance classification:", error);
      // En caso de error, ser conservador y procesar la pregunta
      return true;
    }
  }

  /**
   * Genera un índice de palabras relacionadas, sinónimos y conceptos clave
   * para mejorar la búsqueda vectorial (Word Indexing Tool)
   */
  private async generateWordIndexing(question: string): Promise<{ specific: string[], context: string[] }> {
    console.log(`Generando Word Indexing para: ${question}`);
    
    const prompt = `Eres una herramienta de indexación de palabras ("Word Indexing Tool").
Tu tarea es identificar los conceptos clave de la pregunta del usuario y generar dos listas de palabras:
1. "specific_terms": Términos técnicos, entidades, productos específicos (Alta Prioridad).
2. "context_terms": Términos generales, categorías, tipos de documento (Baja Prioridad).

ONE SHOT EXAMPLE:
Input: "¿Qué leyes deberia seguir si vendo salmon recien pescado?"
Output: {
  "specific_terms": ["pesca", "marisco", "Sernapesca", "alimentos", "salmón", "fresco"],
  "context_terms": ["reglamento", "normativa", "comercialización", "industria", "ley", "venta"]
}

REGLAS:
1. Analiza el dominio de la pregunta.
2. Separa claramente lo específico de lo general.
3. Incluye sinónimos relevantes.
4. Retorna SOLO un objeto JSON con las dos listas.

Input: "${question}"`;

    try {
      const response = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        {
          messages: [
            {
              role: "system",
              content: 'Eres un asistente de indexación semántica. Responde en formato JSON.',
            },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: {
                specific_terms: {
                  type: "array",
                  items: { type: "string" },
                  description: "Specific technical terms, entities, products"
                },
                context_terms: {
                  type: "array",
                  items: { type: "string" },
                  description: "General context terms, categories, regulations"
                }
              },
              required: ["specific_terms", "context_terms"],
            },
          },
          max_tokens: 300,
          temperature: 0.3,
        },
        { gateway: { id: GATEWAY_ID } }
      );

      // Extract response
      let result = { specific: [] as string[], context: [] as string[] };
      
      if (typeof response === "object" && response !== null) {
        let jsonResponse: any = null;
        
        if ("response" in response) {
           const rawResponse = (response as any).response;
           try {
             jsonResponse = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
           } catch (e) {
             console.warn("Failed to parse JSON from Word Indexing response:", rawResponse);
           }
        } else if ("choices" in response && Array.isArray((response as any).choices)) {
           const choices = (response as any).choices;
           if (choices.length > 0 && choices[0].message?.content) {
             const rawResponse = choices[0].message.content;
             try {
               jsonResponse = JSON.parse(rawResponse);
             } catch (e) {
               console.warn("Failed to parse JSON from Word Indexing choices:", rawResponse);
             }
           }
        }

        if (jsonResponse) {
          if (Array.isArray(jsonResponse.specific_terms)) result.specific = jsonResponse.specific_terms;
          if (Array.isArray(jsonResponse.context_terms)) result.context = jsonResponse.context_terms;
        }
      }

      // Fallback if extraction failed or empty
      if (result.specific.length === 0 && result.context.length === 0) {
        console.log("Word Indexing returned empty or failed, using simpler fallback");
        // Simple fallback: split by spaces
        const words = question.split(' ')
          .map(w => w.replace(/[^\w\s]/gi, '').trim())
          .filter(w => w.length > 4);
        
        // Put all in specific for fallback
        result.specific = words;
      }

      console.log(`Word Indexing result: Specific=[${result.specific.join(", ")}], Context=[${result.context.join(", ")}]`);
      return result;

    } catch (error) {
      console.error("Error in Word Indexing:", error);
      // Fallback on error
      return { specific: [], context: [] };
    }
  }

  /**
   * Genera embedding usando Workers AI
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.env.AI.run(
      EMBEDDING_MODEL,
      { text: [text] },
      { gateway: { id: GATEWAY_ID } }
    );

    return (response as any).data[0];
  }

  /**
   * Busca vectores similares en Vectorize
   */
  private async searchVectors(queryEmbedding: number[]): Promise<any[]> {
    const results = await this.env.VECTORIZE.query(queryEmbedding, {
      topK: 10,
      returnMetadata: true,
    });

    return results.matches || [];
  }

  /**
   * Recupera documentos de D1 basándose en IDs de vectores
   */
  private async retrieveDocuments(
    searchResults: any[]
  ): Promise<
    Array<{ id: string; content: string; source: string; score: number }>
  > {
    if (searchResults.length === 0) {
      return [];
    }

    const documentIds = searchResults.map((result) => result.id);
    const placeholders = documentIds.map(() => "?").join(",");

    const query = `SELECT id, text, source FROM documents WHERE id IN (${placeholders})`;
    const { results } = await this.env.database
      .prepare(query)
      .bind(...documentIds)
      .all();

    if (!results || results.length === 0) {
      return [];
    }

    // Create a map of scores from search results
    const scoreMap = new Map(searchResults.map((r) => [r.id, r.score || 0]));

    return (results || []).map((doc: any) => ({
      id: doc.id,
      content: `[Fuente: ${doc.source}]\n${doc.text}`,
      source: doc.source,
      score: scoreMap.get(doc.id) || 0,
    }));
  }

  /**
   * Genera respuesta con streaming usando Workers AI
   */
  private async *streamAnswer(
    question: string,
    documents: Array<{
      id: string;
      content: string;
      source: string;
      score: number;
    }>
  ): AsyncGenerator<string> {
    // Calculate average score for prompt context
    const avgScore =
      documents.reduce((sum, d) => sum + d.score, 0) / documents.length;
    const prompt = this.buildPrompt(question, documents, avgScore);

    const stream = await this.env.AI.run(
      TEXT_GENERATION_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Eres un asistente experto en aseguramiento de calidad QA.
Tu objetivo es proporcionar respuestas precisas y prácticas basadas ÚNICAMENTE en los documentos proporcionados.
IMPORTANTE: Usa razonamiento paso a paso (chain-of-thought) y siempre cita las fuentes específicas.`,
          },
          { role: "user", content: prompt },
        ],
        stream: true,
      },
      { gateway: { id: GATEWAY_ID } }
    );

    for await (const chunk of stream as any) {
      if (chunk.response) {
        yield chunk.response;
      }
    }
  }

  /**
   * Construye el prompt con contexto de documentos siguiendo mejores prácticas
   * Basado en: https://developers.cloudflare.com/workers/get-started/prompting/
   */
  private buildPrompt(
    question: string,
    documents: Array<{
      id: string;
      content: string;
      source: string;
      score: number;
    }>,
    avgScore?: number
  ): string {
    if (documents.length === 0) {
      return `No se encontraron documentos relevantes para responder la pregunta:\n\n${question}\n\nPor favor, indica que no hay suficiente información en la base de conocimiento.`;
    }

    // Sort documents by score (highest first) for better context prioritization
    const sortedDocs = [...documents].sort((a, b) => b.score - a.score);

    // Format documents with metadata for better context
    const formattedDocs = sortedDocs
      .map(
        (doc, idx) =>
          `[DOCUMENTO ${idx + 1}] (Relevancia: ${(doc.score * 100).toFixed(1)}%)
Fuente: ${doc.source}
Contenido:
${doc.content}`
      )
      .join("\n\n---\n\n");

    // Use chain-of-thought prompting for better reasoning
    const prompt = `Contexto de búsqueda:
- Se encontraron ${documents.length} documentos relevantes
- Relevancia promedio: ${avgScore ? (avgScore * 100).toFixed(1) + "%" : "N/A"}
- Fuentes únicas: ${[...new Set(documents.map((d) => d.source))].join(", ")}

=== DOCUMENTOS RELEVANTES ===
${formattedDocs}

=== PREGUNTA DEL USUARIO ===
${question}

=== PROCESO DE RAZONAMIENTO ===
Por favor, sigue este proceso:

1. IDENTIFICACIÓN: Identifica qué documentos contienen información relevante para la pregunta
2. EXTRACCIÓN: Extrae los puntos clave de cada documento relevante
3. SÍNTESIS: Combina la información de manera coherente
4. RESPUESTA: Formula una respuesta clara y estructurada

=== FORMATO DE RESPUESTA ===
Estructura tu respuesta así:

**Respuesta principal:**
[Tu respuesta aquí, citando fuentes]

**Documentos utilizados:**
[Lista los documentos y su relevancia]

**Recomendaciones:**
[Si aplica, proporciona recomendaciones prácticas]

**Limitaciones:**
[Si falta información, indícalo claramente]

Comienza tu respuesta:`;

    return prompt;
  }

  // ============================================================================
  // HTTP REQUEST HANDLER (alternativa a WebSocket RPC)
  // ============================================================================

  /**
   * Maneja requests HTTP directos al agente
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /question - Queue question for async processing (ASYNCHRONOUS)
    // This endpoint queues the question and returns immediately
    // The agent continues running even if connection drops
    if (path === "/question" && request.method === "POST") {
      try {
        const { question, runId } = await request.json<{
          question: string;
          runId?: string;
        }>();

        if (!question) {
          return new Response(
            JSON.stringify({ error: "Question is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Use provided runId or generate one
        const finalRunId = runId || `run-${crypto.randomUUID()}`;

        // Queue the question processing using the Agent's queue system
        // This ensures it runs asynchronously and continues even if connection drops
        await this.queue("processQuestion", {
          question,
          runId: finalRunId,
        });

        return new Response(
          JSON.stringify({
            success: true,
            runId: finalRunId,
            message: "Question queued for processing",
          }),
          {
            status: 202, // 202 Accepted
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // GET /status - Estado del agente
    if (path === "/status" && request.method === "GET") {
      const status = await this.getStatus();
      return new Response(JSON.stringify(status), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /history - Historial
    if (path === "/history" && request.method === "GET") {
      const history = await this.getHistory();
      return new Response(JSON.stringify(history), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: "Not found",
        availableRoutes: {
          "POST /question": "Ask a question (streaming response)",
          "GET /status": "Get agent status",
          "GET /history": "Get run history",
        },
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ============================================================================
  // WEBSOCKET HANDLERS
  // ============================================================================

  /**
   * Se ejecuta cuando un cliente se conecta via WebSocket
   */
  async onConnect(connection: any, ctx: any) {
    console.log("🔌 Client connected:", connection.id);

    // Enviar estado actual al conectarse
    connection.send(
      JSON.stringify({
        type: "welcome",
        state: this.state,
        message: "🤖 Connected to IntelligentAgent",
      })
    );
  }

  /**
   * Se ejecuta cuando se recibe un mensaje WebSocket
   * Los métodos @callable se manejan automáticamente via RPC
   */
  async onMessage(connection: any, message: string) {
    console.log("📨 Message from", connection.id, ":", message);
    // Los mensajes RPC se manejan automáticamente
    // Este método es para mensajes custom
  }

  /**
   * Se ejecuta cuando un cliente se desconecta
   */
  async onClose(connection: any) {
    console.log("👋 Client disconnected:", connection.id);
  }
}
