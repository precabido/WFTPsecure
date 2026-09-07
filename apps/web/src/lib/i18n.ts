/**
 * Bilingual copy (§24).
 *
 * The English is written as English, not as a transliteration of the Spanish —
 * "Share something. Decide when it disappears." rather than a literal rendering.
 *
 * Forbidden claims (§24) are absent by construction: nothing here says
 * unhackable, 100% anonymous, untraceable, military-grade, screenshot-proof,
 * guaranteed physical erasure, zero metadata, or audited. Where a limit exists,
 * the copy states it.
 */

import { brand } from '@cinderlink/config/brand';

export type Locale = 'es' | 'en';

export const copy = {
  es: {
    tagline: brand.tagline.es,
    heroTitle: 'Comparte algo. Decide cuándo desaparece.',
    heroSubtitle:
      'Envía mensajes, credenciales y archivos mediante cápsulas cifradas que caducan, se consumen o puedes revocar.',
    encryptedHere: 'El contenido se cifra en tu navegador antes de salir de este dispositivo.',
    serverStores: 'Se cifra en tu navegador. El servidor almacena únicamente datos cifrados.',

    tabs: { note: 'Nota', files: 'Archivos', combined: 'Cápsula', request: 'Solicitar' },
    templates: {
      note: 'Nota',
      credentials: 'Credenciales',
      'api-key': 'Clave API',
      'env-vars': 'Variables .env',
      code: 'Código',
      json: 'JSON',
      files: 'Archivos',
      voice: 'Nota de voz',
      request: 'Solicitud segura',
    },

    ctaCreate: 'Crear enlace seguro',
    ctaCustomise: 'Personalizar',
    dropzone: 'Arrastra archivos aquí o selecciónalos',
    dropzoneButton: 'Seleccionar archivos',
    notePlaceholder: 'Escribe el mensaje, la contraseña o el secreto que quieres compartir…',

    duration: 'Duración',
    openings: 'Aperturas',
    policySummary: 'Resumen de la política',
    onceOnly: 'Una sola apertura',
    timesN: (n: number) => `Hasta ${n} aperturas`,
    expiresIn: 'Caduca en',
    passwordOptional: 'Contraseña (opcional)',
    passwordHint: 'Usa una frase larga. Nunca se envía al servidor.',
    generatePassword: 'Generar',
    splitDelivery: 'Enviar enlace y clave por separado',
    splitExplain:
      'Envía cada parte por un canal distinto: por ejemplo el enlace por correo y la clave por mensaje.',

    sealed: 'Cápsula sellada',
    recipientLink: 'Enlace para el destinatario',
    separateKey: 'Clave (envíala aparte)',
    manageLink: 'Enlace privado de gestión',
    manageWarning: 'Guarda el enlace de gestión. No podremos recuperarlo.',
    copy: 'Copiar',
    copied: 'Copiado',
    share: 'Compartir',
    fingerprint: 'Huella de la cápsula',
    fingerprintHelp: 'Compárala por otro canal para confirmar que es la misma cápsula.',
    createAnother: 'Crear otra cápsula',

    waiting: 'Hay una cápsula esperándote',
    oneTimeWarning: 'Esta cápsula solo puede reclamarse una vez. Ábrela cuando estés preparado.',
    openAndConsume: 'Abrir y consumir',
    enterPassword: 'Introduce la contraseña',
    enterKey: 'Introduce la clave que recibiste aparte',
    unlockAt: 'Se desbloquea el',
    remaining: 'Tiempo restante',
    items: 'elementos',

    hide: 'Ocultar',
    reveal: 'Mostrar',
    destroyNow: 'Destruir ahora',
    download: 'Descargar',
    decrypting: 'Descifrando',
    encrypting: 'Cifrando',
    uploading: 'Subiendo',

    unavailable: 'Esta cápsula ya no está disponible.',
    states: {
      expired: 'Ha caducado.',
      consumed: 'Ya fue consumida.',
      revoked: 'Fue revocada por quien la creó.',
      'not-found': 'No existe o ya no está disponible.',
      destroyed: 'Fue destruida.',
      locked: 'Todavía no se puede abrir.',
      corrupt: 'No se pudo verificar su integridad.',
    },

    manageTitle: 'Controla la cápsula sin ver su contenido.',
    revoke: 'Revocar ahora',
    shorten: 'Acortar caducidad',
    history: 'Historial',
    events: {
      created: 'Creada',
      claimed: 'Reclamada',
      retrieved: 'Descargada',
      revoked: 'Revocada',
      expired: 'Caducada',
      destroyed: 'Destruida',
    },

    requestTitle: '¿Qué necesitas recibir?',
    requestInstructions: 'Instrucciones para quien envía',
    requestCreate: 'Crear solicitud segura',
    requestDeliver: 'Enviar de forma segura',
    requestDelivered: 'Entrega recibida y cifrada. Solo quien la solicitó puede abrirla.',
    submissions: 'Entregas',
    closeRequest: 'Cerrar solicitud',

    previewWarning:
      'Vista previa pública por HTTP. Utiliza únicamente datos de prueba. El despliegue de producción requerirá HTTPS.',

    nav: { how: 'Cómo funciona', security: 'Seguridad', privacy: 'Privacidad' },
    theme: { light: 'Claro', dark: 'Oscuro', system: 'Sistema' },
    wrongPassword: 'Contraseña incorrecta.',
    wrongKey: 'La clave no es válida para esta cápsula.',
    tampered: 'No se pudo verificar el contenido. No se mostrará.',
  },

  en: {
    tagline: brand.tagline.en,
    heroTitle: 'Share something. Decide when it disappears.',
    heroSubtitle:
      'Send messages, credentials and files as encrypted capsules that expire, burn on read, or can be revoked.',
    encryptedHere: 'Content is encrypted in your browser before it leaves this device.',
    serverStores: 'Encrypted in your browser. The server only ever stores ciphertext.',

    tabs: { note: 'Note', files: 'Files', combined: 'Capsule', request: 'Request' },
    templates: {
      note: 'Note',
      credentials: 'Credentials',
      'api-key': 'API key',
      'env-vars': '.env variables',
      code: 'Code',
      json: 'JSON',
      files: 'Files',
      voice: 'Voice note',
      request: 'Secure request',
    },

    ctaCreate: 'Create secure link',
    ctaCustomise: 'Customise',
    dropzone: 'Drop files here, or choose them',
    dropzoneButton: 'Choose files',
    notePlaceholder: 'Write the message, password or secret you want to share…',

    duration: 'Duration',
    openings: 'Openings',
    policySummary: 'Policy summary',
    onceOnly: 'One opening only',
    timesN: (n: number) => `Up to ${n} openings`,
    expiresIn: 'Expires in',
    passwordOptional: 'Password (optional)',
    passwordHint: 'Use a long phrase. It never reaches the server.',
    generatePassword: 'Generate',
    splitDelivery: 'Send the link and the key separately',
    splitExplain: 'Send each part a different way — the link by email, the key by message.',

    sealed: 'Capsule sealed',
    recipientLink: 'Link for the recipient',
    separateKey: 'Key (send this separately)',
    manageLink: 'Private management link',
    manageWarning: 'Save the management link. We cannot recover it for you.',
    copy: 'Copy',
    copied: 'Copied',
    share: 'Share',
    fingerprint: 'Capsule fingerprint',
    fingerprintHelp: 'Compare it over another channel to confirm you have the same capsule.',
    createAnother: 'Create another capsule',

    waiting: 'A capsule is waiting for you',
    oneTimeWarning: 'This capsule can only be claimed once. Open it when you are ready.',
    openAndConsume: 'Open and consume',
    enterPassword: 'Enter the password',
    enterKey: 'Enter the key you were sent separately',
    unlockAt: 'Unlocks on',
    remaining: 'Time remaining',
    items: 'items',

    hide: 'Hide',
    reveal: 'Reveal',
    destroyNow: 'Destroy now',
    download: 'Download',
    decrypting: 'Decrypting',
    encrypting: 'Encrypting',
    uploading: 'Uploading',

    unavailable: 'This capsule is no longer available.',
    states: {
      expired: 'It expired.',
      consumed: 'It has already been opened.',
      revoked: 'The sender revoked it.',
      'not-found': 'It does not exist, or is no longer available.',
      destroyed: 'It was destroyed.',
      locked: 'It cannot be opened yet.',
      corrupt: 'Its integrity could not be verified.',
    },

    manageTitle: 'Control the capsule without seeing what is inside.',
    revoke: 'Revoke now',
    shorten: 'Shorten expiry',
    history: 'History',
    events: {
      created: 'Created',
      claimed: 'Claimed',
      retrieved: 'Downloaded',
      revoked: 'Revoked',
      expired: 'Expired',
      destroyed: 'Destroyed',
    },

    requestTitle: 'What do you need to receive?',
    requestInstructions: 'Instructions for the sender',
    requestCreate: 'Create secure request',
    requestDeliver: 'Send securely',
    requestDelivered: 'Delivered and encrypted. Only the person who asked can open it.',
    submissions: 'Deliveries',
    closeRequest: 'Close request',

    previewWarning:
      'Public preview over HTTP. Use test data only. A production deployment will require HTTPS.',

    nav: { how: 'How it works', security: 'Security', privacy: 'Privacy' },
    theme: { light: 'Light', dark: 'Dark', system: 'System' },
    wrongPassword: 'Incorrect password.',
    wrongKey: 'That key is not valid for this capsule.',
    tampered: 'The content could not be verified, so it will not be shown.',
  },
} as const;

export type Copy = (typeof copy)['es'];

export function t(locale: Locale): Copy {
  return copy[locale] as Copy;
}

/** Human duration, e.g. "2 h 15 min" / "2h 15m". */
export function formatDuration(ms: number, locale: Locale): string {
  if (ms <= 0) return locale === 'es' ? 'caducada' : 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const unit = locale === 'es' ? { d: 'd', h: 'h', m: 'min', s: 's' } : { d: 'd', h: 'h', m: 'm', s: 's' };

  // Show at most two units, and omit a trailing zero one: a preset of exactly
  // one hour should read "1 h", not "1h 0min".
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${unit.d}`);
    if (hours > 0) parts.push(`${hours} ${unit.h}`);
  } else if (hours > 0) {
    parts.push(`${hours} ${unit.h}`);
    if (minutes > 0) parts.push(`${minutes} ${unit.m}`);
  } else if (minutes > 0) {
    parts.push(`${minutes} ${unit.m}`);
    if (seconds > 0) parts.push(`${seconds} ${unit.s}`);
  } else {
    parts.push(`${seconds} ${unit.s}`);
  }
  return parts.join(' ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
