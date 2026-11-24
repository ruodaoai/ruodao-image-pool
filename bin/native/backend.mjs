/**
 * 原生号池后端生命周期：源码 / 补丁 / Python 环境 / 进程 / 健康检查 / 安装状态机。
 *
 * 后端是固定提交的 chatgpt2api（Python + uvicorn），账号数据放在插件数据目录，
 * 因此升级源码不会丢账号。所有启动参数都从插件配置读取，不依赖外部脚本。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT, GIF_LIMITS, IMAGE_TIERS, NATIVE_MODELS, PATCH_VERSION, SOURCE_COMMIT, SOURCE_VERSION,
  ensureNativeDirs, isEngineImageModel, nativeBaseUrl, nativeKey, nativePaths, nativePort, normalizeImageTier,
  readJson, readSetupState, writeJson,
} from "./config.mjs";
import { ensureSource } from "./source.mjs";
import { ensureVenv, ensureDeps, runtimeSummary, venvPython } from "./python.mjs";
import { installSourcePatch, sourcePatchStatus } from "./gif-patch.mjs";
import { discoverLocalProxies, launchProxyClient, normalizePorts } from "./proxy.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.join(MODULE_DIR, "entrypoint.py");
const ENTRYPOINT_NAME = "ruodao_entrypoint.py";

export const SETUP_STEPS = Object.freeze([
  { id: "python", title: "Python 运行时" },
  { id: "source", title: "固定版本源码" },
  { id: "patch", title: "gpt-image-2.6 / GIF 补丁" },
  { id: "deps", title: "后端依赖" },
  { id: "start", title: "启动原生号池服务" },
  { id: "verify", title: "健康检查" },
]);

const STEP_LABEL = Object.fromEntries(SETUP_STEPS.map((step) => [step.id, step.title]));

function logTail(paths, lines = 60) {
  try {
    return fs.readFileSync(paths.logFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { ok: response.ok, status: response.status, data, text };
}

/** 代理地址脱敏：只保留协议、主机、端口，账号密码一律替换为 ***。 */
export function maskProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString().replace(/\/$/, "");
  } catch {
    return text.replace(/\/\/[^@/]*@/, "//***@");
  }
}

/** 接受 http(s) / socks5(h) 与 host:port[:user:pass]；空字符串表示清除代理。 */
export function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 500) throw new Error("代理地址过长（最多 500 字符）");
  const withScheme = /^(https?|socks5h?|socks):\/\/\S+$/i.test(text);
  const hostPort = /^[^\s:@/]+:\d{1,5}(?::[^:\s]+:[^:\s]+)?$/.test(text);
  if (!withScheme && !hostPort) throw new Error("代理地址格式无效：支持 http:// / https:// / socks5:// 或 host:port");
  return text;
}

async function engineSettings(backend) {
  const response = await fetchJson(`${backend.baseUrl}/api/settings`, {
    headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 15000,
  });
  if (!response.ok) throw new Error(`读取引擎设置失败（HTTP ${response.status}）`);
  return response.data?.config || {};
}

export async function readEngineProxy(backend) {
  const config = await engineSettings(backend);
  const proxy = String(config.proxy || "").trim();
  return { configured: Boolean(proxy), proxy, masked: maskProxyUrl(proxy) };
}

export async function saveEngineProxy(backend, url) {
  const proxy = normalizeProxyUrl(url);
  const response = await fetchJson(`${backend.baseUrl}/api/settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.key}` },
    body: { proxy },
    timeoutMs: 20000,
  });
  if (!response.ok) throw new Error(`保存代理失败（HTTP ${response.status}）`);
  const saved = String(response.data?.config?.proxy || "").trim();
  // 命令返回值只给脱敏地址，账号密码不出引擎进程。
  return { configured: Boolean(saved), proxy: maskProxyUrl(saved) };
}

