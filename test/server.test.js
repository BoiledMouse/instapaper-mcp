import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InstapaperClient, credentialsFromEnv } from "../dist/instapaper.js";
import { createServer } from "../dist/server.js";

/** Fake fetch that records calls and answers with a status chosen per URL. */
function fakeFetch(statusFor = () => 201) {
  const calls = [];
  const impl = async (endpoint, init) => {
    const params = new URLSearchParams(init.body.toString());
    calls.push({ endpoint, at: Date.now(), auth: init.headers.Authorization, params: Object.fromEntries(params) });
    const status = statusFor(params.get("url"));
    const headers = status === 201 ? { "Content-Location": params.get("url"), "X-Instapaper-Title": "A Title" } : {};
    return new Response(status === 201 ? "201" : String(status), { status, headers });
  };
  return { calls, impl };
}

async function connect(fetchImpl, batchDelayMs = 0) {
  const client = new InstapaperClient({ username: "me@example.com", password: "pw" }, { fetchImpl });
  const server = createServer({ client, batchDelayMs });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

test("lists both tools", async () => {
  const mcp = await connect(fakeFetch().impl);
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["save_article", "save_articles"]);
});

test("save_article sends basic auth, url, title and note as selection", async () => {
  const f = fakeFetch();
  const mcp = await connect(f.impl);
  const res = await mcp.callTool({
    name: "save_article",
    arguments: { url: "https://example.com/a", title: "T", note: "N" },
  });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /Saved to Instapaper/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].endpoint, "https://www.instapaper.com/api/add");
  assert.equal(f.calls[0].auth, "Basic " + Buffer.from("me@example.com:pw").toString("base64"));
  assert.deepEqual(f.calls[0].params, { url: "https://example.com/a", title: "T", selection: "N" });
});

test("save_article maps 403 and 400 to tool errors", async () => {
  const mcp403 = await connect(fakeFetch(() => 403).impl);
  const r1 = await mcp403.callTool({ name: "save_article", arguments: { url: "https://example.com" } });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /username or password/);

  const mcp400 = await connect(fakeFetch(() => 400).impl);
  const r2 = await mcp400.callTool({ name: "save_article", arguments: { url: "https://example.com" } });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /400/);
});

test("save_article rejects non-http URLs before calling Instapaper", async () => {
  const f = fakeFetch();
  const mcp = await connect(f.impl);
  const res = await mcp.callTool({ name: "save_article", arguments: { url: "javascript:alert(1)" } });
  assert.equal(res.isError, true);
  assert.equal(f.calls.length, 0);
});

const articles = (...urls) => urls.map((url) => ({ url }));

test("save_articles saves sequentially with a delay and reports per-URL results", async () => {
  const f = fakeFetch((u) => (u.endsWith("/bad") ? 400 : 201));
  const mcp = await connect(f.impl, 50);
  const res = await mcp.callTool({
    name: "save_articles",
    arguments: { articles: articles("https://a.com/1", "https://a.com/bad", "https://a.com/3", "https://a.com/1") },
  });
  const text = res.content[0].text;
  assert.equal(res.isError, false);
  assert.match(text, /Saved 2 of 3 URL\(s\), 1 failed \(1 duplicate\(s\) ignored\)/);
  assert.deepEqual(f.calls.map((c) => c.params.url), ["https://a.com/1", "https://a.com/bad", "https://a.com/3"]);
  for (let i = 1; i < f.calls.length; i++) {
    assert.ok(f.calls[i].at - f.calls[i - 1].at >= 45, "expected a pause between saves");
  }
});

test("save_articles stops on bad credentials", async () => {
  const f = fakeFetch(() => 403);
  const mcp = await connect(f.impl);
  const res = await mcp.callTool({
    name: "save_articles",
    arguments: { articles: articles("https://a.com/1", "https://a.com/2", "https://a.com/3") },
  });
  assert.equal(res.isError, true);
  assert.equal(f.calls.length, 1);
  assert.match(res.content[0].text, /2 skipped/);
  assert.match(res.content[0].text, /Stopped early/);
});

test("save_articles sends each article's own title and note, first duplicate wins", async () => {
  const f = fakeFetch();
  const mcp = await connect(f.impl);
  const res = await mcp.callTool({
    name: "save_articles",
    arguments: {
      articles: [
        { url: "https://a.com/1", title: "One", note: "First note" },
        { url: "https://a.com/2" },
        { url: "https://a.com/3", note: "Only a note" },
        { url: "https://a.com/1", title: "Ignored duplicate" },
      ],
    },
  });
  assert.equal(res.isError, false);
  assert.deepEqual(
    f.calls.map((c) => c.params),
    [
      { url: "https://a.com/1", title: "One", selection: "First note" },
      { url: "https://a.com/2" },
      { url: "https://a.com/3", selection: "Only a note" },
    ],
  );
});

test("save_articles rejects a non-http URL anywhere in the batch before saving anything", async () => {
  const f = fakeFetch();
  const mcp = await connect(f.impl);
  const res = await mcp.callTool({
    name: "save_articles",
    arguments: { articles: [{ url: "https://a.com/1" }, { url: "ftp://a.com/2" }] },
  });
  assert.equal(res.isError, true);
  assert.equal(f.calls.length, 0);
});

test("network failures are reported, not thrown", async () => {
  const mcp = await connect(async () => {
    throw new Error("ECONNREFUSED");
  });
  const res = await mcp.callTool({ name: "save_article", arguments: { url: "https://a.com" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not reach Instapaper: ECONNREFUSED/);
});

test("credentialsFromEnv requires a username, allows an empty password", () => {
  assert.throws(() => credentialsFromEnv({}), /INSTAPAPER_USERNAME/);
  assert.deepEqual(credentialsFromEnv({ INSTAPAPER_USERNAME: "u" }), { username: "u", password: "" });
});
