import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { compressFilesFromRelativePath } from '../methods.js';
import { DeviceMatrixConfig } from '../types/domain/device.types.js';
import {
  type BinaryEnvelope,
  encryptEnv,
  encryptFlowBuffer,
  resolveKekPublicKey,
} from '../utils/envelope.js';
import { toPortableRelativePath } from '../utils/paths.js';
import { IExecutionPlan } from './execution-plan.service.js';

export interface TestSubmissionConfig {
  androidApiLevel?: string;
  androidDevice?: string;
  androidNoSnapshot?: boolean;
  apiUrl?: string;
  appBinaryId: string;
  cliVersion: string;
  commonRoot: string;
  continueOnFailure?: boolean;
  debug?: boolean;
  deviceLocale?: string;
  deviceMatrix?: DeviceMatrixConfig[];
  disableAnimations?: boolean;
  /**
   * Encrypt the flow zip and env vars before upload (#1151/#1152), each with its
   * own per-upload DEK wrapped under the environment KEK. Requires `apiUrl` to
   * resolve the pinned KEK public key.
   */
  encrypt?: boolean;
  env?: string[];
  executionPlan: IExecutionPlan;
  flowFile: string;
  googlePlay?: boolean;
  iOSDevice?: string;
  iOSVersion?: string;
  logger?: (message: string) => void;
  maestroChromeOnboarding?: boolean;
  maestroVersion: string;
  metadata?: string[];
  name?: string;
  orientation?: string;
  raw?: unknown;
  report?: string;
  retry?: number;
  runnerType?: string;
  showCrosshairs?: boolean;
}

const mimeTypeLookupByExtension: Record<string, string> = {
  zip: 'application/zip',
};

/**
 * Service for building test submission form data
 */
