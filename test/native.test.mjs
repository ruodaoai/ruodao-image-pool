import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import net from "node:net";

const NATIVE_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin", "native");
const CLI = path.join(path.dirname(NATIVE_DIR), "image-pool.mjs");

async function nativeModule(name) {
  return import(pathToFileURL(path.join(NATIVE_DIR, name)).href);
}

function run(mode, stdin = "", extraEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-"));
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      RUODAO_IMAGE_POOL_DATA_DIR: dataDir,
      RUODAO_NATIVE_PORT: "39999",
      ...extraEnv,
    },
  });
  return { code: res.status, out: res.stdout, err: res.stderr, dataDir };
}

function lastJson(out) {
  return JSON.parse(out.trim().split("\n").pop());
}

test("原生模型目录与引擎白名单一致（2.6 三件套 + gpt-image-2 + Codex）", async () => {
  const config = await nativeModule("config.mjs");
  const index = await nativeModule("index.mjs");
  assert.deepEqual(config.NATIVE_MODELS, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
  assert.deepEqual(config.COMPAT_MODELS, ["gpt-image-2"]);
  assert.deepEqual(config.IMAGE_MODELS, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
  assert.deepEqual(config.ENGINE_IMAGE_MODELS, [
    "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2",
    "codex-gpt-image-2", "plus-codex-gpt-image-2", "pro-codex-gpt-image-2", "team-codex-gpt-image-2",
  ]);
  for (const model of config.NATIVE_MODELS) assert.ok(config.isNativeModel(model));
  assert.ok(!config.isNativeModel("gpt-image-2.5"));
  assert.ok(!config.isKnownImageModel("gpt-image-2.5"));
  assert.ok(!config.isEngineImageModel("gpt-image-2.5-flare"));
  assert.ok(config.isEngineImageModel("team-codex-gpt-image-2"));
  assert.ok(!config.isEngineImageModel("gpt-image-3"));
  assert.deepEqual(config.IMAGE_TIERS, ["auto", "1k", "2k", "4k"]);
  assert.equal(index.normalizeImageTier("2K"), "2k");
  assert.equal(index.normalizeImageTier("8k"), "auto");
  const entries = index.nativeModelEntries();
  assert.deepEqual(entries.map((item) => item.id), [...config.IMAGE_MODELS]);
  assert.equal(entries[0].capabilities.gif, true);
  assert.equal(entries[3].capabilities.gif, false);
  const dynamicEntries = index.nativeModelEntries(["plus-codex-gpt-image-2", "gpt-image-2.5-experimental", "gpt-4o"]);
  assert.deepEqual(dynamicEntries.map((item) => item.id), [...config.IMAGE_MODELS, "plus-codex-gpt-image-2"]);
  assert.deepEqual(entries[0].capabilities.tiers, ["auto", "1k", "2k", "4k"]);
  assert.deepEqual(config.GIF_LIMITS, { minFrames: 2, maxFrames: 16, minDurationMs: 20, maxDurationMs: 2000, durationStepMs: 10 });
});

test("GIF 参数校验：默认值、上下界与 10ms 步长", async () => {
  const { validateGifOptions } = await nativeModule("images.mjs");
  assert.deepEqual(validateGifOptions({}), { frameCount: 9, frameDurationMs: 200 });
  assert.deepEqual(validateGifOptions({ frame_count: 2, frame_duration_ms: 20 }), { frameCount: 2, frameDurationMs: 20 });
  assert.deepEqual(validateGifOptions({ frameCount: 16, frameDurationMs: 2000 }), { frameCount: 16, frameDurationMs: 2000 });
  for (const frames of [1, 17, 2.5, "x"]) {
    assert.throws(() => validateGifOptions({ frame_count: frames }), /帧数/);
  }
  for (const duration of [10, 2010, 25, "x"]) {
    assert.throws(() => validateGifOptions({ frame_duration_ms: duration }), /每帧时长/);
  }
});

test("图片格式识别覆盖 GIF87a/GIF89a/PNG/JPEG/WEBP", async () => {
  const { detectImageFormat } = await nativeModule("images.mjs");
  assert.equal(detectImageFormat(Buffer.from("GIF89a")), "gif");
  assert.equal(detectImageFormat(Buffer.from("GIF87a")), "gif");
  assert.equal(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(detectImageFormat(Buffer.from("RIFF0000WEBP", "latin1")), "webp");
  assert.equal(detectImageFormat(Buffer.from("not-an-image")), "");
});

test("源码镜像固定到同一提交，ZIP 名称可复现", async () => {
  const source = await nativeModule("source.mjs");
  const config = await nativeModule("config.mjs");
  assert.match(source.sourceZipName(), /^chatgpt2api-[0-9a-f]{40}\.zip$/);
  assert.ok(source.sourceZipName().includes(config.SOURCE_COMMIT));
  const mirrors = source.sourceMirrors();
  assert.ok(mirrors.length >= 4);
  for (const url of mirrors) assert.ok(url.includes(config.SOURCE_COMMIT));
});

test("CLI models 在未安装时仍返回模型清单", () => {
  const { code, out } = run("models");
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.installed, false);
  assert.equal(body.running, false);
  assert.deepEqual(body.imageModels, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2"]);
  assert.deepEqual(body.gifModels, ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
});

test("CLI native-status 空目录返回未安装且不抛错", () => {
  const { code, out } = run("native-status");
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.source.ready, false);
  assert.equal(body.running, false);
  assert.equal(body.source.commit, "92dd80e91543157d36a4ddad60e765c5293760e9");
  assert.equal(body.setup.status, "idle");
});

test("CLI native-accounts 导入后返回完整邮箱，密码与 2FA 不落返回值", () => {
  const text = "pool.user@example.com----SUPERSECRET----JBSWY3DPEHPK3PXP";
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-accounts-"));
  const env = { RUODAO_IMAGE_POOL_DATA_DIR: dataDir, RUODAO_NATIVE_PORT: "39999" };
  const imported = run("native-accounts", JSON.stringify({ action: "import", text }), env);
  assert.equal(imported.code, 0);
  const importBody = lastJson(imported.out);
  assert.equal(importBody.state, "succeeded");
  assert.equal(importBody.total, 1);
  assert.equal(importBody.accounts[0].email, "pool.user@example.com");
  assert.ok(!JSON.stringify(importBody).includes("SUPERSECRET"));
  assert.ok(!JSON.stringify(importBody).includes("JBSWY3DPEHPK3PXP"));

  const file = path.join(dataDir, "native", "accounts.json");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /SUPERSECRET/);

  const listed = run("native-accounts", JSON.stringify({ action: "list" }), env);
  assert.equal(listed.code, 0);
  const listBody = lastJson(listed.out);
  assert.equal(listBody.backend, false);
  assert.equal(listBody.accounts[0].email, "pool.user@example.com");
  assert.equal(listBody.totalQuota, 0);
  assert.equal(listBody.limited, 0);
  assert.ok(!JSON.stringify(listBody).includes("SUPERSECRET"));
  assert.ok(!JSON.stringify(listBody).includes("JBSWY3DPEHPK3PXP"));
});

test("CLI native-setup-status 空目录返回 idle 进度", () => {
  const { code, out } = run("native-setup-status");
  assert.equal(code, 0);
  const body = lastJson(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.setup.status, "idle");
});

const TINY_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function runAsync(mode, stdin, extraEnv, existingDataDir = "") {
  const dataDir = existingDataDir || mkdtempSync(path.join(tmpdir(), "image-pool-native-e2e-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, mode], {
      env: { ...process.env, RUODAO_IMAGE_POOL_DATA_DIR: dataDir, ...extraEnv },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => resolve({ code, out, err, dataDir }));
    child.stdin.end(stdin);
  });
}

/** 假后端：模拟 chatgpt2api 的健康、鉴权、模型与出图响应，验证插件侧契约。 */
async function startFakeBackend() {
  const http = await import("node:http");
  const state = {
    lastUrl: "", lastPayload: null, proxy: "",
    accounts: [{ email: "pool.user@example.com", status: "正常", type: "free", quota: 12, access_token: "tok-pool" }],
    lastRefreshTokens: [],
  };
  const readJsonBody = (req, callback) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => callback(JSON.parse(body || "{}")));
  };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith("/health")) return send(200, { status: "ok", accounts: { total: 1, active: 1 } });
    if (req.url === "/api/accounts/refresh" && req.method === "POST") {
      return readJsonBody(req, (payload) => {
        state.lastRefreshTokens = Array.isArray(payload.access_tokens) ? payload.access_tokens : [];
        send(200, { progress_id: "fake-refresh" });
      });
    }
    if (req.url.startsWith("/api/accounts/refresh/progress/")) {
      const counts = { "正常": 0, "限流": 0, "异常": 0, "禁用": 0 };
      for (const account of state.accounts) counts[account.status] = (counts[account.status] || 0) + 1;
      return send(200, { total: state.accounts.length, processed: state.accounts.length, done: true, status_counts: counts, total_quota: 0 });
    }
    if (req.url === "/api/accounts" && req.method === "DELETE") {
      return readJsonBody(req, (payload) => {
        const tokens = new Set(Array.isArray(payload.tokens) ? payload.tokens : []);
        const before = state.accounts.length;
        state.accounts = state.accounts.filter((item) => !tokens.has(item.access_token));
        send(200, { removed: before - state.accounts.length, items: state.accounts });
      });
    }
    if (req.url.startsWith("/api/accounts")) return send(200, { items: state.accounts });
    if (req.url === "/api/settings") {
      if (req.method === "GET") return send(200, { config: { proxy: state.proxy } });
      return readJsonBody(req, (payload) => {
        state.proxy = String(payload.proxy || "");
        send(200, { config: { proxy: state.proxy } });
      });
    }
    if (req.url === "/api/proxy/test") {
      return readJsonBody(req, (payload) => {
        const candidate = String(payload.url || state.proxy || "");
        if (!candidate) {
          return send(200, { result: { ok: false, status: 0, latency_ms: 0, has_proxy: false, proxy_source: "direct", error: "no active proxy configured" } });
        }
        if (candidate.includes("blocked")) {
          return send(200, { result: { ok: true, status: 403, latency_ms: 30, has_proxy: true, proxy_source: "input", error: null } });
        }
        send(200, { result: { ok: true, status: 200, latency_ms: 12, has_proxy: true, proxy_source: payload.url ? "input" : "global", error: null } });
      });
    }
    if (req.url === "/v1/models") {
      return send(200, { data: [{ id: "plus-codex-gpt-image-2" }, { id: "gpt-image-2.5-experimental" }, { id: "gpt-4o" }, { id: "gpt-image-2.6" }] });
    }
    if (req.url === "/v1/images/generations" || req.url === "/v1/images/edits") {
      state.lastUrl = req.url;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        state.lastPayload = payload;
        if (String(payload.prompt || "").includes("quota-error")) {
          return send(429, { detail: { error: "no available image quota (tried 3 tokens)" } });
        }
        if (String(payload.prompt || "").includes("proxy-down")) {
          return send(502, { error: { message: "image account upstream unreachable: proxy connection refused via 127.0.0.1:9674" } });
        }
        const wantsGif = payload.output_format === "gif";
        const isStaticTest = String(payload.prompt || "").includes("static");
        if (wantsGif && isStaticTest) return send(200, { data: [{ b64_json: TINY_PNG }] });
        return send(200, { data: [{ b64_json: wantsGif ? TINY_GIF : TINY_PNG }] });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, state };
}

