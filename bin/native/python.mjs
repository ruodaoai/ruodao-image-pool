/** Python 运行时探测与隔离环境：优先系统 Python 3.13/3.12，venv + pip 安装固定依赖。 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const env = (k, d = "") => (process.env[k] ?? d).trim();
const MIN_MINOR = 10;

export const REQUIREMENTS = Object.freeze([
  "curl-cffi>=0.15.0",
  "fastapi>=0.136.0",
  "pillow>=12.2.0",
  "pybase64>=1.4.3",
  "python-multipart>=0.0.26",
  "tiktoken>=0.12.0",
  "uvicorn>=0.44.0",
  "sqlalchemy>=2.0.0",
  "psycopg2-binary>=2.9.0",
  "gitpython>=3.1.0",
]);
const CORE_REQUIREMENTS = REQUIREMENTS.filter((name) => !name.startsWith("psycopg2"));
const IMPORT_PROBE = "import importlib.util as u, json; mods=['fastapi','uvicorn','curl_cffi','PIL','pybase64','multipart','tiktoken','sqlalchemy','git']; print(json.dumps([m for m in mods if u.find_spec(m) is None]))";
const PROBE = "import sys, json; print(json.dumps({'version':'%d.%d.%d'%sys.version_info[:3],'executable':sys.executable,'venv':sys.prefix!=sys.base_prefix}))";

function probe(exe, args = []) {
  if (!exe) return null;
  try {
    const result = spawnSync(exe, [...args, "-c", PROBE], {
      encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout) return null;
    const info = JSON.parse(result.stdout.trim());
    const [major, minor] = String(info.version).split(".").map(Number);
    if (major !== 3 || !Number.isInteger(minor)) return null;
    return { ...info, major, minor };
  } catch {
    return null;
  }
}

function windowsInstalls() {
  if (process.platform !== "win32") return [];
  const found = [];
  for (const version of ["3.13", "3.12", "3.11", "3.10", "3.14"]) {
    for (const key of [
      `HKLM\\SOFTWARE\\Python\\PythonCore\\${version}\\InstallPath`,
      `HKCU\\SOFTWARE\\Python\\PythonCore\\${version}\\InstallPath`,
      `HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore\\${version}\\InstallPath`,
    ]) {
      try {
        const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        if (result.status !== 0 || !result.stdout) continue;
        const match = result.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
        if (!match) continue;
        const exe = path.join(match[1].trim(), "python.exe");
        if (fs.existsSync(exe) && !found.includes(exe)) found.push(exe);
      } catch { /* 忽略 */ }
    }
  }
  return found;
}

function launcherInstalls() {
  if (process.platform !== "win32") return [];
  try {
    const result = spawnSync("py", ["-0p"], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0 || !result.stdout) return [];
    return [...result.stdout.matchAll(/([A-Za-z]:\\[^\r\n]*?python\.exe)/gi)].map((match) => match[1].trim());
  } catch {
    return [];
  }
}

function commonInstalls() {
  const list = [];
  if (process.platform !== "win32") return list;
  for (const base of [env("LOCALAPPDATA") && path.join(env("LOCALAPPDATA"), "Programs", "Python"), "C:\\"]) {
    if (!base) continue;
    try {
      for (const entry of fs.readdirSync(base)) {
        if (!/^Python3(1[0-4])$/i.test(entry) && !/^Python3(1[0-4])-/i.test(entry)) continue;
        for (const exe of [path.join(base, entry, "python.exe"), path.join(base, entry, "install", "python.exe")]) {
          if (fs.existsSync(exe)) list.push(exe);
        }
      }
    } catch { /* 忽略 */ }
  }
  return list;
}

export function findSystemPython() {
  const configured = env("RUODAO_NATIVE_PYTHON");
  if (configured) {
    const info = probe(configured);
    if (info && info.minor >= MIN_MINOR) return { ...info, source: "configured" };
    throw new Error(`RUODAO_NATIVE_PYTHON 指向的 Python 不可用或低于 3.${MIN_MINOR}：${configured}`);
  }
  const candidates = [];
  if (process.platform === "win32") {
    for (const version of ["3.13", "3.12", "3.11", "3.10"]) candidates.push({ exe: "py", args: [`-${version}`], source: "py-launcher" });
    for (const exe of [...launcherInstalls(), ...windowsInstalls(), ...commonInstalls()]) {
      if (exe.toLowerCase().endsWith("python.exe")) candidates.push({ exe, args: [], source: "windows-install" });
    }
  }
  for (const exe of ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"]) {
    candidates.push({ exe, args: [], source: "path" });
  }
  for (const candidate of candidates) {
    const info = probe(candidate.exe, candidate.args);
    if (!info || info.minor < MIN_MINOR || info.venv) continue;
    return { ...info, source: candidate.source };
  }
  throw new Error(`未找到 Python 3.${MIN_MINOR}+。请安装 Python 3.12 或 3.13（勾选 Add to PATH），或设置 RUODAO_NATIVE_PYTHON 指向 python.exe。`);
}

export function venvPython(paths) {
  return process.platform === "win32" ? path.join(paths.venv, "Scripts", "python.exe") : path.join(paths.venv, "bin", "python");
}

