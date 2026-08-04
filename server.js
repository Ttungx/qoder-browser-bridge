#!/usr/bin/env node
/**
 * qw-browser-bridge — 独立的浏览器 MCP Server
 *
 * 复用 QoderWork 浏览器连接器扩展（Chrome Extension V2 协议），
 * 让 Claude Code / opencode 等任意 MCP 客户端直接操控真实浏览器。
 *
 * 架构：
 *   MCP 客户端 <--stdio(JSON-RPC)--> 本进程 <--ws(/extension/v2)--> 浏览器扩展
 *   发现机制：向 %APPDATA%\<候选目录>\relay-port.json 写入本服务端口，
 *   扩展的 native messaging host 扫描到后，扩展自动连上来（支持与 QoderWork 并存）。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { WebSocketServer } = require("ws");

// ---------------- 配置 ----------------
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const PORT = Number(getArg("--port", process.env.QWBB_PORT || "18789"));
const APP_NAME = getArg("--name", "QW Browser Bridge");
const DISCOVERY_DIR =
  getArg("--discovery-dir", "") ||
  path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "QoderWork Dev");
const NO_DISCOVERY = args.includes("--no-discovery");
const INVOKE_TIMEOUT_MS = Number(getArg("--timeout", "180000"));

const log = (...a) => console.error("[bridge]", ...a);

// ---------------- 扩展会话状态 ----------------
const ext = {
  ws: null,
  info: null, // extensionInfo
  tools: null, // tools/discover 结果
  nextId: 1,
  pending: new Map(), // id -> {resolve, reject, timer, label}
  pingTimer: null,
};

function sendExt(msg) {
  if (ext.ws && ext.ws.readyState === 1) ext.ws.send(JSON.stringify(msg));
}

function callExt(method, params, label, timeoutMs = INVOKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!ext.ws || ext.ws.readyState !== 1) {
      return reject(new Error("浏览器扩展未连接（请确认浏览器已打开且连接器扩展已启用）"));
    }
    const id = ext.nextId++;
    const timer = setTimeout(() => {
      ext.pending.delete(id);
      reject(new Error(`${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    ext.pending.set(id, { resolve, reject, timer, label });
    sendExt({ id, method, params });
  });
}

function handleExtMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // 响应：{id, result} / {id, error}
  if (typeof msg.id === "number" && ext.pending.has(msg.id)) {
    const p = ext.pending.get(msg.id);
    ext.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "扩展返回错误"), { code: msg.error.code }));
    else p.resolve(msg.result);
    return;
  }

  switch (msg.method) {
    case "extensionInfo":
      ext.info = msg.params || {};
      log("扩展已连接:", JSON.stringify(ext.info));
      // 连接后立即拉取工具定义
      callExt("tools/discover", {}, "tools/discover", 10000)
        .then((r) => {
          ext.tools = (r && r.tools) || [];
          log(`已获取 ${ext.tools.length} 个浏览器工具`);
        })
        .catch((e) => log("tools/discover 失败:", e.message));
      break;
    case "pong":
      break; // 心跳响应
    case "forwardCDPEvent":
      break; // CDP 事件通知，无需处理
    default:
      log("收到未知扩展消息:", JSON.stringify(msg).slice(0, 200));
  }
}

function onExtClose() {
  log("扩展断开");
  ext.ws = null;
  ext.info = null;
  ext.tools = null;
  clearInterval(ext.pingTimer);
  ext.pingTimer = null;
  for (const [, p] of ext.pending) {
    clearTimeout(p.timer);
    p.reject(new Error("浏览器扩展连接已断开"));
  }
  ext.pending.clear();
}

// ---------------- HTTP + WebSocket 服务 ----------------
const RELAY_CAPABILITIES = [
  "v2-connection-status",
  "multi-browser-clients",
  "active-browser-client",
  "browser-client-display-name",
  "app-info-name",
  "browser-tab-handoff",
];

const httpServer = http.createServer((req, res) => {
  if (req.url === "/app/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        appName: APP_NAME,
        version: "1.0.0",
        relayCapabilities: RELAY_CAPABILITIES,
      })
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url !== "/extension/v2") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (ext.ws) {
      log("已有扩展连接，替换为新连接");
      try { ext.ws.close(); } catch {}
      onExtClose();
    }
    ext.ws = ws;
    ws.on("message", (data) => handleExtMessage(String(data)));
    ws.on("close", onExtClose);
    ws.on("error", (e) => log("WS 错误:", e.message));
    // 心跳
    clearInterval(ext.pingTimer);
    ext.pingTimer = setInterval(() => sendExt({ method: "ping" }), 20000);
  });
});

// ---------------- 发现注册（relay-port.json） ----------------
const RELAY_PORT_FILE = path.join(DISCOVERY_DIR, "relay-port.json");
function writeDiscoveryFile() {
  if (NO_DISCOVERY) return;
  try {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
    fs.writeFileSync(
      RELAY_PORT_FILE,
      JSON.stringify({ port: PORT, appName: APP_NAME, pid: process.pid, timestamp: Date.now() })
    );
    log(`已写入发现文件: ${RELAY_PORT_FILE}`);
  } catch (e) {
    log("发现文件写入失败（扩展仍可通过 fallback 端口发现）:", e.message);
  }
}
function removeDiscoveryFile() {
  if (NO_DISCOVERY) return;
  try {
    const data = JSON.parse(fs.readFileSync(RELAY_PORT_FILE, "utf-8"));
    if (data.pid === process.pid) fs.unlinkSync(RELAY_PORT_FILE);
  } catch {}
}

// ---------------- MCP stdio 层 ----------------
function mcpSend(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function waitForTools(timeoutMs = 20000) {
  if (ext.tools) return ext.tools;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (ext.tools) return ext.tools;
  }
  throw new Error(
    "等待浏览器扩展连接超时。请确认：浏览器已打开，且 QoderWork 浏览器连接器扩展已启用。"
  );
}

async function handleMcpRequest(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "qw-browser-bridge", version: "1.0.0" },
          instructions:
            "通过 QoderWork 浏览器连接器扩展控制真实浏览器。先用 tabs_context 查看标签页，tabId 需使用其中的 ID。",
        };
      case "ping":
        return {};
      case "tools/list": {
        const tools = await waitForTools();
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          })),
        };
      }
      case "tools/call": {
        const tools = await waitForTools();
        const name = params.name;
        const toolArgs = params.arguments || {};
        if (!tools.some((t) => t.name === name)) {
          return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
        }
        log(`调用 ${name}`, JSON.stringify(toolArgs).slice(0, 300));
        const result = await callExt("tools/invoke", { tool: name, arguments: toolArgs }, name);
        // 扩展返回的 result 本身就是 MCP content 结构
        if (result && Array.isArray(result.content)) {
          return { content: result.content, isError: false };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
      }
      default:
        if (id !== undefined) {
          mcpSend({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return null;
    }
  } catch (e) {
    if (method === "tools/call") {
      return { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true };
    }
    throw e;
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  // 通知类消息（无 id）不需要回复
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "notifications/initialized") log("MCP 客户端初始化完成");
    return;
  }
  try {
    const result = await handleMcpRequest(msg);
    if (result !== null && result !== undefined) {
      mcpSend({ jsonrpc: "2.0", id: msg.id, result });
    }
  } catch (e) {
    mcpSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } });
  }
});

// ---------------- 启动 ----------------
function shutdown() {
  log("退出");
  removeDiscoveryFile();
  try { sendExt({ method: "browser/release" }); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removeDiscoveryFile);

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`HTTP/WS 服务已启动: http://127.0.0.1:${PORT} (WS 路径 /extension/v2)`);
  writeDiscoveryFile();
  log("等待浏览器扩展连接...");
});
