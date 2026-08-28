# =====================================================================
# BetterTypora 安装器
# =====================================================================
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -Uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -TyporaDir "D:\Tools\Typora\resources"
#
# 功能:
#   1. 自动定位 Typora 的 resources 目录 (运行进程 / 注册表卸载信息 / 显式指定)
#   2. 备份 window.html → window.html.bettertypora.bak
#   3. 幂等注入 <script src="./plugins/plugin-loader.js"> (已注入则跳过)
#   4. 复制 plugins/ 目录 (含 plugin-loader.js)
#   5. -Uninstall: 移除注入行恢复原样 (插件目录保留)
# =====================================================================

param(
    [string]$TyporaDir = "",
    [switch]$Uninstall,
    [switch]$NoBackup,
    [switch]$DetectOnly
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsSrc = Join-Path $scriptDir "plugins"
$injectLine = '<script src="./plugins/plugin-loader.js"></script>'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "!!  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------
# 无参数 → 交互菜单 (双击 安装.bat 时的入口)
# ---------------------------------------------------------------------
if (-not $Uninstall -and -not $DetectOnly -and -not $TyporaDir) {
    Write-Host ""
    Write-Host "  ============ BetterTypora 安装器 ============" -ForegroundColor Cyan
    Write-Host "    1. 安装      (安装或更新)"
    Write-Host "    2. 卸载      (移除注入行, 保留插件目录)"
    Write-Host "    3. 仅检测    (显示 Typora 路径, 不改动)"
    Write-Host "    4. 退出"
    Write-Host "  =============================================" -ForegroundColor Cyan
    $menuChoice = Read-Host "  请选择 [1-4]"
    if ($menuChoice -eq "2")      { $Uninstall = $true }
    elseif ($menuChoice -eq "3")  { $DetectOnly = $true }
    elseif ($menuChoice -eq "4" -or $menuChoice -eq "") { Write-Ok "已退出"; exit 0 }
    elseif ($menuChoice -ne "1")  { Write-Err "无效选择: $menuChoice"; exit 1 }
    # "1" 或直接回车 → 默认安装, 继续
}

# ---------------------------------------------------------------------
# 定位 Typora resources 目录
# ---------------------------------------------------------------------
function Find-TyporaResources {
    if ($TyporaDir) {
        if (Test-Path $TyporaDir) { return $TyporaDir }
        Write-Err "指定的目录不存在: $TyporaDir"
        exit 1
    }
    # 1. 正在运行的 Typora 进程 (最可靠)
    try {
        $proc = Get-Process typora -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.Path -and (Test-Path $proc.Path)) {
            $res = Join-Path (Split-Path -Parent $proc.Path) "resources"
            if (Test-Path $res) { return $res }
        }
    } catch {}
    # 2. 注册表 App Paths (应用路径注册, 默认值 = exe 完整路径; 便携版也常注册)
    $appPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Typora.exe",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Typora.exe",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Typora.exe"
    )
    foreach ($k in $appPaths) {
        try {
            if (-not (Test-Path $k)) { continue }
            $prop = Get-ItemProperty $k -ErrorAction SilentlyContinue
            $exePath = $prop.'(default)'
            if ($exePath -and (Test-Path $exePath)) {
                $res = Join-Path (Split-Path -Parent $exePath) "resources"
                if (Test-Path $res) { return $res }
            }
        } catch {}
    }
    # 3. 注册表卸载信息 (安装器写入的权威路径, 覆盖标准安装位置)
    $uninstallKeys = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Typora",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Typora",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Typora"
    )
    foreach ($k in $uninstallKeys) {
        try {
            if (-not (Test-Path $k)) { continue }
            $prop = Get-ItemProperty $k -ErrorAction SilentlyContinue
            # InstallLocation: "C:\Program Files\Typora"
            $loc = $prop.InstallLocation
            if ($loc -and (Test-Path $loc)) {
                $res = Join-Path $loc "resources"
                if (Test-Path $res) { return $res }
            }
            # DisplayIcon: "C:\Program Files\Typora\Typora.exe" (可能带 ,0 参数)
            $icon = $prop.DisplayIcon
            if ($icon) {
                $exe = (($icon -split ",")[0]).Trim('"').Trim()
                if ($exe -and (Test-Path $exe)) {
                    $res = Join-Path (Split-Path -Parent $exe) "resources"
                    if (Test-Path $res) { return $res }
                }
            }
        } catch {}
    }
    # 4. 常见安装路径兜底 (便携版未注册注册表时)
    $candidates = @(
        "$env:ProgramFiles\Typora\resources",
        "${env:ProgramFiles(x86)}\Typora\resources",
        "$env:LOCALAPPDATA\Programs\Typora\resources",
        "$env:LOCALAPPDATA\Typora\resources",
        "$env:USERPROFILE\scoop\apps\typora\current\resources"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

# ---------------------------------------------------------------------
# 文件夹选择器 — 用户手动挑选 Typora resources 目录
# 兼容两种选择: 直接选 resources 目录, 或选 Typora 安装根目录 (自动补 resources)
# ---------------------------------------------------------------------
function Select-ResourcesFolder {
    try {
        Add-Type -AssemblyName System.Windows.Forms
    } catch {
        return $null
    }
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "请选择 Typora 的 resources 目录 (Typora 安装目录下的 resources 文件夹)"
    $dlg.ShowNewFolderButton = $false
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        return $null
    }
    $p = $dlg.SelectedPath
    if (-not $p) { return $null }
    if (Test-Path (Join-Path $p "window.html")) { return $p }
    $sub = Join-Path $p "resources"
    if (Test-Path (Join-Path $sub "window.html")) { return $sub }
    return $null
}

