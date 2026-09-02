'use client';

/**
 * Security page (§25).
 *
 * Written to be understandable by a non-specialist while remaining literally
 * true. Every "we protect against" is paired with a "we do not protect
 * against", because a security page that only lists strengths is marketing.
 */

import { usePrefs } from '@/components/shell';
import { brand } from '@cinderlink/config/brand';

export default function SecurityPage() {
  const { locale } = usePrefs();
  const es = locale === 'es';

  const protects = es
    ? [
        'Alguien que lea la base de datos sin tener el enlace: solo encuentra texto cifrado.',
        'El operador del almacenamiento: ve ciphertext, tamaños y fechas, nunca contenido.',
        'Reutilizar el enlace después de consumirlo: la cápsula deja de estar disponible.',
        'Adivinar identificadores: son aleatorios de 128 bits.',
        'Modificar el contenido cifrado: el descifrado autenticado lo detecta y se niega a mostrarlo.',
        'Escáneres de enlaces que hacen GET: abrir la página no consume la cápsula.',
        'Dos receptores a la vez: solo una reclamación puede ganar.',
        'Filtrar nombres de archivo: viajan dentro del manifiesto cifrado.',
      ]
    : [
        'Someone reading the database without the link: they find only ciphertext.',
        'The storage operator: they see ciphertext, sizes and dates, never content.',
        'Reusing a link after it was consumed: the capsule is no longer available.',
        'Guessing identifiers: they are 128 bits of randomness.',
        'Modifying stored ciphertext: authenticated decryption detects it and refuses to display.',
        'Link scanners that issue GETs: loading the page does not consume the capsule.',
        'Two recipients at once: only one claim can win.',
        'Leaking filenames: they travel inside the encrypted manifest.',
      ];

  const doesNotProtect = es
    ? [
        'Un dispositivo comprometido, del emisor o del receptor.',
        'Extensiones del navegador maliciosas, keyloggers o malware.',
        'Un receptor que copie, fotografíe o reenvíe el contenido.',
        'Interceptar el enlace y la clave juntos por el mismo canal.',
        'Contraseñas débiles: quien tenga el enlace puede probarlas sin límite y sin conexión.',
        'JavaScript modificado en tránsito cuando la conexión no usa HTTPS.',
        'Un servidor comprometido que entregue código malicioso al navegador.',
        'Capturas de pantalla del sistema operativo.',
        'Copias o snapshots del proveedor de infraestructura que no controlamos.',
        'Análisis de tráfico: el tamaño aproximado y el momento del envío son observables.',
      ]
    : [
        'A compromised device, whether the sender’s or the recipient’s.',
        'Malicious browser extensions, keyloggers or malware.',
        'A recipient who copies, photographs or forwards the content.',
        'Intercepting the link and the key together over the same channel.',
        'Weak passwords: whoever holds the link can guess offline, without limit.',
        'JavaScript modified in transit when the connection is not HTTPS.',
        'A compromised server that serves malicious code to the browser.',
        'Operating-system screenshots.',
        'Snapshots or copies held by infrastructure providers we do not control.',
        'Traffic analysis: approximate size and timing are observable.',
      ];

  return (
    <article className="mx-auto w-full max-w-content px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{es ? 'Seguridad' : 'Security'}</h1>

      <p className="mt-3" style={{ color: 'var(--text-secondary)' }}>
        {es
          ? `${brand.name} cifra el contenido en tu navegador con XChaCha20-Poly1305 y libsodium. La clave viaja en el fragmento del enlace (después de #), que los navegadores nunca envían al servidor. El servidor almacena únicamente texto cifrado, identificadores aleatorios y las fechas necesarias para caducar la cápsula.`
          : `${brand.name} encrypts content in your browser with XChaCha20-Poly1305 and libsodium. The key travels in the link fragment (after #), which browsers never send to the server. The server stores only ciphertext, random identifiers, and the dates needed to expire the capsule.`}
      </p>

      <Section title={es ? 'Protege frente a' : 'Protects against'} items={protects} tone="safe" />
      <Section title={es ? 'No protege frente a' : 'Does not protect against'} items={doesNotProtect} tone="warn" />

      <h2 className="mt-8 text-lg font-semibold">{es ? 'Estado' : 'Status'}</h2>
      <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
        {es
          ? 'Este software no ha recibido una auditoría criptográfica externa. La implementación usa primitivas estándar de libsodium y no algoritmos propios, pero eso no sustituye a una revisión independiente.'
          : 'This software has not received an external cryptographic audit. It uses standard libsodium primitives rather than home-grown algorithms, but that is not a substitute for independent review.'}
      </p>

      <h2 className="mt-8 text-lg font-semibold">{es ? 'Reportar un fallo' : 'Report a vulnerability'}</h2>
      <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
        <code className="numeric">{brand.securityContact}</code>
        {' · '}
        <a href="/.well-known/security.txt" className="underline underline-offset-2">
          security.txt
        </a>
      </p>
    </article>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone: 'safe' | 'warn' }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2.5 rounded-md px-3 py-2.5"
            style={{
              background: tone === 'safe' ? 'var(--safe-soft)' : 'var(--warn-soft)',
              border: `1px solid ${tone === 'safe' ? 'var(--safe-border)' : 'var(--warn-border)'}`,
              fontSize: '0.9375rem',
            }}
          >
            <span aria-hidden="true" style={{ color: tone === 'safe' ? 'var(--safe)' : 'var(--warn)' }}>
              {tone === 'safe' ? '✓' : '!'}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