test("generate GIF：返回真实 GIF 字节并落盘、记账", async () => {
  const { server, port, state } = await startFakeBackend();
  try {
    const { code, out, dataDir } = await runAsync("generate",
      JSON.stringify({ prompt: "一只橘猫飞行员", model: "gpt-image-2.6", output_format: "gif", frame_count: 4, frame_duration_ms: 120 }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.state, "succeeded");
    assert.equal(body.mode, "native");
    assert.equal(body.outputFormat, "gif");
    assert.deepEqual(body.gif, { frameCount: 4, frameDurationMs: 120 });
    assert.equal(state.lastPayload.size, "auto");
    assert.match(body.imagePath, /\.gif$/);
    assert.ok(existsSync(body.imagePath));
    const bytes = readFileSync(body.imagePath);
    assert.equal(detectGifHeader(bytes), true);
    const ledger = readFileSync(path.join(dataDir, "usage.jsonl"), "utf8");
    assert.match(ledger, /"kind":"image"/);
    assert.match(ledger, /"state":"completed"/);
  } finally {
    server.close();
  }
});

test("generate 支持兼容模型 gpt-image-2、档位、比例与参考图转发", async () => {
  const { server, port, state } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({
        prompt: "参考图改图", model: "gpt-image-2", resolution: "2k", aspect_ratio: "16:9",
        images: [`data:image/png;base64,${TINY_PNG}`],
      }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.state, "succeeded");
    assert.equal(body.model, "gpt-image-2");
    assert.equal(state.lastUrl, "/v1/images/edits");
    assert.equal(state.lastPayload.resolution, "2k");
    assert.equal(state.lastPayload.aspect_ratio, "16:9");
    assert.equal(state.lastPayload.images.length, 1);
  } finally {
    server.close();
  }
});

