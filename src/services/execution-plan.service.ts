import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getFlowsToRunInSequence,
  isFlowFile,
  isWorkspaceConfigFile,
  processDependencies,
  readDirectory,
  readTestYamlFileAsJson,
  readYamlFileAsJson,
} from './execution-plan.utils.js';

/** Email notification configuration */
interface INotificationsConfig {
  email?: {
    enabled?: boolean;
    onSuccess?: boolean;
    recipients?: string[];
  };
}

/** Workspace configuration from config.yaml */
interface IWorkspaceConfig {
  excludeTags?: null | string[];
  executionOrder?: IExecutionOrder | null;
  flows?: null | string[];
  includeTags?: null | string[];
  local?: ILocal | null;
  notifications?: INotificationsConfig;
  platform?: {
    android?: { disableAnimations?: boolean };
    ios?: { disableAnimations?: boolean };
  };
}

/** Local execution configuration */
interface ILocal {
  deterministicOrder: boolean | null;
}

/** Sequential execution configuration */
interface IExecutionOrder {
  continueOnFailure: boolean;
  flowsOrder: string[];
}

/** Options for execution plan generation */
export interface PlanOptions {
  configFile?: string;
  debug?: boolean;
  excludeFlows?: string[];
  excludeTags?: string[];
  includeTags?: string[];
  input: string;
}

/** Execution plan containing all flows to run with metadata and dependencies */
export interface IExecutionPlan {
  allExcludeTags?: null | string[];
  allIncludeTags?: null | string[];
  flowMetadata: Record<string, Record<string, unknown>>;
  flowOverrides: Record<string, Record<string, unknown>>;
  flowsToRun: string[];
  referencedFiles: string[];
  sequence?: IFlowSequence | null;
  totalFlowFiles: number;
  workspaceConfig?: IWorkspaceConfig;
}

/** Flow sequence configuration for ordered execution */
interface IFlowSequence {
  continueOnFailure?: boolean;
  flows: string[];
}

/**
 * Recursively check and resolve all dependencies for a flow file
 * Includes runFlow references, JavaScript scripts, and media files
 * @param input - Path to flow file to check
 * @returns Array of all dependency file paths (deduplicated)
 * @throws Error if any referenced files are missing
 */
async function checkDependencies(input: string): Promise<string[]> {
  const checkedDependencies: string[] = [];
  const uncheckedDependencies: string[] = [input];

  while (uncheckedDependencies.length > 0) {
    const fileToCheck = uncheckedDependencies.shift()!;
    const { config, testSteps } = readTestYamlFileAsJson(fileToCheck);
    const { allErrors, allFiles } = processDependencies({
      config,
      input: fileToCheck,
      testSteps,
    });

    if (allErrors.length > 0) {
      throw new Error(
        'The following flow files are not present in the filesystem: \n' +
          allErrors.join('\n'),
      );
    }

    for (const file of allFiles) {
      if (!isFlowFile(file)) {
        // js/media files don't have dependencies
        checkedDependencies.push(file);
      }

      if (!checkedDependencies.includes(file)) {
        uncheckedDependencies.push(file);
      }
    }

    if (!checkedDependencies.includes(fileToCheck)) {
      checkedDependencies.push(fileToCheck);
    }
  }

  return checkedDependencies;
}

/**
 * Filter flow files based on exclude patterns
 * @param unfilteredFlowFiles - All discovered flow files
 * @param excludeFlows - Patterns to exclude
 * @returns Filtered array of flow file paths
 */
function filterFlowFiles(
  unfilteredFlowFiles: string[],
  excludeFlows?: string[],
): string[] {
  if (excludeFlows) {
    return unfilteredFlowFiles.filter(
      (file) =>
        !excludeFlows.some((flow) =>
          path.normalize(file).startsWith(path.normalize(path.resolve(flow))),
        ),
    );
  }

  return unfilteredFlowFiles;
}

/**
 * Load workspace configuration from config.yaml/yml if present
 * @param input - Input directory path
 * @param unfilteredFlowFiles - List of discovered flow files
 * @returns Workspace configuration object (empty if no config file found)
 */
function getWorkspaceConfig(
  input: string,
  unfilteredFlowFiles: string[],
): IWorkspaceConfig {
  const possibleConfigPaths = new Set(
    [path.join(input, 'config.yaml'), path.join(input, 'config.yml')].map((p) =>
      path.normalize(p),
    ),
  );

  const configFilePath = unfilteredFlowFiles.find((file) =>
    possibleConfigPaths.has(path.normalize(file)),
  );

  const config = configFilePath
    ? (readYamlFileAsJson(configFilePath) as IWorkspaceConfig)
    : {};

  return config;
}

