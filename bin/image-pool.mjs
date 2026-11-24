#!/usr/bin/env node
/**
 * 若道生图号池（原生引擎：gpt-image-2.6 / flare / sunburst + 原生 GIF）
 *
 * 引擎来自固定版本 chatgpt2api（v1.8.0，commit 92dd80e91543157d36a4ddad60e765c5293760e9），
 * 插件负责：安装固定源码与 2.6/GIF 补丁 → 创建 Python 隔离环境 → 启动后端 →
 * 导入账号并完成 OAuth / 密码 / 2FA 登录 → 生图与 GIF → 本地图片库 / 台账 →
 * 对 Agent 暴露 OpenAI 兼容的本地生图 API。
 *
 * 命令模式（process.argv[2]）：
 *   doctor              自检：引擎安装/补丁/服务/账号/本地 API
 *   models              模型目录（2.6 / 2 + 账号动态模型 + GIF 能力）
 *   preferences         默认模型与分辨率档位：stdin { action?: "get"|"set", defaultModel?, defaultImageTier? }
 *   generate            生图：stdin { prompt, model?, resolution?, aspect_ratio?, output_format?, frame_count?, frame_duration_ms?, images?, size?, n? }
 *   agent-access        启动本地 OpenAI 兼容生图 API，返回 base URL / Key / 模型
 *   usage               消耗统计：stdin { days? }
 *   logs                调用日志：stdin { days?, limit?, offset?, kind?, state?, q? }
 *   images              图片库：stdin { action: "list"|"delete"|"reveal", file? }
 *   native-setup        后台安装原生引擎（固定源码 → 补丁 → 依赖 → 启动）
 *   native-setup-run    安装子进程入口（由 native-setup 拉起）
 *   native-setup-status 安装进度（步骤 / 日志 / 服务状态）
 *   native-service      服务维护：stdin { action: "start"|"stop"|"restart"|"status" }
 *   native-accounts     号池账号：stdin { action: "import"|"login"|"check"|"list"|"refresh"|"delete", text?, emails?, proxy?, force?, concurrency? }
 *                       check 批量检测：刷新 token 并对失效账号强制密码 + 2FA 重登，返回 available/limited/retryable/dead 分类
 *   native-proxy        全局代理：stdin { action: "get"|"set"|"test"|"discover"|"auto", url?, clientId?, waitMs? }
 *   native-status       引擎状态 + 安装进度 + 本地 API 状态
 *
 * 输出（stdout JSON）：Host 记入 pluginExecutionResults。
 *   { "state": "succeeded", ... } 或 { "state": "failed", "error": "..." }
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as ledger from "./ledger.mjs";
import * as native from "./native/index.mjs";

const env = (k, d = "") => (process.env[k] ?? d).trim();

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 运行时数据目录（必须在插件目录之外）：插件更新/卸载会 rmdir 插件目录，
 * 而 venv、源码、图片与台账不能跟着丢。
 */
function resolveDataDir() {
  const custom = env("RUODAO_IMAGE_POOL_DATA_DIR", "");
  if (custom) return custom;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"), "RuodaoImagePool");
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || ".", "Library", "Application Support", "RuodaoImagePool");
  }
  return path.join(process.env.HOME || ".", ".local", "share", "ruodao-image-pool");
}
const DATA_DIR = resolveDataDir();

/**
 * 立即切换工作目录：宿主以插件目录为 cwd 启动命令，
 * 子进程（python / 安装进程）若继承插件目录会锁住目录导致更新时 EBUSY。
 */
try {
  mkdirSync(DATA_DIR, { recursive: true });
  process.chdir(DATA_DIR);
} catch { /* 目录不可写时保持原 cwd，后续步骤会报明确错误 */ }

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyData();
}

