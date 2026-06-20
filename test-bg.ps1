Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$prevHwnd = [Win32]::GetForegroundWindow()
Start-Process "https://youtube.com"
Start-Sleep -Milliseconds 800
$newHwnd = [Win32]::GetForegroundWindow()
if ($newHwnd -ne $prevHwnd) {
    [void][Win32]::ShowWindow($newHwnd, 6) # SW_MINIMIZE
}
[void][Win32]::SetForegroundWindow($prevHwnd)
