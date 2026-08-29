# =====================================================================
# BetterTypora 安装器
# =====================================================================
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -Uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -Uninstall -Purge
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -Uninstall -KeepPlugins
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -TyporaDir "D:\Tools\Typora\resources"
#   powershell -NoProfile -ExecutionPolicy Bypass -File core.ps1 -TyporaDir "D:\Tools\Typora\resources" -Yes
#
# 功能:
#   1. 自动定位 Typora 的 resources 目录 (运行进程 / 注册表 / 显式指定)
#   2. 备份 window.html, 并对注入行做幂等处理
#   3. 对 BetterTypora 管理的插件目录执行直接完整替换, 清理已废弃文件
#   4. 仅备份 window.html, 插件目录不备份、不回滚
#   5. -Uninstall: 移除注入行并清理 BetterTypora 管理的插件; -KeepPlugins 可保留插件目录
# =====================================================================

param(
    [string]$TyporaDir = "",
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$KeepPlugins,
    [switch]$NoBackup,
    [switch]$DetectOnly,
    [switch]$Force,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsSrc = Join-Path $scriptDir "plugins"
$loaderSrc = Join-Path $pluginsSrc "plugin-loader.js"
$injectLine = '<script src="./plugins/plugin-loader.js"></script>'
$installerVersion = "1.1.0"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "!!  $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

function Get-FullPath([string]$value) {
    return [System.IO.Path]::GetFullPath($value).TrimEnd('\', '/')
}

function Get-FileHashValue([string]$filePath) {
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash
}

function Test-PluginId([string]$id) {
    return ($id -match '^[A-Za-z0-9][A-Za-z0-9._-]*$')
}

function Get-ManagedPlugins {
    $result = @()
    $ids = @{}
    $pluginDirs = @(Get-ChildItem -LiteralPath $pluginsSrc -Directory -Force)
    foreach ($dir in $pluginDirs) {
        $manifestPath = Join-Path $dir.FullName "manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            throw "无法解析插件清单: $manifestPath; $($_.Exception.Message)"
        }
        $id = [string]$manifest.id
        if (-not $id -or -not (Test-PluginId $id)) { throw "插件 ID 无效: $manifestPath" }
        if ($ids.ContainsKey($id)) { throw "发现重复插件 ID '$id': $manifestPath" }
        $mainName = [string]$manifest.main
        if (-not $mainName) { $mainName = "main.js" }
        $mainPath = Join-Path $dir.FullName $mainName
        if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf)) { throw "插件 '$id' 缺少入口文件: $mainPath" }
        $ids[$id] = $true
        $result += [PSCustomObject]@{ Id = $id; Path = $dir.FullName; Version = [string]$manifest.version }
    }
    return $result
}

function Read-State([string]$statePath) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        Write-Warn "BetterTypora 安装状态文件无法解析, 将按无状态处理: $statePath"
        return $null
    }
}

function Get-StatePluginIds($state) {
    $ids = @()
    if ($state -and $state.managedPlugins) {
        foreach ($id in @($state.managedPlugins)) {
            $value = [string]$id
            if ($value -and (Test-PluginId $value)) { $ids += $value }
        }
    }
    return $ids
}

function Write-State([string]$statePath, $state) {
    $json = $state | ConvertTo-Json -Depth 6
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($statePath, $json, $utf8)
}

function Copy-DirectoryContents([string]$source, [string]$destination) {
    if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Directory -Path $destination -Force | Out-Null }
    foreach ($item in @(Get-ChildItem -LiteralPath $source -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
    }
}

