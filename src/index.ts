import { fromHono } from "chanfana";
import { Hono } from "hono";
import type { Env } from "./types";

// Export Durable Objects, Agent, and Workflow

export { IntelligentAgent } from "./agent";
export { RAGWorkflow } from "./workflow";
export { AgentWebSocket } from "./websocket";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
});

// ============================================================================
// RAG ENDPOINTS
// ============================================================================

/**
 * POST /question - Create a new agent question (ASYNCHRONOUS)
 * 
 * This is the main endpoint for the compliance Q&A agent.
 * Uses IntelligentAgent with Cloudflare Agents SDK.
 * 
 * Flow:
 * 1. Request is received and validated
 * 2. Agent is queued to run asynchronously
 * 3. RunId is returned immediately
 * 4. Agent continues running even if connection drops
 * 5. Use GET /question/:runId to check progress/results
 */
app.post("/question", async (c) => {
	try {
		const body = await c.req.json<{ question: string }>();
		
		if (!body.question) {
			return c.json({
				success: false,
				error: "Question is required"
			}, 400);
		}
		// Generate unique run ID
		const runId = `run-${crypto.randomUUID()}`;
		// Get IntelligentAgent singleton instance
		const agentId = c.env.INTELLIGENT_AGENT.idFromName(runId);
		const agent = c.env.INTELLIGENT_AGENT.get(agentId) as any;
		
		// Queue the question to run asynchronously using Durable Object RPC
		// This calls the processQuestion method directly which queues internally
		// The agent continues running even if connection drops
		await agent.processQuestion({
			question: body.question,
			runId: runId
		});

		return c.json({
			success: true,
			runId: runId,
			status: "running",
			message: "Agent run created and processing in background. Use GET /status/:runId to check progress.",
			statusUrl: `/status/${runId}`
		}, 202); // 202 Accepted - async processing

	} catch (error) {
		console.error("❌ Error creating agent run:", error);
		return c.json({
			success: false,
			error: error instanceof Error ? error.message : "Unknown error"
		}, 500);
	}
});

/**
 * GET /status/:runId - Get the status and result of an agent run
 * 
 * Returns the current state and result (if completed) of a question run.
 * This endpoint can be polled to check progress.
 */
app.get("/status/:runId", async (c) => {
	try {
		const runId = c.req.param("runId");
		
		// Get IntelligentAgent instance for this specific run
		// Since we create a new agent per run in POST /question, we must access the same one here
		const agentId = c.env.INTELLIGENT_AGENT.idFromName(runId);
		const agent = c.env.INTELLIGENT_AGENT.get(agentId) as any;
		
		// Get history using direct RPC call
		const historyData = await agent.getHistory(100); // Get last 100 runs
		
		if (historyData.error) {
			console.error("Error getting history:", historyData.error);
		}
		
		const run = historyData.runs?.find((r: any) => r.id === runId);

		if (!run) {
			// Check if it's in current state (might be still running)
			const status = await agent.getStatus();
			if (status.state.lastRunId === runId) {
				return c.json({
					success: true,
					runId: runId,
					question: status.state.lastQuestion,
					status: status.state.lastRunStatus || 'running',
					documentsUsed: status.state.documentsRetrieved || 0,
					message: "Run is still in progress. Please check again later."
				});
			}
			
			return c.json({
				success: false,
				error: "Run not found. It may not have started yet or the runId is invalid."
			}, 404);
		}

		// Return full run data with metrics
		return c.json({
			success: true,
			runId: run.id,
			question: run.question,
			answer: run.answer,
			documentsUsed: run.documents_used,
			status: run.status,
			toolsUsed: run.tools_used || [],
			toolCallCount: run.tool_call_count || 0,
			latencyMs: run.latency_ms || 0,
			createdAt: run.created_at,
			completedAt: run.completed_at,
			duration: run.completed_at ? (run.completed_at - run.created_at) / 1000 : null,
			metrics: {
				latency: `${run.latency_ms || 0}ms`,
				toolsUsed: run.tools_used || [],
				toolCallCount: run.tool_call_count || 0,
				documentsRetrieved: run.documents_used || 0
			}
		});

	} catch (error) {
		console.error("❌ Error getting question status:", error);
		return c.json({
			success: false,
			error: error instanceof Error ? error.message : "Unknown error"
		}, 500);
	}
});

/**
 * POST /seed - Seed knowledge base with documents
 * Upload documents to the vector database
 */
