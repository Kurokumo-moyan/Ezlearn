// 获取 Microsoft WebView2 SDK（桌面窗口用）：从 nuget.org 下载固定版本，解压出需要的 3 个 DLL，
// 并用 Windows 的 Authenticode 校验它们确实由 Microsoft 签名。结果缓存在 build/vendor/webview2/。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WEBVIEW2_VERSION = '1.0.2903.40';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'vendor', 'webview2');
const FILES = {
  'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
  'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
  'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll',
};

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();

function verify(file) {
  // 必须是有效签名，且签名者是 Microsoft
  const out = ps(`$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
  const [status, subject] = out.split('|');
  if (status !== 'Valid' || !/O=Microsoft Corporation/.test(subject)) throw new Error(`签名校验失败：${path.basename(file)} → ${out}`);
}

export async function fetchWebView2() {
  const marker = path.join(OUT, `.version-${WEBVIEW2_VERSION}`);
  if (fs.existsSync(marker) && Object.values(FILES).every((f) => fs.existsSync(path.join(OUT, f)))) {
    Object.values(FILES).forEach((f) => verify(path.join(OUT, f)));
    return OUT;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 WebView2 SDK 失败：HTTP ${res.status}`);
  const pkg = path.join(OUT, 'package.nupkg');
  fs.writeFileSync(pkg, Buffer.from(await res.arrayBuffer()));
  // nupkg 就是 zip：只取需要的文件，并防止路径穿越
  const entries = Object.keys(FILES).map((k) => `'${k}'`).join(',');
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${pkg.replace(/'/g, "''")}')
try {
  foreach ($want in @(${entries})) {
    $e = $z.Entries | Where-Object { $_.FullName -eq $want } | Select-Object -First 1
    if (-not $e) { throw "missing $want" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path '${OUT.replace(/'/g, "''")}' $e.Name), $true)
  }
} finally { $z.Dispose() }`);
  fs.rmSync(pkg);
  Object.values(FILES).forEach((f) => verify(path.join(OUT, f)));
  fs.writeFileSync(marker, new Date().toISOString());
  return OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await fetchWebView2());
}