export async function testEngineProxy(backend, url = "", { timeoutMs = 45000 } = {}) {
  const draft = String(url || "").trim();
  const response = await fetchJson(`${backend.baseUrl}/api/proxy/test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.key}` },
    body: draft ? { url: normalizeProxyUrl(draft) } : {},
    timeoutMs,
  });
  if (!response.ok) throw new Error(`代理测试失败（HTTP ${response.status}）`);
  const result = response.data?.result || {};
  const error = String(result.error || "");
  const ok = result.ok === true;
  const status = Number(result.status) || 0;
  // 引擎把"收到任意 HTTP 响应"算连通，但 403/429 说明出口 IP 被风控，登录仍会失败。
  const blocked = status === 403 || status === 429;
  const detail = error === "no active proxy configured" ? "尚未配置代理"
    : error === "invalid proxy url" ? "代理地址格式无效"
      : error;
  return {
    ok,
    status,
    latencyMs: Number(result.latency_ms) || 0,
    hasProxy: result.has_proxy === true,
    proxySource: String(result.proxy_source || ""),
    blocked,
    error: detail,
    hint: !ok ? (detail || "代理连接失败：请检查地址与端口")
      : blocked ? `代理能连通，但出口 IP 被 OpenAI 风控（HTTP ${status}），请更换节点后再登录`
        : status >= 200 && status < 400 ? "代理可用，可以重新登录账号"
          : `代理返回 HTTP ${status}：入口可达，但登录可能仍被拒绝`,
  };
}

