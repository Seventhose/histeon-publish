param([switch]$Quiet)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

if (-not $Quiet) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Vuoi disinstallare Histeon Publish? Siti, cronologia e segreti restano nella cartella AppData.",
        "Disinstalla Histeon Publish",
        "YesNo",
        "Question"
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
        exit 0
    }
}

$installDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_INSTALL_DIR)) {
    Join-Path $env:LOCALAPPDATA "Programs\Histos Publish"
} else {
    [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_INSTALL_DIR)
}
$installDirectory = [System.IO.Path]::GetFullPath($installDirectory)
$installDirectory = $installDirectory.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
$installParent = Split-Path -Parent $installDirectory
# Same guard as install.ps1: the recursive removal below must never reach a folder that is not ours.
if ((Split-Path -Leaf $installDirectory) -ne "Histos Publish" -or (Split-Path -Leaf $installParent) -ne "Programs") {
    $message = "Il percorso di installazione deve terminare con Programs\Histos Publish: disinstallazione annullata."
    if (-not $Quiet) {
        [System.Windows.Forms.MessageBox]::Show($message, "Disinstalla Histeon Publish", "OK", "Error") | Out-Null
    }
    Write-Error $message -ErrorAction Continue
    exit 1
}
$startMenuDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_START_MENU_DIR)) {
    Join-Path ([Environment]::GetFolderPath("Programs")) "Histos Publish"
} else {
    [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_START_MENU_DIR)
}
$desktopDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_DESKTOP_DIR)) {
    [Environment]::GetFolderPath("Desktop")
} else {
    [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_DESKTOP_DIR)
}
$applicationShortcut = Join-Path $startMenuDirectory "Histos Publish.lnk"
$uninstallShortcut = Join-Path $startMenuDirectory "Disinstalla Histos Publish.lnk"
$desktopShortcut = Join-Path $desktopDirectory "Histos Publish.lnk"
Remove-Item -LiteralPath $applicationShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $uninstallShortcut -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $startMenuDirectory -PathType Container) {
    $remainingStartMenuItem = Get-ChildItem -LiteralPath $startMenuDirectory -Force | Select-Object -First 1
    if ($null -eq $remainingStartMenuItem) {
        Remove-Item -LiteralPath $startMenuDirectory -Force -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue

$escapedInstallDirectory = $installDirectory.Replace("'", "''")
$cleanupScript = "Start-Sleep -Seconds 2; Remove-Item -LiteralPath '$escapedInstallDirectory' -Recurse -Force -ErrorAction SilentlyContinue"
$encodedCleanup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanupScript))
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCleanup) -WindowStyle Hidden -WorkingDirectory ([System.IO.Path]::GetTempPath())
exit 0
