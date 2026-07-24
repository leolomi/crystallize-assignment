import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { createApp } from "./bootstrap";
import { appConfig } from "./config/app.config";

async function bootstrap() {
  const app = await createApp();
  const { port } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(port);

  new Logger("Api").log(`API listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error("API failed to start:", err);
  process.exit(1);
});
