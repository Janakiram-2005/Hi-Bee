/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { initIpc } from '@ui-tars/electron-ipc/main';
import { checkBrowserAvailability } from '../services/browserCheck';
import { isExtensionInstalled, sendExtensionCommand } from '../services/extensionServer';

const t = initIpc.create();

export const browserRoute = t.router({
  checkBrowserAvailability: t.procedure.input<void>().handle(async () => {
    return await checkBrowserAvailability();
  }),
  isExtensionInstalled: t.procedure.input<void>().handle(async () => {
    return isExtensionInstalled();
  }),
  sendExtensionCommand: t.procedure.input<string>().handle(async ({ input }) => {
    return await sendExtensionCommand(input);
  })
});
