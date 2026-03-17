import * as net from 'net';
import * as http from 'http';
import { SocksClient } from 'socks';
import { ProxyConfig } from '../types/connection';

/**
 * Creates a TCP tunnel through a proxy server and returns the connected socket.
 *
 * - SOCKS4 / SOCKS5 — uses the `socks` library
 * - HTTP           — uses an HTTP CONNECT tunnel via Node's built-in `http` module
 *
 * The returned socket is already connected to the target host/port through the
 * proxy and can be passed directly to ssh2's `ConnectConfig.sock` or used as
 * basic-ftp's control socket.
 */
export async function createProxySocket(
    proxy: ProxyConfig,
    proxyPassword: string | undefined,
    targetHost: string,
    targetPort: number
): Promise<net.Socket> {
    if (proxy.type === 'socks4' || proxy.type === 'socks5') {
        return createSocksSocket(proxy, proxyPassword, targetHost, targetPort);
    }
    return createHttpConnectSocket(proxy, proxyPassword, targetHost, targetPort);
}

// ─── SOCKS4 / SOCKS5 ────────────────────────────────────────────────────────

async function createSocksSocket(
    proxy: ProxyConfig,
    proxyPassword: string | undefined,
    targetHost: string,
    targetPort: number
): Promise<net.Socket> {
    const result = await SocksClient.createConnection({
        proxy: {
            host: proxy.host,
            port: proxy.port,
            type: proxy.type === 'socks4' ? 4 : 5,
            ...(proxy.username ? { userId: proxy.username } : {}),
            ...(proxyPassword ? { password: proxyPassword } : {}),
        },
        command: 'connect',
        destination: {
            host: targetHost,
            port: targetPort,
        },
        timeout: 15000,
    });

    return result.socket;
}

// ─── HTTP CONNECT ────────────────────────────────────────────────────────────

function createHttpConnectSocket(
    proxy: ProxyConfig,
    proxyPassword: string | undefined,
    targetHost: string,
    targetPort: number
): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const authHeader =
            proxy.username && proxyPassword
                ? 'Basic ' + Buffer.from(`${proxy.username}:${proxyPassword}`).toString('base64')
                : proxy.username
                ? 'Basic ' + Buffer.from(`${proxy.username}:`).toString('base64')
                : undefined;

        const req = http.request({
            host: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            headers: {
                Host: `${targetHost}:${targetPort}`,
                ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
            },
            timeout: 15000,
        });

        req.on('connect', (_res, socket) => {
            resolve(socket as net.Socket);
        });

        req.on('error', (err: Error) => {
            req.destroy();
            reject(err);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('HTTP CONNECT proxy timed out'));
        });

        req.end();
    });
}
