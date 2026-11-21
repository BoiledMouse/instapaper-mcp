# instapaper-mcp

A small [MCP](https://modelcontextprotocol.io) server that saves articles to Instapaper using the
[Simple API](https://www.instapaper.com/api/simple) (`POST https://www.instapaper.com/api/add` with HTTP Basic Auth).

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `save_article` | `url` (required), `title?`, `note?` | Saves one URL. `note` is sent as Instapaper's `selection` field, which shows up as the bookmark's description. |
| `save_articles` | `urls[]` (1–50) | Saves each URL in turn, pausing between requests (750 ms by default). Duplicates are dropped. Reports each URL's result, and stops early if Instapaper rejects the credentials. |

How Instapaper's responses are reported: `201` counts as saved. `400` (bad URL) and `403` (wrong username or password)
come back as tool errors with a plain-English message. `500` and network failures are reported the same way.

## Setup

Requires Node.js 18 or later.

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

### Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `INSTAPAPER_USERNAME` | yes | | Your Instapaper email or username |
| `INSTAPAPER_PASSWORD` | no | empty | Your Instapaper password (leave it unset if your account has none) |
| `INSTAPAPER_BATCH_DELAY_MS` | no | `750` | Pause between saves in `save_articles` |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http` (the `--stdio` / `--http` flags do the same) |
| `PORT` / `HOST` | no | `3000` / `127.0.0.1` | Where the HTTP server listens (or use `--port` / `--host`) |
| `MCP_AUTH_TOKEN` | for HTTP | | Bearer token clients must send. The HTTP server won't start without it. |
| `MCP_ALLOW_NO_AUTH` | no | | Set to `1` to run HTTP without a token, e.g. behind your own authenticating proxy |

## Claude Desktop (stdio)

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "instapaper": {
      "command": "node",
      "args": ["/absolute/path/to/instapaper-mcp/dist/index.js"],
      "env": {
        "INSTAPAPER_USERNAME": "you@example.com",
        "INSTAPAPER_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. On Windows, write the path with escaped backslashes (`C:\\Users\\...`) or forward slashes.

## Claude Code (stdio)

```bash
claude mcp add instapaper \
  -e INSTAPAPER_USERNAME=you@example.com \
  -e INSTAPAPER_PASSWORD=your-password \
  -- node /absolute/path/to/instapaper-mcp/dist/index.js
```

Add `--scope user` to make it available in every project. Run `claude mcp list` to check that it connected.

## Streamable HTTP (remote hosting)

The HTTP mode runs **stateless**: every `POST /mcp` gets a fresh server and returns a JSON response, so the server
can run behind a load balancer or on a platform that scales to zero. `GET /health` returns `ok`, for health checks.

```bash
export INSTAPAPER_USERNAME=you@example.com
export INSTAPAPER_PASSWORD=your-password
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
node dist/index.js --http --host 0.0.0.0 --port 3000
```

The server speaks plain HTTP. When you host it publicly, put it behind HTTPS (a reverse proxy, or your platform's
TLS), because the bearer token travels in every request. Anyone who has the token can save to your Instapaper account.

### Connecting Claude Code to it

```bash
claude mcp add --transport http instapaper https://your-host.example.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

### Connecting Claude Desktop to it

Claude Desktop's `mcpServers` config launches local commands. To reach a remote server that uses a static bearer
token, bridge to it with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "instapaper": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-host.example.com/mcp",
        "--header", "Authorization: Bearer ${INSTAPAPER_MCP_TOKEN}"
      ],
      "env": { "INSTAPAPER_MCP_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

The "custom connector" option under Settings → Connectors expects servers that use OAuth (or no auth), so it won't
send this server's bearer token.

## Project layout

```
src/instapaper.ts   Simple API client (Basic Auth, maps response codes to results)
src/server.ts       MCP tool definitions
src/index.ts        Entry point: stdio or streamable HTTP
test/               Tests that run against a fake Instapaper endpoint (no network)
```
