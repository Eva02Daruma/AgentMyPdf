import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * AgentWebSocket Durable Object
 * 
 * Manages WebSocket connections for real-time agent run updates.
 * Clients can subscribe to specific run IDs to receive progress updates.
 */
export class AgentWebSocket extends DurableObject<Env> {
  // Map of client ID to WebSocket connection
  private sessions: Map<string, WebSocket>;
  // Map of run ID to set of subscribed client IDs
  private runSubscriptions: Map<string, Set<string>>;
  // Set of client IDs subscribed to ALL runs (global subscription)
  private globalSubscribers: Set<string>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();
    this.runSubscriptions = new Map();
    this.globalSubscribers = new Set();
    console.log("🔌 AgentWebSocket: Constructor called (hibernation or first init)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle internal broadcast requests from MyAgent
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const { runId, update } = await request.json<{ runId: string; update: unknown }>();
      await this.broadcastRunUpdate(runId, update);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { 
        status: 426,
        statusText: "Upgrade Required"
      });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Generate unique client ID
    const clientId = crypto.randomUUID();
    this.sessions.set(clientId, server);

    console.log(`🔌 New WebSocket connection accepted - Client: ${clientId}`);

    // Set up event handlers
    server.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(clientId, event.data);
    });

    server.addEventListener("close", () => {
      this.handleClose(clientId);
    });

    server.addEventListener("error", (event: ErrorEvent) => {
      console.error(`❌ WebSocket error for client ${clientId}:`, event);
      this.handleClose(clientId);
    });

    // Send welcome message
    server.send(JSON.stringify({
      type: "connected",
      clientId,
      timestamp: Date.now(),
      message: "Connected to Agent WebSocket Server"
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(clientId: string, data: string): void {
    console.log(`📨 WebSocket message received from ${clientId}`);
    
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "subscribe":
          this.handleSubscribe(clientId, message.runId);
          break;
        
        case "unsubscribe":
          this.handleUnsubscribe(clientId, message.runId);
          break;
        
        case "ping":
          this.handlePing(clientId);
          break;
        
        default:
          this.sendToClient(clientId, {
            type: "error",
            message: `Unknown message type: ${message.type}`
          });
      }
    } catch (error) {
      console.error(`❌ Error parsing message from ${clientId}:`, error);
      this.sendToClient(clientId, {
        type: "error",
        message: "Invalid JSON message"
      });
    }
  }

  /**
   * Subscribe client to a run ID or to ALL runs
   */
  private handleSubscribe(clientId: string, runId: string): void {
    // Special case: subscribe to ALL runs
    if (!runId || runId === "all" || runId === "*") {
      this.globalSubscribers.add(clientId);
      console.log(`✅ Client ${clientId} subscribed to ALL runs (global)`);
      
      this.sendToClient(clientId, {
        type: "subscribed",
        runId: "all",
        scope: "global",
        timestamp: Date.now(),
        message: "Subscribed to all runs"
      });
      return;
    }

    // Add client to specific run subscriptions
    if (!this.runSubscriptions.has(runId)) {
      this.runSubscriptions.set(runId, new Set());
    }
    this.runSubscriptions.get(runId)!.add(clientId);

    console.log(`✅ Client ${clientId} subscribed to run ${runId}`);

    this.sendToClient(clientId, {
      type: "subscribed",
      runId,
      scope: "specific",
      timestamp: Date.now()
    });
  }

  /**
   * Unsubscribe client from a run ID or from global subscription
   */
  private handleUnsubscribe(clientId: string, runId: string): void {
    // Unsubscribe from global
    if (!runId || runId === "all" || runId === "*") {
      this.globalSubscribers.delete(clientId);
      this.sendToClient(clientId, {
        type: "unsubscribed",
        runId: "all",
        scope: "global",
        timestamp: Date.now()
      });
      return;
    }

    // Unsubscribe from specific run
    if (this.runSubscriptions.has(runId)) {
      this.runSubscriptions.get(runId)!.delete(clientId);
      
      // Clean up empty subscription sets
      if (this.runSubscriptions.get(runId)!.size === 0) {
        this.runSubscriptions.delete(runId);
      }
    }

    this.sendToClient(clientId, {
      type: "unsubscribed",
      runId,
      scope: "specific",
      timestamp: Date.now()
    });
  }

  /**
   * Handle ping from client
   */
  private handlePing(clientId: string): void {
    this.sendToClient(clientId, {
      type: "pong",
      timestamp: Date.now()
    });
  }

  /**
   * Handle client disconnect
   */
  private handleClose(clientId: string): void {
    console.log(`🔌 Client ${clientId} disconnected`);
    
    // Remove from global subscribers
    this.globalSubscribers.delete(clientId);
    
    // Remove from all run-specific subscriptions
    for (const [runId, subscribers] of this.runSubscriptions.entries()) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.runSubscriptions.delete(runId);
      }
    }

    // Remove session
    this.sessions.delete(clientId);
  }

  /**
   * Send message to specific client
   */
  private sendToClient(clientId: string, data: unknown): void {
    const ws = this.sessions.get(clientId);
    if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Broadcast update to all clients subscribed to a run (specific + global)
   * This method is called from MyAgent via alarm or direct fetch
   */
  async broadcastRunUpdate(runId: string, update: unknown): Promise<void> {
    const specificSubscribers = this.runSubscriptions.get(runId) || new Set();
    
    // Combine specific subscribers + global subscribers
    const allRecipients = new Set([...specificSubscribers, ...this.globalSubscribers]);

    if (allRecipients.size === 0) {
      console.log(`📭 No subscribers for run ${runId}`);
      return;
    }

    console.log(`📢 Broadcasting update for run ${runId} to ${allRecipients.size} clients (${specificSubscribers.size} specific + ${this.globalSubscribers.size} global)`);

    const message = JSON.stringify({
      type: "run_update",
      runId,
      update,
      timestamp: Date.now()
    });

    // Send to all recipients
    for (const clientId of allRecipients) {
      const ws = this.sessions.get(clientId);
      if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          console.error(`❌ Error sending to client ${clientId}:`, error);
        }
      } else {
        // Clean up stale connections
        specificSubscribers.delete(clientId);
        this.globalSubscribers.delete(clientId);
      }
    }

    // Clean up empty subscription sets
    if (specificSubscribers.size === 0) {
      this.runSubscriptions.delete(runId);
    }
  }

  /**
   * Get statistics about current connections
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      totalSubscriptions: this.runSubscriptions.size,
      runDetails: Array.from(this.runSubscriptions.entries()).map(([runId, clients]) => ({
        runId,
        subscriberCount: clients.size
      }))
    };
  }
}
