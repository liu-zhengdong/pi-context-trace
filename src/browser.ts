import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function openBrowser(
  url: string,
  exec: ExtensionAPI["exec"],
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let command = "xdg-open";
  const args = [url];
  if (platform === "darwin") command = "open";
  else if (platform === "win32") {
    command = "rundll32.exe";
    args.unshift("url.dll,FileProtocolHandler");
  }
  const result = await exec(command, args, { timeout: 5000 });
  if (result.killed) throw new Error("打开浏览器超时");
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || `浏览器启动命令退出：${result.code}`,
    );
}
