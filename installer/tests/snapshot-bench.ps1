<#
.SYNOPSIS
    Замер снимка отката установщика ETN на НАСТОЯЩЕМ коде: снимок создаётся
    CreateRollbackSnapshot, возврат — ReplaceTreeFromSnapshot (ошибка a34f48da).

.DESCRIPTION
    Скрипт не запускает продуктовый установщик: он собирает harness-инсталлятор
    Inno, в который дословно вставлен код снимка из installer/etn.iss, а
    заглушены только LogLine, SetInstallStage и параметры каталогов. Стенд
    повторяет путь продукта: каталог данных заранее НЕ создаётся (его создаёт
    CreateRollbackSnapshot), каталог-приёмник снимка тоже; «до» — побайтовая
    копия CopyTreeRec, «после» — настоящий снимок и настоящий откат.

    Источник дерева — installer/payload/server (10 721 файл, 65 МБ: та
    раскладка, снимок которой в реальной установке шёл 48–72 с в silent и
    больше 20 минут в GUI). Payload нет или -Synthetic — строится синтетическое
    дерево из мелких файлов (-Files, -FileSizeKb).

    Проверки:
      snapshot-bench:copy-integrity      — копия совпадает с источником;
      snapshot-bench:snapshot-real       — журнал настоящего снимка: server и
                                           service ПЕРЕНЕСЕНЫ, без WARN и
                                           «скопирован» (блокер приёмки 1);
      snapshot-bench:snapshot-integrity  — снимок совпадает с исходным деревом,
                                           исходные каталоги отсутствуют;
      snapshot-bench:snapshot-instant    — снимок не медленнее копии/5 и < 2 с;
      snapshot-bench:rollback-real       — откат вернул каталоги переносом;
      snapshot-bench:rollback-integrity  — после отката дерево то же;
      snapshot-bench:rollback-instant    — откат так же быстр;
      snapshot-bench:restore-missing-keeps — нет каталога в снимке, хотя он был
                                           на месте (Expected) — откат не
                                           трогает файлы и сообщает неудачу;
      snapshot-bench:restore-absent-removes — каталога не было и нет в снимке —
                                           откат убирает текущий каталог.

    Нужен Inno Setup 6 (ISCC.exe). Запуск:

        pwsh installer/tests/snapshot-bench.ps1 [-IsccPath <путь к ISCC.exe>]
        pwsh installer/tests/snapshot-bench.ps1 -Synthetic -Files 5000

    Код возврата: 0 — проверки зелёные, 1 — провал, 2 — нет ISCC.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$WorkRoot,
    [string]$IsccPath,
    [string]$IssPath,
    [string]$Source,
    [switch]$Synthetic,
    [int]$Files = 6000,
    [int]$FileSizeKb = 4,
    [int]$TimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$repoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$installerDir = Join-Path $repoRoot 'installer'
if (-not $IssPath) { $IssPath = Join-Path $installerDir 'etn.iss' }
$issPath = [System.IO.Path]::GetFullPath($IssPath)
if (-not (Test-Path -LiteralPath $issPath)) { throw "Нет $issPath." }
if (-not $WorkRoot) { $WorkRoot = Join-Path $repoRoot '.tmp\snapshot-bench' }
$workRoot = [System.IO.Path]::GetFullPath($WorkRoot)

. (Join-Path $PSScriptRoot 'iss-guard.ps1')

$results = New-Object System.Collections.Generic.List[object]

function Add-BenchResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $mark = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-38} {2}" -f $mark, $Name, $Note)
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

function Get-IssFunctionText {
    param([string]$Text, [string]$Name)
    $lines = @(Get-IssStrippedLines -Text $Text)
    $declPattern = '^\s*(function|procedure)\s+' + [regex]::Escape($Name) + '\b'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $declPattern) {
            return ($lines[$i] + "`n" + (Get-IssFunctionBody -Text $Text -Name $Name))
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

<# Хэш дерева: относительный путь + длина + SHA-256 содержимого. Доказывает, что
    снимок и откат не потеряли и не подменили ни одного файла. #>
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

function New-SmallTree {
    param([string]$Root, [int]$Files)
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    for ($i = 0; $i -lt $Files; $i++) {
        $dir = Join-Path $Root ('pkg{0}' -f ($i % 4))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $dir ('file-{0:D3}.txt' -f $i)), ("payload {0}`n" -f $i))
    }
}