app.post("/seed", async (c) => {
	try {
		const body = await c.req.json<{ text: string; source: string }>();
		
		if (!body.text || !body.source) {
			return c.json({
				success: false,
				error: "Text and source are required"
			}, 400);
		}

		// Store in D1 and Vectorize
		const query = "INSERT INTO documents (text, source) VALUES (?, ?) RETURNING *";
		const { results } = await c.env.database.prepare(query)
			.bind(body.text, body.source)
			.run();

		const record = results?.[0];
		if (!record) {
			throw new Error("Failed to create document");
		}

		// Generate embedding
		const embeddings = await c.env.AI.run(
			"@cf/baai/bge-base-en-v1.5",
			{
				text: body.text,
			},
			{
				gateway: {
					id: "agentmypdf"
				}
			}
		);

		const values = (embeddings as any).data?.[0];
		if (!values) {
			throw new Error("Failed to generate embedding");
		}

		// Insert into Vectorize
		await c.env.VECTORIZE.upsert([
			{
				id: (record as any).id.toString(),
				values: values,
				metadata: {
					source: body.source,
					text: body.text.substring(0, 500),
				},
			},
		]);

		return c.json({
			success: true,
			documentId: (record as any).id,
			message: "Document indexed successfully",
		});
	} catch (error) {
		return c.json({
			success: false,
			error: error instanceof Error ? error.message : "Unknown error"
		}, 500);
	}
});

/**
 * GET /ws-client - Serve WebSocket test client
 */
app.get("/ws-client", async (c) => {
	const html = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent WebSocket Client</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: white; text-align: center; margin-bottom: 30px; font-size: 2.5em; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .panel { background: white; border-radius: 12px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .panel h2 { color: #667eea; margin-bottom: 20px; font-size: 1.5em; }
        textarea { width: 100%; min-height: 120px; padding: 12px; border: 2px solid #e5e7eb; border-radius: 8px; }
        button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; margin-top: 10px; }
        .messages { background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 8px; padding: 15px; max-height: 400px; overflow-y: auto; font-family: monospace; }
        .message { margin-bottom: 10px; padding: 8px; border-radius: 4px; border-left: 4px solid #667eea; background: white; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔌 Agent WebSocket Client</h1>
        <div class="grid">
            <div class="panel">
                <h2>Create Question</h2>
                <textarea id="question" placeholder="Enter your legal question...">Si tengo una empresa de software medioambiental para salmoneras, en el sur de chile, que sugerencias tienes de como puedo cumplir con la ley de protección de datos personales?</textarea>
                <button onclick="createQuestion()">Send Question</button>
            </div>
            <div class="panel">
                <h2>Messages</h2>
                <div class="messages" id="messages"></div>
            </div>
        </div>
    </div>
    <script>
        let ws = null;
        function addMessage(content) {
            document.getElementById('messages').innerHTML += '<div class="message">' + content + '</div>';
        }
        window.addEventListener('load', () => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + '/ws';
            ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                addMessage('✅ Connected to WebSocket');
                // Auto-subscribe to ALL runs for testing
                ws.send(JSON.stringify({ type: 'subscribe', runId: 'all' }));
                addMessage('🌐 Auto-subscribed to ALL runs (testing mode)');
            };
            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data.type === 'run_update') {
                    addMessage('📢 [' + data.runId + '] ' + data.update.status + ' - ' + (data.update.step || 'processing'));
                    if (data.update.result) addMessage('✅ Result: ' + data.update.result.substring(0, 200) + '...');
                } else if (data.type === 'subscribed') {
                    addMessage('✓ Subscribed to: ' + data.runId);
                }
            };
        });
        async function createQuestion() {
            const q = document.getElementById('question').value;
            const res = await fetch('/question', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: q}) });
            const data = await res.json();
            if (data.success) {
                addMessage('🚀 Question created: ' + data.runId);
                addMessage('⏳ Waiting for updates... (already subscribed to all runs)');
            }
        }
    </script>
</body>
</html>`;
	return c.html(html);
});

/**
 * GET /ws - WebSocket endpoint for real-time agent updates
 * Clients connect here to receive real-time progress updates
 */
app.get("/ws", async (c) => {
	// Check for WebSocket upgrade
	const upgradeHeader = c.req.header("Upgrade");
	if (!upgradeHeader || upgradeHeader !== "websocket") {
		return c.json({
			success: false,
			error: "Expected Upgrade: websocket header"
		}, 426);
	}

	// Get WebSocket Durable Object (using singleton pattern)
	const id = c.env.AgentWebSocket.idFromName("websocket-server");
	const stub = c.env.AgentWebSocket.get(id);

	// Forward the upgrade request to the Durable Object
	return stub.fetch(c.req.raw);
});

// Export the Hono app
export default app;
