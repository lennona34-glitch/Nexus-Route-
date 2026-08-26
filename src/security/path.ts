import path from 'path';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Checks whether a child path is strictly inside the specified parent directory.
 * Uses canonical path resolution and relative path segments to prevent directory traversal.
 */
export function isInsideDir(childPath: string, parentDir: string): boolean {
  if (!childPath || !parentDir) return false;

  const resolvedParent = path.resolve(parentDir);
  const resolvedChild = path.resolve(resolvedParent, childPath);

  const relative = path.relative(resolvedParent, resolvedChild);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolves and validates that a raw target path is within the designated parent directory.
 * If safe, returns the canonical absolute path.
 * If outside boundaries, throws a SecurityError.
 */
export function sanitizeWorkspacePath(rawPath: string, parentDir: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new SecurityError('Invalid path provided.');
  }

  const resolvedParent = path.resolve(parentDir);
  const resolvedTarget = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(resolvedParent, rawPath);

  const relative = path.relative(resolvedParent, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError(`Access denied: Path "${rawPath}" is outside workspace boundary.`);
  }

  return resolvedTarget;
}
