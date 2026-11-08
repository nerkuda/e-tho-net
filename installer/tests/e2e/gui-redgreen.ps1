<#
.SYNOPSIS
    Красно-зелёная валидация GUI-пробы установщика ETN на мутантах .iss.

.DESCRIPTION
    Доказывает, что проба (probe.ps1 + проверки gui.ps1) видит реальные дефекты
    раскладки и текста, а не только «зелёное» состояние:

      GREEN  — продуктовый установщик (release/ETN-Setup-0.15.3.exe, собран из
               текущего .iss): строка области клиента совпадает дословно,
               обрезки и пересечений нет;
      RED-1  — мутация «укоротить длинный текст»: EtnClientScopeRowUserOnly
               заменён короткой строкой → проверка текста красная;
      RED-2  — мутация «сжать причину»: у GReasonLabel после FitLabel ширина
               уменьшена втрое и высота вдвое → проверка раскладки красная
               (required_height > height).

    Мутации живут только в рабочей копии .iss: после каждой сборки файл
    восстанавливается из побайтового бэкапа, sha256 сверяется. Тестовые
    сборки — обычные (без -TestMode): проба обязана работать на продуктовой
    сборке, хуки не используются. Мутанты собираются с настоящим payload.
    Запуск установщика — только в ВМ и только в интерактивной сессии
    (неэлевированный режим «только для меня» — там видна длинная строка).

    Задача 8789381a (0.15.3), этап 4.

.PARAMETER OutDir
    Каталог отчётов и мутантов (по умолчанию .tmp/gui-redgreen).

.EXAMPLE
    pwsh -File installer/tests/e2e/gui-redgreen.ps1
#>
[CmdletBinding()]
param(
    [string]$Vm = 'ETN-Win11',
    [string]$BaseSnapshot = 'base-e2e-live',
    [string]$GuiBaseSnapshot = 'base-e2e-gui',
    [string]$OriginalSnapshot = 'base-clean-v2',
    [string]$SecretsPath = 'C:\Users\User\.zcode\secrets\etn-vms.env',
    [string]$OutDir = '',
    [string]$IssPath = '',
    [string]$GreenSetup = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = $PSScriptRoot
. (Join-Path $here 'assert.ps1')
. (Join-Path $here 'vm.ps1')
. (Join-Path $here 'guest.ps1')
. (Join-Path $here 'gui.ps1')

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $here '..\..\..'))
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.tmp\gui-redgreen' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not $IssPath) { $IssPath = Join-Path $repoRoot 'installer\etn.iss' }
if (-not $GreenSetup) { $GreenSetup = Join-Path $repoRoot 'release\ETN-Setup-0.15.3.exe' }
$issPath = [System.IO.Path]::GetFullPath($IssPath)
$greenSetup = [System.IO.Path]::GetFullPath($GreenSetup)
$reports = Join-Path $OutDir 'reports'
$buildRoot = Join-Path $OutDir 'build'
New-Item -ItemType Directory -Path $reports -Force | Out-Null
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

$results = New-E2EResultList
$timings = New-E2ETimingList
$scenarioReports = New-Object System.Collections.Generic.List[object]
$context = $null
$restoreError = ''

# Дословный текст из [CustomMessages] — эталон для проверки текста.
$expectedScope = 'Режим «только для меня»: клиент ставится в ваш профиль, права администратора не нужны. Чтобы установить сервер или клиент «для всех пользователей», закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).'

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

<#
    Применить мутацию к .iss, собрать установщик, сразу восстановить .iss из
    побайтового бэкапа и сверить sha256. Возвращает путь к собранному exe.
