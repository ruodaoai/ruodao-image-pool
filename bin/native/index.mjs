/** 原生号池引擎门面：CLI、守护进程和工作台只依赖这里。 */
export {
  SOURCE_COMMIT, SOURCE_VERSION, PATCH_VERSION, DEFAULT_PORT,
  NATIVE_MODELS, COMPAT_MODELS, CODEX_MODELS, IMAGE_MODELS, ENGINE_IMAGE_MODELS, IMAGE_TIERS, IMAGE_QUALITIES, GIF_MODELS, GIF_LIMITS,
  TIER_PRESET_SIZES,
  nativeEnabled, nativePort, nativeBaseUrl, nativePaths, nativeKey, isNativeModel, isKnownImageModel, isEngineImageModel,
  normalizeImageTier, normalizeImageQuality, qualityForTier, sizeForTier, isGifModel,
} from "./config.mjs";
export {
  SETUP_STEPS, ensureBackend, launchSetup, listBackendImageModels, nativeLogTail, nativeProxyAction, nativeStatus,
  prepareRuntime, probeBackend, readPreferences, readSetupRequest, runSetup, setupStatus, startExistingBackend,
  stopBackend, writePreferences,
} from "./backend.mjs";
export {
  checkAccounts, classifyCheckError, deleteAccounts, importCredentials, listAccounts, loginAccounts, nativeAccountAction,
  parseCredentialText, refreshAccounts,
} from "./accounts.mjs";
export { detectImageFormat, nativeGenerate, normalizeReferences, validateGifOptions } from "./images.mjs";

import fs from "node:fs";
import path from "node:path";
import { GIF_LIMITS, IMAGE_MODELS, IMAGE_TIERS, NATIVE_MODELS, isEngineImageModel, nativePaths } from "./config.mjs";
import { venvPython } from "./python.mjs";

/** 轻量安装态检查：不启动 Python、不探测端口，供模型目录 / 自检快速判断。 */
export function nativeInstalled(dataDir) {
  const paths = nativePaths(dataDir);
  return {
    source: fs.existsSync(path.join(paths.source, "main.py")),
    venv: fs.existsSync(venvPython(paths)),
    patched: fs.existsSync(paths.patchMarker),
    dataDir: paths.data,
    logFile: paths.logFile,
  };
}

/** 原生模型条目：即使后端还没导入账号，下拉框也能看到 2.6 / 2 与 GIF 能力。 */
export function nativeModelEntries(extraIds = []) {
  const created = Math.floor(Date.now() / 1000);
  const ids = [...new Set([...IMAGE_MODELS, ...extraIds.map((id) => String(id || "").trim()).filter(isEngineImageModel)])];
  return ids.map((id) => ({
    id, object: "model", created, owned_by: "ruodao-native", type: "image",
    capabilities: {
      gif: NATIVE_MODELS.includes(id),
      ...(NATIVE_MODELS.includes(id) ? { frames: [GIF_LIMITS.minFrames, GIF_LIMITS.maxFrames], frameDurationMs: [GIF_LIMITS.minDurationMs, GIF_LIMITS.maxDurationMs] } : {}),
      referenceImages: true, streaming: false, tiers: IMAGE_TIERS,
    },
  }));
}