if (-not $Source) { $Source = Join-Path $installerDir 'payload\server' }
$sourceKind = 'payload'
if ($Synthetic -or -not (Test-Path -LiteralPath $Source)) {
    $sourceKind = 'synthetic'
    $Source = Join-Path $workRoot 'synthetic-source'
}

$iscc = Find-Iscc -Explicit $IsccPath
if (-not $iscc) {
    Write-Host 'ПРОПУЩЕНО: Inno Setup 6 (ISCC.exe) не найден — укажите -IsccPath.' -ForegroundColor Yellow
    exit 2
}

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$outDir = Join-Path $workRoot 'out'
$appDir = Join-Path $workRoot 'app'
$dataDir = Join-Path $workRoot 'data'
$copyDest = Join-Path $workRoot 'copy\server'
foreach ($dir in @($outDir, $appDir, $dataDir, (Join-Path $workRoot 'copy'))) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
foreach ($dir in @($outDir, $appDir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

if ($sourceKind -eq 'synthetic') {
    # Реалистичный набор: много мелких файлов в глубокой вложенности плюс
    # несколько крупных — как node_modules в поставке сервера.
    Write-Host ("Синтетическое дерево: {0} файлов по {1} КБ" -f $Files, $FileSizeKb)
    $rng = [System.Random]::new(20261112)
    $payload = [byte[]]::new($FileSizeKb * 1024)
    for ($i = 0; $i -lt $Files; $i++) {
        $dir = Join-Path $Source ('pkg{0}\lib\nested{1}' -f ($i % 40), ($i % 7))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $rng.NextBytes($payload)
        [System.IO.File]::WriteAllBytes((Join-Path $dir ('module-{0:D5}.js' -f $i)), $payload)
    }
    [System.IO.File]::WriteAllBytes((Join-Path $Source 'big.bin'), [byte[]]::new(32MB))
}

$sourceFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File -Force)
$sourceBytes = ($sourceFiles | Measure-Object -Property Length -Sum).Sum
Write-Host ("Источник ({0}): {1} файлов, {2:N1} МБ — {3}" -f $sourceKind, $sourceFiles.Count,
    ($sourceBytes / 1MB), $Source)

# Рабочая копия «установленного» каталога: замеряем не её создание, а операции
# снимка. robocopy с /MT — только подготовка стенда, в замер не входит.
$appServer = Join-Path $appDir 'server'
& robocopy $Source $appServer /E /MT:8 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy подготовки стенда вернул $LASTEXITCODE." }
$appService = Join-Path $appDir 'service'
New-SmallTree -Root $appService -Files 5

$hashServer = Get-TreeHashLines -Root $appServer
$hashService = Get-TreeHashLines -Root $appService

$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$moveDecl = [regex]::Match($issText, "function MoveFileExW\([\s\S]*?stdcall';").Value
if (-not $moveDecl) { throw "В $issPath нет объявления MoveFileExW." }
$backupLenLine = Get-IssConstLine -Text $issText -Name 'BACKUP_DIR_NAME_LEN'

$harness = @"
[Setup]
AppName=ETN snapshot bench
AppVersion=1.0
DefaultDirName={tmp}\etn-snapshot-bench
CreateAppDir=no
Uninstallable=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
PrivilegesRequired=lowest
Compression=none
SolidCompression=no
OutputDir=$outDir
OutputBaseFilename=snapshot-bench

[CustomMessages]
EtnStageSnapshot=Snapshot stage

[Code]
var
  GServerDir, GDataDir, GLastRollbackDir, BenchLog: String;
  GServerFilesPresent, GSnapshotMovedServer, GSnapshotMovedService: Boolean;
  GSnapshotHasServer, GSnapshotHasService: Boolean;

$moveDecl

procedure ExitProcess(uExitCode: Cardinal); external 'ExitProcess@kernel32.dll stdcall';

const
  $backupLenLine

$(Get-IssFunctionText -Text $issText -Name 'AppendUtf8Line')

{ Заглушка журнала: строки пишутся в файл замера тем же писателем UTF-8. }
procedure LogLine(const Level, Msg: String);
begin
  AppendUtf8Line(BenchLog, Level + ': ' + Msg);
end;

{ Заглушка этапа: мастер в замере не участвует. }
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

$(Get-IssFunctionText -Text $issText -Name 'IfStr')

$(Get-IssFunctionText -Text $issText -Name 'CreateRollbackSnapshot')

$(Get-IssFunctionText -Text $issText -Name 'ReplaceTreeFromSnapshot')

{ Настройка стенда: каталоги программы и данных, журнал, файл результата. }
procedure InitBench;
begin
  BenchLog := ExpandConstant('{param:BENCHLOG}');
  GDataDir := ExpandConstant('{param:DATADIR}');
  GServerDir := ExpandConstant('{param:APPDIR}');
  GLastRollbackDir := ExpandConstant('{param:LAST}');
  GServerFilesPresent := True;
end;

procedure WriteOut(const Text: String);
begin
  SaveStringToFile(ExpandConstant('{param:OUT}'), Text, False);
end;

function InitializeSetup: Boolean;
var
  Mode, Src, Dest: String;
  Ok: Boolean;
begin
  Result := False;
  Mode := ExpandConstant('{param:MODE}');
  Src := ExpandConstant('{param:SRC}');
  Dest := ExpandConstant('{param:DEST}');
  InitBench;
  if Mode = 'copy' then
  begin
    if CopyTreeRec(Src, Dest) then ExitProcess(0) else ExitProcess(5);
  end
  else if Mode = 'snapshot' then
  begin
    Ok := CreateRollbackSnapshot();
    WriteOut('result=' + IntToStr(Ord(Ok)) + #13#10 +
      'moved_server=' + IntToStr(Ord(GSnapshotMovedServer)) + #13#10 +
      'moved_service=' + IntToStr(Ord(GSnapshotMovedService)) + #13#10 +
      'last=' + GLastRollbackDir + #13#10);
    if Ok then ExitProcess(0) else ExitProcess(5);
  end
  else if Mode = 'rollback' then
  begin
    Ok := ReplaceTreeFromSnapshot(GLastRollbackDir + '\server',
      GServerDir + '\server', 'server', True);
    if Ok then
      Ok := ReplaceTreeFromSnapshot(GLastRollbackDir + '\service',
        GServerDir + '\service', 'service', True);
    WriteOut('result=' + IntToStr(Ord(Ok)) + #13#10);
    if Ok then ExitProcess(0) else ExitProcess(5);
  end
  else if Mode = 'missing' then
  begin
    Ok := ReplaceTreeFromSnapshot(Src, Dest, 'server', True);
    WriteOut('result=' + IntToStr(Ord(Ok)) + #13#10);
    ExitProcess(0);
  end
  else if Mode = 'absent' then
  begin
    Ok := ReplaceTreeFromSnapshot(Src, Dest, 'server', False);
    WriteOut('result=' + IntToStr(Ord(Ok)) + #13#10);
    ExitProcess(0);
  end;
  ExitProcess(6);
end;
"@

$harnessPath = Join-Path $workRoot 'snapshot-bench.iss'
[System.IO.File]::WriteAllText($harnessPath, $harness, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Inno: {0}" -f $iscc)
$compileOut = & $iscc "/O$outDir" $harnessPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host $compileOut
    throw "ISCC завершился с кодом $LASTEXITCODE."
}
$exe = Join-Path $outDir 'snapshot-bench.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Сборка не дала $exe." }

function Invoke-Harness {
    param([hashtable]$Arguments)
    $list = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    foreach ($key in $Arguments.Keys) { $list += ('/{0}={1}' -f $key, $Arguments[$key]) }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $exe -PassThru -Wait -ArgumentList $list
    $watch.Stop()
    return [pscustomobject]@{ Code = $process.ExitCode; Ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 1) }
}

function Read-BenchOut {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) -split "`r?`n")) {
        if ($line -match '^([a-z_]+)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
    }
    return $map
}

function Read-BenchLog {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8))
}

