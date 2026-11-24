/**
 * 后端源码补丁：为固定版本的 chatgpt2api 补上 gpt-image-2.6 与原生 GIF，
 * 并把账号数据目录移到插件数据目录（源码更新不会清空账号）。
 *
 * 补丁使用严格锚点：上游快照不匹配时直接失败，绝不运行“半补丁”源码。
 */
import fs from "node:fs";
import path from "node:path";
import { PATCH_VERSION } from "./config.mjs";

const HEADER_PREFIX = "# RUODAO_POOL_GIF_PATCH ";
const HEADER = `${HEADER_PREFIX}${PATCH_VERSION}\n`;
const PATCHED_FILES = [
  "utils/helper.py",
  "services/protocol/conversation.py",
  "services/protocol/openai_v1_image_generations.py",
  "api/ai.py",
  "services/image_storage_service.py",
  "services/image_service.py",
  "services/openai_backend_api.py",
  "services/protocol/openai_v1_models.py",
  "services/config.py",
  "services/account_service.py",
];

/** 已补丁文件只做增量：整个文件只应用一次转换，升级版本时仅改写补丁头。 */
const ACCOUNT_RECOVERY_METHOD = `    def _recover_limited_accounts(
            self,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> int:
        """按需复核限流 / 额度为 0 的账号，避免后台刷新间隔内误报 no available image quota。"""
        if not self._quota_recovery_lock.acquire(timeout=60):
            return 0
        try:
            now = time.time()
            if now - self._last_quota_recovery_at < self._QUOTA_RECOVERY_COOLDOWN_SECONDS:
                return 1 if self._list_ready_candidate_tokens(None, plan_type, source_type, plan_types) else 0
            self._last_quota_recovery_at = now
            with self._lock:
                tokens = [
                    token
                    for account in self._accounts.values()
                    if str(account.get("status") or "") not in {"禁用", "异常"}
                       and (str(account.get("status") or "") == "限流" or int(account.get("quota") or 0) <= 0)
                       and self._account_matches_plan_type(account, plan_type)
                       and self._account_matches_any_plan_type(account, plan_types)
                       and self._account_matches_source_type(account, source_type)
                       and (token := str(account.get("access_token") or ""))
                ]
            if not tokens:
                return 0
            log_service.add(LOG_TYPE_ACCOUNT, "额度复核", {"count": len(tokens)})
            result = self.refresh_accounts(tokens, defer_invalid_removal=True)
            return max(1, int(result.get("refreshed") or 0))
        except Exception:
            return 0
        finally:
            self._quota_recovery_lock.release()

`;

const ACQUIRE_CANDIDATE_OLD = `    def _acquire_next_candidate_token(
            self,
            excluded_tokens: set[str] | None = None,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        with self._image_slot_condition:
            while True:
                if not self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types):
                    raise RuntimeError(
                        f"no available {plan_type or source_type or ''} image quota".replace("  ", " ").strip()
                        if plan_type or source_type else "no available image quota"
                    )
                tokens = self._list_available_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
                if tokens:
                    access_token = tokens[self._index % len(tokens)]
                    self._index += 1
                    self._image_inflight[access_token] = int(self._image_inflight.get(access_token, 0)) + 1
                    return access_token
                self._image_slot_condition.wait(timeout=1.0)`;

const ACQUIRE_CANDIDATE_NEW = `    def _acquire_next_candidate_token(
            self,
            excluded_tokens: set[str] | None = None,
            plan_type: str | None = None,
            source_type: str | None = None,
            plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        recovered = False
        while True:
            exhausted = False
            with self._image_slot_condition:
                if not self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types):
                    exhausted = True
                else:
                    tokens = self._list_available_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
                    if tokens:
                        access_token = tokens[self._index % len(tokens)]
                        self._index += 1
                        self._image_inflight[access_token] = int(self._image_inflight.get(access_token, 0)) + 1
                        return access_token
                    self._image_slot_condition.wait(timeout=1.0)
            if exhausted:
                # 本地额度缓存可能已过期：复核一次限流账号再重试，仍无可用才报错。
                if recovered or not self._recover_limited_accounts(plan_type=plan_type, source_type=source_type, plan_types=plan_types):
                    raise RuntimeError(
                        f"no available {plan_type or source_type or ''} image quota".replace("  ", " ").strip()
                        if plan_type or source_type else "no available image quota"
                    )
                recovered = True`;

