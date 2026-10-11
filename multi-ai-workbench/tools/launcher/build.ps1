<#
  构建 Windows 一键启动器：multi-ai-workbench\启动工作台.exe

  用 Windows 自带的 csc.exe（.NET Framework 4.x）编译，不需要装 .NET SDK / Visual Studio。
  图标由 make-icon.mjs 生成（ICO 是二进制格式，用 Node 写比在 PowerShell 里拼字节省心）。

  用法： powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1
#>
$ErrorActionPreference = 'Stop'

# 脚本位于 multi-ai-workbench\tools\launcher，向上两级即项目根目录
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$icon = Join-Path $here 'app.ico'
$source = Join-Path $here 'Launcher.cs'
$output = Join-Path $root '启动工作台.exe'

Write-Host "项目根目录：$root"

# ---------------------------------------------------------------- 1) 图标
if (-not (Test-Path $icon)) {
  Write-Host "图标不存在，调用 Node 生成：$icon"
  & node (Join-Path $here 'make-icon.mjs')
  if ($LASTEXITCODE -ne 0) { throw "生成图标失败，退出码 $LASTEXITCODE" }
}

# ---------------------------------------------------------------- 2) 找编译器
$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $null
foreach ($candidate in $candidates) {
  if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) { throw '找不到 csc.exe：这台机器缺少 .NET Framework 4.x' }
Write-Host "编译器：$csc"

# ---------------------------------------------------------------- 3) 编译
& $csc /nologo /codepage:65001 /target:winexe /optimize+ /platform:anycpu `
  "/out:$output" `
  "/win32icon:$icon" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "$source"
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

# ---------------------------------------------------------------- 4) 结果
$size = (Get-Item $output).Length
Write-Host ""
Write-Host "编译完成：$output" -ForegroundColor Green
Write-Host ("体积：{0:N0} 字节" -f $size)