function Test-WriteAccess([string]$directory) {
    $probe = Join-Path $directory (".bettertypora-write-test-" + [Guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::WriteAllText($probe, "BetterTypora")
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $false
    }
}

# ---------------------------------------------------------------------
# 无参数 → 交互菜单 (双击 安装.bat 时的入口)
# ---------------------------------------------------------------------
if (-not $Uninstall -and -not $DetectOnly -and -not $TyporaDir) {
    Write-Host ""
    Write-Host "  ============ BetterTypora 安装器 ============" -ForegroundColor Cyan
    Write-Host "    1. 安装      (安装或更新)"
    Write-Host "    2. 卸载      (移除注入行, 清理 BetterTypora 插件)"
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

# 卸载默认清理 BetterTypora 自身的插件和设置；需要仅移除注入时使用 -KeepPlugins。
if ($KeepPlugins -and -not $Uninstall) {
    Write-Err "-KeepPlugins 只能与 -Uninstall 一起使用"
    exit 1
}
if ($Uninstall -and -not $KeepPlugins) { $Purge = $true }

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

function Get-LoaderScriptPattern {
    $doubleQuote = [char]34
    $singleQuote = [char]39
    $src = "(?:" + $doubleQuote + "\.\/plugins\/plugin-loader\.js" + $doubleQuote + "|" + $singleQuote + "\.\/plugins\/plugin-loader\.js" + $singleQuote + ")"
    # 仅匹配一个完整的 loader 节点。不使用跨标签的通配符，避免误吞 Typora 原生脚本；
    # loader 可能紧跟在 <body> 后面，因此不能要求它位于行首。
    return "(?i)<script\b(?=[^>]*\bsrc\s*=\s*$src)[^>]*>\s*</script\s*>"
}

function Test-HtmlHasLoader([string]$html) {
    return [regex]::IsMatch($html, (Get-LoaderScriptPattern))
}

function Remove-LoaderScript([string]$html) {
    return [regex]::Replace($html, (Get-LoaderScriptPattern), "")
}

function Add-LoaderScript([string]$html) {
    if (Test-HtmlHasLoader $html) { return $html }
    if ([regex]::IsMatch($html, '(?i)</body\s*>')) {
        return [regex]::Replace($html, '(?i)</body\s*>', ($injectLine + "`r`n</body>"), 1)
    }
    return ($html.TrimEnd() + "`r`n" + $injectLine + "`r`n")
}

# ---------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------
Write-Step "BetterTypora 安装器 v$installerVersion"

if (-not (Test-Path -LiteralPath $pluginsSrc -PathType Container)) {
    Write-Err "未找到插件目录: $pluginsSrc (请把 core.ps1 放在发布包或仓库根目录运行)"
    exit 1
}
if (-not (Test-Path -LiteralPath $loaderSrc -PathType Leaf)) {
    Write-Err "未找到核心加载器: $loaderSrc (发布包不完整)"
    exit 1
}

$sourcePlugins = @(Get-ManagedPlugins)
$sourcePluginIds = @($sourcePlugins | ForEach-Object { $_.Id })
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

$resources = Get-FullPath $resources
$windowHtml = Join-Path $resources "window.html"
$pluginsDest = Join-Path $resources "plugins"
$loaderDest = Join-Path $pluginsDest "plugin-loader.js"
$statePath = Join-Path $pluginsDest ".bettertypora-state.json"
if (-not (Test-Path -LiteralPath $windowHtml -PathType Leaf)) {
    Write-Err "window.html 不存在: $windowHtml (目录不对?)"
    exit 1
}

$running = @(Get-Process typora -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $Force) {
    Write-Err "检测到 Typora 正在运行。请完全退出 Typora 后再安装或卸载。"
    Write-Err "如确认文件未被占用，可使用 -Force 继续，但不建议在运行中更新插件。"
    exit 1
}

if (-not (Test-WriteAccess $resources)) {
    Write-Err "没有写入权限: $resources"
    Write-Err "请以管理员身份运行安装器, 或将 Typora 安装到当前用户可写目录。"
    exit 1
}

# --- 执行前确认 (Y/N) ---
if ($Uninstall) {
    if ($Purge) {
        if ($Yes) { $answer = "Y" } else { $answer = Read-Host "  将移除注入行并删除 BetterTypora 管理的插件目录 (保留用户插件与 .cache)。继续? (Y/N)" }
    } else {
        if ($Yes) { $answer = "Y" } else { $answer = Read-Host "  将移除 BetterTypora 注入行, 插件目录默认保留。继续? (Y/N)" }
    }
} else {
    if ($Yes) { $answer = "Y" } else { $answer = Read-Host "  将安装或更新 BetterTypora 到 $resources (完整替换受管插件目录)。继续? (Y/N)" }
}
if ($answer -notmatch '^[Yy]') {
    Write-Ok "已取消, 未做任何改动"
    exit 0
}

# --- 注入/移除注入行 ---
$hadBom = Test-HtmlHasBom $windowHtml
$html = Read-Html $windowHtml
$already = Test-HtmlHasLoader $html
$state = Read-State $statePath

if ($Uninstall) {
    Write-Step "卸载模式"
    try {
        if ($already) {
            $backupWindow = "$windowHtml.bettertypora.bak"
            $canRestore = (-not $NoBackup) -and (Test-Path -LiteralPath $backupWindow -PathType Leaf) -and $state -and $state.windowAfterHash -and ((Get-FileHashValue $windowHtml) -eq [string]$state.windowAfterHash)
            if ($canRestore) {
                Copy-Item -LiteralPath $backupWindow -Destination $windowHtml -Force
                Write-Ok "已根据未被修改的状态恢复原 window.html"
            } else {
                if ((Test-Path -LiteralPath $backupWindow -PathType Leaf) -and -not $NoBackup) {
                    Write-Warn "window.html 在安装后被修改, 为避免覆盖用户改动，仅移除 BetterTypora 注入行。原始备份仍保留。"
                }
                Write-Html $windowHtml (Remove-LoaderScript $html) $hadBom
                Write-Ok "已移除 BetterTypora 注入行"
            }
        } else {
            Write-Ok "window.html 未包含 BetterTypora 注入, 无需处理"
        }

        if ($Purge -and (Test-Path -LiteralPath $pluginsDest -PathType Container)) {
            $purgeIds = @(Get-StatePluginIds $state)
            if ($purgeIds.Count -eq 0) { $purgeIds = $sourcePluginIds }
            foreach ($id in $purgeIds) {
                $targetPlugin = Join-Path $pluginsDest $id
                if (Test-Path -LiteralPath $targetPlugin -PathType Container) {
                    Remove-Item -LiteralPath $targetPlugin -Recurse -Force
                    Write-Ok "已清理插件目录: $id"
                }
                $cacheFile = Join-Path $pluginsDest (".cache\" + $id + ".settings.json")
                if (Test-Path -LiteralPath $cacheFile -PathType Leaf) {
                    Remove-Item -LiteralPath $cacheFile -Force
                }
            }
            if (Test-Path -LiteralPath $loaderDest -PathType Leaf) {
                Remove-Item -LiteralPath $loaderDest -Force
                Write-Ok "已清理核心加载器: plugin-loader.js"
            }
            if (Test-Path -LiteralPath $statePath -PathType Leaf) {
                Remove-Item -LiteralPath $statePath -Force
            }
        }
        Write-Step "卸载完成"
    } catch {
        Write-Err "卸载失败: $($_.Exception.Message)"
        exit 1
    }
    exit 0
}

# --- 安装/更新 ---
Write-Step "安装"
try {
    if (-not (Test-Path -LiteralPath $pluginsDest -PathType Container)) {
        New-Item -ItemType Directory -Path $pluginsDest -Force | Out-Null
    }

    # 只备份 window.html。插件目录采用直接替换，避免旧版插件文件残留。
    if (-not $NoBackup) {
        $backupWindow = "$windowHtml.bettertypora.bak"
        if (-not (Test-Path -LiteralPath $backupWindow -PathType Leaf)) {
            Copy-Item -LiteralPath $windowHtml -Destination $backupWindow -Force
            Write-Ok "已备份原文件: window.html.bettertypora.bak"
        } else {
            Write-Ok "保留已有原始备份: window.html.bettertypora.bak"
        }
    }

    foreach ($plugin in $sourcePlugins) {
        $targetPlugin = Join-Path $pluginsDest $plugin.Id
        if (Test-Path -LiteralPath $targetPlugin -PathType Container) {
            Remove-Item -LiteralPath $targetPlugin -Recurse -Force
        }
        New-Item -ItemType Directory -Path $targetPlugin -Force | Out-Null
        Copy-DirectoryContents $plugin.Path $targetPlugin
        Write-Ok "已完整替换插件目录: $($plugin.Id)"
    }

    # 只清理上一次由 BetterTypora 管理、但本次发行包已移除的插件。
    $previousIds = @(Get-StatePluginIds $state)
    foreach ($oldId in $previousIds) {
        if ($sourcePluginIds -notcontains $oldId) {
            $oldPluginPath = Join-Path $pluginsDest $oldId
            if (Test-Path -LiteralPath $oldPluginPath -PathType Container) {
                Remove-Item -LiteralPath $oldPluginPath -Recurse -Force
                Write-Ok "已清理已移除的旧插件目录: $oldId"
            }
        }
    }

    Copy-Item -LiteralPath $loaderSrc -Destination $loaderDest -Force
    Write-Ok "已更新核心加载器: plugin-loader.js"

    $beforeHash = Get-FileHashValue $windowHtml
    $newHtml = Add-LoaderScript $html
    if ($newHtml -ne $html) {
        Write-Html $windowHtml $newHtml $hadBom
        Write-Ok "注入完成: $injectLine"
    } else {
        Write-Ok "window.html 已注入过, 跳过注入"
    }

    $afterHash = Get-FileHashValue $windowHtml
    $newState = [ordered]@{
        installerVersion = $installerVersion
        installedAt = (Get-Date).ToString("o")
        managedPlugins = $sourcePluginIds
        windowBeforeHash = $beforeHash
        windowAfterHash = $afterHash
    }
    Write-State $statePath $newState

    Write-Step "安装完成"
    Write-Host ""
    Write-Host "  请完全退出并重启 Typora (设置 → 插件 页面可查看/开关插件)" -ForegroundColor Yellow
} catch {
    Write-Err "安装失败: $($_.Exception.Message)"
    Write-Warn "插件目录可能已部分更新，请重新运行安装器完成安装。"
    exit 1
}
