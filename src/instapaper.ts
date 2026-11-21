/**
 * Minimal client for the Instapaper Simple API.
 * https://www.instapaper.com/api/simple
 */

export const INSTAPAPER_ADD_URL = "https://www.instapaper.com/api/add";

export interface InstapaperCredentials {
  username: string;
  /** Instapaper accounts may have no password; send an empty string in that case. */
  password: string;
}

export interface SaveRequest {
  url: string;
  title?: string;
  /** Sent as Instapaper's `selection` field (shown as the bookmark's description). */
  note?: string;
}

export type SaveResult =
  | {
      ok: true;
      url: string;
      /** Final URL Instapaper saved (Content-Location header), if returned. */
      savedUrl?: string;
      /** Title Instapaper resolved (X-Instapaper-Title header), if returned. */
      savedTitle?: string;
    }
  | {
      ok: false;
      url: string;
      status: number;
      kind: "bad_request" | "bad_credentials" | "server_error" | "network_error" | "unexpected";
      message: string;
    };

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): InstapaperCredentials {
  const username = env.INSTAPAPER_USERNAME?.trim();
  if (!username) {
    throw new Error("INSTAPAPER_USERNAME is not set. Set it (and INSTAPAPER_PASSWORD) in the server's environment.");
  }
  return { username, password: env.INSTAPAPER_PASSWORD ?? "" };
}

export interface InstapaperClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export class InstapaperClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(creds: InstapaperCredentials, opts: InstapaperClientOptions = {}) {
    this.authHeader =
      "Basic " + Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? INSTAPAPER_ADD_URL;
  }

  async save(req: SaveRequest): Promise<SaveResult> {
    const body = new URLSearchParams({ url: req.url });
    if (req.title) body.set("title", req.title);
    if (req.note) body.set("selection", req.note);

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "instapaper-mcp/1.0",
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        ok: false,
        url: req.url,
        status: 0,
        kind: "network_error",
        message: `Could not reach Instapaper: ${(err as Error).message}`,
      };
    }

    // Drain the body so the connection can be reused.
    await res.text().catch(() => "");

    switch (res.status) {
      case 201:
        return {
          ok: true,
          url: req.url,
          savedUrl: res.headers.get("content-location") ?? undefined,
          savedTitle: res.headers.get("x-instapaper-title") ?? undefined,
        };
      case 400:
        return {
          ok: false,
          url: req.url,
          status: 400,
          kind: "bad_request",
          message: "Instapaper rejected the request (400). The URL is probably missing or invalid.",
        };
      case 403:
        return {
          ok: false,
          url: req.url,
          status: 403,
          kind: "bad_credentials",
          message: "Invalid Instapaper username or password (403). Check INSTAPAPER_USERNAME / INSTAPAPER_PASSWORD.",
        };
      case 500:
        return {
          ok: false,
          url: req.url,
          status: 500,
          kind: "server_error",
          message: "Instapaper had a server error (500). Try again later.",
        };
      default:
        return {
          ok: false,
          url: req.url,
          status: res.status,
          kind: "unexpected",
          message: `Unexpected response from Instapaper: HTTP ${res.status}.`,
        };
    }
  }
}