$benchLog = Join-Path $workRoot 'bench.log'
$benchOut = Join-Path $workRoot 'bench.out'
foreach ($path in @($benchLog, $benchOut)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }

# 1. «До»: прежний снимок — побайтовая копия. Родитель приёмника не создаётся:
#    CopyTreeRec создаёт его сам, как и продукт.
$copy = Invoke-Harness -Arguments @{ MODE = 'copy'; SRC = $appServer; DEST = $copyDest; BENCHLOG = $benchLog; APPDIR = $appDir; DATADIR = $dataDir; OUT = $benchOut; LAST = '' }
$hashCopy = Get-TreeHashLines -Root $copyDest
Add-BenchResult -Name 'snapshot-bench:copy-integrity' -Ok (
    ($copy.Code -eq 0) -and (($hashCopy -join "`n") -eq ($hashServer -join "`n"))
) -Note ("копия {0:N1} с, файлов {1}, код {2}" -f ($copy.Ms / 1000), $hashCopy.Count, $copy.Code)

# 2. «После»: настоящий снимок. Каталог данных отсутствует — CreateRollbackSnapshot
#    обязан создать и RollbackRoot, и каталог-приёмник сам.
$snapshot = Invoke-Harness -Arguments @{ MODE = 'snapshot'; SRC = ''; DEST = ''; BENCHLOG = $benchLog; APPDIR = $appDir; DATADIR = $dataDir; OUT = $benchOut; LAST = '' }
$snapshotOut = Read-BenchOut -Path $benchOut
$logText = Read-BenchLog -Path $benchLog
$last = [string]$snapshotOut['last']
$movedClean = ($logText -match 'INFO: Снимок отката: server перенесён') -and
    ($logText -match 'INFO: Снимок отката: service перенесён') -and
    ($logText -notmatch 'Снимок отката: server не перенесён') -and
    ($logText -notmatch 'Снимок отката: server скопирован') -and
    ($logText -notmatch 'Снимок отката: service не перенесён') -and
    ($logText -notmatch 'Снимок отката: service скопирован')
