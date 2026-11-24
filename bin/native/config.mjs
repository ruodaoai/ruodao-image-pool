/**
 * 原生号池引擎配置：固定后端版本、目录、端口与模型清单。
 *
 * 原生引擎不再依赖浏览器窗口，而是直接托管 chatgpt2api 的 ChatGPT 账号池后端：
 * 账号用 OAuth / 2FA 换取 token，后端用 token 调用 ChatGPT 生图，
 * 因此支持 gpt-image-2.6（含 flare / sunburst）与原生 GIF。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SOURCE_COMMIT = "92dd80e91543157d36a4ddad60e765c5293760e9";
export const SOURCE_VERSION = "1.8.0";
export const DEFAULT_PORT = 38650;
export const PATCH_VERSION = "ruodao-pool-gif-v3";

export const NATIVE_MODELS = Object.freeze([
  "gpt-image-2.6",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);
/** 引擎 BASE_IMAGE_MODELS 里的静态图模型；固定的 chatgpt2api v1.8.0 不支持 2.5 系列。 */
export const COMPAT_MODELS = Object.freeze(["gpt-image-2"]);
/** Codex 账号专用模型：只有后端返回对应套餐账号时才会出现在目录里。 */
export const CODEX_MODELS = Object.freeze([
  "codex-gpt-image-2",
  "plus-codex-gpt-image-2",
  "pro-codex-gpt-image-2",
  "team-codex-gpt-image-2",
]);
export const IMAGE_MODELS = Object.freeze([...NATIVE_MODELS, ...COMPAT_MODELS]);
/** 引擎生成接口的白名单；超出这里的 ID 会直接返回 unsupported image model。 */
export const ENGINE_IMAGE_MODELS = Object.freeze([...IMAGE_MODELS, ...CODEX_MODELS]);
export const IMAGE_TIERS = Object.freeze(["auto", "1k", "2k", "4k"]);
export const IMAGE_QUALITIES = Object.freeze(["auto", "low", "medium", "high"]);
export const GIF_MODELS = new Set(NATIVE_MODELS);
export const GIF_LIMITS = Object.freeze({ minFrames: 2, maxFrames: 16, minDurationMs: 20, maxDurationMs: 2000, durationStepMs: 10 });

/** 与原生引擎 ruodao_entrypoint.py 的 PRESET_SIZES 保持一致。 */
export const TIER_PRESET_SIZES = Object.freeze({
  "1:1": Object.freeze({ "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" }),
  "16:9": Object.freeze({ "1k": "1920x1088", "2k": "2560x1440", "4k": "3840x2160" }),
  "9:16": Object.freeze({ "1k": "1088x1920", "2k": "1440x2560", "4k": "2160x3840" }),
  "3:2": Object.freeze({ "1k": "1536x1024", "2k": "2400x1600", "4k": "3600x2400" }),
  "2:3": Object.freeze({ "1k": "1024x1536", "2k": "1600x2400", "4k": "2400x3600" }),
  "4:3": Object.freeze({ "1k": "1365x1024", "2k": "2560x1920", "4k": "3840x2880" }),
  "3:4": Object.freeze({ "1k": "1024x1365", "2k": "1920x2560", "4k": "2880x3840" }),
});

const env = (k, d = "") => (process.env[k] ?? d).trim();

export function nativeEnabled() {
  return !["off", "0", "false", "no"].includes(env("RUODAO_NATIVE_ENGINE", "on").toLowerCase());
}

export function nativePort() {
  const value = Number(env("RUODAO_NATIVE_PORT", String(DEFAULT_PORT)));
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("原生号池端口应为 1024–65535");
  return value;
}

export function nativeBaseUrl() {
  return `http://127.0.0.1:${nativePort()}`;
}

export function nativePaths(dataDir) {
  const root = path.resolve(env("RUODAO_NATIVE_HOME") || path.join(dataDir, "native"));
  return {
    root,
    source: path.join(root, "source"),
    data: path.join(root, "data"),
    venv: path.join(root, "venv"),
    downloads: path.join(root, "downloads"),
    logs: path.join(root, "logs"),
    logFile: path.join(root, "logs", "backend.log"),
    keyFile: path.join(root, "native-key.txt"),
    pidFile: path.join(root, "backend.pid"),
    runtimeFile: path.join(root, "runtime.json"),
    setupState: path.join(root, "setup-state.json"),
    setupRequest: path.join(root, "setup-request.json"),
    marker: path.join(root, "source-commit.txt"),
    patchMarker: path.join(root, "source", ".ruodao-pool-gif-patch"),
    preferences: path.join(root, "preferences.json"),
    requirements: path.join(root, "requirements.txt"),
    authWorker: path.join(MODULE_DIR, "auth_worker.py"),
  };
}

export function ensureNativeDirs(paths) {
  for (const dir of [paths.root, paths.data, paths.downloads, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** API key 只保存在本机用户数据目录，绝不写入插件仓库或日志。 */
export function nativeKey(paths) {
  ensureNativeDirs(paths);
  try {
    const saved = fs.readFileSync(paths.keyFile, "utf8").trim();
    if (saved.length >= 12) return saved;
  } catch { /* 首次启动 */ }
  const fresh = randomBytes(32).toString("hex");
  fs.writeFileSync(paths.keyFile, fresh + "\n", { flag: "w", mode: 0o600 });
  return fresh;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function readSetupState(paths) {
  return readJson(paths.setupState, { status: "idle", steps: {}, log: [] });
}

export function markEmail(email) {
  const text = String(email || "");
  if (!text) return "";
  const [name, domain] = text.split("@");
  if (!domain) return text.length > 4 ? `${text.slice(0, 2)}***${text.slice(-2)}` : "***";
  const head = name.length > 2 ? name.slice(0, 2) + "***" : name.slice(0, 1) + "***";
  return `${head}@${domain}`;
}

export function isNativeModel(model) {
  return NATIVE_MODELS.includes(String(model || "").trim());
}

export function isKnownImageModel(model) {
  return IMAGE_MODELS.includes(String(model || "").trim());
}

export function isEngineImageModel(model) {
  return ENGINE_IMAGE_MODELS.includes(String(model || "").trim());
}

export function normalizeImageTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return IMAGE_TIERS.includes(tier) ? tier : "auto";
}

export function normalizeImageQuality(value) {
  const quality = String(value || "").trim().toLowerCase();
  return IMAGE_QUALITIES.includes(quality) ? quality : "auto";
}

/** 档位换算实际尺寸；比例缺省按 1:1，auto 不指定尺寸。 */
export function sizeForTier(tier, ratio = "1:1") {
  const sizes = TIER_PRESET_SIZES[String(ratio || "1:1").trim() || "1:1"];
  return sizes?.[String(tier || "").trim().toLowerCase()] || "";
}

/** 高清/超清同时把 quality 提到 high；标准与自动沿用上游默认。 */
export function qualityForTier(tier) {
  const value = String(tier || "").trim().toLowerCase();
  return value === "2k" || value === "4k" ? "high" : "";
}

export function isGifModel(model) {
  return GIF_MODELS.has(String(model || "").trim());
}

