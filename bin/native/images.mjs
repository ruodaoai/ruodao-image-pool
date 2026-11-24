/**
 * 原生生图：参数校验、参考图归一化、GIF 校验、落盘与台账。
 *
 * 原生后端由 chatgpt2api 调度账号池；本模块只负责插件侧契约：
 * gpt-image-2.6 × 3 模型、原生 GIF（2–16 帧 / 20–2000ms / 不支持参考图与流式）。
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { appendLedger, ensureDataDir, imagesDir, writeImageMeta } from "../ledger.mjs";
import {
  ENGINE_IMAGE_MODELS, GIF_LIMITS, GIF_MODELS, IMAGE_QUALITIES, IMAGE_TIERS,
  isEngineImageModel, nativeBaseUrl, normalizeImageTier, qualityForTier, sizeForTier,
} from "./config.mjs";
import {
  ensureBackend, fetchJson, maskProxyUrl, nativeProxyAction, readEngineProxy, readPreferences,
} from "./backend.mjs";

const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const RATIOS = new Set(["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"]);
const PROMPT_RATIO_RE = /(?:^|[^\d])(?:比例|画幅|aspect\s*ratio)?\s*(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4)(?!\d)/i;

// 上游瞬断（curl 56、连接被重置、网关 5xx）重试一次通常就能成功；
// 内容审核、额度耗尽、参数错误重试只会浪费时间与额度，必须直接返回。
const TRANSIENT_TRANSPORT_RE = /fetch failed|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|connection (?:closed|reset|aborted)|aborted due to timeout|the operation was aborted/i;
const TRANSIENT_UPSTREAM_RE = /connection (?:closed|reset)|socket hang up|curl: \((?:18|28|52|55|56|92)\)|timed? ?out|bad gateway|service unavailable|gateway timeout|upstream.{0,40}(?:error|failed|unavailable)/i;
const NO_RETRY_RE = /内容政策|防护限制|内容审核|content[_ -]?policy|moderation|safety (?:system|policy)|rejected as a result|no available image quota|没有可用生图额度|没有可用账号|upstream unreachable|无法连接 OpenAI|未登录|未安装|不支持|缺少|必须是|超过|格式|帧数|时长/i;
/** 引擎 v3 起会区分「账号都正常但连不上 OpenAI」与「真的没有额度」。 */
const UPSTREAM_UNREACHABLE_RE = /image account upstream unreachable|upstream unreachable|无法连接 OpenAI/i;
const PROXY_RECOVERY_COOLDOWN_MS = 120000;
let lastProxyRecoveryAt = 0;

export function validateGifOptions(input = {}) {
  const frames = input.frameCount ?? input.frame_count ?? 9;
  const duration = input.frameDurationMs ?? input.frame_duration_ms ?? 200;
  if (!Number.isInteger(Number(frames)) || Number(frames) < GIF_LIMITS.minFrames || Number(frames) > GIF_LIMITS.maxFrames) {
    throw new Error(`GIF 帧数必须是 ${GIF_LIMITS.minFrames}–${GIF_LIMITS.maxFrames} 的整数`);
  }
  if (!Number.isInteger(Number(duration)) || Number(duration) < GIF_LIMITS.minDurationMs || Number(duration) > GIF_LIMITS.maxDurationMs || Number(duration) % GIF_LIMITS.durationStepMs) {
    throw new Error(`GIF 每帧时长必须是 ${GIF_LIMITS.minDurationMs}–${GIF_LIMITS.maxDurationMs}ms，且为 ${GIF_LIMITS.durationStepMs}ms 的整数倍`);
  }
  return { frameCount: Number(frames), frameDurationMs: Number(duration) };
}

