<#
.SYNOPSIS
    Общий сторож статических проверок installer/etn.iss для тестов установщика ETN.

.DESCRIPTION
    Test-IssCode ищет фрагмент кода в тексте Inno Setup Pascal Script, не
    принимая за код комментарии. Текст разбирается построчно с состоянием:
    строковые литералы, блочные комментарии `{ ... }` и `(* ... *)`
    (в том числе многострочные), строчный `// ...`. Строки проверяются
    регулярным выражением после вырезания комментариев.

    Зачем отдельный хелпер: наивный подстрочный поиск по всему тексту
    ($issText.Contains(...)) и регулярка по всему файлу проходили на
    закомментированной строке — дефекты B2 приёмки задачи 9b310991. Один и
    тот же хелпер обязаны использовать все тесты установщика
    (silent-codes.ps1, init-key.ps1), чтобы сторож не разъезжался.

    `;` в Pascal Script НЕ комментарий, а разделитель операторов (строка
    `; function ValidDisplayName` ломает компиляцию ISCC) — поэтому по
    умолчанию она считается кодом. Для ini-секций `.iss` (`[Setup]` и др.)
    `;` — комментарий в начале строки; там вызывайте `-IniComments`.

    Подключение (dot-sourcing):
        . (Join-Path $PSScriptRoot 'iss-guard.ps1')

    Вспомогательные функции:
      Get-IssStrippedLines — строки файла без комментариев (для своих проверок);
      Get-IssFunctionBody  — тело функции/процедуры по имени (проверка реального
                             фрагмента, а не подстроки по всему файлу);
      Get-IssIfdefBody     — строки внутри `#ifdef <имя>` (проверка, что хук
                             действительно под директивой, а не в комментарии).

    Самопроверка — Test-IssGuardSelfTest: возвращает объект
    { Ok = [bool]; Message = [string] } по встроенным образцам; вызывается
    тестами и попадает в их результаты отдельной проверкой.
#>

function Get-IssStrippedLines {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [switch]$IniComments
    )
    $result = New-Object System.Collections.Generic.List[string]
    # Состояние блочного комментария переносится между строками.
    $block = ''
    $section = ''
    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        # Секция .iss: комментарии Pascal Script ({ }, (* *), //) действуют
        # только в [Code]; в ini-секциях и #define фигурные скобки — константы
        # Inno ({app}, {autopf}, {#AppDir}), их вырезать нельзя.
        if ($trimmed -match '^\[([^\]]+)\]$') {
            $section = $Matches[1]
            $result.Add($line)
            continue
        }
        if ($section -ine 'Code') {
            if ($IniComments -and $trimmed.StartsWith(';')) {
                $result.Add('')
            } else {
                $result.Add($line)
            }
            continue
        }
        $sb = New-Object System.Text.StringBuilder
        $inString = $false
        $i = 0
        while ($i -lt $line.Length) {
            $c = $line[$i]
            if ($block -eq 'brace') {
                if ($c -eq '}') { $block = '' }
                $i++
                continue
            }
            if ($block -eq 'paren') {
                if (($c -eq '*') -and (($i + 1) -lt $line.Length) -and ($line[$i + 1] -eq ')')) {
                    $block = ''
                    $i += 2
                } else {
                    $i++
                }
                continue
            }
            if ($inString) {
                [void]$sb.Append($c)
                if ($c -eq "'") {
                    if ((($i + 1) -lt $line.Length) -and ($line[$i + 1] -eq "'")) {
                        [void]$sb.Append("'")
                        $i += 2
                        continue
                    }
                    $inString = $false
                }
                $i++
                continue
            }
            if ($IniComments -and ($c -eq ';') -and ($sb.ToString().Trim() -eq '')) { break }
            if ($c -eq "'") { $inString = $true; [void]$sb.Append($c); $i++; continue }
            if ($c -eq '{') { $block = 'brace'; $i++; continue }
            if (($c -eq '(') -and (($i + 1) -lt $line.Length) -and ($line[$i + 1] -eq '*')) {
                $block = 'paren'
                $i += 2
                continue
            }
            if (($c -eq '/') -and (($i + 1) -lt $line.Length) -and ($line[$i + 1] -eq '/')) { break }
            [void]$sb.Append($c)
            $i++
        }
        $result.Add($sb.ToString())
    }
    return $result
}

function Test-IssCode {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [switch]$IniComments
    )
    foreach ($line in (Get-IssStrippedLines -Text $Text -IniComments:$IniComments)) {
        if ($line.Trim() -eq '') { continue }
        if ($line -match $Pattern) { return $true }
    }
    return $false
}

function Get-IssFunctionBody {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $lines = @(Get-IssStrippedLines -Text $Text)
    $start = -1
    $namePattern = '^\s*(function|procedure)\s+' + [regex]::Escape($Name) + '\b'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $namePattern) { $start = $i; break }
    }
    if ($start -lt 0) { return '' }
    $body = New-Object System.Collections.Generic.List[string]
    $nextDecl = '^\s*(function|procedure)\s+[A-Za-z_]'
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $nextDecl) { break }
        $body.Add($lines[$i])
    }
    return ($body -join "`n")
}