/**
 * Extract DeviceCloud-specific override environment variables
 * Looks for env vars prefixed with DEVICECLOUD_OVERRIDE_
 * @param config - Flow configuration object
 * @returns Object containing override key-value pairs
 */
function extractDeviceCloudOverrides(
  config: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!config || !config.env || typeof config.env !== 'object') {
    return {};
  }

  const overrides: Record<string, unknown> = {};
  const envVars = config.env as Record<string, unknown>;

  for (const [key, value] of Object.entries(envVars)) {
    if (key.startsWith('DEVICECLOUD_OVERRIDE_')) {
      // Remove the DEVICECLOUD_OVERRIDE_ prefix and use the rest as the override key
      const overrideKey = key.replace('DEVICECLOUD_OVERRIDE_', '');
      overrides[overrideKey] = value;
    }
  }

  return overrides;
}

/**
 * Generate execution plan for a single flow file
 * @param normalizedInput - Normalized path to the flow file
 * @param resolvedConfigFile - Optional absolute path to a custom config file
 * @returns Execution plan for the single file with dependencies
 */
async function planSingleFile(
  normalizedInput: string,
  resolvedConfigFile?: string,
): Promise<IExecutionPlan> {
  const inputBasename = path.basename(normalizedInput);
  if (
    inputBasename === 'config.yaml' ||
    inputBasename === 'config.yml' ||
    isWorkspaceConfigFile(normalizedInput)
  ) {
    throw new Error(
      'If using config.yaml, pass the workspace folder path, not the config file or a custom path via --config',
    );
  }

  const { config } = readTestYamlFileAsJson(normalizedInput);
  const flowMetadata: Record<string, Record<string, unknown>> = {};
  const flowOverrides: Record<string, Record<string, unknown>> = {};

  if (config) {
    flowMetadata[normalizedInput] = config;
    flowOverrides[normalizedInput] = extractDeviceCloudOverrides(config);
  }

  let workspaceConfig: IWorkspaceConfig | undefined;
  if (resolvedConfigFile) {
    if (!fs.existsSync(resolvedConfigFile)) {
      throw new Error(`Config file does not exist: ${resolvedConfigFile}`);
    }

    workspaceConfig = readYamlFileAsJson(
      resolvedConfigFile,
    ) as IWorkspaceConfig;
  }

  const checkedDependancies = await checkDependencies(normalizedInput);
  return {
    flowMetadata,
    flowOverrides,
    flowsToRun: [normalizedInput],
    referencedFiles: [...new Set(checkedDependancies)],
    totalFlowFiles: 1,
    workspaceConfig,
  };
}

/**
 * Apply workspace.flows glob patterns to filter flow files
 * @param workspaceConfig - Workspace configuration containing flow globs
 * @param normalizedInput - Normalized path to the workspace directory
 * @param unfilteredFlowFiles - List of all discovered flow files
 * @param resolvedConfigFile - Optional absolute path to a custom config file
 * @param excludeFlows - --exclude-flows patterns to re-apply to glob matches
 * @returns Filtered list of flow file paths matching the globs
 */
async function applyFlowGlobs(
  workspaceConfig: IWorkspaceConfig,
  normalizedInput: string,
  unfilteredFlowFiles: string[],
  resolvedConfigFile?: string,
  excludeFlows?: string[],
): Promise<string[]> {
  // Both branches compare absolute paths, so `--config ./x.yml` and
  // `--config /abs/x.yml` behave identically, and a same-named file in a
  // sibling directory is never mistaken for the active config.
  const activeConfig = resolvedConfigFile
    ? path.normalize(resolvedConfigFile)
    : undefined;
  const isExcludedConfig = (absolutePath: string): boolean => {
    const base = path.basename(absolutePath);
    if (base === 'config.yaml' || base === 'config.yml') return true;
    return (
      activeConfig !== undefined &&
      path.normalize(absolutePath) === activeConfig
    );
  };

  if (workspaceConfig.flows) {
    const globs = workspaceConfig.flows.map((g) => g);
    // fs.globSync lands in Node 22; the CLI's `engines.node` already requires it.
    // No `nodir` option — we strip directories with a stat check below.
    const allMatches = fs.globSync(globs, { cwd: normalizedInput });
    const matchedFiles = allMatches.filter((file) => {
      try {
        return fs.statSync(path.resolve(normalizedInput, file)).isFile();
      } catch {
        return false;
      }
    });

    // Resolve before filtering: glob matches are relative to normalizedInput,
    // so comparing them against the config path only ever worked when the
    // config happened to sit at the workspace root.
    const globbedFlowFiles = matchedFiles
      .map((file) => path.resolve(normalizedInput, file))
      .filter((file) => !isExcludedConfig(file) && isFlowFile(file));

    // Re-globbing from disk bypasses the earlier --exclude-flows filter, so
    // re-apply it here or excluded flows sneak back in via `flows:` globs.
    return filterFlowFiles(globbedFlowFiles, excludeFlows);
  }

  return unfilteredFlowFiles.filter((file) => !isExcludedConfig(file));
}

