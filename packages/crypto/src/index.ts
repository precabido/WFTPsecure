/**
 * @cinderlink/crypto — capsule-envelope-v1.
 *
 * Everything the browser needs to seal and open a capsule. Nothing in this
 * package performs I/O: it takes bytes and returns bytes, which keeps the
 * security-relevant surface auditable and testable in isolation.
 *
 * See docs/crypto-format.md for the wire format specification.
 */

export { getSodium, resetSodiumForTests, type Sodium } from './sodium.ts';

export {
  buildAad,
  manifestAad,
  fileChunkAad,
  rootKeyWrapAad,
  submissionAad,
  type AadParts,
  type ObjectType,
} from './aad.ts';

export {
  utf8,
  toBase64Url,
  fromBase64Url,
  randomBytes,
  randomId,
  wipe,
  concatBytes,
  timingSafeEqual,
} from './bytes.ts';

export {
  ROOT_KEY_BYTES,
  EnvelopeError,
  generateRootKey,
  deriveManifestKey,
  sealBytes,
  openBytes,
  sealManifest,
  openManifest,
  serializeManifest,
  deserializeManifest,
} from './envelope.ts';

export {
  generateFileKey,
  chunkOverheadBytes,
  createFileEncryptor,
  createFileDecryptor,
  encryptBuffer,
  decryptChunks,
  type FileEncryptor,
  type FileDecryptor,
} from './stream.ts';

export {
  DEFAULT_KDF,
  PasswordError,
  wrapRootKey,
  unwrapRootKey,
  estimatePasswordStrength,
  type KdfParams,
  type WrappedRootKey,
} from './password.ts';

export {
  capsuleFingerprint,
  formatFingerprint,
  formatDeliveryKey,
  parseDeliveryKey,
} from './fingerprint.ts';

export { FINGERPRINT_WORDS } from './wordlist.ts';

export {
  LINK_VERSION,
  LinkError,
  encodeFragment,
  decodeFragment,
  capsuleUrl,
  manageUrl,
  requestUrl,
  type CapsuleLinkSecret,
} from './link.ts';

export {
  generateRequestKeypair,
  sealSubmission,
  openSubmission,
  type RequestKeypair,
} from './sealed.ts';

export type {
  CapsuleKind,
  TemplateId,
  StructuredField,
  CodeBlock,
  FileEntry,
  ReceiverConfig,
  CapsuleManifest,
  RequestPrompt,
  SubmissionManifest,
} from './types.ts';