test("CLI models 只合并引擎白名单内的动态模型", async () => {
  const { server, port } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("models", "", { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.ok(body.imageModels.includes("plus-codex-gpt-image-2"));
    assert.ok(!body.imageModels.includes("gpt-image-2.5-experimental"));
    assert.ok(!body.imageModels.includes("gpt-4o"));
  } finally {
    server.close();
  }
});

test("generate 显式 auto 档位会透传，避免被默认档位覆盖", async () => {
  const { server, port, state } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({ prompt: "auto cat", model: "gpt-image-2.6", resolution: "auto" }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    assert.equal(lastJson(out).state, "succeeded");
    assert.equal(state.lastPayload.resolution, "auto");
    assert.equal(state.lastPayload.size, undefined);
  } finally {
    server.close();
  }
});

test("未显式传档位时使用保存的默认画质，并把尺寸与 quality 一起发给引擎", async () => {
  const { server, port, state } = await startFakeBackend();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-quality-"));
  mkdirSync(path.join(dataDir, "native"), { recursive: true });
  writeFileSync(path.join(dataDir, "native", "preferences.json"), JSON.stringify({ defaultImageTier: "2k" }));
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({ prompt: "高清猫咪", model: "gpt-image-2.6" }),
      { RUODAO_NATIVE_PORT: String(port) }, dataDir);
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.resolution, "2k");
    assert.equal(body.size, "2048x2048");
    assert.equal(state.lastPayload.resolution, "2k");
    assert.equal(state.lastPayload.size, "2048x2048");
    assert.equal(state.lastPayload.quality, "high");
    const meta = JSON.parse(readFileSync(`${body.imagePath}.json`, "utf8"));
    assert.equal(meta.resolution, "2k");
    assert.equal(meta.quality, "high");
    assert.equal(meta.width, 1);
    assert.equal(meta.height, 1);
    assert.equal(body.images[0].width, 1);
  } finally {
    server.close();
  }
});

