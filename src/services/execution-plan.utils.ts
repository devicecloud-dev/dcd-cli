 
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';

const commandsThatRequireFiles = new Set(['addMedia', 'runFlow', 'runScript']);

export function getFlowsToRunInSequence(
  paths: { [key: string]: string },
  flowOrder: string[],
  debug = false,
): string[] {
  if (flowOrder.length === 0) {
    if (debug) {
      console.log('[DEBUG] getFlowsToRunInSequence: flowOrder is empty, returning []');
    }

    return [];
  }

  const availableNames = Object.keys(paths);

  if (debug) {
    console.log(`[DEBUG] getFlowsToRunInSequence: Looking for flows in order: [${flowOrder.join(', ')}]`);
    console.log(`[DEBUG] getFlowsToRunInSequence: Available flow names: [${availableNames.join(', ')}]`);
  }

  const namesInOrder = flowOrder.filter((name) =>
    Object.hasOwn(paths, name),
  );

  if (debug) {
    console.log(`[DEBUG] getFlowsToRunInSequence: Matched ${namesInOrder.length} flow(s): [${namesInOrder.join(', ')}]`);
  }

  if (namesInOrder.length === 0) {
    const notFound = flowOrder.filter((name) => !availableNames.includes(name));

    console.warn(
      `Warning: Could not find flows specified in executionOrder.flowsOrder: ${notFound.join(', ')}\n` +
      `This may be intentional if flows were excluded by tags.\n` +
      `Available flow names:\n${availableNames.join('\n')}`,
    );
    return [];
  }

  return namesInOrder.map((name) => paths[name]);
}

export function isFlowFile(filePath: string): boolean {
  // Exclude files inside .app bundles
  // Check if any directory in the path ends with .app
  const pathParts = filePath.split(path.sep);
  for (const part of pathParts) {
    if (part.endsWith('.app')) {
      return false;
    }
  }

  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

export const readYamlFileAsJson = (filePath: string) => {
  try {
    const normalizedPath = path.normalize(filePath);
    const yamlText = fs.readFileSync(normalizedPath, 'utf8');

    const result = yaml.load(yamlText);

    // Ensure includeTags and excludeTags are always arrays if present
    if (result && typeof result === 'object') {
      if ('includeTags' in result && !Array.isArray(result.includeTags)) {
        result.includeTags = result.includeTags ? [result.includeTags] : [];
      }

      if ('excludeTags' in result && !Array.isArray(result.excludeTags)) {
        result.excludeTags = result.excludeTags ? [result.excludeTags] : [];
      }
    }

    return result;
  } catch (error) {
    throw new Error(`Error parsing YAML file ${filePath}: ${error}`, {
      cause: error,
    });
  }
};

export const readTestYamlFileAsJson = (filePath: string) => {
  try {
    const normalizedPath = path.normalize(filePath);
    const yamlText = fs.readFileSync(normalizedPath, 'utf8');
    const normalizedText = yamlText
      .replaceAll('\r\n', '\n')
      .replaceAll(/\n---[\t ]*\n/g, '\n---\n');
    if (normalizedText.includes('\n---\n')) {
      const yamlTexts = normalizedText.split('\n---\n');
      const config = yaml.load(yamlTexts[0]) as Record<string, unknown>;
      // Rejoin everything after the first separator so step documents beyond
      // a second `---` aren't silently dropped.
      const testSteps = yaml.load(yamlTexts.slice(1).join('\n')) as Record<
        string,
        unknown
      >[];
      if (config && Object.keys(config).length > 0) {
        return { config, testSteps };
      }
    }

    const testSteps = yaml.load(yamlText) as Record<string, unknown>[];
    return { config: null, testSteps };
  } catch (error) {
    const message = `Error parsing YAML file ${filePath}: ${error}`;
    console.error(message);
    throw new Error(message, { cause: error });
  }
};

export async function readDirectory(
  dir: string,
  filterFunction?: (filePath: string) => boolean,
): Promise<string[]> {
  const readDirResult = await fs.promises.readdir(dir);
  const files = await Promise.all(
    readDirResult.map(async (file) => {
      const filePath = path.join(dir, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.isFile())
        if (filterFunction) {
          if (filterFunction(filePath)) return filePath;
        } else {
          return filePath;
        }
    }),
  );

  return files.flat().filter(Boolean) as string[];
}

export const checkIfFilesExistInWorkspace = (
  commandName: string,
  command: Record<string, string> | string | string[],
  absoluteFilePath: string,
) => {
  const errors: string[] = [];
  const files: string[] = [];
  const directory = path.dirname(absoluteFilePath);

  const buildError = (error: string) =>
    `Flow file "${absoluteFilePath}" has a command "${commandName}" that references a ${error} ${JSON.stringify(
      command,
    )}`;

  const processFilePath = (relativePath: string) => {
    const absoluteFilePath = path.normalize(
      path.resolve(directory, relativePath),
    );
    const error = checkFile(absoluteFilePath);
    if (error) errors.push(buildError(error));
    files.push(absoluteFilePath);
  };

  // simple command — processFilePath already resolves against `directory`
  if (typeof command === 'string') {
    processFilePath(command);
  }

  // array command
  if (Array.isArray(command)) {
    for (const file of command) {
      processFilePath(file);
    }
  }

  // object command
  const x = command as Record<string, string>; // prevent annoying ts error
  if (typeof command === 'object' && x?.file) processFilePath(x.file);

  return { errors, files };
};

const checkFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) return `non-existent file`;
};

