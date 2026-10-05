/**
 * Evidence (report.html, DOM snapshots, screenshots) is engine-generated from captured screens of the
 * target app, so it is served inert: no scripts, no plugins, no forms. The policy goes on every
 * evidence response, not just HTML, because SVG and XML render as documents too; images shown in
 * an <img> are unaffected. `allow-same-origin` keeps a report's origin so its screenshots load with
 * the session cookie; without `allow-scripts` that grants nothing else.
 */
export const EVIDENCE_CSP =
  "sandbox allow-same-origin allow-popups; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'";

export function evidenceHeaders(): Record<string, string> {
  return {
    'content-security-policy': EVIDENCE_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300',
  };
}
