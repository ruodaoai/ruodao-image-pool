#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容生图 API（原生号池）
 *
 * Agent / 脚本用 Base URL + Bearer Key 调用本服务，本服务把请求转给插件内置的
 * chatgpt2api 原生引擎（gpt-image-2.6 / flare / sunburst + 原生 GIF）。
 *
 *   GET  /health                         健康检查（无需鉴权）
 *   GET  /v1/models                      原生模型列表
 *   POST /v1/images/generations          生图 / GIF
 *   POST /v1/images/edits                参考图生图（JSON images: base64 / data URL / http 链接，或 OpenAI multipart/form-data）
 *   GET  /v1/usage?days=30               消耗统计
 *   GET  /v1/logs?days=7&limit=100       调用日志
 *   GET  /v1/images                      图片库
 *   DELETE /v1/images/<file>             删除图片
 *   GET  /images/<file>                  图片文件（本机直连，OpenAI 客户端取图用）
 *   POST /v1/shutdown                    关闭进程
 */

import http from "node:http";
import path from "node:path";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as native from "./native/index.mjs";
import {
  DATA_DIR, aggregateUsage, deleteImage, imagesDir, listImages,
  queryLogs, readLedger,
} from "./ledger.mjs";

const env = (k, d = "") => (process.env[k] ?? d).trim();

