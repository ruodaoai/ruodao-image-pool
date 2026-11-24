"""若道原生号池 ASGI 入口：在不改动上游源码的前提下提供默认模型/尺寸与状态接口。

只包装 /v1/images/generations、/v1/images/edits、/v1/responses；
显式 model / size 始终优先。其余请求原样透传。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from main import app as upstream_app

PRESET_SIZES = {
    "1:1": {"1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096"},
    "16:9": {"1k": "1920x1088", "2k": "2560x1440", "4k": "3840x2160"},
    "9:16": {"1k": "1088x1920", "2k": "1440x2560", "4k": "2160x3840"},
    "3:2": {"1k": "1536x1024", "2k": "2400x1600", "4k": "3600x2400"},
    "2:3": {"1k": "1024x1536", "2k": "1600x2400", "4k": "2400x3600"},
    "4:3": {"1k": "1365x1024", "2k": "2560x1920", "4k": "3840x2880"},
    "3:4": {"1k": "1024x1365", "2k": "1920x2560", "4k": "2880x3840"},
}
RATIO_RE = re.compile(
    r"(?:^|[^\d])(?:比例|画幅|aspect\s*ratio)?\s*"
    r"(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4)(?!\d)",
    re.IGNORECASE,
)
MAX_BUFFER_BYTES = 72 * 1024 * 1024
NATIVE_MODELS = [
    "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst",
    "gpt-image-2", "codex-gpt-image-2",
    "plus-codex-gpt-image-2", "pro-codex-gpt-image-2", "team-codex-gpt-image-2",
]
GIF_MODELS = ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]


def preferences() -> dict[str, str]:
    defaults = {"defaultModel": "gpt-image-2.6", "defaultImageTier": "auto"}
    filename = os.environ.get("RUODAO_NATIVE_PREFERENCES_FILE", "")
    if not filename:
        return defaults
    try:
        doc = json.loads(Path(filename).read_text(encoding="utf-8"))
        model = doc.get("defaultModel")
        tier = doc.get("defaultImageTier")
        if isinstance(model, str) and model in NATIVE_MODELS:
            defaults["defaultModel"] = model
        if isinstance(tier, str) and tier.lower() in ("auto", "1k", "2k", "4k"):
            defaults["defaultImageTier"] = tier.lower()
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return defaults


def effective_tier(fields: dict[str, Any], prefs: dict[str, str]) -> str:
    tier = str(fields.get("resolution") or fields.get("imageTier") or prefs["defaultImageTier"]).lower()
    return tier if tier in ("1k", "2k", "4k") else "auto"


def choose_size(fields: dict[str, Any], prefs: dict[str, str]) -> str | None:
    if fields.get("size") is not None and str(fields["size"]).strip():
        return None
    tier = effective_tier(fields, prefs)
    if tier == "auto":
        return None
    ratio = fields.get("aspect_ratio") or fields.get("aspectRatio") or ""
    ratio = str(ratio).strip()
    if not ratio:
        match = RATIO_RE.search(str(fields.get("prompt") or ""))
        ratio = re.sub(r"\s", "", match.group(1)) if match else ""
    # 选了档位却没给画幅时按 1:1，否则上游会继续按默认 1024 出图。
    return PRESET_SIZES.get(ratio or "1:1", {}).get(tier)


def choose_quality(fields: dict[str, Any], prefs: dict[str, str]) -> str | None:
    if str(fields.get("quality") or "").strip():
        return None
    return "high" if effective_tier(fields, prefs) in ("2k", "4k") else None


def apply_json_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict):
        return body
    changed = False
    if not fields.get("model"):
        fields["model"] = prefs["defaultModel"]
        changed = True
    size = choose_size(fields, prefs)
    if size:
        fields["size"] = size
        changed = True
    quality = choose_quality(fields, prefs)
    if quality:
        fields["quality"] = quality
        changed = True
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if changed else body


def apply_responses_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict) or not isinstance(fields.get("tools"), list):
        return body
    changed = False
    tools = []
    for item in fields["tools"]:
        if not isinstance(item, dict) or item.get("type") != "image_generation":
            tools.append(item)
            continue
        tool = dict(item)
        prompt_input = fields.get("input")
        prompt = prompt_input if isinstance(prompt_input, str) else str(prompt_input or "")[:12000]
        ratio_fields = {
            "prompt": prompt,
            "aspect_ratio": fields.get("aspect_ratio"),
            "resolution": tool.get("resolution") or fields.get("resolution"),
            "size": tool.get("size"),
            "quality": tool.get("quality") or fields.get("quality"),
        }
        new_size = choose_size(ratio_fields, prefs)
        if new_size:
            tool["size"] = new_size
            changed = True
        new_quality = choose_quality(ratio_fields, prefs)
        if new_quality:
            tool["quality"] = new_quality
            changed = True
        tools.append(tool)
    if changed:
        fields["tools"] = tools
        return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return body


def apply_multipart_defaults(body: bytes, content_type: str, prefs: dict[str, str]) -> bytes:
    match = re.search(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
    if not match:
        return body
    boundary = (match.group(1) or match.group(2)).encode("ascii", "ignore")
    if not boundary or len(boundary) > 200:
        return body
    marker = b"--" + boundary
    closing = marker + b"--"
    pos = body.rfind(closing)
    if pos < 0:
        return body
    parts = body[:pos].split(marker)
    fields: dict[str, str] = {}
    for part in parts:
        if not part.startswith(b"\r\n"):
            continue
        head, sep, value = part[2:].partition(b"\r\n\r\n")
        if not sep or len(head) > 8192:
            continue
        found = re.search(rb'(?im)^Content-Disposition:\s*form-data;\s*name="([a-zA-Z_]+)"', head)
        if not found or b"filename=" in head.lower():
            continue
        name = found.group(1).decode("ascii")
        if name in ("prompt", "size", "model", "quality", "resolution", "imageTier", "aspect_ratio", "aspectRatio"):
            fields[name] = value.rstrip(b"\r\n").decode("utf-8", "replace")[:12000]
    additions = {}
    if not fields.get("model"):
        additions["model"] = prefs["defaultModel"]
    size = choose_size(fields, prefs)
    if size:
        additions["size"] = size
    quality = choose_quality(fields, prefs)
    if quality:
        additions["quality"] = quality
    if not additions:
        return body
    encoded = bytearray()
    for key, value in additions.items():
        encoded.extend(marker + b'\r\nContent-Disposition: form-data; name="' + key.encode() + b'"\r\n\r\n')
        encoded.extend(value.encode() + b"\r\n")
    return body[:pos] + bytes(encoded) + body[pos:]


class ApplyImagePreferences:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("method") == "GET" and scope.get("path") in (
            "/ruodao/native/status", "/ruodao/pool-gif-status"
        ):
            from starlette.responses import JSONResponse
            response = JSONResponse({
                "enabled": True,
                "engine": "chatgpt2api-native",
                "source_commit": os.environ.get("RUODAO_NATIVE_SOURCE_COMMIT", ""),
                "models": NATIVE_MODELS,
                "default_image_tier": preferences()["defaultImageTier"],
                "gif": {
                    "models": GIF_MODELS,
                    "min_frames": 2,
                    "max_frames": 16,
                    "min_frame_duration_ms": 20,
                    "max_frame_duration_ms": 2000,
                    "frame_duration_step_ms": 10,
                    "reference_images": False,
                    "streaming": False,
                },
                "data_dir": os.environ.get("RUODAO_NATIVE_DATA_DIR", ""),
            })
            return await response(scope, receive, send)
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") not in (
            "/v1/images/generations", "/v1/images/edits", "/v1/responses"
        ):
            return await self.app(scope, receive, send)
        prefs = preferences()
        headers = list(scope.get("headers", []))
        content_type = next((v.decode("latin1") for k, v in headers if k.lower() == b"content-type"), "")
        is_json = content_type.split(";", 1)[0].strip().lower() == "application/json"
        is_form = content_type.split(";", 1)[0].strip().lower() == "multipart/form-data"
        if not is_json and not is_form:
            return await self.app(scope, receive, send)
        chunks = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > MAX_BUFFER_BYTES:
                payload = b'{"detail":{"error":"image upload exceeds 72MB limit"}}'
                await send({"type": "http.response.start", "status": 413, "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                ]})
                await send({"type": "http.response.body", "body": payload})
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        original = b"".join(chunks)
        updated = (
            apply_responses_defaults(original, prefs) if scope["path"] == "/v1/responses"
            else apply_json_defaults(original, prefs)
        ) if is_json else apply_multipart_defaults(original, content_type, prefs)
        if updated != original:
            headers = [(k, v) for k, v in headers if k.lower() != b"content-length"]
            headers.append((b"content-length", str(len(updated)).encode()))
            scope = dict(scope, headers=headers)
        handed = False

        async def single_receive():
            nonlocal handed
            if not handed:
                handed = True
                return {"type": "http.request", "body": updated, "more_body": False}
            return await receive()

        await self.app(scope, single_receive, send)


app = ApplyImagePreferences(upstream_app)
