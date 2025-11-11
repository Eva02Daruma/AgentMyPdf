import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { Agent } from "agents";

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * AI Gateway configuration
 */
const GATEWAY_ID = "agentmypdf";

// ============================================================================
// TYPES
// ============================================================================

export type AgentRunStatus = "pending" | "running" | "completed" | "failed";

export interface AgentRun {
  id: string;
  question: string;
  status: AgentRunStatus;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}


const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const TEXT_GENERATION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";



// ============================================================================
// DURABLE OBJECT CLASS
// ============================================================================

/**
 * MyAgent Durable Object
 *
 * Manages agent runs for analyzing legal documents using Workers AI.
 * Provides asynchronous processing with persistent state storage.
 *
 * Uses RAG (Retrieval Augmented Generation) to:
 * 1. Convert question to embeddings
 * 2. Search similar vectors in Vectorize
 * 3. Retrieve relevant documents from D1
 * 4. Generate answer with context using AI
 */
export class MyAgent extends DurableObject<Env> {
  // --------------------------------------------------------------------------
  // PUBLIC METHODS
  // --------------------------------------------------------------------------

  /**
   * Main entry point for HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "POST" && path === "/run") {
        return await this.handleCreateRun(request);
      }

      if (request.method === "GET" && path.startsWith("/status/")) {
        const runId = path.split("/")[2];
        return await this.handleGetStatus(runId);
      }

      return this.errorResponse("Not Found", 404);
    } catch (error) {
      console.error("Fetch error:", error);
      return this.errorResponse(
        error instanceof Error ? error.message : "Internal server error",
        500
      );
    }
  }

  // --------------------------------------------------------------------------
  // HTTP HANDLERS
  // --------------------------------------------------------------------------

  /**
   * Handle POST /run - Create a new agent run
   */
  private async handleCreateRun(request: Request): Promise<Response> {
    const body = await request.json<{ question: string }>();

    if (!body.question) {
      return this.errorResponse("Question is required", 400);
    }

    const runId = crypto.randomUUID();
    const run: AgentRun = {
      id: runId,
      question: body.question,
      status: "pending",
      createdAt: Date.now(),
    };

    await this.saveRun(runId, run);

    // Start processing asynchronously (fire and forget)
    this.ctx.waitUntil(this.processRun(runId));

    return this.jsonResponse(
      {
        success: true,
        runId,
        status: "pending",
        message: "Agent run created. Processing asynchronously.",
      },
      202
    );
  }

  /**
   * Handle GET /status/:runId - Get agent run status
   */
  private async handleGetStatus(runId: string): Promise<Response> {
    const run = await this.loadRun(runId);

    if (!run) {
      return this.errorResponse("Run not found", 404);
    }

    return this.jsonResponse({
      success: true,
      data: run,
    });
  }

  // --------------------------------------------------------------------------
  // PROCESSING LOGIC (RAG Pipeline)
  // --------------------------------------------------------------------------

