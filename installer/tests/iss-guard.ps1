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
      Get-IssFunctionBodyWithoutIfdef — тело функции без строк, компилируемых
                             только под указанной директивой (продуктовая
                             ветка против TestMode-модели);
      Get-IssIfdefBody     — строки внутри `#ifdef <имя>` (проверка, что хук
                             действительно под директивой, а не в комментарии);
      Get-IssCustomMessage / Get-IssCustomMessageNames — значение сообщения
                             [CustomMessages] по имени и список имён (включая
                             дубликаты) — сторож выноса UI-строк;
      Get-IssUiLiterals    — кириллические литералы [Code], не являющиеся
                             журнальными и не входящие в allowlist: сторож
                             «UI-строки только в [CustomMessages]».

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

# Тело функции без строк, компилируемых только под указанной директивой:
# продуктовая ветка функции отличается от тестовой модели службы (8b1f5980:
# сторож 1073 искал подстроки, которые есть и в TestMode-ветке, и потому не
# ловил удаление продуктовой). Директивы #ifdef/#if/#endif в результат не
# попадают.
function Get-IssFunctionBodyWithoutIfdef {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Ifdef
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
    $target = '^#ifdef\s+' + [regex]::Escape($Ifdef) + '\b'
    $stack = New-Object System.Collections.Generic.List[bool]
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($line in $body) {
        $t = $line.Trim()
        if ($t -match $target) { $stack.Add($true); continue }
        if (($t -match '^#ifdef\s+\S+') -or ($t -match '^#ifndef\s+\S+') -or ($t -match '^#if\b')) {
            $stack.Add(($stack.Count -gt 0) -and ($stack[$stack.Count - 1]))
            continue
        }
        if ($t -match '^#endif\b') {
            if ($stack.Count -gt 0) { $stack.RemoveAt($stack.Count - 1) }
            continue
        }
        if ($stack -contains $true) { continue }
        $result.Add($line)
    }
    return ($result -join "`n")
}

# --- [CustomMessages] -------------------------------------------------------
# Сообщения установщика читаются из ini-секции [CustomMessages]: только строки
# «Имя=Значение», ';' в начале строки — комментарий, имя без точек (точка в
# Inno — языковой префикс) проверяется отдельным сторожем. Продолжение строки
# обратным слэшем в конце склеивается без разделителя — так же, как это делает
# компилятор Inno. Значения здесь нужны сторожам, которые проверяют, что текст
# прежнего литерала переехал в сообщение, а не потерялся.
function Get-IssCustomMessageMap {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $map = [ordered]@{}
    $inSection = $false
    $pending = $null
    $pendingValue = ''
    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[([^\]]+)\]$') {
            if ($null -ne $pending) { $map[$pending] = $pendingValue; $pending = $null }
            $inSection = ($Matches[1] -ieq 'CustomMessages')
            continue
        }
        if (-not $inSection) { continue }
        if ($trimmed -eq '' -or $trimmed.StartsWith(';')) { continue }
        $isContinuation = ($null -ne $pending) -and $pendingValue.EndsWith('\')
        if ($isContinuation) {
            $pendingValue = $pendingValue.Substring(0, $pendingValue.Length - 1) + $trimmed
            continue
        }
        if ($null -ne $pending) { $map[$pending] = $pendingValue; $pending = $null }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1)
        if ($value.EndsWith('\')) {
            $pending = $name
            $pendingValue = $value
        }
        else {
            $map[$name] = $value
        }
    }
    if ($null -ne $pending) { $map[$pending] = $pendingValue }
    return $map
}

function Get-IssCustomMessage {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $map = Get-IssCustomMessageMap -Text $Text
    if (-not $map.Contains($Name)) { return $null }
    return [string]$map[$Name]
}

function Get-IssCustomMessageNames {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    # Имена собираются списком, без словаря: дубликат имени — ошибка компиляции
    # Inno, и сторож должен её увидеть, а не схлопнуть в одно значение.
    $names = New-Object System.Collections.Generic.List[string]
    $inSection = $false
    $continues = $false
    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[([^\]]+)\]$') {
            $inSection = ($Matches[1] -ieq 'CustomMessages')
            $continues = $false
            continue
        }
        if (-not $inSection) { continue }
        if ($trimmed -eq '' -or $trimmed.StartsWith(';')) { continue }
        if ($continues) {
            $continues = $trimmed.EndsWith('\')
            continue
        }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $names.Add($line.Substring(0, $eq).Trim())
        $continues = $line.Substring($eq + 1).EndsWith('\')
    }
    return @($names)
}

