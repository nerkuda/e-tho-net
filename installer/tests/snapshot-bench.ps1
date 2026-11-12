<#
.SYNOPSIS
    Замер снимка отката установщика ETN: перенос каталога против побайтовой
    копии (ошибка a34f48da).

.DESCRIPTION
    Собирает harness-инсталлятор Inno из кода etn.iss (CopyTreeRec и
    TakeSnapshot — дословно, с заглушкой LogLine) и на одном и том же дереве
    файлов замеряет три операции, которые делает установщик:

      copy      — прежний снимок: рекурсивная побайтовая копия каталога;
      move      — новый снимок: переименование каталога (MoveFileExW);
      moveback  — откат: возврат снимка на место переименованием.

    Дерево по умолчанию — installer/payload/server (10 721 файл, 65 МБ: та
    раскладка, снимок которой в реальной установке шёл 48–72 с в silent и
    больше 20 минут в GUI). Замеряется, во сколько раз перенос быстрее копии.
    Payload нет — строится синтетическое дерево из мелких файлов (-Files,
    -FileSizeKb).

    Проверки:
      snapshot-bench:copy-integrity   — копия совпадает с источником;
      snapshot-bench:move-instant     — перенос не медленнее копии/5 и < 2 с;
      snapshot-bench:move-integrity   — после переноса дерево то же;
      snapshot-bench:rollback-instant — возврат снимка так же быстр;
      snapshot-bench:rollback-integrity — после возврата дерево то же.

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
    Write-Host ("{0}  {1,-32} {2}" -f $mark, $Name, $Note)
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

<# Хэш дерева: относительный путь + длина + SHA-256 содержимого. Доказывает, что
    перенос не потерял и не подменил ни одного файла. #>
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
$copyDest = Join-Path $workRoot 'copy\server'
$moveDest = Join-Path $workRoot 'move\server'
foreach ($dir in @($outDir, $appDir, (Join-Path $workRoot 'copy'), (Join-Path $workRoot 'move'))) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

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

$hashBefore = Get-TreeHashLines -Root $appServer

$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$moveDecl = [regex]::Match($issText, "function MoveFileExW\([\s\S]*?stdcall';").Value
if (-not $moveDecl) { throw "В $issPath нет объявления MoveFileExW." }

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

[Code]
$moveDecl

procedure ExitProcess(uExitCode: Cardinal); external 'ExitProcess@kernel32.dll stdcall';

{ Заглушка журнала: проба замеряет операции снимка, а не запись строк. }
procedure LogLine(const Level, Msg: String);
begin
end;

$(Get-IssFunctionText -Text $issText -Name 'CopyTreeRec')

$(Get-IssFunctionText -Text $issText -Name 'TakeSnapshot')

function InitializeSetup: Boolean;
var
  Src, Dest, Mode: String;
  Moved, Ok: Boolean;
begin
  Result := False;
  Src := ExpandConstant('{param:SRC}');
  Dest := ExpandConstant('{param:DEST}');
  Mode := ExpandConstant('{param:MODE}');
  Ok := False;
  if Mode = 'copy' then
    Ok := CopyTreeRec(Src, Dest)
  else if Mode = 'move' then
    Ok := TakeSnapshot(Src, Dest, 'server', Moved)
  else if Mode = 'moveback' then
  begin
    Moved := False;
    Ok := MoveFileExW(Src, Dest, 0);
  end;
  if Ok then ExitProcess(0) else ExitProcess(5);
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
    param([string]$Mode, [string]$Src, [string]$Dest)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $exe -PassThru -Wait `
        -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
            ('/SRC=' + $Src), ('/DEST=' + $Dest), ('/MODE=' + $Mode))
    $watch.Stop()
    return [pscustomobject]@{ Code = $process.ExitCode; Ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 1) }
}

# 1. «До»: прежний снимок — побайтовая копия.
$copy = Invoke-Harness -Mode 'copy' -Src $appServer -Dest $copyDest
$hashCopy = Get-TreeHashLines -Root $copyDest
Add-BenchResult -Name 'snapshot-bench:copy-integrity' -Ok (
    ($copy.Code -eq 0) -and (($hashCopy -join "`n") -eq ($hashBefore -join "`n"))
) -Note ("копия {0:N1} с, файлов {1}, код {2}" -f ($copy.Ms / 1000), $hashCopy.Count, $copy.Code)

# 2. «После»: новый снимок — перенос каталога.
$move = Invoke-Harness -Mode 'move' -Src $appServer -Dest $moveDest
$hashMoved = Get-TreeHashLines -Root $moveDest
Add-BenchResult -Name 'snapshot-bench:move-integrity' -Ok (
    ($move.Code -eq 0) -and (($hashMoved -join "`n") -eq ($hashBefore -join "`n"))
) -Note ("перенос {0:N1} с, файлов {1}, код {2}" -f ($move.Ms / 1000), $hashMoved.Count, $move.Code)
$factor = if ($move.Ms -gt 0) { [math]::Round($copy.Ms / $move.Ms, 1) } else { [double]::PositiveInfinity }
Add-BenchResult -Name 'snapshot-bench:move-instant' -Ok (
    ($move.Code -eq 0) -and ($move.Ms -lt 2000) -and ($move.Ms * 5 -lt $copy.Ms)
) -Note ("перенос быстрее копии в {0} раз ({1:N1} с против {2:N1} с)" -f $factor, ($move.Ms / 1000), ($copy.Ms / 1000))

# 3. Откат: возврат снимка на место переименованием.
$back = Invoke-Harness -Mode 'moveback' -Src $moveDest -Dest $appServer
$hashBack = Get-TreeHashLines -Root $appServer
Add-BenchResult -Name 'snapshot-bench:rollback-integrity' -Ok (
    ($back.Code -eq 0) -and (($hashBack -join "`n") -eq ($hashBefore -join "`n"))
) -Note ("возврат {0:N1} с, файлов {1}, код {2}" -f ($back.Ms / 1000), $hashBack.Count, $back.Code)
Add-BenchResult -Name 'snapshot-bench:rollback-instant' -Ok (
    ($back.Code -eq 0) -and ($back.Ms -lt 2000) -and ($back.Ms * 5 -lt $copy.Ms)
) -Note ("возврат быстрее копии в {0} раз" -f ([math]::Round($copy.Ms / [math]::Max($back.Ms, 0.01), 1)))

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Снимок отката: {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
    exit 1
}
exit 0