  /**
   * Process a question through the RAG pipeline
   */
  private async processRun(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    if (run.status !== "pending") {
      console.log(`Run ${runId} already ${run.status}, skipping`);
      return;
    }

    const startTime = Date.now();

    try {
      console.log(`\n${"=".repeat(80)}`);
      console.log(`🚀 [${runId}] Started RAG Pipeline`);
      console.log(
        `❓ Question: "${run.question.substring(0, 100)}${run.question.length > 100 ? "..." : ""}"`
      );
      console.log(`${"=".repeat(80)}\n`);

      // Update to running status
      run.status = "running";
      await this.saveRun(runId, run);
      await this.notifyWebSocket(runId, { status: "running", step: "started" });

      // Step 1: Generate query embedding
      console.log(`[${runId}] 📊 Step 1/4: Generating query embedding...`);
      const embeddingStart = Date.now();
      const queryEmbedding = await this.generateEmbedding(run.question);
      console.log(
        `  ✅ Embedding generated in ${Date.now() - embeddingStart}ms (${queryEmbedding.length} dimensions)`
      );
      await this.notifyWebSocket(runId, { 
        status: "running", 
        step: "embedding_complete",
        elapsed: Date.now() - embeddingStart
      });

      // Step 2: Search similar vectors
      console.log(
        `\n[${runId}] 🔍 Step 2/4: Searching similar vectors in Vectorize...`
      );
      const searchStart = Date.now();
      const searchResults = await this.searchVectors(queryEmbedding);
      console.log(
        `  ✅ Vector search completed in ${Date.now() - searchStart}ms`
      );

      // Step 3: Retrieve relevant documents
      console.log(`\n[${runId}] 📚 Step 3/4: Retrieving documents from D1...`);
      const retrieveStart = Date.now();
      const documents = await this.retrieveDocuments(searchResults);
      console.log(
        `  ✅ Document retrieval completed in ${Date.now() - retrieveStart}ms`
      );
      await this.notifyWebSocket(runId, { 
        status: "running", 
        step: "documents_retrieved",
        documentCount: documents.length,
        elapsed: Date.now() - retrieveStart
      });

      // Step 4: Generate answer with context
      console.log(
        `\n[${runId}] 🤖 Step 4/4: Generating answer with ${documents.length} documents...`
      );
      const generateStart = Date.now();
      const answer = await this.generateAnswer(run.question, documents);
      console.log(`  ✅ Answer generated in ${Date.now() - generateStart}ms`);

      // Mark as completed
      const totalTime = Date.now() - startTime;
      run.status = "completed";
      run.result = answer;
      run.completedAt = Date.now();
      await this.saveRun(runId, run);

      // Notify WebSocket subscribers of completion
      await this.notifyWebSocket(runId, { 
        status: "completed",
        result: answer,
        totalTime,
        answerLength: answer.length
      });

      console.log(`\n${"=".repeat(80)}`);
      console.log(`✅ [${runId}] Pipeline Completed Successfully`);
      console.log(`⏱️  Total time: ${totalTime}ms`);
      console.log(`📝 Answer length: ${answer.length} characters`);
      console.log(`${"=".repeat(80)}\n`);
    } catch (error) {
      console.error(`\n❌ [${runId}] Pipeline Failed:`, error);
      await this.markRunAsFailed(runId, error);
    }
  }

  /**
   * Generate embedding for text using Workers AI
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.env.AI.run(
      EMBEDDING_MODEL,
      {
        text: text,
      },
      {
        gateway: {
          id: GATEWAY_ID,
        },
      }
    );

    const values = (response as any).data?.[0];
    if (!values) throw new Error("Failed to generate embedding");
    return values as number[];
  }

  /**
   * Search for similar vectors in Vectorize
   */
  private async searchVectors(queryEmbedding: number[]): Promise<any[]> {
    const results = await this.env.VECTORIZE.query(queryEmbedding, {
      topK: 10, // Increased from 5 to get more context
      returnMetadata: true,
    });

    const matches = results.matches || [];

    // Log search results for debugging
    console.log(`  🔍 Vector search found ${matches.length} matches`);
    if (matches.length > 0) {
      console.log(
        `  📊 Top match score: ${matches[0]?.score?.toFixed(4) || "N/A"}`
      );
      console.log(
        `  📚 Sources: ${[...new Set(matches.map((m: any) => m.metadata?.source))].join(", ")}`
      );
    }

    return matches;
  }

  /**
   * Retrieve documents from D1 based on vector search results
   */
  private async retrieveDocuments(searchResults: any[]): Promise<string[]> {
    if (searchResults.length === 0) {
      console.log("  ⚠️  No vector matches found");
      return [];
    }

    const documentIds = searchResults.map((result) => result.id);
    const placeholders = documentIds.map(() => "?").join(",");

    const query = `SELECT id, text, source FROM documents WHERE id IN (${placeholders})`;
    const { results } = await this.env.database
      .prepare(query)
      .bind(...documentIds)
      .all();

    console.log(`  📥 Retrieved ${results?.length || 0} documents from D1`);

    if (!results || results.length === 0) {
      console.log("  ⚠️  No documents found in D1 for vector matches");
      return [];
    }

    // Format documents with source citations
    const formattedDocs = (results || []).map((doc: any) => {
      const preview = doc.text.substring(0, 100);
      console.log(`  📄 Doc ${doc.id} from ${doc.source}: "${preview}..."`);
      return `[Fuente: ${doc.source}]\n${doc.text}`;
    });

    return formattedDocs;
  }