export async function probeBackend(baseUrl, key, { timeoutMs = 2500 } = {}) {
  let health = null;
  try {
    const response = await fetchJson(`${baseUrl}/health?format=json`, { timeoutMs });
    if (response.ok && response.data && typeof response.data.status === "string") health = response.data;
  } catch { /* 未启动 */ }
  if (!health) return { up: false, ours: false, health: null, baseUrl };
  let ours = false;
  if (key) {
    try {
      const response = await fetchJson(`${baseUrl}/api/accounts`, {
        headers: { Authorization: `Bearer ${key}` }, timeoutMs: Math.max(1500, timeoutMs),
      });
      ours = response.ok;
    } catch { /* 鉴权失败 */ }
  }
  return { up: true, ours, health, baseUrl };
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processCommand(pid) {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], {
        encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      return String(result.stdout || "").trim();
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function ownedByPlugin(paths, pid) {
  if (!pidAlive(pid)) return { alive: false, owned: false, command: "" };
  const command = processCommand(pid);
  const owned = command.includes(ENTRYPOINT_NAME) || command.includes(paths.venv);
  return { alive: true, owned, command };
}

export function readRuntime(paths) {
  return readJson(paths.runtimeFile, null);
}

function writeRuntime(paths, value) {
  writeJson(paths.runtimeFile, value);
  fs.writeFileSync(paths.pidFile, String(value.pid || "") + "\n", { mode: 0o600 });
}

export function readBackendPid(paths) {
  const runtime = readRuntime(paths);
  if (Number.isInteger(runtime?.pid) && runtime.pid > 0) return runtime.pid;
  try {
    const pid = Number(fs.readFileSync(paths.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

async function waitForHealth(paths, key, { timeoutMs = 90000, child = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  const onExit = (code) => { exited = code; };
  child?.once("exit", onExit);
  try {
    while (Date.now() < deadline) {
      if (exited !== null) break;
      const probe = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 1800 });
      if (probe.up && probe.ours) return probe;
      if (!await portAvailable(nativePort()) && probe.up) return probe;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    child?.off("exit", onExit);
  }
  const tail = logTail(paths, 40);
  throw new Error(`原生号池后端启动失败${exited !== null ? `（退出码 ${exited}）` : "（等待健康检查超时）"}${tail ? `：\n${tail.slice(-1200)}` : ""}`);
}

function copyEntrypoint(paths) {
  const target = path.join(paths.source, ENTRYPOINT_NAME);
  const content = fs.readFileSync(ENTRYPOINT);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
    fs.writeFileSync(target, content, { mode: 0o600 });
  }
}

export async function prepareRuntime(dataDir, { sourceDir, sourceZip, onProgress, skipDeps = false } = {}) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const note = (step, message) => onProgress?.({ step, message });

  note("python", "检查 Python 3.10+ 运行时");
  const base = skipDeps ? runtimeSummary(paths) : null;
  if (base?.ready) {
    note("python", `复用已有虚拟环境：Python ${base.python}`);
  } else {
    const venv = ensureVenv(paths, { onProgress });
    note("python", `Python 虚拟环境就绪：${venv.version}`);
    if (skipDeps) throw new Error("已跳过依赖安装，但虚拟环境尚未创建");
  }

  await ensureSource(paths, { sourceDir, sourceZip, onProgress: (event) => note(event.step, event.message) });
  note("source", `固定版本源码就绪：${SOURCE_COMMIT.slice(0, 10)}（v${SOURCE_VERSION}）`);

  const patch = installSourcePatch(paths.source);
  note("patch", patch.skipped ? "补丁已是当前版本（gpt-image-2.6 × 3 + 原生 GIF）" : `补丁已应用：${patch.files} 个文件（gpt-image-2.6 × 3 + 原生 GIF）`);
  copyEntrypoint(paths);

  if (!skipDeps) await ensureDeps(paths, { onProgress });
  return paths;
}

function backendEnv(paths, key) {
  return {
    ...process.env,
    CHATGPT2API_AUTH_KEY: key,
    STORAGE_BACKEND: "json",
    RUODAO_NATIVE_DATA_DIR: paths.data,
    RUODAO_NATIVE_PREFERENCES_FILE: paths.preferences,
    RUODAO_NATIVE_SOURCE_DIR: paths.source,
    RUODAO_NATIVE_SOURCE_COMMIT: SOURCE_COMMIT,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

async function spawnBackend(paths, key) {
  const port = nativePort();
  if (!await portAvailable(port)) throw new Error(`端口 ${port} 已被占用：请关闭占用进程，或设置 RUODAO_NATIVE_PORT 使用其他端口`);
  const python = venvPython(paths);
  if (!fs.existsSync(python)) throw new Error("Python 虚拟环境不存在，请先执行原生号池安装");
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFd = fs.openSync(paths.logFile, "a", 0o600);
  fs.appendFileSync(paths.logFile, `\n===== ${new Date().toISOString()} start port ${port} =====\n`);
  let child;
  try {
    child = spawn(python, ["-m", "uvicorn", `${ENTRYPOINT_NAME.replace(/\.py$/, "")}:app`, "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
      cwd: paths.source,
      env: backendEnv(paths, key),
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  if (!Number.isInteger(child.pid)) throw new Error("无法获取原生号池后端进程号");
  writeRuntime(paths, {
    pid: child.pid, port, startedAt: Date.now(), sourceCommit: SOURCE_COMMIT,
    sourceVersion: SOURCE_VERSION, patchVersion: PATCH_VERSION, python,
  });
  await waitForHealth(paths, key, { timeoutMs: 90000, child });
  return { pid: child.pid, port };
}

/** 启动失败时清理本插件刚拉起的进程，避免留下占用端口的孤儿进程。 */
async function killPid(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 16000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* 忽略 */ } }
  }
}

export async function stopBackend(dataDir, { force = false } = {}) {
  const paths = nativePaths(dataDir);
  const pid = readBackendPid(paths);
  if (!pid) {
    const probe = await probeBackend(nativeBaseUrl(), nativeKey(paths), { timeoutMs: 1500 });
    if (probe.up) throw new Error("检测到原生号池后端在运行，但它不是由本插件启动（缺少进程记录），为避免误杀请手动停止该进程");
    return { stopped: false, already: true };
  }
  const state = ownedByPlugin(paths, pid);
  if (state.alive && !state.owned && !force) {
    throw new Error(`进程 ${pid} 不是原生号池后端（${state.command.slice(0, 120) || "无法读取命令行"}），已拒绝停止`);
  }
  if (state.alive) await killPid(pid);
  for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 200));
  try { fs.rmSync(paths.pidFile, { force: true }); } catch { /* 忽略 */ }
  writeJson(paths.runtimeFile, { ...(readRuntime(paths) || {}), pid: 0, stoppedAt: Date.now() });
  return { stopped: true, pid };
}

/** 确保后端可用：已运行则复用，否则按需准备运行环境并拉起。 */
export async function ensureBackend(dataDir, { autoPrepare = true, sourceDir, sourceZip, onProgress } = {}) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const key = nativeKey(paths);
  const baseUrl = nativeBaseUrl();
  const probe = await probeBackend(baseUrl, key, { timeoutMs: 1800 });
  if (probe.up && probe.ours) return { ...probe, paths, key, adopted: true };
  if (probe.up) throw new Error(`端口 ${nativePort()} 上有另一个 chatgpt2api 服务（鉴权不匹配）。请关闭它，或设置 RUODAO_NATIVE_PORT 使用其他端口`);
  if (!autoPrepare) throw new Error("原生号池后端未运行：请先执行「原生号池安装」");
  await prepareRuntime(dataDir, { sourceDir, sourceZip, onProgress });
  await spawnBackend(paths, key);
  const ready = await probeBackend(baseUrl, key, { timeoutMs: 4000 });
  if (!ready.up || !ready.ours) throw new Error("原生号池后端已启动但健康检查未通过，请查看日志");
  return { ...ready, paths, key, adopted: false };
}

/** 只启动已安装的运行时（不做源码/依赖准备），供服务面板快速启停。 */
export async function startExistingBackend(dataDir) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const key = nativeKey(paths);
  const probe = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 1800 });
  if (probe.up && probe.ours) return { ...probe, paths, key, adopted: true };
  if (probe.up) throw new Error(`端口 ${nativePort()} 被其他 chatgpt2api 服务占用`);
  if (!fs.existsSync(path.join(paths.source, "main.py")) || !fs.existsSync(venvPython(paths))) {
    throw new Error("原生号池尚未安装：请先执行 native-setup 一键安装");
  }
  try {
    installSourcePatch(paths.source);
    copyEntrypoint(paths);
  } catch (error) {
    throw new Error(`原生号池补丁升级失败：${String(error?.message || error).slice(0, 400)}；请重新执行 native-setup 一键安装`);
  }
  await spawnBackend(paths, key);
  const ready = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 4000 });
  if (!ready.up || !ready.ours) throw new Error("原生号池后端已启动但健康检查未通过，请查看日志");
  return { ...ready, paths, key, adopted: false };
}

