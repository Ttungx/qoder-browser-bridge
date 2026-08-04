# Qoder-browser-bridge

独立的浏览器 MCP Server —— 复用 **QoderWork/Qoder 浏览器连接器扩展**，让 Claude Code、opencode 等任意 MCP 客户端直接操控你的真实浏览器（保留登录态、Cookies、真实指纹）。

## 工作原理

```
MCP 客户端 (Claude Code / opencode)
    │  stdio (JSON-RPC / MCP)
    ▼
qw-browser-bridge (本程序)
    │  WebSocket  ws://127.0.0.1:<port>/extension/v2
    │  HTTP       /app/info
    ▼
QoderWork 浏览器连接器扩展 (Chrome/Edge Extension)
    │  chrome.debugger / chrome.tabs API
    ▼
你的真实浏览器标签页
```

发现机制：本程序启动时向 `%APPDATA%\QoderWork Dev\relay-port.json` 写入自己的端口。
扩展内置的 native messaging host 会扫描所有 QoderWork 候选目录下的 `relay-port.json`，
扩展发现后自动建立 WebSocket 连接。支持与 QoderWork 主程序**同时运行**（扩展原生支持多中继）。

工具列表不是硬编码的：连接建立后通过 `tools/discover` 从扩展动态获取，扩展升级后自动跟进。

## 依赖

- Node.js 18+
- Edge/Chrome 中已安装并启用 **Qoder浏览器连接器扩展**（QoderWork 设置里打开"浏览器连接器"即可自动安装）
- 浏览器处于运行状态

## 手动运行

```bash
node server.js                 # 默认端口 18789
node server.js --port 18800    # 指定端口
node server.js --no-discovery  # 不写发现文件（调试用）
```

日志输出到 stderr（stdout 保留给 MCP 协议）。看到 `扩展已连接` 和 `已获取 N 个浏览器工具` 即就绪。

## cc-switch 配置

```json
{
  "type": "stdio",
  "command": "node",
  "args": [
    "~/server.js"
  ]
}
```

## Claude Code 配置

```bash
claude mcp add browser -- node E:\software\AAATools\qw-browser-bridge\server.js
```

或手动编辑 `~/.claude.json` / 项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["~/server.js"]
    }
  }
}
```

## opencode 配置

`opencode.json`：

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", ~/server.js"],
      "enabled": true
    }
  }
}
```

## 通用 MCP 客户端

任何支持 stdio 型 MCP server 的客户端都可以，核心就是：
`command: node`，`args: [server.js 的绝对路径]`。

## 提供的工具（17 个，随扩展版本动态变化）

navigate / read_page / find / form_input / computer（点击、输入、截图、滚动等）/
javascript_tool / get_page_text / file_upload / resize_window /
read_console_messages / read_network_requests / handle_dialog /
tabs_context / tabs_create / tabs_context_mcp / tabs_create_mcp / tabs_close_mcp

## 注意事项

- 典型用法：先 `tabs_context` 或 `tabs_create_mcp` 拿到 tabId，后续工具都传这个 tabId。
- `edge://`、`chrome://` 等内部页面会被扩展拒绝操作，先 navigate 到普通网页。
- 程序退出时自动删除自己写的 `relay-port.json`（按 pid 匹配，不会误删 QoderWork 的）。
- 默认发现目录是 `%APPDATA%\QoderWork Dev`，可用 `--discovery-dir` 改。
- 协议逆向自扩展 v1.5.2（V2 协议），扩展大版本升级后如连不上可重新抓包核对。
