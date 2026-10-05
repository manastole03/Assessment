"""LegacyCore Member Services — a deliberately hostile stand-in for a legacy core-banking back office.

This package is the *target application*, not part of the automation system. It exists so the
system can be exercised against the surface properties the brief calls out:

* server-rendered pages inside a frameset, table-based layouts, no test IDs, cryptic field names;
* two tenants running the same vendor product with different branding, labels and versions;
* injectable runtime faults (session expiry, interstitials, native dialogs, slow/failed loads,
  unknown popups, a broken deployment) so replay error handling can be demonstrated deterministically.

All data is synthetic.
"""
