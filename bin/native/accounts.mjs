/**
 * 原生号池账号：发货文本解析、OAuth/2FA 登录、导入后端、刷新与删除。
 *
 * 凭据与 token 只写入插件用户数据目录（0600）；接口与日志不出现密码 / 2FA / token，
 * 账号列表按用户要求返回完整邮箱，方便核对；后端 token 永不透出到 CLI / UI。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ensureNativeDirs, readJson, writeJson } from "./config.mjs";
import { ensureBackend, fetchJson, nativeDirs, readEngineProxy } from "./backend.mjs";
import { venvPython } from "./python.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function credentialsFile(paths) {
  return path.join(paths.root, "accounts.json");
}

export function parseCredentialText(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("===")) continue;
    const parts = line.split(/----|---|\t+|\|/).map((item) => item.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [email, password, totp = ""] = parts;
    if (!EMAIL_RE.test(email) || !password) continue;
    rows.push({ email, password, totp_secret: totp });
  }
  const seen = new Map();
  for (const row of rows) seen.set(row.email.toLowerCase(), row);
  return [...seen.values()];
}

export function readCredentials(dataDir) {
  const paths = nativeDirs(dataDir);
  const doc = readJson(credentialsFile(paths), { accounts: [] });
  const list = Array.isArray(doc?.accounts) ? doc.accounts : [];
  return { paths, accounts: list.filter((item) => item && typeof item.email === "string" && item.email.includes("@")) };
}

function saveCredentials(paths, accounts) {
  ensureNativeDirs(paths);
  writeJson(credentialsFile(paths), { updatedAt: Date.now(), accounts });
  try { fs.chmodSync(credentialsFile(paths), 0o600); } catch { /* Windows 忽略 */ }
}

export function emailHash(email) {
  return createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 12);
}

const LOGIN_ERROR_HINTS = [
  [/^authorize_failed_403\b/, "登录被 OpenAI 拒绝（403）：当前网络 IP 被风控，请先配置可用的全局代理再重试。"],
  [/^authorize_failed_5\d\d\b/, "OpenAI 登录服务暂时不可用（5xx），请稍后重试。"],
  [/^authorize_failed_/, "OpenAI 登录入口返回异常，请检查网络或代理。"],
  [/^authorize_network_error/, "无法连接 OpenAI：请检查本机网络或代理地址。"],
  [/^password_verify_failed_403/, "密码校验被拒绝（403）：代理 IP 被风控，或账号需要人工安全验证。"],
  [/^password_verify_failed_/, "密码校验失败：账号密码可能已变更。"],
  [/^refresh_failed_403/, "Token 刷新被拒绝（403）：当前网络 IP 被风控，请配置代理后重试。"],
  [/^refresh_failed_401/, "Token 已失效且无法刷新：请重新登录该账号。"],
  [/^refresh_failed_/, "Token 刷新失败：请重新登录该账号。"],
  [/^mfa_verify_failed_/, "2FA 校验失败：请检查账号的 2FA 密钥是否最新。"],
  [/^mfa_challenge_requires_totp_secret/, "账号需要 2FA，但发货文本里没有 2FA 密钥。"],
  [/^invalid_totp_secret_base32/, "2FA 密钥格式无效。"],
  [/^dependencies_missing/, "登录依赖缺失：请到「服务状态」重新安装原生号池。"],
  [/^refresh_failed_and_no_password/, "Token 已过期且没有密码，无法自动重新登录。"],
  [/^no_auth_code_obtained/, "登录流程未拿到授权码：请检查代理或账号安全验证。"],
  [/^token_exchange_failed_/, "授权码换取 Token 失败：请重试或更换代理。"],
];

