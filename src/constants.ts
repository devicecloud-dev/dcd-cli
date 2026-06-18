/**
 * Consolidated flag definitions.
 * Flags are organized by domain in src/config/flags/
 */

import type { ArgsDef } from 'citty';

import { apiFlags } from './config/flags/api.flags';
import { binaryFlags } from './config/flags/binary.flags';
import { deviceFlags } from './config/flags/device.flags';
import { environmentFlags } from './config/flags/environment.flags';
import { executionFlags } from './config/flags/execution.flags';
import { githubFlags } from './config/flags/github.flags';
import { outputFlags } from './config/flags/output.flags';

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