#>
function Build-Mutant {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Mutate
    )
    $original = [System.IO.File]::ReadAllBytes($issPath)
    $originalHash = (Get-FileHash -LiteralPath $issPath -Algorithm SHA256).Hash
    $backup = Join-Path $OutDir ("etn.iss.$Name.bak")
    [System.IO.File]::WriteAllBytes($backup, $original)
    $text = [System.IO.File]::ReadAllText($issPath)
    $mutated = & $Mutate $text
    if ($mutated -eq $text) { throw "Мутация $Name не изменила .iss" }
    [System.IO.File]::WriteAllText($issPath, $mutated, (New-Object System.Text.UTF8Encoding($true)))
    $buildDir = Join-Path $buildRoot $Name
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
    try {
        $arguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'installer\build.ps1'),
            '-OutputDir', $buildDir, '-BaseFilename', "ETN-Setup-$Name"
        )
        # Вывод сборки печатается, но в возвращаемое значение функции не
        # попадает: возвращается только путь к exe.
        & pwsh @arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        if ($LASTEXITCODE -ne 0) { throw "Сборка $Name завершилась с кодом $LASTEXITCODE" }
    } finally {
        [System.IO.File]::WriteAllBytes($issPath, $original)
        $restoredHash = (Get-FileHash -LiteralPath $issPath -Algorithm SHA256).Hash
        if ($restoredHash -ne $originalHash) {
            throw "Восстановление .iss после $Name не совпало по sha256: $restoredHash вместо $originalHash"
        }
    }
    $exe = Join-Path $buildDir "ETN-Setup-$Name-0.15.3.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Сборка $Name не создала $exe" }
    return $exe
}

<#
    Прогон пробы на установщике в ВМ и разбор снимка экрана компонентов.
    Возвращает { Probe; Snapshot; TextMatches; LayoutOk; Problems }.
