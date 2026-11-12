<#
.SYNOPSIS
    Прогон настоящего кода снимка отката установщика ETN: каталог-приёмник
    создаётся продуктом, сервер и служба ПЕРЕНОСЯТСЯ, неудачный возврат не
    теряет флаг переноса (ошибка a34f48da, круг доработки 1).

.DESCRIPTION
    Скрипт не запускает продуктовый установщик: он собирает harness-инсталлятор
    Inno, в который дословно вставлены функции из installer/etn.iss
    (TakeSnapshot, UndoSnapshotMoves, NewRollbackDirName, CreateRollbackSnapshot,
    CopyTreeRec и вспомогательные), а заглушены только LogLine, SetInstallStage
    и параметры каталогов. Каталог-приёмник снимка НЕ создаётся заранее: именно
    так его видит продукт — CreateRollbackSnapshot обязан создать его сам.

    Режимы:
      create — вызвать настоящую CreateRollbackSnapshot на дереве app\server и
               app\service при отсутствующем каталоге данных; журнал должен
               содержать «server перенесён» и «service перенесён», без WARN
               «не перенесён»/«скопирован»; исходные каталоги после снимка
               отсутствуют, содержимое снимка совпадает с исходным;
      undo   — вызвать UndoSnapshotMoves, когда вернуть каталог невозможно
               (цель уже существует): флаг переноса обязан остаться True, а
               каталог снимка — на месте (иначе единственная копия файлов
               сервера удаляется вызывающим).

    Проверки:
      snapshot-probe:created            — снимок создан, каталог снимка есть;
      snapshot-probe:server-moved       — server перенесён, не скопирован;
      snapshot-probe:service-moved      — service перенесён, не скопирован;
      snapshot-probe:tree               — снимок совпадает с исходным деревом,
                                          исходные каталоги отсутствуют;
      snapshot-probe:undo-keeps-flag    — неудачный возврат не сбрасывает флаг;
      snapshot-probe:undo-keeps-snapshot — каталог снимка после неудачи цел.

    Нужен Inno Setup 6 (ISCC.exe). Запуск:

        pwsh installer/tests/snapshot-probe.ps1 [-IsccPath <путь к ISCC.exe>]
        pwsh installer/tests/snapshot-probe.ps1 -IssPath <другой etn.iss>  # мутация

    Код возврата: 0 — все проверки зелёные, 1 — есть провалы, 2 — нет ISCC.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$WorkRoot,
    [string]$IsccPath,
    [string]$IssPath,
    [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$repoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$installerDir = Join-Path $repoRoot 'installer'
if (-not $IssPath) { $IssPath = Join-Path $installerDir 'etn.iss' }
$issPath = [System.IO.Path]::GetFullPath($IssPath)
if (-not (Test-Path -LiteralPath $issPath)) { throw "Нет $issPath." }
if (-not $WorkRoot) { $WorkRoot = Join-Path $repoRoot '.tmp\snapshot-probe' }
$workRoot = [System.IO.Path]::GetFullPath($WorkRoot)

. (Join-Path $PSScriptRoot 'iss-guard.ps1')

$results = New-Object System.Collections.Generic.List[object]

function Add-ProbeResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $mark = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-36} {2}" -f $mark, $Name, $Note)
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

function Get-IssConstLine {
    param([string]$Text, [string]$Name)
    foreach ($line in (Get-IssStrippedLines -Text $Text)) {
        if ($line.Trim() -match ('^' + [regex]::Escape($Name) + '\s*=')) { return $line.Trim() }
    }
    throw "В $issPath нет константы $Name."
}

function New-SmallTree {
    param([string]$Root, [int]$Files)
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    for ($i = 0; $i -lt $Files; $i++) {
        $dir = Join-Path $Root ('pkg{0}' -f ($i % 3))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $dir ('file-{0:D3}.txt' -f $i)), ("payload {0}`n" -f $i))
    }
}

$iscc = Find-Iscc -Explicit $IsccPath
if (-not $iscc) {
    Write-Host 'ПРОПУЩЕНО: Inno Setup 6 (ISCC.exe) не найден — укажите -IsccPath.' -ForegroundColor Yellow
    exit 2
}

$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$moveDecl = [regex]::Match($issText, "function MoveFileExW\([\s\S]*?stdcall';").Value
if (-not $moveDecl) { throw "В $issPath нет объявления MoveFileExW." }
$backupLenLine = Get-IssConstLine -Text $issText -Name 'BACKUP_DIR_NAME_LEN'

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$outDir = Join-Path $workRoot 'out'
foreach ($dir in @($outDir)) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$harness = @"
[Setup]
AppName=ETN snapshot probe
AppVersion=1.0
DefaultDirName={tmp}\etn-snapshot-probe
CreateAppDir=no
Uninstallable=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
PrivilegesRequired=lowest
Compression=none
SolidCompression=no
OutputDir=$outDir
OutputBaseFilename=snapshot-probe

[CustomMessages]
EtnStageSnapshot=Snapshot stage

