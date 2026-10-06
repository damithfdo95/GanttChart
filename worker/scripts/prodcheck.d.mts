export const EXPECTED_WORKER_ROUTES: string[];
export const SECRET_NAMES: string[];
export const DEV_ONLY_VARS: string[];
export function parseDomains(raw: unknown): string[];
export function stripJsonComments(text: string): string;
export function parseJsonc(text: string): Record<string, any>;
export function checkProduction(
  config: Record<string, any>,
  context: { distHasIndex: boolean; docsText: string },
): { errors: string[]; notes: string[] };
