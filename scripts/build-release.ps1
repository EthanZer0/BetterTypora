# =====================================================================
# BetterTypora 发布包构建脚本
# =====================================================================
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Version v1.1.0
#
# 产物: BetterTypora-<Version>.zip 和对应的 .sha256 (仓库根目录)
# 布局:
#   BetterTypora-<Version>/
#   ├── 安装.bat         双击入口 (菜单: 安装/卸载/仅检测/退出)
#   ├── core.ps1         安装器本体
#   ├── VERSION           发布版本
#   ├── plugins/         插件本体 (含 split-view/node_modules 运行时依赖, 不含测试)
#   └── LICENSE          MIT
# =====================================================================

param([string]$Version = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $root "VERSION"
$versionFromFile = ""
if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
    $versionFromFile = (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
}
if (-not $Version) { $Version = $versionFromFile }
if ($Version -match '^v') { $Version = $Version.Substring(1) }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "版本号无效: '$Version'。请使用 1.1.0 或 v1.1.0 格式。"
}
$Version = "v$Version"
$stageName = "BetterTypora-$Version"
$stage = Join-Path $root $stageName
$zip = Join-Path $root "$stageName.zip"
$zipTemp = Join-Path $root "$stageName.tmp.zip"
$sha256 = "$zip.sha256"

Write-Host "==> 构建发布包 $stageName" -ForegroundColor Cyan

function Require-File([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少发布文件: $path" }
}

function Read-Json([string]$path) {
    try { return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "JSON 无法解析: $path; $($_.Exception.Message)" }
}

function Copy-PluginRuntime([string]$source, [string]$destination) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $excluded = @("tests", ".cache", ".git", ".gitignore")
    foreach ($item in @(Get-ChildItem -LiteralPath $source -Force)) {
        if ($excluded -contains $item.Name) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
    }
}

function Assert-PluginRuntime([string]$pluginPath, $manifest) {
    $main = [string]$manifest.main
    if (-not $main) { $main = "main.js" }
    Require-File (Join-Path $pluginPath $main)
    $packagePath = Join-Path $pluginPath "package.json"
    if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
        $package = Read-Json $packagePath
        $nodeModules = Join-Path $pluginPath "node_modules"
        foreach ($dependency in @($package.dependencies.PSObject.Properties.Name)) {
            if (-not (Test-Path -LiteralPath (Join-Path $nodeModules $dependency) -PathType Container)) {
                throw "插件 '$($manifest.id)' 缺少运行时依赖 '$dependency'。请先在构建机安装依赖后再打包。"
            }
        }
    }
}

try {
    # 1. 构建前校验入口文件和核心加载器。
    foreach ($file in @("安装.bat", "core.ps1", "LICENSE", "VERSION")) {
        Require-File (Join-Path $root $file)
    }
    $pluginsSrc = Join-Path $root "plugins"
    if (-not (Test-Path -LiteralPath $pluginsSrc -PathType Container)) { throw "缺少插件目录: $pluginsSrc" }
    Require-File (Join-Path $pluginsSrc "plugin-loader.js")

    # 2. 清理并创建 staging。
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    # 3. 复制安装器与版本文件。
    foreach ($file in @("安装.bat", "core.ps1", "LICENSE", "VERSION")) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage -Force
    }
    Write-Host "    安装器与版本文件已复制"

    # 4. 只复制插件运行时文件，排除测试、缓存和源码仓库目录。
    $pluginDest = Join-Path $stage "plugins"
    New-Item -ItemType Directory -Path $pluginDest -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $pluginsSrc "plugin-loader.js") -Destination $pluginDest -Force
    $pluginCount = 0
    foreach ($pluginDir in @(Get-ChildItem -LiteralPath $pluginsSrc -Directory -Force)) {
        $manifestPath = Join-Path $pluginDir.FullName "manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
        $manifest = Read-Json $manifestPath
        if ([string]$manifest.id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "插件 ID 无效: $manifestPath" }
        $pluginTarget = Join-Path $pluginDest ([string]$manifest.id)
        Copy-PluginRuntime $pluginDir.FullName $pluginTarget
        Assert-PluginRuntime $pluginTarget $manifest
        $pluginCount++
    }
    if ($pluginCount -eq 0) { throw "未找到可发布插件" }
    Write-Host "    已复制 $pluginCount 个插件运行时目录 (含 split-view/node_modules)"

    # 5. 压缩到临时文件，校验成功后再替换正式产物。
    if (Test-Path -LiteralPath $zipTemp) { Remove-Item -LiteralPath $zipTemp -Force }
    Compress-Archive -Path $stage -DestinationPath $zipTemp -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipTemp)
    try {
        # Windows PowerShell 生成的 zip 条目可能使用反斜杠，校验时统一为通用分隔符。
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        foreach ($required in @(
            "$stageName/安装.bat",
            "$stageName/core.ps1",
            "$stageName/VERSION",
            "$stageName/plugins/plugin-loader.js"
        )) {
            if ($entryNames -notcontains $required) { throw "发布包缺少条目: $required" }
        }
        if (@($entryNames | Where-Object { $_ -match '/tests/' -or $_ -match '/\.cache/' -or $_ -match '/\.git/' }).Count -gt 0) {
            throw "发布包包含测试或缓存目录"
        }
    } finally {
        $archive.Dispose()
    }

    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Move-Item -LiteralPath $zipTemp -Destination $zip -Force
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashText = "$hash *$([System.IO.Path]::GetFileName($zip))`r`n"
    [System.IO.File]::WriteAllText($sha256, $hashText, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "==> 完成: $zip" -ForegroundColor Green
    Write-Host "    大小: $([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB"
    Write-Host "    SHA-256: $sha256"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath $zipTemp) { Remove-Item -LiteralPath $zipTemp -Force }
}
