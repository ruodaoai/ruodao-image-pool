/**
 * 本机代理发现与启动：识别常见代理客户端、扫描监听端口、按需启动客户端。
 *
 * 只处理本机（127.0.0.1）端口，不读取客户端节点配置，也不连接任何第三方服务。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const LOCAL_PROXY_HOST = "127.0.0.1";

/** 常见代理客户端的默认混合 / HTTP 端口。 */
export const COMMON_PROXY_PORTS = Object.freeze([
  9674, 9675, 9676, 7897, 7890, 7891, 7898, 10809, 10808, 1080, 2080, 12334, 8889,
]);

export const KNOWN_PROXY_CLIENTS = Object.freeze([
  {
    id: "jimmm", name: "Jimmm", exe: "Jimmm.exe", dirs: ["Jimmm"],
    paths: ["D:\\Program Files\\Jimmm\\Jimmm.exe"],
    processNames: ["Jimmm.exe"], ports: [9674, 9675, 9676],
  },
  {
    id: "clash-verge", name: "Clash Verge / Rev", exe: "Clash Verge.exe",
    dirs: ["Clash Verge", "Clash Verge Rev", "clash-verge"],
    macApps: ["Clash Verge", "Clash Verge Rev"],
    processNames: ["Clash Verge.exe"], ports: [7897, 7890, 7891],
  },
  {
    id: "mihomo-party", name: "Mihomo Party", exe: "Mihomo Party.exe", dirs: ["Mihomo Party"],
    macApps: ["Mihomo Party"], processNames: ["Mihomo Party.exe"], ports: [7897, 7890, 7891],
  },
  {
    id: "clash-for-windows", name: "Clash for Windows", exe: "Clash for Windows.exe",
    dirs: ["Clash for Windows"], processNames: ["Clash for Windows.exe"], ports: [7890, 7891],
  },
  {
    id: "v2rayn", name: "v2rayN", exe: "v2rayN.exe", dirs: ["v2rayN", "v2rayN-Core"],
    processNames: ["v2rayN.exe"], ports: [10809, 10808],
  },
  {
    id: "flclash", name: "FlClash", exe: "FlClash.exe", dirs: ["FlClash"],
    processNames: ["FlClash.exe"], ports: [7890, 7891],
  },
  {
    id: "nekoray", name: "NekoRay / NekoBox", exe: "nekoray.exe", dirs: ["NekoRay", "nekoray"],
    processNames: ["nekoray.exe"], ports: [2080],
  },
  {
    id: "hiddify", name: "Hiddify", exe: "Hiddify.exe", dirs: ["Hiddify"],
    macApps: ["Hiddify"], processNames: ["Hiddify.exe"], ports: [12334],
  },
  {
    id: "shadowsocks", name: "Shadowsocks", exe: "Shadowsocks.exe", dirs: ["Shadowsocks"],
    macApps: ["ShadowsocksX-NG"], processNames: ["Shadowsocks.exe"], ports: [1080],
  },
]);

function fileExists(target) {
  try { return fs.statSync(target).isFile() || fs.statSync(target).isDirectory(); } catch { return false; }
}

function windowsRoots() {
  return [...new Set([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    process.env.APPDATA,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "D:\\Program Files",
    "D:\\Program Files (x86)",
  ].filter(Boolean))];
}

function candidatePaths(client) {
  if (client.path) return [client.path];
  const explicit = Array.isArray(client.paths) ? client.paths : [];
  if (process.platform === "win32") {
    const fromRoots = windowsRoots()
      .flatMap((root) => (client.dirs || []).map((dir) => path.join(root, dir, client.exe)));
    return [...new Set([...explicit, ...fromRoots])];
  }
  if (process.platform === "darwin") {
    const apps = (client.macApps || client.dirs || []).map((name) => `/Applications/${name}.app`);
    return [...new Set([...explicit, ...apps])];
  }
  return [...new Set(explicit)];
}

function runningProcessNames() {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const names = String(result.stdout || "").split(/\r?\n/)
        .map((line) => (line.match(/^"([^"]+)"/) || [])[1])
        .filter(Boolean)
        .map((name) => name.toLowerCase());
      return new Set(names);
    }
    const result = spawnSync("ps", ["-A", "-o", "comm="], { encoding: "utf8", timeout: 5000 });
    const names = String(result.stdout || "").split(/\r?\n/)
      .map((line) => path.basename(line.trim()))
      .filter(Boolean)
      .map((name) => name.toLowerCase());
    return new Set(names);
  } catch {
    return new Set();
  }
}