/**
 * Resolve sequential execution order from workspace config
 * @param workspaceConfig - Workspace configuration with executionOrder
 * @param pathsByName - Map of flow names to their file paths
 * @param debug - Whether to output debug logging
 * @returns Array of flow paths in sequential execution order
 */
function resolveSequentialFlows(
  workspaceConfig: IWorkspaceConfig,
  pathsByName: Record<string, string>,
  debug: boolean,
): string[] {
  if (!workspaceConfig.executionOrder?.flowsOrder) {
    return [];
  }

  if (debug) {
    console.log('[DEBUG] executionOrder.flowsOrder:', workspaceConfig.executionOrder.flowsOrder);
    console.log('[DEBUG] Available flow names:', Object.keys(pathsByName));
  }

  // Dedupe so a flow listed twice in flowsOrder isn't run twice.
  const flowsToRunInSequence = [
    ...new Set(
      workspaceConfig.executionOrder.flowsOrder.flatMap((flowOrder) => {
        const normalizedFlowOrder = flowOrder.replace(/\.ya?ml$/i, '');
        if (debug && flowOrder !== normalizedFlowOrder) {
          console.log(`[DEBUG] Stripping trailing extension: "${flowOrder}" -> "${normalizedFlowOrder}"`);
        }

        return getFlowsToRunInSequence(pathsByName, [normalizedFlowOrder], debug);
      }),
    ),
  ];

  if (debug) {
    console.log(`[DEBUG] Sequential flows resolved: ${flowsToRunInSequence.length} flow(s)`);
  }

  if (
    workspaceConfig.executionOrder.flowsOrder.length > 0 &&
    flowsToRunInSequence.length === 0
  ) {
    console.warn(
      `Warning: executionOrder specified ${workspaceConfig.executionOrder.flowsOrder.length} flow(s) but none were found.\n` +
        `This may be intentional if flows were excluded by tags.\n\n` +
        `Expected flows: ${workspaceConfig.executionOrder.flowsOrder.join(', ')}\n` +
        `Available flow names: ${Object.keys(pathsByName).join(', ')}\n\n` +
        `Hint: Flow names come from either the 'name' field in the flow config or the filename without extension.`,
    );
  }

  return flowsToRunInSequence;
}

/**
 * Generate execution plan for test flows
 *
 * Handles:
 * - Single file or directory input
 * - Workspace configuration (config.yaml)
 * - Flow inclusion/exclusion patterns
 * - Tag-based filtering (include/exclude)
 * - Dependency resolution (runFlow, scripts, media)
 * - Sequential execution ordering
 * - DeviceCloud-specific overrides
 *
 * @param options - Plan generation options
 * @returns Complete execution plan with flows, dependencies, and metadata
 * @throws Error if input path doesn't exist, no flows found, or dependencies missing
 */