test("默认画质为 4K 时从提示词推断画幅，显式 auto 仍可单次覆盖", async () => {
  const { server, port, state } = await startFakeBackend();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-quality-"));
  mkdirSync(path.join(dataDir, "native"), { recursive: true });
  writeFileSync(path.join(dataDir, "native", "preferences.json"), JSON.stringify({ defaultImageTier: "4k" }));
  try {
    const portrait = await runAsync("generate",
      JSON.stringify({ prompt: "竖版 2:3 游戏角色立绘", model: "gpt-image-2.6" }),
      { RUODAO_NATIVE_PORT: String(port) }, dataDir);
    assert.equal(portrait.code, 0);
    assert.equal(state.lastPayload.size, "2400x3600");
    assert.equal(state.lastPayload.quality, "high");

    const auto = await runAsync("generate",
      JSON.stringify({ prompt: "auto cat", model: "gpt-image-2.6", resolution: "auto" }),
      { RUODAO_NATIVE_PORT: String(port) }, dataDir);
    assert.equal(auto.code, 0);
    assert.equal(lastJson(auto.out).state, "succeeded");
    assert.equal(state.lastPayload.resolution, "auto");
    assert.equal(state.lastPayload.size, undefined);
    assert.equal(state.lastPayload.quality, undefined);
  } finally {
    server.close();
  }
});

