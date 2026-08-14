import * as yaml from 'js-yaml';
import { z } from 'zod';

/**
 * Runtime schema for a workspace `config.yaml`.
 *
 * This is the single source of truth for the config's shape — the TypeScript
 * type is inferred from it (`IWorkspaceConfig`) rather than declared alongside
 * it, so the compile-time and runtime views cannot drift. Before this existed
 * the config was `yaml.load`ed and straight-cast, which meant an
 * `executionOrder` written in the wrong shape was silently ignored and every
 * flow ran in parallel (dcd-cli#110).
 */

/**
 * Tags may be written as a bare scalar (`includeTags: smoke`) or a list.
 * Scalars are wrapped, and primitive members are coerced to strings so a
 * YAML-numeric tag (`includeTags: [2]`) still compares against flow tags
 * instead of silently matching nothing.
 */
const tagList = z.preprocess((value) => {
  if (value === null || value === undefined) return value;
  const members = Array.isArray(value) ? value : [value];
  return members.map((member) =>
    typeof member === 'number' || typeof member === 'boolean'
      ? String(member)
      : member,
  );
}, z.array(z.string()));

/** Sequential execution configuration */
const ExecutionOrderSchema = z.object({
  // Defaults to true: a failing flow does not stop the rest of the sequence.
  // Declared here so the default lives in one place instead of being
  // re-specified at each read site.
  continueOnFailure: z.boolean().default(true),
  flowsOrder: z.array(z.string()),
});

/**
 * `looseObject`, not `object`: unknown keys are reported as warnings but must
 * survive parsing, because the whole config is forwarded to the API as
 * `fields.workspaceConfig` and stripping keys would silently alter that
 * payload.
 */
