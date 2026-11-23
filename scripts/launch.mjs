#!/usr/bin/env node
/**
 * SPAN one-click launcher.
 *
 * - installs TypeScript if this is a fresh checkout
 * - rebuilds the browser and server bundles
 * - starts the Node server (frontend is served by the same process)
 * - waits for /api/health, then opens the game in the default browser
 *
 * Usage:
 *   npm run launch
 *   node scripts/launch.mjs --no-open
 *   node scripts/launch.mjs --skip-build --app
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const NO_OPEN = argv.has("--no-open") || process.env.SPAN_NO_OPEN === "1";
const SKIP_BUILD = argv.has("--skip-build") || process.env.SPAN_SKIP_BUILD === "1";
const APP_WINDOW = argv.has("--app") || process.env.SPAN_APP_WINDOW === "1";

const host = process.env.HOST || "127.0.0.1";
const requestedPort = Number(process.env.PORT || "4173");
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 4173;
const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const url = `http://${browserHost}:${port}`;

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const serverEntry = path.join(ROOT, "dist", "server", "server.js");
const clientEntry = path.join(ROOT, "public", "js", "client", "main.js");
banner();

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  fail(`需要 Node.js 22.5 或更高版本，当前为 ${process.versions.node}。`);
}

if (!SKIP_BUILD) {
  if (!existsSync(path.join(ROOT, "node_modules", "typescript"))) {
    console.log("→ 首次启动，安装依赖…");
    runNpm(["install"]);
  }
  console.log("→ 编译 TypeScript…");
  runNpm(["run", "build"]);
}

if (!existsSync(serverEntry) || !existsSync(clientEntry)) {
  fail("构建产物不存在。请先运行 npm install 和 npm run build。");
}

const existing = await readHealth();
if (existing?.name?.includes("SPAN")) {
  console.log(`→ 服务器已经在运行：${url}`);
  openBrowser(url);
  process.exit(0);
}

if (await portIsOpen(port)) {
  fail(`端口 ${port} 已被其他程序占用。可以设置环境变量 PORT 换一个端口。`);
}

console.log(`→ 启动服务器 ${url}`);
const child = spawn(process.execPath, [serverEntry], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: host },
  stdio: "inherit",
  windowsHide: true,
});

let shuttingDown = false;
const stop = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal === "SIGTERM" ? "SIGTERM" : "SIGINT");
  }
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => {
  if (!shuttingDown) {
    console.log(`\n[launcher] 服务器已退出（code ${code ?? 0}）。`);
  }
  process.exit(code ?? 0);
});
child.on("error", (error) => {
  fail(`无法启动服务器：${error.message}`);
});

const ready = await waitForHealth();
if (!ready) {
  stop("SIGTERM");
  fail("服务器启动超时。请检查端口和 Node 版本。");
}

console.log(`\n  SPAN 已就绪：${url}`);
console.log("  关闭此窗口或按 Ctrl+C 停止服务器。\n");
openBrowser(url);

async function readHealth() {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(800),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    if (child.exitCode !== null) return false;
    const health = await readHealth();
    if (health?.ok) return health;
    await sleep(250);
  }
  return false;
}

function portIsOpen(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: targetPort, host: browserHost });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function runNpm(args) {
  const onWindows = process.platform === "win32";
  const command = onWindows ? process.env.ComSpec || "cmd.exe" : npm;
  const commandArgs = onWindows
    ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`npm ${args.join(" ")} 失败。`);
}

function openBrowser(targetUrl) {
  if (NO_OPEN) {
    console.log(`→ 已跳过自动打开浏览器（--no-open）。`);
    return;
  }

  try {
    if (process.platform === "win32") {
      const appBrowser = APP_WINDOW ? findWindowsBrowser() : null;
      if (appBrowser) {
        spawn(
          appBrowser,
          [`--app=${targetUrl}`, "--window-size=1440,900", "--no-first-run", "--no-default-browser-check"],
          { detached: true, stdio: "ignore", windowsHide: false },
        ).unref();
        console.log("→ 已用浏览器应用窗口打开游戏。");
        return;
      }
      spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${targetUrl}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      console.log("→ 已请求浏览器打开游戏。");
      return;
    }

    const command = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [targetUrl], { detached: true, stdio: "ignore" }).unref();
    console.log("→ 已请求浏览器打开游戏。");
  } catch (error) {
    console.log(`→ 无法自动打开浏览器，请手动访问 ${targetUrl}（${error.message}）`);
  }
}

function findWindowsBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function banner() {
  console.log("");
  console.log("  ███████╗██████╗  █████╗ ███╗   ██╗");
  console.log("  ██╔════╝██╔══██╗██╔══██╗████╗  ██║");
  console.log("  ███████╗██████╔╝███████║██╔██╗ ██║");
  console.log("  ╚════██║██╔═══╝ ██╔══██║██║╚██╗██║");
  console.log("  ███████║██║     ██║  ██║██║ ╚████║");
  console.log("  ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝");
  console.log("  造桥模拟器 · 一键启动");
  console.log("");
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}
