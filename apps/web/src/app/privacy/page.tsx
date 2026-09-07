'use client';

/** Privacy model, in plain language (§25, §18). */

import { usePrefs } from '@/components/shell';

export default function PrivacyPage() {
  const { locale } = usePrefs();
  const es = locale === 'es';

  const sees = es
    ? [
        'Texto cifrado que no puede descifrar.',
        'Identificadores aleatorios de cápsulas y objetos.',
        'El tamaño cifrado y el número de fragmentos.',
        'Fechas de creación, caducidad y reclamación.',
        'El número de aperturas usadas y restantes.',
        'Hashes de los tokens de gestión y recuperación.',
      ]
    : [
        'Ciphertext it cannot decrypt.',
        'Random capsule and object identifiers.',
        'Encrypted size and chunk count.',
        'Creation, expiry and claim timestamps.',
        'How many openings have been used and remain.',
        'Hashes of management and retrieval tokens.',
      ];

  const doesNotSee = es
    ? [
        'El contenido, en ninguna forma.',
        'Títulos, alias del remitente ni mensajes.',
        'Nombres de archivo ni tipos MIME reales.',
        'Contraseñas de cápsula, ni siquiera su hash.',
        'La clave raíz ni las claves de archivo.',
        'La clave privada de una solicitud segura.',
        'Los temas visuales y preferencias del destinatario.',
      ]
    : [
        'The content, in any form.',
        'Titles, sender aliases or messages.',
        'Real filenames or MIME types.',
        'Capsule passwords — not even a hash of them.',
        'The root key or any file key.',
        'The private key of a secure request.',
        'Recipient themes and preferences.',
      ];

  return (
    <article className="mx-auto w-full max-w-content px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{es ? 'Privacidad' : 'Privacy'}</h1>

      <h2 className="mt-6 text-lg font-semibold">{es ? 'Qué ve el servidor' : 'What the server sees'}</h2>
      <ul className="mt-2 flex flex-col gap-1.5" style={{ color: 'var(--text-secondary)' }}>
        {sees.map((item) => (<li key={item}>· {item}</li>))}
      </ul>

      <h2 className="mt-6 text-lg font-semibold">{es ? 'Qué no ve' : 'What it does not see'}</h2>
      <ul className="mt-2 flex flex-col gap-1.5" style={{ color: 'var(--text-secondary)' }}>
        {doesNotSee.map((item) => (<li key={item}>· {item}</li>))}
      </ul>

      <h2 className="mt-6 text-lg font-semibold">
        {es ? 'Metadatos inevitables' : 'Unavoidable metadata'}
      </h2>
      <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
        {es
          ? 'Para responder a una petición, el servidor ve transitoriamente tu dirección IP a nivel de red. No la almacenamos: para limitar el abuso guardamos únicamente un identificador derivado mediante HMAC con un secreto que rota, junto a un contador. Aun así, no afirmamos "cero metadatos": el tamaño aproximado y el momento de cada petición son observables por quien controle la red.'
          : 'To answer a request, the server transiently sees your IP address at the network layer. We do not store it: for abuse control we keep only an identifier derived with HMAC under a rotating secret, plus a counter. Even so, we do not claim "zero metadata" — approximate size and timing are observable to anyone who controls the network.'}
      </p>

      <h2 className="mt-6 text-lg font-semibold">{es ? 'Retención' : 'Retention'}</h2>
      <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
        {es
          ? 'El texto cifrado se elimina cuando la cápsula caduca, se consume o se revoca. Después queda solo una marca de estado durante un tiempo limitado, para poder responder "ya no está disponible" en lugar de "no existe". Describimos esto como eliminación lógica y criptográfica del servicio junto con el borrado del ciphertext almacenado; no prometemos borrado físico irrecuperable de sectores SSD, snapshots del proveedor ni capas de almacenamiento que no controlamos.'
          : 'Ciphertext is deleted when a capsule expires, is consumed, or is revoked. A state marker remains for a limited period so we can answer "no longer available" rather than "never existed". We describe this as logical and cryptographic removal from the service plus deletion of the stored ciphertext; we do not promise irrecoverable physical erasure of SSD sectors, provider snapshots, or storage layers we do not control.'}
      </p>

      <h2 className="mt-6 text-lg font-semibold">{es ? 'Registros' : 'Logs'}</h2>
      <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
        {es
          ? 'Los registros guardan el método, la ruta con parámetros sin resolver (por ejemplo /api/v1/capsules/:capsuleId) y el código de estado. Las cabeceras de autorización, las cookies y los cuerpos de petición se redactan antes de escribirse.'
          : 'Logs record the method, the unresolved route pattern (for example /api/v1/capsules/:capsuleId) and the status code. Authorization headers, cookies and request bodies are redacted before they are written.'}
      </p>
    </article>
  );
}
