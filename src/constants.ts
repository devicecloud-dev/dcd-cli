/**
 * Consolidated flag definitions.
 * Flags are organized by domain in src/config/flags/
 */

import type { ArgsDef } from 'citty';

import { apiFlags } from './config/flags/api.flags.js';
import { binaryFlags } from './config/flags/binary.flags.js';
import { deviceFlags } from './config/flags/device.flags.js';
import { environmentFlags } from './config/flags/environment.flags.js';
import { executionFlags } from './config/flags/execution.flags.js';
import { githubFlags } from './config/flags/github.flags.js';
import { outputFlags } from './config/flags/output.flags.js';

/**
 * All flag definitions consolidated from domain-specific flag modules.
 * Spread into a command's `args` to expose the full cloud-command surface.
 */
export const flags = {
  ...apiFlags,
  ...binaryFlags,
  ...deviceFlags,
  ...environmentFlags,
  ...executionFlags,
  ...githubFlags,
  ...outputFlags,
} as const satisfies ArgsDef;

export type FlagKey = keyof typeof flags;
