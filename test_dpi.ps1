$p = [IntPtr]::Zero
$h = (Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);' -Name "DC" -PassThru)::GetDC($p)
$g = (Add-Type -MemberDefinition '[DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);' -Name "Caps" -PassThru)::GetDeviceCaps($h, 88) # LOGPIXELSX = 88
Write-Output "DPI: $g"
Write-Output "ScaleFactor: $($g / 96.0)"
