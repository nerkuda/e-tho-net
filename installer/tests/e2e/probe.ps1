<#
.SYNOPSIS
    Гостевая GUI-проба установщика ETN: мастер глазами пользователя (UIA/Win32).

.DESCRIPTION
    Запускается В ИНТЕРАКТИВНОЙ сессии гостя (запланированная задача, см.
    gui.ps1): только там у установщика есть рабочий стол и живые окна.
    Скрипт читает план (JSON) и пишет результат (JSON):

      * запускает установщик (план `exe`) или подключается к уже запущенному
        процессу (`pid`/`title`);
      * выполняет шаги плана: ожидание окна/страницы/текста, снимки состояния,
        клики (UIA Invoke/Toggle, Win32 SendMessage, клик по координатам),
        ввод текста в поля, нажатие «Далее»/«Установить»/«Готово», ответ в
        диалоге, ожидание завершения процесса;
      * снимает состояние страницы: заголовки, тексты статических контролов
        (WM_GETTEXT), прямоугольники в координатах страницы, состояние «Далее»
        (IsWindowEnabled), чекбоксы (BM_GETCHECK + UIA ToggleState), элементы
        TNewCheckListBox (LB_GETCOUNT/LB_GETTEXT/LB_GETITEMHEIGHT/LB_GETTOPINDEX;
        текст читается через буфер в процессе установщика), измеренные высоты
        текста (DrawText) — обрезка видна как required_height > height.

    Внутренние checked/enabled строк списка снаружи недоступны (Inno не отдаёт
    их через Win32) — это допустимая деградация: выбор компонентов
    подтверждается журналом установщика на хосте.

    Секреты: текст полей длиннее 16 символов в результат не попадает
    (`<redacted:N>`) — ключ администратора живёт только на экране. Скрипт не
    печатает содержимое контролов в консоль: только файл результата.

    Задача 8789381a (0.15.3), этап 4.

.PARAMETER Plan
    Путь к JSON-плану (см. gui.ps1, New-GuiPlan).

.PARAMETER Out
    Путь к JSON-результату.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Plan,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Win32/UIA вспомогательные типы ----------------------------------------

