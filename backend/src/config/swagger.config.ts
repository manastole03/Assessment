import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ACCESS_TOKEN_COOKIE, API_KEY_HEADER } from '../common/constants/http.js';
import { API_VERSION } from '../modules/platform/platform.service.js';

const DESCRIPTION = `
The control plane for **rote**: identity, roles, approvals, runs, human handoffs and audit, in front of the
rote engine (deterministic replay of recorded computer-use capabilities).

**Envelope.** Every JSON response is \`{ success, data, message }\`; collections add \`meta\`
(\`page\`, \`limit\`, \`total\`, \`totalPages\`); errors are \`{ success: false, message, error: { code, details },
timestamp, path, requestId }\`. Branch on \`error.code\`, never on \`message\`.

**Authentication.** Browsers use the httpOnly session cookie from \`POST /auth/login\` and send the \`rote_csrf\`
cookie back as \`X-CSRF-Token\` on writes. Scripts and agents use an API key (\`POST /api-keys\`) as
\`Authorization: Bearer rote_…\` or \`X-API-Key\`. Roles rank VIEWER < OPERATOR < REVIEWER < ADMIN.

**Engine documents.** Capability artifacts, run results, events and eval results pass through unchanged and keep
the engine's snake_case keys; their schemas are in \`schemas/*.schema.json\`.
`;

export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('rote control plane')
      .setDescription(DESCRIPTION)
      .setVersion(API_VERSION)
      .addCookieAuth(
        ACCESS_TOKEN_COOKIE,
        { type: 'apiKey', in: 'cookie', name: ACCESS_TOKEN_COOKIE },
        'session',
      )
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', description: 'An access token or an API key (rote_…)' },
        'bearer',
      )
      .addApiKey({ type: 'apiKey', in: 'header', name: API_KEY_HEADER }, 'apiKey')
      .addServer('/', 'This server')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    customSiteTitle: 'rote API',
    swaggerOptions: {
      persistAuthorization: false,
      displayRequestDuration: true,
      tagsSorter: 'alpha',
    },
  });
}
