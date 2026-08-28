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
 * Resolves and validates that a raw target path is within the designated parent directory or user profile.
 * If safe, returns the canonical absolute path.
 * If outside boundaries or targeting Windows system directories, throws a SecurityError.
 */
export function sanitizeWorkspacePath(rawPath: string, parentDir: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new SecurityError('Invalid path provided.');
  }

  const resolvedParent = path.resolve(parentDir);
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\adria';
  const resolvedUser = path.resolve(userProfile);

  // If path is absolute (e.g. C:\Users\adria\Desktop\modeldock\...)
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    const resolvedTarget = path.resolve(rawPath);

    // Guard against Windows system directories
    const winDir = process.env.WINDIR || 'C:\\Windows';
    if (!path.relative(winDir, resolvedTarget).startsWith('..')) {
      throw new SecurityError(`Access denied: Writing to system directory "${rawPath}" is prohibited.`);
    }

    // Check if target is inside user profile or designated workspace
    const isInsideWorkspace = isInsideDir(resolvedTarget, resolvedParent);
    const isInsideUserProfile = isInsideDir(resolvedTarget, resolvedUser);

    if (isInsideWorkspace || isInsideUserProfile || resolvedTarget.startsWith(resolvedUser)) {
      return resolvedTarget;
    }
  }

  // Otherwise resolve relative to parentDir
  const resolvedTarget = path.resolve(resolvedParent, rawPath);
  const relative = path.relative(resolvedParent, resolvedTarget);
  const relToUser = path.relative(resolvedUser, resolvedTarget);

  const isInsideParent = !relative.startsWith('..') && !path.isAbsolute(relative);
  const isInsideUser = !relToUser.startsWith('..') && !path.isAbsolute(relToUser);

  if (!isInsideParent && !isInsideUser) {
    throw new SecurityError(`Access denied: Path "${rawPath}" is outside accessible workspace boundaries.`);
  }

  return resolvedTarget;
}
