#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InstapaperClient, credentialsFromEnv } from "./instapaper.js";
import { createServer, type ServerOptions } from "./server.js";

// Logs go to stderr: on stdio, stdout is the MCP protocol channel.
const log = (...args: unknown[]) => console.error("[instapaper-mcp]", ...args);

function parseArgs(argv: string[]) {
  const out: { transport?: string; port?: string; host?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split("=", 2);
    const next = () => inline ?? argv[++i];
    if (flag === "--transport") out.transport = next();
    else if (flag === "--http") out.transport = "http";
    else if (flag === "--stdio") out.transport = "stdio";
    else if (flag === "--port") out.port = next();
    else if (flag === "--host") out.host = next();
    else if (flag === "--help" || flag === "-h") {
      console.error(
        "Usage: instapaper-mcp [--stdio | --http] [--port 3000] [--host 127.0.0.1]\n" +
          "Env: INSTAPAPER_USERNAME, INSTAPAPER_PASSWORD, MCP_TRANSPORT, PORT, HOST,\n" +
          "     MCP_AUTH_TOKEN (required for HTTP unless MCP_ALLOW_NO_AUTH=1), INSTAPAPER_BATCH_DELAY_MS",
      );
      process.exit(0);
    }
  }
  return out;
}

async function runStdio(opts: ServerOptions) {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
  log("running on stdio");
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function runHttp(opts: ServerOptions, host: string, port: number) {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  if (!token) {
    if (process.env.MCP_ALLOW_NO_AUTH !== "1") {
      log(
        "refusing to start HTTP transport without MCP_AUTH_TOKEN. Anyone who can reach the server could " +
          "save to your Instapaper account. Set MCP_AUTH_TOKEN, or MCP_ALLOW_NO_AUTH=1 if it sits behind " +
          "your own auth proxy.",
      );
      process.exit(1);
    }
    log("WARNING: HTTP transport running without authentication (MCP_ALLOW_NO_AUTH=1)");
  }

  const http = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (token && !tokenMatches(req.headers.authorization, token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="instapaper-mcp"');
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }
    // Stateless mode: no sessions, so there is nothing to stream on GET or delete on DELETE.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      jsonRpcError(res, 405, "Method not allowed");
      return;
    }

    try {
      const body = await readJson(req);
      // A fresh server + transport per request keeps stateless mode free of cross-request state.
      const server = createServer(opts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 500) log("request failed:", err);
      jsonRpcError(res, status, status === 500 ? "Internal server error" : (err as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  log(`streamable HTTP listening on http://${host}:${port}/mcp`);

  const shutdown = () => http.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transport = (args.transport ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  const delay = Number(process.env.INSTAPAPER_BATCH_DELAY_MS ?? 750);
  const opts: ServerOptions = {
    client: new InstapaperClient(credentialsFromEnv()),
    batchDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 750,
  };

  if (transport === "stdio") {
    await runStdio(opts);
  } else if (transport === "http" || transport === "streamable-http") {
    const port = Number(args.port ?? process.env.PORT ?? 3000);
    const host = args.host ?? process.env.HOST ?? "127.0.0.1";
    await runHttp(opts, host, port);
  } else {
    throw new Error(`Unknown transport "${transport}". Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  log((err as Error).message);
  process.exit(1);
});