# ---------------------------------------------------------------------
# 读写 window.html (保持原编码, 保留/不保留 BOM 与原文件一致)
# ---------------------------------------------------------------------
function Read-Html([string]$path) {
    return [System.IO.File]::ReadAllText($path)   # 自动检测编码 (UTF-8/BOM/ANSI)
}

function Write-Html([string]$path, [string]$text, [bool]$hadBom) {
    $utf8 = New-Object System.Text.UTF8Encoding($hadBom)
    [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function Test-HtmlHasBom([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}

# ---------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------
Write-Step "BetterTypora 安装器 v1.0.0"

if (-not (Test-Path $pluginsSrc)) {
    Write-Err "未找到插件目录: $pluginsSrc (请把 core.ps1 放在仓库根目录运行)"
    exit 1
}

$resources = Find-TyporaResources

if ($DetectOnly) {
    if (-not $resources) {
        Write-Err "未检测到 Typora 路径 (检测模式)"
        exit 1
    }
    Write-Ok "Typora resources: $resources"
    Write-Ok "检测模式: 仅定位, 不执行安装"
    exit 0
}

if (-not $resources) {
    # 自动检测失败 → 文件夹选择器
    Write-Err "未自动检测到 Typora 安装目录, 请手动选择"
    $resources = Select-ResourcesFolder
    if (-not $resources) {
        Write-Err "未选择有效目录, 已退出"
        exit 1
    }
    Write-Ok "已选择: $resources"
} elseif (-not $TyporaDir) {
    # 自动检测到的路径 → 用户确认是否使用
    Write-Ok "检测到 Typora: $resources"
    $usePath = Read-Host "  是否使用此路径? (Y/N)"
    if ($usePath -notmatch '^[Yy]') {
        $resources = Select-ResourcesFolder
        if (-not $resources) {
            Write-Err "未选择有效目录, 已退出"
            exit 1
        }
        Write-Ok "已选择: $resources"
    }
}

$windowHtml = Join-Path $resources "window.html"
if (-not (Test-Path $windowHtml)) {
    Write-Err "window.html 不存在: $windowHtml (目录不对?)"
    exit 1
}

# --- 执行前确认 (Y/N) ---
if ($Uninstall) {
    $answer = Read-Host "  将移除 BetterTypora 注入行, 恢复原 window.html (已备份)。继续? (Y/N)"
} else {
    $answer = Read-Host "  将安装 BetterTypora 到 $resources (备份 + 注入 + 复制插件)。继续? (Y/N)"
}
if ($answer -notmatch '^[Yy]') {
    Write-Ok "已取消, 未做任何改动"
    exit 0
}

# --- 注入/移除注入行 ---
$hadBom = Test-HtmlHasBom $windowHtml
$html = Read-Html $windowHtml
$already = $html -match 'src="\./plugins/plugin-loader\.js"'

if ($Uninstall) {
    Write-Step "卸载模式: 移除注入行"
    if (-not $already) {
        Write-Ok "window.html 未包含 BetterTypora 注入, 无需处理"
    } else {
        if (-not $NoBackup) {
            Copy-Item $windowHtml "$windowHtml.bettertypora.bak" -Force
            Write-Ok "已备份原文件: window.html.bettertypora.bak"
        }
        $html = $html -replace '<script src="\./plugins/plugin-loader\.js">\s*', ""
        Write-Html $windowHtml $html $hadBom
        Write-Ok "已移除注入行。plugins/ 目录保留, 手动删除 resources/plugins/ 即完全清除"
    }
    Write-Ok "卸载完成"
    exit 0
}

# --- 安装 ---
Write-Step "安装"
if ($already) {
    Write-Ok "window.html 已注入过, 跳过注入"
} else {
    if (-not $NoBackup) {
        Copy-Item $windowHtml "$windowHtml.bettertypora.bak" -Force
        Write-Ok "已备份原文件: window.html.bettertypora.bak"
    }
    if ($html -match '(?i)</body>') {
        $html = $html -replace '(?i)</body>', "$injectLine</body>"
    } else {
        $html = $html.TrimEnd() + "`r`n$injectLine"   # 无 </body> 兜底: 追加末尾
    }
    Write-Html $windowHtml $html $hadBom
    Write-Ok "注入完成: $injectLine"
}

# --- 复制插件目录 ---
$pluginsDest = Join-Path $resources "plugins"
if (Test-Path $pluginsDest) {
    # 只更新不删除: 保留用户已有的 .cache 与自定义插件
    Copy-Item (Join-Path $pluginsSrc "*") -Destination $pluginsDest -Recurse -Force
    Write-Ok "插件目录已更新: $pluginsDest (已存在的插件覆盖, 其余保留)"
} else {
    Copy-Item $pluginsSrc -Destination $pluginsDest -Recurse -Force
    Write-Ok "插件目录已复制: $pluginsDest"
}

Write-Step "完成"
Write-Host ""
Write-Host "  请完全退出并重启 Typora (设置 → 插件 页面可查看/开关插件)" -ForegroundColor Yellow
