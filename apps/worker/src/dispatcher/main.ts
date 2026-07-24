import "reflect-metadata";
import { createHeadlessContext } from "@crystallize/shared";
import { Logger } from "@nestjs/common";

import { AppModule } from "./app.module";

async function bootstrap() {
  const ctx = await createHeadlessContext(AppModule);
  ctx.enableShutdownHooks();
  new Logger("Dispatcher").log("Dispatcher up");
}

bootstrap().catch((err) => {
  console.error("Dispatcher failed to start:", err);
  process.exit(1);
});