/* ---------------- 安装状态机 ---------------- */

export function resetSetupState() {
  return {
    status: "idle", startedAt: 0, finishedAt: 0, error: "", step: "",
    steps: Object.fromEntries(SETUP_STEPS.map((step) => [step.id, { status: "pending", message: "" }])),
    log: [],
  };
}

function appendLog(state, line) {
  const text = String(line || "").trim();
  if (!text) return;
  const last = state.log[state.log.length - 1];
  if (last?.text === text) return;
  state.log.push({ ts: Date.now(), text: text.slice(0, 400) });
  if (state.log.length > 240) state.log = state.log.slice(-240);
}

function saveSetupState(paths, state) {
  state.updatedAt = Date.now();
  writeJson(paths.setupState, state);
}

function markStep(state, id, status, message = "") {
  if (!state.steps[id]) state.steps[id] = { status: "pending", message: "" };
  state.steps[id] = { ...state.steps[id], status, message, ...(status === "running" ? { startedAt: Date.now() } : {}), ...(["succeeded", "failed"].includes(status) ? { finishedAt: Date.now() } : {}) };
  state.step = id;
  if (message) appendLog(state, `${STEP_LABEL[id] || id}：${message}`);
}

export async function runSetup(dataDir, { sourceDir, sourceZip } = {}) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const state = resetSetupState();
  state.status = "running";
  state.startedAt = Date.now();
  state.pid = process.pid;
  saveSetupState(paths, state);
  const onProgress = ({ step, message }) => {
    if (!state.steps[step]) return;
    if (state.steps[step].status !== "running") markStep(state, step, "running");
    if (message) {
      state.steps[step].message = message;
      appendLog(state, message);
    }
    saveSetupState(paths, state);
  };
  try {
    markStep(state, "python", "running");
    onProgress({ step: "python", message: "检查 Python 3.10+ 运行时" });
    const venv = ensureVenv(paths, { onProgress });
    onProgress({ step: "python", message: `虚拟环境就绪：Python ${venv.version}` });
    markStep(state, "python", "succeeded", `Python ${venv.version}`);

    markStep(state, "source", "running");
    await ensureSource(paths, { sourceDir, sourceZip, onProgress });
    markStep(state, "source", "succeeded", `v${SOURCE_VERSION} · ${SOURCE_COMMIT.slice(0, 10)}`);

    markStep(state, "patch", "running");
    const patch = installSourcePatch(paths.source);
    copyEntrypoint(paths);
    markStep(state, "patch", "succeeded", patch.skipped ? "已是当前补丁版本" : `${patch.files} 个文件`);

    markStep(state, "deps", "running");
    await ensureDeps(paths, { onProgress });
    markStep(state, "deps", "succeeded", "依赖完整");

    markStep(state, "start", "running");
    const key = nativeKey(paths);
    const running = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 1500 });
    if (running.up && running.ours) {
      markStep(state, "start", "succeeded", "服务已在运行，直接复用");
    } else {
      if (running.up) throw new Error(`端口 ${nativePort()} 被其他服务占用`);
      await spawnBackend(paths, key);
      markStep(state, "start", "succeeded", `127.0.0.1:${nativePort()}`);
    }

    markStep(state, "verify", "running");
    const probe = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 5000 });
    if (!probe.up || !probe.ours) throw new Error("健康检查失败：后端未响应或鉴权不匹配");
    const accounts = probe.health?.accounts || {};
    markStep(state, "verify", "succeeded", `服务正常 · 账号 ${accounts.total ?? 0} 个（可用 ${accounts.active ?? 0} 个）`);
    state.status = "succeeded";
    state.finishedAt = Date.now();
    appendLog(state, "原生号池安装完成");
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1200);
    state.status = "failed";
    state.error = message;
    state.finishedAt = Date.now();
    if (state.step && state.steps[state.step]) state.steps[state.step] = { ...state.steps[state.step], status: "failed", message, finishedAt: Date.now() };
    appendLog(state, `安装失败：${message}`);
    throw error;
  } finally {
    saveSetupState(paths, state);
  }
  return state;
}

