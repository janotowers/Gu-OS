// Runs the Gu OS web application in THIS process's machine against a declared
// hosted target — the topology SL-7's RS-2 decision names: "the reviewed
// application code executed by the operator process against hosted staging
// persistence" (Slice Plan SL-7). It deploys nothing, and no Gu OS application
// runtime exists in staging before or after it runs.
//
// Fail closed, the `target-env` way: the four runtime Supabase variables are
// ALWAYS set from the declared target, so none can fall through to
// `apps/web/.env.local` (production). Next.js never overrides a variable that
// is already present in the environment, so these win over any .env file.
// Values are never printed.
//
// Usage:
//   npx tsx scripts/run-app-against-target.ts --env-file .env.staging.local --env staging [--port 3007]

import { spawn } from "node:child_process";
import { assertBinding, describeTarget, parseTargetArgs, resolveTarget, runtimeEnvFor } from "./lib/target-env";

function parsePort(argv: string[]): string {
  const i = argv.indexOf("--port");
  const port = i >= 0 ? argv[i + 1] : "3007";
  if (!/^\d{2,5}$/.test(port ?? "")) throw new Error(`invalid --port ${port}`);
  return port;
}

function main(): void {
  const argv = process.argv.slice(2);
  const target = resolveTarget(parseTargetArgs(argv));
  assertBinding(target);
  const port = parsePort(argv);
  const env = {
    ...process.env,
    ...runtimeEnvFor(target),
    NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
  };
  console.log(describeTarget(target));
  console.log(`web app → http://localhost:${port} (runtime Supabase variables bound to "${target.name}")`);
  console.log("Sign in yourself; this process never asks for, reads or stores a credential.\n");

  const child = spawn("npm", ["run", "dev", "--workspace", "@agents/web", "--", "--port", port], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
