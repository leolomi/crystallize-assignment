import type { INestApplication } from "@nestjs/common";

import { createApp } from "../src/bootstrap";

/**
 * Shared API app for integration tests. Listens on port 0 so the OS picks a
 * free port — a dev server on :3000 never gets in the way. Requests go through
 * fetch against the real HTTP stack (express + Nest pipes).
 */
let app: INestApplication | null = null;
let baseUrl = "";

export async function getTestApp(): Promise<INestApplication> {
  if (!app) {
    app = await createApp();
    await app.listen(0);
    // getUrl() returns e.g. http://[::1]:52341 — port chosen by the OS
    baseUrl = await app.getUrl();
  }
  return app;
}

export async function closeTestApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
    baseUrl = "";
  }
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

async function toApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
  };
}

/** POST an application/x-ndjson body — one JSON payload per line. */
// biome-ignore lint/suspicious/noExplicitAny: see ApiResponse
export async function postNdjson<T = any>(
  path: string,
  lines: unknown[],
): Promise<ApiResponse<T>> {
  return postNdjsonRaw(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
}

/** POST a raw application/x-ndjson body — for malformed-line scenarios. */
// biome-ignore lint/suspicious/noExplicitAny: see ApiResponse
export async function postNdjsonRaw<T = any>(
  path: string,
  body: string,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body,
  });
  return toApiResponse(response);
}

// biome-ignore lint/suspicious/noExplicitAny: see ApiResponse
export async function postJson<T = any>(
  path: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return toApiResponse(response);
}

// biome-ignore lint/suspicious/noExplicitAny: see ApiResponse
export async function getJson<T = any>(path: string): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`);
  return toApiResponse(response);
}