interface IProcessDependencies {
  config?: Record<string, unknown> | null;
  input: string;
  testSteps: Record<string, unknown>[];
}

const checkStepsArray = (
  steps: Record<string, unknown>[],
  absoluteFilePath: string,
) => {
  let errors: string[] = [];
  let files: string[] = [];
  for (const command of steps) {
    if (typeof command === 'string') continue;
    for (const [commandName, commandValue] of Object.entries(command)) {
      if (commandsThatRequireFiles.has(commandName)) {
        const { errors: newErrors, files: newFiles } =
          checkIfFilesExistInWorkspace(
            commandName,
            commandValue as Record<string, string> | string | string[],
            path.normalize(absoluteFilePath),
          );
        errors = [...errors, ...newErrors];
        files = [...files, ...newFiles];
      }

      const nestedCommands =
        typeof commandValue === 'object' &&
        ((commandValue as Record<string, unknown>).commands as Record<
          string,
          unknown
        >[]);

      if (nestedCommands) {
        const { errors: newErrors, files: newFiles } = checkStepsArray(
          nestedCommands,
          absoluteFilePath,
        );
        errors = [...errors, ...newErrors];
        files = [...files, ...newFiles];
      }
    }
  }

  return { errors, files };
};

export const processDependencies = ({
  config,
  input,
  testSteps,
}: IProcessDependencies) => {
  let allErrors: string[] = [];
  let allFiles: string[] = [];

  const { onFlowComplete, onFlowStart } = config ?? {};
  const stepsArray = [testSteps];
  if (onFlowStart) stepsArray.push(onFlowStart as Record<string, unknown>[]);
  if (onFlowComplete)
    stepsArray.push(onFlowComplete as Record<string, unknown>[]);

  for (const [index, steps] of stepsArray.entries()) {
    try {
      const { errors, files } = checkStepsArray(steps, input);
      allErrors = [...allErrors, ...errors];
      allFiles = [...allFiles, ...files];
    } catch {
      const location = ['Test Steps', 'On Flow Start', 'On Flow Complete'][
        index
      ];
      throw new Error(
        `Error processing dependencies for file ${input} in the ${location} section. Expected an array of steps but received: ${JSON.stringify(
          steps,
        )}`,
      );
    }
  }

  return { allErrors, allFiles };
};