export class TestSubmissionService {
  /**
   * Build the test-submission payload: the compressed flow zip plus every
   * non-`file` field, each encoded exactly as it is sent today. The same
   * `fields` feed both the new JSON `submitFlowTest` body and the legacy
   * multipart `buildFormData`, guaranteeing byte-identical field encoding
   * across both paths.
   * @param config Test submission configuration
   * @returns The flow zip buffer, its SHA-256, and the string-encoded fields
   */
  public async buildTestPayload(
    config: TestSubmissionConfig,
  ): Promise<{ buffer: Buffer; fields: Record<string, string>; sha: string }> {
    const {
      apiUrl,
      appBinaryId,
      encrypt = false,
      flowFile,
      executionPlan,
      commonRoot,
      cliVersion,
      env = [],
      metadata = [],
      googlePlay = false,
      androidApiLevel,
      androidDevice,
      androidNoSnapshot,
      iOSVersion,
      iOSDevice,
      name,
      runnerType,
      maestroVersion,
      deviceLocale,
      orientation,
      retry,
      continueOnFailure = true,
      report,
      showCrosshairs,
      maestroChromeOnboarding,
      raw,
      disableAnimations,
      deviceMatrix,
      debug = false,
      logger,
    } = config;

    const {
      allExcludeTags,
      allIncludeTags,
      flowMetadata,
      flowOverrides,
      flowsToRun: testFileNames,
      referencedFiles,
      sequence,
      workspaceConfig,
    } = executionPlan;

    const { flows: sequentialFlows = [] } = sequence ?? {};

    const envObject = this.parseKeyValuePairs(env);
    const metadataObject = this.parseKeyValuePairs(metadata);

    if (Object.keys(envObject).length > 0) {
      this.logDebug(
        debug,
        logger,
        `[DEBUG] Environment variables: ${JSON.stringify(envObject)}`,
      );
    }

    if (Object.keys(metadataObject).length > 0) {
      this.logDebug(
        debug,
        logger,
        `[DEBUG] User metadata: ${JSON.stringify(metadataObject)}`,
      );
    }

    // Log non-YAML file assets being uploaded
    if (referencedFiles.length > 0) {
      const nonYamlFiles = referencedFiles.filter(
        (file) => !file.endsWith('.yaml') && !file.endsWith('.yml'),
      );
      if (nonYamlFiles.length > 0) {
        this.logDebug(
          debug,
          logger,
          `[DEBUG] Uploading ${nonYamlFiles.length} non-YAML file asset(s):`,
        );
        for (const file of nonYamlFiles) {
          const normalizedPath = this.normalizeFilePath(file, commonRoot);
          this.logDebug(debug, logger, `[DEBUG]   - ${normalizedPath}`);
        }
      }
    }

    this.logDebug(debug, logger, `[DEBUG] Compressing files from path: ${flowFile}`);

    const plaintextZip = await compressFilesFromRelativePath(
      flowFile?.endsWith('.yaml') || flowFile?.endsWith('.yml')
        ? path.dirname(flowFile)
        : flowFile,
      [
        ...new Set([
          ...referencedFiles,
          ...testFileNames,
          ...sequentialFlows,
        ]),
      ],
      commonRoot,
    );

    this.logDebug(debug, logger, `[DEBUG] Compressed file size: ${plaintextZip.length} bytes`);

    // Client-side envelope encryption (#1151 flow zip, #1152 env vars). Each
    // gets its own per-upload DEK wrapped under the environment KEK; the flow
    // zip becomes a DCDE container and `sha` is the CIPHERTEXT hash (uploads.sha
    // stays a ciphertext hash, mirroring binaries.sha). `enc` rides `fields`
    // as a JSON string like every other field, so both the JSON submitFlowTest
    // body and the legacy multipart form carry it identically.
    let buffer = plaintextZip;
    let envObjectToSend: Record<string, unknown> = envObject;
    let flowEnc: BinaryEnvelope | undefined;
    if (encrypt) {
      if (!apiUrl) {
        throw new Error('Encryption requires apiUrl to resolve the KEK public key');
      }
      const kek = resolveKekPublicKey(apiUrl);
      if (!kek) {
        throw new Error(
          'Encryption was requested but no KEK public key is configured for this environment. ' +
            'Set DCD_BINARY_KEK_PUBLIC=<version>:<base64> or pin one in src/config/environments.ts.',
        );
      }
      const flow = encryptFlowBuffer(plaintextZip, kek);
      buffer = flow.ciphertext;
      flowEnc = flow.enc;
      this.logDebug(
        debug,
        logger,
        `[DEBUG] Encrypting flow zip before upload (KEK v${kek.version}); ciphertext ${buffer.length} bytes`,
      );
      // Only encrypt when there are env vars; an empty map has no secret to
      // protect and stays a plaintext `{}` (no `enc` marker, passes through).
      if (Object.keys(envObject).length > 0) {
        envObjectToSend = { enc: encryptEnv(envObject, kek) };
        this.logDebug(debug, logger, `[DEBUG] Encrypting ${Object.keys(envObject).length} env var(s)`);
      }
    }

    // SHA-256 of what actually gets uploaded (ciphertext when encrypted).
    const sha = createHash('sha256').update(buffer).digest('hex');
    this.logDebug(debug, logger, `[DEBUG] Flow ZIP SHA-256: ${sha}`);

    // String-encoded fields, in the same order and with the same encoding as
    // the legacy multipart FormData. Reused verbatim by both submission paths.
    const fields: Record<string, string> = {};

    fields.sha = sha;
    fields.appBinaryId = appBinaryId;
    fields.testFileNames = JSON.stringify(
      this.normalizePaths(testFileNames, commonRoot),
    );
    fields.flowMetadata = JSON.stringify(
      this.normalizePathMap(flowMetadata, commonRoot),
    );
    fields.testFileOverrides = JSON.stringify(
      this.normalizePathMap(flowOverrides, commonRoot),
    );
    fields.sequentialFlows = JSON.stringify(
      this.normalizePaths(sequentialFlows, commonRoot),
    );
    fields.env = JSON.stringify(envObjectToSend);
    // Flow-zip envelope for uploads.metadata.enc (#1151). JSON string so both
    // submission paths carry it like every other field; the API parses it.
    if (flowEnc) {
      fields.enc = JSON.stringify(flowEnc);
    }
    // Note: googlePlay is now included in configPayload below instead of as a separate field
    // to work around a FormData parsing issue in the API

    // Explicit device matrix (one upload, N cells). Only sent when present, so
    // single-device submissions stay byte-identical.
    if (deviceMatrix && deviceMatrix.length > 0) {
      fields.deviceMatrix = JSON.stringify(deviceMatrix);
    }

    // Platform used only to pick which workspace-config disableAnimations flag
    // applies. A device matrix is single-platform; its first cell decides. Fall
    // back to the scalar iOS flags for single-device submissions.
    const matrixPlatform =
      deviceMatrix && deviceMatrix.length > 0
        ? 'iOSDevice' in deviceMatrix[0]
          ? 'ios'
          : 'android'
        : undefined;
    const targetPlatform =
      matrixPlatform ?? (iOSDevice || iOSVersion ? 'ios' : 'android');
    const configYamlDisableAnimations =
      targetPlatform === 'ios'
        ? Boolean(workspaceConfig?.platform?.ios?.disableAnimations)
        : Boolean(workspaceConfig?.platform?.android?.disableAnimations);
    const effectiveDisableAnimations = disableAnimations || configYamlDisableAnimations;

    const configPayload: Record<
      string,
      | Record<string, string>
      | boolean
      | null
      | number
      | string
      | string[]
      | undefined
    > = {
      allExcludeTags,
      allIncludeTags,
      androidNoSnapshot,
      autoRetriesRemaining: retry,
      continueOnFailure,
      deviceLocale,
      googlePlay,
      maestroVersion,
      orientation,
      raw: JSON.stringify(raw),
      report,
      showCrosshairs,
      maestroChromeOnboarding,
      disableAnimations: effectiveDisableAnimations,
      version: cliVersion,
    };

    fields.config = JSON.stringify(configPayload);

    if (Object.keys(metadataObject).length > 0) {
      const metadataPayload = { userMetadata: metadataObject };
      fields.metadata = JSON.stringify(metadataPayload);
      this.logDebug(
        debug,
        logger,
        `[DEBUG] Sending metadata to API: ${JSON.stringify(metadataPayload)}`,
      );
    }

    this.setOptionalFields(fields, {
      androidApiLevel,
      androidDevice,
      iOSDevice,
      iOSVersion,
      name,
      runnerType,
    });

    if (workspaceConfig) {
      fields.workspaceConfig = JSON.stringify(workspaceConfig);
    }

    return { buffer, fields, sha };
  }