  /**
   * Generate answer using Workers AI with retrieved context
   */
  private async generateAnswer(
    question: string,
    documents: string[]
  ): Promise<string> {
    // Handle case with no documents
    if (documents.length === 0) {
      return "Lo siento, no encontré información relevante en la base de conocimiento legal para responder tu pregunta. Por favor, intenta reformular tu consulta o verifica que los documentos necesarios hayan sido procesados.";
    }

    const prompt = this.buildPrompt(question, documents);

    const response = await this.env.AI.run(
      TEXT_GENERATION_MODEL,
      {
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente legal especializado en leyes chilenas. DEBES basar tu respuesta ÚNICAMENTE en los documentos proporcionados y SIEMPRE citar las fuentes específicas usando el formato [Fuente: nombre-ley].",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      },
      {
        gateway: {
          id: GATEWAY_ID,
        },
      }
    );

    return this.extractResponseText(response);
  }

  // --------------------------------------------------------------------------
  // STORAGE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Load a run from storage
   */
  private async loadRun(runId: string): Promise<AgentRun | null> {
    return (await this.ctx.storage.get<AgentRun>(`run:${runId}`)) || null;
  }

  /**
   * Save a run to storage
   */
  private async saveRun(runId: string, run: AgentRun): Promise<void> {
    await this.ctx.storage.put(`run:${runId}`, run);
  }

  /**
   * Update run status
   */
  private async updateRunStatus(
    runId: string,
    run: AgentRun,
    status: AgentRunStatus
  ): Promise<void> {
    run.status = status;
    await this.saveRun(runId, run);
  }

  /**
   * Mark a run as failed
   */
  private async markRunAsFailed(runId: string, error: unknown): Promise<void> {
    console.error(`Run ${runId} failed:`, error);

    const run = await this.loadRun(runId);
    if (!run) return;

    run.status = "failed";
    run.error = error instanceof Error ? error.message : "Unknown error";
    run.completedAt = Date.now();
    await this.saveRun(runId, run);
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  /**
   * Build a prompt for the AI model with RAG context
   * Following Cloudflare RAG best practices for citation
   */
  private buildPrompt(question: string, documents: string[]): string {
    // Format documents with clear separation
    const formattedDocs = documents
      .map((doc, idx) => `DOCUMENTO ${idx + 1}:\n${doc}`)
      .join("\n\n---\n\n");

    return `A continuación se presentan fragmentos de leyes chilenas. Responde la pregunta basándote EXCLUSIVAMENTE en estos documentos.

=== DOCUMENTOS LEGALES ===
${formattedDocs}

=== PREGUNTA ===
${question}

=== INSTRUCCIONES IMPORTANTES ===
1. DEBES citar la fuente específica [Fuente: ...] para cada afirmación
2. Si mencionas un artículo o disposición, indica de qué ley proviene
3. Si la respuesta requiere información de múltiples documentos, cítalos todos
4. Proporciona recomendaciones prácticas y accionables
5. Si los documentos no contienen información suficiente, dilo explícitamente

=== FORMATO DE RESPUESTA ===
Estructura tu respuesta así:
- Primero: Resume brevemente qué leyes aplican
- Luego: Proporciona la respuesta detallada citando fuentes
- Finalmente: Da recomendaciones prácticas

RESPUESTA:`;
  }

  /**
   * Extract text from AI response
   */
  private extractResponseText(response: unknown): string {
    if (typeof response === "object" && response !== null) {
      const resp = response as any;

      if (resp.response) {
        return String(resp.response);
      }

      if (resp.text) {
        return String(resp.text);
      }

      return JSON.stringify(response);
    }

    return String(response);
  }

  /**
   * Create a JSON response
   */
  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Create an error response
   */
  private errorResponse(message: string, status = 400): Response {
    return this.jsonResponse(
      {
        success: false,
        error: message,
      },
      status
    );
  }

  /**
   * Notify WebSocket subscribers about run updates
   */
  private async notifyWebSocket(runId: string, update: unknown): Promise<void> {
    try {
      // Get WebSocket Durable Object instance
      const wsId = this.env.AgentWebSocket.idFromName("websocket-server");
      const wsStub = this.env.AgentWebSocket.get(wsId);

      // Call the broadcastRunUpdate method via fetch
      await wsStub.fetch("http://internal/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, update }),
      });
    } catch (error) {
      // Don't fail the run if WebSocket notification fails
      console.error(`⚠️  Failed to notify WebSocket for run ${runId}:`, error);
    }
  }
}