/** v3：代理未启动 / 全池网络不可达时，不能伪装成「没有可用额度」。
 *  引擎原先在 20 次 fetch_remote_info 全部抛异常后仍报 no available image quota，
 *  插件与桌面端只能照着本地额度拼出「0 个限流、0 个额度为 0」的矛盾提示。 */
const UPSTREAM_HINTS_ANCHOR = "    _QUOTA_RECOVERY_COOLDOWN_SECONDS = 60\n";
const UPSTREAM_HINTS_BLOCK = `    _QUOTA_RECOVERY_COOLDOWN_SECONDS = 60
    _UPSTREAM_UNREACHABLE_HINTS = (
        "failed to perform", "failed to connect", "could not connect", "connection refused",
        "connection reset", "connection aborted", "proxyerror", "sslerror", "timed out", "timeout",
        "curl: (5", "curl: (6", "curl: (7", "curl: (28", "curl: (35", "curl: (52", "curl: (56",
        "enetunreach", "eai_again", "unsupported_country_region_territory",
    )
`;

const GET_TOKEN_STATE_OLD = `        max_attempts = 20  # 防止无限循环
        attempted_tokens: set[str] = set()
        for _attempt in range(max_attempts):
`;
const GET_TOKEN_STATE_NEW = `        max_attempts = 20  # 防止无限循环
        attempted_tokens: set[str] = set()
        remote_errors: list[str] = []
        remote_checked = 0
        for _attempt in range(max_attempts):
`;

const GET_TOKEN_CATCH_OLD = `            try:
                account = self.fetch_remote_info(access_token, "get_available_access_token")
            except Exception:
                self.release_image_slot(access_token)
                continue
`;
const GET_TOKEN_CATCH_NEW = `            try:
                account = self.fetch_remote_info(access_token, "get_available_access_token")
            except Exception as exc:
                remote_errors.append(str(exc))
                self.release_image_slot(access_token)
                continue
            remote_checked += 1
`;

const GET_TOKEN_RAISE_OLD = `        raise RuntimeError(
            f"no available {plan_type or source_type or ''} image quota (tried {len(attempted_tokens)} tokens)".replace("  ", " ").strip()
            if plan_type or source_type else f"no available image quota (tried {len(attempted_tokens)} tokens)"
        )
`;
const GET_TOKEN_RAISE_NEW = `        if remote_errors and not remote_checked:
            last_error = next(
                (error for error in reversed(remote_errors) if any(hint in error.lower() for hint in self._UPSTREAM_UNREACHABLE_HINTS)),
                "",
            )
            if last_error:
                proxy = ""
                marker = " over proxy "
                if marker in last_error:
                    proxy = last_error.split(marker, 1)[1].split(" ", 1)[0].strip()
                reason = "proxy connection refused" if ("could not connect" in last_error.lower() or "failed to connect" in last_error.lower()) else "network unavailable"
                raise RuntimeError(
                    f"image account upstream unreachable: {reason}{' via ' + proxy if proxy else ''}"
                )
        raise RuntimeError(
            f"no available {plan_type or source_type or ''} image quota (tried {len(attempted_tokens)} tokens)".replace("  ", " ").strip()
            if plan_type or source_type else f"no available image quota (tried {len(attempted_tokens)} tokens)"
        )
`;