[Code]
var
  GServerDir, GDataDir, GLastRollbackDir, ProbeLog: String;
  GServerFilesPresent, GSnapshotMovedServer, GSnapshotMovedService: Boolean;
  GSnapshotHasServer, GSnapshotHasService: Boolean;

$moveDecl

procedure ExitProcess(uExitCode: Cardinal); external 'ExitProcess@kernel32.dll stdcall';

const
  $backupLenLine

{ Заглушка журнала: строки пишутся в файл пробы в UTF-8, чтобы PowerShell
  прочитал их без мохито. }
procedure LogLine(const Level, Msg: String);
begin
  SaveStringToFile(ProbeLog, Utf8Encode(Level + ': ' + Msg + #13#10), True);
end;

{ Заглушка этапа: мастер в пробе не участвует. }
procedure SetInstallStage(const Stage: String);
begin
end;

$(Get-IssFunctionText -Text $issText -Name 'IsAllDigits')

$(Get-IssFunctionText -Text $issText -Name 'IsBackupDirName')

$(Get-IssFunctionText -Text $issText -Name 'IsRealSubdir')

$(Get-IssFunctionText -Text $issText -Name 'CopyTreeRec')

$(Get-IssFunctionText -Text $issText -Name 'TakeSnapshot')

$(Get-IssFunctionText -Text $issText -Name 'UndoSnapshotMoves')

$(Get-IssFunctionText -Text $issText -Name 'NewRollbackDirName')

$(Get-IssFunctionText -Text $issText -Name 'RollbackRoot')

$(Get-IssFunctionText -Text $issText -Name 'CleanupRollbackSnapshotsExcept')

$(Get-IssFunctionText -Text $issText -Name 'CreateRollbackSnapshot')

function InitializeSetup: Boolean;
var
  Mode, OutPath: String;
  Ok: Boolean;
begin
  Result := False;
  Mode := ExpandConstant('{param:MODE}');
  ProbeLog := ExpandConstant('{param:PROBELOG}');
  OutPath := ExpandConstant('{param:OUT}');
  GDataDir := ExpandConstant('{param:DATADIR}');
  GServerDir := ExpandConstant('{param:APPDIR}');
  GServerFilesPresent := True;
  GSnapshotMovedServer := (ExpandConstant('{param:SETMOVED}') = '1');
  GSnapshotMovedService := False;
  if Mode = 'create' then
  begin
    Ok := CreateRollbackSnapshot();
    SaveStringToFile(OutPath,
      'result=' + IntToStr(Ord(Ok)) + #13#10 +
      'moved_server=' + IntToStr(Ord(GSnapshotMovedServer)) + #13#10 +
      'moved_service=' + IntToStr(Ord(GSnapshotMovedService)) + #13#10 +
      'last=' + GLastRollbackDir + #13#10, False);
    if Ok then ExitProcess(0) else ExitProcess(5);
  end
  else if Mode = 'undo' then
  begin
    UndoSnapshotMoves(ExpandConstant('{param:SNAPSHOT}'));
    SaveStringToFile(OutPath,
      'moved_server=' + IntToStr(Ord(GSnapshotMovedServer)) + #13#10 +
      'moved_service=' + IntToStr(Ord(GSnapshotMovedService)) + #13#10, False);
    ExitProcess(0);
  end;
  ExitProcess(6);
end;
"@

$harnessPath = Join-Path $workRoot 'snapshot-probe.iss'
[System.IO.File]::WriteAllText($harnessPath, $harness, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Inno: {0}" -f $iscc)
Write-Host ("Источник кода: {0}" -f $issPath)
$compileOut = & $iscc "/O$outDir" $harnessPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host $compileOut
    throw "ISCC завершился с кодом $LASTEXITCODE."
}
$exe = Join-Path $outDir 'snapshot-probe.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Сборка не дала $exe." }

function Invoke-Probe {
    param([hashtable]$Arguments)
    $list = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    foreach ($key in $Arguments.Keys) { $list += ('/{0}={1}' -f $key, $Arguments[$key]) }
    $process = Start-Process -FilePath $exe -PassThru -Wait -ArgumentList $list
    return $process.ExitCode
}

function Read-ProbeLog {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8))
}

function Read-ProbeOut {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) -split "`r?`n")) {
        if ($line -match '^([a-z_]+)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
    }
    return $map
}

