/**
 * Evidence HTML (report.html) is engine-generated but shows captured screen text, so it is served
 * as an inert document: no scripts, no plugins, no forms. `allow-same-origin` keeps the page's origin
 * so its screenshots load with the session cookie; without `allow-scripts` that grants nothing else.
 */
export const EVIDENCE_HTML_CSP =
  "sandbox allow-same-origin allow-popups; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'";

export function evidenceHeaders(upstream: Response): Record<string, string> {
  const type = upstream.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300',
  };
  if (type.startsWith('text/html')) headers['content-security-policy'] = EVIDENCE_HTML_CSP;
  return headers;
}
