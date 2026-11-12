<#
.SYNOPSIS
    Прогон журнала установщика ETN: два и более запуска в одну секунду не
    теряют и не смешивают журналы (ошибка f7887a35).

.DESCRIPTION
    Скрипт НЕ запускает продуктовый установщик: он собирает крошечный
    harness-инсталлятор Inno, в который дословно вставлен код журнала из
    installer/etn.iss (AppendUtf8Line, LogProbeWritten, TryInitLog, LogLine и
    константа LOG_NAME_ATTEMPTS), и запускает его несколько раз одновременно.
    Все экземпляры ждут общий барьер, поэтому TryInitLog у них выполняется в
    одну и ту же секунду — ровно тот сценарий, в котором имя журнала
    совпадало и журнал терялся.

    Проверки:
      log-race:distinct-files   — каждый запуск создал СВОЙ файл журнала
                                  (число файлов равно числу запусков);
      log-race:own-line         — в каждом файле есть строка именно своего
                                  запуска (записи не подмешались);
      log-race:confirmed-name   — имя каждого файла совпадает с тем, что
                                  установщик записал в last-<tag>.txt
                                  (журнал реально создан, а не «FileExists»).

    Нужен Inno Setup 6 (ISCC.exe). Путь — параметром -IsccPath или поиском в
    стандартных каталогах. Запуск:

        pwsh installer/tests/log-race.ps1 [-IsccPath <путь к ISCC.exe>]
        pwsh installer/tests/log-race.ps1 -IssPath <другой etn.iss>   # мутация

    Код возврата: 0 — все проверки зелёные, 1 — есть провалы, 2 — нет ISCC.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$WorkRoot,
    [string]$IsccPath,
    [string]$IssPath,
    [int]$Runs = 8,
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$repoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$installerDir = Join-Path $repoRoot 'installer'
if (-not $IssPath) { $IssPath = Join-Path $installerDir 'etn.iss' }
$issPath = [System.IO.Path]::GetFullPath($IssPath)
if (-not (Test-Path -LiteralPath $issPath)) { throw "Нет $issPath." }
if (-not $WorkRoot) { $WorkRoot = Join-Path $repoRoot '.tmp\log-race' }
$workRoot = [System.IO.Path]::GetFullPath($WorkRoot)

. (Join-Path $PSScriptRoot 'iss-guard.ps1')

$results = New-Object System.Collections.Generic.List[object]

function Add-RaceResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $mark = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-28} {2}" -f $mark, $Name, $Note)
}

function Find-Iscc {
    param([string]$Explicit)
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Explicit) { $candidates.Add($Explicit) }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if ($base) { $candidates.Add((Join-Path $base 'Inno Setup 6\ISCC.exe')) }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

<# Текст функции из etn.iss: строка объявления + тело без комментариев.
    Комментарии вырезает общий хелпер iss-guard.ps1, поэтому harness собирается
    из того же кода, что компилируется в продуктовом установщике. #>
function Get-IssFunctionText {
    param([string]$Text, [string]$Name)
    $lines = @(Get-IssStrippedLines -Text $Text)
    $declPattern = '^\s*(function|procedure)\s+' + [regex]::Escape($Name) + '\b'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $declPattern) {
            $decl = $lines[$i]
            $body = Get-IssFunctionBody -Text $Text -Name $Name
            return ($decl + "`n" + $body)
        }
    }
    throw "В $issPath нет функции $Name."
}

$iscc = Find-Iscc -Explicit $IsccPath
if (-not $iscc) {
    Write-Host 'ПРОПУЩЕНО: Inno Setup 6 (ISCC.exe) не найден — укажите -IsccPath.' -ForegroundColor Yellow
    exit 2
}

$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$attemptsLine = $null
foreach ($line in (Get-IssStrippedLines -Text $issText)) {
    if ($line.Trim() -match '^LOG_NAME_ATTEMPTS\s*=') { $attemptsLine = $line.Trim(); break }
}
if (-not $attemptsLine) { throw "В $issPath нет константы LOG_NAME_ATTEMPTS." }

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$logDir = Join-Path $workRoot 'logs'
$outDir = Join-Path $workRoot 'out'
foreach ($dir in @($logDir, $outDir)) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$harness = @"
[Setup]
AppName=ETN log race harness
AppVersion=1.0
DefaultDirName={tmp}\etn-log-race
CreateAppDir=no
Uninstallable=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
PrivilegesRequired=lowest
Compression=none
SolidCompression=no
OutputDir=$outDir
OutputBaseFilename=log-race

[Code]
var
  GLogPath: String;

{ Внешняя функция — та же, что объявлена в etn.iss: код возврата harness-процесса. }
procedure ExitProcess(uExitCode: Cardinal); external 'ExitProcess@kernel32.dll stdcall';

const
  $attemptsLine

