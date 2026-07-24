import { Module } from "@nestjs/common";

import { MongoClientService } from "./mongo-client.service";

/**
 * Mongo connection wiring. Not @Global on purpose: only the runner imports it,
 * which keeps "only the runner does the heavy external work" visible in the
 * module graph.
 */
@Module({
  providers: [MongoClientService],
  exports: [MongoClientService],
})
export class MongoModule {}
