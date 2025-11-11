import type { Context } from "hono";


// Environment bindings for the Worker
export interface Env {
  AI: Ai;
  database: D1Database;
  VECTORIZE: VectorizeIndex;
  MyAgent: DurableObjectNamespace;
  AgentWebSocket: DurableObjectNamespace;
  INTELLIGENT_AGENT: DurableObjectNamespace;
}

export type AppContext = Context<{ Bindings: Env }>;


// Document types for RAG
export interface Document {
	id: number;
	text: string;
	source: string;
	created_at: string;
}

export interface Vector {
	id: string;
	values: number[];
	metadata?: Record<string, any>;
}
