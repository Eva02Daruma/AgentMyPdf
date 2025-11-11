import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./types";

// ============================================================================
// CONSTANTS
// ============================================================================

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GATEWAY_ID = "agentmypdf";

// ============================================================================
// RAG WORKFLOW
// ============================================================================

// Payload type for RAG workflow
interface RAGPayload {
	text: string;
	source: string;
}

/**
 * RAG Workflow for Knowledge Seeding
 * 
 * This workflow handles the complete RAG pipeline:
 * 1. Create database record
 * 2. Generate embeddings
 * 3. Store vectors in Vectorize
 */
export class RAGWorkflow extends WorkflowEntrypoint<Env, RAGPayload> {
	async run(event: WorkflowEvent<RAGPayload>, step: WorkflowStep) {
		const env = this.env;
		const { text, source } = event.payload;

		// Step 1: Create database record
		const record = await step.do(`create database record`, async () => {
			const query = "INSERT INTO documents (text, source) VALUES (?, ?) RETURNING *";
			const { results } = await env.database.prepare(query).bind(text, source).run();

			const record = results?.[0];
			if (!record) throw new Error("Failed to create document");
			return record as { id: number; text: string; source: string };
		});

		// Step 2: Generate embedding
		const embedding = await step.do(`generate embedding`, async () => {
			const embeddings = await env.AI.run(
				EMBEDDING_MODEL,
				{
					text: text,
				},
				{
					gateway: {
						id: GATEWAY_ID
					}
				}
			);

			const values = (embeddings as any).data?.[0];
			if (!values) throw new Error("Failed to generate vector embedding");
			return values as number[];
		});

		// Step 3: Insert vector into Vectorize
		await step.do(`insert vector`, async () => {
			return env.VECTORIZE.upsert([
				{
					id: record.id.toString(),
					values: embedding,
					metadata: {
						source: source,
						text: text.substring(0, 500), // Store snippet for reference
					},
				},
			]);
		});

		return {
			success: true,
			documentId: record.id,
			message: "Document indexed successfully",
		};
	}
}