Add-BenchResult -Name 'snapshot-bench:snapshot-real' -Ok (
    ($snapshot.Code -eq 0) -and ($snapshotOut['result'] -eq '1') -and $movedClean
) -Note $(if ($movedClean) { 'server и service перенесены, копий нет' } else { 'журнал: ' + (($logText -split "`r?`n" | Where-Object { $_ -match 'Снимок отката' }) -join ' | ') })

$snapshotServer = if ($last) { Join-Path $last 'server' } else { '' }
$snapshotService = if ($last) { Join-Path $last 'service' } else { '' }
$snapshotIntegrity = $snapshotServer -and (Test-Path -LiteralPath $snapshotServer) -and
    (Test-Path -LiteralPath $snapshotService) -and
    (-not (Test-Path -LiteralPath $appServer)) -and (-not (Test-Path -LiteralPath $appService)) -and
    (((Get-TreeHashLines -Root $snapshotServer) -join "`n") -eq ($hashServer -join "`n")) -and
    (((Get-TreeHashLines -Root $snapshotService) -join "`n") -eq ($hashService -join "`n"))
Add-BenchResult -Name 'snapshot-bench:snapshot-integrity' -Ok ([bool]$snapshotIntegrity) `
    -Note ("файлов в снимке server: {0}, service: {1}; исходные каталоги на месте: server={2}, service={3}" -f `
        $(if ($snapshotServer -and (Test-Path -LiteralPath $snapshotServer)) { (Get-TreeHashLines -Root $snapshotServer).Count } else { -1 }), `
        $(if ($snapshotService -and (Test-Path -LiteralPath $snapshotService)) { (Get-TreeHashLines -Root $snapshotService).Count } else { -1 }), `
        (Test-Path -LiteralPath $appServer), (Test-Path -LiteralPath $appService))

$factor = if ($snapshot.Ms -gt 0) { [math]::Round($copy.Ms / $snapshot.Ms, 1) } else { [double]::PositiveInfinity }
Add-BenchResult -Name 'snapshot-bench:snapshot-instant' -Ok (
    ($snapshot.Code -eq 0) -and ($snapshot.Ms -lt 2000) -and ($snapshot.Ms * 5 -lt $copy.Ms)
) -Note ("снимок быстрее копии в {0} раз ({1:N1} с против {2:N1} с)" -f $factor, ($snapshot.Ms / 1000), ($copy.Ms / 1000))

