'use client';

/**
 * Minimal, safe Markdown renderer (§9).
 *
 * Written by hand rather than pulling in a Markdown library plus a sanitiser,
 * for one reason: this content is authored by an untrusted sender and rendered
 * in the recipient's browser, inside our origin. A parser that emits HTML and
 * then relies on a sanitiser to take it back is a design where any sanitiser
 * bypass becomes stored XSS against every recipient.
 *
 * This renderer never produces HTML strings at all. It builds React elements
 * directly from parsed tokens, so there is no innerHTML, no dangerouslySetInner-
 * HTML, and nothing for a bypass to slip through:
 *
 *   - raw HTML in the source is rendered as literal text, never parsed;
 *   - images are NOT supported, so no remote fetch can be triggered (§9);
 *   - links are limited to http/https/mailto and carry
 *     rel="noopener noreferrer nofollow";
 *   - no iframes, embeds, scripts, styles or event handlers exist in the
 *     output element vocabulary.
 */

import type { ReactNode } from 'react';

/** Schemes allowed in links. javascript:, data: and vbscript: are excluded. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  // Reject control characters that could smuggle a scheme past the test.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  if (!SAFE_SCHEME.test(trimmed)) return null;
  return trimmed;
}

/** Inline formatting: code, bold, italic, links. Everything else is literal. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // One pass over an alternation keeps precedence explicit and avoids the
  // nested-replacement bugs that plague regex-chaining renderers.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="numeric"
          style={{
            background: 'var(--surface-inset)',
            padding: '0.1rem 0.3rem',
            borderRadius: 4,
            fontSize: '0.875em',
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch === undefined || linkMatch === null ? null : safeHref(linkMatch[2] as string);
      if (href === null) {
        // An unsafe scheme renders as plain text — never as a live link.
        nodes.push(<span key={key}>{token}</span>);
      } else {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            // §9: every external link is isolated from this document.
            rel="noopener noreferrer nofollow"
            style={{ color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' }}
          >
            {label}
          </a>,
        );
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function MarkdownView({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeLines: string[] | null = null;
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`p${key++}`} style={{ margin: '0 0 0.75rem' }}>
        {renderInline(paragraph.join(' '), `p${key}`)}
      </p>,
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul${key++}`} style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', listStyle: 'disc' }}>
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item, `li${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (const line of lines) {
    // Fenced code: contents are always literal, never re-parsed.
    if (line.trimStart().startsWith('```')) {
      if (codeLines === null) {
        flushParagraph();
        flushList();
        codeLines = [];
      } else {
        blocks.push(
          <pre
            key={`code${key++}`}
            className="numeric"
            style={{
              background: 'var(--surface-inset)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
              fontSize: '0.8125rem',
              margin: '0 0 0.75rem',
            }}
          >
            {codeLines.join('\n')}
          </pre>,
        );
        codeLines = null;
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = (heading[1] as string).length;
      const content = renderInline(heading[2] as string, `h${key}`);
      const style = { margin: '1rem 0 0.5rem', fontWeight: 600, letterSpacing: '-0.01em' } as const;
      blocks.push(
        level === 1 ? (
          <h2 key={`h${key++}`} style={{ ...style, fontSize: '1.2rem' }}>{content}</h2>
        ) : level === 2 ? (
          <h3 key={`h${key++}`} style={{ ...style, fontSize: '1.05rem' }}>{content}</h3>
        ) : (
          <h4 key={`h${key++}`} style={{ ...style, fontSize: '0.95rem' }}>{content}</h4>
        ),
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      listItems.push(bullet[1] as string);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  // An unterminated fence must still render, as literal text.
  if (codeLines !== null) {
    blocks.push(
      <pre key={`code${key++}`} className="numeric" style={{ background: 'var(--surface-inset)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', overflowX: 'auto', margin: 0 }}>
        {codeLines.join('\n')}
      </pre>,
    );
  }
  flushParagraph();
  flushList();

  return (
    <div
      className="rounded-md px-3.5 py-3"
      style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', fontSize: '0.9375rem' }}
    >
      {blocks}
    </div>
  );
}