function Get-TreeHashLines {
    param([string]$Root)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($file in (Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($rootFull.Length).TrimStart('\')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $lines.Add(($relative + '|' + $file.Length + '|' + $hash))
    }
    return @($lines)
}

# --- create: настоящая CreateRollbackSnapshot без предсозданного каталога ---
$createRoot = Join-Path $workRoot 'create'
if (Test-Path -LiteralPath $createRoot) { Remove-Item -LiteralPath $createRoot -Recurse -Force }
$appDir = Join-Path $createRoot 'app'
$dataDir = Join-Path $createRoot 'data'
New-SmallTree -Root (Join-Path $appDir 'server') -Files 25
New-SmallTree -Root (Join-Path $appDir 'service') -Files 3
$hashServer = Get-TreeHashLines -Root (Join-Path $appDir 'server')
$hashService = Get-TreeHashLines -Root (Join-Path $appDir 'service')
$createLog = Join-Path $createRoot 'probe.log'
$createOut = Join-Path $createRoot 'probe.out'

$createCode = Invoke-Probe -Arguments @{
    MODE = 'create'; APPDIR = $appDir; DATADIR = $dataDir; PROBELOG = $createLog; OUT = $createOut; SNAPSHOT = ''
}
$log = Read-ProbeLog -Path $createLog
$out = Read-ProbeOut -Path $createOut
$last = [string]$out['last']
$snapshotServer = if ($last) { Join-Path $last 'server' } else { '' }

Add-ProbeResult -Name 'snapshot-probe:created' -Ok (
    ($createCode -eq 0) -and ($out['result'] -eq '1') -and $last -and (Test-Path -LiteralPath $last)
) -Note ("код {0}, снимок «{1}»" -f $createCode, $last)

$serverMoved = ($log -match 'INFO: Снимок отката: server перенесён') -and
    ($log -notmatch 'server не перенесён') -and ($log -notmatch 'server скопирован')
Add-ProbeResult -Name 'snapshot-probe:server-moved' -Ok $serverMoved `
    -Note $(if ($serverMoved) { 'server перенесён, копии нет' } else { 'журнал: ' + (($log -split "`r?`n" | Where-Object { $_ -match 'server' }) -join ' | ') })

$serviceMoved = ($log -match 'INFO: Снимок отката: service перенесён') -and
    ($log -notmatch 'service не перенесён') -and ($log -notmatch 'service скопирован')
Add-ProbeResult -Name 'snapshot-probe:service-moved' -Ok $serviceMoved `
    -Note $(if ($serviceMoved) { 'service перенесён, копии нет' } else { 'журнал: ' + (($log -split "`r?`n" | Where-Object { $_ -match 'service' }) -join ' | ') })

$snapshotOk = $snapshotServer -and (Test-Path -LiteralPath $snapshotServer) -and
    (Test-Path -LiteralPath (Join-Path $last 'service')) -and
    (-not (Test-Path -LiteralPath (Join-Path $appDir 'server'))) -and
    (-not (Test-Path -LiteralPath (Join-Path $appDir 'service'))) -and
    (((Get-TreeHashLines -Root $snapshotServer) -join "`n") -eq ($hashServer -join "`n")) -and
    (((Get-TreeHashLines -Root (Join-Path $last 'service')) -join "`n") -eq ($hashService -join "`n"))
Add-ProbeResult -Name 'snapshot-probe:tree' -Ok $snapshotOk `
    -Note ("файлов в снимке server: {0}; исходные каталоги на месте: server={1}, service={2}" -f `
        $(if ($snapshotServer -and (Test-Path -LiteralPath $snapshotServer)) { (Get-TreeHashLines -Root $snapshotServer).Count } else { -1 }), `
        (Test-Path -LiteralPath (Join-Path $appDir 'server')), (Test-Path -LiteralPath (Join-Path $appDir 'service')))

# --- undo: неудачный возврат не сбрасывает флаг и не теряет снимок ---
$undoRoot = Join-Path $workRoot 'undo'
if (Test-Path -LiteralPath $undoRoot) { Remove-Item -LiteralPath $undoRoot -Recurse -Force }
$undoApp = Join-Path $undoRoot 'app'
$undoSnapshot = Join-Path $undoRoot 'snapshot'
New-SmallTree -Root (Join-Path $undoApp 'server') -Files 2
New-SmallTree -Root (Join-Path $undoSnapshot 'server') -Files 2
$undoLog = Join-Path $undoRoot 'probe.log'
$undoOut = Join-Path $undoRoot 'probe.out'
$undoCode = Invoke-Probe -Arguments @{
    MODE = 'undo'; APPDIR = $undoApp; DATADIR = (Join-Path $undoRoot 'data'); PROBELOG = $undoLog
    OUT = $undoOut; SNAPSHOT = $undoSnapshot; SETMOVED = '1'
}
$undoResult = Read-ProbeOut -Path $undoOut
Add-ProbeResult -Name 'snapshot-probe:undo-keeps-flag' -Ok (
    ($undoCode -eq 0) -and ($undoResult['moved_server'] -eq '1')
) -Note ("код {0}, флаг переноса после неудачи: {1}" -f $undoCode, $undoResult['moved_server'])
$snapshotKept = (Test-Path -LiteralPath (Join-Path $undoSnapshot 'server')) -and
    ((Get-ChildItem -LiteralPath (Join-Path $undoSnapshot 'server') -Recurse -File -Force | Measure-Object).Count -gt 0)
Add-ProbeResult -Name 'snapshot-probe:undo-keeps-snapshot' -Ok $snapshotKept `
    -Note ("каталог снимка цел: {0}" -f $snapshotKept)

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Снимок отката (настоящий код): {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
    exit 1
}
exit 0