function swap(text, needle, replacement, file) {
  const at = text.indexOf(needle);
  if (at === -1 || text.indexOf(needle, at + needle.length) !== -1) {
    throw new Error(`原生生图补丁锚点不匹配：${file} → ${needle.slice(0, 90).replace(/\n/g, "\\n")}`);
  }
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

function patch(file, input) {
  let text = input.replace(/\r\n/g, "\n");
  const change = (a, b) => { text = swap(text, a, b, file); };
  if (file === "utils/helper.py") {
    change('BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2"}',
      'BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2", "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}');
  }
  if (file === "services/protocol/openai_v1_models.py") {
    change('dynamic_models.add("gpt-image-2")',
      'dynamic_models.update({"gpt-image-2", "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"})');
  }
  if (file === "api/ai.py") {
    change("    history_disabled: bool = True\n    stream: bool | None = None\n",
      "    history_disabled: bool = True\n    stream: bool | None = None\n    output_format: str | None = None\n    frame_count: int | None = None\n    frame_duration_ms: int | None = None\n");
  }
  if (file === "services/protocol/openai_v1_image_generations.py") {
    change('    base_url = str(body.get("base_url") or "") or None',
      '    output_format = body.get("output_format")\n'
      + '    frame_count = body.get("frame_count")\n'
      + '    frame_duration_ms = body.get("frame_duration_ms")\n'
      + '    if output_format == "gif":\n'
      + '        if model not in {"gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}:\n'
      + '            from fastapi import HTTPException\n'
      + '            raise HTTPException(status_code=400, detail={"error":"GIF requires a GPT Image 2.6 model"})\n'
      + '        if body.get("stream"):\n'
      + '            from fastapi import HTTPException\n'
      + '            raise HTTPException(status_code=400, detail={"error":"GIF streaming is not supported"})\n'
      + '        try:\n'
      + '            frames = int(frame_count if frame_count is not None else 9)\n'
      + '            duration = int(frame_duration_ms if frame_duration_ms is not None else 200)\n'
      + '        except (TypeError, ValueError):\n'
      + '            from fastapi import HTTPException\n'
      + '            raise HTTPException(status_code=400, detail={"error":"GIF frame_count/frame_duration_ms must be integers"})\n'
      + '        if frames < 2 or frames > 16:\n'
      + '            from fastapi import HTTPException\n'
      + '            raise HTTPException(status_code=400, detail={"error":"GIF frame_count must be between 2 and 16"})\n'
      + '        if duration < 20 or duration > 2000 or duration % 10 != 0:\n'
      + '            from fastapi import HTTPException\n'
      + '            raise HTTPException(status_code=400, detail={"error":"GIF frame_duration_ms must be 20-2000 in steps of 10"})\n'
      + '    elif output_format not in (None, "png", "webp", "jpeg", "jpg"):\n'
      + '        from fastapi import HTTPException\n'
      + '        raise HTTPException(status_code=400, detail={"error":"unsupported image output_format"})\n'
      + '    base_url = str(body.get("base_url") or "") or None');
    change("        response_format=response_format,\n        base_url=base_url,",
      "        response_format=response_format,\n        output_format=output_format,\n        frame_count=frame_count,\n        frame_duration_ms=frame_duration_ms,\n        base_url=base_url,");
  }
  if (file === "services/protocol/conversation.py") {
    change('    response_format: str = "b64_json"\n    base_url: str | None = None',
      '    response_format: str = "b64_json"\n    output_format: str | None = None\n    frame_count: int | None = None\n    frame_duration_ms: int | None = None\n    base_url: str | None = None');
    change('def build_image_prompt(prompt: str, size: str | None, quality: str = "auto") -> str:',
      'def build_image_prompt(prompt: str, size: str | None, quality: str = "auto", output_format: str | None = None, frame_count: int | None = None, frame_duration_ms: int | None = None) -> str:');
    change('    if quality:\n        hints.append(f"输出图片质量为 {quality}。")\n    return f"{prompt.strip()}\\n\\n{\'\'.join(hints)}" if hints else prompt',
      '    if quality:\n        hints.append(f"输出图片质量为 {quality}。")\n'
      + '    if output_format == "gif":\n'
      + '        hints.append("生成格式为 gif 动图；输出真正的多帧动画，不要输出分镜拼图或静态帧。")\n'
      + '        if frame_count is not None:\n'
      + '            hints.append(f"frame_count: {frame_count}。")\n'
      + '        if frame_duration_ms is not None:\n'
      + '            hints.append(f"frame_duration_ms: {frame_duration_ms}。")\n'
      + '    return f"{prompt.strip()}\\n\\n{\'\'.join(hints)}" if hints else prompt');
    change('    quality: str = "auto",\n    thinking_effort: str = "",\n) -> Iterator[dict[str, Any]]:',
      '    quality: str = "auto",\n    output_format: str | None = None,\n    frame_count: int | None = None,\n    frame_duration_ms: int | None = None,\n    thinking_effort: str = "",\n) -> Iterator[dict[str, Any]]:');
    change("build_image_prompt(prompt, size, quality)) if image_model else prompt",
      "build_image_prompt(prompt, size, quality, output_format, frame_count, frame_duration_ms)) if image_model else prompt");
    change("            quality=request.quality,\n    ):\n        last = event",
      "            quality=request.quality,\n            output_format=request.output_format,\n            frame_count=request.frame_count,\n            frame_duration_ms=request.frame_duration_ms,\n    ):\n        last = event");
    change('def format_image_result(\n    items: list[dict[str, Any]],\n    prompt: str,\n    response_format: str,\n    base_url: str | None = None,\n    created: int | None = None,\n    message: str = "",',
      'def format_image_result(\n    items: list[dict[str, Any]],\n    prompt: str,\n    response_format: str,\n    base_url: str | None = None,\n    created: int | None = None,\n    message: str = "",\n    output_format: str | None = None,');
    change('        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt\n        if response_format == "b64_json":',
      '        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt\n'
      + '        if output_format == "gif" and not base64.b64decode(b64_json).startswith((b"GIF87a", b"GIF89a")):\n'
      + '            continue\n'
      + '        if response_format == "b64_json":');
    change('    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}\n    if message and not data:\n        result["message"] = message',
      '    if output_format == "gif" and not data:\n'
      + '        raise ImageGenerationError("upstream did not return an animated GIF", status_code=502)\n'
      + '    result: dict[str, Any] = {"created": created or int(time.time()), "data": data}\n'
      + '    if message and not data:\n        result["message"] = message');
    const before = text;
    text = text.replace(/(request\.base_url,\n[ \t]*int\(time\.time\(\)\),\n)([ \t]*)(\)\["data"\])/g,
      "$1$2output_format=request.output_format,\n$2$3");
    if ((before.match(/request\.base_url,\n[ \t]*int\(time\.time\(\)\),\n[ \t]*\)\["data"\]/g) || []).length !== 4) {
      throw new Error("原生生图补丁：conversation.py 的 4 个图片格式化调用点未全部命中");
    }
    change("        quality=request.quality,\n    )))\n    if not images:",
      "        quality=request.quality,\n        output_format=request.output_format,\n        frame_count=request.frame_count,\n        frame_duration_ms=request.frame_duration_ms,\n    )))\n    if not images:");
  }
  if (file === "services/openai_backend_api.py") {
    change('            quality: str = "auto",\n    ) -> Iterator[Dict[str, Any]]:',
      '            quality: str = "auto",\n            output_format: str | None = None,\n            frame_count: int | None = None,\n            frame_duration_ms: int | None = None,\n    ) -> Iterator[Dict[str, Any]]:');
    change('                "output_format": "png",\n            }],',
      '                "output_format": output_format or "png",\n'
      + '                **({"frame_count": frame_count} if output_format == "gif" and frame_count is not None else {}),\n'
      + '                **({"frame_duration_ms": frame_duration_ms} if output_format == "gif" and frame_duration_ms is not None else {}),\n'
      + '            }],');
    change('        elif base_model == CODEX_IMAGE_MODEL:',
      '        elif base_model in {"gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}:\n'
      + '            return "auto", ""\n'
      + '        elif base_model == CODEX_IMAGE_MODEL:');
  }
  if (file === "services/image_storage_service.py") {
    change('IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}',
      'IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}');
    change('        filename = f"{int(time.time())}_{file_hash}.png"',
      '        extension = ".gif" if image_data.startswith((b"GIF87a", b"GIF89a")) else ".png"\n'
      + '        filename = f"{int(time.time())}_{file_hash}{extension}"');
  }
  if (file === "services/image_service.py") {
    const old = 'media_type="image/png",';
    if (text.split(old).length - 1 !== 2) throw new Error("原生生图补丁：image_service.py 的图片 media_type 分支不是 2 个");
    text = text.replaceAll(old, 'media_type="image/gif" if str(relative_path).lower().endswith(".gif") else "image/png",');
  }
  if (file === "services/config.py") {
    change('BASE_DIR = Path(__file__).resolve().parents[1]\nDATA_DIR = BASE_DIR / "data"',
      'BASE_DIR = Path(__file__).resolve().parents[1]\n'
      + '_RUODAO_DATA_DIR = str(os.environ.get("RUODAO_NATIVE_DATA_DIR") or "").strip()\n'
      + 'DATA_DIR = Path(_RUODAO_DATA_DIR).expanduser().resolve() if _RUODAO_DATA_DIR else BASE_DIR / "data"\n'
      + 'DATA_DIR.mkdir(parents=True, exist_ok=True)');
  }
  if (file === "services/account_service.py") {
    change("    _TOKEN_REFRESH_ERROR_BACKOFF_SECONDS = 5 * 60\n",
      "    _TOKEN_REFRESH_ERROR_BACKOFF_SECONDS = 5 * 60\n    _QUOTA_RECOVERY_COOLDOWN_SECONDS = 60\n");
    change("        self._token_aliases: dict[str, str] = {}\n        self._cumulative_total = self._load_cumulative_total()\n",
      "        self._token_aliases: dict[str, str] = {}\n"
      + "        self._quota_recovery_lock = Lock()\n"
      + "        self._last_quota_recovery_at = 0.0\n"
      + "        self._cumulative_total = self._load_cumulative_total()\n");
    change("    def _acquire_next_candidate_token(\n",
      ACCOUNT_RECOVERY_METHOD + "    def _acquire_next_candidate_token(\n");
    change(ACQUIRE_CANDIDATE_OLD, ACQUIRE_CANDIDATE_NEW);
    text = applyUpstreamUnreachablePatch(text, file);
  }
  return text;
}