export function detectImageFormat(bytes) {
  if (bytes.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "gif";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return "";
}

function mimeFromFormat(format) {
  return format === "gif" ? "image/gif" : format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

/** 从图片字节读实际像素，用于图片库与生成结果里核对高清是否生效。 */
export function detectImageSize(bytes, format = detectImageFormat(bytes)) {
  try {
    if (format === "png" && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (format === "gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (format === "webp" && bytes.length >= 30) {
      const chunk = bytes.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
      if (chunk === "VP8 ") {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
    if (format === "jpg" && bytes.length >= 4) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        if (length < 2) break;
        offset += 2 + length;
      }
    }
  } catch { /* 读取失败不影响出图 */ }
  return { width: 0, height: 0 };
}

/** 提示词里写了比例（如「竖版 2:3」）时，档位换算沿用该比例。 */
export function inferAspectRatioFromPrompt(prompt) {
  const match = PROMPT_RATIO_RE.exec(String(prompt || ""));
  return match ? match[1].replace(/\s/g, "") : "";
}

function decodeBase64(text) {
  const cleaned = String(text || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!cleaned) throw new Error("参考图为空");
  const bytes = Buffer.from(cleaned, "base64");
  if (!bytes.length) throw new Error("参考图 Base64 无效");
  return bytes;
}

function readReference(item, index) {
  const label = `第 ${index + 1} 张参考图`;
  if (typeof item === "string") {
    const text = item.trim();
    if (/^https?:\/\//i.test(text) || text.startsWith("data:")) return text;
    if (fs.existsSync(text)) {
      const bytes = fs.readFileSync(text);
      if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(`${label}超过 20MB`);
      const format = detectImageFormat(bytes) || path.extname(text).slice(1) || "png";
      return { b64_json: bytes.toString("base64"), mime_type: mimeFromFormat(format), filename: path.basename(text) };
    }
    const bytes = decodeBase64(text);
    if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(`${label}超过 20MB`);
    const format = detectImageFormat(bytes) || "png";
    return { b64_json: bytes.toString("base64"), mime_type: mimeFromFormat(format), filename: `reference-${index + 1}.${format}` };
  }
  if (item && typeof item === "object") {
    const inline = item.b64_json || item.base64 || item.dataBase64 || item.data;
    if (inline) {
      const bytes = decodeBase64(inline);
      if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(`${label}超过 20MB`);
      const format = detectImageFormat(bytes) || "png";
      return {
        b64_json: bytes.toString("base64"),
        mime_type: item.mime_type || item.mimeType || mimeFromFormat(format),
        filename: item.filename || item.file_name || `reference-${index + 1}.${format}`,
      };
    }
    const url = item.image_url || item.url;
    if (url) return typeof url === "string" ? url : String(url.url || "");
  }
  throw new Error(`${label}格式无效：需要 Base64、data URL、http 链接或本地图片路径`);
}

export function normalizeReferences(input = {}) {
  const raw = input.images ?? input.image ?? input.referenceImages ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > MAX_REFERENCES) throw new Error(`参考图最多 ${MAX_REFERENCES} 张`);
  return list.filter((item) => item != null && item !== "").map(readReference);
}

/** 提交生图请求并保存结果；返回可直接给 CLI/守护进程的响应。 */
export async function nativeGenerate(dataDir, input = {}, { onProgress } = {}) {
  const prompt = String(input.prompt || input.description || "").trim();
  if (!prompt) throw new Error("缺少生图提示词：请传 { prompt }");
  if (prompt.length > 12000) throw new Error("提示词最长 12000 字符");
  const preferences = readPreferences(dataDir);
  const model = String(input.model || preferences.defaultModel || "gpt-image-2.6").trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error("模型名称无效");
  if (/^gpt-image-2\.5(?:-|$)/.test(model)) {
    throw new Error("当前原生引擎不支持 gpt-image-2.5 系列（后端白名单只有 2.6 / gpt-image-2 / Codex 系列），请改用 gpt-image-2.6");
  }
  if (!isEngineImageModel(model)) {
    throw new Error(`原生号池不支持模型 ${model}；可用：${ENGINE_IMAGE_MODELS.join(" / ")}`);
  }
  const gif = Boolean(input.output_format === "gif" || input.outputFormat === "gif" || input.gif);
  if (gif && !GIF_MODELS.has(model)) throw new Error("原生 GIF 只支持 gpt-image-2.6 / flare / sunburst");
  const allReferences = normalizeReferences(input);
  if (gif && allReferences.length) throw new Error("原生 GIF 暂不支持参考图片");
  const references = gif ? [] : allReferences;
  if (input.stream) throw new Error("原生 GIF/生图接口不支持 stream，请去掉 stream 参数");

  let size = String(input.size || "").trim();
  if (size && !SIZE_RE.test(size)) throw new Error("size 格式应为 宽x高，例如 1024x1024");
  const explicitTier = String(input.resolution ?? input.imageTier ?? "").trim().toLowerCase();
  if (explicitTier && !IMAGE_TIERS.includes(explicitTier)) throw new Error("分辨率档位只支持 auto / 1k / 2k / 4k");
  // 未显式指定档位时沿用工作台保存的默认画质；显式 auto 仍然交给上游决定。
  const tier = explicitTier || normalizeImageTier(preferences.defaultImageTier);
  const explicitQuality = String(input.quality || "").trim().toLowerCase();
  if (explicitQuality && !IMAGE_QUALITIES.includes(explicitQuality)) throw new Error("画质只支持 auto / low / medium / high");
  const quality = explicitQuality || qualityForTier(tier);
  const ratio = String(input.aspect_ratio || input.aspectRatio || "").trim();
  if (ratio && !RATIOS.has(ratio)) throw new Error("画幅比例只支持 1:1 / 16:9 / 9:16 / 3:2 / 2:3 / 4:3 / 3:4");
  if (!size && !gif && tier !== "auto") {
    // 选了高清/超清却没选画幅时按 1:1 换算，否则上游会继续按默认 1024 出图。
    size = sizeForTier(tier, ratio || inferAspectRatioFromPrompt(prompt) || "1:1");
  }
  const n = Number(input.n || 1);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("n 必须是 1–4 的整数");

  const startedAt = Date.now();
  const backend = await ensureBackend(dataDir, { onProgress });
  const body = {
    model,
    prompt,
    n,
    response_format: "b64_json",
    ...(size ? { size } : {}),
    ...(tier ? { resolution: tier } : {}),
    ...(ratio ? { aspect_ratio: ratio } : {}),
    ...(quality && quality !== "auto" ? { quality } : {}),
  };
  let gifOptions = null;
  if (gif) {
    gifOptions = validateGifOptions(input);
    body.output_format = "gif";
    body.frame_count = gifOptions.frameCount;
    body.frame_duration_ms = gifOptions.frameDurationMs;
    // 与参考实现一致：GIF 交给上游按画幅自动定尺寸，避免被固定尺寸裁成分镜
    if (!size) body.size = "auto";
  }
  if (references.length) body.images = references;

  const endpoint = references.length ? "/v1/images/edits" : "/v1/images/generations";
  onProgress?.({ phase: "submit", message: `${gif ? "原生 GIF" : "原生生图"}提交：${model}${gif ? ` · ${gifOptions.frameCount} 帧 / ${gifOptions.frameDurationMs}ms` : ""}` });
  const submit = () => submitWithTransientRetry(`${nativeBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.key}` },
    body,
    timeoutMs: Math.max(60000, Number(input.timeoutMs) || 600000),
  }, (attempt, reason) => {
    onProgress?.({ phase: "retry", message: `原生号池请求中断（${reason.slice(0, 120)}），第 ${attempt} 次重试…` });
  });
  let response = await submit();
  let recovery = null;
  if (!response.ok && UPSTREAM_UNREACHABLE_RE.test(briefError(response.text))) {
    if (input.autoRecoverProxy === false) {
      recovery = { retry: false, skipped: true, note: "调用方关闭了自动启动代理", reason: unreachableReason(briefError(response.text)) };
    } else {
      recovery = await recoverProxyOnce(dataDir, backend, briefError(response.text), onProgress);
      if (recovery.retry) {
        onProgress?.({ phase: "proxy", message: `${recovery.note || "代理已恢复"}，重新提交生图…` });
        response = await submit();
      }
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    const raw = briefError(response.text) || `原生生图失败（HTTP ${response.status}）`;
    let message = raw;
    if (UPSTREAM_UNREACHABLE_RE.test(raw)) {
      message = await unreachableMessage(backend, raw, recovery);
    } else if (/no available image quota/i.test(`${raw} ${response.text || ""}`)) {
      message = await quotaExhaustedMessage(backend);
    }
    appendLedger({ kind: "image", source: "native", model, account: "native-pool", state: "failed", elapsedMs, promptChars: prompt.length, prompt: prompt.slice(0, 200), error: message });
    throw new Error(message);
  }
  const data = Array.isArray(response.data?.data) ? response.data.data : [];
  if (!data.length) {
    const message = briefError(response.data?.message || response.text) || "原生生图响应中没有图片";
    appendLedger({ kind: "image", source: "native", model, account: "native-pool", state: "failed", elapsedMs, promptChars: prompt.length, prompt: prompt.slice(0, 200), error: message });
    throw new Error(message);
  }

  ensureDataDir();
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  try {
    for (let i = 0; i < data.length; i++) {
      const item = data[i] || {};
      if (!item.b64_json) throw new Error("原生生图返回了空图片数据");
      const bytes = decodeBase64(item.b64_json);
      const format = detectImageFormat(bytes);
      if (!format) throw new Error("上游返回的图片格式无法识别");
      if (gif && format !== "gif") throw new Error("请求了 GIF，但上游没有返回 GIF 数据（已阻止保存为静态图）");
      const file = path.join(dir, `native-${Date.now()}-${i + 1}.${format}`);
      fs.writeFileSync(file, bytes);
      const dimensions = detectImageSize(bytes, format);
      writeImageMeta(file, {
        prompt: prompt.slice(0, 500), model, format, size: size || "", source: "native",
        resolution: tier || undefined, aspectRatio: ratio || undefined, quality: quality || undefined,
        width: dimensions.width || undefined, height: dimensions.height || undefined,
        gif: gifOptions || undefined, elapsedMs,
      });
      saved.push({ file, format, bytes: bytes.length, width: dimensions.width, height: dimensions.height });
    }
  } catch (error) {
    appendLedger({ kind: "image", source: "native", model, account: "native-pool", state: "failed", elapsedMs, promptChars: prompt.length, prompt: prompt.slice(0, 200), error: error.message });
    throw error;
  }
  appendLedger({
    kind: "image", source: "native", state: "completed", model, account: "native-pool",
    elapsedMs, promptChars: prompt.length, prompt: prompt.slice(0, 200),
    imagePath: saved[0]?.file || "", imageUrl: "",
  });
  const imagePath = saved[0]?.file || "";
  return {
    state: "succeeded", mode: "native", model, imagePath, imageUrl: "",
    url: imagePath, images: saved.map((item) => ({ path: item.file, format: item.format, bytes: item.bytes, width: item.width, height: item.height })),
    outputFormat: saved[0]?.format || "png", gif: gifOptions || undefined,
    resolution: tier, quality: quality || undefined, size: size || "",
    elapsedMs, prompt, hint: "原生号池已出图并写入本地图片库与台账；账号池自动选择可用账号",
  };
}

/** 上游瞬断重试：只在传输层错误或网关 5xx/连接中断时重试一次，
 *  内容审核、额度、参数类错误原样返回，避免重复扣时扣额度。 */
async function submitWithTransientRetry(url, options, onRetry) {
  const attempts = 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !TRANSIENT_TRANSPORT_RE.test(errorText(error))) {
        throw new Error(`原生号池请求中断：${friendlyTransportText(error)}`);
      }
      onRetry?.(attempt + 1, friendlyTransportText(error));
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }
    if (response.ok || attempt >= attempts - 1) return response;
    const raw = briefError(response.text);
    if (NO_RETRY_RE.test(raw) || !(response.status >= 500 || TRANSIENT_UPSTREAM_RE.test(raw))) return response;
    onRetry?.(attempt + 1, raw);
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  throw new Error(`原生号池请求中断：${friendlyTransportText(lastError)}`);
}

