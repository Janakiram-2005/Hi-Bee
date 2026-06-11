const { exec } = require('child_process');

const psCmd = `Get-Process | Where-Object { $_.ProcessName -like '*notepad*' } | Select-Object Id, ProcessName, MainWindowHandle, MainWindowTitle | ConvertTo-Json`;

exec(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, (error, stdout) => {
    if (error) {
        console.error('Error:', error);
    }
    console.log('Notepad processes found on system:');
    console.log(stdout.trim());
});