# 3. Откат: настоящая ReplaceTreeFromSnapshot возвращает снимок на место.
foreach ($path in @($benchLog, $benchOut)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
$rollback = Invoke-Harness -Arguments @{ MODE = 'rollback'; SRC = ''; DEST = ''; BENCHLOG = $benchLog; APPDIR = $appDir; DATADIR = $dataDir; OUT = $benchOut; LAST = $last }
$rollbackOut = Read-BenchOut -Path $benchOut
$rollbackLog = Read-BenchLog -Path $benchLog
$returnedByMove = ([regex]::Matches($rollbackLog, 'возвращён переносом снимка')).Count -eq 2
Add-BenchResult -Name 'snapshot-bench:rollback-real' -Ok (
    ($rollback.Code -eq 0) -and ($rollbackOut['result'] -eq '1') -and $returnedByMove
) -Note $(if ($returnedByMove) { 'server и service возвращены переносом' } else { 'журнал: ' + (($rollbackLog -split "`r?`n" | Where-Object { $_ -match 'Откат файлов' }) -join ' | ') })

$rollbackIntegrity = (Test-Path -LiteralPath $appServer) -and (Test-Path -LiteralPath $appService) -and
    (((Get-TreeHashLines -Root $appServer) -join "`n") -eq ($hashServer -join "`n")) -and
    (((Get-TreeHashLines -Root $appService) -join "`n") -eq ($hashService -join "`n"))
Add-BenchResult -Name 'snapshot-bench:rollback-integrity' -Ok ([bool]$rollbackIntegrity) `
    -Note ("после отката файлов {0}, хэши совпадают: {1}" -f `
        $(if (Test-Path -LiteralPath $appServer) { (Get-TreeHashLines -Root $appServer).Count } else { -1 }), $rollbackIntegrity)

Add-BenchResult -Name 'snapshot-bench:rollback-instant' -Ok (
    ($rollback.Code -eq 0) -and ($rollback.Ms -lt 2000) -and ($rollback.Ms * 5 -lt $copy.Ms)
) -Note ("откат быстрее копии в {0} раз ({1:N1} с)" -f ([math]::Round($copy.Ms / [math]::Max($rollback.Ms, 0.01), 1)), ($rollback.Ms / 1000))

# 4. Снимок без каталога, который был на месте (Expected=True): откат обязан
#    не трогать текущие файлы и вернуть неудачу, а не «успех без возврата».
$missingRoot = Join-Path $workRoot 'missing'
if (Test-Path -LiteralPath $missingRoot) { Remove-Item -LiteralPath $missingRoot -Recurse -Force }
New-SmallTree -Root (Join-Path $missingRoot 'dest') -Files 2
$missingOut = Join-Path $missingRoot 'out.txt'
$missing = Invoke-Harness -Arguments @{ MODE = 'missing'; SRC = (Join-Path $missingRoot 'no-such-src'); DEST = (Join-Path $missingRoot 'dest'); BENCHLOG = (Join-Path $missingRoot 'log.txt'); APPDIR = $appDir; DATADIR = $dataDir; OUT = $missingOut; LAST = '' }
$missingResult = Read-BenchOut -Path $missingOut
$destKept = (Test-Path -LiteralPath (Join-Path $missingRoot 'dest')) -and
    ((Get-ChildItem -LiteralPath (Join-Path $missingRoot 'dest') -Recurse -File -Force | Measure-Object).Count -gt 0)
Add-BenchResult -Name 'snapshot-bench:restore-missing-keeps' -Ok (
    ($missing.Code -eq 0) -and ($missingResult['result'] -eq '0') -and $destKept
) -Note ("откат вернул {0}, каталог программы цел: {1}" -f $missingResult['result'], $destKept)

# 5. Снимок без каталога, которого не было и до обновления (Expected=False):
#    откат обязан убрать текущий каталог — состояние должно совпасть со снимком.
$absentRoot = Join-Path $workRoot 'absent'
if (Test-Path -LiteralPath $absentRoot) { Remove-Item -LiteralPath $absentRoot -Recurse -Force }
New-SmallTree -Root (Join-Path $absentRoot 'dest') -Files 2
$absentOut = Join-Path $absentRoot 'out.txt'
$absent = Invoke-Harness -Arguments @{ MODE = 'absent'; SRC = (Join-Path $absentRoot 'no-such-src'); DEST = (Join-Path $absentRoot 'dest'); BENCHLOG = (Join-Path $absentRoot 'log.txt'); APPDIR = $appDir; DATADIR = $dataDir; OUT = $absentOut; LAST = '' }
$absentResult = Read-BenchOut -Path $absentOut
$destRemoved = -not (Test-Path -LiteralPath (Join-Path $absentRoot 'dest'))
Add-BenchResult -Name 'snapshot-bench:restore-absent-removes' -Ok (
    ($absent.Code -eq 0) -and ($absentResult['result'] -eq '1') -and $destRemoved
) -Note ("откат вернул {0}, каталог удалён: {1}" -f $absentResult['result'], $destRemoved)

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Снимок отката: {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
    exit 1
}
exit 0