#>
function Invoke-ComponentsProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$SetupPath
    )
    Write-Step "Проба ${Name}: запуск установщика (без элевации)"
    Close-GuestSession -Context $script:context
    Restore-VmSnapshot -Vm $Vm -Name $GuiBaseSnapshot
    Start-VmHeadless -Vm $Vm
    $null = Wait-VmGuestAdditions -Vm $Vm -TimeoutSec 300
    $null = Wait-GuestReady -Context $script:context -TimeoutSec 300
    $session = Wait-GuestInteractiveSession -Context $script:context -TimeoutSec 180
    if ([int]$session.ActiveSessions -le 0) { throw 'Нет интерактивной сессии для GUI-пробы.' }
    $null = Invoke-GuestElevatedCommand -Context $script:context `
        -Command 'if not exist C:\e2e mkdir C:\e2e & if not exist C:\e2e\gui mkdir C:\e2e\gui & exit /b 0'
    $guestSetup = 'C:\e2e\' + (Split-Path -Leaf $SetupPath)
    $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
    $plain = $script:context.Credential.GetNetworkCredential().Password
    [System.IO.File]::WriteAllText($passwordFile, $plain)
    $plain = $null
    try {
        Copy-HostFileToGuest -Vm $Vm -Source $SetupPath -Destination $guestSetup `
            -UserName $script:context.UserName -PasswordFile $passwordFile
    } finally {
        Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
    }
    $null = Copy-GuestGuiProbe -Context $script:context
    $plan = New-GuiPlan -Exe $guestSetup -Steps @(
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = 'components' },
        @{ type = 'kill' }
    )
    $probe = Invoke-GuestGuiProbe -Plan $plan -Name $Name -RunLevel Limited -TimeoutSec 300 `
        -ArtifactDir $reports
    $snapshot = Get-GuiSnapshot -ProbeResult $probe.Result -Name 'components'
    $textMatches = $false
    if ($snapshot) {
        $lists = @(Get-JsonField $snapshot 'lists')
        if ($lists.Count -gt 0) {
            foreach ($item in @(Get-JsonField $lists[0] 'items')) {
                if ([string](Get-JsonField $item 'text') -eq $expectedScope) { $textMatches = $true }
            }
        }
    }
    $layoutProblems = @()
    $layoutOk = $false
    if ($snapshot) {
        $layout = Test-GuiSnapshotLayout -Snapshot $snapshot
        $layoutOk = [bool]$layout.Ok
        $layoutProblems = @($layout.Problems)
    }
    $artifacts = Join-Path $reports $Name
    New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
    if ($probe.Raw) {
        [System.IO.File]::WriteAllText((Join-Path $artifacts 'probe.json'), $probe.Raw,
            (New-Object System.Text.UTF8Encoding($false)))
    }
    return [pscustomobject]@{
        Probe        = $probe
        Snapshot     = $snapshot
        TextMatches  = $textMatches
        LayoutOk     = $layoutOk
        Problems     = $layoutProblems
    }
}

try {
    $null = Resolve-VBoxManage
    $context = New-GuestContext -Vm $Vm -SecretsPath $SecretsPath

    $issHash = (Get-FileHash -LiteralPath $issPath -Algorithm SHA256).Hash
    Write-Host "sha256 etn.iss: $issHash"
    $status = Ensure-GuiBaseSnapshots -Vm $Vm -Context $context `
        -BaseSnapshot $BaseSnapshot -GuiBase $GuiBaseSnapshot -BootTimeoutSec 300
    Write-Host ("GUI-база: {0}" -f (((@($status.created) -join ', ') + ' ').Trim()))

    # --- GREEN: продуктовая сборка, текущий .iss -----------------------------
    $green = Invoke-ComponentsProbe -Name 'green-product' -SetupPath $greenSetup
    Add-E2ECheck -Results $results -Scenario 'GREEN' -Name 'green:probe' -Ok ([bool]$green.Probe.Ok) `
        -Expected 'проба отработала' -Actual $(if ($green.Probe.Ok) { 'ok' } else { $green.Probe.Error })
    Add-E2ECheck -Results $results -Scenario 'GREEN' -Name 'green:scope-text' -Ok $green.TextMatches `
        -Expected 'длинная строка области клиента дословно' -Actual $(if ($green.TextMatches) { 'совпала' } else { 'не совпала' })
    Add-E2ECheck -Results $results -Scenario 'GREEN' -Name 'green:layout' -Ok $green.LayoutOk `
        -Expected 'без обрезки и пересечений' `
        -Actual $(if ($green.LayoutOk) { 'ok' } else { $green.Problems -join '; ' })

    if (-not $SkipBuild) {
        # --- RED-1: укоротить длинный текст ---------------------------------
        $red1Setup = Build-Mutant -Name 'red1-short-text' -Mutate {
            param($text)
            $pattern = '(?m)^EtnClientScopeRowUserOnly=.*$'
            $found = [regex]::Matches($text, $pattern)
            if ($found.Count -ne 1) { throw "Ожидалась одна строка EtnClientScopeRowUserOnly, найдено $($found.Count)" }
            return [regex]::Replace($text, $pattern, 'EtnClientScopeRowUserOnly=Режим «только для меня»: клиент ставится в ваш профиль.')
        }
        $red1 = Invoke-ComponentsProbe -Name 'red1-short-text' -SetupPath $red1Setup
        Add-E2ECheck -Results $results -Scenario 'RED-1' -Name 'red1:probe' -Ok ([bool]$red1.Probe.Ok) `
            -Expected 'проба отработала' -Actual $(if ($red1.Probe.Ok) { 'ok' } else { $red1.Probe.Error })
        Add-E2ECheck -Results $results -Scenario 'RED-1' -Name 'red1:text-check-red' -Ok (-not $red1.TextMatches) `
            -Expected 'проверка текста КРАСНАЯ (строка не совпала)' -Actual $(if ($red1.TextMatches) { 'совпала (дефект пробы)' } else { 'не совпала' })

        # --- RED-2: сжать причину по ширине и высоте ------------------------
        $red2Setup = Build-Mutant -Name 'red2-clipped-reason' -Mutate {
            param($text)
            $anchor = "    GReasonLabel.Caption := ComponentsReasonLabelText;`r`n    FitLabel(GReasonLabel);"
            $count = ([regex]::Matches($text, [regex]::Escape($anchor))).Count
            if ($count -ne 1) {
                $anchor = "    GReasonLabel.Caption := ComponentsReasonLabelText;`n    FitLabel(GReasonLabel);"
                $count = ([regex]::Matches($text, [regex]::Escape($anchor))).Count
            }
            if ($count -ne 1) { throw "Не найден единый якорь GReasonLabel+FitLabel (найдено $count)" }
            $replacement = $anchor + "`r`n    GReasonLabel.Width := GReasonLabel.Width div 3;`r`n    GReasonLabel.Height := GReasonLabel.Height div 2;"
            return $text.Replace($anchor, $replacement)
        }
        $red2 = Invoke-ComponentsProbe -Name 'red2-clipped-reason' -SetupPath $red2Setup
        Add-E2ECheck -Results $results -Scenario 'RED-2' -Name 'red2:probe' -Ok ([bool]$red2.Probe.Ok) `
            -Expected 'проба отработала' -Actual $(if ($red2.Probe.Ok) { 'ok' } else { $red2.Probe.Error })
        $clipped = @($red2.Problems | Where-Object { $_ -like '*обрезка*' })
        Add-E2ECheck -Results $results -Scenario 'RED-2' -Name 'red2:layout-red' -Ok ((-not $red2.LayoutOk) -and $clipped.Count -gt 0) `
            -Expected 'проверка раскладки КРАСНАЯ (обрезка причины)' `
            -Actual $(if (-not $red2.LayoutOk) { "$($red2.Problems.Count) проблем" } else { 'раскладка зелёная (дефект пробы)' }) `
            -Note (($red2.Problems | Select-Object -First 4) -join '; ')
    }

    $finalHash = (Get-FileHash -LiteralPath $issPath -Algorithm SHA256).Hash
    Add-E2ECheck -Results $results -Scenario 'RESTORE' -Name 'iss:sha256-restored' -Ok ($finalHash -eq $issHash) `
        -Expected $issHash -Actual $finalHash

    foreach ($scenario in @('GREEN', 'RED-1', 'RED-2', 'RESTORE')) {
        $summary = Get-E2ESummary -Results $results -Scenario $scenario
        if ($summary.checks -eq 0) { continue }
        $scenarioReports.Add([pscustomobject]@{
                name = $scenario; snapshot = $GuiBaseSnapshot; checks = $summary.checks
                failed = $summary.failed; deferred = $summary.deferred; ok = $summary.ok
            })
        Write-Host ("Итог {0}: проверок {1}, провалов {2}" -f $scenario, $summary.checks, $summary.failed)
    }
} finally {
    if ($context) { Close-GuestSession -Context $context }
    try {
        Write-Step "Возврат ВМ в снапшот $OriginalSnapshot"
        Restore-VmSnapshot -Vm $Vm -Name $OriginalSnapshot
        Stop-Vm -Vm $Vm
    } catch {
        $restoreError = $_.Exception.Message
        Write-Warning "Не удалось вернуть ВМ: $restoreError"
    }
    $extra = @{
        vm = [ordered]@{ name = $Vm; original_snapshot = $OriginalSnapshot; restore_error = $restoreError }
        iss = [ordered]@{ path = $IssPath }
    }
    Write-E2EReport -Results $results -Timings $timings -Scenarios $scenarioReports.ToArray() `
        -Path (Join-Path $OutDir 'redgreen-report.json') -Extra $extra
    $failed = @($results | Where-Object { (-not $_.ok) -and (-not $_.deferred) }).Count
    Write-Host ''
    Write-Host ("Итог красно-зелёной валидации: проверок {0}, провалов {1}" -f $results.Count, $failed)
    if ($failed -gt 0) { exit 1 }
    if ($restoreError) { exit 2 }
}
