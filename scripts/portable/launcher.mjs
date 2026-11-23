#!/usr/bin/env node
/**
 * SPAN portable launcher.
 *
 * This file is copied into the release package. It does not build, install, or
 * require npm: it starts the prebuilt server, waits for health, and opens the
 * game in a browser window.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = new Set(process.argv.slice(2));
const NO_OPEN = argv.has("--no-open") || process.env.SPAN_NO_OPEN === "1";
const APP_WINDOW = argv.has("--app") || process.env.SPAN_APP_WINDOW === "1";
const HOST = process.env.HOST || "127.0.0.1";
const requestedPort = Number(process.env.PORT || "4173");
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 4173;
const browserHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
const URL = `http://${browserHost}:${PORT}`;

banner();

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  fail(`需要 Node.js 22.5 或更高版本，当前为 ${process.versions.node}。`);
}

const serverEntry = path.join(ROOT, "server", "server.js");
const webEntry = path.join(ROOT, "public", "index.html");
if (!existsSync(serverEntry) || !existsSync(webEntry)) {
  fail("便携版文件不完整，请重新解压整个压缩包。");
}

const existing = await readHealth();
if (existing?.name?.includes("SPAN")) {
  console.log(`→ 游戏已经在运行：${URL}`);
  openBrowser(URL);
  process.exit(0);
}

if (await portIsOpen(PORT)) {
  fail(`端口 ${PORT} 已被其他程序占用。可以设置环境变量 PORT 换一个端口。`);
}

mkdirSync(path.join(ROOT, "data"), { recursive: true });
console.log(`→ 启动 SPAN：${URL}`);

const child = spawn(process.execPath, [serverEntry], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST,
    BRIDGE_PUBLIC_DIR: path.join(ROOT, "public"),
    BRIDGE_DATA_DIR: path.join(ROOT, "data"),
  },
  stdio: "inherit",
  windowsHide: true,
});

let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  if (!shuttingDown) console.log(`\n[launcher] 服务器已退出（code ${code ?? 0}）。`);
  process.exit(code ?? 0);
});
child.on("error", (error) => fail(`无法启动服务器：${error.message}`));

const ready = await waitForHealth();
if (!ready) {
  stop();
  fail("服务器启动超时。请检查 4173 端口是否被占用。");
}

console.log("");
console.log(`  SPAN 已就绪：${URL}`);
console.log("  关闭此窗口或按 Ctrl+C 停止游戏服务器。");
console.log("");
openBrowser(URL);

async function readHealth() {
  try {
    const response = await fetch(`${URL}/api/health`, {
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
    if (await readHealth()) return true;
    await sleep(250);
  }
  return false;
}

function portIsOpen(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: targetPort, host: browserHost });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function openBrowser(targetUrl) {
  if (NO_OPEN) {
    console.log("→ 已跳过自动打开浏览器（--no-open）。");
    return;
  }

  try {
    if (process.platform === "win32") {
      if (APP_WINDOW) {
        const browser = findWindowsBrowser();
        if (browser) {
          spawn(
            browser,
            [`--app=${targetUrl}`, "--window-size=1440,900", "--no-first-run", "--no-default-browser-check"],
            { detached: true, stdio: "ignore" },
          ).unref();
          console.log("→ 已用浏览器应用窗口打开游戏。");
          return;
        }
      }
      spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${targetUrl}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      console.log("→ 已打开浏览器。");
      return;
    }

    const command = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [targetUrl], { detached: true, stdio: "ignore" }).unref();
    console.log("→ 已打开浏览器。");
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
  console.log("  造桥模拟器 · 便携版");
  console.log("");
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}
