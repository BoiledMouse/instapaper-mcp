import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstapaperClient, type SaveResult } from "./instapaper.js";

export const MAX_BATCH = 50;

export interface ServerOptions {
  client: InstapaperClient;
  /** Pause between saves in save_articles, in milliseconds. */
  batchDelayMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "Must be an http(s) URL" });

const title = z.string().max(500).optional().describe("Optional title; Instapaper fetches one if omitted");
const note = z.string().max(2000).optional().describe("Optional note/description to attach to the bookmark");

const article = z.object({
  url: httpUrl.describe("The http(s) URL of the page to save"),
  title,
  note,
});

function describe(r: SaveResult): string {
  if (r.ok) {
    const title = r.savedTitle ? ` — "${r.savedTitle}"` : "";
    return `✓ ${r.savedUrl ?? r.url}${title}`;
  }
  return `✗ ${r.url}: ${r.message}`;
}

export function createServer({ client, batchDelayMs }: ServerOptions): McpServer {
  const server = new McpServer({ name: "instapaper", version: "1.0.0" });

  server.registerTool(
    "save_article",
    {
      title: "Save article to Instapaper",
      description:
        "Save a single URL to the user's Instapaper account. Optionally set a title and a note " +
        "(stored as the bookmark's description).",
      inputSchema: {
        url: httpUrl.describe("The http(s) URL of the page to save"),
        title,
        note,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, title, note }) => {
      const result = await client.save({ url, title, note });
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? `Saved to Instapaper: ${describe(result)}` : describe(result) }],
      };
    },
  );

  server.registerTool(
    "save_articles",
    {
      title: "Save several articles to Instapaper",
      description:
        `Save up to ${MAX_BATCH} articles to Instapaper, one at a time with a short pause between each. ` +
        "Each article has a URL and an optional title and note. Repeated URLs are saved once (the first " +
        "occurrence wins). Reports per-URL success or failure. Stops early if the credentials are rejected.",
      inputSchema: {
        articles: z.array(article).min(1).max(MAX_BATCH).describe("The articles to save"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ articles }) => {
      const seen = new Set<string>();
      const unique = articles.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));
      const results: SaveResult[] = [];
      let aborted = false;

      for (let i = 0; i < unique.length; i++) {
        if (i > 0 && batchDelayMs > 0) await sleep(batchDelayMs);
        const { url, title, note } = unique[i];
        const r = await client.save({ url, title, note });
        results.push(r);
        if (!r.ok && r.kind === "bad_credentials") {
          aborted = true;
          break;
        }
      }

      const saved = results.filter((r) => r.ok).length;
      const failed = results.length - saved;
      const skipped = unique.length - results.length;

      const lines = [
        `Saved ${saved} of ${unique.length} URL(s)` +
          (failed ? `, ${failed} failed` : "") +
          (skipped ? `, ${skipped} skipped` : "") +
          (articles.length !== unique.length ? ` (${articles.length - unique.length} duplicate(s) ignored)` : "") +
          ".",
        ...results.map(describe),
      ];
      if (aborted) lines.push("Stopped early: Instapaper rejected the credentials, so the remaining URLs were not attempted.");

      return {
        isError: saved === 0,
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  return server;
}