export function loginErrorHint(error) {
  const text = String(error || "").trim();
  if (!text) return "";
  // curl_cffi 的代理连接失败是原始英文异常（curl: (7) ... over proxy host），
  // 不能落进 authorize_* 码，需要单独翻成可操作提示。
  const proxy = text.match(/Failed to connect to \S+ over proxy ([\w.\-\[\]:]+)/i);
  if (proxy) {
    return `无法连接代理 ${proxy[1]}：本机代理客户端未启动或端口不对，请启动代理后重试，或在下方「网络代理」里更换/清除代理。`;
  }
  if (/Failed to perform, curl:/i.test(text)) return "网络请求失败：请检查本机网络或代理是否可用。";
  const matched = LOGIN_ERROR_HINTS.find(([pattern]) => pattern.test(text));
  return matched ? matched[1] : "";
}

function imageLimits(backendItem) {
  const list = Array.isArray(backendItem?.limits_progress) ? backendItem.limits_progress : [];
  const item = list.find((entry) => entry && entry.feature_name === "image_gen");
  if (!item) return null;
  return {
    remaining: Number(item.remaining) || 0,
    resetAfter: String(item.reset_after || ""),
  };
}

const CHECK_VERDICTS = Object.freeze({
  available: "可用",
  limited: "限流",
  retryable: "暂时不可用",
  dead: "彻底不可用",
  unknown: "无法判定",
});

/** 账号是否被 OpenAI 侧停用/封禁：这类账号无法再通过密码或 2FA 恢复。 */
const DEAD_ACCOUNT_PATTERN = /(account_deactivated|account_banned|account_suspended|account_disabled|account_locked|deleted_account|invalid_account|account_not_found|user_deactivated)/i;

function checkRecord(input) {
  const verdict = String(input?.verdict || "").trim();
  return {
    verdict,
    label: CHECK_VERDICTS[verdict] || "未检测",
    reason: String(input?.reason || "").slice(0, 200),
    code: String(input?.code || "").slice(0, 160),
    at: Number(input?.at) || 0,
  };
}

/**
 * 把登录/刷新失败原因归类成四档：
 * dead = 凭据或账号本身已不可恢复（建议批量删除）；
 * retryable = 代理、网络、风控、依赖等临时问题，换个时间/节点还能恢复。
 */
export function classifyCheckError(error) {
  const code = String(error || "").trim();
  if (!code) return { verdict: "retryable", reason: "登录返回空原因，稍后重试" };
  if (DEAD_ACCOUNT_PATTERN.test(code)) {
    return { verdict: "dead", reason: "账号已被停用或封禁，无法再登录" };
  }
  if (/^password_verify_failed_/i.test(code)) {
    if (/403/.test(code)) return { verdict: "retryable", reason: "密码校验被风控（403）：代理 IP 受限或需要人工安全验证" };
    if (/429/.test(code)) return { verdict: "retryable", reason: "请求过于频繁（429），稍后重试" };
    return { verdict: "dead", reason: "邮箱或密码错误：账号密码已变更，或账号不存在" };
  }
  if (/^mfa_verify_failed_/i.test(code)) {
    if (/403/.test(code)) return { verdict: "retryable", reason: "2FA 校验被风控（403），稍后重试" };
    if (/429/.test(code)) return { verdict: "retryable", reason: "请求过于频繁（429），稍后重试" };
    return { verdict: "dead", reason: "2FA 验证码校验失败：保存的 2FA 密钥可能已失效" };
  }
  if (/^mfa_challenge_requires_totp_secret|^invalid_totp_secret_base32|^mfa_challenge_no_factor_id/i.test(code)) {
    return { verdict: "dead", reason: "缺少可用 2FA 密钥，账号无法自动登录" };
  }
  if (/^refresh_failed_and_no_password/i.test(code)) {
    return { verdict: "dead", reason: "Token 已失效且没有保存密码，无法自动恢复" };
  }
  if (/^dependencies_missing/i.test(code)) {
    return { verdict: "retryable", reason: "登录依赖缺失：请到「服务状态」重新安装原生号池" };
  }
  if (/^authorize_failed_5\d\d|^refresh_failed_5\d\d|^token_exchange_failed_5\d\d/i.test(code)) {
    return { verdict: "retryable", reason: "OpenAI 登录服务暂时不可用（5xx），稍后重试" };
  }
  if (/^authorize_failed_403|^refresh_failed_403|^password_verify_failed_403|^mfa_verify_failed_403/i.test(code)) {
    return { verdict: "retryable", reason: "登录被 OpenAI 拒绝（403）：代理 IP 被风控，请换节点后重试" };
  }
  if (/Failed to connect .* proxy|curl: \(7\)|Failed to perform, curl|authorize_network_error|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(code)) {
    return { verdict: "retryable", reason: "网络或代理不可达：请启动代理后重试" };
  }
  if (/^authorize_failed_4\d\d|^token_exchange_failed_4\d\d|^no_auth_code_obtained|^empty_access_token/i.test(code)) {
    return { verdict: "retryable", reason: "登录流程未完成（可能需要人工安全验证），稍后重试" };
  }
  return { verdict: "retryable", reason: `暂时无法验证：${code.slice(0, 120)}` };
}

