"""账号登录工作进程：邮箱 + 密码 + 2FA 换取 ChatGPT token。

输入（stdin JSON）：
  {"source_dir": "...", "proxy": "", "verify": true,
   "accounts": [{"email": "...", "password": "...", "totp_secret": "...",
                 "access_token": "", "refresh_token": ""}]}

输出（stdout JSON）：{"ok": true, "results": [{email, ok, access_token, refresh_token,
id_token, expires_in, error}]}。token 只回到调用方内存，不落盘、不打印到日志。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

SOURCE_DIR = os.environ.get("RUODAO_NATIVE_SOURCE_DIR", "").strip()
for candidate in (Path(SOURCE_DIR), Path.cwd(), Path(__file__).resolve().parent):
    if candidate and (candidate / "utils" / "sentinel.py").is_file():
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
        break

try:
    from curl_cffi import requests
except ImportError:
    requests = None

try:
    from utils.pkce import generate_pkce
except ImportError:
    generate_pkce = None

try:
    from utils.sentinel import build_sentinel_token
except ImportError:
    build_sentinel_token = None

AUTH_BASE = "https://auth.openai.com"
TOKEN_URL = f"{AUTH_BASE}/oauth/token"
CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD"
AUTH0_CLIENT = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9"
REDIRECT_URI = "https://platform.openai.com/auth/callback"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)


def brief(value: object, limit: int = 200) -> str:
    text = str(value or "").replace("\n", " ")
    return text[:limit]


def response_detail(response) -> str:
    """提取登录接口的错误码/描述，供上层把"账号禁用"和"网络风控"区分开。"""
    data = {}
    try:
        data = response.json() if response.text else {}
    except Exception:
        data = {}
    if isinstance(data, dict):
        for key in ("error_description", "error", "code", "message", "detail"):
            value = data.get(key)
            if isinstance(value, dict):
                value = value.get("message") or value.get("code") or value.get("type")
            if value:
                return brief(value, 160)
    return brief(getattr(response, "text", ""), 160)


def jwt_payload(token: str) -> dict:
    try:
        parts = str(token or "").split(".")
        if len(parts) != 3:
            return {}
        padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except Exception:
        return {}


def totp_code(secret: str) -> str:
    cleaned = secret.replace(" ", "").upper()
    cleaned += "=" * ((8 - len(cleaned) % 8) % 8)
    key = base64.b32decode(cleaned)
    digest = hmac.new(key, struct.pack(">Q", int(time.time() // 30)), hashlib.sha1).digest()
    offset = digest[19] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{value:06d}"


def resolve_proxy(custom: str) -> str:
    if custom and custom.strip():
        return custom.strip()
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    import socket
    for port in (7890, 7897, 10809, 10808):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.15):
                return f"http://127.0.0.1:{port}"
        except OSError:
            continue
    return ""


def refresh_access_token(refresh_token: str, session) -> dict:
    response = session.post(
        TOKEN_URL,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CLIENT_ID},
        timeout=60,
    )
    data = response.json() if response.text else {}
    if response.status_code != 200 or not isinstance(data, dict) or not data.get("access_token"):
        detail = ""
        if isinstance(data, dict):
            detail = str(data.get("error_description") or data.get("error") or "")
        raise RuntimeError(f"refresh_failed_{response.status_code}{': ' + brief(detail) if detail else ''}")
    return {
        "access_token": str(data.get("access_token") or "").strip(),
        "refresh_token": str(data.get("refresh_token") or refresh_token).strip(),
        "id_token": str(data.get("id_token") or "").strip(),
    }


def password_login(email: str, password: str, totp_secret: str, session) -> dict:
    if not generate_pkce or not build_sentinel_token:
        raise RuntimeError("dependencies_missing")
    device_id = str(uuid.uuid4())
    verifier, challenge = generate_pkce()
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    params = {
        "issuer": AUTH_BASE,
        "client_id": CLIENT_ID,
        "audience": "https://api.openai.com/v1",
        "redirect_uri": REDIRECT_URI,
        "device_id": device_id,
        "screen_hint": "login_or_signup",
        "max_age": "0",
        "login_hint": email,
        "scope": "openid profile email offline_access",
        "response_type": "code",
        "response_mode": "query",
        "state": secrets.token_urlsafe(32),
        "nonce": secrets.token_urlsafe(32),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "auth0Client": AUTH0_CLIENT,
    }
    response = session.get(f"{AUTH_BASE}/api/accounts/authorize?{urlencode(params)}", headers={"user-agent": USER_AGENT}, allow_redirects=True, timeout=30)
    if response.status_code not in (200, 302):
        detail = response_detail(response)
        raise RuntimeError(f"authorize_failed_{response.status_code}{': ' + detail if detail else ''}")

    headers = {
        "accept": "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "origin": AUTH_BASE,
        "user-agent": USER_AGENT,
        "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "referer": f"{AUTH_BASE}/email-verification",
        "oai-device-id": device_id,
    }
    try:
        sentinel, sc_value = build_sentinel_token(session, device_id, "password_verify")
        headers["openai-sentinel-token"] = sentinel
        if sc_value:
            session.cookies.set("oai-sc", sc_value, domain=".openai.com")
    except Exception:
        pass
    login = session.post(f"{AUTH_BASE}/api/accounts/password/verify", headers=headers, json={"password": password}, timeout=30)
    if login.status_code != 200:
        detail = response_detail(login)
        raise RuntimeError(f"password_verify_failed_{login.status_code}{': ' + detail if detail else ''}")
    login_data = login.json() if login.text else {}
    code = auth_code(login_data.get("continue_url"))

    if not code:
        page = login_data.get("page") or {}
        if str(page.get("type") or "") == "mfa_challenge":
            payload = page.get("payload") or {}
            factor_id = payload.get("factor_id") or ((payload.get("factors") or [{}])[0].get("id") or "")
            if not factor_id:
                raise RuntimeError("mfa_challenge_no_factor_id")
            if not totp_secret:
                raise RuntimeError("mfa_challenge_requires_totp_secret")
            try:
                code_value = totp_code(totp_secret)
            except (binascii.Error, ValueError):
                raise RuntimeError("invalid_totp_secret_base32")
            mfa_headers = dict(headers)
            try:
                sentinel, sc_value = build_sentinel_token(session, device_id, "verify_mfa")
                mfa_headers["openai-sentinel-token"] = sentinel
                if sc_value:
                    session.cookies.set("oai-sc", sc_value, domain=".openai.com")
            except Exception:
                pass
            mfa_headers["referer"] = f"{AUTH_BASE}/mfa-challenge/{factor_id}"
            mfa = session.post(
                f"{AUTH_BASE}/api/accounts/mfa/verify",
                headers=mfa_headers,
                json={"id": factor_id, "type": "totp", "code": code_value},
                timeout=30,
            )
            if mfa.status_code != 200:
                detail = response_detail(mfa)
                raise RuntimeError(f"mfa_verify_failed_{mfa.status_code}{': ' + detail if detail else ''}")
            code = auth_code((mfa.json() if mfa.text else {}).get("continue_url"))

    if not code:
        page = login_data.get("page") or {}
        page_type = str(page.get("type") or "").strip()
        detail = ""
        if page:
            try:
                detail = brief(json.dumps(page.get("payload") or {}, ensure_ascii=False), 160)
            except Exception:
                detail = ""
        if not detail:
            detail = response_detail(login)
        parts = [item for item in (page_type, detail) if item]
        raise RuntimeError("no_auth_code_obtained" + (": " + ": ".join(parts) if parts else ""))

    token_response = session.post(
        f"{AUTH_BASE}/api/accounts/oauth/token",
        headers={
            "accept": "*/*",
            "auth0-client": AUTH0_CLIENT,
            "content-type": "application/json",
            "origin": "https://platform.openai.com",
            "referer": "https://platform.openai.com/",
            "user-agent": USER_AGENT,
        },
        json={"client_id": CLIENT_ID, "code_verifier": verifier, "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
        timeout=60,
    )
    if token_response.status_code != 200:
        detail = response_detail(token_response)
        raise RuntimeError(f"token_exchange_failed_{token_response.status_code}{': ' + detail if detail else ''}")
    data = token_response.json() if token_response.text else {}
    access = str(data.get("access_token") or "").strip()
    if not access:
        raise RuntimeError("empty_access_token")
    return {
        "access_token": access,
        "refresh_token": str(data.get("refresh_token") or "").strip(),
        "id_token": str(data.get("id_token") or "").strip(),
        "expires_in": data.get("expires_in"),
    }


def auth_code(continue_url: object) -> str:
    text = str(continue_url or "").strip()
    if not text or "code=" not in text:
        return ""
    query = urlparse(text).query if text.startswith("http") else text
    return str((parse_qs(query).get("code") or [""])[0]).strip()


def login(account: dict, proxy_url: str, verify: bool, force: bool = False) -> dict:
    if not requests:
        return {"ok": False, "error": "dependencies_missing"}
    email = str(account.get("email") or "").strip()
    cached_access = str(account.get("access_token") or "").strip()
    cached_refresh = str(account.get("refresh_token") or "").strip()
    expiry = jwt_payload(cached_access).get("exp")
    if not force and cached_access and isinstance(expiry, (int, float)) and expiry > time.time() + 60:
        return {"ok": True, "access_token": cached_access, "refresh_token": cached_refresh, "id_token": "", "expires_in": int(expiry - time.time()), "cached": True}

    session_kwargs = {"impersonate": "chrome110", "verify": verify}
    if proxy_url:
        session_kwargs["proxy"] = proxy_url
    session = requests.Session(**session_kwargs)
    try:
        if cached_refresh:
            try:
                token = refresh_access_token(cached_refresh, session)
                return {"ok": True, **token, "cached": True}
            except Exception:
                pass
        password = str(account.get("password") or "")
        if not password:
            return {"ok": False, "error": "refresh_failed_and_no_password"}
        return {"ok": True, **password_login(email, password, str(account.get("totp_secret") or ""), session)}
    finally:
        try:
            session.close()
        except Exception:
            pass


def main() -> None:
    if not requests:
        print(json.dumps({"ok": False, "error": "dependencies_missing", "results": []}, ensure_ascii=False))
        return
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        payload = {}
    accounts = payload.get("accounts") if isinstance(payload, dict) else None
    if not isinstance(accounts, list) or not accounts:
        print(json.dumps({"ok": False, "error": "no_valid_accounts", "results": []}, ensure_ascii=False))
        return
    proxy_url = resolve_proxy(str(payload.get("proxy") or ""))
    verify = payload.get("verify")
    if verify is None:
        verify = os.environ.get("RUODAO_NATIVE_TLS_INSECURE", "") not in ("1", "true", "yes")
    force = bool(payload.get("force")) if isinstance(payload, dict) else False
    try:
        concurrency = int(payload.get("concurrency") or 0) if isinstance(payload, dict) else 0
    except (TypeError, ValueError):
        concurrency = 0
    if concurrency <= 0:
        concurrency = 4

    valid = [item for item in accounts if isinstance(item, dict) and str(item.get("email") or "").strip()]

    def run_one(account: dict) -> dict:
        email = str(account.get("email") or "").strip()
        try:
            result = login(account, proxy_url, bool(verify), force)
        except Exception as error:
            result = {"ok": False, "error": brief(error)}
        return {"email": email, **result}

    # 每个账号持有独立 session；并发上限压到 8，避免同一出口 IP 触发风控。
    workers = max(1, min(8, concurrency, len(valid) or 1))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(run_one, valid))
    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