function errorText(error) {
  return [error?.message, error?.cause?.message, error?.cause?.code, error?.code].filter(Boolean).join(" ");
}

function friendlyTransportText(error) {
  const text = errorText(error);
  if (/abort|timeout|timed out/i.test(text)) return "连接超时";
  if (/ECONNRESET|connection (?:closed|reset)|socket hang up/i.test(text)) return "连接被上游提前断开";
  if (/ENETUNREACH|EAI_AGAIN|ENOTFOUND/i.test(text)) return "网络不可达";
  return String(error?.message || error || "未知网络错误").slice(0, 200);
}

function unreachableReason(raw) {
  const text = String(raw || "");
  const via = / via ([^\s"']+)/i.exec(text)?.[1] || "";
  const reason = /proxy connection refused/i.test(text) ? "代理端口拒绝连接"
    : /network unavailable/i.test(text) ? "网络不可达"
      : "网络或代理不可用";
  return { reason, via };
}

/** 号池报「连不上 OpenAI」时自动拉起本机代理并重试一次；冷却期内不再重复启动。 */
async function recoverProxyOnce(dataDir, backend, raw, onProgress) {
  const reason = unreachableReason(raw);
  if (Date.now() - lastProxyRecoveryAt < PROXY_RECOVERY_COOLDOWN_MS) {
    return { retry: false, note: "刚刚已尝试过自动恢复，仍在冷却中", reason };
  }
  lastProxyRecoveryAt = Date.now();
  let proxy = { configured: false, masked: "" };
  try { proxy = await readEngineProxy(backend); } catch { /* 读取失败不阻断恢复 */ }
  onProgress?.({ phase: "proxy", message: `号池无法连接 OpenAI（${reason.reason}），正在自动检测并启动本机代理…` });
  let auto = null;
  try {
    auto = await nativeProxyAction(dataDir, { action: "auto" });
  } catch (error) {
    auto = { outcome: "error", message: String(error?.message || error) };
  }
  return {
    retry: auto?.outcome === "ok" || auto?.outcome === "saved",
    proxy,
    outcome: String(auto?.outcome || "error"),
    note: String(auto?.message || ""),
    reason,
  };
}

async function poolSummary(backend) {
  try {
    const response = await fetchJson(`${backend.baseUrl}/api/accounts`, {
      headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 8000,
    });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    if (!items.length) return null;
    const readyItems = items.filter((item) => String(item?.status ?? "") === "正常" && Number(item?.quota || 0) > 0);
    return {
      items,
      total: items.length,
      ready: readyItems.length,
      quota: readyItems.reduce((sum, item) => sum + Number(item?.quota || 0), 0),
    };
  } catch {
    return null;
  }
}

async function unreachableMessage(backend, raw, recovery) {
  const summary = await poolSummary(backend);
  const detail = unreachableReason(raw);
  const masked = detail.via ? maskProxyUrl(detail.via) : "";
  // curl 的 "over proxy" 有时只给主机名；优先展示配置里带端口的完整代理。
  const proxyText = masked.includes(":")
    ? `（代理 ${masked}）`
    : recovery?.proxy?.masked ? `（代理 ${recovery.proxy.masked}）` : masked ? `（代理 ${masked}）` : "";
  const note = String(recovery?.note || "").replace(/[。．.]+$/, "");
  const poolText = summary
    ? `号池 ${summary.ready}/${summary.total} 个账号可用、剩余 ${summary.quota} 张额度`
    : "号池账号本身有额度";
  const tail = recovery?.retry
    ? `已自动恢复代理并重新提交，仍连不上 OpenAI：${note || "代理未就绪"}。请稍后再试，或到「生图号池 → 网络代理」更换出口节点。`
    : recovery?.skipped
      ? "请到「生图号池 → 网络代理」点「一键检测 / 启动代理」，或手动填写可用代理后再试。"
      : `自动恢复未成功：${note || "未检测到可用的本机代理"}。请到「生图号池 → 网络代理」点「一键检测 / 启动代理」，或手动填写可用代理后再试。`;
  return `${poolText}，但无法连接 OpenAI：${detail.reason}${proxyText}。${tail}`;
}

async function quotaExhaustedMessage(backend) {
  const summary = await poolSummary(backend);
  if (!summary) return "号池暂时没有可用生图额度：请稍后重试，或在「账号池」页刷新额度 / 导入更多账号。";
  const limited = summary.items.filter((item) => item?.status === "限流").length;
  const exhausted = summary.items.filter((item) => Number(item?.quota) === 0).length;
  const shortage = [limited ? `${limited} 个限流` : "", exhausted ? `${exhausted} 个额度为 0` : ""].filter(Boolean);
  const restores = summary.items
    .map((item) => String(item?.restore_at || "").trim())
    .filter((value) => value && Date.parse(value) > Date.now())
    .sort();
  const head = shortage.length
    ? `号池暂时没有可用生图额度：${summary.total} 个账号中 ${shortage.join("、")}`
    : summary.ready > 0
      ? `号池暂未选中可用账号：${summary.total} 个账号中有 ${summary.ready} 个本地看似可用，但引擎校验未通过（登录态可能刚失效）`
      : `号池暂时没有可用生图额度：${summary.total} 个账号均不在可用状态`;
  const parts = [
    head,
    restores[0] ? `最早 ${restores[0]} 恢复` : "",
    "可以稍后重试，或在「账号池」页刷新额度 / 导入更多账号",
  ].filter(Boolean);
  return `${parts.join("；")}。`;
}

function briefError(text) {
  const clean = String(text || "").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  try {
    const doc = JSON.parse(clean);
    return String(doc?.detail?.error || doc?.detail?.message || doc?.error?.message || doc?.error || doc?.detail || clean).slice(0, 400);
  } catch {
    return clean.slice(0, 400);
  }
}
