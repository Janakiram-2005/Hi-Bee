const { mouse, Point } = require('@computer-use/nut-js');
const { exec } = require('child_process');

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

async function run() {
    console.log('Moving mouse to (500, 500) using nut-js...');
    await mouse.setPosition(new Point(500, 500));

    // Query physical position using PowerShell (which will call GetCursorPos)
    const psCmd = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
}
"@
$pt = New-Object Win32+POINT
if ([Win32]::GetCursorPos([ref]$pt)) {
    Write-Output "PhysicalCursorPos: $($pt.X), $($pt.Y)"
} else {
    Write-Output "failed"
}
`;
    try {
        const out = await execPromise(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`);
        console.log(out);
    } catch (e) {
        console.error("Error executing PowerShell:", e);
    }
}

run();