export async function plan(options: PlanOptions): Promise<IExecutionPlan> {
  const {
    input,
    includeTags = [],
    excludeTags = [],
    excludeFlows,
    configFile,
    debug = false,
  } = options;
  const normalizedInput = path.normalize(input);
  const flowMetadata: Record<string, Record<string, unknown>> = {};
  const resolvedConfigFile = configFile
    ? path.resolve(process.cwd(), configFile)
    : undefined;

  if (!fs.existsSync(normalizedInput)) {
    throw new Error(
      `Flow path does not exist: ${path.resolve(normalizedInput)}`,
    );
  }

  if (fs.lstatSync(normalizedInput).isFile()) {
    return planSingleFile(normalizedInput, resolvedConfigFile);
  }

  let unfilteredFlowFiles = await readDirectory(normalizedInput, isFlowFile);
  if (unfilteredFlowFiles.length === 0) {
    throw new Error(
      `Flow directory does not contain any Flow files: ${path.resolve(
        normalizedInput,
      )}`,
    );
  }

  unfilteredFlowFiles = filterFlowFiles(unfilteredFlowFiles, excludeFlows);

  let workspaceConfig: IWorkspaceConfig;
  if (resolvedConfigFile) {
    if (!fs.existsSync(resolvedConfigFile)) {
      throw new Error(`Config file does not exist: ${resolvedConfigFile}`);
    }

    workspaceConfig = readYamlFileAsJson(
      resolvedConfigFile,
    ) as IWorkspaceConfig;
  } else {
    workspaceConfig = getWorkspaceConfig(normalizedInput, unfilteredFlowFiles);
  }

  unfilteredFlowFiles = await applyFlowGlobs(
    workspaceConfig,
    normalizedInput,
    unfilteredFlowFiles,
    resolvedConfigFile,
    excludeFlows,
  );

  // The exclusions above are filename-based: they only catch
  // `config.yaml`/`config.yml` and the active --config target. Any other
  // workspace config sharing the folder (a second CI workflow's, say) is still
  // on the list and would be parsed as a flow, so drop config-shaped files by
  // shape — see dcd-cli#99.
  const configShapedFiles = new Set(
    unfilteredFlowFiles.filter((file) => isWorkspaceConfigFile(file)),
  );
  if (configShapedFiles.size > 0) {
    if (debug) {
      console.log(
        `[DEBUG] Skipping ${configShapedFiles.size} workspace config file(s): ${[
          ...configShapedFiles,
        ].join(', ')}`,
      );
    }

    unfilteredFlowFiles = unfilteredFlowFiles.filter(
      (file) => !configShapedFiles.has(file),
    );
  }

  if (unfilteredFlowFiles.length === 0) {
    const error = workspaceConfig.flows
      ? new Error(
          `Flow inclusion pattern(s) did not match any Flow files:\n${workspaceConfig.flows.join(
            '\n',
          )}`,
        )
      : new Error(
          `Workspace does not contain any Flows: ${path.resolve(
            normalizedInput,
          )}`,
        );
    throw error;
  }

  // eslint-disable-next-line unicorn/no-array-reduce
  const configPerFlowFile = unfilteredFlowFiles.reduce(
    (acc, filePath) => {
      const { config } = readTestYamlFileAsJson(filePath);
      acc[filePath] = config;
      return acc;
    },
    {} as Record<string, Record<string, unknown> | null>,
  );

  const allIncludeTags = [...includeTags, ...(workspaceConfig.includeTags || [])];
  const allExcludeTags = [...excludeTags, ...(workspaceConfig.excludeTags || [])];
  const flowOverrides: Record<string, Record<string, unknown>> = {};

  const allFlows = unfilteredFlowFiles.filter((filePath: string) => {
    const config = configPerFlowFile[filePath];
    const rawTags = config?.tags;
    const tags = Array.isArray(rawTags) ? rawTags : (rawTags ? [rawTags] : []);
    if (config) {
      flowMetadata[filePath] = config;
      flowOverrides[filePath] = extractDeviceCloudOverrides(config);
    }

    return (
      (allIncludeTags.length === 0 ||
        tags.some((tag) => allIncludeTags.includes(tag))) &&
      (allExcludeTags.length === 0 ||
        !tags.some((tag) => allExcludeTags.includes(tag)))
    );
  });

  if (allFlows.length === 0) {
    throw new Error(
      `Include / Exclude tags did not match any Flows:\n\nInclude Tags:\n${allIncludeTags.join(
        '\n',
      )}\n\nExclude Tags:\n${allExcludeTags.join('\n')}`,
    );
  }

  const allFiles = await Promise.all(
    allFlows.map((filePath) => checkDependencies(filePath)),
  ).then((results) => [...new Set(results.flat())]);

  // eslint-disable-next-line unicorn/no-array-reduce
  const pathsByName = allFlows.reduce((acc, filePath) => {
    const config = configPerFlowFile[filePath];
    const name = (config?.name as string) || path.parse(filePath).name;
    acc[name] = filePath;
    if (debug) {
      console.log(`[DEBUG] Flow name mapping: "${name}" -> ${filePath}`);
    }

    return acc;
  }, {} as Record<string, string>);

  const flowsToRunInSequence = resolveSequentialFlows(workspaceConfig, pathsByName, debug);
  const normalFlows = allFlows
    .filter((flow) => !flowsToRunInSequence.includes(flow))
    .sort((a, b) => a.localeCompare(b));

  return {
    allExcludeTags,
    allIncludeTags,
    flowMetadata,
    flowOverrides,
    flowsToRun: normalFlows,
    referencedFiles: [...new Set(allFiles)],
    sequence: {
      continueOnFailure: workspaceConfig.executionOrder?.continueOnFailure,
      flows: flowsToRunInSequence,
    },
    totalFlowFiles: unfilteredFlowFiles.length,
    workspaceConfig,
  };
}