$nativeCode = @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class EtnProbeNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetTopWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    // Нажатие кнопки оконным сообщением: не зависит от того, какое окно
    // впереди и где курсор. BM_CLICK — 0x00F5.
    public static void ClickMessage(IntPtr hWnd)
    {
        SendMessage(hWnd, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }

    // Асинхронный клик: обработчик кнопки может уйти в PrepareToInstall и
    // открыть модальный диалог закрытия клиента, не возвращаясь до его
    // закрытия. Синхронный SendMessage вешал всю пробу на этом шаге
    // (наблюдалось 2026-11-08, G3/G4). PostMessage ставит клик в очередь
    // установщика и сразу возвращает управление; следующий шаг ждёт
    // результата (диалог, страницу) со своим таймаутом.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public static bool ClickMessageAsync(IntPtr hWnd)
    {
        return PostMessage(hWnd, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int DrawText(IntPtr hdc, string lpchText, int cchText, ref RECT lprc, uint dwDTFormat);

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetTextExtentPoint32W(IntPtr hdc, string s, int c, out SIZE size);

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; }

    // Истинная ширина/высота текста шрифтом контрола (WM_GETFONT), без
    // переноса: диагностика расхождений между DrawText и метриками шрифта.
    public static string TextExtent(IntPtr h, string text)
    {
        IntPtr font = LocalFont(h);
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        IntPtr old = IntPtr.Zero;
        try
        {
            if (font != IntPtr.Zero) { old = SelectObject(dc, font); }
            SIZE size;
            if (!GetTextExtentPoint32W(dc, text, text.Length, out size)) { return "fail"; }
            return size.cx + "x" + size.cy;
        }
        finally
        {
            if (old != IntPtr.Zero) { SelectObject(dc, old); }
            DeleteDC(dc);
            if (font != IntPtr.Zero) { DeleteObject(font); }
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint flAllocationType, uint flProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtSuspendProcess(IntPtr hProcess);

    public static bool SuspendProcess(int pid)
    {
        IntPtr h = OpenProcess(0x0800, false, pid);
        if (h == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            return NtSuspendProcess(h) == 0;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_GETTEXTLENGTH = 0x000E;
    private const uint WM_SETTEXT = 0x000C;
    private const uint WM_GETFONT = 0x0031;
    private const uint BM_GETCHECK = 0x00F0;
    private const uint GW_CHILD = 5;
    private const uint GW_HWNDNEXT = 2;

    public static string Class(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(260);
        int n = GetClassName(h, sb, sb.Capacity);
        return n > 0 ? sb.ToString() : string.Empty;
    }

    public static string Text(IntPtr h)
    {
        int len = (int)SendMessage(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        if (len <= 0)
        {
            len = GetWindowTextLength(h);
        }
        if (len <= 0)
        {
            return string.Empty;
        }
        StringBuilder sb = new StringBuilder(len + 2);
        SendMessage(h, WM_GETTEXT, (IntPtr)(len + 1), sb);
        string text = sb.ToString();
        if (text.Length == 0)
        {
            StringBuilder fallback = new StringBuilder(len + 2);
            GetWindowText(h, fallback, fallback.Capacity);
            text = fallback.ToString();
        }
        return text;
    }

    public static bool SetText(IntPtr h, string text)
    {
        return SendMessage(h, WM_SETTEXT, IntPtr.Zero, text ?? string.Empty) != IntPtr.Zero;
    }

    public static int CheckState(IntPtr h)
    {
        return SendMessage(h, BM_GETCHECK, IntPtr.Zero, IntPtr.Zero).ToInt32();
    }

    public static int[] Rect(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r))
        {
            return new int[] { 0, 0, 0, 0 };
        }
        return new int[] { r.Left, r.Top, r.Right, r.Bottom };
    }

    public static int[] ClientSize(IntPtr h)
    {
        RECT r;
        if (!GetClientRect(h, out r))
        {
            return new int[] { 0, 0 };
        }
        return new int[] { r.Right - r.Left, r.Bottom - r.Top };
    }

    private static void Collect(IntPtr parent, List<IntPtr> list)
    {
        IntPtr child = GetWindow(parent, GW_CHILD);
        while (child != IntPtr.Zero)
        {
            list.Add(child);
            Collect(child, list);
            child = GetWindow(child, GW_HWNDNEXT);
        }
    }

    public static IntPtr[] Descendants(IntPtr root)
    {
        List<IntPtr> list = new List<IntPtr>();
        Collect(root, list);
        return list.ToArray();
    }

    public static IntPtr[] TopWindowsOfProcess(int pid)
    {
        List<IntPtr> list = new List<IntPtr>();
        IntPtr h = GetTopWindow(IntPtr.Zero);
        while (h != IntPtr.Zero)
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if ((int)p == pid)
            {
                list.Add(h);
            }
            h = GetWindow(h, GW_HWNDNEXT);
        }
        return list.ToArray();
    }

    private static bool TopCallback(IntPtr h, IntPtr lParam)
    {
        GCHandle handle = GCHandle.FromIntPtr(lParam);
        List<IntPtr> list = (List<IntPtr>)handle.Target;
        list.Add(h);
        return true;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    public static IntPtr[] TopWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        GCHandle handle = GCHandle.Alloc(list);
        try
        {
            EnumWindows(TopCallback, GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }
        return list.ToArray();
    }

    public static int WindowPid(IntPtr h)
    {
        uint p;
        GetWindowThreadProcessId(h, out p);
        return (int)p;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct LOGFONT
    {
        public int lfHeight;
        public int lfWidth;
        public int lfEscapement;
        public int lfOrientation;
        public int lfWeight;
        public byte lfItalic;
        public byte lfUnderline;
        public byte lfStrikeOut;
        public byte lfCharSet;
        public byte lfOutPrecision;
        public byte lfClipPrecision;
        public byte lfQuality;
        public byte lfPitchAndFamily;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string lfFaceName;
    }

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetObjectW(IntPtr h, int size, ref LOGFONT lf);

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFontIndirectW(ref LOGFONT lf);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);

    // Шрифт контрола, воссозданный в НАШЕМ процессе по LOGFONT. Чужой HFONT
    // из WM_GETFONT не всегда годится для SelectObject в нашем DC (метрики
    // расходились: 272 px против реальных ~400, 2026-11-07), а локальная
    // копия по LOGFONT даёт те же свойства без зависимости от чужого объекта.
    public static IntPtr LocalFont(IntPtr h)
    {
        IntPtr font = SendMessage(h, WM_GETFONT, IntPtr.Zero, IntPtr.Zero);
        if (font == IntPtr.Zero) { return IntPtr.Zero; }
        LOGFONT lf = new LOGFONT();
        if (GetObjectW(font, Marshal.SizeOf(typeof(LOGFONT)), ref lf) == 0) { return IntPtr.Zero; }
        return CreateFontIndirectW(ref lf);
    }

    public static long FontHandle(IntPtr h)
    {
        return SendMessage(h, WM_GETFONT, IntPtr.Zero, IntPtr.Zero).ToInt64();
    }

    public static string FontInfo(IntPtr h)
    {
        IntPtr font = SendMessage(h, WM_GETFONT, IntPtr.Zero, IntPtr.Zero);
        if (font == IntPtr.Zero) { return "none"; }
        LOGFONT lf = new LOGFONT();
        int got = GetObjectW(font, Marshal.SizeOf(typeof(LOGFONT)), ref lf);
        return "got=" + got + " face=" + lf.lfFaceName + " height=" + lf.lfHeight
            + " weight=" + lf.lfWeight + " charset=" + lf.lfCharSet;
    }

    public static void ClickAt(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    public static string Foreground()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero)
        {
            return string.Empty;
        }
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return Class(h) + "|" + Text(h) + "|" + pid.ToString();
    }

    public static int ListCount(IntPtr h) { return SendMessage(h, 0x018B, IntPtr.Zero, IntPtr.Zero).ToInt32(); }
    public static int ListTopIndex(IntPtr h) { return SendMessage(h, 0x018E, IntPtr.Zero, IntPtr.Zero).ToInt32(); }
    public static int ListItemHeight(IntPtr h, int index) { return SendMessage(h, 0x01A1, (IntPtr)index, IntPtr.Zero).ToInt32(); }

    // LB_GETITEMRECT у чужого процесса: RECT живёт в адресном пространстве
    // установщика (сообщение старше WM_USER не маршалируется системой).
    public static int[] ListItemRect(IntPtr h, int index)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        IntPtr proc = OpenProcess(0x0008 | 0x0010 | 0x0020 | 0x0400, false, (int)pid);
        if (proc == IntPtr.Zero) { return null; }
        IntPtr remote = VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)16, 0x3000, 0x04);
        if (remote == IntPtr.Zero) { CloseHandle(proc); return null; }
        try
        {
            IntPtr sent = SendMessage(h, 0x0198, (IntPtr)index, remote);
            if (sent == IntPtr.Zero) { return null; }
            byte[] buffer = new byte[16];
            UIntPtr read;
            if (!ReadProcessMemory(proc, remote, buffer, (UIntPtr)buffer.Length, out read)) { return null; }
            return new int[] {
                BitConverter.ToInt32(buffer, 0), BitConverter.ToInt32(buffer, 4),
                BitConverter.ToInt32(buffer, 8), BitConverter.ToInt32(buffer, 12)
            };
        }
        finally
        {
            VirtualFreeEx(proc, remote, UIntPtr.Zero, 0x8000);
            CloseHandle(proc);
        }
    }

    // LB_GETTEXT — маршалируемое системой сообщение: текст копируется в буфер
    // ВЫЗЫВАЮЩЕГО процесса. Поэтому сначала локальный буфер (обычный путь), и
    // только при пустом результате — старый трюк с буфером в чужом процессе.
    public static string ListItemTextLocal(IntPtr h, int index)
    {
        StringBuilder buffer = new StringBuilder(1024);
        SendMessage(h, 0x0189, (IntPtr)index, buffer);
        return buffer.ToString();
    }

    public static string ListItemText(IntPtr h, int index)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        IntPtr proc = OpenProcess(0x0008 | 0x0010 | 0x0020 | 0x0400, false, (int)pid);
        if (proc == IntPtr.Zero)
        {
            return string.Empty;
        }
        IntPtr remote = VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)4096, 0x3000, 0x04);
        if (remote == IntPtr.Zero)
        {
            CloseHandle(proc);
            return string.Empty;
        }
        try
        {
            SendMessage(h, 0x0189, (IntPtr)index, remote);
            byte[] buffer = new byte[4096];
            UIntPtr read;
            if (!ReadProcessMemory(proc, remote, buffer, (UIntPtr)buffer.Length, out read))
            {
                return string.Empty;
            }
            string text = Encoding.Unicode.GetString(buffer);
            int end = text.IndexOf('\0');
            if (end >= 0)
            {
                text = text.Substring(0, end);
            }
            return text;
        }
        finally
        {
            VirtualFreeEx(proc, remote, UIntPtr.Zero, 0x8000);
            CloseHandle(proc);
        }
    }

    private const uint DT_LEFT = 0x0000;
    private const uint DT_TOP = 0x0000;
    private const uint DT_WORDBREAK = 0x0010;
    private const uint DT_SINGLELINE = 0x0020;
    private const uint DT_CALCRECT = 0x0400;
    private const uint DT_NOPREFIX = 0x0800;

    public static int MeasureHeight(IntPtr h, string text, int width, bool wordWrap)
    {
        // Шрифт контрола пересоздаётся локально по LOGFONT: измерения чужого
        // HFONT в нашем DC давали неверный перенос (2026-11-07).
        IntPtr local = LocalFont(h);
        try
        {
            return MeasureWithFont(local, text, width, wordWrap);
        }
        finally
        {
            if (local != IntPtr.Zero) { DeleteObject(local); }
        }
    }

    // Старое поведение (SelectObject чужого HFONT) — только для диагностики.
    public static int MeasureHeightForeign(IntPtr h, string text, int width, bool wordWrap)
    {
        IntPtr font = SendMessage(h, WM_GETFONT, IntPtr.Zero, IntPtr.Zero);
        return MeasureWithFont(font, text, width, wordWrap);
    }

    private static int MeasureWithFont(IntPtr font, string text, int width, bool wordWrap)
    {
        if (text == null || text.Length == 0)
        {
            return 0;
        }
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        IntPtr old = IntPtr.Zero;
        if (dc == IntPtr.Zero)
        {
            return -1;
        }
        try
        {
            if (font != IntPtr.Zero)
            {
                old = SelectObject(dc, font);
            }
            RECT r = new RECT();
            r.Left = 0; r.Top = 0; r.Right = width > 0 ? width : 10000; r.Bottom = 0;
            uint flags = DT_LEFT | DT_TOP | DT_CALCRECT | DT_NOPREFIX;
            flags |= wordWrap ? DT_WORDBREAK : DT_SINGLELINE;
            DrawText(dc, text, -1, ref r, flags);
            return r.Bottom - r.Top;
        }
        finally
        {
            if (old != IntPtr.Zero)
            {
                SelectObject(dc, old);
            }
            DeleteDC(dc);
        }
    }
}
'@