test("显式 quality 透传，非法画质直接拒绝", async () => {
  const { server, port, state } = await startFakeBackend();
  try {
    const { code } = await runAsync("generate",
      JSON.stringify({ prompt: "low quality", model: "gpt-image-2.6", quality: "low" }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    assert.equal(state.lastPayload.quality, "low");
    const bad = run("generate", JSON.stringify({ prompt: "x", quality: "ultra" }));
    assert.equal(bad.code, 1);
    assert.match(lastJson(bad.out).error, /画质/);
  } finally {
    server.close();
  }
});

test("尺寸换算与图片像素识别（PNG / GIF）", async () => {
  const { detectImageSize } = await nativeModule("images.mjs");
  const config = await nativeModule("config.mjs");
  assert.equal(config.sizeForTier("2k", "16:9"), "2560x1440");
  assert.equal(config.sizeForTier("4k", "2:3"), "2400x3600");
  assert.equal(config.sizeForTier("auto", "1:1"), "");
  assert.equal(config.qualityForTier("2k"), "high");
  assert.equal(config.qualityForTier("1k"), "");
  const png = Buffer.from(TINY_PNG, "base64");
  const gif = Buffer.from(TINY_GIF, "base64");
  assert.deepEqual(detectImageSize(png), { width: 1, height: 1 });
  assert.deepEqual(detectImageSize(gif), { width: 1, height: 1 });
});

test("generate 拒绝不支持的模型、非法档位与比例，GIF 仅限 2.6", () => {
  const cases = [
    [{ prompt: "x", model: "gpt-image-2.5-sunburst" }, /2\.5/],
    [{ prompt: "x", model: "gpt-image-2.5-experimental" }, /2\.5/],
    [{ prompt: "x", model: "gpt-image-3" }, /原生号池不支持模型/],
    [{ prompt: "x", model: "gpt-image-2.6", resolution: "8k" }, /分辨率档位/],
    [{ prompt: "x", model: "gpt-image-2.6", aspect_ratio: "21:9" }, /画幅比例/],
    [{ prompt: "x", model: "gpt-image-2", output_format: "gif" }, /GIF 只支持/],
  ];
  for (const [payload, pattern] of cases) {
    const { code, out } = run("generate", JSON.stringify(payload));
    assert.equal(code, 1, JSON.stringify(payload));
    assert.match(lastJson(out).error, pattern);
  }
});

test("generate 请求 GIF 但上游返回静态图时拒绝保存", async () => {
  const { server, port } = await startFakeBackend();
  try {
    const { code, out, dataDir } = await runAsync("generate",
      JSON.stringify({ prompt: "static cat", model: "gpt-image-2.6", output_format: "gif" }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 1);
    const body = lastJson(out);
    assert.equal(body.state, "failed");
    assert.match(body.error, /没有返回 GIF/);
    const ledger = readFileSync(path.join(dataDir, "usage.jsonl"), "utf8");
    assert.match(ledger, /"state":"failed"/);
  } finally {
    server.close();
  }
});

test("generate 遇到引擎无额度时返回可操作中文提示，且只报未来恢复时间", async () => {
  const { server, port, state } = await startFakeBackend();
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const later = new Date(Date.now() + 3 * 3600_000).toISOString();
  state.accounts = [
    { email: "a@example.com", status: "限流", type: "free", quota: 0, restore_at: later },
    { email: "b@example.com", status: "限流", type: "free", quota: 0, restore_at: soon },
    { email: "c@example.com", status: "限流", type: "free", quota: 0, restore_at: "2020-01-01T00:00:00Z" },
  ];
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({ prompt: "quota-error cat", model: "gpt-image-2.6" }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 1);
    const body = lastJson(out);
    assert.equal(body.state, "failed");
    assert.match(body.error, /号池暂时没有可用生图额度/);
    assert.match(body.error, /3 个账号中 3 个限流/);
    assert.ok(body.error.includes(soon), body.error);
    assert.ok(!body.error.includes("2020-01-01T00:00:00Z"), "过期的恢复时间不应再展示");
  } finally {
    server.close();
  }
});

test("generate 遇到账号有额度但代理不可达时给出代理恢复指引，而不是报无额度", async () => {
  const { server, port } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({ prompt: "proxy-down cat", model: "gpt-image-2.6", autoRecoverProxy: false }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 1);
    const body = lastJson(out);
    assert.equal(body.state, "failed");
    assert.match(body.error, /无法连接 OpenAI/);
    assert.match(body.error, /代理端口拒绝连接/);
    assert.match(body.error, /127\.0\.0\.1:9674/);
    assert.match(body.error, /网络代理/);
    assert.doesNotMatch(body.error, /号池暂时没有可用生图额度|0 个限流/);
  } finally {
    server.close();
  }
});

test("generate 静态图默认保存 PNG", async () => {
  const { server, port } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("generate",
      JSON.stringify({ prompt: "一只橘猫", model: "gpt-image-2.6" }),
      { RUODAO_NATIVE_PORT: String(port) });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.outputFormat, "png");
    assert.match(body.imagePath, /\.png$/);
  } finally {
    server.close();
  }
});

