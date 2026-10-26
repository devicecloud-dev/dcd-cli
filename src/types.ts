import type { CpuArchitecture } from './services/metadata-extractor.service.js';
import type { BinaryEnvelope } from './utils/envelope.js';

export type TAppMetadata = {
  /**
   * APK only: the native ABIs under `lib/<abi>/` (e.g. `arm64-v8a`, `x86_64`).
   * Stored on `binaries.metadata.abis`. Empty when the APK has no native code.
   */
  abis?: string[];
  appId: string;
  /**
   * APK only: the CPU families the APK can run on, `arm`, `x86` or both.
   * Stored on `binaries.metadata.architectures`. Both when it has no native code.
   */
  architectures?: CpuArchitecture[];
  platform: 'android' | 'ios';
  /**
   * Present when the binary was client-side envelope-encrypted before upload
   * (dcd#1138). Stored on `binaries.metadata.enc`; the platform reads it to
   * release the DEK and decrypt. Absent = legacy plaintext upload.
   */
  enc?: BinaryEnvelope;
  /**
   * Whether an encrypted APK ships the Flutter engine (dcd#1138). The API
   * detects this itself for plaintext binaries, so it is only sent with `enc`.
   */
  usesFlutterEngine?: boolean;
};
