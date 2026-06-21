import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';

const t = initIpc.create();

export const visionRoute = t.router({
  startVisionBrain: t.procedure.handle(async () => {
    logger.info('[Vision] Vision engine handled by frontend now.');
    return { success: true };
  }),

  stopVisionBrain: t.procedure.handle(async () => {
    logger.info('[Vision] Vision engine handled by frontend now.');
    return { success: true };
  })
});
