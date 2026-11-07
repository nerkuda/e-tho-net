<#
.SYNOPSIS
    Результаты E2E-прогона установщика: проверки, замеры, счётчики, JSON-отчёт.

.DESCRIPTION
    Общий формат результата для сценариев installer/tests/e2e/run.ps1:
    одна запись — одна проверка (scenario, name, ok, deferred, expected,
    actual, note). Сценарий считается успешным, только если у него есть
    проверки и нет ни одной проваленной.

    Замеры (duration и подобные) — не проверки: они не влияют на счётчики
    проверок, итог сценария и код возврата, а попадают в отчёт отдельным
    разделом `timings`. Безусловно-зелёная метрика в общем счёте проверок
    завышала бы покрытие, поэтому счёт «проверок» и «замеров» разделён.

    В отчёте у сценария есть поимённый список `checks_detail`
    (name/ok/deferred/expected/actual/note) — отложенная проверка и причина
    провала трассируются по JSON без чтения консольного журнала.

    Задача 8789381a (0.15.3). Секреты ВМ в результаты не попадают: note и
    actual формируются из кодов, путей и текста журнала установщика.
#>

function New-E2EResultList {
    return New-Object System.Collections.Generic.List[object]
}

function New-E2ETimingList {
    return New-Object System.Collections.Generic.List[object]
}

function Add-E2ECheck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [string]$Note = '',
        $Expected = $null,
        $Actual = $null,
        [switch]$Deferred
    )
    $Results.Add([pscustomobject]@{
            scenario = $Scenario
            name     = $Name
            ok       = ($Ok -and (-not $Deferred))
            deferred = [bool]$Deferred
            expected = $Expected
            actual   = $Actual
            note     = $Note
            at       = (Get-Date).ToUniversalTime().ToString('o')
        })
    $mark = if ($Deferred) { 'SKIP' } elseif ($Ok) { 'OK  ' } else { 'FAIL' }
    $actualText = if ($null -ne $Actual) { "actual=$Actual" } else { '' }
    $noteText = if ($Note) { "  $Note" } else { '' }
    Write-Host ("{0}  {1,-34} {2}{3}" -f $mark, $Name, $actualText, $noteText)
}

<#
    Замер сценария: длительность шага, сценария и т.п. Замер — не проверка
    (не входит в счётчики проверок/провалов и не влияет на код возврата),
    в отчёте лежит отдельным разделом timings.
#>
function Add-E2ETiming {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Timings,
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Value,
        [string]$Note = ''
    )
    $Timings.Add([pscustomobject]@{
            scenario = $Scenario
            name     = $Name
            value    = $Value
            note     = $Note
            at       = (Get-Date).ToUniversalTime().ToString('o')
        })
    $noteText = if ($Note) { "  $Note" } else { '' }
    Write-Host ("TIME  {0,-34} value={1}{2}" -f $Name, $Value, $noteText)
}

<#
    Сводка по сценарию: количество проверок, провалов и итог.
    Пустой список проверок — провал: сценарий, который ничего не проверил,
    нельзя считать успешным.
#>
function Get-E2ESummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [Parameter(Mandatory = $true)][string]$Scenario
    )
    $items = @($Results | Where-Object { $_.scenario -eq $Scenario })
    $failed = @($items | Where-Object { (-not $_.ok) -and (-not $_.deferred) }).Count
    $deferred = @($items | Where-Object { $_.deferred }).Count
    return [pscustomobject]@{
        scenario = $Scenario
        checks   = $items.Count
        failed   = $failed
        deferred = $deferred
        ok       = (($items.Count -gt 0) -and ($failed -eq 0) -and ($deferred -eq 0))
    }
}

<#
    Отчёт в JSON: сценарии (имя, снапшот, длительность, итог, счётчики,
    поимённый список проверок checks_detail, замеры timings), общие счётчики.
    UTF-8 без BOM — файл читают и агент, и человек.
#>
function Write-E2EReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Results,
        [AllowEmptyCollection()][object]$Timings = @(),
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Scenarios,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Extra = @{}
    )
    $report = [ordered]@{}
    foreach ($key in $Extra.Keys) { $report[$key] = $Extra[$key] }
    $report['generated_at'] = (Get-Date).ToUniversalTime().ToString('o')
    $scenarioCards = @(foreach ($scenario in @($Scenarios)) {
            $card = [ordered]@{}
            foreach ($property in $scenario.PSObject.Properties) {
                $card[$property.Name] = $property.Value
            }
            $card['timings'] = @(foreach ($timing in $Timings) {
                    if ($timing.scenario -ne $scenario.name) { continue }
                    [ordered]@{
                        name  = $timing.name
                        value = $timing.value
                        note  = $timing.note
                    }
                })
            $card['checks_detail'] = @(foreach ($item in $Results) {
                    if ($item.scenario -ne $scenario.name) { continue }
                    [ordered]@{
                        name     = $item.name
                        ok       = $item.ok
                        deferred = $item.deferred
                        expected = $item.expected
                        actual   = $item.actual
                        note     = $item.note
                    }
                })
            $card
        })
    $report['scenarios'] = $scenarioCards
    $report['totals'] = [ordered]@{
        scenarios = @($Scenarios).Count
        checks    = $Results.Count
        failed    = (@($Results | Where-Object { (-not $_.ok) -and (-not $_.deferred) }).Count)
        deferred  = @($Results | Where-Object { $_.deferred }).Count
        timings   = $Timings.Count
    }
    $dir = Split-Path -Parent $Path
    if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $report | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Отчёт: $Path"
}