test("登录错误映射为可操作中文提示", async () => {
  const { loginErrorHint } = await nativeModule("accounts.mjs");
  assert.match(loginErrorHint("authorize_failed_403"), /代理/);
  assert.match(loginErrorHint("refresh_failed_401"), /重新登录/);
  assert.match(loginErrorHint("mfa_verify_failed_401"), /2FA/);
  assert.match(loginErrorHint("dependencies_missing"), /重新安装/);
  const proxyDown = loginErrorHint("Failed to perform, curl: (7) Failed to connect to auth.openai.com:443 over proxy 127.0.0.1 after 0 ms: Could not connect to server.");
  assert.match(proxyDown, /无法连接代理 127\.0\.0\.1/);
  assert.match(proxyDown, /启动代理/);
  assert.match(loginErrorHint("Failed to perform, curl: (28) Operation timed out"), /网络/);
  assert.equal(loginErrorHint("some_unknown_error"), "");
});

test("单账号重新登录按 emailHash 精确选择账号", async () => {
  const { selectAccounts, emailHash } = await nativeModule("accounts.mjs");
  const list = [{ email: "a@example.com", password: "1" }, { email: "b@example.com", password: "2" }];
  assert.deepEqual(selectAccounts(list, [emailHash("b@example.com")]).map((item) => item.email), ["b@example.com"]);
  assert.deepEqual(selectAccounts(list, []).map((item) => item.email), ["a@example.com", "b@example.com"]);
  assert.deepEqual(selectAccounts(list, ["not-a-hash"]), []);
});

test("旧版 2.5 默认模型会被规范化，也不能再保存", async () => {
  const { readPreferences, writePreferences } = await nativeModule("backend.mjs");
  const { nativePaths } = await nativeModule("config.mjs");
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-prefs-"));
  assert.throws(() => writePreferences(dataDir, { defaultModel: "gpt-image-2.5" }), /支持列表/);
  const paths = nativePaths(dataDir);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.preferences, JSON.stringify({ defaultModel: "gpt-image-2.5-sunburst", defaultImageTier: "2k" }));
  assert.deepEqual(readPreferences(dataDir), { defaultModel: "gpt-image-2.6", defaultImageTier: "2k" });
});

test("native-proxy 读取、保存、测试并在返回值中脱敏", async () => {
  const { server, port, state } = await startFakeBackend();
  const env = { RUODAO_NATIVE_PORT: String(port) };
  try {
    const initial = await runAsync("native-proxy", JSON.stringify({ action: "get" }), env);
    assert.equal(initial.code, 0);
    assert.equal(lastJson(initial.out).configured, false);

    const saved = await runAsync("native-proxy", JSON.stringify({ action: "set", url: "http://127.0.0.1:7897" }), env);
    assert.equal(saved.code, 0);
    assert.equal(lastJson(saved.out).configured, true);
    assert.equal(state.proxy, "http://127.0.0.1:7897");

    const masked = await runAsync("native-proxy", JSON.stringify({ action: "set", url: "http://user:secret@127.0.0.1:7897" }), env);
    assert.equal(masked.code, 0);
    const maskedBody = lastJson(masked.out);
    assert.equal(maskedBody.configured, true);
    assert.ok(!JSON.stringify(maskedBody).includes("secret"));
    assert.match(maskedBody.proxy, /\*\*\*/);

    const tested = await runAsync("native-proxy", JSON.stringify({ action: "test" }), env);
    assert.equal(tested.code, 0);
    assert.equal(lastJson(tested.out).result.ok, true);
    assert.equal(lastJson(tested.out).result.blocked, false);

    const blocked = await runAsync("native-proxy", JSON.stringify({ action: "test", url: "http://blocked.local:7890" }), env);
    assert.equal(blocked.code, 0);
    const blockedResult = lastJson(blocked.out).result;
    assert.equal(blockedResult.ok, true);
    assert.equal(blockedResult.blocked, true);
    assert.match(blockedResult.hint, /风控/);

    const invalid = await runAsync("native-proxy", JSON.stringify({ action: "set", url: "not a proxy" }), env);
    assert.equal(invalid.code, 1);
    assert.match(lastJson(invalid.out).error, /格式无效/);
  } finally {
    server.close();
  }
});

async function listenTcp() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

test("native-proxy discover 发现本机监听端口并给出候选地址", async () => {
  const { server, port } = await listenTcp();
  try {
    const { code, out } = await runAsync("native-proxy",
      JSON.stringify({ action: "discover", ports: [port], clients: [], inspectProcesses: false }),
      { RUODAO_IMAGE_POOL_PROXY_TEST: "1", RUODAO_NATIVE_PORT: "39999" });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.state, "succeeded");
    assert.deepEqual(body.ports, [port]);
    assert.deepEqual(body.candidates, [{ port, url: `http://127.0.0.1:${port}` }]);
    assert.match(body.summary, /可连接/);
  } finally {
    server.close();
  }
});