// 旧版本把运行数据放在插件目录 data/ 下：首次运行把小型状态文件迁到应用数据目录
let legacyMigrated = false;
function migrateLegacyData() {
  if (legacyMigrated) return;
  legacyMigrated = true;
  const legacy = path.join(PLUGIN_DIR, "data");
  if (path.resolve(legacy) === path.resolve(DATA_DIR) || !existsSync(legacy)) return;
  try {
    if (existsSync(DATA_DIR) && readdirSync(DATA_DIR).some((f) => !["downloads", "native"].includes(f))) return;
    cpSync(legacy, DATA_DIR, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (["downloads", "images", "node_modules", "native", "fpbrowser2api"].includes(base)) return false;
        try { return statSync(src).size < 20 * 1024 * 1024; } catch { return true; }
      },
    });
  } catch { /* 被占用/权限不足时忽略：账号可重新导入 */ }
}

/* ---------------- 本地 OpenAI 兼容 API ---------------- */

const IMAGE_API_PORT = () => Number(env("RUODAO_IMAGE_API_PORT", "8100")) || 8100;
const IMAGE_API_TOKEN_FILE = () => path.join(DATA_DIR, "api-token.txt");

function imageApiToken() {
  try {
    const saved = readFileSync(IMAGE_API_TOKEN_FILE(), "utf8").trim();
    if (saved) return saved;
  } catch { /* 首次启动 */ }
  ensureDataDir();
  const fresh = randomBytes(24).toString("hex");
  writeFileSync(IMAGE_API_TOKEN_FILE(), fresh, "utf8");
  return fresh;
}

async function imageApiHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${IMAGE_API_PORT()}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** 本地生图 API 是 Agent/工作台实际调用的端点，状态里必须单列出来。 */
async function imageApiStatus() {
  const health = await imageApiHealth();
  const base = `http://127.0.0.1:${IMAGE_API_PORT()}/v1`;
  return {
    id: "api",
    label: "本地生图 API",
    up: Boolean(health?.ok),
    base,
    port: IMAGE_API_PORT(),
    hint: health
      ? `已启动 · Agent 通过 ${base} 调用原生号池`
      : `未启动：Agent 生图会报 ERR_CONNECTION_REFUSED；点「启动服务」拉起 127.0.0.1:${IMAGE_API_PORT()}`,
  };
}

async function apiRequest(pathname, { method = "GET", body, timeoutMs = 30000, token } = {}) {
  const base = `http://127.0.0.1:${IMAGE_API_PORT()}`;
  let res;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token || imageApiToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`无法连接本地生图 API（${base}）：${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}：${text.slice(0, 200)}`);
  return data;
}

/** 本地 API 构建指纹：插件更新后自动重启，避免跑旧代码。 */
function imageApiBuild() {
  const files = [
    "image-api.mjs", "ledger.mjs",
    "native/config.mjs", "native/backend.mjs", "native/accounts.mjs", "native/images.mjs", "native/index.mjs",
  ];
  // 图片目录变化也要重启本地 API：预览路由在启动时缓存了 IMAGES_DIR。
  return [ledger.imagesDir(), ...files.map((rel) => {
    try { return String(Math.round(statSync(path.join(PLUGIN_DIR, "bin", rel)).mtimeMs)); } catch { return "0"; }
  })].join(".");
}

async function ensureImageApi({ restartOnStale = true } = {}) {
  const port = IMAGE_API_PORT();
  const build = imageApiBuild();
  let health = await imageApiHealth();
  if (health && restartOnStale && health.build !== build) {
    await stopImageApi();
    health = null;
  }
  if (!health) {
    const script = path.join(PLUGIN_DIR, "bin", "image-api.mjs");
    if (!existsSync(script)) throw new Error(`缺少本地 API 脚本：${script}`);
    try {
      const child = spawn(process.execPath, [script], {
        cwd: DATA_DIR,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          RUODAO_IMAGE_API_PORT: String(port),
          RUODAO_IMAGE_API_BUILD: build,
          RUODAO_IMAGE_POOL_DATA_DIR: DATA_DIR,
        },
      });
      child.on("error", () => {});
      child.unref();
    } catch (e) {
      throw new Error(`本地生图 API 启动失败：${e.message}`);
    }
    for (let i = 0; i < 30 && !health; i++) {
      await new Promise((r) => setTimeout(r, 500));
      health = await imageApiHealth();
    }
  }
  if (!health) throw new Error(`本地生图 API 未就绪（端口 ${port}）：请查看 ${path.join(DATA_DIR, "api.log")}`);
  return health;
}

