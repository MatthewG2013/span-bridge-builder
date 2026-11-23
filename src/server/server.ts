import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JsonStore } from "./store.js";
import {
  ValidationError,
  listPublicLevels,
  validateDesign,
  validateLevelQuery,
  validateNickname,
  validateResult,
} from "./validation.js";

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  publicDir?: string;
  verbose?: boolean;
}

export interface BridgeServer {
  server: Server;
  store: JsonStore;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 512 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export async function createBridgeServer(options: BridgeServerOptions = {}): Promise<BridgeServer> {
  const port = options.port ?? Number(process.env.PORT ?? 4173);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const dataDir = options.dataDir ?? process.env.BRIDGE_DATA_DIR ?? resolve(process.cwd(), "data");
  const publicDir = resolve(options.publicDir ?? process.env.BRIDGE_PUBLIC_DIR ?? resolve(process.cwd(), "public"));
  const verbose = options.verbose ?? process.env.NODE_ENV !== "test";
  const store = await JsonStore.open(dataDir);

  const server = createServer((request, response) => {
    handleRequest(request, response, store, publicDir, verbose).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof ValidationError ? error.status : 500;
      const message =
        error instanceof ValidationError
          ? error.message
          : "服务器内部错误，请稍后再试。";
      if (verbose) {
        console.error(`[api] ${request.method} ${request.url} -> ${status}`, error);
      }
      sendJson(response, status, { error: message });
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const actualPort = (server.address() as { port: number }).port;
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${actualPort}`;

  return {
    server,
    store,
    port: actualPort,
    url,
    close: async () => {
      const closed = new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: JsonStore,
  publicDir: string,
  verbose: boolean,
): Promise<void> {
  setSecurityHeaders(response);
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    await handleApi(method, url, request, response, store);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  await serveStatic(url.pathname, response, publicDir, method === "HEAD", verbose);
}

async function handleApi(
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  store: JsonStore,
): Promise<void> {
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      name: "SPAN Bridge Lab",
      version: "0.2.0",
      time: new Date().toISOString(),
      storage: store.stats(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/levels") {
    sendJson(response, 200, { levels: listPublicLevels() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/leaderboard") {
    const levelId = validateLevelQuery(url.searchParams.get("levelId"));
    const nicknameParam = url.searchParams.get("nickname");
    const nickname = nicknameParam ? validateNickname(nicknameParam) : null;
    sendJson(response, 200, {
      levelId,
      entries: store.leaderboard(levelId, 10),
      personalBest: nickname ? store.personalBest(nickname, levelId) : null,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/designs") {
    const levelId = validateLevelQuery(url.searchParams.get("levelId"));
    const nickname = validateNickname(url.searchParams.get("nickname"));
    const design = store.findDesign(nickname, levelId);
    sendJson(response, 200, { design });
    return;
  }

  if (method === "POST" && url.pathname === "/api/designs") {
    const body = await readJsonBody(request);
    const input = validateDesign(body);
    const saved = await store.saveDesign(input);
    sendJson(response, saved.created ? 201 : 200, {
      ok: true,
      created: saved.created,
      design: saved.design,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/results") {
    const body = await readJsonBody(request);
    const input = validateResult(body);
    const submitted = await store.submitResult(input);
    sendJson(response, 200, {
      ok: true,
      improved: submitted.improved,
      result: submitted.result,
      leaderboard: store.leaderboard(input.levelId, 10),
    });
    return;
  }

  sendJson(response, 404, { error: "接口不存在" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("请求必须使用 application/json", 415);
  }

  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new ValidationError("请求体过大", 413);
    }
    chunks.push(buffer);
  }

  if (total === 0) throw new ValidationError("请求体不能为空");
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("JSON 格式错误");
  }
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
  publicDir: string,
  headOnly: boolean,
  verbose: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, "Bad Request");
    return;
  }

  if (decoded.includes("\0")) {
    sendText(response, 400, "Bad Request");
    return;
  }

  const relative = decoded === "/" ? "/index.html" : decoded;
  const filePath = resolve(publicDir, "." + relative);
  const allowedPrefix = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
  if (filePath !== publicDir && !filePath.startsWith(allowedPrefix)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendText(response, 404, "Not Found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("Content-Length", info.size);
    response.setHeader("Cache-Control", "no-cache");
    if (headOnly) {
      response.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      if (!response.headersSent) {
        sendText(response, 500, "Internal Server Error");
      } else {
        response.destroy();
      }
      if (verbose) console.error(`[static] ${pathname}`, error);
    });
    stream.pipe(response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sendText(response, 404, "Not Found");
      return;
    }
    if (verbose) console.error(`[static] ${pathname}`, error);
    sendText(response, 500, "Internal Server Error");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", payload.length);
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, message: string): void {
  const payload = Buffer.from(message, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", payload.length);
  response.end(payload);
}

async function main(): Promise<void> {
  const bridge = await createBridgeServer();
  console.log(`\n  SPAN Bridge Lab  ${bridge.url}`);
  console.log(`  data: ${bridge.store.filePath}\n`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[server] ${signal} received, shutting down...`);
    await bridge.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[server] failed to start", error);
    process.exit(1);
  });
}
