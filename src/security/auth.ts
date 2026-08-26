import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class AdminAuthService {
  private adminKey: string;
  private secretFilePath: string;

  constructor(customKey?: string) {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    }
    this.secretFilePath = path.join(dataDir, '.admin_secret');

    if (customKey && customKey.trim()) {
      this.adminKey = customKey.trim();
    } else if (process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.trim()) {
      this.adminKey = process.env.ADMIN_API_KEY.trim();
    } else {
      // Load or generate a persistent local admin session token
      if (fs.existsSync(this.secretFilePath)) {
        try {
          this.adminKey = fs.readFileSync(this.secretFilePath, 'utf8').trim();
        } catch {
          this.adminKey = this.generateAndSaveSecret();
        }
      } else {
        this.adminKey = this.generateAndSaveSecret();
      }
    }
  }

  private generateAndSaveSecret(): string {
    const secret = `nr-admin-${crypto.randomBytes(24).toString('hex')}`;
    try {
      fs.writeFileSync(this.secretFilePath, secret, { encoding: 'utf8', mode: 0o600 });
    } catch {}
    return secret;
  }

  getAdminKey(): string {
    return this.adminKey;
  }

  validate(tokenOrHeader?: string): boolean {
    if (!tokenOrHeader) return false;

    const raw = tokenOrHeader.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return false;

    // Constant-time string comparison to prevent timing attacks
    const bufA = Buffer.from(raw);
    const bufB = Buffer.from(this.adminKey);

    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}

export const adminAuth = new AdminAuthService();
