import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { logger } from '../logger';

export function registerSystemHandlers() {
  ipcMain.handle('system:action', async (_, { action, arg }) => {
    logger.info(`[System] Executing action: ${action}`);
    
    if (action === 'volume_up') {
      exec('powershell -c "$obj = new-object -com wscript.shell; $obj.SendKeys([char]175)"');
    } else if (action === 'volume_down') {
      exec('powershell -c "$obj = new-object -com wscript.shell; $obj.SendKeys([char]174)"');
    } else if (action === 'play_pause') {
      exec('powershell -c "$obj = new-object -com wscript.shell; $obj.SendKeys([char]179)"');
    } else if (action === 'open_app') {
      if (arg) {
        // e.g. start notepad.exe or https://google.com
        exec(`start ${arg}`);
      }
    }
    
    return true;
  });
}