/** 后台运行安装：立即返回，进度写入 setup-state.json，供 setup-status 轮询。 */
export function launchSetup(dataDir, input = {}) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const current = readSetupState(paths);
  if (current.status === "running" && current.pid && pidAlive(current.pid)) {
    return { alreadyRunning: true, pid: current.pid, status: current.status };
  }
  writeJson(paths.setupRequest, { sourceDir: input.sourceDir || "", sourceZip: input.sourceZip || "" });
  const state = resetSetupState();
  state.status = "running";
  state.startedAt = Date.now();
  saveSetupState(paths, state);
  const cli = path.join(MODULE_DIR, "..", "image-pool.mjs");
  const logFd = fs.openSync(path.join(paths.logs, "setup.log"), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [cli, "native-setup-run"], {
      cwd: path.resolve(MODULE_DIR, "..", ".."),
      env: process.env,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  state.pid = child.pid;
  saveSetupState(paths, state);
  return { alreadyRunning: false, pid: child.pid, status: "running" };
}

export function setupStatus(dataDir) {
  const paths = nativePaths(dataDir);
  return { ...readSetupState(paths), logFile: path.join(paths.logs, "setup.log") };
}

export function readSetupRequest(dataDir) {
  return readJson(nativePaths(dataDir).setupRequest, {}) || {};
}

/* ---------------- 状态与偏好 ---------------- */

export async function nativeStatus(dataDir) {
  const paths = nativePaths(dataDir);
  const key = fs.existsSync(paths.keyFile) ? nativeKey(paths) : "";
  const probe = await probeBackend(nativeBaseUrl(), key, { timeoutMs: 1500 });
  const patch = sourcePatchStatus(paths.source);
  const runtime = readRuntime(paths) || {};
  const pid = readBackendPid(paths);
  const sourceReady = fs.existsSync(path.join(paths.source, "main.py"));
  return {
    enabled: true,
    baseUrl: nativeBaseUrl(),
    port: nativePort(),
    running: probe.up,
    ours: probe.ours,
    pid: pid || 0,
    uptimeMs: runtime.startedAt ? Math.max(0, Date.now() - Number(runtime.startedAt)) : 0,
    source: {
      dir: paths.source, ready: sourceReady, commit: SOURCE_COMMIT, version: SOURCE_VERSION,
      patched: patch.current, patchVersion: patch.installed || "",
    },
    python: runtimeSummary(paths),
    accounts: probe.health?.accounts || null,
    models: NATIVE_MODELS,
    gif: { models: NATIVE_MODELS, ...GIF_LIMITS, referenceImages: false, streaming: false },
    dataDir: paths.data,
    runtime: { ...runtime, pid: pid || 0 },
    logFile: paths.logFile,
  };
}

/* ---------------- 本机代理发现 / 一键配置 ---------------- */

function testProxyClients(input) {
  if (process.env.RUODAO_IMAGE_POOL_PROXY_TEST === "1" && Array.isArray(input.clients)) return input.clients;
  return undefined;
}

function proxyPortOf(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return 0;
    return Number(url.port) || 0;
  } catch {
    return 0;
  }
}

