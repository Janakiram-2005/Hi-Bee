/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { initIpc } from '@ui-tars/electron-ipc/main';
import { shell } from 'electron';
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
  }),
  openExternal: t.procedure.input<{url: string}>().handle(async ({ input }) => {
    await shell.openExternal(input.url);
    return true;
  })
});
