import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CMD etapu `worker` z Dockerfile jako lista argumentów: `node`, flagi Node
 * i `lib/jobs/worker.ts`. Pusta lista, gdy Dockerfile nie ma etapu `worker`
 * albo CMD w formie exec.
 */
export function workerCmd(root: string = process.cwd()): string[] {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const stage = dockerfile.split(/^FROM /m).find((s) => /^\S+ AS worker\b/.test(s));
  const line = stage?.match(/^CMD (\[.*\])$/m)?.[1];
  return line ? (JSON.parse(line) as string[]) : [];
}

/**
 * Środowisko procesu jak w obrazie workera: NODE_ENV=production, bez NODE_OPTIONS
 * z Vitest. `extra` to zwykły słownik, bo `NodeJS.ProcessEnv` z typów Next wymaga NODE_ENV.
 */
export function imageEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', ...extra };
}
