# Silent per-user NSIS lifecycle: install -> hidden smoke -> upgrade -> hidden smoke -> uninstall.
# No elevation, no visible windows; installs into a temporary directory and removes it afterwards.
# Usage: ./scripts/installer-lifecycle.ps1 -Installer <old-setup.exe> -Upgrade <new-setup.exe> -UpgradeVersion 0.1.1
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Upgrade, [Parameter(Mandatory)][string]$UpgradeVersion)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP "opendraft-install-$([guid]::NewGuid())"
$userData = Join-Path $env:APPDATA 'OpenDraft'
$hadUserData = Test-Path $userData
$marker = Join-Path $userData "opendraft-lifecycle-$([guid]::NewGuid()).txt"
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\OpenDraft.lnk'
function Entries { @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'OpenDraft*' }) }
function Check([bool]$ok, [string]$name) { if (-not $ok) { throw "FAILED: $name" }; Write-Output "PASS: $name" }
function Run([string]$file, [string[]]$arguments) { (Start-Process $file -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden).ExitCode }
function Smoke {
  # npm writes notices to stderr; run through cmd so PowerShell 5.1 does not treat them as errors.
  $env:OPENDRAFT_EXECUTABLE = Join-Path $dir 'OpenDraft.exe'
  cmd /c "npx playwright test tests/e2e/desktop.spec.ts --reporter=line 2>&1" | Out-Host
  $code = $LASTEXITCODE; Remove-Item Env:OPENDRAFT_EXECUTABLE; $code
}
Check (@(Entries).Count -eq 0) 'no existing OpenDraft installation'
try {
  Check ((Run $Installer @('/S', "/D=$dir")) -eq 0) 'silent install exit code'
  Check (Test-Path (Join-Path $dir 'OpenDraft.exe')) 'executable installed'
  Check ((Get-ChildItem (Join-Path $dir 'licenses')).Count -ge 11) 'license notices installed'
  Check (@(Entries).Count -eq 1) 'single uninstall registry entry'
  Check (Test-Path $shortcut) 'Start Menu shortcut'
  Check ((Smoke) -eq 0) 'hidden smoke on installed app'
  New-Item -ItemType Directory -Force $userData | Out-Null; Set-Content $marker 'lifecycle' -Encoding utf8
  Check ((Run $Upgrade @('/S', "/D=$dir")) -eq 0) 'silent upgrade exit code'
  Check ((@(Entries).Count -eq 1) -and (@(Entries)[0].DisplayVersion -eq $UpgradeVersion)) "registry reports $UpgradeVersion"
  Check (Test-Path $marker) 'user data preserved across upgrade'
  Check ((Smoke) -eq 0) 'hidden smoke on upgraded app'
  $uninstaller = Get-ChildItem $dir -Filter 'Uninstall OpenDraft.exe' | Select-Object -First 1
  Check ((Run $uninstaller.FullName @('/S', "_?=$dir")) -eq 0) 'silent uninstall exit code'
  Check (-not (Test-Path (Join-Path $dir 'OpenDraft.exe'))) 'executable removed'
  Check (@(Entries).Count -eq 0) 'registry entry removed'
  Check (-not (Test-Path $shortcut)) 'Start Menu shortcut removed'
  Check (Test-Path $marker) 'user data retained after uninstall (documented default)'
} finally {
  # Always run the real uninstaller for an install this script created, before deleting its directory.
  $leftover = Join-Path $dir 'Uninstall OpenDraft.exe'
  if ((Test-Path $leftover) -and @(Entries | Where-Object { $_.UninstallString -like "*$dir*" }).Count) { Run $leftover @('/S', "_?=$dir") | Out-Null }
  Remove-Item -Force $marker -ErrorAction SilentlyContinue
  if (-not $hadUserData) { Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
