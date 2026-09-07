/**
 * The encrypted manifest (§12).
 *
 * EVERYTHING in this file is plaintext the server must never see. It is
 * serialised, encrypted under a key derived from the capsule root key, and only
 * the ciphertext is uploaded. That includes things people often forget are
 * sensitive: file names, MIME types, the sender's alias, and even the chosen
 * theme (a distinctive theme choice is a linkability signal).
 */

export type CapsuleKind = 'note' | 'files' | 'combined' | 'request';

export type TemplateId =
  | 'note'
  | 'credentials'
  | 'api-key'
  | 'env-vars'
  | 'code'
  | 'json'
  | 'files'
  | 'voice'
  | 'request';

/** A labelled secret the recipient can copy field-by-field (§9). */
export interface StructuredField {
  id: string;
  label: string;
  value: string;
  /** Render masked until revealed; copy still works while masked. */
  secret: boolean;
  /** Preserve newlines exactly — required for .env blocks. */
  multiline?: boolean;
}

export interface CodeBlock {
  language: string;
  source: string;
}

/** Per-file metadata. `key` and `header` are what actually unlock the blob. */
export interface FileEntry {
  /** Object id used in storage keys and chunk AAD. */
  objectId: string;
  /** Original name — sanitised only in the browser at download time (§14). */
  name: string;
  /** Client-declared MIME. Advisory only; never used for security decisions. */
  mimeType: string;
  /** Plaintext size in bytes. */
  size: number;
  chunkCount: number;
  /** Independent random key per file (§12: no key reuse across files). */
  key: string;
  /** secretstream header (base64url), 24 bytes. */
  header: string;
}

/** Recipient-facing presentation that is private until the capsule is opened. */
export interface ReceiverConfig {
  theme: 'light' | 'dark' | 'paper' | 'terminal';
  accent: 'violet' | 'cyan' | 'amber' | 'emerald' | 'slate';
  destroyAnimation: 'fade' | 'dissolve' | 'seal';
  locale: 'en' | 'es';
  /** Auto-hide content when the tab loses focus. */
  autoHideOnBlur: boolean;
  /** Require press-and-hold to reveal secret fields. */
  holdToReveal: boolean;
  /** Seconds the content stays visible after opening; 0 = no local timer. */
  visibleSeconds: number;
  /** Allow inline preview for the safe media allowlist (§14). */
  allowPreview: boolean;
  /** Always download, never preview. */
  forceDownload: boolean;
}

export interface CapsuleManifest {
  /** Envelope version; rejected if it does not match this build's. */
  v: string;
  kind: CapsuleKind;
  template: TemplateId;
  /** Optional title shown after opening. */
  title?: string;
  /** Optional sender alias — free text, never verified, never an account. */
  senderAlias?: string;
  /** Body text; rendered as sanitised Markdown when `markdown` is true. */
  message?: string;
  markdown?: boolean;
  /** Instructions displayed above the payload. */
  instructions?: string;
  fields?: StructuredField[];
  code?: CodeBlock;
  /** Ordered file list; order is meaningful and is authenticated with the rest. */
  files?: FileEntry[];
  receiver: ReceiverConfig;
  /** Creation time as recorded by the *client*; the server has its own clock. */
  createdAt: string;
}

/** Prompt shown to the responder of a secure request; also encrypted. */
export interface RequestPrompt {
  v: string;
  title: string;
  instructions?: string;
  /** What the creator is asking for, for display only. */
  wants: 'files' | 'text' | 'both';
  receiver: ReceiverConfig;
  createdAt: string;
}

/** A responder's sealed delivery, decryptable only by the request creator. */
export interface SubmissionManifest {
  v: string;
  message?: string;
  files?: FileEntry[];
  /** Optional self-declared name of the responder. Never verified. */
  responderAlias?: string;
  createdAt: string;
}
