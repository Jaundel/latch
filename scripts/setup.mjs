// Registers the Latch MCP server with an AI client.
//   npm run setup                    print what to do
//   npm run setup -- --claude-code   add to Claude Code (user scope)
//   npm run setup -- --claude-desktop
//   npm run setup -- --codex
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = join(root, 'server', 'index.js');
const extension = join(root, 'extension');
const args = new Set(process.argv.slice(2));

function claudeCode() {
  execSync(`claude mcp add --scope user latch -- node "${server}"`, { stdio: 'inherit' });
}

function claudeDesktop() {
  const base = process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config');
  const file = join(base, 'Claude', 'claude_desktop_config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  config.mcpServers = { ...config.mcpServers, latch: { command: 'node', args: [server] } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
  console.log(`Added latch to ${file}. Restart Claude Desktop.`);
}

function codex() {
  const file = join(homedir(), '.codex', 'config.toml');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^\[mcp_servers\.latch\]/m.test(current)) return console.log(`latch is already in ${file}`);
  if (current) copyFileSync(file, `${file}.bak`);
  const block = `\n[mcp_servers.latch]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, current + block);
  console.log(`Added latch to ${file}. Restart Codex.`);
}

if (args.has('--claude-code')) claudeCode();
if (args.has('--claude-desktop')) claudeDesktop();
if (args.has('--codex')) codex();

if (!args.size) {
  console.log(`Latch setup

1. Load the extension
   Open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick:
   ${extension}

2. Click the Latch icon in Chrome and enter your email, password and inbox app password.

3. Add the tool to your AI (pick one or more):
   npm run setup -- --claude-code
   npm run setup -- --claude-desktop
   npm run setup -- --codex

   Or by hand:
   claude mcp add --scope user latch -- node "${server}"
`);
}