/** v3 增量：可以在全新源码上叠加，也可以在已打 v2 补丁的 account_service 上单独迁移。 */
function applyUpstreamUnreachablePatch(text, file) {
  let out = text;
  const change = (a, b) => { out = swap(out, a, b, file); };
  change(UPSTREAM_HINTS_ANCHOR, UPSTREAM_HINTS_BLOCK);
  change(GET_TOKEN_STATE_OLD, GET_TOKEN_STATE_NEW);
  change(GET_TOKEN_CATCH_OLD, GET_TOKEN_CATCH_NEW);
  change(GET_TOKEN_RAISE_OLD, GET_TOKEN_RAISE_NEW);
  return out;
}

export function sourcePatchStatus(sourceRoot) {
  try {
    const installed = fs.readFileSync(path.join(sourceRoot, ".ruodao-pool-gif-patch"), "utf8").trim();
    return { installed, current: installed === PATCH_VERSION };
  } catch {
    return { installed: "", current: false };
  }
}

/**
 * 幂等安装源码补丁。先把所有文件在内存里转换完成，再原子落盘；
 * 任何锚点不匹配都会中止，不会留下半补丁源码。
 */
export function installSourcePatch(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const marker = path.join(root, ".ruodao-pool-gif-patch");
  const installed = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  if (installed === PATCH_VERSION) return { version: PATCH_VERSION, files: 0, skipped: true };

  const pending = [];
  for (const rel of PATCHED_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Error(`源码缺少文件：${rel}`);
    const content = fs.readFileSync(file, "utf8");
    if (content.startsWith(HEADER_PREFIX)) {
      // 既有补丁文件只升级版本头：转换只做一次，重复套锚点会直接报错。
      // 新版本对已补丁文件的改动必须写成幂等增量迁移。
      const body = content.slice(content.indexOf("\n") + 1);
      const upgraded = rel === "services/account_service.py" && !body.includes("_UPSTREAM_UNREACHABLE_HINTS")
        ? applyUpstreamUnreachablePatch(body, rel)
        : body;
      pending.push([file, HEADER + upgraded]);
      continue;
    }
    pending.push([file, HEADER + patch(rel, content)]);
  }
  for (const [file, content] of pending) {
    const tmp = `${file}.ruodao-tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  fs.writeFileSync(marker, PATCH_VERSION + "\n", { mode: 0o600 });
  return { version: PATCH_VERSION, files: pending.length, skipped: false };
}
