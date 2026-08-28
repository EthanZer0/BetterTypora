# =====================================================================
# BetterTypora 发布包构建脚本
# =====================================================================
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Version v1.0.1
#
# 产物: BetterTypora-<Version>.zip (仓库根目录)
# 布局:
#   BetterTypora-<Version>/
#   ├── 安装.bat         双击入口 (菜单: 安装/卸载/仅检测/退出)
#   ├── core.ps1         安装器本体
#   ├── plugins/         插件本体 (含 split-view/node_modules 运行时依赖)
#   ├── README.md        说明
#   └── LICENSE          MIT
# =====================================================================

param([string]$Version = "v1.0.0")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stageName = "BetterTypora-$Version"
$stage = Join-Path $root $stageName
$zip = Join-Path $root "$stageName.zip"

Write-Host "==> 构建发布包 $stageName" -ForegroundColor Cyan

# 1. 清理旧 staging
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory | Out-Null

# 2. 复制安装器与文档
foreach ($f in @("安装.bat", "core.ps1", "README.md", "LICENSE")) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) { throw "缺少文件: $src" }
    Copy-Item $src $stage
}
Write-Host "    安装器 + 文档已复制"

# 3. 复制插件目录 (含 split-view/node_modules 运行时依赖)
$pluginsSrc = Join-Path $root "plugins"
if (-not (Test-Path $pluginsSrc)) { throw "缺少插件目录: $pluginsSrc" }
Copy-Item $pluginsSrc (Join-Path $stage "plugins") -Recurse
Write-Host "    插件目录已复制 (含 node_modules)"

# 4. 压缩
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

Write-Host "==> 完成: $zip" -ForegroundColor Green
Write-Host "    大小: $([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB"