function Get-IssUiLiterals {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    # 4dc117f5: в [Code] UI-строк быть не должно. Журнальные операторы
    # (LogLine/LogDefer/LogOrDefer/Log) и метки операций инструмента БД
    # (ApplyDatabaseToolReport) остаются в коде по решению пользователя;
    # остальные кириллические литералы — нарушения, кроме allowlist.
    $allowed = @('%.1f ГБ', '%.1f МБ', ' КБ', ' МБ', ' --connect-name="Локальный сервер"')
    $codeMatch = [regex]::Match($Text, '(?ms)^\[Code\]\s*(.*)$')
    if (-not $codeMatch.Success) { return @() }
    # Get-IssStrippedLines вырезает комментарии только в секции [Code], поэтому
    # передаём фиктивный заголовок и отбрасываем его строку.
    $stripped = @(Get-IssStrippedLines -Text ("[Code]`n" + $codeMatch.Groups[1].Value))
    $bodyLines = if ($stripped.Count -gt 1) { $stripped[1..($stripped.Count - 1)] } else { @() }
    $joined = $bodyLines -join "`n"
    $statements = New-Object System.Collections.Generic.List[string]
    $sb = New-Object System.Text.StringBuilder
    $inString = $false
    $depth = 0
    for ($i = 0; $i -lt $joined.Length; $i++) {
        $c = $joined[$i]
        [void]$sb.Append($c)
        if ($c -eq "'") {
            # Удвоенная кавычка внутри строки — не конец литерала.
            if ($inString -and (($i + 1) -lt $joined.Length) -and ($joined[$i + 1] -eq "'")) {
                [void]$sb.Append("'")
                $i++
                continue
            }
            $inString = -not $inString
            continue
        }
        if ($inString) { continue }
        if ($c -eq '(') { $depth++ }
        elseif ($c -eq ')') { if ($depth -gt 0) { $depth-- } }
        elseif (($c -eq ';') -and ($depth -eq 0)) {
            $statements.Add($sb.ToString())
            [void]$sb.Clear()
        }
    }
    if ($sb.ToString().Trim() -ne '') { $statements.Add($sb.ToString()) }
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($statement in $statements) {
        # Исключаются только строковые аргументы журнальных вызовов и метки
        # ApplyDatabaseToolReport, а не всё утверждение целиком: иначе UI-строка
        # в том же операторе рядом с журналом проходит незамеченной.
        $journalDepths = New-Object System.Collections.Generic.List[int]
        $inString = $false
        $stringStart = -1
        $depth = 0
        for ($i = 0; $i -lt $statement.Length; $i++) {
            $c = $statement[$i]
            if ($inString) {
                if ($c -eq "'") {
                    # Удвоенная кавычка внутри строки — не конец литерала.
                    if ((($i + 1) -lt $statement.Length) -and ($statement[$i + 1] -eq "'")) {
                        $i++
                        continue
                    }
                    $inString = $false
                    if ($journalDepths.Count -eq 0) {
                        $value = $statement.Substring($stringStart + 1, $i - $stringStart - 1) -replace "''", "'"
                        if (($value -match '[А-Яа-яЁё]') -and ($allowed -notcontains $value) -and
                            (-not $found.Contains($value))) {
                            $found.Add($value)
                        }
                    }
                }
                continue
            }
            if ($c -eq "'") {
                $inString = $true
                $stringStart = $i
                continue
            }
            if ($c -eq '(') {
                $depth++
                $j = $i - 1
                while ($j -ge 0 -and [char]::IsWhiteSpace($statement[$j])) { $j-- }
                $nameEnd = $j
                while ($j -ge 0 -and ($statement[$j] -match '[A-Za-z0-9_]')) { $j-- }
                if ($nameEnd -gt $j) {
                    $name = $statement.Substring($j + 1, $nameEnd - $j)
                    if ($name -imatch '^(LogLine|LogDefer|LogOrDefer|Log|ApplyDatabaseToolReport)$') {
                        $journalDepths.Add($depth)
                    }
                }
            }
            elseif ($c -eq ')') {
                if (($journalDepths.Count -gt 0) -and
                    ($journalDepths[$journalDepths.Count - 1] -eq $depth)) {
                    $journalDepths.RemoveAt($journalDepths.Count - 1)
                }
                if ($depth -gt 0) { $depth-- }
            }
        }
    }
    return @($found)
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

    $funcIfdef = "[Code]`r`nfunction F`r`nbegin`r`n  BEFORE`r`n#ifdef TestMode`r`n  HOOK`r`n#endif`r`n  AFTER`r`nend;"
    $funcNoIfdef = Get-IssFunctionBodyWithoutIfdef -Text $funcIfdef -Name 'F' -Ifdef 'TestMode'
    if (($funcNoIfdef -notmatch 'BEFORE') -or ($funcNoIfdef -notmatch 'AFTER') -or
        ($funcNoIfdef -match 'HOOK')) {
        $failures.Add('тело функции без #ifdef: BEFORE/AFTER остаются, HOOK вырезан')
    }
    $funcOtherIfdef = "[Code]`r`nfunction F`r`nbegin`r`n#ifdef OtherMode`r`n  OTHER`r`n#endif`r`n  ALWAYS`r`nend;"
    $funcOther = Get-IssFunctionBodyWithoutIfdef -Text $funcOtherIfdef -Name 'F' -Ifdef 'TestMode'
    if (($funcOther -notmatch 'ALWAYS') -or ($funcOther -notmatch 'OTHER')) {
        $failures.Add('тело функции без #ifdef: чужая директива не должна вырезать код')
    }

    # [CustomMessages]: значение ищется только в своей секции, комментарии и
    # строки других секций не подмешиваются, '\' в конце строки склеивает.
    $msgSample = "[CustomMessages]`r`n; комментарий`r`nEtnA=Первый`r`nEtnB=Второй %1`r`n[Setup]`r`nNotMessage=Не сообщение"
    if ((Get-IssCustomMessage -Text $msgSample -Name 'EtnA') -ne 'Первый') {
        $failures.Add('[CustomMessages]: EtnA должен быть найден')
    }
    if ($null -ne (Get-IssCustomMessage -Text $msgSample -Name 'NotMessage')) {
        $failures.Add('[CustomMessages]: строка из [Setup] — не сообщение')
    }
    if ($null -ne (Get-IssCustomMessage -Text $msgSample -Name 'EtnMissing')) {
        $failures.Add('[CustomMessages]: отсутствующее имя — $null')
    }
    $msgNames = Get-IssCustomMessageNames -Text $msgSample
    if (($msgNames -join ',') -ne 'EtnA,EtnB') {
        $failures.Add('[CustomMessages]: имена — EtnA,EtnB без строк другой секции')
    }
    $msgCont = "[CustomMessages]`r`nEtnC=Первая часть \" + "`r`n" + 'вторая часть'
    if ((Get-IssCustomMessage -Text $msgCont -Name 'EtnC') -ne 'Первая часть вторая часть') {
        $failures.Add('[CustomMessages]: продолжение строки склеивается')
    }

    # 4dc117f5: сторож UI-литералов — журнал и allowlist проходят, UI-строка нет.
    $uiSample = "[Code]`r`nbegin`r`n  LogLine('INFO', 'журнал');`r`n  Result := 'подпись';`r`n  X := '%.1f ГБ';`r`n  ApplyDatabaseToolReport(P, C, 'Бэкап БД');`r`nend;"
    $uiBad = @(Get-IssUiLiterals -Text $uiSample)
    if (($uiBad.Count -ne 1) -or ($uiBad[0] -ne 'подпись')) {
        $failures.Add('UI-литералы: ожидалась только «подпись», найдено: ' + ($uiBad -join ', '))
    }
    $uiCommented = "[Code]`r`n// Result := 'скрытая';`r`n{ Result := 'в блоке'; }"
    if (@(Get-IssUiLiterals -Text $uiCommented).Count -ne 0) {
        $failures.Add('UI-литералы: закомментированные строки не считаются')
    }
    # 4dc117f5: журнальный вызов в том же операторе не должен скрывать соседний
    # UI-литерал — исключаются только аргументы самого вызова.
    $uiInline = "[Code]`r`nbegin`r`n  if True then LogLine('INFO', 'журнал') else Result := 'подпись';`r`nend;"
    $uiInlineBad = @(Get-IssUiLiterals -Text $uiInline)
    if (($uiInlineBad.Count -ne 1) -or ($uiInlineBad[0] -ne 'подпись')) {
        $failures.Add('UI-литералы: строка вне аргументов LogLine должна находиться, найдено: ' +
            ($uiInlineBad -join ', '))
    }
    $uiPrefix = "[Code]`r`nbegin`r`n  X := 'префикс' + LogLine('INFO', 'журнал');`r`nend;"
    $uiPrefixBad = @(Get-IssUiLiterals -Text $uiPrefix)
    if (($uiPrefixBad.Count -ne 1) -or ($uiPrefixBad[0] -ne 'префикс')) {
        $failures.Add('UI-литералы: строка после LogLine в выражении должна находиться, найдено: ' +
            ($uiPrefixBad -join ', '))
    }
    $uiNested = "[Code]`r`nbegin`r`n  LogLine('INFO', FmtMessage('в журнале', [X]));`r`nend;"
    if (@(Get-IssUiLiterals -Text $uiNested).Count -ne 0) {
        $failures.Add('UI-литералы: вложенные аргументы журнального вызова не считаются')
    }

    return [pscustomobject]@{
        Ok      = ($failures.Count -eq 0)
        Message = if ($failures.Count -eq 0) { 'хелпер не путает код с комментариями и режет тела функций/директив' } else { $failures -join '; ' }
    }
}
