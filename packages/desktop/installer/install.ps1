$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

$stagingDirectory = $null
$previousDirectory = $null
$previousInstallMoved = $false
$newInstallMoved = $false
$installCommitted = $false

try {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "La cartella AppData dell'utente non è disponibile."
    }

    $installDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_INSTALL_DIR)) {
        Join-Path $env:LOCALAPPDATA "Programs\Histos Publish"
    } else {
        [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_INSTALL_DIR)
    }
    $installDirectory = [System.IO.Path]::GetFullPath($installDirectory)
    $installDirectory = $installDirectory.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
    $installParent = Split-Path -Parent $installDirectory
    if ((Split-Path -Leaf $installDirectory) -ne "Histos Publish" -or (Split-Path -Leaf $installParent) -ne "Programs") {
        throw "Il percorso di installazione deve terminare con Programs\Histos Publish."
    }

    $archivePath = Join-Path $PSScriptRoot "histos-publish.zip"
    $applicationPath = Join-Path $installDirectory "Histos Publish.exe"
    $startMenuDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_START_MENU_DIR)) {
        Join-Path ([Environment]::GetFolderPath("Programs")) "Histos Publish"
    } else {
        [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_START_MENU_DIR)
    }

    $transactionId = [guid]::NewGuid().ToString("N")
    $stagingDirectory = Join-Path $installParent ".Histos Publish-$transactionId.installing"
    $previousDirectory = Join-Path $installParent ".Histos Publish-$transactionId.previous"
    New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
    try {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDirectory
    } catch {
        throw "L'archivio di installazione histos-publish.zip è danneggiato o non è uno ZIP: $($_.Exception.Message)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDirectory "Histos Publish.exe") -PathType Leaf)) {
        throw "Il programma non è contenuto nell'archivio di installazione."
    }

    Get-Process -Name "Histos Publish" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $installDirectory) {
        if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
            throw "Il percorso di installazione esiste ma non è una cartella."
        }
        [System.IO.Directory]::Move($installDirectory, $previousDirectory)
        $previousInstallMoved = $true
    }
    [System.IO.Directory]::Move($stagingDirectory, $installDirectory)
    $stagingDirectory = $null
    $newInstallMoved = $true

    New-Item -ItemType Directory -Path $startMenuDirectory -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $applicationShortcut = $shell.CreateShortcut((Join-Path $startMenuDirectory "Histos Publish.lnk"))
    $applicationShortcut.TargetPath = $applicationPath
    $applicationShortcut.WorkingDirectory = $installDirectory
    $applicationShortcut.IconLocation = "$applicationPath,0"
    $applicationShortcut.Save()

    $uninstallShortcut = $shell.CreateShortcut((Join-Path $startMenuDirectory "Disinstalla Histos Publish.lnk"))
    $uninstallShortcut.TargetPath = "powershell.exe"
    $uninstallShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $installDirectory 'uninstall.ps1')`""
    $uninstallShortcut.WorkingDirectory = $installDirectory
    $uninstallShortcut.Save()

    $desktopDirectory = if ([string]::IsNullOrWhiteSpace($env:HISTOS_PUBLISH_DESKTOP_DIR)) {
        [Environment]::GetFolderPath("Desktop")
    } else {
        [System.IO.Path]::GetFullPath($env:HISTOS_PUBLISH_DESKTOP_DIR)
    }
    if (-not [string]::IsNullOrWhiteSpace($desktopDirectory)) {
        $desktopShortcut = $shell.CreateShortcut((Join-Path $desktopDirectory "Histos Publish.lnk"))
        $desktopShortcut.TargetPath = $applicationPath
        $desktopShortcut.WorkingDirectory = $installDirectory
        $desktopShortcut.IconLocation = "$applicationPath,0"
        $desktopShortcut.Save()
    }

    $installCommitted = $true
    $backupNotice = ""
    if ($previousInstallMoved -and (Test-Path -LiteralPath $previousDirectory -PathType Container)) {
        try {
            Remove-Item -LiteralPath $previousDirectory -Recurse -Force
            $previousInstallMoved = $false
        } catch {
            $backupNotice = " La vecchia copia è conservata temporaneamente in: $previousDirectory"
        }
    }
    if ($env:HISTOS_PUBLISH_SILENT_INSTALL -ne "1") {
        [System.Windows.Forms.MessageBox]::Show("Histeon Publish è stato installato per l'utente corrente. I dati restano nella cartella AppData.$backupNotice", "Histeon Publish", "OK", "Information") | Out-Null
    }
    exit 0
} catch {
    $failureMessage = "Installazione non riuscita: $($_.Exception.Message)"
    if ($newInstallMoved -and -not $installCommitted -and (Test-Path -LiteralPath $installDirectory -PathType Container)) {
        try {
            Remove-Item -LiteralPath $installDirectory -Recurse -Force
        } catch {
            $failureMessage += " Non è stato possibile rimuovere la nuova cartella; controllala: $installDirectory"
        }
    }
    if ($previousInstallMoved -and -not $installCommitted -and (Test-Path -LiteralPath $previousDirectory -PathType Container)) {
        try {
            if (-not (Test-Path -LiteralPath $installDirectory)) {
                [System.IO.Directory]::Move($previousDirectory, $installDirectory)
                $previousInstallMoved = $false
            } else {
                $failureMessage += " La versione precedente è conservata in: $previousDirectory"
            }
        } catch {
            $failureMessage += " Non è stato possibile ripristinare la versione precedente; il backup resta in: $previousDirectory"
        }
    }
    if ($stagingDirectory -and (Test-Path -LiteralPath $stagingDirectory -PathType Container)) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($env:HISTOS_PUBLISH_SILENT_INSTALL -ne "1") {
        [System.Windows.Forms.MessageBox]::Show($failureMessage, "Histeon Publish", "OK", "Error") | Out-Null
    }
    [Console]::Error.WriteLine($failureMessage)
    exit 1
}