function pickProxyClient(clients, clientId) {
  if (clientId) {
    const wanted = clients.find((item) => item.id === clientId || item.name === clientId);
    if (wanted) return wanted;
  }
  return clients.find((item) => item.installed && item.running)
    || clients.find((item) => item.installed)
    || clients.find((item) => item.running)
    || null;
}

function orderProxyCandidates(candidates, { currentRaw = "", client = null } = {}) {
  const preferred = [...(client?.ports || [])];
  const currentPort = proxyPortOf(currentRaw);
  if (currentPort) preferred.push(currentPort);
  const rank = (port) => {
    const index = preferred.indexOf(port);
    return index < 0 ? preferred.length + 100 : index;
  };
  return candidates
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.port) - rank(b.item.port) || a.index - b.index)
    .map(({ item }) => item);
}

async function autoConfigureProxy(dataDir, input = {}) {
  const steps = [];
  const record = (id, title, status, detail = "") => steps.push({ id, title, status, detail });
  const ports = normalizePorts(input.ports);
  const clients = testProxyClients(input);
  let discovery = { clients: [], ports: [], candidates: [], summary: "" };
  let backend = null;
  let engineError = "";
  try {
    backend = await ensureBackend(dataDir, { autoPrepare: false });
    record("engine", "原生号池", "ok", backend.baseUrl);
  } catch (error) {
    engineError = error?.message || String(error);
    record("engine", "原生号池", "warn", engineError);
  }

  let current = { configured: false, proxy: "", masked: "" };
  if (backend) {
    try {
      current = await readEngineProxy(backend);
    } catch (error) {
      record("current", "当前代理", "warn", `读取失败：${error?.message || error}`);
    }
    if (current.configured) {
      try {
        const result = await testEngineProxy(backend, "", { timeoutMs: 20000 });
        if (result.ok && !result.blocked) {
          record("current", "当前代理", "ok", `${current.masked} 可用（HTTP ${result.status}）`);
          return {
            engine: true, outcome: "ok", configured: true, proxy: current.masked, result,
            steps, clients: discovery.clients, ports: discovery.ports, candidates: [],
            message: `当前代理正常：${current.masked}（ChatGPT 可达，HTTP ${result.status}），无需修改。`,
          };
        }
        record("current", "当前代理", "warn", result.hint || "已保存的代理不可用");
      } catch (error) {
        record("current", "当前代理", "warn", `测试失败：${error?.message || error}`);
      }
    } else {
      record("current", "当前代理", "skip", "未配置（直连）");
    }
  }

  discovery = await discoverLocalProxies({
    ports: ports.length ? ports : undefined,
    clients,
    inspectProcesses: input.inspectProcesses !== false,
  });
  record("scan", "扫描本机代理", discovery.candidates.length ? "ok" : "warn", discovery.summary);

  let launchedClient = null;
  if (!discovery.candidates.length) {
    const client = pickProxyClient(discovery.clients, input.clientId);
    if (!client) {
      record("launch", "启动代理客户端", "error", "未检测到 Jimmm / Clash Verge / v2rayN 等常见客户端");
      return {
        engine: Boolean(backend), outcome: "no-client", configured: current.configured,
        proxy: current.configured ? current.masked : "", steps, clients: discovery.clients,
        ports: [], candidates: [],
        message: "未检测到可自动启动的代理客户端。请先安装并打开 Jimmm / Clash Verge / v2rayN 等代理客户端，或在下方手动填写代理端口。",
      };
    }
    if (!client.path) {
      record("launch", "启动代理客户端", "error", `${client.name} 正在运行，但没有检测到代理端口，请开启系统代理 / 混合端口`);
      return {
        engine: Boolean(backend), outcome: "no-port", configured: current.configured,
        proxy: current.configured ? current.masked : "", steps, clients: discovery.clients,
        ports: [], candidates: [],
        message: `检测到 ${client.name} 正在运行，但代理端口没有打开。请在客户端里开启「系统代理 / 混合端口」，或手动填写代理地址。`,
      };
    }
    record("launch", "启动代理客户端", "ok", `正在启动 ${client.name}：${client.path}`);
    const waitMs = Math.min(45000, Math.max(1000, Number(input.waitMs) || 30000));
    try {
      const launched = await launchProxyClient(client, { ports: ports.length ? ports : undefined, waitMs });
      launchedClient = client;
      if (!launched.listening.length) {
        record("launch", "启动代理客户端", "warn", `${client.name} 已启动，但 ${Math.round(waitMs / 1000)} 秒内没有检测到代理端口`);
        return {
          engine: Boolean(backend), outcome: "launch-timeout", configured: current.configured,
          proxy: current.configured ? current.masked : "", steps, clients: discovery.clients,
          ports: [], candidates: [],
          message: `已启动 ${client.name}，但没有检测到代理端口。请确认客户端已登录节点并开启「系统代理 / 混合端口」，然后再试一次。`,
        };
      }
      record("launch", "启动代理客户端", "ok", `${client.name} 已启动，端口 ${launched.listening.join(" / ")} 已就绪`);
      discovery = await discoverLocalProxies({
        ports: ports.length ? ports : undefined,
        clients,
        inspectProcesses: false,
      });
    } catch (error) {
      record("launch", "启动代理客户端", "error", error?.message || String(error));
      return {
        engine: Boolean(backend), outcome: "launch-failed", configured: current.configured,
        proxy: current.configured ? current.masked : "", steps, clients: discovery.clients,
        ports: [], candidates: [],
        message: `${error?.message || "启动代理客户端失败"}。也可以手动打开代理客户端，或在下方填写代理地址。`,
      };
    }
  }

  const candidates = orderProxyCandidates(discovery.candidates, { currentRaw: current.proxy, client: launchedClient });
  if (!backend) {
    return {
      engine: false, outcome: "engine-offline", configured: current.configured,
      proxy: current.configured ? current.masked : "", steps, clients: discovery.clients,
      ports: discovery.ports, candidates: candidates.map((item) => item.url),
      suggested: candidates[0]?.url || "",
      message: candidates.length
        ? `已检测到本机代理端口 ${candidates.map((item) => item.url).join(" / ")}；原生号池未启动，先启动号池后再点一次即可自动验证并保存。`
        : "原生号池未启动，暂时无法验证代理；先启动号池后再试。",
    };
  }

  let best = null;
  let blocked = null;
  let lastError = "";
  for (const candidate of candidates.slice(0, 4)) {
    try {
      const result = await testEngineProxy(backend, candidate.url, { timeoutMs: 15000 });
      record("verify", `验证 ${candidate.url}`, result.ok ? "ok" : "warn", result.hint || `HTTP ${result.status}`);
      if (result.ok && !result.blocked) {
        const score = result.status >= 200 && result.status < 400 ? 2 : 1;
        if (!best || score > best.score) best = { candidate, result, score };
        if (score === 2) break;
      } else if (result.blocked) {
        blocked = result;
      }
    } catch (error) {
      lastError = error?.message || String(error);
      record("verify", `验证 ${candidate.url}`, "warn", lastError);
    }
  }
  if (!best) {
    const message = blocked
      ? `本机代理端口可以连通，但出口 IP 被 OpenAI 风控（HTTP ${blocked.status}）。请在代理客户端切换节点后再试。`
      : `检测到本机代理端口，但访问 ChatGPT 失败：${lastError || "连接不可用"}。请检查代理客户端是否已连接节点。`;
    return {
      engine: true, outcome: blocked ? "blocked" : "no-working", configured: current.configured,
      proxy: current.configured ? current.masked : "", result: blocked || null, steps,
      clients: discovery.clients, ports: discovery.ports, candidates: candidates.map((item) => item.url),
      suggested: candidates[0]?.url || "", message,
    };
  }
  try {
    const saved = await saveEngineProxy(backend, best.candidate.url);
    record("save", "保存全局代理", "ok", `${best.candidate.url}（ChatGPT HTTP ${best.result.status}）`);
    return {
      engine: true, outcome: "saved", configured: saved.configured, proxy: saved.proxy,
      result: best.result, candidate: best.candidate.url, steps, clients: discovery.clients,
      ports: discovery.ports, candidates: candidates.map((item) => item.url),
      message: `已自动配置本机代理 ${best.candidate.url}，登录、额度刷新和生图都会走它。`,
    };
  } catch (error) {
    record("save", "保存全局代理", "error", error?.message || String(error));
    return {
      engine: true, outcome: "save-failed", configured: current.configured,
      proxy: current.configured ? current.masked : "", result: best.result, steps,
      clients: discovery.clients, ports: discovery.ports, candidates: candidates.map((item) => item.url),
      message: `代理可用，但保存失败：${error?.message || error}。请点「保存代理」手动填写 ${best.candidate.url}。`,
    };
  }
}