const IMAGES_DIR = imagesDir();
const TOKEN_FILE = path.join(DATA_DIR, "api-token.txt");
const LOG_FILE = path.join(DATA_DIR, "api.log");
const PORT = Number(env("RUODAO_IMAGE_API_PORT", "8100")) || 8100;
const BUILD = env("RUODAO_IMAGE_API_BUILD", "");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function log(line) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, "utf8"); } catch { /* 忽略 */ }
}
function token() {
  try {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch { /* 首次启动 */ }
  const fresh = randomBytes(24).toString("hex");
  try { writeFileSync(TOKEN_FILE, fresh, "utf8"); } catch { /* 读内存值 */ }
  return fresh;
}
const TOKEN = token();

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(text);
}
function authorized(req) {
  const raw = String(req.headers.authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && m[1].trim() === TOKEN);
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      // 参考图以 base64 内联，单张可达 20MB，留足四张的余量
      if (size > 96 * 1024 * 1024) { reject(new Error("请求体超过 96MB")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// OpenAI 标准 /images/edits 用 multipart/form-data 传参考图（桌面端与官方 SDK
// 都走这条），而内部原生引擎只认 JSON images，所以在这里统一归一化。
async function multipartBody(raw, contentType) {
  let form;
  try {
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new Error("请求体不是合法的 multipart/form-data");
  }
  const body = {};
  const images = [];
  for (const [rawKey, value] of form.entries()) {
    const key = rawKey.replace(/\[\]$/, "");
    if (typeof value === "string") {
      if (body[key] === undefined) body[key] = value;
      else if (Array.isArray(body[key])) body[key].push(value);
      else body[key] = [body[key], value];
      continue;
    }
    if (key !== "image" && key !== "images") continue;
    const bytes = Buffer.from(await value.arrayBuffer());
    if (!bytes.length) continue;
    images.push({
      b64_json: bytes.toString("base64"),
      mime_type: value.type || "",
      filename: value.name || `reference-${images.length + 1}`,
    });
  }
  if (images.length) body.images = images;
  return body;
}

async function readBody(req) {
  const raw = await readRawBody(req);
  const contentType = String(req.headers["content-type"] || "");
  if (/^multipart\/form-data/i.test(contentType)) return multipartBody(raw, contentType);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("请求体不是合法 JSON"); }
}

const CONTENT_POLICY_RE = /内容政策|防护限制|内容审核|content[_ -]?policy|moderation|safety (?:system|policy)|rejected as a result|violat\w*.{0,24}(?:polic|guideline)/i;
const POOL_UNAVAILABLE_RE = /未安装|未运行|未就绪|未登录|不是可用账号/;
const POOL_UPSTREAM_UNREACHABLE_RE = /image account upstream unreachable|upstream unreachable|无法连接 OpenAI/i;
const POOL_CAPACITY_RE = /no available image quota|没有可用生图额度|没有可用账号/i;
const QUOTA_RE = /额度|限额|quota|insufficient_quota|limit/i;
const BAD_REQUEST_RE = /缺少|必须是|不支持|超过|格式|帧数|时长|参考图|prompt/i;
const TRANSIENT_RE = /connection (?:closed|reset|aborted)|socket hang up|curl: \((?:18|28|52|55|56|92)\)|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|timeout|timed out|bad gateway|service unavailable|gateway timeout|upstream|连接超时|提前断开/i;

/** 上游拒绝对话与「号池自身故障」必须区分：内容审核被当成 5xx 时，
 *  客户端只会提示「通道暂时不可用」，用户会一直原样重试同一个违规提示词。 */
function errorMetaFor(message) {
  if (CONTENT_POLICY_RE.test(message)) return { status: 400, code: "content_policy", retryable: false };
  // 必须排在额度规则前：中文提示里带「额度」二字，但这是代理/网络故障，不是 429。
  if (POOL_UPSTREAM_UNREACHABLE_RE.test(message)) return { status: 502, code: "pool_upstream_unreachable", retryable: false };
  if (POOL_UNAVAILABLE_RE.test(message)) return { status: 503, code: "pool_unavailable", retryable: true };
  if (POOL_CAPACITY_RE.test(message)) return { status: 503, code: "pool_no_capacity", retryable: true };
  if (QUOTA_RE.test(message)) return { status: 429, code: "quota_exhausted", retryable: true };
  if (BAD_REQUEST_RE.test(message)) return { status: 400, code: "invalid_request", retryable: false };
  if (TRANSIENT_RE.test(message)) return { status: 502, code: "upstream_transient", retryable: true };
  return { status: 502, code: "upstream_error", retryable: false };
}

function errorTypeForStatus(status) {
  return status === 400 ? "invalid_request_error"
    : status === 429 ? "rate_limit_error"
      : status === 503 ? "service_unavailable" : "upstream_error";
}

async function generateImage(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    const error = new Error("缺少 prompt");
    error.status = 400;
    throw error;
  }
  const timeoutMs = Number(body.timeout_seconds) > 0 ? Number(body.timeout_seconds) * 1000 : 600000;
  return native.nativeGenerate(DATA_DIR, { ...body, timeoutMs }, {
    onProgress: (progress) => log(`native ${progress.phase || ""} ${progress.message || ""}`.trim()),
  });
}

function imageResponse(result, prompt, body) {
  const nativeInfo = { model: result.model, elapsedMs: result.elapsedMs, outputFormat: result.outputFormat, gif: result.gif || null };
  if (body.response_format === "b64_json") {
    const data = (result.images || []).map((item) => {
      const file = item.path || "";
      const b64 = file && existsSync(file) ? readFileSync(file).toString("base64") : "";
      return b64 ? { b64_json: b64, revised_prompt: prompt } : null;
    }).filter(Boolean);
    if (!data.length) {
      const error = new Error("生图完成但读取图片失败");
      error.status = 502;
      throw error;
    }
    return { created: Math.floor(Date.now() / 1000), data, native: nativeInfo };
  }
  const data = (result.images || []).map((item) => ({
    url: `http://127.0.0.1:${PORT}/images/${encodeURIComponent(path.basename(item.path))}`,
    revised_prompt: prompt,
  }));
  if (!data.length) {
    const error = new Error("生图完成但没有图片地址");
    error.status = 502;
    throw error;
  }
  return { created: Math.floor(Date.now() / 1000), data, native: nativeInfo };
}

/* ---------------- HTTP ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") return json(res, 204, {});

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "image-pool-api",
      port: PORT,
      build: BUILD,
      features: ["error-codes-v1", "pool-upstream-unreachable-v1"],
      nativeBase: native.nativeBaseUrl(),
      models: native.IMAGE_MODELS,
      tiers: native.IMAGE_TIERS,
      gif: native.GIF_LIMITS,
    });
  }

  // 图片文件走本机直连：OpenAI 客户端拿到 URL 后不会带 Bearer，要求鉴权会 401
  if (req.method === "GET" && url.pathname.startsWith("/images/")) {
    const name = path.basename(decodeURIComponent(url.pathname.slice("/images/".length)));
    const file = path.join(IMAGES_DIR, name);
    if (!/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp|gif)$/i.test(name) || !existsSync(file)) {
      return json(res, 404, { error: { message: "image not found" } });
    }
    const ext = path.extname(name).toLowerCase();
    const type = ext === ".gif" ? "image/gif"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".webp" ? "image/webp" : "image/png";
    res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
    return;
  }

  if (!authorized(req)) return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const live = await native.listBackendImageModels(DATA_DIR);
    return json(res, 200, { object: "list", data: native.nativeModelEntries(live) });
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    const days = Number(url.searchParams.get("days")) || 30;
    return json(res, 200, aggregateUsage(readLedger(), { days }));
  }

  if (req.method === "GET" && url.pathname === "/v1/logs") {
    const params = url.searchParams;
    return json(res, 200, queryLogs(readLedger(), {
      days: Number(params.get("days")) || 7,
      limit: Number(params.get("limit")) || 100,
      offset: Number(params.get("offset")) || 0,
      kind: params.get("kind") || "",
      state: params.get("state") || "",
      q: params.get("q") || "",
    }));
  }

  if (req.method === "GET" && url.pathname === "/v1/images") {
    const items = listImages({ limit: Number(url.searchParams.get("limit")) || 200 })
      .map((item) => ({ ...item, url: `http://127.0.0.1:${PORT}/images/${encodeURIComponent(item.file)}` }));
    return json(res, 200, { total: items.length, items });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/v1/images/")) {
    try {
      const file = decodeURIComponent(url.pathname.slice("/v1/images/".length));
      return json(res, 200, { state: "succeeded", ...deleteImage(file) });
    } catch (e) {
      return json(res, 400, { state: "failed", error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/shutdown") {
    json(res, 200, { state: "succeeded", message: "shutting down" });
    setTimeout(() => shutdown("api request"), 200);
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
    let body;
    try { body = await readBody(req); } catch (e) {
      return json(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
    }
    const prompt = String(body.prompt || "").trim();
    try {
      const result = await generateImage(body);
      log(`native image ok model=${result.model} elapsed=${result.elapsedMs}ms format=${result.outputFormat}`);
      return json(res, 200, imageResponse(result, prompt, body));
    } catch (e) {
      const message = String(e?.message || e);
      log(`native image failed: ${message.slice(0, 400)}`);
      const meta = errorMetaFor(message);
      const status = e?.status || meta.status;
      return json(res, status, {
        error: {
          message,
          type: errorTypeForStatus(status),
          code: meta.code,
          retryable: meta.retryable,
        },
      });
    }
  }

  json(res, 404, { error: { message: `unknown endpoint ${req.method} ${url.pathname}` } });
});

server.on("error", (e) => {
  log(`server error: ${e.message}`);
  process.exit(e.code === "EADDRINUSE" ? 0 : 1);
});
server.listen(PORT, "127.0.0.1", () => {
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), String(process.pid), "utf8"); } catch { /* 忽略 */ }
  log(`listening on http://127.0.0.1:${PORT}/v1 native=${native.nativeBaseUrl()}`);
});

let exiting = false;
function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  log(`shutdown: ${reason}`);
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), "", "utf8"); } catch { /* 忽略 */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig));

process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e?.message || e).slice(0, 300)}`));
process.on("uncaughtException", (e) => log(`uncaughtException: ${String(e?.message || e).slice(0, 300)}`));
