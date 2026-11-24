import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_DIR, "bin", "image-pool.mjs");
const API = path.join(PLUGIN_DIR, "bin", "image-api.mjs");

function run(mode, stdin = "", extraEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-test-"));
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      RUODAO_IMAGE_POOL_DATA_DIR: dataDir,
      RUODAO_NATIVE_PORT: "39998",
      RUODAO_IMAGE_API_PORT: "59995",
      ...extraEnv,
    },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function lastJson(out) {
  return JSON.parse(out.trim().split("\n").pop());
}

test("未知模式返回失败 JSON", () => {
  const { code, out } = run("nope");
  assert.equal(code, 1);
  const body = lastJson(out);
  assert.equal(body.state, "failed");
  assert.match(body.error, /未知模式/);
});

test("清单只保留 14 个原生命令且不含旧通道文案", () => {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "ruodao-plugin.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
  const ui = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "ui.json"), "utf8"));
  assert.equal(manifest.version, "1.10.0");
  assert.equal(plugin.version, "1.10.0");
  assert.equal(ui.version, "1.10.0");
  assert.deepEqual(manifest.contributes.commands.map((item) => item.id), [
    "com.ruodao.image-pool.doctor",
    "com.ruodao.image-pool.models",
    "com.ruodao.image-pool.preferences",
    "com.ruodao.image-pool.agent-access",
    "com.ruodao.image-pool.generate",
    "com.ruodao.image-pool.usage",
    "com.ruodao.image-pool.logs",
    "com.ruodao.image-pool.images",
    "com.ruodao.image-pool.native-setup",
    "com.ruodao.image-pool.native-setup-status",
    "com.ruodao.image-pool.native-service",
    "com.ruodao.image-pool.native-accounts",
    "com.ruodao.image-pool.native-proxy",
    "com.ruodao.image-pool.native-status",
  ]);
  const removed = new Set(["setup", "repair", "repair-status", "cleanup", "setup-status", "provision", "service", "assistant", "stealth", "bind", "workers", "task", "daemon", "warmup", "accounts", "native-models", "native-generate"].map((name) => `com.ruodao.image-pool.${name}`));
  for (const item of manifest.contributes.commands) {
    assert.ok(!removed.has(item.id), `旧命令残留：${item.id}`);
  }
  const legacyTerms = /VirtualBrowser|FPBrowser2API|allinone|playwright|直驱|网关/i;
  for (const [name, text] of [
    ["ruodao-plugin.json", JSON.stringify(manifest)],
    ["plugin.json", JSON.stringify(plugin)],
    ["ui.json", JSON.stringify(ui)],
    ["README.md", readFileSync(path.join(PLUGIN_DIR, "README.md"), "utf8")],
  ]) {
    assert.ok(!legacyTerms.test(text), `${name} 仍包含旧通道文案`);
  }
});

test("CLI 不再暴露旧模式", () => {
  const source = readFileSync(CLI, "utf8");
  for (const mode of ["setup", "repair", "cleanup", "provision", "service", "assistant", "stealth", "bind", "workers", "task", "daemon", "warmup", "accounts", "native-models", "native-generate"]) {
    assert.ok(!source.includes(`mode === "${mode}"`), `CLI 仍注册旧模式：${mode}`);
  }
  for (const mode of ["doctor", "models", "preferences", "generate", "agent-access", "usage", "logs", "images", "native-setup", "native-setup-status", "native-service", "native-accounts", "native-proxy", "native-status"]) {
    assert.ok(source.includes(`mode === "${mode}"`), `CLI 缺少模式：${mode}`);
  }
});

test("doctor 离线返回结构化检查项", () => {
  const { code, out } = run("doctor");
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.ok, false);
  for (const key of ["engine", "patch", "service", "accounts", "localApi"]) {
    assert.equal(typeof body.checks[key].ok, "boolean");
    assert.ok(body.checks[key].hint);
  }
  assert.deepEqual(body.models, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
});