function safeAccount(item, backendItem, paths) {
  const expiry = Number(item.expiresAt) || 0;
  const lastError = String(item.lastError || "").slice(0, 200);
  return {
    email: String(item.email || "").trim(),
    emailHash: emailHash(item.email),
    status: backendItem?.status || (lastError ? "登录失败" : expiry && expiry < Date.now() ? "登录过期" : "未登录"),
    type: backendItem?.type || item.type || "free",
    quota: Number(backendItem?.quota) || 0,
    restoreAt: String(backendItem?.restore_at || ""),
    limits: imageLimits(backendItem),
    imageInflight: Number(backendItem?.image_inflight) || 0,
    success: Number(backendItem?.success) || 0,
    fail: Number(backendItem?.fail) || 0,
    lastUsedAt: backendItem?.last_used_at || backendItem?.lastUsedAt || "",
    lastLoginAt: Number(item.lastLoginAt) || 0,
    lastError,
    lastErrorHint: loginErrorHint(lastError),
    lastCheck: checkRecord(item.lastCheck),
    inBackend: Boolean(backendItem),
    hasTotp: Boolean(item.totp_secret),
    hasPassword: Boolean(item.password),
    hasToken: Boolean(item.access_token || item.refresh_token),
    credentialsFile: credentialsFile(paths),
  };
}

function mergeByIdentity(existing, incoming) {
  const map = new Map(existing.map((item) => [String(item.email).toLowerCase(), item]));
  for (const item of incoming) {
    const key = String(item.email).toLowerCase();
    const current = map.get(key) || {};
    map.set(key, { ...current, ...item });
  }
  return [...map.values()];
}

export function importCredentials(dataDir, text) {
  const parsed = parseCredentialText(text);
  if (!parsed.length) throw new Error("未解析出账号：每行格式为「邮箱----密码----2FA密钥」");
  const { paths, accounts } = readCredentials(dataDir);
  const merged = mergeByIdentity(accounts, parsed.map((row) => ({ ...row, importedAt: Date.now() })));
  saveCredentials(paths, merged);
  return {
    parsed: parsed.length,
    added: merged.length - accounts.length,
    total: merged.length,
    accounts: parsed.map((row) => ({ email: row.email, emailHash: emailHash(row.email) })),
  };
}

async function backendList(backend) {
  const response = await fetchJson(`${backend.baseUrl}/api/accounts`, {
    headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 15000,
  });
  if (!response.ok) throw new Error(`读取后端账号失败（HTTP ${response.status}）`);
  return Array.isArray(response.data?.items) ? response.data.items : [];
}

async function runningBackend(dataDir) {
  try {
    return await ensureBackend(dataDir, { autoPrepare: false });
  } catch {
    return null;
  }
}

