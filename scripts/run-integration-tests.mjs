/* global Buffer, console, fetch, process, setTimeout */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";

const composeFile = "compose.integration.yml";
const envFile = "test/integration/.env.generated";
const jwtSecret = "integration-jwt-secret-at-least-32-characters";

function jwt(role) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    exp: 4_102_444_800,
    iat: 1_700_000_000,
    iss: "supabase",
    role,
  });
  const signature = crypto
    .createHmac("sha256", jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

writeFileSync(
  envFile,
  [
    `INTEGRATION_JWT_SECRET=${jwtSecret}`,
    `INTEGRATION_SERVICE_ROLE_KEY=${jwt("service_role")}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

const dockerInfo = spawnSync("docker", ["info"], { stdio: "ignore" });
if (dockerInfo.status !== 0) {
  console.error(
    "Docker is unavailable. Ensure the daemon is running and this user can access the Docker socket.",
  );
  process.exit(1);
}

function compose(args, options = {}) {
  return spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", composeFile, ...args],
    { encoding: "utf8", stdio: "inherit", ...options },
  );
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let exitCode = 1;
try {
  compose(["down", "--volumes", "--remove-orphans"]);
  const up = compose(["up", "--build", "--detach", "--wait"]);
  if (up.status !== 0) throw new Error("Integration stack failed to start");
  await Promise.all([
    waitFor("http://127.0.0.1:55421/rest/v1/"),
    waitFor("http://127.0.0.1:55431/"),
    waitFor("http://127.0.0.1:55432/"),
    waitFor("http://127.0.0.1:55433/"),
    waitFor("http://127.0.0.1:55434/"),
  ]);
  const tests = spawnSync(
    "npx",
    ["vitest", "run", "--config", "vitest.integration.config.ts"],
    {
      env: {
        ...process.env,
        INTEGRATION_JWT_SECRET: jwtSecret,
      },
      stdio: "inherit",
    },
  );
  exitCode = tests.status ?? 1;
} catch (error) {
  console.error(error);
  compose(["logs", "--no-color"]);
} finally {
  if (process.env.INTEGRATION_KEEP_RUNNING !== "1") {
    compose(["down", "--volumes", "--remove-orphans"]);
    unlinkSync(envFile);
  }
}

process.exit(exitCode);