$(Get-IssFunctionText -Text $issText -Name 'IfStr')

$(Get-IssFunctionText -Text $issText -Name 'RedactLine')

$(Get-IssFunctionText -Text $issText -Name 'AppendUtf8Line')

$(Get-IssFunctionText -Text $issText -Name 'LogLine')

$(Get-IssFunctionText -Text $issText -Name 'LogProbeWritten')

$(Get-IssFunctionText -Text $issText -Name 'TryInitLog')

{ Барьер: все экземпляры объявляют готовность и ждут файл go, поэтому вызов
  TryInitLog у них попадает в одну секунду — сценарий ошибки f7887a35. }
function WaitBarrier(const Dir, Tag: String): Boolean;
var
  I: Integer;
begin
  SaveStringToFile(Dir + '\ready-' + Tag, Tag, False);
  Result := False;
  for I := 1 to 3000 do
  begin
    if FileExists(Dir + '\go') then
    begin
      Result := True;
      Exit;
    end;
    Sleep(10);
  end;
end;

function InitializeSetup: Boolean;
var
  Dir, Tag: String;
begin
  Result := False;
  Dir := ExpandConstant('{param:LOGDIR}');
  Tag := ExpandConstant('{param:TAG}');
  if not WaitBarrier(Dir, Tag) then ExitProcess(4);
  if not TryInitLog(Dir, 'install', 'ETN setup log') then ExitProcess(3);
  LogLine('INFO', 'harness run ' + Tag);
  SaveStringToFile(Dir + '\last-' + Tag + '.txt', GLogPath, False);
  ExitProcess(0);
end;
"@

$harnessPath = Join-Path $workRoot 'log-race.iss'
[System.IO.File]::WriteAllText($harnessPath, $harness, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Inno: {0}" -f $iscc)
Write-Host ("Источник кода: {0}" -f $issPath)
$compileOut = & $iscc "/O$outDir" $harnessPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host $compileOut
    throw "ISCC завершился с кодом $LASTEXITCODE."
}
$exe = Join-Path $outDir 'log-race.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Сборка не дала $exe." }

# Запуск: N экземпляров одновременно, барьер — общий файл go.
$tags = 1..$Runs | ForEach-Object { 'run{0:D2}' -f $_ }
$processes = @()
foreach ($tag in $tags) {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        ('/LOGDIR=' + $logDir), ('/TAG=' + $tag))
    $processes += Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
}
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $ready = @(Get-ChildItem -LiteralPath $logDir -Filter 'ready-*' -File -ErrorAction SilentlyContinue)
    if ($ready.Count -ge $Runs) { break }
    Start-Sleep -Milliseconds 50
}
New-Item -ItemType File -Path (Join-Path $logDir 'go') -Force | Out-Null
foreach ($process in $processes) {
    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        try { $process.Kill() } catch { }
    }
}

$logs = @(Get-ChildItem -LiteralPath $logDir -Filter 'install-*.log' -File -ErrorAction SilentlyContinue)
$reported = @()
foreach ($tag in $tags) {
    $mapPath = Join-Path $logDir ('last-' + $tag + '.txt')
    if (Test-Path -LiteralPath $mapPath) {
        $reported += [pscustomobject]@{
            Tag  = $tag
            Path = ([System.IO.File]::ReadAllText($mapPath)).Trim()
        }
    }
}

Add-RaceResult -Name 'log-race:distinct-files' -Ok ($logs.Count -eq $Runs) `
    -Note ("запусков {0}, журналов {1} ({2})" -f $Runs, $logs.Count, (($logs.Name | Sort-Object) -join ', '))

$ownLine = 0
foreach ($tag in $tags) {
    $file = $logs | Where-Object { $_.Name -like '*.log' } |
        Where-Object { ([System.IO.File]::ReadAllText($_.FullName)) -match ('harness run ' + $tag + '\b') } |
        Select-Object -First 1
    if ($file) { $ownLine += 1 }
}
Add-RaceResult -Name 'log-race:own-line' -Ok ($ownLine -eq $Runs) `
    -Note ("строку своего запуска нашли в журнале: {0} из {1}" -f $ownLine, $Runs)

$confirmed = 0
foreach ($item in $reported) {
    if ($item.Path -and (Test-Path -LiteralPath $item.Path)) { $confirmed += 1 }
}
$uniqueReported = @($reported | Where-Object { $_.Path } | ForEach-Object { $_.Path } | Sort-Object -Unique)
Add-RaceResult -Name 'log-race:confirmed-name' -Ok (($confirmed -eq $Runs) -and ($uniqueReported.Count -eq $Runs)) `
    -Note ("подтверждённых путей {0}, уникальных {1} из {2}" -f $confirmed, $uniqueReported.Count, $Runs)

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Журнал и гонка запусков: {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
    exit 1
}
exit 0
