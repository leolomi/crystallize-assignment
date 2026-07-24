import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "pino-nestjs";

import { AppModule } from "./app.module";

/**
 * Build the API app without listening — reused by main and by the integration
 * tests. bufferLogs holds init logs until the pino logger takes over, so
 * nothing goes through Nest's default console logger.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks(); // close the pg pool on SIGTERM/SIGINT

  const docConfig = new DocumentBuilder()
    .setTitle("Bulk task runner")
    .setDescription(
      "Submit bulk jobs (NDJSON or JSON) and follow their progress.",
    )
    .setVersion("0.1.0")
    .build();
  SwaggerModule.setup(
    "docs",
    app,
    SwaggerModule.createDocument(app, docConfig),
  );

  return app;
}
