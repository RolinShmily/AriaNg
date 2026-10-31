[CmdletBinding()]
param (
    [string] $DataDir = [System.IO.Path]::Combine($env:USERPROFILE, '.aria2'),
    [string] $DownloadDir = [System.IO.Path]::Combine($env:USERPROFILE, 'Downloads'),
    [ValidateRange(1, 65535)]
    [int] $RpcPort = 6800,
    [ValidateRange(0, 2147483647)]
    [int] $ParentProcessId = 0,
    [string] $Aria2Path = [System.IO.Path]::Combine($env:USERPROFILE, 'scoop/apps/aria2/current/aria2c.exe')
)

$ErrorActionPreference = 'Stop'
# Preserve native exit codes even when PowerShell 7's native error preference is enabled.
$PSNativeCommandUseErrorActionPreference = $false

function New-RpcSecret {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    }
    finally {
        $random.Dispose()
    }

    return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

try {
    foreach ($pathArgument in @(
        @{ Name = 'DataDir'; Value = $DataDir },
        @{ Name = 'DownloadDir'; Value = $DownloadDir },
        @{ Name = 'Aria2Path'; Value = $Aria2Path }
    )) {
        if ([string]::IsNullOrWhiteSpace($pathArgument.Value)) {
            throw ('{0} must not be empty.' -f $pathArgument.Name)
        }
        if ($pathArgument.Value.Contains("`r") -or $pathArgument.Value.Contains("`n")) {
            throw ('{0} must not contain newline characters.' -f $pathArgument.Name)
        }
    }

    $DataDir = [System.IO.Path]::GetFullPath($DataDir)
    $DownloadDir = [System.IO.Path]::GetFullPath($DownloadDir)
    $Aria2Path = [System.IO.Path]::GetFullPath($Aria2Path)

    if (-not [System.IO.File]::Exists($Aria2Path)) {
        throw ('aria2 executable was not found: {0}' -f $Aria2Path)
    }

    [System.IO.Directory]::CreateDirectory($DataDir) | Out-Null
    [System.IO.Directory]::CreateDirectory($DownloadDir) | Out-Null

    $configPath = [System.IO.Path]::Combine($DataDir, 'aria2.conf')
    $sessionPath = [System.IO.Path]::Combine($DataDir, 'aria2.session')
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    if (-not [System.IO.File]::Exists($sessionPath)) {
        # CreateNew cannot truncate an existing session, including one created concurrently.
        $sessionFile = [System.IO.File]::Open(
            $sessionPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $sessionFile.Dispose()
    }

    if (-not [System.IO.File]::Exists($configPath)) {
        $secret = New-RpcSecret
        $dhtPath = [System.IO.Path]::Combine($DataDir, 'dht.dat')
        $dht6Path = [System.IO.Path]::Combine($DataDir, 'dht6.dat')
        $configLines = @(
            "dir=$DownloadDir",
            'continue=true',
            'auto-save-interval=60',
            "input-file=$sessionPath",
            "save-session=$sessionPath",
            'save-session-interval=60',
            "dht-file-path=$dhtPath",
            "dht-file-path6=$dht6Path",
            'enable-dht=true',
            'enable-peer-exchange=true',
            'seed-time=0',
            'rpc-save-upload-metadata=true',
            'bt-save-metadata=true',
            'bt-load-saved-metadata=true',
            'enable-rpc=true',
            'rpc-listen-all=false',
            "rpc-listen-port=$RpcPort",
            'rpc-allow-origin-all=true',
            "rpc-secret=$secret",
            'daemon=false',
            'show-console-readout=false',
            'summary-interval=0'
        )
        [System.IO.File]::WriteAllText(
            $configPath,
            ($configLines -join [System.Environment]::NewLine) + [System.Environment]::NewLine,
            $utf8NoBom
        )
    }
    else {
        # Detect a pre-existing BOM so appending does not mix text encodings.
        $reader = New-Object System.IO.StreamReader($configPath, $utf8NoBom, $true)
        try {
            $configText = $reader.ReadToEnd()
            $configEncoding = $reader.CurrentEncoding
        }
        finally {
            $reader.Dispose()
        }

        $lastSecret = ''
        foreach ($line in ($configText -split '\r\n|\n|\r')) {
            # Comment lines do not match. A later empty assignment overrides an earlier secret.
            if ($line -cmatch '^[\t ]*rpc-secret[\t ]*=(.*)$') {
                $lastSecret = $Matches[1].Trim()
            }
        }

        if ([string]::IsNullOrWhiteSpace($lastSecret)) {
            $separator = ''
            if ($configText.Length -gt 0 -and
                -not $configText.EndsWith("`n") -and
                -not $configText.EndsWith("`r")) {
                $separator = [System.Environment]::NewLine
            }
            $secret = New-RpcSecret
            [System.IO.File]::AppendAllText(
                $configPath,
                $separator + 'rpc-secret=' + $secret + [System.Environment]::NewLine,
                $configEncoding
            )
        }
    }

    # Keep credentials in the config file, never in arguments or script output.
    $aria2Arguments = @(
        "--conf-path=$configPath",
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        "--rpc-listen-port=$RpcPort",
        '--rpc-allow-origin-all=true',
        '--daemon=false',
        "--input-file=$sessionPath",
        "--save-session=$sessionPath",
        '--save-session-interval=60'
    )
    if ($ParentProcessId -gt 0) {
        $aria2Arguments += "--stop-with-process=$ParentProcessId"
    }

    # Keep aria2's relative runtime files outside the replaceable WebUI package.
    Set-Location -LiteralPath $DataDir
    & $Aria2Path @aria2Arguments
    exit $LASTEXITCODE
}
catch {
    Write-Error ('aria2 startup failed: {0}' -f $_.Exception.Message) -ErrorAction Continue
    exit 1
}