export async function listAccounts(dataDir) {
  const { paths, accounts } = readCredentials(dataDir);
  const backend = await runningBackend(dataDir);
  let backendItems = [];
  if (backend) {
    try { backendItems = await backendList(backend); } catch { /* 后端可能正在重启 */ }
  }
  const byEmail = new Map();
  for (const item of backendItems) {
    const email = String(item?.email || "").trim().toLowerCase();
    if (email) byEmail.set(email, item);
  }
  const safe = accounts.map((item) => safeAccount(item, byEmail.get(String(item.email).toLowerCase()), paths));
  const limited = safe.filter((item) => item.status === "限流");
  return {
    backend: Boolean(backend), running: Boolean(backend),
    total: safe.length, online: safe.filter((item) => item.status === "正常").length,
    limited: limited.length,
    totalQuota: safe.reduce((sum, item) => sum + item.quota, 0),
    nextRestoreAt: limited.map((item) => item.restoreAt).filter(Boolean).sort()[0] || "",
    accounts: safe,
    dataDir: paths.root,
  };
}

export function selectAccounts(accounts, refs) {
  if (!refs?.length) return accounts;
  const wanted = new Set(refs.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  return accounts.filter((item) => wanted.has(String(item.email).toLowerCase()) || wanted.has(emailHash(item.email)));
}

function runWorker(paths, payload, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const python = venvPython(paths);
    if (!fs.existsSync(python)) return reject(new Error("Python 环境不存在：请先执行「原生号池安装」"));
    const child = spawn(python, [paths.authWorker], {
      cwd: paths.source,
      env: { ...process.env, RUODAO_NATIVE_SOURCE_DIR: paths.source, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } reject(new Error(`账号登录超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-20000); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`无法启动登录进程：${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).reverse().find((item) => item.trim().startsWith("{"));
      if (!line) return reject(new Error(`账号登录失败（退出码 ${code}）：${redact(stderr).slice(-700) || "无输出"}`));
      try { resolve(JSON.parse(line)); } catch { reject(new Error("账号登录返回了无法解析的结果")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function redact(text) {
  return String(text || "").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/eyJ[a-zA-Z0-9._-]{20,}/g, "[JWT]");
}

/**
 * 登录选中账号（默认全部），把 token 导入后端并刷新资料。
 * 返回结果不含任何 token / 密码 / 2FA 密钥。
 */
export async function loginAccounts(dataDir, { emails = [], proxy = "", timeoutMs = 600000, force = false, concurrency = 0 } = {}) {
  const { paths, accounts } = readCredentials(dataDir);
  if (!accounts.length) throw new Error("号池里还没有账号：请先粘贴发货文本导入");
  const targets = selectAccounts(accounts, emails);
  if (!targets.length) throw new Error("没有匹配的账号");
  const backend = await ensureBackend(dataDir, { onProgress: () => {} });
  // 未显式传代理时复用引擎里保存的全局代理（登录、刷新额度、生图共用同一出口）。
  let effectiveProxy = String(proxy || "").trim();
  if (!effectiveProxy) {
    try {
      const saved = await readEngineProxy(backend);
      if (saved.proxy) effectiveProxy = saved.proxy;
    } catch { /* 代理配置读取失败时仍可走环境变量或直连 */ }
  }
  const payload = {
    proxy: effectiveProxy,
    force: Boolean(force),
    concurrency: Number(concurrency) || 0,
    accounts: targets.map((item) => ({
      email: item.email, password: item.password || "", totp_secret: item.totp_secret || "",
      access_token: item.access_token || "", refresh_token: item.refresh_token || "",
    })),
  };
  const result = await runWorker(paths, payload, { timeoutMs });
  if (result?.ok === false) throw new Error(`账号登录失败：${redact(result.error || "未知原因").slice(0, 300)}`);
  const results = Array.isArray(result?.results) ? result.results : [];
  const tokens = [];
  const enrolled = [];
  const updated = [];
  const byEmail = new Map(targets.map((item) => [String(item.email).toLowerCase(), { ...item }]));
  for (const item of results) {
    const key = String(item.email || "").toLowerCase();
    const current = byEmail.get(key);
    if (!current) continue;
    if (item.ok && item.access_token) {
      current.access_token = item.access_token;
      current.refresh_token = item.refresh_token || current.refresh_token || "";
      current.id_token = item.id_token || "";
      current.lastLoginAt = Date.now();
      current.lastError = "";
      const exp = Number(item.expires_in) || 0;
      current.expiresAt = exp ? Date.now() + exp * 1000 : 0;
      tokens.push(item.access_token);
      enrolled.push({
        access_token: item.access_token,
        refresh_token: current.refresh_token,
        id_token: current.id_token,
        email: current.email,
        source_type: "oauth_password_2fa",
        type: "free",
      });
    } else {
      current.lastError = String(item.error || "登录失败").slice(0, 200);
    }
    updated.push(current);
  }
  saveCredentials(paths, mergeByIdentity(accounts, updated));

  let imported = { added: 0, skipped: 0, refreshed: 0, errors: [] };
  if (enrolled.length) {
    const response = await fetchJson(`${backend.baseUrl}/api/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${backend.key}` },
      body: { tokens, accounts: enrolled },
      timeoutMs: 240000,
    });
    if (!response.ok) throw new Error(`导入后端失败（HTTP ${response.status}）：${redact(response.text).slice(0, 400)}`);
    imported = {
      added: Number(response.data?.added) || 0,
      skipped: Number(response.data?.skipped) || 0,
      refreshed: Number(response.data?.refreshed) || 0,
      errors: (Array.isArray(response.data?.errors) ? response.data.errors : []).map((item) => redact(item?.error || "").slice(0, 200)).filter(Boolean),
    };
  }
  let models = [];
  try {
    const response = await fetchJson(`${backend.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 15000 });
    models = (response.data?.data || []).map((item) => item?.id).filter(Boolean);
  } catch { /* 模型目录不是登录必需项 */ }
  const finalList = await listAccounts(dataDir);
  const failed = results.filter((item) => !item.ok);
  return {
    total: targets.length, succeeded: results.filter((item) => item.ok).length, failed: failed.length,
    results: results.map((item) => ({
      email: String(item.email || "").trim(),
      ok: Boolean(item.ok),
      error: item.ok ? "" : redact(item.error || "登录失败").slice(0, 200),
      hint: item.ok ? "" : loginErrorHint(item.error),
    })),
    imported, models, accounts: finalList.accounts,
  };
}

async function syncBackendTokens(paths, accounts, backendItems) {
  const byEmail = new Map();
  for (const item of backendItems) {
    const key = String(item?.email || "").toLowerCase();
    if (key) byEmail.set(key, item);
  }
  let changed = false;
  for (const item of accounts) {
    const remote = byEmail.get(String(item.email).toLowerCase());
    if (!remote?.access_token) continue;
    if (item.access_token !== remote.access_token || (remote.refresh_token && item.refresh_token !== remote.refresh_token)) {
      item.access_token = remote.access_token;
      item.refresh_token = remote.refresh_token || item.refresh_token;
      changed = true;
    }
  }
  if (changed) saveCredentials(paths, accounts);
}

export async function refreshAccounts(dataDir, { emails = [] } = {}) {
  const { paths, accounts } = readCredentials(dataDir);
  const backend = await ensureBackend(dataDir, { autoPrepare: false });
  const backendItems = await backendList(backend);
  const targets = selectAccounts(accounts, emails);
  const targetEmails = new Set(targets.map((item) => String(item.email).toLowerCase()));
  const tokens = backendItems
    .filter((item) => targetEmails.has(String(item.email || "").toLowerCase()) || (!emails.length && item.access_token))
    .map((item) => item.access_token).filter(Boolean);
  if (!tokens.length) throw new Error("选中的账号尚未导入后端，请先登录");
  const response = await fetchJson(`${backend.baseUrl}/api/accounts/refresh`, {
    method: "POST", headers: { Authorization: `Bearer ${backend.key}` }, body: { access_tokens: tokens }, timeoutMs: 30000,
  });
  if (!response.ok) throw new Error(`刷新失败（HTTP ${response.status}）：${redact(response.text).slice(0, 300)}`);
  const progressId = response.data?.progress_id;
  let progress = null;
  if (progressId) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const status = await fetchJson(`${backend.baseUrl}/api/accounts/refresh/progress/${encodeURIComponent(progressId)}`, {
        headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 15000,
      });
      progress = status.data || progress;
      if (progress?.done || progress?.error) break;
    }
  }
  const latest = await backendList(backend);
  await syncBackendTokens(paths, accounts, latest);
  return {
    requested: tokens.length,
    processed: Number(progress?.processed) || 0,
    done: Boolean(progress?.done),
    error: progress?.error || "",
    statusCounts: progress?.status_counts || null,
    totalQuota: Number(progress?.total_quota) || 0,
    accounts: (await listAccounts(dataDir)).accounts,
  };
}

export async function deleteAccounts(dataDir, { emails = [] } = {}) {
  const { paths, accounts } = readCredentials(dataDir);
  const targets = selectAccounts(accounts, emails);
  if (!targets.length) throw new Error("没有匹配的账号");
  const targetEmails = new Set(targets.map((item) => String(item.email).toLowerCase()));
  let removed = 0;
  const backend = await runningBackend(dataDir);
  if (backend) {
    const backendItems = await backendList(backend);
    const tokens = backendItems.filter((item) => targetEmails.has(String(item.email || "").toLowerCase())).map((item) => item.access_token).filter(Boolean);
    if (tokens.length) {
      const response = await fetchJson(`${backend.baseUrl}/api/accounts`, {
        method: "DELETE", headers: { Authorization: `Bearer ${backend.key}` }, body: { tokens }, timeoutMs: 30000,
      });
      if (!response.ok) throw new Error(`后端删除失败（HTTP ${response.status}）`);
      removed = Number(response.data?.removed) || tokens.length;
    }
  }
  saveCredentials(paths, accounts.filter((item) => !targetEmails.has(String(item.email).toLowerCase())));
  return { removed, credentialsRemoved: targets.length, accounts: (await listAccounts(dataDir)).accounts };
}

/* ---------------- 批量检测 ---------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshBackendTokens(backend, tokens, { timeoutMs = 180000 } = {}) {
  const response = await fetchJson(`${backend.baseUrl}/api/accounts/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.key}` },
    body: { access_tokens: tokens },
    timeoutMs: 30000,
  });
  if (!response.ok) throw new Error(`刷新失败（HTTP ${response.status}）：${redact(response.text).slice(0, 300)}`);
  const progressId = response.data?.progress_id;
  let progress = null;
  if (progressId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1200);
      const status = await fetchJson(`${backend.baseUrl}/api/accounts/refresh/progress/${encodeURIComponent(progressId)}`, {
        headers: { Authorization: `Bearer ${backend.key}` }, timeoutMs: 15000,
      });
      progress = status.data || progress;
      if (progress?.done || progress?.error) break;
    }
  }
  return progress;
}

/**
 * 批量检测账号是否还能用：
 * 1) 先让后端刷新 token/额度，状态正常的直接判定可用或限流；
 * 2) Token 失效、账号异常或未导入的，强制用保存的密码 + 2FA 重新登录（忽略缓存 token）；
 * 3) 按错误码区分「彻底不可用（dead）」与「暂时不可用（retryable）」并写入账号台账。
 */
export async function checkAccounts(dataDir, { emails = [], verify = true, concurrency = 4, timeoutMs = 600000 } = {}) {
  const { paths, accounts } = readCredentials(dataDir);
  if (!accounts.length) throw new Error("号池里还没有账号：请先粘贴发货文本导入");
  const targets = selectAccounts(accounts, emails);
  if (!targets.length) throw new Error("没有匹配的账号");
  const checkedAt = Date.now();
  const key = (value) => String(value || "").trim().toLowerCase();
  const decisions = new Map();
  const pending = [];
  let backend = null;
  let refreshError = "";
  let refreshProgress = null;

  try {
    backend = await ensureBackend(dataDir, { autoPrepare: false });
  } catch (error) {
    refreshError = redact(error?.message || error).slice(0, 300);
  }

  if (backend) {
    const targetEmails = new Set(targets.map((item) => key(item.email)));
    try {
      const before = await backendList(backend);
      const tokens = before
        .filter((item) => targetEmails.has(key(item.email)) && item.access_token)
        .map((item) => item.access_token);
      if (tokens.length) refreshProgress = await refreshBackendTokens(backend, tokens, { timeoutMs: Math.min(180000, Math.max(30000, Math.floor(timeoutMs / 3))) });
      const after = await backendList(backend);
      const afterBy = new Map(after.map((item) => [key(item.email), item]));
      for (const account of targets) {
        const remote = afterBy.get(key(account.email));
        if (!remote) {
          pending.push(account);
          continue;
        }
        const status = String(remote.status || "");
        if (status === "禁用") {
          decisions.set(key(account.email), { verdict: "dead", reason: "后端标记为禁用：账号已被封禁或停用", code: "status_disabled" });
        } else if (status === "正常") {
          decisions.set(key(account.email), { verdict: "available", reason: "Token 有效，账号正常可用", code: "status_ok" });
        } else if (status === "限流") {
          decisions.set(key(account.email), { verdict: "limited", reason: "Token 有效，当前限流或无额度", code: "status_limited" });
        } else {
          pending.push(account);
        }
      }
    } catch (error) {
      refreshError = redact(error?.message || error).slice(0, 300);
      pending.push(...targets);
    }
  } else {
    pending.push(...targets);
  }

  const pendingUnique = [...new Map(pending.map((item) => [key(item.email), item])).values()];
  const loginSummary = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  let loginError = "";

  if (verify) {
    const verifiable = pendingUnique.filter((account) => account.password || account.access_token || account.refresh_token);
    const missing = pendingUnique.filter((account) => !account.password && !account.access_token && !account.refresh_token);
    loginSummary.skipped = missing.length;
    for (const account of missing) {
      decisions.set(key(account.email), { verdict: "unknown", reason: "缺少密码与 Token，无法自动检测；需要重新导入发货文本", code: "missing_credentials" });
    }
    if (verifiable.length) {
      try {
        const login = await loginAccounts(dataDir, {
          // 这里拿到的是凭据原始记录（无 emailHash 字段），按邮箱选择最稳；
          // 对外部 check 入参仍支持 emailHash（selectAccounts 两者都匹配）。
          emails: verifiable.map((item) => item.email),
          force: true,
          concurrency,
          timeoutMs,
        });
        loginSummary.attempted = verifiable.length;
        loginSummary.succeeded = Number(login.succeeded) || 0;
        loginSummary.failed = Number(login.failed) || 0;
        const outcomeBy = new Map((login.results || []).map((item) => [key(item.email), item]));
        let afterLoginBy = new Map();
        try {
          const live = await runningBackend(dataDir);
          if (live) afterLoginBy = new Map((await backendList(live)).map((item) => [key(item.email), item]));
        } catch { /* 登录结果本身已足够判定 */ }
        for (const account of verifiable) {
          const outcome = outcomeBy.get(key(account.email));
          if (outcome?.ok) {
            const remote = afterLoginBy.get(key(account.email));
            if (String(remote?.status || "") === "限流") {
              decisions.set(key(account.email), { verdict: "limited", reason: "重新登录成功，当前限流或无额度", code: "relogin_ok" });
            } else {
              decisions.set(key(account.email), { verdict: "available", reason: "重新登录成功，账号可用", code: "relogin_ok" });
            }
          } else {
            const code = String(outcome?.error || "login_failed");
            const classified = classifyCheckError(code);
            decisions.set(key(account.email), {
              verdict: classified.verdict,
              reason: classified.reason,
              code: code.slice(0, 160),
              hint: outcome?.hint || loginErrorHint(code),
            });
          }
        }
      } catch (error) {
        loginError = redact(error?.message || error).slice(0, 300);
      }
    }
  }

  const results = targets.map((account) => {
    const decision = decisions.get(key(account.email)) || {
      verdict: "retryable",
      reason: loginError ? `无法验证：${loginError}` : verify ? "未完成检测，请重试" : "仅刷新未做登录验证",
      code: loginError ? "check_incomplete" : verify ? "check_incomplete" : "refresh_only",
    };
    return {
      email: String(account.email || "").trim(),
      emailHash: emailHash(account.email),
      verdict: decision.verdict,
      label: CHECK_VERDICTS[decision.verdict] || "无法判定",
      reason: String(decision.reason || "").slice(0, 200),
      hint: decision.hint || loginErrorHint(decision.code),
      code: String(decision.code || "").slice(0, 160),
      checkedAt,
    };
  });

  const latest = readCredentials(dataDir).accounts;
  const latestBy = new Map(latest.map((item) => [key(item.email), item]));
  for (const result of results) {
    const record = latestBy.get(key(result.email));
    if (!record) continue;
    record.lastCheck = { verdict: result.verdict, reason: result.reason, code: result.code, at: checkedAt };
    if (result.verdict === "available" || result.verdict === "limited") record.lastError = "";
  }
  saveCredentials(paths, latest);

  const counts = { available: 0, limited: 0, retryable: 0, dead: 0, unknown: 0 };
  for (const result of results) counts[result.verdict] = (counts[result.verdict] || 0) + 1;
  const list = await listAccounts(dataDir);
  return {
    total: results.length,
    backend: Boolean(backend),
    refreshError,
    loginError,
    refreshProgress: refreshProgress ? { processed: Number(refreshProgress.processed) || 0, done: Boolean(refreshProgress.done), error: refreshProgress.error || "" } : null,
    loginSummary,
    counts,
    deadEmails: results.filter((item) => item.verdict === "dead").map((item) => item.email),
    results,
    accounts: list.accounts,
  };
}

export async function nativeAccountAction(dataDir, input = {}) {
  const action = String(input.action || input.subcommand || "list").toLowerCase();
  if (action === "import") {
    const result = importCredentials(dataDir, input.text ?? input.content ?? input.accounts ?? "");
    if (input.login === true || input.autoLogin === true) {
      const login = await loginAccounts(dataDir, { emails: input.emails || [], proxy: input.proxy || "", timeoutMs: input.timeoutMs });
      return { action, ...result, login };
    }
    return { action, ...result };
  }
  if (action === "login") {
    return {
      action,
      ...(await loginAccounts(dataDir, {
        emails: input.emails || [],
        proxy: input.proxy || "",
        timeoutMs: input.timeoutMs,
        force: input.force === true,
        concurrency: input.concurrency,
      })),
    };
  }
  if (action === "check") {
    return {
      action,
      ...(await checkAccounts(dataDir, {
        emails: input.emails || [],
        verify: input.verify !== false,
        concurrency: input.concurrency,
        timeoutMs: input.timeoutMs,
      })),
    };
  }
  if (action === "refresh") return { action, ...(await refreshAccounts(dataDir, { emails: input.emails || [] })) };
  if (action === "delete") return { action, ...(await deleteAccounts(dataDir, { emails: input.emails || [] })) };
  if (action === "list") return { action, ...(await listAccounts(dataDir)) };
  throw new Error(`未知的账号操作：${action}（支持 import / login / check / list / refresh / delete）`);
}
