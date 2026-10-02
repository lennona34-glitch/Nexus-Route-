import net from 'net';
import tls from 'tls';
import http from 'http';
import https from 'https';

export interface ProxyConfig {
  enabled: boolean;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

class Socks5HttpsAgent extends https.Agent {
  private proxy: ProxyConfig;

  constructor(proxy: ProxyConfig) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options: any, callback: (err: Error | null, socket?: any) => void): any {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port) || 443;

    const proxySocket = net.connect({
      host: this.proxy.host,
      port: this.proxy.port,
    });

    proxySocket.setTimeout(20000, () => {
      proxySocket.destroy(new Error(`SOCKS5 proxy connection to ${this.proxy.host}:${this.proxy.port} timed out after 20s`));
    });

    proxySocket.on('error', (err) => callback(err));

    proxySocket.once('connect', () => {
      // Step 1: Greeting
      const hasAuth = !!(this.proxy.username && this.proxy.password);
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02]) // SOCKS5, 2 methods: NO AUTH (0x00) & USER/PASS (0x02)
        : Buffer.from([0x05, 0x01, 0x00]);       // SOCKS5, 1 method: NO AUTH (0x00)

      proxySocket.write(greeting);

      proxySocket.once('data', (authResp: Buffer) => {
        if (authResp[0] !== 0x05) {
          proxySocket.destroy();
          return callback(new Error('Invalid SOCKS5 version in proxy response'));
        }

        const method = authResp[1];

        const proceedToConnect = () => {
          // Step 3: Send Connection Request (CMD=0x01: Connect, RSV=0x00, ATYP=0x03: Domain)
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);

          const reqBuf = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            portBuf,
          ]);

          proxySocket.write(reqBuf);

          proxySocket.once('data', (connResp: Buffer) => {
            if (connResp[0] !== 0x05 || connResp[1] !== 0x00) {
              proxySocket.destroy();
              return callback(new Error(`SOCKS5 proxy connection failed with code: 0x${connResp[1]?.toString(16)}`));
            }

            const tlsSocket = tls.connect({
              ...options,
              socket: proxySocket,
              servername: targetHost,
            });

            tlsSocket.on('error', (err) => callback(err));
            tlsSocket.once('secureConnect', () => {
              proxySocket.setTimeout(0);
              tlsSocket.setTimeout(0);
              callback(null, tlsSocket);
            });
          });
        };

        if (method === 0x02 && hasAuth) {
          // Step 2: Username/Password Auth (RFC 1929)
          const uBuf = Buffer.from(this.proxy.username!, 'utf8');
          const pBuf = Buffer.from(this.proxy.password!, 'utf8');
          const authPayload = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf,
          ]);
          proxySocket.write(authPayload);

          proxySocket.once('data', (subResp: Buffer) => {
            if (subResp[1] !== 0x00) {
              proxySocket.destroy();
              return callback(new Error('SOCKS5 authentication failed: Invalid NordVPN Service Credentials. Please verify in Nord Account > Services > NordVPN > Manual Setup.'));
            }
            proceedToConnect();
          });
        } else if (method === 0x02 && !hasAuth) {
          proxySocket.destroy();
          return callback(new Error('NordVPN SOCKS5 server requires Service Credentials (username & password). Please enter them in settings.'));
        } else if (method === 0x00) {
          proceedToConnect();
        } else if (method === 0xff) {
          proxySocket.destroy();
          return callback(new Error('NordVPN SOCKS5 server rejected unauthenticated connection. NordVPN Service Credentials (username & password) are required.'));
        } else {
          proxySocket.destroy();
          callback(new Error(`SOCKS5 proxy rejected authentication method (0x${method.toString(16)})`));
        }
      });
    });
  }
}

class Socks5HttpAgent extends http.Agent {
  private proxy: ProxyConfig;

