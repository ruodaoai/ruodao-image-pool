import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_DIR, "bin", "image-pool.mjs");

function dataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "image-pool-ledger-"));
  mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

function seed(dir) {
  const now = Date.now();
  const rows = [
    { ts: now - 1000, kind: "image", source: "native", account: "native-pool", model: "gpt-image-2.6", state: "completed", elapsedMs: 90000, prompt: "一只猫", imagePath: path.join(dir, "images", "a.png") },
    { ts: now - 2000, kind: "image", source: "native", account: "native-pool", model: "gpt-image-2.6", state: "failed", elapsedMs: 60000, prompt: "一只狗", error: "生成超时" },
    { ts: now - 3000, kind: "image", source: "native", account: "native-pool", model: "gpt-image-2.6-flare", state: "completed", elapsedMs: 30000, prompt: "GIF 心跳", outputFormat: "gif" },
  ];
  writeFileSync(path.join(dir, "usage.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(path.join(dir, "images", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, "images", "a.png.json"), JSON.stringify({ ts: now, prompt: "一只猫", model: "gpt-image-2.6", elapsedMs: 90000 }), "utf8");
  return dir;
}

function run(mode, stdin, dir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, RUODAO_IMAGE_POOL_DATA_DIR: dir, ...extraEnv },
  });
  const lines = String(res.stdout || "").trim().split("\n").filter(Boolean);
  return { code: res.status, body: JSON.parse(lines[lines.length - 1] || "{}") };
}

test("usage 按类型/模型/账号与天数聚合", () => {
  const dir = seed(dataDir());
  const { body } = run("usage", '{"days":30}', dir);
  assert.equal(body.state, "succeeded");
  assert.equal(body.totalTasks, 3);
  assert.equal(body.generated, 2);
  assert.equal(body.failed, 1);
  assert.equal(body.byKind.image.total, 3);
  assert.equal(body.byKind.image.generated, 2);
  assert.equal(body.byModel["gpt-image-2.6"].total, 2);
  assert.equal(body.byModel["gpt-image-2.6-flare"].total, 1);
  assert.equal(body.byAccount["native-pool"].total, 3);
  assert.equal(body.errors[0].message, "生成超时");
});

test("logs 支持按状态/关键词过滤并倒序", () => {
  const dir = seed(dataDir());
  const all = run("logs", '{"days":30}', dir).body;
  assert.equal(all.total, 3);
  assert.equal(all.rows[0].ts >= all.rows[1].ts, true);
  const failed = run("logs", '{"days":30,"state":"failed"}', dir).body;
  assert.equal(failed.total, 1);
  assert.match(failed.rows[0].error, /超时/);
  const keyword = run("logs", '{"days":30,"q":"猫"}', dir).body;
  assert.equal(keyword.total, 1);
  assert.equal(keyword.rows[0].prompt, "一只猫");
});

test("images 列表带提示词与大小，delete 后消失", () => {
  const dir = seed(dataDir());
  const list = run("images", "{}", dir).body;
  assert.equal(list.state, "succeeded");
  assert.equal(list.total, 1);
  assert.equal(list.items[0].prompt, "一只猫");
  assert.ok(list.items[0].size > 0);
  assert.match(list.items[0].url, /\/images\/a\.png$/);
  const del = run("images", '{"action":"delete","file":"a.png"}', dir).body;
  assert.equal(del.state, "succeeded");
  assert.equal(run("images", "{}", dir).body.total, 0);
  assert.equal(existsSync(path.join(dir, "images", "a.png.json")), false);
});

test("图片保存目录可指向独立目录（RUDAO_IMAGE_POOL_IMAGES_DIR）", () => {
  const dir = dataDir();
  const custom = mkdtempSync(path.join(tmpdir(), "image-pool-images-"));
  writeFileSync(path.join(custom, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(custom, "b.png.json"), JSON.stringify({ ts: Date.now(), prompt: "自定义目录", model: "gpt-image-2.6" }), "utf8");
  const list = run("images", "{}", dir, { RUDAO_IMAGE_POOL_IMAGES_DIR: custom }).body;
  assert.equal(list.state, "succeeded");
  assert.equal(list.imagesDir, custom);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].file, "b.png");
  assert.equal(list.items[0].path, path.join(custom, "b.png"));
  const del = run("images", '{"action":"delete","file":"b.png"}', dir, { RUDAO_IMAGE_POOL_IMAGES_DIR: custom }).body;
  assert.equal(del.state, "succeeded");
  assert.equal(existsSync(path.join(custom, "b.png")), false);
  assert.equal(existsSync(path.join(dir, "images", "b.png")), false);
});