export const WorkspaceConfigSchema = z.looseObject({
  excludeTags: tagList.nullish(),
  executionOrder: ExecutionOrderSchema.nullish(),
  flows: z.array(z.string()).nullish(),
  includeTags: tagList.nullish(),
  local: z
    .looseObject({ deterministicOrder: z.boolean().nullish() })
    .nullish(),
  notifications: z
    .looseObject({
      email: z
        .looseObject({
          enabled: z.boolean().optional(),
          onSuccess: z.boolean().optional(),
          recipients: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .nullish(),
  platform: z
    .looseObject({
      android: z
        .looseObject({ disableAnimations: z.boolean().optional() })
        .optional(),
      ios: z
        .looseObject({ disableAnimations: z.boolean().optional() })
        .optional(),
    })
    .nullish(),
});

/** Workspace configuration from config.yaml */
export type IWorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/**
 * Top-level keys that only ever appear in a workspace config, derived from the
 * schema so the two can't drift. Deliberately excludes keys Maestro also allows
 * in flow front matter — appId, name, tags, env, onFlowStart, onFlowComplete,
 * jsEngine — because this set also drives config-vs-flow detection
 * (`isWorkspaceConfigFile`).
 */
export const WORKSPACE_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.keys(WorkspaceConfigSchema.shape),
);

/**
 * Near-misses that aren't just a casing slip on a real key. Keyed lowercase.
 */
const KEY_ALIASES: Record<string, string> = {
  continueonfailure: 'executionOrder.continueOnFailure',
  excludetag: 'excludeTags',
  floworder: 'executionOrder.flowsOrder',
  flowsorder: 'executionOrder.flowsOrder',
  includetag: 'includeTags',
  tags: 'includeTags / excludeTags',
};

/**
 * Suggest the key the author probably meant.
 * @param unknownKey - Unrecognised top-level key from the config
 * @returns The suggested key name, or undefined if there's no close match
 */
function suggestKey(unknownKey: string): string | undefined {
  const lowered = unknownKey.toLowerCase();
  const casingSlip = [...WORKSPACE_CONFIG_KEYS].find(
    (key) => key.toLowerCase() === lowered,
  );

  return casingSlip ?? KEY_ALIASES[lowered];
}

/**
 * Describe how an `executionOrder` value is malformed, in prose.
 *
 * Split out so the most likely mistake — a bare list of flow names — gets a
 * message showing the expected shape rather than a generic schema dump.
 *
 * @param value - The raw `executionOrder` value from the config
 * @returns A description of the problem, or undefined if the shape is valid
 */
function describeExecutionOrderShape(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return 'a bare list of flow names';
  if (typeof value !== 'object') return `a ${typeof value} value`;

  const { flowsOrder } = value as Record<string, unknown>;
  if (flowsOrder === undefined) return 'a map with no `flowsOrder` key';
  if (!Array.isArray(flowsOrder)) {
    return 'a map whose `flowsOrder` is not a list';
  }

  return undefined;
}

/** Indent a YAML fragment so it reads as a block inside an error message. */
function indentYaml(value: unknown): string {
  return yaml
    .dump(value, { lineWidth: -1 })
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * Build the error for a malformed `executionOrder`, showing what was found
 * next to what was expected.
 * @param filePath - Path to the config file, for the message
 * @param problem - Prose description from describeExecutionOrderShape
 * @param found - The raw `executionOrder` value that failed
 * @returns The error to throw
 */
function executionOrderError(
  filePath: string,
  problem: string,
  found: unknown,
): Error {
  return new Error(
    `Invalid \`executionOrder\` in ${filePath}\n\n` +
      `\`executionOrder\` must be a map containing a \`flowsOrder\` list, but it is ${problem}.\n\n` +
      `Found:\n${indentYaml({ executionOrder: found })}\n\n` +
      `Expected:\n${indentYaml({
        executionOrder: {
          continueOnFailure: true,
          flowsOrder: ['first-flow', 'second-flow'],
        },
      })}\n\n` +
      `Without \`flowsOrder\` the flows are not sequenced — they all run in parallel.`,
  );
}

/**
 * Validate a parsed workspace config.
 *
 * Hard errors (thrown): the config isn't a map, or `executionOrder` is present
 * but malformed. Both are unambiguous mistakes with no valid interpretation, so
 * failing fast beats a warning that scrolls past in CI.
 *
 * Soft problems (warned): unknown top-level keys. These are preserved, not
 * stripped, and warned about once.
 *
 * @param raw - The result of loading the YAML file
 * @param options - Config file path (for messages) and a warning sink
 * @returns The validated config, with defaults applied
 * @throws Error if the config is not a map or `executionOrder` is malformed
 */
export function parseWorkspaceConfig(
  raw: unknown,
  options: { filePath: string; warn: (message: string) => void },
): IWorkspaceConfig {
  const { filePath, warn } = options;

  if (raw === null || raw === undefined) return {};

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Invalid workspace config in ${filePath}\n\n` +
        `Expected a map of configuration keys (${[...WORKSPACE_CONFIG_KEYS].join(
          ', ',
        )}), but found ${Array.isArray(raw) ? 'a list' : `a ${typeof raw} value`}.`,
    );
  }

  const rawConfig = raw as Record<string, unknown>;

  // Checked ahead of the schema so this specific mistake gets a targeted
  // message; the schema would otherwise report "expected object, received array".
  const executionOrderProblem = describeExecutionOrderShape(
    rawConfig.executionOrder,
  );
  if (executionOrderProblem) {
    throw executionOrderError(
      filePath,
      executionOrderProblem,
      rawConfig.executionOrder,
    );
  }

  const unknownKeys = Object.keys(rawConfig).filter(
    (key) => !WORKSPACE_CONFIG_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    const lines = unknownKeys.map((key) => {
      const suggestion = suggestKey(key);
      return suggestion
        ? `  ${key} — did you mean ${suggestion}?`
        : `  ${key}`;
    });

    warn(
      `Warning: unrecognised key(s) in ${filePath} — these are ignored:\n` +
        `${lines.join('\n')}\n\n` +
        `Supported keys: ${[...WORKSPACE_CONFIG_KEYS].join(', ')}`,
    );
  }

  const result = WorkspaceConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  ${location}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(`Invalid workspace config in ${filePath}\n\n${issues}`);
  }

  return result.data;
}