if (-not ('EtnProbeNative' -as [type])) {
    Add-Type -TypeDefinition $nativeCode -Language CSharp
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$AE = [System.Windows.Automation.AutomationElement]
$TSS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$InvokePattern = [System.Windows.Automation.InvokePattern]
$TogglePattern = [System.Windows.Automation.TogglePattern]
$ValuePattern = [System.Windows.Automation.ValuePattern]

# --- Общие помощники -------------------------------------------------------

$script:Result = [ordered]@{
    schema        = 1
    started_at    = (Get-Date).ToUniversalTime().ToString('o')
    finished_at   = ''
    ok            = $false
    error         = ''
    plan          = $Plan
    session       = $null
    installer     = $null
    steps         = @()
    snapshots     = [ordered]@{}
    warnings      = @()
}
$script:StepList = New-Object System.Collections.Generic.List[object]
$script:SnapshotMap = [ordered]@{}
$script:InstallerProcess = $null
$script:WizardHandle = [IntPtr]::Zero
$script:WizardPid = 0
$script:KeepInstaller = $false

function Write-Result {
    $json = $script:Result | ConvertTo-Json -Depth 12
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

<#
    Журнал хода шагов рядом с результатом. Нужен, когда шаг завис
    (например, синхронный BM_CLICK ждёт модальный диалог): файл результата
    пишется только в конце, а progress.log показывает последний начатый шаг.
#>
$script:ProgressPath = $Out + '.progress.log'
function Write-ProgressLine {
    param([string]$Line)
    try {
        [System.IO.File]::AppendAllText($script:ProgressPath,
            ((Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff') + ' ' + $Line + "`r`n"),
            (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Get-SessionInfo {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue |
            Where-Object { $_.SessionId -eq $sessionId })
    $desktop = ''
    try {
        $desktop = [System.Environment]::GetEnvironmentVariable('USERNAME') + '@' +
            [System.Environment]::GetEnvironmentVariable('USERDOMAIN')
    } catch { }
    return [ordered]@{
        session_id      = $sessionId
        user            = $desktop
        user_interactive = [System.Environment]::UserInteractive
        explorer_count  = $explorer.Count
        foreground      = [EtnProbeNative]::Foreground()
        screen          = @(
            [System.Windows.Forms.SystemInformation]::VirtualScreen.Width,
            [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
        )
    }
}

<#
    Является ли процесс $TargetPid самим $RootPid или его потомком.
    Установщик Inno Setup — два процесса: маленький SetupLdr (его и запускаем)
    и основной setup во временном файле (*.tmp), которому принадлежит окно
    мастера. Без родства процессов окно мастера не находится (наблюдалось
    2026-11-07: виден только InnoSetupLdrWindow, а TWizardForm — у ребёнка).
#>
function Test-ProcessDescendant {
    param([int]$RootPid, [int]$ChildPid)
    if ($RootPid -le 0 -or $ChildPid -le 0) { return $false }
    if ($RootPid -eq $ChildPid) { return $true }
    $current = $ChildPid
    for ($i = 0; $i -lt 4; $i++) {
        try {
            $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if ($null -eq $proc) { return $false }
            $parent = [int]$proc.ParentProcessId
            if ($parent -eq $RootPid) { return $true }
            if ($parent -le 0) { return $false }
            $current = $parent
        } catch { return $false }
    }
    return $false
}

function Find-WizardWindow {
    param([int]$TargetPid, [string]$TitleContains = '', [int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $tops = if ($TargetPid -gt 0) {
            @([EtnProbeNative]::TopWindowsOfProcess($TargetPid) + [EtnProbeNative]::TopWindows())
        } else {
            @([EtnProbeNative]::TopWindows())
        }
        $seen = @{}
        foreach ($h in $tops) {
            if ($seen.ContainsKey($h.ToInt64())) { continue }
            $seen[$h.ToInt64()] = $true
            $class = [EtnProbeNative]::Class($h)
            # Только мастер: диалоги (TMsgBoxForm) ищутся отдельно и не должны
            # подменять дескриптор мастера — иначе снимок страницы пуст.
            if ($class -ne 'TWizardForm') { continue }
            if (-not [EtnProbeNative]::IsWindowVisible($h)) { continue }
            if ($TitleContains) {
                $text = [EtnProbeNative]::Text($h)
                if (-not $text.Contains($TitleContains)) { continue }
            }
            $wizardPid = [EtnProbeNative]::WindowPid($h)
            if ($TargetPid -le 0 -or (Test-ProcessDescendant -RootPid $TargetPid -ChildPid $wizardPid)) {
                return $h
            }
        }
        Start-Sleep -Milliseconds 400
    }
    return [IntPtr]::Zero
}

function Get-WizardHandle {
    param([int]$TimeoutSec = 30)
    if ($script:WizardHandle -ne [IntPtr]::Zero -and [EtnProbeNative]::IsWindowVisible($script:WizardHandle)) {
        return $script:WizardHandle
    }
    $pid_ = if ($script:InstallerProcess) { $script:InstallerProcess.Id } else { $script:WizardPid }
    $handle = Find-WizardWindow -TargetPid $pid_ -TimeoutSec $TimeoutSec
    if ($handle -ne [IntPtr]::Zero) {
        $script:WizardHandle = $handle
        $script:WizardPid = $pid_
    }
    return $handle
}

function Get-VisibleDescendants {
    param([IntPtr]$Root)
    return @([EtnProbeNative]::Descendants($Root) | Where-Object {
            [EtnProbeNative]::IsWindowVisible($_)
        })
}

<#
    Глубина окна от корня (число уровней GetParent). Нужна, чтобы отличить
    внешнюю страницу мастера от страницы содержимого: в Inno 6 внешняя
    страница (OuterNotebook) содержит заголовок и внутренний Notebook, в
    котором лежит активная страница с контролами. Активная — самая глубокая.
#>
function Get-ControlDepth {
    param([IntPtr]$Root, [IntPtr]$Handle)
    $depth = 0
    $current = $Handle
    while ($current -ne [IntPtr]::Zero -and $current -ne $Root -and $depth -lt 16) {
        $current = [EtnProbeNative]::GetParent($current)
        $depth++
    }
    return $depth
}

function Get-ActivePageSurface {
    param([IntPtr]$Wizard)
    $pages = @(Get-VisibleDescendants -Root $Wizard | Where-Object {
            [EtnProbeNative]::Class($_) -eq 'TNewNotebookPage'
        })
    if ($pages.Count -eq 0) { return [IntPtr]::Zero }
    # Активная страница: самая глубокая (страница содержимого внутри
    # внутреннего Notebook), при равной глубине — с большим числом видимых
    # дочерних окон.
    $best = [IntPtr]::Zero
    $bestDepth = -1
    $bestCount = -1
    foreach ($page in $pages) {
        $depth = Get-ControlDepth -Root $Wizard -Handle $page
        $count = @(Get-VisibleDescendants -Root $page).Count
        if ($depth -gt $bestDepth -or ($depth -eq $bestDepth -and $count -gt $bestCount)) {
            $bestDepth = $depth
            $bestCount = $count
            $best = $page
        }
    }
    return $best
}

function Get-TextOrEmpty {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero) { return '' }
    return [EtnProbeNative]::Text($Handle)
}

function Get-RedactedText {
    param([string]$Text, [string]$Class)
    if ($null -eq $Text) { return '' }
    # Поля ввода длиннее 16 символов могут содержать ключ администратора:
    # значение в результат не попадает, только длина.
    if ($Text.Length -gt 16 -and ($Class -like '*Edit*' -or $Class -like '*EDIT*')) {
        return ('<redacted:{0}>' -f $Text.Length)
    }
    return $Text
}

function Get-ControlSnapshot {
    param([IntPtr]$Handle, [IntPtr]$Page)
    $class = [EtnProbeNative]::Class($Handle)
    $text = Get-TextOrEmpty -Handle $Handle
    $rect = [EtnProbeNative]::Rect($Handle)
    $pageRect = if ($Page -ne [IntPtr]::Zero) { [EtnProbeNative]::Rect($Page) } else { @(0, 0, 0, 0) }
    $client = [EtnProbeNative]::ClientSize($Handle)
    $item = [ordered]@{
        handle    = $Handle.ToInt64()
        class     = $class
        text      = Get-RedactedText -Text $text -Class $class
        chars     = $text.Length
        visible   = [EtnProbeNative]::IsWindowVisible($Handle)
        enabled   = [EtnProbeNative]::IsWindowEnabled($Handle)
        rect      = @($rect[0], $rect[1], $rect[2], $rect[3])
        rect_rel  = @(($rect[0] - $pageRect[0]), ($rect[1] - $pageRect[1]), ($rect[2] - $pageRect[0]), ($rect[3] - $pageRect[1]))
        width     = ($rect[2] - $rect[0])
        height    = ($rect[3] - $rect[1])
        client    = @($client[0], $client[1])
    }
    if ($class -like '*Check*' -or [EtnProbeNative]::CheckState($Handle) -ne 0) {
        $item['checked_win32'] = [EtnProbeNative]::CheckState($Handle)
    }
    # Обрезка многострочной подписи: высота контрола против измеренной по
    # тексту и ширине. 0/пустой текст не измеряются.
    if ($text -and $class -like '*Static*') {
        $measured = [EtnProbeNative]::MeasureHeight($Handle, $text, $client[0], $true)
        $item['required_height'] = $measured
        $item['font'] = [EtnProbeNative]::FontInfo($Handle)
    }
    # Многострочные поля (Memo итоговой сводки) WM_GETTEXT в другом процессе
    # иногда не отдают: текст читается через UIA ValuePattern.
    if (-not $text -and ($class -like '*Memo*' -or $class -like '*Edit*' -or $class -eq 'EDIT')) {
        try {
            $element = $AE::FromHandle($Handle)
            $pattern = $null
            if ($null -ne $element -and $element.TryGetCurrentPattern($ValuePattern.Pattern, [ref]$pattern)) {
                $value = [string]$pattern.Current.Value
                if ($value) {
                    $item['text'] = Get-RedactedText -Text $value -Class $class
                    $item['chars'] = $value.Length
                    $item['text_source'] = 'uia-value'
                }
            }
        } catch { }
    }
    return $item
}

function Get-ListSnapshot {
    param([IntPtr]$Handle, [IntPtr]$Page)
    $rect = [EtnProbeNative]::Rect($Handle)
    $pageRect = if ($Page -ne [IntPtr]::Zero) { [EtnProbeNative]::Rect($Page) } else { @(0, 0, 0, 0) }
    $client = [EtnProbeNative]::ClientSize($Handle)
    $count = [EtnProbeNative]::ListCount($Handle)
    $items = @()
    for ($i = 0; $i -lt $count; $i++) {
        $text = [EtnProbeNative]::ListItemTextLocal($Handle, $i)
        $textSource = 'local'
        if (-not $text) {
            $text = [EtnProbeNative]::ListItemText($Handle, $i)
            $textSource = 'remote'
        }
        $height = [EtnProbeNative]::ListItemHeight($Handle, $i)
        $required = -1
        if ($text) {
            # Ширина строки: клиентская ширина минус отступ и системная
            # полоса прокрутки (она появляется при переполнении списка).
            $measureWidth = [Math]::Max(40, $client[0] - 24)
            $required = [EtnProbeNative]::MeasureHeight($Handle, $text, $measureWidth, $true)
        }
        $items += [ordered]@{
            index          = $i
            text           = Get-RedactedText -Text $text -Class 'ListBox'
            text_source    = $textSource
            chars          = $text.Length
            height         = $height
            required_height = $required
        }
    }
    return [ordered]@{
        handle    = $Handle.ToInt64()
        class     = [EtnProbeNative]::Class($Handle)
        rect      = @($rect[0], $rect[1], $rect[2], $rect[3])
        rect_rel  = @(($rect[0] - $pageRect[0]), ($rect[1] - $pageRect[1]), ($rect[2] - $pageRect[0]), ($rect[3] - $pageRect[1]))
        width     = ($rect[2] - $rect[0])
        height    = ($rect[3] - $rect[1])
        client    = @($client[0], $client[1])
        count     = $count
        top_index = [EtnProbeNative]::ListTopIndex($Handle)
        line_height = [EtnProbeNative]::MeasureHeight($Handle, 'Wg', 10000, $false)
        items     = $items
    }
}

function Get-UiaSnapshot {
    param([IntPtr]$Wizard)
    $items = @()
    try {
        $root = $AE::FromHandle($Wizard)
        if ($null -eq $root) { return @() }
        $all = $root.FindAll($TSS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $all) {
            try {
                $current = $element.Current
                $name = $current.Name
                $type = $current.ControlType.ProgrammaticName
                if ($type -eq 'ControlType.Edit' -and $name -and $name.Length -gt 16) {
                    $name = ('<redacted:{0}>' -f $name.Length)
                }
                $bounds = $current.BoundingRectangle
                $item = [ordered]@{
                    name      = $name
                    class     = $current.ClassName
                    type      = $type
                    enabled   = $current.IsEnabled
                    offscreen = $current.IsOffscreen
                    handle    = $current.NativeWindowHandle
                    rect      = @([int]$bounds.Left, [int]$bounds.Top, [int]$bounds.Right, [int]$bounds.Bottom)
                }
                $pattern = $null
                if ($element.TryGetCurrentPattern($TogglePattern.Pattern, [ref]$pattern)) {
                    $item['toggle_state'] = [string]$pattern.Current.ToggleState
                }
                $items += $item
            } catch { }
        }
    } catch {
        $script:Result['warnings'] += ('UIA: ' + $_.Exception.Message)
    }
    return $items
}

function Get-PageTitle {
    param([IntPtr]$Wizard, [IntPtr]$Page)
    # Заголовок страницы — статический текст над поверхностью страницы
    # (PageNameLabel); ниже него — описание (PageDescriptionLabel).
    $pageRect = if ($Page -ne [IntPtr]::Zero) { [EtnProbeNative]::Rect($Page) } else { @(0, 0, 0, 0) }
    $texts = @()
    foreach ($handle in (Get-VisibleDescendants -Root $Wizard)) {
        $class = [EtnProbeNative]::Class($handle)
        if ($class -notlike '*Static*') { continue }
        $rect = [EtnProbeNative]::Rect($handle)
        if ($rect[1] -ge $pageRect[1]) { continue }
        $text = [EtnProbeNative]::Text($handle)
        if (-not $text) { continue }
        $texts += [pscustomobject]@{ top = $rect[1]; text = $text }
    }
    $sorted = @($texts | Sort-Object top)
    $title = if ($sorted.Count -ge 1) { $sorted[0].text } else { '' }
    $subtitle = if ($sorted.Count -ge 2) { $sorted[1].text } else { '' }
    return [ordered]@{ title = $title; subtitle = $subtitle }
}

function Get-WizardSnapshot {
    param([string]$Name)
    $wizard = Get-WizardHandle -TimeoutSec 20
    if ($wizard -eq [IntPtr]::Zero) { throw 'Окно мастера не найдено.' }
    $page = Get-ActivePageSurface -Wizard $wizard
    $title = Get-PageTitle -Wizard $wizard -Page $page
    $controls = @()
    $lists = @()
    if ($page -ne [IntPtr]::Zero) {
        foreach ($handle in (Get-VisibleDescendants -Root $page)) {
            # Только прямые дети поверхности: вложенные окна (кнопки внутри
            # строк и т.п.) не участвуют в проверке пересечений.
            if ([EtnProbeNative]::GetParent($handle) -ne $page) { continue }
            $class = [EtnProbeNative]::Class($handle)
            if ($class -like '*CheckListBox*' -or $class -like '*ListBox*') {
                $lists += Get-ListSnapshot -Handle $handle -Page $page
            }
            $controls += Get-ControlSnapshot -Handle $handle -Page $page
        }
    }
    # Кнопки мастера и прочие видимые контролы вне поверхности (заголовки,
    # «Далее», «Назад», «Отмена») — для состояния кнопки и её прямоугольника.
    # Кнопки ищутся среди всех потомков: в зависимости от версии Inno они
    # лежат либо прямо на форме, либо в панели навигации.
    $wizardControls = @()
    foreach ($handle in (Get-VisibleDescendants -Root $wizard)) {
        $isDirect = ([EtnProbeNative]::GetParent($handle) -eq $wizard)
        $isButton = ([EtnProbeNative]::Class($handle) -like '*Button*')
        if (-not $isDirect -and -not $isButton) { continue }
        $wizardControls += Get-ControlSnapshot -Handle $handle -Page $page
    }
    $next = @($wizardControls | Where-Object { $_.class -like '*Button*' -and $_.text -match 'Далее|Установить|Готово|Завершить' }) |
        Select-Object -First 1
    $snapshot = [ordered]@{
        name            = $Name
        at              = (Get-Date).ToUniversalTime().ToString('o')
        window          = [ordered]@{
            title = Get-TextOrEmpty -Handle $wizard
            rect  = [EtnProbeNative]::Rect($wizard)
        }
        page            = [ordered]@{
            title    = $title.title
            subtitle = $title.subtitle
            surface  = [EtnProbeNative]::Rect($page)
            width    = if ($page -ne [IntPtr]::Zero) { [EtnProbeNative]::Rect($page)[2] - [EtnProbeNative]::Rect($page)[0] } else { 0 }
            height   = if ($page -ne [IntPtr]::Zero) { [EtnProbeNative]::Rect($page)[3] - [EtnProbeNative]::Rect($page)[1] } else { 0 }
        }
        controls        = $controls
        wizard_controls = $wizardControls
        lists           = $lists
        next_button     = $next
        uia             = Get-UiaSnapshot -Wizard $wizard
    }
    $script:SnapshotMap[$Name] = $snapshot
    return $snapshot
}

function Wait-Condition {
    param([scriptblock]$Condition, [int]$TimeoutSec = 30, [int]$PollMs = 300)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $value = & $Condition
        if ($value) { return $value }
        Start-Sleep -Milliseconds $PollMs
    }
    return $null
}

function Get-TextMatches {
    param([IntPtr]$Root, [string]$Text, [switch]$Exact)
    $matches = @()
    foreach ($handle in (Get-VisibleDescendants -Root $Root)) {
        $class = [EtnProbeNative]::Class($handle)
        $value = [EtnProbeNative]::Text($handle)
        if (-not $value) { continue }
        $hit = if ($Exact) { $value -eq $Text } else { $value.Contains($Text) }
        if ($hit) {
            $rect = [EtnProbeNative]::Rect($handle)
            $matches += [pscustomobject]@{
                handle = $handle
                class  = $class
                text   = $value
                area   = ($rect[2] - $rect[0]) * ($rect[3] - $rect[1])
                top    = $rect[1]
            }
        }
    }
    return $matches
}

function Invoke-UiaAction {
    param([IntPtr]$Handle, [string]$Preferred = '')
    try {
        $element = $AE::FromHandle($Handle)
        if ($null -eq $element) { return 'none' }
        $pattern = $null
        if ($Preferred -eq 'toggle' -and $element.TryGetCurrentPattern($TogglePattern.Pattern, [ref]$pattern)) {
            $pattern.Toggle()
            return 'uia-toggle'
        }
        if ($element.TryGetCurrentPattern($InvokePattern.Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            return 'uia-invoke'
        }
        if ($element.TryGetCurrentPattern($TogglePattern.Pattern, [ref]$pattern)) {
            $pattern.Toggle()
            return 'uia-toggle'
        }
    } catch { }
    return 'none'
}

function Invoke-ControlClick {
    param([IntPtr]$Handle, [switch]$PreferToggle)
    $method = Invoke-UiaAction -Handle $Handle -Preferred $(if ($PreferToggle) { 'toggle' } else { '' })
    if ($method -ne 'none') { return $method }
    $rect = [EtnProbeNative]::Rect($Handle)
    $x = [int](($rect[0] + $rect[2]) / 2)
    $y = [int](($rect[1] + $rect[3]) / 2)
    $wizard = Get-WizardHandle -TimeoutSec 5
    if ($wizard -ne [IntPtr]::Zero) { $null = [EtnProbeNative]::SetForegroundWindow($wizard) }
    [EtnProbeNative]::ClickAt($x, $y)
    return 'mouse'
}

<#
    Нажатие кнопки оконным сообщением (BM_CLICK). Мышиный клик по кнопке
    ненадёжен, когда окно мастера в этот момент не активно: Windows проглатывает
    первый клик на активацию (поймано на кнопке «Завершить» — 40 с ожидания,
    мастер жив, затем BM_CLICK сразу закрыл его с кодом 0). BM_CLICK не зависит
    от активного окна и положения курсора.
#>
function Invoke-ButtonClick {
    param([IntPtr]$Handle, [switch]$Async)
    if ($Async) {
        $null = [EtnProbeNative]::ClickMessageAsync($Handle)
        return 'bm-click-async'
    }
    [EtnProbeNative]::ClickMessage($Handle)
    return 'bm-click'
}

function Set-EditValue {
    param([IntPtr]$Handle, [string]$Text)
    try {
        $element = $AE::FromHandle($Handle)
        if ($null -ne $element) {
            $pattern = $null
            if ($element.TryGetCurrentPattern($ValuePattern.Pattern, [ref]$pattern)) {
                $pattern.SetValue($Text)
                return 'uia-value'
            }
        }
    } catch { }
    $null = [EtnProbeNative]::SetText($Handle, $Text)
    return 'wm-settext'
}

function Get-VisibleEdits {
    param([IntPtr]$Page)
    $edits = @()
    foreach ($handle in (Get-VisibleDescendants -Root $Page)) {
        if ([EtnProbeNative]::GetParent($handle) -ne $Page) { continue }
        $class = [EtnProbeNative]::Class($handle)
        if ($class -like '*Edit*' -or $class -eq 'EDIT') {
            $rect = [EtnProbeNative]::Rect($handle)
            $edits += [pscustomobject]@{ handle = $handle; top = $rect[1]; left = $rect[0] }
        }
    }
    return @($edits | Sort-Object top, left)
}

function Get-DialogWindow {
    param([int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $pid_ = if ($script:InstallerProcess) { $script:InstallerProcess.Id } else { $script:WizardPid }
    while ((Get-Date) -lt $deadline) {
        # Диалог принадлежит основному setup-процессу (ребёнку SetupLdr),
        # поэтому смотрим и окна процесса установщика, и все верхние окна.
        $tops = if ($pid_ -gt 0) {
            @([EtnProbeNative]::TopWindowsOfProcess($pid_) + [EtnProbeNative]::TopWindows())
        } else {
            @([EtnProbeNative]::TopWindows())
        }
        $seen = @{}
        foreach ($h in $tops) {
            if ($seen.ContainsKey($h.ToInt64())) { continue }
            $seen[$h.ToInt64()] = $true
            if ($h -eq $script:WizardHandle) { continue }
            if (-not [EtnProbeNative]::IsWindowVisible($h)) { continue }
            $class = [EtnProbeNative]::Class($h)
            if ($class -ne 'TMsgBoxForm' -and $class -ne '#32770') { continue }
            $dialogPid = [EtnProbeNative]::WindowPid($h)
            if ($pid_ -le 0 -or (Test-ProcessDescendant -RootPid $pid_ -ChildPid $dialogPid)) { return $h }
        }
        Start-Sleep -Milliseconds 300
    }
    return [IntPtr]::Zero
}

function Invoke-Step {
    param($Step, [int]$Index)
    $card = [ordered]@{
        index  = $Index
        type   = [string]$Step.type
        name   = [string]$Step.name
        ok     = $false
        error  = ''
        at     = (Get-Date).ToUniversalTime().ToString('o')
        detail = $null
    }
    try {
        switch ([string]$Step.type) {
            'wait_window' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 120 }
                $wizard = Find-WizardWindow -TargetPid $(if ($script:InstallerProcess) { $script:InstallerProcess.Id } else { 0 }) `
                    -TitleContains ([string]$Step.title_contains) -TimeoutSec $timeout
                if ($wizard -eq [IntPtr]::Zero) { throw "Окно мастера не появилось за $timeout с." }
                $script:WizardHandle = $wizard
                $card.detail = [ordered]@{ handle = $wizard.ToInt64(); class = [EtnProbeNative]::Class($wizard); title = Get-TextOrEmpty -Handle $wizard }
            }
            'wait_page' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 60 }
                $expected = [string]$Step.title
                $found = Wait-Condition -TimeoutSec $timeout -Condition {
                    $wizard = Get-WizardHandle -TimeoutSec 5
                    if ($wizard -eq [IntPtr]::Zero) { return $false }
                    $page = Get-ActivePageSurface -Wizard $wizard
                    $info = Get-PageTitle -Wizard $wizard -Page $page
                    if ($info.title -eq $expected -or $info.title.Contains($expected)) {
                        return $info
                    }
                    return $false
                }
                if (-not $found) { throw "Страница «$expected» не появилась за $timeout с." }
                $card.detail = $found
            }
            'wait_text' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 60 }
                $expected = [string]$Step.text
                $found = Wait-Condition -TimeoutSec $timeout -Condition {
                    $wizard = Get-WizardHandle -TimeoutSec 5
                    if ($wizard -eq [IntPtr]::Zero) { return $false }
                    $hit = @(Get-TextMatches -Root $wizard -Text $expected -Exact:([bool]$Step.exact))
                    if ($hit.Count -gt 0) { return $hit[0] }
                    return $false
                }
                if (-not $found) { throw "Текст «$expected» не появился за $timeout с." }
                $card.detail = $found
            }
            'snapshot' {
                $name = if ($Step.name) { [string]$Step.name } else { "snapshot-$Index" }
                $snapshot = Get-WizardSnapshot -Name $name
                $card.name = $name
                $card.detail = [ordered]@{
                    page          = $snapshot.page
                    next_button   = $snapshot.next_button
                    list_counts   = @($snapshot.lists | ForEach-Object { $_.count })
                }
            }
            'click' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $root = $wizard
                if ($Step.within -eq 'dialog') {
                    $root = Get-DialogWindow -TimeoutSec $(if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 30 })
                    if ($root -eq [IntPtr]::Zero) { throw 'Диалог не найден.' }
                }
                $matches = @(Get-TextMatches -Root $root -Text ([string]$Step.text) -Exact:([bool]$Step.exact))
                if ($Step.class) {
                    $matches = @($matches | Where-Object { $_.class -like [string]$Step.class })
                }
                if ($matches.Count -eq 0) { throw "Контрол с текстом «$($Step.text)» не найден." }
                $target = $matches | Sort-Object area | Select-Object -First 1
                $method = if (($target.class -like '*Button*') -and (-not [bool]$Step.toggle)) {
                    Invoke-ButtonClick -Handle $target.handle -Async:([bool]$Step.async)
                } else {
                    Invoke-ControlClick -Handle $target.handle -PreferToggle:([bool]$Step.toggle)
                }
                $card.detail = [ordered]@{ handle = $target.handle.ToInt64(); class = $target.class; method = $method }
                Start-Sleep -Milliseconds 250
            }
            # Переключить флажок строки TNewCheckListBox: снаружи состояние
            # строки не читается (Inno не отдаёт checked через Win32), поэтому
            # клик ставится в левую часть строки, где нарисован флажок.
            'toggle_item' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $page = Get-ActivePageSurface -Wizard $wizard
                $listClass = if ($Step.class) { [string]$Step.class } else { 'TNewCheckListBox' }
                $index = [int]$Step.index
                $handle = $null
                foreach ($candidate in @(Get-VisibleDescendants -Root $page |
                            Where-Object { [EtnProbeNative]::Class($_) -like $listClass })) {
                    if ([EtnProbeNative]::ListCount($candidate) -gt $index) { $handle = $candidate; break }
                }
                if ($null -eq $handle) { throw "Список $listClass со строкой $index не найден." }
                $count = [EtnProbeNative]::ListCount($handle)
                $null = [EtnProbeNative]::SendMessage($handle, 0x0197, [IntPtr][math]::Max(0, $index - 2), [IntPtr]::Zero)
                Start-Sleep -Milliseconds 150
                $rect = [EtnProbeNative]::ListItemRect($handle, $index)
                if ($null -eq $rect) { throw "LB_GETITEMRECT не вернул прямоугольник строки $index." }
                $listRect = [EtnProbeNative]::Rect($handle)
                $x = $listRect[0] + $rect[0] + 10
                $y = $listRect[1] + $rect[1] + [int](($rect[3] - $rect[1]) / 2)
                [EtnProbeNative]::ClickAt($x, $y)
                Start-Sleep -Milliseconds 250
                $card.detail = [ordered]@{
                    handle = $handle.ToInt64(); index = $index; count = $count
                    rect = $rect; click = @($x, $y)
                }
            }
            'check' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $page = Get-ActivePageSurface -Wizard $wizard
                $matches = @(Get-TextMatches -Root $page -Text ([string]$Step.text) -Exact:([bool]$Step.exact))
                if ($matches.Count -eq 0) { throw "Чекбокс «$($Step.text)» не найден." }
                $target = $matches | Sort-Object area | Select-Object -First 1
                $want = if ($Step.state -eq 'off') { $false } else { $true }
                $state = [EtnProbeNative]::CheckState($target.handle)
                $uiaState = $null
                try {
                    $element = $AE::FromHandle($target.handle)
                    $pattern = $null
                    if ($element.TryGetCurrentPattern($TogglePattern.Pattern, [ref]$pattern)) {
                        $uiaState = [string]$pattern.Current.ToggleState
                    }
                } catch { }
                $current = if ($uiaState -eq 'On') { $true } elseif ($uiaState -eq 'Off') { $false } else { $state -ne 0 }
                if ($current -ne $want) {
                    $method = Invoke-ControlClick -Handle $target.handle -PreferToggle
                    $card.detail = [ordered]@{ action = 'clicked'; method = $method; before = $current }
                } else {
                    $card.detail = [ordered]@{ action = 'already'; before = $current }
                }
                Start-Sleep -Milliseconds 250
            }
            # Чекбокс, которого может не быть: лицензия запоминается после
            # первой установки, и на повторном запуске её строки нет. Отличие
            # от check — отсутствие контрола не ошибка.
            'check_optional' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $page = Get-ActivePageSurface -Wizard $wizard
                $matches = @(Get-TextMatches -Root $page -Text ([string]$Step.text) -Exact:([bool]$Step.exact))
                if ($matches.Count -eq 0) {
                    $card.detail = [ordered]@{ action = 'absent' }
                    break
                }
                $target = $matches | Sort-Object area | Select-Object -First 1
                $want = if ($Step.state -eq 'off') { $false } else { $true }
                $state = [EtnProbeNative]::CheckState($target.handle)
                $uiaState = $null
                try {
                    $element = $AE::FromHandle($target.handle)
                    $pattern = $null
                    if ($element.TryGetCurrentPattern($TogglePattern.Pattern, [ref]$pattern)) {
                        $uiaState = [string]$pattern.Current.ToggleState
                    }
                } catch { }
                $current = if ($uiaState -eq 'On') { $true } elseif ($uiaState -eq 'Off') { $false } else { $state -ne 0 }
                if ($current -ne $want) {
                    $method = Invoke-ControlClick -Handle $target.handle -PreferToggle
                    $card.detail = [ordered]@{ action = 'clicked'; method = $method; before = $current }
                } else {
                    $card.detail = [ordered]@{ action = 'already'; before = $current }
                }
                Start-Sleep -Milliseconds 250
            }
            'set_text' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $page = Get-ActivePageSurface -Wizard $wizard
                $edits = @(Get-VisibleEdits -Page $page)
                if ($edits.Count -eq 0) { throw 'На странице нет полей ввода.' }
                $index = if ($null -ne $Step.index) { [int]$Step.index } else { 0 }
                if ($index -ge $edits.Count) { throw "Поле ввода #$index не найдено (всего $($edits.Count))." }
                $method = Set-EditValue -Handle $edits[$index].handle -Text ([string]$Step.text)
                $card.detail = [ordered]@{ index = $index; method = $method; chars = ([string]$Step.text).Length }
                Start-Sleep -Milliseconds 150
            }
            'next' {
                $wizard = Get-WizardHandle -TimeoutSec 10
                $texts = if ($Step.text_any) { @($Step.text_any) } else { @('Далее', 'Установить', 'Готово', 'Завершить') }
                $button = $null
                $button = Wait-Condition -TimeoutSec $(if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 60 }) -Condition {
                    $wiz = Get-WizardHandle -TimeoutSec 5
                    if ($wiz -eq [IntPtr]::Zero) { return $false }
                    foreach ($text in $texts) {
                        $matches = @(Get-TextMatches -Root $wiz -Text $text)
                        foreach ($match in $matches) {
                            if ($match.class -notlike '*Button*') { continue }
                            if (-not [EtnProbeNative]::IsWindowEnabled($match.handle)) { continue }
                            return $match
                        }
                    }
                    return $false
                }
                if (-not $button) {
                    $disabled = @()
                    foreach ($text in $texts) {
                        $disabled += @(Get-TextMatches -Root $wizard -Text $text | Where-Object { $_.class -like '*Button*' })
                    }
                    throw ("Кнопка «" + ($texts -join '/') + "» неактивна или не найдена; найдено: " +
                        (@($disabled | ForEach-Object { $_.class + ':' + $_.text }) -join '; '))
                }
                $method = if ($Step.method -eq 'mouse') {
                    Invoke-ControlClick -Handle $button.handle
                } else {
                    Invoke-ButtonClick -Handle $button.handle -Async:([bool]$Step.async)
                }
                $card.detail = [ordered]@{ handle = $button.handle.ToInt64(); text = $button.text; method = $method }
                Start-Sleep -Milliseconds 300
            }
            'dialog_button' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 60 }
                $dialog = Get-DialogWindow -TimeoutSec $timeout
                if ($dialog -eq [IntPtr]::Zero) { throw "Диалог не появился за $timeout с." }
                $wanted = @()
                if ($Step.text_any) { $wanted = @($Step.text_any) } elseif ($Step.text) { $wanted = @([string]$Step.text) }
                $matches = @()
                foreach ($wantedText in $wanted) {
                    $matches += @(Get-TextMatches -Root $dialog -Text $wantedText -Exact:([bool]$Step.exact))
                }
                if ($matches.Count -eq 0) {
                    $all = @([EtnProbeNative]::Descendants($dialog) | ForEach-Object { [EtnProbeNative]::Class($_) + ':' + [EtnProbeNative]::Text($_) })
                    throw ("Кнопка «$($wanted -join '/')» в диалоге не найдена; контролы: " + ($all -join '; '))
                }
                $target = $matches | Sort-Object area | Select-Object -First 1
                $method = if ($target.class -like '*Button*') {
                    # Ответ в диалоге асинхронный: обработчик «Да» запускает
                    # закрытие клиента и может не вернуться до его конца.
                    Invoke-ButtonClick -Handle $target.handle -Async
                } else {
                    Invoke-ControlClick -Handle $target.handle
                }
                $card.detail = [ordered]@{
                    dialog_class = [EtnProbeNative]::Class($dialog)
                    dialog_title = Get-TextOrEmpty -Handle $dialog
                    button       = $target.text
                    method       = $method
                }
                Start-Sleep -Milliseconds 300
            }
            'wait_finished' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 900 }
                $result = Wait-Condition -TimeoutSec $timeout -Condition {
                    $wizard = Get-WizardHandle -TimeoutSec 10
                    if ($wizard -eq [IntPtr]::Zero) { return $false }
                    foreach ($needle in @('Установка ETN завершена', 'Установка ETN не завершена', 'Установка не завершена')) {
                        $hit = @(Get-TextMatches -Root $wizard -Text $needle -Exact)
                        if ($hit.Count -gt 0) { return [ordered]@{ heading = $needle; found = $hit[0].text } }
                    }
                    return $false
                }
                if (-not $result) { throw "Итоговый экран не появился за $timeout с." }
                $card.detail = $result
            }
            'wait_exit' {
                $timeout = if ($Step.timeout_sec) { [int]$Step.timeout_sec } else { 300 }
                if ($script:InstallerProcess) {
                    if (-not $script:InstallerProcess.WaitForExit($timeout * 1000)) {
                        throw "Процесс установщика не завершился за $timeout с."
                    }
                    $card.detail = [ordered]@{ exit_code = $script:InstallerProcess.ExitCode }
                    $script:Result['installer']['exit_code'] = $script:InstallerProcess.ExitCode
                }
            }
            'sleep' {
                Start-Sleep -Milliseconds ([int]$Step.ms)
            }
            'launch' {
                $exe = [string]$Step.exe
                if (-not (Test-Path -LiteralPath $exe)) { throw "Нет файла: $exe" }
                $startInfo = New-Object System.Diagnostics.ProcessStartInfo
                $startInfo.FileName = $exe
                if ($Step.arguments) { $startInfo.Arguments = (@($Step.arguments) -join ' ') }
                $startInfo.UseShellExecute = $true
                $startInfo.WorkingDirectory = Split-Path -Parent $exe
                $launched = [System.Diagnostics.Process]::Start($startInfo)
                $card.detail = [ordered]@{ pid = $launched.Id; exe = $exe }
                Start-Sleep -Milliseconds ([int]$(if ($Step.settle_ms) { $Step.settle_ms } else { 500 }))
            }
            'suspend_process' {
                $nameFilter = if ($Step.name_filter) { [string]$Step.name_filter } else { 'ETN' }
                $prefix = [string]$Step.path_prefix
                $suspended = @()
                foreach ($process in @(Get-Process -Name $nameFilter -ErrorAction SilentlyContinue)) {
                    $path = ''
                    try { $path = [string]$process.Path } catch { $path = '' }
                    if ($prefix -and -not $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                    if ([EtnProbeNative]::SuspendProcess($process.Id)) { $suspended += $process.Id }
                }
                if ($suspended.Count -eq 0) {
                    throw "Процесс $nameFilter с путём «$prefix» не найден или не приостановлен."
                }
                $card.detail = [ordered]@{ suspended = $suspended }
            }
            'check_secret_absent' {
                $secretPath = [string]$Step.secret_file
                if (-not $secretPath -or -not (Test-Path -LiteralPath $secretPath)) {
                    throw "Нет файла секрета: $secretPath"
                }
                $secret = ([System.IO.File]::ReadAllText($secretPath)).Trim()
                if (-not $secret) { throw 'Файл секрета пуст.' }
                # Отсутствующее log_dirs (поле плана не задано) — не то же самое,
                # что пустой список: @($null) даёт Count=1. Поэтому сначала
                # проверяем само поле, затем уже строим список каталогов.
                $dirs = @()
                if ($Step.log_dirs) { $dirs = @($Step.log_dirs | Where-Object { $_ }) }
                if ($dirs.Count -eq 0) {
                    $dirs = @(
                        (Join-Path $env:ProgramData 'ETN\logs'),
                        'C:\Windows\Temp',
                        $env:TEMP,
                        (Join-Path $env:LOCALAPPDATA 'Temp')
                    )
                }
                $cutoff = (Get-Date).AddMinutes(-180)
                $checked = 0
                $found = @()
                # Журнал установщика создаётся при старте (SetupLogging=yes), но
                # первые байты могут появиться с задержкой — ждём появления
                # хотя бы одного файла, иначе проверка «ключ не в журналах»
                # ложно краснеет.
                $scanDeadline = (Get-Date).AddSeconds(15)
                do {
                    $checked = 0
                    $found = @()
                    foreach ($dir in ($dirs | Select-Object -Unique)) {
                        if (-not (Test-Path -LiteralPath $dir)) { continue }
                        foreach ($pattern in @('*.log', 'Setup Log*.txt')) {
                            foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter $pattern -File -Recurse -ErrorAction SilentlyContinue |
                                        Where-Object { $_.LastWriteTime -gt $cutoff })) {
                                $checked++
                                try {
                                    if ([System.IO.File]::ReadAllText($file.FullName).Contains($secret)) {
                                        $found += $file.FullName
                                    }
                                } catch { }
                            }
                        }
                    }
                    if ($checked -gt 0 -or $found.Count -gt 0) { break }
                    Start-Sleep -Milliseconds 500
                } while ((Get-Date) -lt $scanDeadline)
                $secret = $null
                $card.detail = [ordered]@{
                    secret_file_present = $true
                    files_checked       = $checked
                    files_with_secret   = $found
                }
                if ($found.Count -gt 0) {
                    throw ('секрет найден в журналах: ' + ($found -join ', '))
                }
                if ($checked -eq 0) { throw 'не проверено ни одного журнала' }
            }
            'kill' {
                # Мастер Inno живёт в дочернем процессе загрузчика (*.tmp).
                # Убийство одного загрузчика оставляло окно и однопользовательский
                # мьютекс установщика: следующий запуск не показывал мастер
                # (наблюдалось 2026-11-08 в G3 после снимка чистой страницы).
                $ids = @()
                if ($script:InstallerProcess) {
                    $rootPid = $script:InstallerProcess.Id
                    $ids += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" `
                            -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.ProcessId })
                    $ids += $rootPid
                }
                if ($script:WizardHandle -ne [IntPtr]::Zero) {
                    $wizardPid = [EtnProbeNative]::WindowPid($script:WizardHandle)
                    if ($wizardPid -gt 0) { $ids += $wizardPid }
                }
                $killed = @()
                foreach ($processId in ($ids | Sort-Object -Unique)) {
                    try {
                        Stop-Process -Id $processId -Force -ErrorAction Stop
                        $killed += $processId
                    } catch { }
                }
                $card.detail = [ordered]@{ killed = $killed }
            }
            'note' {
                $card.detail = [ordered]@{ note = [string]$Step.text }
            }
            'measure_text' {
                # Диагностика измерения: высота текста при разных ширинах
                # шрифтом самого контрола и шрифтом формы мастера.
                $wizard = Get-WizardHandle -TimeoutSec 10
                $page = Get-ActivePageSurface -Wizard $wizard
                $needle = [string]$Step.text
                $handle = [IntPtr]::Zero
                $target = @(Get-TextMatches -Root $page -Text $needle) | Sort-Object area | Select-Object -First 1
                if ($target) { $handle = $target.handle }
                $widths = @($Step.widths)
                if ($widths.Count -eq 0) { $widths = @(516, 400, 300) }
                $rows = @()
                foreach ($w in $widths) {
                    $rows += [ordered]@{
                        width              = [int]$w
                        height_own_font    = [EtnProbeNative]::MeasureHeight($handle, $needle, [int]$w, $true)
                        height_foreign_font = [EtnProbeNative]::MeasureHeightForeign($handle, $needle, [int]$w, $true)
                        height_wizard_font = [EtnProbeNative]::MeasureHeight($wizard, $needle, [int]$w, $true)
                    }
                }
                $card.detail = [ordered]@{
                    handle      = $handle.ToInt64()
                    own_font    = if ($handle -ne [IntPtr]::Zero) { [EtnProbeNative]::FontInfo($handle) } else { 'нет контрола' }
                    wizard_font = [EtnProbeNative]::FontInfo($wizard)
                    extent      = if ($handle -ne [IntPtr]::Zero) { [EtnProbeNative]::TextExtent($handle, $needle) } else { '' }
                    rows        = $rows
                }
            }
            'dump_windows' {
                # Диагностика: какие окна видит проба в сессии и что с
                # процессом установщика. Помогает отличить «нет окна» от
                # «другой класс окна/диалог/процесс упал».
                $all = @()
                foreach ($h in @([EtnProbeNative]::TopWindows())) {
                    $all += [ordered]@{
                        handle  = $h.ToInt64()
                        class   = [EtnProbeNative]::Class($h)
                        text    = Get-TextOrEmpty -Handle $h
                        pid     = [EtnProbeNative]::WindowPid($h)
                        visible = [EtnProbeNative]::IsWindowVisible($h)
                    }
                }
                $own = @()
                $exited = $null
                $exitCode = $null
                if ($script:InstallerProcess) {
                    foreach ($h in @([EtnProbeNative]::TopWindowsOfProcess($script:InstallerProcess.Id))) {
                        $own += [ordered]@{
                            handle  = $h.ToInt64()
                            class   = [EtnProbeNative]::Class($h)
                            text    = Get-TextOrEmpty -Handle $h
                            visible = [EtnProbeNative]::IsWindowVisible($h)
                        }
                    }
                    $exited = $script:InstallerProcess.HasExited
                    if ($exited) { $exitCode = $script:InstallerProcess.ExitCode }
                }
                $card.detail = [ordered]@{
                    installer_pid = if ($script:InstallerProcess) { $script:InstallerProcess.Id } else { 0 }
                    exited        = $exited
                    exit_code     = $exitCode
                    foreground    = [EtnProbeNative]::Foreground()
                    installer     = $own
                    all           = $all
                }
            }
            'dump_tree' {
                # Диагностика дерева окон мастера: классы, родители, тексты,
                # геометрия. Нужна, когда снимок страницы пуст — сразу видно,
                # какие классы у поверхности страницы и контролов.
                $wizard = Get-WizardHandle -TimeoutSec 20
                if ($wizard -eq [IntPtr]::Zero) { throw 'Окно мастера не найдено.' }
                $nodes = @()
                foreach ($h in (@($wizard) + @([EtnProbeNative]::Descendants($wizard)))) {
                    $rect = [EtnProbeNative]::Rect($h)
                    $parent = [EtnProbeNative]::GetParent($h)
                    $nodes += [ordered]@{
                        handle  = $h.ToInt64()
                        parent  = $parent.ToInt64()
                        class   = [EtnProbeNative]::Class($h)
                        text    = (Get-RedactedText -Text (Get-TextOrEmpty -Handle $h) -Class ([EtnProbeNative]::Class($h)))
                        visible = [EtnProbeNative]::IsWindowVisible($h)
                        rect    = @($rect[0], $rect[1], $rect[2], $rect[3])
                    }
                }
                $card.detail = [ordered]@{ wizard = $wizard.ToInt64(); nodes = $nodes }
            }
            default {
                throw "Неизвестный шаг «$($Step.type)»."
            }
        }
        $card.ok = $true
    } catch {
        $card.ok = $false
        $card.error = $_.Exception.Message
    }
    $card.finished_at = (Get-Date).ToUniversalTime().ToString('o')
    $script:StepList.Add($card)
    return $card
}

# --- Основной сценарий -----------------------------------------------------

try {
    $planObject = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:KeepInstaller = [bool]$planObject.keep_installer
    $script:Result['session'] = Get-SessionInfo

    if ($planObject.exe) {
        $exe = [string]$planObject.exe
        $arguments = @()
        if ($planObject.arguments) { $arguments = @($planObject.arguments) }
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $exe
        if ($arguments.Count -gt 0) { $startInfo.Arguments = ($arguments -join ' ') }
        $startInfo.UseShellExecute = $true
        $startInfo.WorkingDirectory = Split-Path -Parent $exe
        $proc = [System.Diagnostics.Process]::Start($startInfo)
        $script:InstallerProcess = $proc
        $script:WizardPid = $proc.Id
        Write-ProgressLine ("installer pid={0} exe={1}" -f $proc.Id, $exe)
        $script:Result['installer'] = [ordered]@{
            exe        = $exe
            arguments  = $arguments
            pid        = $proc.Id
            exit_code  = $null
            launched_at = (Get-Date).ToUniversalTime().ToString('o')
        }
    } else {
        $script:WizardPid = if ($planObject.pid) { [int]$planObject.pid } else { 0 }
        $script:Result['installer'] = [ordered]@{
            exe       = ''
            arguments = @()
            pid       = $script:WizardPid
            exit_code = $null
        }
        if ($planObject.title) {
            $handle = Find-WizardWindow -TargetPid $script:WizardPid -TitleContains ([string]$planObject.title) -TimeoutSec 30
            if ($handle -ne [IntPtr]::Zero) { $script:WizardHandle = $handle }
        }
    }

    $steps = @($planObject.steps)
    $index = 0
    $failed = $false
    foreach ($step in $steps) {
        if ($failed) {
            $script:StepList.Add([ordered]@{
                    index = $index; type = [string]$step.type; name = [string]$step.name
                    ok = $false; deferred = $true; error = 'пропущен после сбоя'
                    at = (Get-Date).ToUniversalTime().ToString('o')
                })
            $index++
            continue
        }
        Write-ProgressLine ("start {0} {1}" -f $index, $step.type)
        $card = Invoke-Step -Step $step -Index $index
        Write-ProgressLine ("done {0} ok={1} error={2}" -f $index, $card.ok, ([string]$card.error))
        if (-not $card.ok) { $failed = $true }
        $index++
    }

    if ($script:InstallerProcess -and -not $planObject.keep_installer) {
        if (-not $script:InstallerProcess.HasExited) {
            $script:Result['warnings'] += 'установщик остался запущенным после сценария'
        }
    }
    $script:Result['ok'] = -not $failed
    if ($failed) {
        $script:Result['error'] = (@($script:StepList | Where-Object { -not $_.ok -and -not $_.deferred } |
                    ForEach-Object { $_.type + ': ' + $_.error }) -join ' | ')
    }
} catch {
    $script:Result['ok'] = $false
    $script:Result['error'] = $_.Exception.Message
} finally {
    if ($script:InstallerProcess) {
        try {
            $script:Result['installer']['has_exited'] = $script:InstallerProcess.HasExited
            if ($script:InstallerProcess.HasExited) {
                $script:Result['installer']['exit_code'] = $script:InstallerProcess.ExitCode
            }
            # Незавершённый установщик не должен оставаться в сессии: следующая
            # проба иначе найдёт чужое окно мастера (сбой шага не должен
            # оставлять мусор в интерактивном рабочем столе).
            if (-not $script:Result['ok'] -and -not $script:KeepInstaller -and
                -not $script:InstallerProcess.HasExited) {
                $script:InstallerProcess.Kill()
                $null = $script:InstallerProcess.WaitForExit(10000)
                $script:Result['warnings'] += 'установщик снят после сбоя пробы'
            }
            $script:Result['installer']['still_running'] = -not $script:InstallerProcess.HasExited
        } catch { }
    }
    $script:Result['steps'] = $script:StepList.ToArray()
    $script:Result['snapshots'] = $script:SnapshotMap
    $script:Result['finished_at'] = (Get-Date).ToUniversalTime().ToString('o')
    Write-ProgressLine ("finished ok={0}" -f $script:Result['ok'])
    Write-Result
    if ($script:Result['ok']) { exit 0 } else { exit 3 }
}
