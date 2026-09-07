'use client';

/** How it works, for a non-technical reader (§21). */

import { usePrefs } from '@/components/shell';
import { SealMark } from '@/components/seal-mark';

export default function HowItWorksPage() {
  const { locale } = usePrefs();
  const es = locale === 'es';

  const steps = es
    ? [
        ['Escribes o adjuntas', 'Tu navegador genera una clave aleatoria y cifra el contenido antes de enviar nada.'],
        ['Eliges la política', 'Cuánto tiempo vive y cuántas veces puede abrirse. Puedes añadir contraseña.'],
        ['Compartes el enlace', 'La clave viaja después del # y nunca llega al servidor.'],
        ['Se abre una sola vez', 'Abrir la página no consume nada. Solo al pulsar "Abrir y consumir" se reclama.'],
        ['Desaparece', 'Al consumirse o caducar, el texto cifrado se elimina del servicio.'],
      ]
    : [
        ['You write or attach', 'Your browser generates a random key and encrypts everything before sending anything.'],
        ['You choose the policy', 'How long it lives and how many times it opens. You can add a password.'],
        ['You share the link', 'The key travels after the # and never reaches the server.'],
        ['It opens once', 'Loading the page consumes nothing. Only pressing "Open and consume" claims it.'],
        ['It disappears', 'Once consumed or expired, the ciphertext is removed from the service.'],
      ];

  return (
    <article className="mx-auto w-full max-w-content px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <SealMark size={36} />
        <h1 className="text-2xl font-semibold tracking-tight">{es ? 'Cómo funciona' : 'How it works'}</h1>
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map(([title, body], index) => (
          <li key={title} className="surface flex gap-4 p-4">
            <span
              className="numeric flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span>
              <span className="block font-medium">{title}</span>
              <span className="block text-sm" style={{ color: 'var(--text-secondary)' }}>{body}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {es
          ? 'Nada de esto sustituye al cuidado habitual: si el dispositivo de quien recibe está comprometido, ninguna herramienta puede evitarlo.'
          : 'None of this replaces ordinary care: if the recipient’s device is compromised, no tool can prevent it.'}
      </p>
    </article>
  );
}