/** 全局代理：登录 OpenAI、刷新额度、生图共用同一个出口。 */
export async function nativeProxyAction(dataDir, input = {}) {
  const action = String(input.action || "get").toLowerCase();
  if (action === "discover") {
    const ports = normalizePorts(input.ports);
    const discovery = await discoverLocalProxies({
      ports: ports.length ? ports : undefined,
      clients: testProxyClients(input),
      inspectProcesses: input.inspectProcesses !== false,
    });
    return { action, baseUrl: nativeBaseUrl(), ...discovery };
  }
  if (action === "auto") {
    return { action, baseUrl: nativeBaseUrl(), ...(await autoConfigureProxy(dataDir, input)) };
  }
  const backend = await ensureBackend(dataDir, { autoPrepare: false });
  if (action === "get") {
    const state = await readEngineProxy(backend);
    return { action, baseUrl: backend.baseUrl, configured: state.configured, proxy: state.masked };
  }
  if (action === "set") {
    const saved = await saveEngineProxy(backend, input.url ?? input.proxy ?? "");
    return { action, baseUrl: backend.baseUrl, ...saved };
  }
  if (action === "test") {
    const result = await testEngineProxy(backend, input.url ?? input.proxy ?? "");
    return { action, baseUrl: backend.baseUrl, result };
  }
  throw new Error(`未知代理操作：${action}（支持 get / set / test / discover / auto）`);
}