function Get-IssIfdefBody {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $lines = @(Get-IssStrippedLines -Text $Text)
    $stack = New-Object System.Collections.Generic.List[bool]
    $body = New-Object System.Collections.Generic.List[string]
    $target = '^#ifdef\s+' + [regex]::Escape($Name) + '\b'
    foreach ($line in $lines) {
        $t = $line.Trim()
        if ($t -match $target) { $stack.Add($true); continue }
        if (($t -match '^#ifdef\s+\S+') -or ($t -match '^#ifndef\s+\S+') -or ($t -match '^#if\b')) {
            $stack.Add($false)
            continue
        }
        if ($t -match '^#endif\b') {
            if ($stack.Count -gt 0) { $stack.RemoveAt($stack.Count - 1) }
            continue
        }
        if ($stack -contains $true) { $body.Add($t) }
    }
    return ($body -join "`n")
}

function Test-IssGuardSelfTest {
    $failures = New-Object System.Collections.Generic.List[string]
    $pattern = [regex]::Escape('function ValidDisplayName')
    $code = "[Code]`r`n"
    $cases = @(
        @{ Name = 'фигурный комментарий не код'; Text = ($code + '{ function ValidDisplayName }'); Expected = $false; Ini = $false },
        @{ Name = 'многострочный фигурный не код'; Text = ($code + "{`r`nfunction ValidDisplayName`r`n}"); Expected = $false; Ini = $false },
        @{ Name = 'комментарий (* *) не код'; Text = ($code + '(* function ValidDisplayName *)'); Expected = $false; Ini = $false },
        @{ Name = 'многострочный (* *) не код'; Text = ($code + "(*`r`nfunction ValidDisplayName`r`n*)"); Expected = $false; Ini = $false },
        @{ Name = 'строчный // не код'; Text = ($code + '// function ValidDisplayName'); Expected = $false; Ini = $false },
        @{ Name = 'код с хвостовым // найден'; Text = ($code + 'x := 1; // function ValidDisplayName'); Expected = $false; Ini = $false },
        @{ Name = 'рабочий код найден'; Text = ($code + 'function ValidDisplayName(const S: String): Boolean;'); Expected = $true; Ini = $false },
        @{ Name = 'код с отступом найден'; Text = ($code + "`tfunction ValidDisplayName(const S: String): Boolean;"); Expected = $true; Ini = $false },
        @{ Name = 'код после блочного комментария найден'; Text = ($code + "{ function ValidDisplayName }`r`nfunction ValidDisplayName"); Expected = $true; Ini = $false },
        @{ Name = 'точка с запятой не комментарий [Code]'; Text = ($code + '; function ValidDisplayName'); Expected = $true; Ini = $false },
        @{ Name = 'константа Inno вне [Code] не режется'; Text = "[Setup]`r`nDefaultDirName={#AppDir}"; Expected = $true; Ini = $false; Pattern = [regex]::Escape('{#AppDir}') },
        @{ Name = 'точка с запятой комментарий ini'; Text = '; function ValidDisplayName'; Expected = $false; Ini = $true }
    )
    foreach ($case in $cases) {
        $casePattern = if ($case.ContainsKey('Pattern')) { $case.Pattern } else { $pattern }
        $actual = Test-IssCode -Text $case.Text -Pattern $casePattern -IniComments:$case.Ini
        if ($actual -ne $case.Expected) {
            $failures.Add("$($case.Name): ожидалось $($case.Expected), получено $actual")
        }
    }

    $funcSample = "[Code]`r`nfunction A(`r`nbegin`r`n  X := 1;`r`nend;`r`n`r`nfunction B(`r`nbegin`r`n  Y := 2;`r`nend;"
    $bodyA = Get-IssFunctionBody -Text $funcSample -Name 'A'
    if (($bodyA -notmatch 'X := 1') -or ($bodyA -match 'Y := 2')) {
        $failures.Add('тело функции A: ожидался X := 1 без тела B')
    }
    $funcCommented = "[Code]`r`n{ function A`r`n  X := 9;`r`n}`r`nfunction A(`r`n  X := 1;`r`nend;"
    $bodyCommented = Get-IssFunctionBody -Text $funcCommented -Name 'A'
    if ($bodyCommented -match 'X := 9') {
        $failures.Add('тело функции A: закомментированная копия не должна попадать в тело')
    }

    $ifdefSample = "[Code]`r`n#ifdef TestMode`r`nHOOK_IN`r`n#endif`r`nHOOK_OUT"
    $ifdefBody = Get-IssIfdefBody -Text $ifdefSample -Name 'TestMode'
    if (($ifdefBody -notmatch 'HOOK_IN') -or ($ifdefBody -match 'HOOK_OUT')) {
        $failures.Add('#ifdef TestMode: HOOK_IN должен быть внутри, HOOK_OUT — снаружи')
    }
    $ifdefCommented = "[Code]`r`n{ #ifdef TestMode }`r`nHOOK_IN`r`n{ #endif }"
    $ifdefBodyCommented = Get-IssIfdefBody -Text $ifdefCommented -Name 'TestMode'
    if ($ifdefBodyCommented -match 'HOOK_IN') {
        $failures.Add('#ifdef TestMode: закомментированная директива не должна открывать блок')
    }

    return [pscustomobject]@{
        Ok      = ($failures.Count -eq 0)
        Message = if ($failures.Count -eq 0) { 'хелпер не путает код с комментариями и режет тела функций/директив' } else { $failures -join '; ' }
    }
}
