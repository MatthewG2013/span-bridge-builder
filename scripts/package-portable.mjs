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
import { createHash } from "node:crypto";
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
await writeFile(path.join(RELEASE_ROOT, "使用说明.txt"), `\uFEFF${usageGuide()}`, "utf8");

const published = [];
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
  published.push({ zipName, zipPath });
}

const checksums = [];
for (const { zipName, zipPath } of published) {
  checksums.push(`${await hashFile(zipPath)}  ${zipName}`);
}
const checksumText = `${checksums.join("\n")}\n`;
await writeFile(path.join(DOWNLOAD_DIR, "SHA256SUMS.txt"), checksumText, "utf8");
await writeFile(path.join(RELEASE_ROOT, "SHA256SUMS.txt"), checksumText, "utf8");
console.log("→ 已写入 SHA256SUMS.txt");

console.log("");
console.log("  打包完成。使用说明：release/使用说明.txt");
console.log("  下载页面：public/download.html");
console.log("  下载目录：public/download/");
console.log("");

function usageGuide() {
  return `SPAN 造桥模拟器 ${VERSION} · 便携版使用说明
==================================================

一、release 目录里有什么
------------------------
${variants.map((variant) => `- ${`SPAN-${VERSION}-${variant.key}`}/  ${variant.label}${variant.withNode ? "（内置 Node.js，开箱即用）" : "（需要系统 Node.js 22.5+）"}`).join("\n")}
- 使用说明.txt  本文件
- 下载压缩包位于 ../public/download/ 目录

二、最快启动方式（完整版）
--------------------------
1. 解压 SPAN-${VERSION}-portable 文件夹到任意位置。
   请先完整解压，不要直接在压缩包里双击。
2. 打开解压后的文件夹。
3. 双击 START-SPAN.bat。
4. 等待 1–2 秒，默认浏览器会自动打开：
   http://127.0.0.1:4173
5. 关闭启动窗口，或按 Ctrl+C，即可停止服务器。

完整版已经内置 Node.js 运行时，不需要安装 Node、npm，
也不需要执行 npm install 或 npm run build。

三、精简版启动方式
------------------
精简版不包含 node.exe，需要电脑已安装 Node.js 22.5 或更高版本：
  https://nodejs.org/

安装 Node 后，双击精简版文件夹里的 START-SPAN.bat 即可。
启动逻辑与完整版完全一样。

四、两个入口的区别
------------------
- START-SPAN.bat  推荐入口，双击即可启动并打开浏览器。
- start.bat       命令行入口，作用相同，方便在终端里调用。

五、如何停止服务器
------------------
- 直接关闭启动窗口。
- 或在启动窗口里按 Ctrl+C。
- 如果窗口异常关闭但端口仍被占用，重新运行入口即可检测并启动；
  也可以注销/重启电脑释放端口。

六、端口与局域网访问
--------------------
默认只监听本机：
  http://127.0.0.1:4173

如果 4173 端口被占用，可以在启动前设置环境变量：
  set PORT=5173
  START-SPAN.bat

希望局域网内其他设备访问，可以：
  set HOST=0.0.0.0
  START-SPAN.bat
然后用本机局域网 IP 加端口访问，例如：
  http://192.168.1.20:4173
注意：开放到局域网前请确认你信任所在网络。

七、存档与数据
--------------
游戏存档、昵称和排行榜数据保存在：
  data\\db.json

- 备份：复制整个 data 文件夹。
- 重置：关闭游戏，删除 data 文件夹，重启后会重新创建。
- 升级：替换程序文件时保留 data 文件夹，存档不会丢失。

八、常见问题
------------
1. 浏览器没有自动打开
   手动在浏览器地址栏输入 http://127.0.0.1:4173
   如果仍然打不开，检查启动窗口里是否有错误信息。

2. Windows 提示“Windows 已保护你的电脑”
   这是对未签名 .bat 启动脚本的常规提示。
   点击「更多信息」→「仍要运行」即可。

3. 提示 Node.js 未找到（仅精简版）
   说明系统没有 Node.js，或版本低于 22.5。
   安装最新 LTS 版 Node.js，或者改用完整便携版。

4. 提示端口被占用
   换一个端口：
     set PORT=5173
     START-SPAN.bat

5. 双击后窗口一闪而过
   请确认是解压后的文件夹，并且 START-SPAN.bat 与
   launcher.mjs、server、public 在同一个目录中。

6. 数据想换电脑
   复制整个程序文件夹，或至少复制 data 文件夹。

九、目录结构
------------
START-SPAN.bat          双击入口
start.bat               命令行入口
launcher.mjs            本地启动器
server\\                 后端服务
shared\\                 前后端共享关卡与材料
public\\                 前端页面
runtime\\node.exe        完整版内置的 Node.js 运行时
data\\db.json            自动生成的存档与排行榜
README.txt              包内简要说明
GUIDE.txt               完整使用说明

十、安全与隐私
--------------
- 默认仅在 127.0.0.1 提供本地服务，不对外网开放。
- 不需要联网即可游玩；只有首次下载安装包时需要网络。
- 删除 data 文件夹即可清空所有本地存档。

SPAN · Bridge Lab
`;
}

async function assemble(target, variant) {  await mkdir(target, { recursive: true });
  await copyDir(path.join(ROOT, "dist", "server"), path.join(target, "server"));
  await copyDir(path.join(ROOT, "dist", "shared"), path.join(target, "shared"));

  await mkdir(path.join(target, "public"), { recursive: true });
  await copyFile(path.join(ROOT, "public", "index.html"), path.join(target, "public", "index.html"));
  await copyFile(path.join(ROOT, "public", "styles.css"), path.join(target, "public", "styles.css"));
  await copyDir(path.join(ROOT, "public", "js"), path.join(target, "public", "js"));

  await copyFile(path.join(TEMPLATE_DIR, "launcher.mjs"), path.join(target, "launcher.mjs"));
  await copyFile(path.join(TEMPLATE_DIR, "start.bat"), path.join(target, "start.bat"));
  await copyFile(path.join(TEMPLATE_DIR, "START-SPAN.bat"), path.join(target, "START-SPAN.bat"));
  await writeFile(path.join(target, "GUIDE.txt"), `\uFEFF${usageGuide()}`, "utf8");

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

【完整说明】
请阅读同目录下的 GUIDE.txt，包含端口、存档、局域网和常见问题。

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

async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}
