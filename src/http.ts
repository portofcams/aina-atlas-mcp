#!/usr/bin/env node
/**
 * Āina Atlas MCP — remote HTTP entry (MCP Streamable HTTP transport).
 * ------------------------------------------------------------------
 * Serves the SAME tools as the stdio server (src/index.ts) over HTTPS, so the
 * server is reachable as a *remote* MCP connector (and is eligible for the
 * Anthropic Connectors Directory, which only accepts remote HTTPS servers).
 *
 * Stateful: a session id is minted on the initialize request and reused for
 * the rest of that client's calls (the lifecycle Claude's connector expects).
 *
 * Endpoints:
 *   POST   /mcp      MCP Streamable HTTP — initialize + JSON-RPC calls
 *   GET    /mcp      server -> client SSE stream (requires mcp-session-id)
 *   DELETE /mcp      end a session (requires mcp-session-id)
 *   GET    /healthz  liveness probe
 *   GET    /privacy  public privacy policy (required by the Connectors Directory)
 *   GET    /         human-readable info
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, AINA_INFO } from "./index.js";

const PORT = Number(process.env.PORT || 8090);
const HERE = dirname(fileURLToPath(import.meta.url));

// Active sessions keyed by mcp-session-id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version", "authorization", "last-event-id"],
  })
);

// --- MCP endpoint ---
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = createServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session id (send an initialize request first)." },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP request error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// GET = server->client SSE stream; DELETE = end session. Both need a session id.
async function handleSessionRequest(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// --- Health ---
app.get("/healthz", (_req: Request, res: Response) =>
  res.json({ status: "ok", sessions: Object.keys(transports).length, ...AINA_INFO })
);

// --- Privacy policy (Connectors Directory requires a public one) ---
app.get("/privacy", (_req: Request, res: Response) => {
  try {
    const md = readFileSync(join(HERE, "..", "PRIVACY.md"), "utf8");
    res.type("text/markdown").send(md);
  } catch {
    res.status(404).type("text/plain").send("Privacy policy not found.");
  }
});

// --- Info ---
app.get("/", (_req: Request, res: Response) => {
  res
    .type("text/plain")
    .send(
      `${AINA_INFO.name} v${AINA_INFO.version} — remote MCP server (Streamable HTTP).\n` +
        `MCP endpoint: POST /mcp\nHealth: GET /healthz\nPrivacy: GET /privacy\n` +
        `Hawaii parcel lookup over ${AINA_INFO.dataBase}. Read-only.\n`
    );
});

app.listen(PORT, () => {
  console.log(`aina-atlas-mcp (remote) listening on :${PORT} — POST /mcp`);
});
