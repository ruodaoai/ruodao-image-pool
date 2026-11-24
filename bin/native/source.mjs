/** 固定提交源码的获取：本地 ZIP / 本地目录 / GitHub 官方与镜像下载。 */
import fs from "node:fs";
import path from "node:path";
import { extractZipSafe } from "./archive.mjs";
import { SOURCE_COMMIT } from "./config.mjs";

const env = (k, d = "") => (process.env[k] ?? d).trim();
const REQUIRED = ["pyproject.toml", "main.py", "api/ai.py", "services/config.py", "utils/helper.py"];

export function sourceZipName() {
  return `chatgpt2api-${SOURCE_COMMIT}.zip`;
}

export function sourceMirrors() {
  const list = [];
  const configured = env("RUODAO_NATIVE_SOURCE_URL");
  if (configured) list.push(configured);
  list.push(
    `https://gh-proxy.com/https://github.com/basketikun/chatgpt2api/archive/${SOURCE_COMMIT}.zip`,
    `https://codeload.github.com/basketikun/chatgpt2api/zip/${SOURCE_COMMIT}`,
    `https://ghfast.top/https://github.com/basketikun/chatgpt2api/archive/${SOURCE_COMMIT}.zip`,
    `https://ghproxy.net/https://github.com/basketikun/chatgpt2api/archive/${SOURCE_COMMIT}.zip`,
  );
  return [...new Set(list)];
}

export function sourceValid(dir) {
  return Boolean(dir) && REQUIRED.every((rel) => fs.existsSync(path.join(dir, rel)));
}

export function readSourceCommit(paths) {
  try { return fs.readFileSync(paths.marker, "utf8").trim(); } catch { return ""; }
}

async function downloadToFile(url, dest, { timeoutMs = 180000, onProgress } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  try { fs.rmSync(part, { force: true }); } catch { /* 清理旧分片 */ }
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") || 0);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > 80 * 1024 * 1024) throw new Error("源码下载超过 80MB，已中止");
      chunks.push(Buffer.from(chunk));
      if (onProgress && total) onProgress(Math.round((received / total) * 100));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100 * 1024) throw new Error("下载内容异常（文件过小）");
    if (buffer.subarray(0, 2).toString("latin1") !== "PK") throw new Error("下载内容不是 ZIP");
    fs.writeFileSync(part, buffer);
    fs.renameSync(part, dest);
    return dest;
  } catch (error) {
    try { fs.rmSync(part, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
}

async function acquireZip(paths, { sourceZip, onProgress } = {}) {
  const explicit = sourceZip || env("RUODAO_NATIVE_SOURCE_ZIP");
  if (explicit && fs.existsSync(explicit)) return { zip: explicit, source: "local-zip" };
  const cached = path.join(paths.downloads, sourceZipName());
  if (fs.existsSync(cached)) {
    const head = fs.readFileSync(cached).subarray(0, 2).toString("latin1");
    if (head === "PK") return { zip: cached, source: "cache" };
    try { fs.rmSync(cached, { force: true }); } catch { /* 忽略 */ }
  }
  const errors = [];
  for (const url of sourceMirrors()) {
    onProgress?.({ step: "download", message: `下载固定版本源码：${new URL(url).host}` });
    try {
      await downloadToFile(url, cached, { onProgress: (percent) => onProgress?.({ step: "download", message: `源码下载 ${percent}%`, percent }) });
      return { zip: cached, source: url };
    } catch (error) {
      errors.push(`${new URL(url).host}: ${error.message}`);
      onProgress?.({ step: "download", message: `镜像失败，换下一个：${new URL(url).host}` });
    }
  }
  throw new Error(`源码下载失败（已尝试 ${errors.length} 个地址）：${errors.join("；")}。可设置 RUODAO_NATIVE_SOURCE_ZIP 指向本地源码 ZIP，或 RUODAO_NATIVE_SOURCE_DIR 指向已解压源码目录。`);
}

function backupExistingSource(paths, onProgress) {
  if (!fs.existsSync(paths.source)) return;
  if (!fs.readdirSync(paths.source).length) { fs.rmSync(paths.source, { recursive: true, force: true }); return; }
  const backup = `${paths.source}.bak-${Date.now()}`;
  fs.renameSync(paths.source, backup);
  onProgress?.({ step: "source", message: `旧源码已备份到 ${path.basename(backup)}` });
  for (const entry of fs.readdirSync(path.dirname(paths.source))) {
    if (entry.startsWith("source.bak-") && path.join(path.dirname(paths.source), entry) !== backup) {
      try { fs.rmSync(path.join(path.dirname(paths.source), entry), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
}

function copySourceInto(paths, fromDir, onProgress) {
  backupExistingSource(paths, onProgress);
  fs.mkdirSync(paths.source, { recursive: true, mode: 0o700 });
  fs.cpSync(fromDir, paths.source, { recursive: true, force: true });
  fs.writeFileSync(paths.marker, SOURCE_COMMIT + "\n", { mode: 0o600 });
}

/**
 * 确保源码就绪。优先复用已解压且提交一致的源码；
 * 其次使用本地目录 / 本地 ZIP；最后按镜像顺序下载固定提交。
 */
export async function ensureSource(paths, { sourceDir, sourceZip, onProgress } = {}) {
  if (sourceValid(paths.source) && readSourceCommit(paths) === SOURCE_COMMIT) {
    return { reused: true, source: paths.source, commit: SOURCE_COMMIT };
  }

  const localDir = sourceDir || env("RUODAO_NATIVE_SOURCE_DIR");
  if (localDir) {
    if (!sourceValid(localDir)) throw new Error(`本地源码目录不完整（需要 ${REQUIRED.join("、")}）：${localDir}`);
    if (path.resolve(localDir) !== path.resolve(paths.source)) {
      onProgress?.({ step: "source", message: `使用本地源码目录：${localDir}` });
      copySourceInto(paths, localDir, onProgress);
    } else {
      fs.writeFileSync(paths.marker, SOURCE_COMMIT + "\n", { mode: 0o600 });
    }
    return { reused: false, source: paths.source, commit: SOURCE_COMMIT, local: true };
  }

  const archive = await acquireZip(paths, { sourceZip, onProgress });
  const temp = path.join(paths.root, "unpack-source");
  fs.rmSync(temp, { recursive: true, force: true });
  try {
    onProgress?.({ step: "source", message: "解压源码归档" });
    extractZipSafe(archive.zip, temp);
    const expected = path.join(temp, `chatgpt2api-${SOURCE_COMMIT}`);
    const rootDir = fs.existsSync(expected)
      ? expected
      : fs.readdirSync(temp, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => path.join(temp, item.name))[0];
    if (!rootDir || !sourceValid(rootDir)) throw new Error("源码归档内容不完整");
    copySourceInto(paths, rootDir, onProgress);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { reused: false, source: paths.source, commit: SOURCE_COMMIT };
}
