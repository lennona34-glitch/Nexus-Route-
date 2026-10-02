import path from 'path';
import os from 'os';

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

export interface FileSystemSecurityPolicy {
  fullAccess: boolean; // default: false (sandboxed workspace mode)
  blockDesktop: boolean; // default: true (block direct desktop writes)
  allowedWorkspaceDir?: string;
}

let activePolicy: FileSystemSecurityPolicy = {
  fullAccess: false,
  blockDesktop: true,
};

export function setFileSystemPolicy(policy: Partial<FileSystemSecurityPolicy>): void {
  activePolicy = { ...activePolicy, ...policy };
}

export function getFileSystemPolicy(): FileSystemSecurityPolicy {
  return { ...activePolicy };
}

export function resetFileSystemPolicy(): void {
  activePolicy = {
    fullAccess: false,
    blockDesktop: true,
  };
}

/**
 * Resolves and validates that a raw target path is within the designated workspace directory.
 * In Sandboxed mode (default): models cannot write outside the designated workspace or to Desktop.
 * In Trusted Full Access mode: models can access user project paths, but Desktop remains protected unless explicitly unblocked.
 * System directories (e.g. C:\Windows) are always strictly forbidden.
 */
export function sanitizeWorkspacePath(
  rawPath: string,
  parentDir: string,
  overridePolicy?: Partial<FileSystemSecurityPolicy>
): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new SecurityError('Invalid path provided.');
  }

  const fullAccess = overridePolicy?.fullAccess ?? activePolicy.fullAccess;
  const blockDesktop = overridePolicy?.blockDesktop ?? activePolicy.blockDesktop;
  const effectiveParent = path.resolve(overridePolicy?.allowedWorkspaceDir || parentDir || activePolicy.allowedWorkspaceDir || process.cwd());
  const userProfile = process.env.USERPROFILE || os.homedir();
  const resolvedUser = path.resolve(userProfile);
  const desktopDir = path.resolve(userProfile, 'Desktop');

  const resolvedTarget = path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(effectiveParent, rawPath);

  // 1. Guard against Windows system directories
  const winDir = process.env.WINDIR || 'C:\\Windows';
  if (!path.relative(winDir, resolvedTarget).startsWith('..')) {
    throw new SecurityError(`Access denied: Writing to system directory "${rawPath}" is prohibited.`);
  }

  // 2. Guard against Desktop writes when blockDesktop is true or fullAccess is false
  const isDesktopTarget = isInsideDir(resolvedTarget, desktopDir) ||
    resolvedTarget.toLowerCase().replace(/\\/g, '/').includes('/desktop/') ||
    resolvedTarget.toLowerCase().replace(/\\/g, '/').endsWith('/desktop');

  if (isDesktopTarget && (blockDesktop || !fullAccess)) {
    throw new SecurityError(`Access denied: Writing to Desktop is prohibited. Sandboxed workspace is active (${effectiveParent}). Enable 'Full Access (Trusted Mode)' with Desktop unblocked in Studio to permit.`);
  }

  // 3. Sandboxed Mode Check: Target MUST be strictly inside effectiveParent
  const isInsideWorkspace = isInsideDir(resolvedTarget, effectiveParent) || resolvedTarget === effectiveParent;

  if (!fullAccess) {
    if (!isInsideWorkspace) {
      throw new SecurityError(`Access denied: Path "${rawPath}" resolves outside designated workspace "${effectiveParent}". Sandboxed mode is active.`);
    }
    return resolvedTarget;
  }

  // 4. Trusted Full Access Mode:
  const isInsideUserProfile = isInsideDir(resolvedTarget, resolvedUser) || resolvedTarget.startsWith(resolvedUser);
  if (!isInsideWorkspace && !isInsideUserProfile) {
    throw new SecurityError(`Access denied: Path "${rawPath}" is outside accessible boundaries.`);
  }

  return resolvedTarget;
}