test("models 未安装时仍返回完整图像模型目录与 GIF 边界", () => {
  const { code, out } = run("models");
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.installed, false);
  assert.equal(body.running, false);
  assert.deepEqual(body.imageModels, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
  assert.deepEqual(body.gifModels, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
  assert.deepEqual(body.tiers, ["auto", "1k", "2k", "4k"]);
  assert.deepEqual(body.preferences, { defaultModel: "gpt-image-2.6", defaultImageTier: "auto" });
  assert.deepEqual(body.gifLimits, { minFrames: 2, maxFrames: 16, minDurationMs: 20, maxDurationMs: 2000, durationStepMs: 10 });
});

test("preferences 可保存并规范化默认模型与档位", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-prefs-"));
  const cli = (stdin) => spawnSync(process.execPath, [CLI, "preferences"], {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, RUODAO_IMAGE_POOL_DATA_DIR: dataDir, RUODAO_NATIVE_PORT: "39998", RUODAO_IMAGE_API_PORT: "59995" },
  });
  const get = JSON.parse(cli('{"action":"get"}').stdout.trim().split("\n").pop());
  assert.equal(get.state, "succeeded");
  assert.deepEqual(get.preferences, { defaultModel: "gpt-image-2.6", defaultImageTier: "auto" });
  const set = JSON.parse(cli(JSON.stringify({ action: "set", defaultModel: "gpt-image-2", defaultImageTier: "2K" })).stdout.trim().split("\n").pop());
  assert.equal(set.state, "succeeded");
  assert.deepEqual(set.preferences, { defaultModel: "gpt-image-2", defaultImageTier: "2k" });
  const bad = cli(JSON.stringify({ action: "set", defaultImageTier: "8k" }));
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout.trim().split("\n").pop()).error, /档位/);
});

test("generate 缺少 prompt 返回失败", () => {
  const { code, out } = run("generate", "{}");
  assert.equal(code, 1);
  const body = lastJson(out);
  assert.equal(body.state, "failed");
  assert.match(body.error, /缺少生图提示词/);
});

test("generate 拒绝非原生模型", () => {
  const { code, out } = run("generate", JSON.stringify({ prompt: "a cat", model: "gpt-image2-1k" }));
  assert.equal(code, 1);
  const body = lastJson(out);
  assert.equal(body.state, "failed");
  assert.match(body.error, /原生号池不支持模型/);
});

test("usage 空台账返回零统计", () => {
  const { out } = run("usage", '{"days":7}');
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.totalTasks, 0);
  assert.equal(body.byKind.image.total, 0);
});

test("logs 空台账返回空列表", () => {
  const { out } = run("logs", '{"days":7}');
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.total, 0);
  assert.deepEqual(body.rows, []);
});

test("images 空目录返回空图片库", () => {
  const { out } = run("images", '{"action":"list"}');
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.total, 0);
  assert.ok(body.token);
});

test("native-service 不支持的 action 返回失败", () => {
  const { code, out } = run("native-service", '{"action":"destroy"}');
  assert.equal(code, 1);
  const body = lastJson(out);
  assert.equal(body.state, "failed");
  assert.match(body.error, /不支持的操作/);
});

test("native-service status 离线也能返回结构化状态", () => {
  const { code, out } = run("native-service", '{"action":"status"}');
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.running, false);
  assert.equal(body.api.up, false);
  assert.match(body.api.base, /59995\/v1$/);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      const body = await res.json();
      if (predicate(res, body)) return body;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待超时：${url}`);
}

/** 假原生后端：只满足健康检查、鉴权探测与出图契约。 */
async function startFakeNative() {
  const http = await import("node:http");
  const state = { lastUrl: "", lastPayload: null };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith("/health")) return send(200, { status: "ok" });
    if (req.url.startsWith("/api/accounts")) return send(200, { items: [] });
    if (req.url === "/v1/images/generations" || req.url === "/v1/images/edits") {
      state.lastUrl = req.url;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        state.lastPayload = JSON.parse(body || "{}");
        send(200, { data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, state };
}

test("本地 API 的 /v1/images/edits 接受 OpenAI multipart 参考图", async () => {
  const backend = await startFakeNative();
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-api-edits-"));
  writeFileSync(path.join(dataDir, "api-token.txt"), "test-token-123456\n", "utf8");
  const child = spawn(process.execPath, [API], {
    env: {
      ...process.env,
      RUODAO_IMAGE_POOL_DATA_DIR: dataDir,
      RUODAO_IMAGE_API_PORT: String(port),
      RUODAO_NATIVE_PORT: String(backend.port),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, (res, body) => res.ok && body.ok);
    const form = new FormData();
    form.append("model", "gpt-image-2.6");
    form.append("prompt", "参考图改图");
    form.append("n", "1");
    form.append("image", new Blob([Buffer.from("fake-png-bytes")], { type: "image/png" }), "reference.png");
    const response = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token-123456" },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.equal(backend.state.lastUrl, "/v1/images/edits");
    assert.equal(backend.state.lastPayload.prompt, "参考图改图");
    assert.equal(backend.state.lastPayload.model, "gpt-image-2.6");
    assert.equal(backend.state.lastPayload.images.length, 1);
    assert.equal(backend.state.lastPayload.images[0].filename, "reference.png");
    const data = await response.json();
    assert.ok(data.data[0].url);
  } finally {
    child.kill();
    backend.server.close();
  }
});

test("本地生图 API 只暴露原生端点，旧 worker 路由已移除", async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-api-"));
  writeFileSync(path.join(dataDir, "api-token.txt"), "test-token-123456\n", "utf8");
  const child = spawn(process.execPath, [API], {
    env: {
      ...process.env,
      RUODAO_IMAGE_POOL_DATA_DIR: dataDir,
      RUODAO_IMAGE_API_PORT: String(port),
      RUODAO_NATIVE_PORT: "39997",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const health = await waitFor(`http://127.0.0.1:${port}/health`, (res, body) => res.ok && body.ok);
    assert.equal(health.service, "image-pool-api");
    assert.deepEqual(health.models, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
    assert.deepEqual(health.tiers, ["auto", "1k", "2k", "4k"]);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const auth = { Authorization: "Bearer test-token-123456" };
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: auth })).json();
    assert.deepEqual(models.data.map((item) => item.id), ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
    assert.equal(models.data[0].capabilities.gif, true);
    assert.equal(models.data[3].capabilities.gif, false);

    for (const legacy of ["/v1/workers", "/v1/warmup", "/v1/chat/completions", "/v1/debug/state"]) {
      const res = await fetch(`http://127.0.0.1:${port}${legacy}`, { headers: auth });
      assert.equal(res.status, 404, `${legacy} 应已移除`);
    }

    const usage = await (await fetch(`http://127.0.0.1:${port}/v1/usage?days=7`, { headers: auth })).json();
    assert.equal(usage.totalTasks, 0);

    const shutdown = await fetch(`http://127.0.0.1:${port}/v1/shutdown`, { method: "POST", headers: auth });
    assert.equal(shutdown.status, 200);
  } finally {
    child.kill();
    assert.equal(existsSync(path.join(dataDir, "api.log")), true);
  }
});