test("launchProxyClient 启动客户端并等待端口就绪", async () => {
  const { launchProxyClient } = await nativeModule("proxy.mjs");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const script = path.join(mkdtempSync(path.join(tmpdir(), "image-pool-proxy-launch-")), "fake-proxy.mjs");
  writeFileSync(script, 'import net from "node:net";\nnet.createServer().listen(Number(process.argv[2]), "127.0.0.1");\n');
  const result = await launchProxyClient(
    { id: "fake", name: "Fake", path: process.execPath, args: [script, String(port)], ports: [port] },
    { ports: [port], waitMs: 8000, pollMs: 100 },
  );
  try {
    assert.equal(result.launched, true);
    assert.deepEqual(result.listening, [port]);
    assert.equal(result.timedOut, false);
  } finally {
    if (result.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(result.pid), "/T", "/F"], { windowsHide: true });
      else try { process.kill(result.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
});

test("native-proxy auto 检测到可用本机代理后自动保存", async () => {
  const { server, port } = await listenTcp();
  const { server: backend, port: backendPort, state } = await startFakeBackend();
  try {
    const { code, out } = await runAsync("native-proxy",
      JSON.stringify({ action: "auto", ports: [port], clients: [], inspectProcesses: false }),
      { RUODAO_NATIVE_PORT: String(backendPort), RUODAO_IMAGE_POOL_PROXY_TEST: "1" });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.outcome, "saved");
    assert.equal(body.configured, true);
    assert.equal(body.proxy, `http://127.0.0.1:${port}`);
    assert.equal(state.proxy, `http://127.0.0.1:${port}`);
    assert.ok(body.steps.some((step) => step.id === "save" && step.status === "ok"));
    assert.ok(!JSON.stringify(body).includes("secret"));
  } finally {
    server.close();
    backend.close();
  }
});

test("native-proxy auto 当前代理可用时不改动配置", async () => {
  const { server, port } = await listenTcp();
  const { server: backend, port: backendPort, state } = await startFakeBackend();
  state.proxy = `http://127.0.0.1:${port}`;
  try {
    const { code, out } = await runAsync("native-proxy",
      JSON.stringify({ action: "auto", ports: [port], clients: [], inspectProcesses: false }),
      { RUODAO_NATIVE_PORT: String(backendPort), RUODAO_IMAGE_POOL_PROXY_TEST: "1" });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.outcome, "ok");
    assert.equal(body.proxy, `http://127.0.0.1:${port}`);
    assert.ok(!body.steps.some((step) => step.id === "save"));
    assert.match(body.message, /无需修改/);
  } finally {
    server.close();
    backend.close();
  }
});

test("native-proxy auto 在号池未启动时仍返回本机代理线索", async () => {
  const { server, port } = await listenTcp();
  try {
    const { code, out } = await runAsync("native-proxy",
      JSON.stringify({ action: "auto", ports: [port], clients: [], inspectProcesses: false }),
      { RUODAO_NATIVE_PORT: "39996", RUODAO_IMAGE_POOL_PROXY_TEST: "1" });
    assert.equal(code, 0);
    const body = lastJson(out);
    assert.equal(body.outcome, "engine-offline");
    assert.ok(body.candidates.includes(`http://127.0.0.1:${port}`));
    assert.match(body.message, /启动号池/);
  } finally {
    server.close();
  }
});

test("ensureBackend 返回 baseUrl，账号导入后能读回后端状态", async () => {
  const { server, port } = await startFakeBackend();
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-merge-"));
  const env = { RUODAO_NATIVE_PORT: String(port) };
  try {
    const imported = await runAsync("native-accounts",
      JSON.stringify({ action: "import", text: "pool.user@example.com----SECRET----JBSWY3DPEHPK3PXP" }), env, dataDir);
    assert.equal(imported.code, 0);

    const listed = await runAsync("native-accounts", JSON.stringify({ action: "list" }), env, dataDir);
    assert.equal(listed.code, 0);
    const body = lastJson(listed.out);
    assert.equal(body.backend, true);
    assert.equal(body.accounts[0].inBackend, true);
    assert.equal(body.accounts[0].status, "正常");
    assert.equal(body.accounts[0].email, "pool.user@example.com");
    assert.equal(body.accounts[0].quota, 12);
    assert.equal(body.totalQuota, 12);
    assert.equal(body.limited, 0);
    assert.ok(!JSON.stringify(body).includes("SECRET"));
  } finally {
    server.close();
  }
});

