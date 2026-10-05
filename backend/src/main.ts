import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { configureApp } from './app.setup.js';
import { type AppConfig, appConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  // Imported here so a configuration error (thrown while the module graph loads) is reported cleanly.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(appConfig.KEY);
  configureApp(app, config);
  await app.listen(config.http.port, config.http.host);
  logger.log(
    `rote control plane on http://${config.http.host}:${config.http.port} (API /api/v1, docs ${config.features.swaggerEnabled ? '/api/docs' : 'off'}, env ${config.env})`,
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `\nrote control plane failed to start:\n${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exit(1);
});