async function stopImageApi() {
  try {
    await apiRequest("/v1/shutdown", { method: "POST", timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 600));
  } catch { /* 进程可能已退出 */ }
  try {
    const pid = Number(readFileSync(path.join(DATA_DIR, "api.pid"), "utf8").trim());
    if (pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      else process.kill(pid, "SIGTERM");
    }
  } catch { /* 已退出 */ }
  try { writeFileSync(path.join(DATA_DIR, "api.pid"), "", "utf8"); } catch { /* 忽略 */ }
}

/* ---------------- 命令实现 ---------------- */

async function doctor() {
  const api = await imageApiStatus();
  const setup = native.setupStatus(DATA_DIR);
  let status;
  try {
    status = await native.nativeStatus(DATA_DIR);
  } catch (e) {
    status = { running: false, ours: false, source: { ready: false, patched: false }, python: { ready: false }, accounts: null, error: e.message };
  }
  const accounts = status.accounts || { total: 0, active: 0 };
  const engineReady = Boolean(status.source?.ready && status.python?.ready);
  const checks = {
    engine: {
      ok: engineReady,
      hint: engineReady
        ? `原生引擎已安装（源码 v${status.source?.version || native.SOURCE_VERSION}）`
        : setup.status === "running" ? "安装进行中（后台执行，可继续等待）" : "原生引擎未安装：到「服务状态」点「安装原生号池」",
    },
    patch: {
      ok: Boolean(status.source?.patched),
      hint: status.source?.patched ? `gpt-image-2.6 / GIF 补丁已应用（${native.PATCH_VERSION}）` : "补丁缺失：重新执行原生号池安装",
    },
    service: {
      ok: Boolean(status.running && status.ours),
      base: status.baseUrl,
      hint: status.running && status.ours
        ? `原生号池在线：${status.baseUrl}`
        : engineReady ? "服务未运行：点「启动服务」或直接生图（会自动拉起）" : "服务未安装",
    },
    accounts: {
      ok: Number(accounts.active || 0) > 0,
      total: Number(accounts.total || 0),
      active: Number(accounts.active || 0),
      hint: Number(accounts.active || 0) > 0
        ? `可用账号 ${accounts.active} / ${accounts.total} 个`
        : Number(accounts.total || 0) > 0 ? "账号尚未登录：到「号池账号」点「登录号池账号」" : "尚未导入账号：到「号池账号」粘贴发货文本",
    },
    localApi: {
      ok: api.up,
      base: api.base,
      hint: api.hint,
    },
  };
  const ok = checks.engine.ok && checks.patch.ok && checks.service.ok && checks.accounts.ok;
  emit({
    state: "succeeded",
    ok,
    mode: ok ? "原生号池（gpt-image-2.6 + GIF，已就绪）" : "未就绪",
    dataDir: DATA_DIR,
    checks,
    native: status,
    setup,
    api,
    models: native.IMAGE_MODELS,
    gifLimits: native.GIF_LIMITS,
    hint: ok
      ? "原生号池已就绪：可直接生图或接 Agent"
      : "按顺序完成：安装原生号池 → 导入并登录账号 → 启动服务 → 生图",
  });
}

async function models() {
  const status = await native.nativeStatus(DATA_DIR).catch(() => null);
  const live = await native.listBackendImageModels(DATA_DIR);
  const list = native.nativeModelEntries(live);
  const preferences = native.readPreferences(DATA_DIR);
  emit({
    state: "succeeded",
    installed: Boolean(status?.source?.ready && status?.python?.ready),
    patched: Boolean(status?.source?.patched),
    running: Boolean(status?.running && status?.ours),
    base: status?.baseUrl || native.nativeBaseUrl(),
    accounts: status?.accounts || null,
    total: list.length,
    models: list,
    imageModels: list.map((item) => item.id),
    nativeModels: native.NATIVE_MODELS,
    gifModels: native.NATIVE_MODELS,
    gifLimits: native.GIF_LIMITS,
    tiers: native.IMAGE_TIERS,
    preferences,
    defaultModel: preferences.defaultModel,
    defaultImageTier: preferences.defaultImageTier,
    native: {
      installed: Boolean(status?.source?.ready && status?.python?.ready),
      patched: Boolean(status?.source?.patched),
      running: Boolean(status?.running && status?.ours),
      base: status?.baseUrl || native.nativeBaseUrl(),
    },
    hint: status?.running && status?.ours
      ? `原生号池在线：${list.length} 个图像模型（GIF 仅 2.6 系列）`
      : "原生号池未运行：到「服务状态」安装或启动后即可生图",
  });
}

