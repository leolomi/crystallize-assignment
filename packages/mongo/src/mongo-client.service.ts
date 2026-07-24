import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { type Collection, type Db, type Document, MongoClient } from "mongodb";

import { mongoConfig } from "./mongo.config";

/**
 * Generic Mongo connection wiring — collection access only, no domain
 * knowledge; document shapes and queries belong to the consumers'
 * repositories.
 *
 * The driver connects lazily on first operation, so a process that never
 * touches Mongo never pays for the connection; `serverSelectionTimeoutMS`
 * keeps a down Mongo a fast failure instead of a 30s hang, and `timeoutMS`
 * bounds every operation end-to-end (CSOT) — an op whose response is lost
 * must fail (and enter the row-retry machinery) instead of hanging the
 * runner forever with its heartbeat still beating.
 */
@Injectable()
export class MongoClientService implements OnApplicationShutdown {
  private readonly client: MongoClient;
  private readonly db: Db;

  constructor(@Inject(mongoConfig.KEY) config: ConfigType<typeof mongoConfig>) {
    this.client = new MongoClient(config.url, {
      serverSelectionTimeoutMS: 5000,
      timeoutMS: config.opTimeoutMs,
    });
    this.db = this.client.db(config.dbName);
  }

  collection<TSchema extends Document = Document>(
    name: string,
  ): Collection<TSchema> {
    return this.db.collection<TSchema>(name);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