  constructor(proxy: ProxyConfig) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options: any, callback: (err: Error | null, socket?: any) => void): any {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port) || 80;

    const proxySocket = net.connect({
      host: this.proxy.host,
      port: this.proxy.port,
    });

    proxySocket.setTimeout(20000, () => {
      proxySocket.destroy(new Error(`SOCKS5 proxy connection to ${this.proxy.host}:${this.proxy.port} timed out after 20s`));
    });

    proxySocket.on('error', (err) => callback(err));

    proxySocket.once('connect', () => {
      const hasAuth = !!(this.proxy.username && this.proxy.password);
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);

      proxySocket.write(greeting);

      proxySocket.once('data', (authResp: Buffer) => {
        if (authResp[0] !== 0x05) {
          proxySocket.destroy();
          return callback(new Error('Invalid SOCKS5 version in proxy response'));
        }

        const method = authResp[1];

        const proceedToConnect = () => {
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);

          const reqBuf = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            portBuf,
          ]);

          proxySocket.write(reqBuf);

          proxySocket.once('data', (connResp: Buffer) => {
            if (connResp[0] !== 0x05 || connResp[1] !== 0x00) {
              proxySocket.destroy();
              return callback(new Error(`SOCKS5 proxy connection failed with code: 0x${connResp[1]?.toString(16)}`));
            }
            proxySocket.setTimeout(0);
            callback(null, proxySocket);
          });
        };

        if (method === 0x02 && hasAuth) {
          const uBuf = Buffer.from(this.proxy.username!, 'utf8');
          const pBuf = Buffer.from(this.proxy.password!, 'utf8');
          const authPayload = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf,
          ]);
          proxySocket.write(authPayload);

          proxySocket.once('data', (subResp: Buffer) => {
            if (subResp[1] !== 0x00) {
              proxySocket.destroy();
              return callback(new Error('SOCKS5 authentication failed: Invalid NordVPN Service Credentials.'));
            }
            proceedToConnect();
          });
        } else if (method === 0x02 && !hasAuth) {
          proxySocket.destroy();
          return callback(new Error('NordVPN SOCKS5 server requires Service Credentials.'));
        } else if (method === 0x00) {
          proceedToConnect();
        } else if (method === 0xff) {
          proxySocket.destroy();
          return callback(new Error('NordVPN SOCKS5 server rejected unauthenticated connection.'));
        } else {
          proxySocket.destroy();
          callback(new Error(`SOCKS5 proxy rejected authentication method (0x${method.toString(16)})`));
        }
      });
    });
  }
}

class HttpProxyHttpsAgent extends https.Agent {
  private proxy: ProxyConfig;

  constructor(proxy: ProxyConfig) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options: any, callback: (err: Error | null, socket?: any) => void): any {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port) || 443;

    const proxySocket = net.connect({
      host: this.proxy.host,
      port: this.proxy.port,
    });

    proxySocket.setTimeout(20000, () => {
      proxySocket.destroy(new Error(`HTTP proxy connection timed out after 20s`));
    });

    proxySocket.on('error', (err) => callback(err));

    proxySocket.once('connect', () => {
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (this.proxy.username && this.proxy.password) {
        const auth = Buffer.from(`${this.proxy.username}:${this.proxy.password}`).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectReq += '\r\n';
      proxySocket.write(connectReq);

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\r\n\r\n')) {
          proxySocket.removeListener('data', onData);
          const statusLine = buffer.split('\r\n')[0];
          if (statusLine.includes(' 200 ')) {
            const tlsSocket = tls.connect({
              ...options,
              socket: proxySocket,
              servername: targetHost,
            });
            tlsSocket.on('error', (err) => callback(err));
            tlsSocket.once('secureConnect', () => {
              proxySocket.setTimeout(0);
              tlsSocket.setTimeout(0);
              callback(null, tlsSocket);
            });
          } else {
            proxySocket.destroy();
            callback(new Error(`Proxy CONNECT failed: ${statusLine}`));
          }
        }
      };
      proxySocket.on('data', onData);
    });
  }
}

class HttpProxyHttpAgent extends http.Agent {
  private proxy: ProxyConfig;

  constructor(proxy: ProxyConfig) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options: any, callback: (err: Error | null, socket?: any) => void): any {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port) || 80;

    const proxySocket = net.connect({
      host: this.proxy.host,
      port: this.proxy.port,
    });

    proxySocket.setTimeout(20000, () => {
      proxySocket.destroy(new Error(`HTTP proxy connection timed out after 20s`));
    });

    proxySocket.on('error', (err) => callback(err));

    proxySocket.once('connect', () => {
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (this.proxy.username && this.proxy.password) {
        const auth = Buffer.from(`${this.proxy.username}:${this.proxy.password}`).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectReq += '\r\n';
      proxySocket.write(connectReq);

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\r\n\r\n')) {
          proxySocket.removeListener('data', onData);
          const statusLine = buffer.split('\r\n')[0];
          if (statusLine.includes(' 200 ')) {
            proxySocket.setTimeout(0);
            callback(null, proxySocket);
          } else {
            proxySocket.destroy();
            callback(new Error(`Proxy CONNECT failed: ${statusLine}`));
          }
        }
      };
      proxySocket.on('data', onData);
    });
  }
}

export function createTunnelAgent(proxy: ProxyConfig, isHttps: boolean = true): any {
  if (!proxy.enabled || !proxy.host || !proxy.port) {
    return isHttps ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  }

  if (proxy.type === 'socks5') {
    return isHttps ? new Socks5HttpsAgent(proxy) : new Socks5HttpAgent(proxy);
  } else {
    return isHttps ? new HttpProxyHttpsAgent(proxy) : new HttpProxyHttpAgent(proxy);
  }
}