  /**
   * Wraps the payload fields and flow zip into multipart FormData for the
   * legacy `POST /uploads/flow` fallback. `file` is set first to preserve the
   * exact part ordering the old code produced.
   * @param fields String-encoded fields from {@link buildTestPayload}
   * @param buffer The compressed flow zip
   * @returns FormData ready to be submitted to the multipart API
   */
  public buildFormData(
    fields: Record<string, string>,
    buffer: Buffer,
  ): FormData {
    const formData = new FormData();

    const blob = new Blob([buffer as Uint8Array<ArrayBuffer>], {
      type: mimeTypeLookupByExtension.zip,
    });
    formData.set('file', blob, 'flowFile.zip');

    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }

    return formData;
  }

  private logDebug(
    debug: boolean,
    logger: ((message: string) => void) | undefined,
    message: string,
  ): void {
    if (debug && logger) {
      logger(message);
    }
  }

  private normalizeFilePath(filePath: string, commonRoot: string): string {
    return toPortableRelativePath(filePath, commonRoot);
  }

  private normalizePathMap(
    map: Record<string, unknown>,
    commonRoot: string,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(map).map(([key, value]) => [
        this.normalizeFilePath(key, commonRoot),
        value,
      ]),
    );
  }

  private normalizePaths(paths: string[], commonRoot: string): string[] {
    return paths.map((p) => this.normalizeFilePath(p, commonRoot));
  }

  private parseKeyValuePairs(pairs: string[]): Record<string, string> {
    // eslint-disable-next-line unicorn/no-array-reduce
    return pairs.reduce((acc, cur) => {
      const [key, ...value] = cur.split('=');
      // handle case where value includes an equals sign
      acc[key] = value.join('=');
      return acc;
    }, {} as Record<string, string>);
  }

  private setOptionalFields(
    target: Record<string, string>,
    fields: Record<string, string | undefined>,
  ): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value) {
        target[key] = value.toString();
      }
    }
  }
}