async function preferences(input = {}) {
  const action = String(input.action || "get").toLowerCase();
  if (action === "get") {
    emit({ state: "succeeded", action: "get", preferences: native.readPreferences(DATA_DIR), tiers: native.IMAGE_TIERS });
    return;
  }
  if (action !== "set") fail("preferences 只支持 get / set");
  const next = native.writePreferences(DATA_DIR, {
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
    ...(input.defaultImageTier !== undefined ? { defaultImageTier: input.defaultImageTier } : {}),
  });
  emit({
    state: "succeeded",
    action: "set",
    preferences: next,
    tiers: native.IMAGE_TIERS,
    hint: `已保存默认模型 ${next.defaultModel} · 档位 ${next.defaultImageTier}`,
  });
}

async function generate(input) {
  try {
    emit({ state: "progress", step: "原生号池：检查引擎与可用账号…" });
    const result = await native.nativeGenerate(DATA_DIR, input, {
      onProgress: (event) => emit({ state: "progress", step: event.message || event.phase || "原生号池处理中" }),
    });
    emit(result);
  } catch (e) {
    fail(e?.message || String(e), { mode: "native" });
  }
}

async function agentAccess() {
  const port = IMAGE_API_PORT();
  const apiKey = imageApiToken();
  const before = await imageApiHealth();
  let health;
  try { health = await ensureImageApi(); } catch (e) { fail(e.message); }
  const installed = native.nativeInstalled(DATA_DIR);
  let status = null;
  if (installed.source && installed.venv && installed.patched) {
    try { await native.startExistingBackend(DATA_DIR); } catch { /* 启动失败不阻塞本地 API，状态里会给原因 */ }
    status = await native.nativeStatus(DATA_DIR);
  }
  const live = await native.listBackendImageModels(DATA_DIR);
  const models = native.nativeModelEntries(live).map((item) => item.id);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const started = !before || before.build !== health.build;
  emit({
    state: "succeeded",
    started,
    port,
    baseUrl,
    apiKey,
    models,
    native: {
      installed: Boolean(status?.source?.ready && status?.python?.ready),
      running: Boolean(status?.running && status?.ours),
      base: status?.baseUrl || native.nativeBaseUrl(),
      accounts: status?.accounts || null,
      models: status?.models || native.NATIVE_MODELS,
      gif: status?.gif || null,
    },
    endpoints: {
      models: `${baseUrl}/models`,
      images: `${baseUrl}/images/generations`,
      edits: `${baseUrl}/images/edits`,
      usage: `${baseUrl}/usage?days=30`,
      logs: `${baseUrl}/logs?days=7&limit=100`,
      imageLibrary: `${baseUrl}/images`,
    },
    example: `curl ${baseUrl}/images/generations -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"prompt":"一只橘猫"}'`,
    exampleGif: `curl ${baseUrl}/images/generations -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"model":"gpt-image-2.6","prompt":"一颗跳动的心","output_format":"gif","frame_count":8,"frame_duration_ms":200}'`,
    note: "OpenAI 兼容生图接口：模型目录含 gpt-image-2.6 / 2 与 Codex 系列（GIF 仅 2.6），支持 /v1/images/generations、/v1/images/edits（参考图）、/v1/usage、/v1/logs、/v1/images。",
  });
}

async function usage(input) {
  const days = Number(input?.days) || 30;
  const report = ledger.aggregateUsage(ledger.readLedger(), { days });
  emit({
    state: "succeeded",
    ...report,
    hint: "统计来自本地台账 usage.jsonl（每次生图的模型、账号、耗时与错误）。",
  });
}

