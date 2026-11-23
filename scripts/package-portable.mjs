#!/usr/bin/env node
/**
 * Build a self-contained Windows portable package under release/ and publish
 * downloadable zip files to public/download/.
 *
 *   npm run package        # full (bundled node.exe) + lite
 *   npm run package:full   # full only
 *   npm run package:lite   # lite only
 */
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const argv = new Set(process.argv.slice(2));
const SKIP_BUILD = argv.has("--skip-build");
const onlyArg = process.argv.find((value) => value.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length) : "both";

const RELEASE_ROOT = path.join(ROOT, "release");
const DOWNLOAD_DIR = path.join(ROOT, "public", "download");
const TEMPLATE_DIR = path.join(ROOT, "scripts", "portable");

const variants = [];
if (ONLY === "both" || ONLY === "full") {
  variants.push({ key: "portable", label: "完整便携版", withNode: true });
}
if (ONLY === "both" || ONLY === "lite") {
  variants.push({ key: "lite", label: "精简版", withNode: false });
}
if (variants.length === 0) {
  fail("未知的 --only 参数，使用 full、lite 或 both。");
}
if (process.platform !== "win32" && variants.some((variant) => variant.withNode)) {
  fail("完整便携版包含 Windows 的 node.exe，只能在 Windows 上打包。");
}

console.log("");
console.log(`  SPAN ${VERSION} · 便携版打包`);
console.log("");

if (!SKIP_BUILD) {
  console.log("→ 编译前后端…");
  runNpm(["run", "build"]);
}

await rm(RELEASE_ROOT, { recursive: true, force: true });
await rm(DOWNLOAD_DIR, { recursive: true, force: true });
await mkdir(RELEASE_ROOT, { recursive: true });
await mkdir(DOWNLOAD_DIR, { recursive: true });

for (const variant of variants) {
  const folderName = `SPAN-${VERSION}-${variant.key}`;
  const target = path.join(RELEASE_ROOT, folderName);
  console.log(`→ 组装 ${variant.label}：release/${folderName}`);
  await assemble(target, variant);

  const zipName = `SPAN-${VERSION}-${variant.key}-win64.zip`;
  const zipPath = path.join(DOWNLOAD_DIR, zipName);
  console.log(`→ 压缩 ${zipName}`);
  createZip(target, zipPath);
  const info = await stat(zipPath);
  console.log(`  ${zipName}  ${formatSize(info.size)}`);
}

console.log("");
console.log("  打包完成。下载页面：public/download.html");
console.log("  下载目录：public/download/");
console.log("");

async function assemble(target, variant) {
  await mkdir(target, { recursive: true });
  await copyDir(path.join(ROOT, "dist", "server"), path.join(target, "server"));
  await copyDir(path.join(ROOT, "dist", "shared"), path.join(target, "shared"));

  await mkdir(path.join(target, "public"), { recursive: true });
  await copyFile(path.join(ROOT, "public", "index.html"), path.join(target, "public", "index.html"));
  await copyFile(path.join(ROOT, "public", "styles.css"), path.join(target, "public", "styles.css"));
  await copyDir(path.join(ROOT, "public", "js"), path.join(target, "public", "js"));

  await copyFile(path.join(TEMPLATE_DIR, "launcher.mjs"), path.join(target, "launcher.mjs"));
  await copyFile(path.join(TEMPLATE_DIR, "start.bat"), path.join(target, "start.bat"));
  await copyFile(path.join(TEMPLATE_DIR, "START-SPAN.bat"), path.join(target, "START-SPAN.bat"));

  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        name: "span-portable",
        version: VERSION,
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(target, "README.txt"),
    `\uFEFFSPAN 造桥模拟器 ${VERSION} — ${variant.label}

【运行】
1. 请先把整个压缩包解压到任意文件夹，不要直接在压缩包里双击。
2. 双击「START-SPAN.bat」。
3. 服务器会自动启动，并打开默认浏览器。
4. 关闭启动窗口或按 Ctrl+C，即可停止游戏服务器。

【入口】
- START-SPAN.bat  （推荐，双击即可）
- start.bat        （命令行入口）

【环境】
${variant.withNode
  ? "本包已包含 Node.js 运行时，无需另外安装 Node.js。"
  : "本包不包含 Node.js 运行时，需要先安装 Node.js 22.5 或更高版本：https://nodejs.org/"}

【端口】
默认地址：http://127.0.0.1:4173
如果端口被占用，可以在启动前设置环境变量 PORT，例如：
  set PORT=5173
  start.bat

【存档】
昵称设计、排行榜数据保存在当前文件夹的 data 目录中。
移动文件夹时请连同 data 一起移动。

【常见问题】
- 浏览器没有自动打开：手动访问 http://127.0.0.1:4173
- Windows 提示安全警告：这是未签名的本地启动脚本，可选择「更多信息 → 仍要运行」。
- 请勿把本程序放在需要管理员权限的系统目录中。

SPAN · Bridge Lab
`,
    "utf8",
  );

  if (variant.withNode) {
    console.log("→ 复制 Node.js 运行时…");
    await mkdir(path.join(target, "runtime"), { recursive: true });
    await copyFile(process.execPath, path.join(target, "runtime", "node.exe"));
    await writeFile(
      path.join(target, "runtime", "LICENSE-node.txt"),
      `Node.js
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`,
      "utf8",
    );
  }
}

async function copyDir(source, destination) {
  if (!existsSync(source)) fail(`缺少目录：${source}`);
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !entry.endsWith(".map") && !entry.endsWith(".DS_Store"),
  });
}

function createZip(sourceDir, zipPath) {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(sourceDir)}, ${psQuote(zipPath)}, [System.IO.Compression.CompressionLevel]::Optimal, $true)`,
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`压缩失败：${zipPath}`);
}

function runNpm(args) {
  const onWindows = process.platform === "win32";
  const command = onWindows ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = onWindows ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`npm ${args.join(" ")} 失败。`);
}

function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}