/** 探测单个本机 TCP 端口是否有进程在监听。 */
export function probeTcpPort(port, { host = LOCAL_PROXY_HOST, timeoutMs = 450 } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return resolve(false);
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function normalizePorts(ports) {
  if (!Array.isArray(ports) || !ports.length) return [];
  return [...new Set(ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536))].slice(0, 24);
}

/** 并行扫描端口，返回按输入顺序排列的监听端口。 */
export async function scanListeningPorts(ports, options = {}) {
  const unique = normalizePorts(ports);
  const results = await Promise.all(unique.map(async (port) => [port, await probeTcpPort(port, options)]));
  return results.filter(([, listening]) => listening).map(([port]) => port);
}

function allProxyPorts(clients) {
  return [...new Set([...clients.flatMap((client) => client.ports || []), ...COMMON_PROXY_PORTS])];
}

/** 返回已安装或正在运行的代理客户端（含路径与端口线索）。 */
export function listProxyClients({ clients = KNOWN_PROXY_CLIENTS, inspectProcesses = true } = {}) {
  const running = inspectProcesses ? runningProcessNames() : new Set();
  return clients
    .map((client) => {
      const installedPath = candidatePaths(client).find(fileExists) || "";
      const isRunning = (client.processNames || []).some((name) => running.has(String(name).toLowerCase()));
      if (!installedPath && !isRunning) return null;
      return {
        id: client.id,
        name: client.name,
        installed: Boolean(installedPath),
        running: isRunning,
        path: installedPath,
        ports: client.ports || [],
      };
    })
    .filter(Boolean);
}

/**
 * 扫描本机代理：客户端安装/运行状态 + 监听端口 + 候选地址。
 * ports / clients 可注入，便于测试。
 */
export async function discoverLocalProxies({ ports, clients = KNOWN_PROXY_CLIENTS, inspectProcesses = true } = {}) {
  const foundClients = listProxyClients({ clients, inspectProcesses });
  const scanned = normalizePorts(ports);
  const portList = scanned.length ? scanned : allProxyPorts(clients);
  const listening = await scanListeningPorts(portList);
  const candidates = listening.map((port) => ({ port, url: `http://${LOCAL_PROXY_HOST}:${port}` }));
  const details = [];
  for (const client of foundClients) {
    details.push(`${client.name}${client.installed ? "已安装" : ""}${client.running ? "·运行中" : ""}`);
  }
  if (candidates.length) details.push(`端口 ${candidates.map((item) => `${LOCAL_PROXY_HOST}:${item.port}`).join(" / ")} 可连接`);
  return {
    clients: foundClients,
    ports: listening,
    candidates,
    suggested: candidates[0]?.url || "",
    summary: details.length ? details.join("；") : "未检测到常见代理客户端或代理端口",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动本机代理客户端并等待端口就绪。只接受发现到的客户端对象，不执行任意命令。
 */
export async function launchProxyClient(client, { ports, waitMs = 30000, pollMs = 600 } = {}) {
  if (!client?.path) throw new Error(`${client?.name || "代理客户端"} 未找到启动程序，请手动打开客户端后再试`);
  if (process.platform === "win32" && !client.path.toLowerCase().endsWith(".exe")) {
    throw new Error("只能自动启动 .exe 代理客户端；请手动打开代理客户端");
  }
  const command = process.platform === "darwin" && client.path.endsWith(".app") ? "open" : client.path;
  const args = command === "open" ? ["-a", client.path] : (Array.isArray(client.args) ? client.args : []);
  const pid = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (error) => reject(new Error(`启动 ${client.name} 失败：${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(child.pid || 0); });
  });
  const probePorts = normalizePorts(ports).length ? normalizePorts(ports) : (client.ports || []);
  const deadline = Date.now() + Math.max(1000, Number(waitMs) || 30000);
  while (Date.now() < deadline) {
    const listening = await scanListeningPorts(probePorts);
    if (listening.length) return { launched: true, pid, listening, timedOut: false };
    await delay(pollMs);
  }
  return { launched: true, pid, listening: [], timedOut: true };
}
