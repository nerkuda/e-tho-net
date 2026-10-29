<#
.SYNOPSIS
    Общий сторож статических проверок install/etn.iss для тестов установщика ETN.

.DESCRIPTION
    Test-IssCode ищет фрагмент кода в тексте Inno Setup Pascal Script, не
    принимая за код строку комментария. Проверка идёт по строкам: пустые и
    начинающиеся с ';' (после Trim) пропускаются, остальные проверяются
    регулярным выражением.

    Зачем отдельный хелпер: наивный подстрочный поиск по всему тексту
    ($issText.Contains(...)) проходил на закомментированной строке — дефект B2
    приёмки задачи 9b310991 (`; function ValidDisplayName` считался
    реализацией). Один и тот же хелпер обязаны использовать все тесты
    установщика (silent-codes.ps1, init-key.ps1), чтобы сторож не разъезжался.

    В Inno `;` — комментарий только в начале строки (в параметрах секций это
    разделитель), поэтому строка считается комментарием, если после Trim
    начинается с ';'. Блочных и многострочных комментариев в Pascal Script нет.

    Подключение (dot-sourcing):
        . (Join-Path $PSScriptRoot 'iss-guard.ps1')

    Самопроверка — Test-IssGuardSelfTest: возвращает объект
    { Ok = [bool]; Message = [string] } по встроенным образцам; вызывается
    тестами и попадает в их результаты отдельной проверкой.
#>

function Test-IssCode {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern
    )
    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '') { continue }
        if ($trimmed.StartsWith(';')) { continue }
        if ($trimmed -match $Pattern) { return $true }
    }
    return $false
}

function Test-IssGuardSelfTest {
    $failures = New-Object System.Collections.Generic.List[string]
    $pattern = [regex]::Escape('function ValidDisplayName')
    $samples = @(
        @{ Name = 'комментарий не код'; Text = '; function ValidDisplayName'; Expected = $false },
        @{ Name = 'комментарий с отступом не код'; Text = "`t ; function ValidDisplayName"; Expected = $false },
        @{ Name = 'пустые строки не код'; Text = "`r`n`r`n   `r`n"; Expected = $false },
        @{ Name = 'рабочий код найден'; Text = 'function ValidDisplayName(const S: String): Boolean;'; Expected = $true },
        @{ Name = 'код с отступом найден'; Text = "`tfunction ValidDisplayName(const S: String): Boolean;"; Expected = $true },
        @{ Name = 'код после комментария найден'; Text = "; function ValidDisplayName`r`nfunction ValidDisplayName"; Expected = $true }
    )
    foreach ($sample in $samples) {
        $actual = Test-IssCode -Text $sample.Text -Pattern $pattern
        if ($actual -ne $sample.Expected) {
            $failures.Add("$($sample.Name): ожидалось $($sample.Expected), получено $actual")
        }
    }
    return [pscustomobject]@{
        Ok      = ($failures.Count -eq 0)
        Message = if ($failures.Count -eq 0) { 'хелпер не путает код с комментарием' } else { $failures -join '; ' }
    }
}
