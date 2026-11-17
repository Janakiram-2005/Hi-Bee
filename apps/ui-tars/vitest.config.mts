/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import tsconfigPath from 'vite-tsconfig-paths';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: './',
  test: {
    globals: true,
    environment: 'node',
  },

  plugins: [
    // @ts-ignore
    tsconfigPath({
      projects: ['./tsconfig.node.json'],
    }),
  ],
});
