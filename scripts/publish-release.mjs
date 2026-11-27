#!/usr/bin/env node
/**
 * Publish SPAN to GitHub and Gitee, then create releases and upload assets.
 *
 * Credentials are read from .release-secrets.json (gitignored) or from
 * GITHUB_TOKEN / GITEE_TOKEN environment variables. Tokens are never logged.
 *
 *   node scripts/publish-release.mjs --dry-run
 *   node scripts/publish-release.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const TAG = `v${pkg.version}`;
const SECRETS_FILE = path.join(ROOT, ".release-secrets.json");

const config = await readConfig();
const githubToken = config.githubToken || process.env.GITHUB_TOKEN;
const giteeToken = config.giteeToken || process.env.GITEE_TOKEN;
const repoName = config.repoName || process.env.REPO_NAME || "span-bridge-builder";
const visibility = config.visibility || process.env.REPO_VISIBILITY || "public";
const description =
  config.description ||
  "SPAN 造桥模拟器 — 纯 HTML + TypeScript + Node 服务器存储的网页造桥游戏。";

const assets = [
  {
    name: `SPAN-${pkg.version}-portable-win64.zip`,
    path: path.join(ROOT, "public", "download", `SPAN-${pkg.version}-portable-win64.zip`),
    contentType: "application/zip",
  },
  {
    name: `SPAN-${pkg.version}-lite-win64.zip`,
    path: path.join(ROOT, "public", "download", `SPAN-${pkg.version}-lite-win64.zip`),
    contentType: "application/zip",
  },
  {
    name: "SHA256SUMS.txt",
    path: path.join(ROOT, "public", "download", "SHA256SUMS.txt"),
    contentType: "text/plain",
  },
];

const releaseNotes = await readFile(path.join(ROOT, "docs", `release-notes-${TAG}.md`), "utf8");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { silent: true }).trim();
if (!branch || branch === "HEAD") fail("当前不在一个分支上，无法发布。");

console.log("");
console.log(`  SPAN ${TAG} · 发布到 GitHub + Gitee`);
console.log("");

if (DRY_RUN) {
  console.log("  [dry-run] 不会创建仓库、不会 push、不会调用 API。");
  console.log(`  仓库名：${repoName}`);
  console.log(`  可见性：${visibility}`);
  console.log(`  分支：${branch}`);
  console.log(`  标签：${TAG}`);
  console.log("");
  console.log("  发布资产：");
  for (const asset of assets) {
    if (!existsSync(asset.path)) fail(`缺少发布资产：${asset.path}`);
    console.log(`  - ${asset.name}`);
  }
  console.log("");
  console.log(`  GitHub Token：${config.githubToken || process.env.GITHUB_TOKEN ? "已配置" : "未配置"}`);
  console.log(`  Gitee Token：${config.giteeToken || process.env.GITEE_TOKEN ? "已配置" : "未配置"}`);
  process.exit(0);
}

if (!config.githubToken && !process.env.GITHUB_TOKEN) {
  fail("缺少 GitHub Token。请填写 .release-secrets.json，或设置 GITHUB_TOKEN。");
}
if (!config.giteeToken && !process.env.GITEE_TOKEN) {
  fail("缺少 Gitee Token。请填写 .release-secrets.json，或设置 GITEE_TOKEN。");
}

const isPrivate = visibility === "private";
for (const asset of assets) {
  if (!existsSync(asset.path)) fail(`缺少发布资产：${asset.path}`);
}

const status = git(["status", "--porcelain"], { silent: true }).trim();
if (status) {
  fail("工作区不干净。请先提交所有改动，再运行发布脚本。");
}

if (!git(["rev-parse", "-q", "--verify", `refs/tags/${TAG}`], { silent: true, allowFail: true }).trim()) {
  console.log(`→ 创建本地标签 ${TAG}`);
  git(["tag", "-a", TAG, "-m", `SPAN ${TAG}`]);
} else {
  const tagCommit = git(["rev-list", "-n", "1", TAG], { silent: true }).trim();
  const headCommit = git(["rev-parse", "HEAD"], { silent: true }).trim();
  if (tagCommit !== headCommit) {
    fail(`本地标签 ${TAG} 不在当前 HEAD 上。请先处理标签后再发布。`);
  }
}

const githubUser = await githubApi("/user");
const githubOwner = githubUser.login;
console.log(`→ GitHub 账号：${githubOwner}`);

const giteeUser = await giteeApi("/user");
const giteeOwner = giteeUser.login || giteeUser.name;
if (!giteeOwner) fail("无法从 Gitee Token 读取用户名。");
console.log(`→ Gitee 账号：${giteeOwner}`);

await ensureGithubRepo(githubOwner);
await ensureGiteeRepo(giteeOwner);
ensureRemote("origin", `https://github.com/${githubOwner}/${repoName}.git`);
ensureRemote("gitee", `https://gitee.com/${giteeOwner}/${repoName}.git`);

console.log("→ 推送 GitHub…");
git([
  "push",
  `https://x-access-token:${githubToken}@github.com/${githubOwner}/${repoName}.git`,
  `${branch}:${branch}`,
]);
git([
  "push",
  "--force",
  `https://x-access-token:${githubToken}@github.com/${githubOwner}/${repoName}.git`,
  `refs/tags/${TAG}`,
]);

console.log("→ 推送 Gitee…");
git([
  "push",
  `https://${encodeURIComponent(giteeOwner)}:${encodeURIComponent(giteeToken)}@gitee.com/${giteeOwner}/${repoName}.git`,
  `${branch}:${branch}`,
]);
git([
  "push",
  "--force",
  `https://${encodeURIComponent(giteeOwner)}:${encodeURIComponent(giteeToken)}@gitee.com/${giteeOwner}/${repoName}.git`,
  `refs/tags/${TAG}`,
]);

const githubRelease = await createOrUpdateGithubRelease(githubOwner);
await uploadGithubAssets(githubOwner, githubRelease.id);
const giteeRelease = await createOrUpdateGiteeRelease(giteeOwner);
await uploadGiteeAssets(giteeOwner, giteeRelease.id);

console.log("");
console.log("  发布完成：");
console.log(`  GitHub 仓库：https://github.com/${githubOwner}/${repoName}`);
console.log(`  GitHub Release：https://github.com/${githubOwner}/${repoName}/releases/tag/${TAG}`);
console.log(`  Gitee 仓库：https://gitee.com/${giteeOwner}/${repoName}`);
console.log(`  Gitee Release：https://gitee.com/${giteeOwner}/${repoName}/releases/tag/${TAG}`);
console.log("");

async function readConfig() {
  if (!existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(await readFile(SECRETS_FILE, "utf8"));
  } catch (error) {
    fail(`无法读取 .release-secrets.json：${error.message}`);
  }
}

async function githubApi(apiPath, options = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "SPAN-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const data = safeJson(text);
  if (!response.ok) {
    fail(`GitHub API ${options.method || "GET"} ${apiPath} 失败：${response.status} ${errorText(data, text)}`);
  }
  return data;
}

async function giteeApi(apiPath, options = {}) {
  const method = options.method || "GET";
  const url = new URL(`https://gitee.com/api/v5${apiPath}`);
  if (method === "GET" || method === "DELETE") {
    url.searchParams.set("access_token", giteeToken);
  }
  const isForm = options.form instanceof FormData;
  const body = isForm
    ? options.form
    : options.body
      ? new URLSearchParams({ ...options.body, access_token: giteeToken })
      : undefined;
  const response = await fetch(url, {
    method,
    headers: {
      "User-Agent": "SPAN-release",
      ...(body && !isForm ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...options.headers,
    },
    body,
  });
  const text = await response.text();
  const data = safeJson(text);
  if (!response.ok) {
    fail(`Gitee API ${method} ${apiPath} 失败：${response.status} ${errorText(data, text)}`);
  }
  return data;
}

async function ensureGithubRepo(owner) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "SPAN-release",
    },
  });
  if (response.ok) {
    console.log(`→ GitHub 仓库已存在：${owner}/${repoName}`);
    return;
  }
  if (response.status !== 404) {
    fail(`检查 GitHub 仓库失败：${response.status}`);
  }
  console.log(`→ 创建 GitHub 仓库：${owner}/${repoName}`);
  await githubApi("/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: repoName,
      description,
      private: isPrivate,
      auto_init: false,
    }),
  });
}

async function ensureGiteeRepo(owner) {
  const response = await fetch(
    `https://gitee.com/api/v5/repos/${owner}/${repoName}?access_token=${encodeURIComponent(giteeToken)}`,
    { headers: { "User-Agent": "SPAN-release" } },
  );
  if (response.ok) {
    console.log(`→ Gitee 仓库已存在：${owner}/${repoName}`);
    return;
  }
  if (response.status !== 404) {
    fail(`检查 Gitee 仓库失败：${response.status}`);
  }
  console.log(`→ 创建 Gitee 仓库：${owner}/${repoName}`);
  await giteeApi("/user/repos", {
    method: "POST",
    body: {
      name: repoName,
      description,
      private: String(isPrivate),
      auto_init: "false",
    },
  });
}

function ensureRemote(name, url) {
  const existing = git(["remote", "get-url", name], { silent: true, allowFail: true }).trim();
  if (existing) {
    if (existing !== url) git(["remote", "set-url", name, url]);
  } else {
    git(["remote", "add", name, url]);
  }
}

async function createOrUpdateGithubRelease(owner) {
  let release;
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/releases/tags/${TAG}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "User-Agent": "SPAN-release",
      },
    },
  );
  if (response.status === 200) {
    release = await response.json();
    console.log(`→ 更新 GitHub Release ${TAG}`);
    release = await githubApi(`/repos/${owner}/${repoName}/releases/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: `SPAN ${TAG} — 蓝图 2.0`,
        body: releaseNotes,
        draft: false,
        prerelease: false,
      }),
    });
  } else if (response.status === 404) {
    console.log(`→ 创建 GitHub Release ${TAG}`);
    release = await githubApi(`/repos/${owner}/${repoName}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: branch,
        name: `SPAN ${TAG} — 蓝图 2.0`,
        body: releaseNotes,
        draft: false,
        prerelease: false,
      }),
    });
  } else {
    fail(`查询 GitHub Release 失败：${response.status}`);
  }
  return release;
}

async function uploadGithubAssets(owner, releaseId) {
  const existing = await githubApi(`/repos/${owner}/${repoName}/releases/${releaseId}/assets`);
  for (const asset of assets) {
    const matched = existing.filter((item) => item.name === asset.name);
    for (const item of matched) {
      await githubApi(`/repos/${owner}/${repoName}/releases/assets/${item.id}`, { method: "DELETE" });
    }
    const body = await readFile(asset.path);
    console.log(`→ 上传 GitHub 资产：${asset.name}`);
    const response = await fetch(
      `https://uploads.github.com/repos/${owner}/${repoName}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "Content-Type": asset.contentType,
          "Content-Length": String(body.length),
          "User-Agent": "SPAN-release",
        },
        body,
      },
    );
    if (!response.ok) fail(`上传 GitHub 资产失败：${asset.name} (${response.status})`);
  }
}

async function createOrUpdateGiteeRelease(owner) {
  const response = await fetch(
    `https://gitee.com/api/v5/repos/${owner}/${repoName}/releases/tags/${TAG}?access_token=${encodeURIComponent(giteeToken)}`,
    { headers: { "User-Agent": "SPAN-release" } },
  );
  if (response.status === 200) {
    const release = await response.json();
    if (release && typeof release.id !== "undefined") {
      console.log(`→ Gitee Release 已存在：${TAG}`);
      return release;
    }
    console.log(`→ Gitee Release 尚不存在，准备创建 ${TAG}`);
  } else if (response.status !== 404) {
    fail(`查询 Gitee Release 失败：${response.status}`);
  }

  console.log(`→ 创建 Gitee Release ${TAG}`);
  const created = await giteeApi(`/repos/${owner}/${repoName}/releases`, {
    method: "POST",
    body: {
      tag_name: TAG,
      target_commitish: branch,
      name: `SPAN ${TAG} — 蓝图 2.0`,
      body: releaseNotes,
      prerelease: "false",
    },
  });
  if (!created || typeof created.id === "undefined") {
    fail("Gitee 创建 Release 后没有返回 id，无法上传附件。");
  }
  return created;
}

async function uploadGiteeAssets(owner, releaseId) {
  for (const asset of assets) {
    console.log(`→ 上传 Gitee 资产：${asset.name}`);
    const form = new FormData();
    const body = await readFile(asset.path);
    form.append("file", new Blob([body], { type: asset.contentType }), asset.name);
    const response = await fetch(
      `https://gitee.com/api/v5/repos/${owner}/${repoName}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(giteeToken)}`,
      {
        method: "POST",
        headers: { "User-Agent": "SPAN-release" },
        body: form,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      fail(`上传 Gitee 资产失败：${asset.name} (${response.status}) ${text.slice(0, 300)}`);
    }
  }
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`git 执行失败：${result.error.message}`);
  if (result.status !== 0) {
    if (options.allowFail) return "";
    const stderr = redact((result.stderr || "").trim());
    fail(`git ${args[0]} 失败${stderr ? `：${stderr}` : ""}`);
  }
  if (!options.silent) {
    if (result.stdout) process.stdout.write(redact(result.stdout));
    if (result.stderr) process.stderr.write(redact(result.stderr));
  }
  return result.stdout || "";
}

function redact(text) {
  let result = String(text);
  if (githubToken) result = result.replaceAll(githubToken, "***");
  if (giteeToken) result = result.replaceAll(giteeToken, "***");
  return result;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(data, text) {
  if (data && typeof data === "object") {
    return data.message || data.error_description || data.error || JSON.stringify(data);
  }
  return text.slice(0, 400);
}

function fail(message) {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}