async function logs(input) {
  const result = ledger.queryLogs(ledger.readLedger(), {
    days: Number(input?.days) || 7,
    limit: Number(input?.limit) || 100,
    offset: Number(input?.offset) || 0,
    kind: input?.kind || "",
    state: input?.state || "",
    q: input?.q || input?.keyword || "",
  });
  emit({ state: "succeeded", ...result, ledgerFile: ledger.ledgerFile() });
}

async function images(input) {
  const action = input.action || input.subcommand || "list";
  if (action === "list") {
    const items = ledger.listImages({ limit: Number(input.limit) || 200 });
    const base = `http://127.0.0.1:${IMAGE_API_PORT()}`;
    emit({
      state: "succeeded",
      total: items.length,
      imagesDir: ledger.imagesDir(),
      apiBase: base,
      token: imageApiToken(),
      items: items.map((item) => ({ ...item, url: `${base}/images/${encodeURIComponent(item.file)}` })),
      hint: "图片库来自本地 images/ 目录，每条生图记录都带提示词与耗时；可直接用 url 预览",
    });
    return;
  }
  if (action === "delete") {
    try {
      const result = ledger.deleteImage(input.file);
      emit({ state: "succeeded", action, ...result });
    } catch (e) {
      fail(e.message);
    }
    return;
  }
  if (action === "reveal") {
    const name = path.basename(String(input.file || ""));
    if (!name) fail("缺少 file");
    const full = path.join(ledger.imagesDir(), name);
    if (!existsSync(full)) fail("图片不存在");
    try {
      if (process.platform === "win32") spawnSync("explorer.exe", [`/select,${full}`], { windowsHide: true });
      else if (process.platform === "darwin") spawnSync("open", ["-R", full]);
      else spawnSync("xdg-open", [path.dirname(full)]);
      emit({ state: "succeeded", action, path: full });
    } catch (e) {
      fail(`打开文件夹失败：${e.message}`);
    }
    return;
  }
  fail(`不支持的 images 操作：${action}（支持 list / delete / reveal）`);
}

/* ---------------- 原生号池 ---------------- */

function nativeProgress(event) {
  emit({ state: "progress", step: event?.message || event?.phase || "原生号池处理中", native: true });
}

async function nativeSetup(input) {
  const launched = native.launchSetup(DATA_DIR, input);
  emit({
    state: "succeeded",
    action: "setup",
    ...launched,
    hint: launched.alreadyRunning
      ? "原生号池安装已在后台运行，可在服务状态查看进度"
      : "原生号池安装已在后台启动（固定源码 → 2.6/GIF 补丁 → 装依赖 → 启动服务）",
  });
}

async function nativeSetupRun() {
  const request = native.readSetupRequest(DATA_DIR);
  try {
    const state = await native.runSetup(DATA_DIR, { sourceDir: request.sourceDir, sourceZip: request.sourceZip });
    emit({ state: "succeeded", action: "setup-run", status: state.status, durationMs: state.finishedAt - state.startedAt, steps: state.steps });
  } catch (e) {
    fail(e?.message || String(e), { action: "setup-run" });
  }
}

async function nativeSetupStatus() {
  const state = native.setupStatus(DATA_DIR);
  const status = await native.nativeStatus(DATA_DIR);
  emit({
    state: "succeeded",
    action: "setup-status",
    setup: state,
    native: {
      installed: status.source.ready && status.python.ready,
      running: status.running && status.ours,
      base: status.baseUrl,
      source: status.source,
      python: status.python,
      accounts: status.accounts,
      logFile: status.logFile,
    },
  });
}

async function nativeService(input) {
  const action = String(input?.action || "status").toLowerCase();
  if (!["start", "stop", "restart", "status"].includes(action)) fail(`不支持的操作：${action}（支持 start / stop / restart / status）`);
  if (action === "status") {
    emit({ state: "succeeded", action, ...(await native.nativeStatus(DATA_DIR)), api: await imageApiStatus() });
    return;
  }
  if (action === "stop") {
    const stopped = await native.stopBackend(DATA_DIR);
    await stopImageApi();
    emit({ state: "succeeded", action, ...stopped, ...(await native.nativeStatus(DATA_DIR)), api: await imageApiStatus() });
    return;
  }
  if (action === "restart") {
    try { await native.stopBackend(DATA_DIR); } catch { /* 未运行或非本插件进程，继续启动会给出明确提示 */ }
  }
  try {
    await native.startExistingBackend(DATA_DIR);
    const status = await native.nativeStatus(DATA_DIR);
    let api = await imageApiStatus();
    if (!api.up) {
      try { await ensureImageApi(); api = await imageApiStatus(); } catch { /* 服务状态里会提示 */ }
    }
    emit({ state: "succeeded", action, ...status, api, hint: `原生号池服务已就绪：${status.baseUrl}（gpt-image-2.6 × 3 + 原生 GIF）` });
  } catch (e) {
    fail(e?.message || String(e), { action });
  }
}

