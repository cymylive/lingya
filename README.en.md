# LingYa

> **This project is a fork / secondary development of [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code), licensed under GPL-3.0-only.**
> Original author and project attribution: Cuckoo Code Contributors — https://github.com/wangyongpeng90/cuckoo-code
> This branch ([cymylive/lingya](https://github.com/cymylive/lingya)) is maintained by cymylive.

<p align="center">
  <a href="https://github.com/cymylive/lingya/releases/latest"><img src="https://img.shields.io/github/v/release/cymylive/lingya?style=flat-square&color=2dd4bf" alt="Latest Release"></a>
  <a href="https://github.com/cymylive/lingya/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/cymylive/lingya/build.yml?style=flat-square&label=Build" alt="Build Status"></a>
  <a href="https://github.com/cymylive/lingya/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/github/stars/cymylive/lingya?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/cymylive/lingya/releases"><img src="https://img.shields.io/github/downloads/cymylive/lingya/total?style=flat-square&color=green" alt="Downloads"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2dd4bf?style=flat-square" alt="Platform"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
</p>

English | [中文](README.md)

[Download the latest release](https://github.com/cymylive/lingya/releases/latest)

**LingYa** is a zero-token-cost AI Agent desktop application.

It uses Electron to embed the web versions of AI assistants (DeepSeek, ChatGPT, Claude, etc.) into a local window and injects an overlay (floating ball + panel). The AI is guided by the system prompt to generate tool calls (`lingya` code blocks), which are executed in a local sandbox and the results are sent back to the AI. The whole flow requires no API key and incurs no API usage fees — you use your web account instead of a pay-per-token API.

---

## Features in This Branch (vs. upstream cuckoo-code)

LingYa adds rebranding and feature extensions on top of upstream:

| Feature | Description |
|------|------|
| **Rebranding** | Cuckoo Code → **LingYa**, package `lingya`, separate user data directory |
| **Ink-Raven Theme** | Teal primary `#2dd4bf` + ink-black background + square "灵" ball, distinct from upstream's indigo |
| **Tabbed Layout** | Home / Chat / Log tabs + 2×3 quick-action grid, replacing the single long scroll |
| **Security MOD** | Ported from Codex Session Patcher: CTF prompt injection + refusal interception + AI rewrite |
| **Task Stop** | Panel "Stop" button + floating-ball right-click, cutting AI generation / tool execution / auto loop |
| **Raven Icon** | Newly designed brand icons (icon / tray / logo) |

See [SECURITY-MOD.md](SECURITY-MOD.md) for the security MOD, and [RENAME-LINGYA.md](RENAME-LINGYA.md) for the rename record.

---

## Core Features

### Zero Token Cost

No AI platform API is called, and no API token is used. It directly reuses the chat capabilities of the web versions, turning a web-based AI into an agent that can perform local operations.

### Multi-Platform Provider Framework

- Built-in **DeepSeek**, **ChatGPT**, and **Claude** platforms
- Each platform independently encapsulates differences such as input box location, send button detection, reply completion detection, and message parsing
- You can choose a platform when creating a new window, or **import a custom Provider** (type declarations and templates are provided)

### A True AI Agent

Not just chat. The AI can read/write files, search code, execute commands, query databases, call MCP tools, and continue based on the execution results, forming a "think → act → observe → act again" agent loop.

---

## Main Features

- **Multi-window management**: each window has an independent profile context
- **Project initialization**: after selecting a project directory, the AI gets the directory tree and system prompt
- **Tool call system**: the AI can call tools for reading/writing files, searching code, executing commands, querying databases, and more
- **Command interception**: automatically detects cmd / powershell / bash code blocks and executes them after confirmation
- **MCP support**: uses Claude Desktop compatible configuration format and supports stdio / http server types
- **Overlay panel**: shows command previews, execution results, and history; toggle with Ctrl+Shift+C or Esc
- **Long-term memory & skills**: cross-session memory injection + skill library (supports importing SKILL.md from local folders)
- **Automatic retry**: when JS execution fails and the code appears incomplete, it retries up to 3 times
- **Session persistence**: login state and settings are saved to `%APPDATA%/lingya-ai-pro-session`
- **Safety mechanisms**: 30-second command timeout, 60-second sandbox timeout, 1MB output buffer, dangerous command confirmation

---

## Installation and Running

### Requirements

- Node.js >= 16.0.0
- npm

### Steps

```bash
# Clone the repository
git clone https://github.com/cymylive/lingya.git
cd lingya

# Install dependencies
npm install

# If npm blocks the electron postinstall script (allowScripts), approve it first:
#   npm install-scripts ls
#   npm install-scripts approve electron
#   npm install

# Start the app
npm start
```

### Direct Download

Windows portable build: see [Releases](https://github.com/cymylive/lingya/releases).

---

## Usage Guide

1. Launch the app and choose a platform (DeepSeek / ChatGPT / Claude / custom Provider)
2. Log in to the corresponding web platform normally
3. Click "Initialize Project" and select a project directory; the AI will get the directory tree and system prompt
4. Chat with the AI and ask it to modify files, run commands, inspect code, etc.
5. Tool calls in AI replies are automatically detected and executed
6. Execution results are automatically sent back to the AI, which continues until the task is complete

### Tool Call Example

When an AI reply contains a `lingya` code block in the following format, the system executes it in the sandbox and sends the result back to the AI:

````markdown
```lingya
const content = await read("src/utils/helper.js");
await write("src/utils/helper.js", content.replace("formatDate", "formatTime"));
```
````

---

## Tool System

Supported tools (called through `lingya` code blocks):

| JS Function | Description |
|----------|----------|
| `read(path, options?)` | Read a text file (line-numbered window) |
| `readLines(path, options?)` | Read a file as a structured line array |
| `write(path, content)` | Create or overwrite a file |
| `edit(path, old, new, replaceAll?, dryRun?)` | Precisely replace file content |
| `glob(pattern, searchPath?)` | Find files by glob pattern |
| `grep(pattern, options?)` | Regex search over file contents |
| `bash(command, options?)` | Execute a shell command (cmd) |
| `pwsh(command, options?)` | Execute a PowerShell command |
| `todoWrite(todos)` | Manage a structured task list |
| `deleteFile(path)` | Delete a file (irreversible) |
| `webFetch(url)` | Fetch HTTP(S) URL content (HTML to Markdown) |
| `webSearch(query, opts)` | Search the web |
| `mysql(options)` | Execute MySQL SQL |
| `openBrowserWindow(url, options?)` | Open an Electron browser window |
| `injectJS(windowId, code)` | Inject JS into a specified window |
| `mcpListServers()` | List configured MCP servers |
| `mcpGetTools(serverName)` | List tools of an MCP server |
| `mcpCall(server, tool, args)` | Call an MCP tool |
| `log(...args)` | Output intermediate results to the execution log |

All file operations are relative to the currently bound project directory for safety.

---

## Security MOD

Ported from [Codex Session Patcher](https://github.com/cymylive/codex-session-patcher). All features are off by default.

- **CTF prompt injection**: toggleable. Two ways to apply — automatic (injects into systemPrompt at project initialization) / manual (panel button to inject into the current conversation, works on any session)
- **Refusal interception**: detects whether an AI reply is a refusal (two-tier detection: strong phrases full-text + weak keywords at the first 150 chars), and rewrites/resends when matched
  - Rewrite mode 1: **rewrite via current conversation** (no API needed, recommended)
  - Rewrite mode 2: external API rewrite (OpenAI-compatible)
- **Retry guard**: at most 3 consecutive rewrites in a 60-second window

Configuration is stored in `lingya-security.json`. See [SECURITY-MOD.md](SECURITY-MOD.md).

---

## MCP Configuration

MCP configuration uses the **Claude Desktop compatible format** (can be shared/imported directly):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/my-project"]
    }
  }
}
```

Both stdio (command + args) and http (url + headers) types are supported. Enable/disable state is stored separately. Open the management panel via the "MCP" button in the overlay.

---

## Custom Provider

Want to integrate a new AI platform? Copy `src/providers/custom/provider.template.js` and fill in according to the template:

- Basic info such as `id` / `name` / `homeUrl`
- Selectors for the input box and send button
- Methods such as `matchesUrl()` and `extractSessionId()`

See `src/providers/custom/provider.d.ts` for type declarations. Import the JS file from the platform selection page in the app.

---

## Project Structure

```text
lingya/
├── main.js                 # Electron main process entry (thin shell -> src/main/)
├── preload.js              # Preload entry (thin shell -> src/preload/)
├── start.js                # Cross-platform startup script (logs to wyp/log/)
├── src/
│   ├── main/               # Main process logic
│   ├── preload/            # Renderer process logic (overlay UI + DOM handling)
│   ├── prompt/             # System prompt templates (incl. ctf.md)
│   └── providers/          # Platform providers (deepseek / chatgpt / claude / custom)
├── tools/                  # Tool implementations (JsRunner + individual tools)
├── test/                   # Unit tests (246 cases)
├── assets/                 # Icons
├── .lingyaCode/            # AI assistant project guide (LINGYA.md)
└── dist/                   # Build output
```

---

## Build and Release

- GitHub Actions is configured; pushing a `v*` tag builds Windows and macOS installers and publishes to Releases
- Local manual builds: `npm run build:win:portable:local` or `npm run build:mac:local`
- Build output goes to the `dist/` directory

---

## Roadmap

See [Roadmap.md](Roadmap.md) for the next phase plan.

---

## Contributing

Issues and Pull Requests are welcome.

- Report bugs or suggest new features: Issues
- Submit code: Pull Requests

---

## License

This project is licensed under the GNU General Public License v3.0. See the LICENSE file.

This project is a secondary development of cuckoo-code, licensed under GPL-3.0-only. **Upstream attribution (LICENSE, contributors, upstream links) is preserved as required and must not be removed.**

---

## Acknowledgements

- Upstream project [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code) and all Cuckoo Code Contributors
- [Codex Session Patcher](https://github.com/cymylive/codex-session-patcher): source of the Security MOD capabilities
- DeepSeek, ChatGPT, Claude for providing powerful AI capabilities
- Electron for the cross-platform desktop framework
- [@27584](https://github.com/27584): framework-level improvements (PR #9)
- All contributors and users