test("登录失败原因分为彻底不可用与临时问题", async () => {
  const accounts = await nativeModule("accounts.mjs");
  const dead = [
    "password_verify_failed_401",
    "mfa_verify_failed_401",
    "mfa_challenge_requires_totp_secret",
    "refresh_failed_and_no_password",
    "password_verify_failed_400: account_deactivated",
  ];
  for (const code of dead) assert.equal(accounts.classifyCheckError(code).verdict, "dead", code);
  const retryable = [
    "password_verify_failed_403",
    "authorize_failed_403",
    "refresh_failed_503",
    "authorize_network_error",
    "Failed to perform, curl: (7) Failed to connect over proxy 127.0.0.1:7897",
    "dependencies_missing",
    "no_auth_code_obtained: account_security_challenge",
  ];
  for (const code of retryable) assert.equal(accounts.classifyCheckError(code).verdict, "retryable", code);
});

test("批量检测写入可用性，批量删除同时清理本地凭据与后端 token", async () => {
  const { server, port, state } = await startFakeBackend();
  state.accounts = [
    { email: "pool.user@example.com", status: "正常", type: "free", quota: 12, access_token: "tok-pool" },
    { email: "dead.user@example.com", status: "禁用", type: "free", quota: 0, access_token: "tok-dead" },
    { email: "limited.user@example.com", status: "限流", type: "free", quota: 0, access_token: "tok-limited" },
  ];
  const dataDir = mkdtempSync(path.join(tmpdir(), "image-pool-native-check-"));
  const env = { RUODAO_NATIVE_PORT: String(port) };
  try {
    const text = [
      "pool.user@example.com----SECRET----JBSWY3DPEHPK3PXP",
      "dead.user@example.com----SECRET----JBSWY3DPEHPK3PXP",
      "limited.user@example.com----SECRET----JBSWY3DPEHPK3PXP",
    ].join("\n");
    const imported = await runAsync("native-accounts", JSON.stringify({ action: "import", text }), env, dataDir);
    assert.equal(imported.code, 0);

    const checked = await runAsync("native-accounts", JSON.stringify({ action: "check" }), env, dataDir);
    assert.equal(checked.code, 0);
    const body = lastJson(checked.out);
    assert.equal(body.state, "succeeded");
    assert.deepEqual(body.counts, { available: 1, limited: 1, retryable: 0, dead: 1, unknown: 0 });
    assert.deepEqual(body.deadEmails, ["dead.user@example.com"]);
    assert.deepEqual(state.lastRefreshTokens.sort(), ["tok-dead", "tok-limited", "tok-pool"]);
    const verdicts = Object.fromEntries(body.results.map((item) => [item.email, item.verdict]));
    assert.equal(verdicts["pool.user@example.com"], "available");
    assert.equal(verdicts["limited.user@example.com"], "limited");
    assert.equal(verdicts["dead.user@example.com"], "dead");

    const listed = lastJson((await runAsync("native-accounts", JSON.stringify({ action: "list" }), env, dataDir)).out);
    const deadAccount = listed.accounts.find((item) => item.email === "dead.user@example.com");
    assert.equal(deadAccount.lastCheck.verdict, "dead");
    assert.match(deadAccount.lastCheck.reason, /封禁|停用/);

    const hashes = listed.accounts.filter((item) => item.email !== "pool.user@example.com").map((item) => item.emailHash);
    const deleted = lastJson((await runAsync("native-accounts", JSON.stringify({ action: "delete", emails: hashes }), env, dataDir)).out);
    assert.equal(deleted.state, "succeeded");
    assert.equal(deleted.credentialsRemoved, 2);
    assert.equal(deleted.removed, 2);
    assert.deepEqual(state.accounts.map((item) => item.email), ["pool.user@example.com"]);
    const after = lastJson((await runAsync("native-accounts", JSON.stringify({ action: "list" }), env, dataDir)).out);
    assert.deepEqual(after.accounts.map((item) => item.email), ["pool.user@example.com"]);
  } finally {
    server.close();
  }
});

function detectGifHeader(bytes) {
  const head = bytes.subarray(0, 6).toString("latin1");
  return head === "GIF87a" || head === "GIF89a";
}
