(async () => {
  const health = await fetch("/api/health", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const version = health?.version || "0.2.0";
  await wireDownload(
    "fullDownload",
    "fullSize",
    `/download/SPAN-${version}-portable-win64.zip`,
    "下载完整便携版",
  );
  await wireDownload(
    "liteDownload",
    "liteSize",
    `/download/SPAN-${version}-lite-win64.zip`,
    "下载精简版",
  );
})();

async function wireDownload(linkId, sizeId, href, label) {
  const link = document.getElementById(linkId);
  const size = document.getElementById(sizeId);
  link.href = href;
  try {
    const response = await fetch(href, { method: "HEAD", cache: "no-store" });
    if (!response.ok) throw new Error("missing");
    const bytes = Number(response.headers.get("content-length") || 0);
    link.classList.remove("disabled");
    link.textContent = label;
    size.textContent = bytes
      ? `文件大小 ${formatBytes(bytes)} · 解压后双击入口`
      : "文件已就绪 · 解压后双击入口";
  } catch {
    link.classList.add("disabled");
    link.removeAttribute("download");
    link.textContent = "安装包尚未生成";
    size.textContent = "请先在项目中运行 npm run package";
  }
}

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