export function readPreferences(dataDir) {
  const saved = readJson(nativePaths(dataDir).preferences, {}) || {};
  const model = String(saved.defaultModel || "").trim();
  return {
    // 旧版本可能保存过引擎不支持的 2.5 系列，读回时直接回落到默认模型。
    defaultModel: isEngineImageModel(model) ? model : "gpt-image-2.6",
    defaultImageTier: normalizeImageTier(saved.defaultImageTier),
  };
}

export function writePreferences(dataDir, prefs = {}) {
  const paths = nativePaths(dataDir);
  ensureNativeDirs(paths);
  const current = readJson(paths.preferences, {}) || {};
  const next = { ...current };
  if (prefs.defaultModel !== undefined) {
    const model = String(prefs.defaultModel || "").trim();
    if (!isEngineImageModel(model)) throw new Error("默认模型不在原生引擎支持列表（2.6 系列 / gpt-image-2 / Codex 系列）");
    next.defaultModel = model;
  }
  if (prefs.defaultImageTier !== undefined) {
    const tier = String(prefs.defaultImageTier ?? "").trim().toLowerCase();
    if (tier && !IMAGE_TIERS.includes(tier)) throw new Error("分辨率档位只支持 auto / 1k / 2k / 4k");
    next.defaultImageTier = tier || "auto";
  }
  writeJson(paths.preferences, next);
  return readPreferences(dataDir);
}

/** 从运行中的原生后端拉取账号实际可用的图像模型；未启动或失败时返回空数组。 */
export async function listBackendImageModels(dataDir, { timeoutMs = 8000 } = {}) {
  const paths = nativePaths(dataDir);
  try {
    const response = await fetchJson(`${nativeBaseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${nativeKey(paths)}` },
      timeoutMs,
    });
    if (!response.ok) return [];
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    return [...new Set(rows.map((item) => String(item?.id || "").trim()).filter(isEngineImageModel))].sort();
  } catch {
    return [];
  }
}

/* ---------------- 便捷入口 ---------------- */

export function nativeDirs(dataDir) {
  return nativePaths(dataDir);
}

export function nativeLogTail(dataDir, lines = 80) {
  return logTail(nativePaths(dataDir), lines);
}

export function defaultPort() {
  return DEFAULT_PORT;
}
