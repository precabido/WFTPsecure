/**
 * robots.txt (§6).
 *
 * The preview must never be indexed: capsule URLs in a search index would be a
 * catastrophic leak, and the informational pages are not worth the risk.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });
}
