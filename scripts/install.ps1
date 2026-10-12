param(
  [string]$Source,
  [string]$InstallRoot,
  [string]$Manifest,
  [switch]$DryRun,
  [switch]$NoLaunch,
  [switch]$NoRuntimeInstall
)
$ErrorActionPreference = 'Stop'
if (-not $Manifest) { $Manifest = Join-Path $PSScriptRoot '..\install-manifest.json' }
$growthManifest = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if (-not $InstallRoot) {
  if ($env:GROWTH_DATA_DIR) { $InstallRoot = $env:GROWTH_DATA_DIR }
  else { $InstallRoot = Join-Path $env:LOCALAPPDATA 'GrowthTimelapseStudio' }
}
if (-not $Source -and -not $DryRun -and -not $growthManifest.release.published) {
  throw '内测安装包尚未发布。维护者可用 -Source 验证本地源码；不会下载 main 分支代替发行包。'
}
$growthArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($growthArch -ne 'X64') { throw 'Windows 安装器目前仅提供 x64 方案。' }
$growthNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($growthNode) {
  & $growthNode -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
  if ($LASTEXITCODE -ne 0) { $growthNode = $null }
}
if (-not $growthNode) {
  if ($DryRun) { Write-Output 'DRY RUN: 将校验并下载官方 Node.js 24.19.0 到用户数据目录。'; exit 0 }
  if ($NoRuntimeInstall) { throw '未找到 Node.js 24+；-NoRuntimeInstall 已禁止安装本机依赖。' }
  $growthAsset = $growthManifest.node.'win32-x64'
  if ($growthManifest.node.version -ne '24.19.0' -or $growthAsset.url -ne 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' -or $growthAsset.sha256 -ne '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73') {
    throw 'Node bootstrap 清单与固定官方发行包不一致。'
  }
  $growthRuntimeParent = Join-Path $InstallRoot 'runtimes\node\24.19.0'
  $growthRuntime = Join-Path $growthRuntimeParent 'win32-x64'
  $growthNode = Join-Path $growthRuntime 'node.exe'
  if (-not (Test-Path -LiteralPath $growthNode)) {
    $growthCache = Join-Path $InstallRoot 'cache'
    New-Item -ItemType Directory -Path $growthCache,$growthRuntimeParent -Force | Out-Null
    $growthArchive = Join-Path $growthCache 'node-v24.19.0-win-x64.zip'
    if (-not (Test-Path -LiteralPath $growthArchive) -or (Get-FileHash -LiteralPath $growthArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $growthAsset.sha256) {
      Invoke-WebRequest -Uri $growthAsset.url -OutFile ($growthArchive + '.part') -UseBasicParsing
      if ((Get-FileHash -LiteralPath ($growthArchive + '.part') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $growthAsset.sha256) {
        Remove-Item -LiteralPath ($growthArchive + '.part') -Force
        throw 'Node.js SHA256 校验失败，已停止。'
      }
      Move-Item -LiteralPath ($growthArchive + '.part') -Destination $growthArchive -Force
    }
    $growthStage = Join-Path $growthRuntimeParent ('.stage-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $growthArchive -DestinationPath $growthStage
    Move-Item -LiteralPath (Join-Path $growthStage 'node-v24.19.0-win-x64') -Destination $growthRuntime
    Remove-Item -LiteralPath $growthStage -Force
  }
  $env:PATH = $growthRuntime + ';' + $env:PATH
}
$growthArgs = @((Join-Path $PSScriptRoot 'install.mjs'), '--install-root', $InstallRoot)
$growthArgs += @('--manifest', $Manifest)
if ($Source) { $growthArgs += @('--source', $Source) }
if ($DryRun) { $growthArgs += '--dry-run' }
if ($NoLaunch) { $growthArgs += '--no-launch' }
if ($NoRuntimeInstall) { $growthArgs += '--no-runtime-install' }
& $growthNode @growthArgs
exit $LASTEXITCODE