async function nativeAccounts(input) {
  try {
    const result = await native.nativeAccountAction(DATA_DIR, input);
    emit({ state: "succeeded", ...result });
  } catch (e) {
    fail(e?.message || String(e), { action: input?.action || "list" });
  }
}

async function nativeProxy(input) {
  try {
    const result = await native.nativeProxyAction(DATA_DIR, input);
    emit({ state: "succeeded", ...result });
  } catch (e) {
    fail(e?.message || String(e), { action: input?.action || "get" });
  }
}

/* ---------------- main ---------------- */

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    // 终端直跑（无管道输入）时 stdin 不会关闭，2 秒无数据即按空输入处理；
    // 大参考图（多张 Base64）可能持续写入超过 2 秒，每来一块数据就续期。
    const timer = setTimeout(() => { process.stdin.destroy(); done(parseStdin(data)); }, 2000);
    if (process.stdin.isTTY) { clearTimeout(timer); return done({}); }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; timer.refresh(); });
    process.stdin.on("end", () => { clearTimeout(timer); done(parseStdin(data)); });
    process.stdin.on("error", () => { clearTimeout(timer); done({}); });
    process.stdin.on("close", () => { clearTimeout(timer); done(parseStdin(data)); });
  });
}

function parseStdin(data) {
  try { return data.trim() ? JSON.parse(data) : { text: data.trim() }; }
  catch { return { text: data.trim() }; }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

class FailSignal extends Error {
  constructor() {
    super("__image_pool_fail__");
    this.name = "FailSignal";
  }
}

function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  // 直接 process.exit 会在 fetch/undici 仍持有句柄时触发 Windows libuv 断言（0xC0000409），
  // 改为交给顶层 catch 收口；兜底定时器防止残留句柄把失败命令挂住。
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1500).unref();
  throw new FailSignal();
}

const stdin = await readStdin();
// 工作台 UI 会把用户保存的配置通过 stdin JSON 的 config 字段传进来，覆盖同名环境变量。
if (stdin.config && typeof stdin.config === "object") {
  for (const [key, value] of Object.entries(stdin.config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) process.env[key] = String(value).trim();
  }
}
const mode = process.argv[2] ?? "";
try {
  if (mode === "doctor") await doctor();
  else if (mode === "models") await models();
  else if (mode === "preferences") await preferences(stdin);
  else if (mode === "generate") await generate(stdin);
  else if (mode === "agent-access") await agentAccess();
  else if (mode === "usage") await usage(stdin);
  else if (mode === "logs") await logs(stdin);
  else if (mode === "images") await images(stdin);
  else if (mode === "native-setup") await nativeSetup(stdin);
  else if (mode === "native-setup-run") await nativeSetupRun();
  else if (mode === "native-setup-status") await nativeSetupStatus();
  else if (mode === "native-service") await nativeService(stdin);
  else if (mode === "native-accounts") await nativeAccounts(stdin);
  else if (mode === "native-proxy") await nativeProxy(stdin);
  else if (mode === "native-status") {
    emit({
      state: "succeeded",
      ...(await native.nativeStatus(DATA_DIR)),
      setup: native.setupStatus(DATA_DIR),
      api: await imageApiStatus(),
    });
  }
  else fail(`未知模式：${mode}（支持 doctor / models / preferences / generate / agent-access / usage / logs / images / native-setup / native-setup-status / native-service / native-accounts / native-proxy / native-status）`);
} catch (e) {
  if (!(e instanceof FailSignal)) fail(e?.message || String(e));
}
