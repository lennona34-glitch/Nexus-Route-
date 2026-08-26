import { URL } from 'url';
import net from 'net';

/**
 * Validates a target URL to protect against SSRF (Server-Side Request Forgery).
 * Rejects non-HTTP(S) protocols and loopback / private IP address destinations.
 */
export function validatePublicHttpUrl(rawUrl: string): { valid: boolean; error?: string; parsedUrl?: URL } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, error: 'Malformed URL format.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Disallowed protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback hostnames
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    return { valid: false, error: 'Access to loopback / local interfaces is forbidden.' };
  }

  // Block AWS / Cloud metadata addresses
  if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    return { valid: false, error: 'Access to cloud instance metadata service is forbidden.' };
  }

  // Check IPv4 private address ranges
  if (net.isIPv4(hostname)) {
    const parts = hostname.split('.').map(Number);
    // 10.0.0.0/8
    if (parts[0] === 10) return { valid: false, error: 'Access to private RFC 1918 addresses is forbidden.' };
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return { valid: false, error: 'Access to private RFC 1918 addresses is forbidden.' };
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return { valid: false, error: 'Access to private RFC 1918 addresses is forbidden.' };
    // 127.0.0.0/8
    if (parts[0] === 127) return { valid: false, error: 'Access to loopback addresses is forbidden.' };
    // 0.0.0.0/8
    if (parts[0] === 0) return { valid: false, error: 'Access to 0.0.0.0 is forbidden.' };
  }

  return { valid: true, parsedUrl: parsed };
}
