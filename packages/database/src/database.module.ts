import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { schema } from "../drizzle";
import {
  DATABASE_CLIENT_PROVIDER,
  DRIZZLE_DATABASE_PROVIDER,
} from "./database.constants";
import { dbConfig } from "./db.config";

/**
 * DB wiring shared by every process. Uses Bun's native SQL driver with
 * Drizzle's bun-sql adapter. On shutdown the pool is closed so SIGTERM exits
 * cleanly.
 *
 * Not @Global on purpose: consumers (TaskModule, app roots) import it
 * explicitly, so the dependency is visible in the graph. Nest instantiates a
 * module once per class no matter how many modules import it — one pool per
 * process either way, @Global would only have hidden the coupling.
 */
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT_PROVIDER,
      // The namespace token, not ConfigService + a stringly "db" lookup: the
      // key stays tied to registerAs, so a namespace rename cannot silently
      // miss at runtime — and the factory receives the mapped, typed shape.
      inject: [dbConfig.KEY],
      useFactory: (db: ConfigType<typeof dbConfig>) =>
        new SQL({
          adapter: "postgres",
          hostname: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          max: db.maxConnections,
        }),
    },
    {
      provide: DRIZZLE_DATABASE_PROVIDER,
      inject: [DATABASE_CLIENT_PROVIDER],
      useFactory: (client: SQL) =>
        drizzle(client, { schema, casing: "snake_case" }),
    },
  ],
  exports: [DATABASE_CLIENT_PROVIDER, DRIZZLE_DATABASE_PROVIDER],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CLIENT_PROVIDER) private readonly client: SQL) {}

  async onApplicationShutdown() {
    await this.client.close();
  }
}
