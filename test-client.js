// 端到端测试：spawn server.js，走 MCP stdio 全流程
const { spawn } = require("child_process");
const path = require("path");

const srv = spawn("node", [path.join(__dirname, "server.js")], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const waiters = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    console.log("\n===== RESPONSE id=" + msg.id + " =====");
    console.log(JSON.stringify(msg, null, 1).slice(0, 1800));
    if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const p = new Promise((r) => waiters.set(id, r));
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("=== initialize ===");
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("=== tools/list ===");
  const list = await send("tools/list", {});
  const tools = (list.result && list.result.tools) || [];
  console.log("工具数:", tools.length, "| 名称:", tools.map((t) => t.name).join(", "));

  console.log("=== tabs_context ===");
  const tc = await send("tools/call", { name: "tabs_context", arguments: {} });
  const text = tc.result?.content?.[0]?.text || "";
  console.log("tabs:", text.slice(0, 300));

  console.log("=== tabs_create_mcp（新建空白标签页）===");
  const created = await send("tools/call", { name: "tabs_create_mcp", arguments: {} });
  const createdText = created.result?.content?.[0]?.text || "";
  console.log("created:", createdText.slice(0, 200));
  const m = createdText.match(/\[(\d+)\]/) || text.match(/\[(\d+)\]/);
  if (!m) { console.log("没有可用标签页，退出"); process.exit(1); }
  const tabId = Number(m[1]);

  console.log("=== navigate 到 example.com ===");
  const nav = await send("tools/call", { name: "navigate", arguments: { url: "https://example.com", tabId } });
  console.log("nav result:", JSON.stringify(nav.result?.content?.[0]?.text || nav.result).slice(0, 200));

  console.log("=== get_page_text ===");
  const txt = await send("tools/call", { name: "get_page_text", arguments: { tabId } });
  console.log("page text:", JSON.stringify(txt.result?.content?.[0]?.text || "").slice(0, 200));

  console.log("=== screenshot ===");
  const shot = await send("tools/call", { name: "computer", arguments: { action: "screenshot", tabId } });
  const content = shot.result?.content || [];
  console.log("screenshot content blocks:", content.map((c) => c.type + (c.data ? `(${Math.round(c.data.length / 1024)}KB)` : "")).join(", "));

  console.log("\n### 全部测试完成 ###");
  srv.kill();
  process.exit(0);
})().catch((e) => { console.error("测试失败:", e); srv.kill(); process.exit(1); });
