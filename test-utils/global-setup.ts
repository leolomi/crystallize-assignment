import { afterAll, beforeAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import * as dotenv from "dotenv";

/**
 * Preloaded by `bun run test:integration` (see package.json). Boots a
 * throwaway docker stack (bulk-runner-test project, dynamic host port,
 * tmpfs storage), discovers the published ports, resolves .env.test against
 * them, migrates, and truncates every table between tests.
 */
const repoRoot = process.cwd();
const dockerFolder = join(repoRoot, "docker");
const dockerComposeBase = join(dockerFolder, "docker-compose.yml");
const dockerComposeTest = join(dockerFolder, "docker-compose.test.yml");
const composeFiles = ["-f", dockerComposeBase, "-f", dockerComposeTest];

const EXCLUDED_TABLES = new Set(["__drizzle_migrations"]);
let dbClient: SQL;

beforeAll(() => {
  startContainers();
  runMigrations();

  // Instantiated here because env vars are set dynamically by startContainers()
  dbClient = new SQL({
    adapter: "postgres",
    database: process.env.DB_NAME,
    hostname: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
  });
});

beforeEach(() => truncateTables());

afterAll(async () => {
  await dbClient.close();
  stopContainers();
});

function startContainers() {
  console.log("🚀 Starting integration-test containers...");

  const upResult = Bun.spawnSync(
    ["docker", "compose", ...composeFiles, "up", "-d", "--wait"],
    { stdout: "inherit", stderr: "inherit" },
  );

  if (!upResult.success) {
    console.error(
      `❌ docker compose up failed with exit code ${upResult.exitCode}`,
    );
    process.exit(1);
  }

  // Discover the host ports docker published dynamically and export them as
  // DOCKER_<SERVICE>_PORT_<internal> so .env.test can reference them.
  const dockerContainers = Bun.spawnSync(
    ["docker", "compose", ...composeFiles, "ps", "--format", "json", "--all"],
    { stdout: "pipe", stderr: "inherit" },
  );

  if (!dockerContainers.success) {
    console.error("❌ Failed to get docker containers");
    process.exit(1);
  }

  const output = dockerContainers.stdout?.toString().trim() ?? "";
  if (!output) {
    console.error("❌ No containers found from docker compose ps");
    process.exit(1);
  }

  // Each line is a JSON object for a container
  for (const line of output.split("\n").filter(Boolean)) {
    const container = JSON.parse(line) as {
      Name: string;
      Service: string;
      Publishers: Array<{ PublishedPort: number; TargetPort: number }> | null;
    };

    for (const publisher of container.Publishers ?? []) {
      if (publisher.PublishedPort > 0) {
        // Use Service name (e.g. "postgres"), not container Name
        // (e.g. "bulk-runner-test-postgres-1").
        const variable = `DOCKER_${container.Service.toUpperCase()}_PORT_${publisher.TargetPort}`;
        process.env[variable] = `${publisher.PublishedPort}`;
        console.log(`export ${variable}=${publisher.PublishedPort}`);
      }
    }
  }

  // Lives in test-utils/ (not the repo root) so `bun test` never auto-loads
  // it — the $DOCKER_* refs only make sense after the containers are up.
  const configOutput = dotenv.config({
    path: join(repoRoot, "test-utils", ".env.test"),
    override: true,
  });

  for (const [key, value] of Object.entries(configOutput.parsed ?? {})) {
    if (value.includes("$DOCKER_")) {
      process.env[key] = value.replace(
        /\$([A-Z_][A-Z0-9_]*)/g,
        (_, varName) => process.env[varName] ?? "",
      );
    }
  }

  console.log("✅ Integration-test containers started\n");
}

function stopContainers() {
  console.log("🧹 Stopping integration-test containers...");

  Bun.spawnSync(["docker", "compose", ...composeFiles, "down"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log("✅ Integration-test containers stopped\n");
}

function runMigrations() {
  console.log("🔄 Running Drizzle migrations...");
  const migrateResult = Bun.spawnSync(
    ["bun", "run", "--cwd", "packages/database", "migrate"],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit", env: process.env },
  );

  if (!migrateResult.success) {
    console.error(
      `❌ Drizzle migrations failed with exit code ${migrateResult.exitCode}`,
    );
    throw new Error("Failed to run Drizzle migrations");
  }

  console.log("✅ Migrations completed\n");
}

async function truncateTables() {
  const tables =
    await dbClient`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const tablesToTruncate = tables
    .map((t: { tablename: string }) => t.tablename)
    .filter((name: string) => !EXCLUDED_TABLES.has(name));

  if (tablesToTruncate.length > 0) {
    const tableNames = tablesToTruncate.map((t: string) => `"${t}"`).join(", ");
    await dbClient.unsafe(`TRUNCATE TABLE ${tableNames} CASCADE`);
  }
}
