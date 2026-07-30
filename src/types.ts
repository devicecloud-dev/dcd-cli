import type { BinaryEnvelope } from './utils/envelope.js';

export type TAppMetadata = {
  appId: string;
  platform: 'android' | 'ios';
  /**
   * Present when the binary was client-side envelope-encrypted before upload
   * (dcd#1138). Stored on `binaries.metadata.enc`; the platform reads it to
   * release the DEK and decrypt. Absent = legacy plaintext upload.
   */
  enc?: BinaryEnvelope;
};
