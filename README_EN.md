# Qoder-browser-bridge

Standalone browser MCP Server — reuses the **QoderWork/Qoder Browser Connector Extension**, letting any MCP client (Claude Code, opencode, etc.) directly control your real browser (keeping login state, cookies, and real fingerprint).

[中文版](./README.md) | English

## How it works

```
MCP client (Claude Code / opencode)
    │  stdio (JSON-RPC / MCP)
    ▼
qw-browser-bridge (this program)
    │  WebSocket  ws://127.0.0.1:<port>/extension/v2
    │  HTTP       /app/info
    ▼
QoderWork Browser Connector Extension (Chrome/Edge Extension)
    │  chrome.debugger / chrome.tabs API
    ▼
Your real browser tabs
```

Discovery: on startup this program writes its own port to `%APPDATA%\QoderWork Dev\relay-port.json`.
The extension's built-in native messaging host scans all QoderWork candidate directories for `relay-port.json`,
and auto-connects over WebSocket once found. It can run **alongside** the QoderWork main program (the extension natively supports multiple relays).

The tool list is not hardcoded: after the connection is established it's fetched dynamically from the extension via `tools/discover`, so it follows extension upgrades automatically.

## Requirements

- Node.js 18+
- The **Qoder Browser Connector Extension** installed and enabled in Edge/Chrome (enable "Browser Connector" in QoderWork settings to auto-install)
- Browser running

## Manual run

```bash
node server.js                 # default port 18789
node server.js --port 18800    # custom port
node server.js --no-discovery  # skip writing the discovery file (debugging)
```

Logs go to stderr (stdout is reserved for the MCP protocol). Ready when you see `扩展已连接` and `已获取 N 个浏览器工具`.

## cc-switch config

```json
{
  "type": "stdio",
  "command": "node",
  "args": [
    "~/server.js"
  ]
}
```

## Claude Code config

```bash
claude mcp add browser -- node E:\software\AAATools\qw-browser-bridge\server.js
```

Or edit `~/.claude.json` / project `.mcp.json` manually:

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

## opencode config

`opencode.json`:

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", ~/server.js],
      "enabled": true
    }
  }
}
```

## Any MCP client

Any client that supports stdio-type MCP servers works; the core is simply:
`command: node`, `args: [absolute path to server.js]`.

## Provided tools (17, changes dynamically with the extension version)

navigate / read_page / find / form_input / computer (click, type, screenshot, scroll, etc.) /
javascript_tool / get_page_text / file_upload / resize_window /
read_console_messages / read_network_requests / handle_dialog /
tabs_context / tabs_create / tabs_context_mcp / tabs_create_mcp / tabs_close_mcp

## Notes

- Typical usage: call `tabs_context` or `tabs_create_mcp` first to get a tabId, then pass that tabId to subsequent tools.
- Internal pages like `edge://`, `chrome://` are rejected by the extension; navigate to a normal webpage first.
- On exit the program deletes the `relay-port.json` it wrote (matched by pid, so it won't delete QoderWork's).
- Default discovery directory is `%APPDATA%\QoderWork Dev`, changeable with `--discovery-dir`.
- Protocol reverse-engineered from extension v1.5.2 (V2 protocol); if connection fails after a major extension upgrade, re-capture and verify.