/** 假原生后端：按 mode 返回内容审核 / 上游瞬断 / 额度不足。 */
async function startFailingNative(mode) {
  const http = await import("node:http");
  const state = { mode, hits: 0 };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith("/health")) return send(200, { status: "ok" });
    if (req.url.startsWith("/api/accounts")) return send(200, { items: [] });
    if (req.url === "/v1/images/generations") {
      state.hits += 1;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (state.mode === "policy") {
          return send(500, { detail: { error: "非常抱歉，生成的图片可能违反了关于青少年与儿童形象适当描绘的防护限制。如果你认为此判断有误，请重试或修改提示语。" } });
        }
        if (state.mode === "quota") {
          return send(500, { detail: { error: "no available image quota" } });
        }
        if (state.mode === "unreachable") {
          return send(502, { error: { message: "image account upstream unreachable: proxy connection refused via 127.0.0.1:9674" } });
        }
        return send(500, { detail: { error: "Failed to perform, curl: (56) Connection closed abruptly." } });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, state };
}

test("本地 API 区分内容审核 / 额度不足 / 上游瞬断，并给出 code 与 retryable", async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-api-errors-"));
  writeFileSync(path.join(dataDir, "api-token.txt"), "test-token-123456\n", "utf8");
  const backend = await startFailingNative("policy");
  const child = spawn(process.execPath, [API], {
    env: {
      ...process.env,
      RUODAO_IMAGE_POOL_DATA_DIR: dataDir,
      RUODAO_IMAGE_API_PORT: String(port),
      RUODAO_NATIVE_PORT: String(backend.port),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const call = () => fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token-123456", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2.6", prompt: "test", autoRecoverProxy: false }),
  });
  try {
    const health = await waitFor(`http://127.0.0.1:${port}/health`, (res, body) => res.ok && body.ok);
    assert.deepEqual(health.features, ["error-codes-v1", "pool-upstream-unreachable-v1"]);

    const policy = await call();
    assert.equal(policy.status, 400);
    const policyBody = await policy.json();
    assert.equal(policyBody.error.code, "content_policy");
    assert.equal(policyBody.error.retryable, false);

    backend.state.mode = "quota";
    const quota = await call();
    assert.equal(quota.status, 503);
    const quotaBody = await quota.json();
    assert.equal(quotaBody.error.code, "pool_no_capacity");
    assert.equal(quotaBody.error.retryable, true);

    backend.state.mode = "unreachable";
    const unreachable = await call();
    assert.equal(unreachable.status, 502);
    const unreachableBody = await unreachable.json();
    assert.equal(unreachableBody.error.code, "pool_upstream_unreachable");
    assert.equal(unreachableBody.error.retryable, false);
    assert.match(unreachableBody.error.message, /无法连接 OpenAI/);

    backend.state.mode = "transient";
    backend.state.hits = 0;
    const transient = await call();
    assert.equal(transient.status, 502);
    const transientBody = await transient.json();
    assert.equal(transientBody.error.code, "upstream_transient");
    assert.equal(transientBody.error.retryable, true);
    assert.equal(backend.state.hits, 2, "上游瞬断必须重试一次");
  } finally {
    child.kill();
    backend.server.close();
  }
});