export function ensureVenv(paths, { onProgress } = {}) {
  const target = venvPython(paths);
  if (fs.existsSync(target)) {
    const info = probe(target);
    if (info) return { python: target, ...info, reused: true };
    onProgress?.({ step: "python", message: "虚拟环境无法运行，正在重建" });
    fs.rmSync(paths.venv, { recursive: true, force: true });
  }
  const system = findSystemPython();
  onProgress?.({ step: "python", message: `使用 Python ${system.version}（${system.source}）创建隔离环境` });
  fs.mkdirSync(path.dirname(paths.venv), { recursive: true });
  const result = spawnSync(system.executable, ["-m", "venv", paths.venv], {
    encoding: "utf8", timeout: 180000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    cwd: paths.root,
  });
  if (result.status !== 0 || !fs.existsSync(target)) {
    fs.rmSync(paths.venv, { recursive: true, force: true });
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-900);
    throw new Error(`创建 Python 虚拟环境失败：${detail || `退出码 ${result.status}`}`);
  }
  const info = probe(target);
  if (!info) throw new Error("虚拟环境创建后无法运行，请检查 Python 安装是否完整");
  onProgress?.({ step: "python", message: `虚拟环境就绪：Python ${info.version}` });
  return { python: target, ...info, reused: false };
}

function run(command, args, { cwd, env: extraEnv, timeoutMs = 1500000, onProgress, label } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, windowsHide: true, shell: false,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let lastTick = 0;
    const receive = (chunk) => {
      output = (output + String(chunk)).slice(-14000);
      const now = Date.now();
      if (onProgress && now - lastTick > 1500) {
        lastTick = now;
        const line = String(chunk).trim().split(/\r?\n/).filter(Boolean).pop() || "";
        if (line) onProgress({ step: "deps", message: `${label || "安装依赖"}：${line.slice(-120)}` });
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error(`${label || "命令"}超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`无法执行 ${path.basename(command)}：${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(output.trim());
      reject(new Error(`${label || "命令"}失败（退出码 ${code}）：${output.slice(-1200)}`));
    });
  });
}

function missingPackages(python) {
  const result = spawnSync(python, ["-c", IMPORT_PROBE], { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

export async function ensureDeps(paths, { onProgress } = {}) {
  const python = venvPython(paths);
  const missing = missingPackages(python);
  if (Array.isArray(missing) && !missing.length) return { installed: false, missing: [] };
  const requirements = REQUIREMENTS.join("\n") + "\n";
  fs.writeFileSync(paths.requirements, requirements, "utf8");
  const indexUrl = env("RUODAO_NATIVE_PIP_INDEX", "https://mirrors.aliyun.com/pypi/simple");
  const baseArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "-r", paths.requirements];
  const commonEnv = { PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", PIP_PROGRESS_BAR: "off", PYTHONUNBUFFERED: "1" };
  onProgress?.({ step: "deps", message: `安装 Python 依赖（${missing?.length ? missing.join(", ") : "首次安装"}），首次约 2–6 分钟` });
  try {
    await run(python, [...baseArgs, "--index-url", indexUrl], {
      cwd: paths.root, env: commonEnv, onProgress, label: "安装 Python 依赖",
    });
  } catch (firstError) {
    onProgress?.({ step: "deps", message: "镜像安装失败，改用 PyPI 官方源重试" });
    try {
      await run(python, [...baseArgs, "--index-url", "https://pypi.org/simple"], {
        cwd: paths.root, env: commonEnv, onProgress, label: "安装 Python 依赖（官方源）",
      });
    } catch (secondError) {
      // psycopg2 只用于 PostgreSQL 存储；本项目使用 JSON 存储，缺它不影响生图。
      onProgress?.({ step: "deps", message: "完整依赖安装失败，尝试仅安装核心依赖（JSON 存储不需要 psycopg2）" });
      const coreFile = paths.requirements + ".core.txt";
      fs.writeFileSync(coreFile, CORE_REQUIREMENTS.join("\n") + "\n", "utf8");
      try {
        await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "-r", coreFile, "--index-url", "https://pypi.org/simple"], {
          cwd: paths.root, env: commonEnv, onProgress, label: "安装核心依赖",
        });
      } catch (thirdError) {
        throw new Error(`Python 依赖安装失败：${String(firstError.message || firstError).slice(0, 700)}；官方源：${String(secondError.message || secondError).slice(0, 700)}；核心依赖：${String(thirdError.message || thirdError).slice(0, 700)}`);
      }
    }
  }
  const remaining = missingPackages(python);
  if (Array.isArray(remaining) && remaining.length) throw new Error(`依赖安装后仍缺少：${remaining.join("、")}`);
  return { installed: true, missing: missing || [] };
}

export function runtimeSummary(paths) {
  const python = venvPython(paths);
  const info = fs.existsSync(python) ? probe(python) : null;
  return {
    ready: Boolean(info),
    python: info?.version || "",
    pythonPath: info?.executable || python,
    venv: paths.venv,
    missing: info ? missingPackages(python) : null,
  };
}
