/*
 * Minimal ambient Node typings for the opt-in rendered-layout regression
 * (tests/inbox-list.rendered-layout.test.ts), which runs in the Vitest node
 * environment and drives a real Chrome binary over CDP. The repository
 * intentionally ships without @types/node; this declares only the small
 * built-in surface that test uses. Global script file: no imports/exports.
 */
declare module 'node:child_process' {
  export interface ChildProcess {
    kill(signal?: string | number): boolean;
  }
  export function spawn(command: string, args: string[], options: { stdio: 'ignore' }): ChildProcess;
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };