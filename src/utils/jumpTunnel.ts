import * as fs from 'fs';
import { Client, ConnectConfig } from 'ssh2';
import { JumpHostConfig } from '../types/connection';
import { readPrivateKeySync } from './privateKeyLoader';

export interface JumpSocket {
    /** The forwarded stream to use as ssh2 ConnectConfig.sock for the target connection */
    stream: NodeJS.ReadableStream & NodeJS.WritableStream;
    /** The jump host ssh2.Client — must be ended after the target connection is closed */
    jumpClient: Client;
}

/**
 * Opens an SSH connection to a jump host, then uses SSH channel forwarding
 * (ProxyJump / ProxyCommand equivalent) to obtain a direct TCP stream to the
 * target server.  The returned stream can be passed to a second ssh2.Client via
 * ConnectConfig.sock.
 *
 * @param jumpConfig   Jump host configuration.
 * @param getPassword  Async getter for the jump host password.
 * @param getPassphrase Async getter for the jump host private key passphrase.
 * @param targetHost   Target server hostname/IP.
 * @param targetPort   Target server port.
 */
export async function createJumpSocket(
    jumpConfig: JumpHostConfig,
    getPassword: () => Promise<string | undefined>,
    getPassphrase: () => Promise<string | undefined>,
    targetHost: string,
    targetPort: number
): Promise<JumpSocket> {
    const jumpClient = new Client();

    const connectConfig: ConnectConfig = {
        host: jumpConfig.host,
        port: jumpConfig.port,
        username: jumpConfig.username,
        readyTimeout: 30000,
    };

    // Configure jump host authentication
    switch (jumpConfig.authMethod) {
        case 'password': {
            const password = await getPassword();
            if (password) {
                connectConfig.password = password;
            }
            break;
        }
        case 'key': {
            if (jumpConfig.privateKeyPath) {
                const keyPath = jumpConfig.privateKeyPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
                try {
                    connectConfig.privateKey = readPrivateKeySync(keyPath);
                } catch (err) {
                    throw new Error(
                        err instanceof Error
                            ? err.message
                            : `Failed to read jump host private key: ${keyPath}`
                    );
                }
            }
            if (jumpConfig.hasPassphrase) {
                const passphrase = await getPassphrase();
                if (passphrase) {
                    connectConfig.passphrase = passphrase;
                }
            }
            break;
        }
        case 'agent':
            connectConfig.agent = jumpConfig.agent || process.env.SSH_AUTH_SOCK;
            break;
        case 'keyboard-interactive':
            // keyboard-interactive is not supported for jump hosts in headless mode
            // (no UI available during the tunnel setup). Fall through to default.
            break;
    }

    // Phase 1: Connect to jump host
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            jumpClient.destroy();
            reject(new Error('Jump host connection timed out'));
        }, 30000);

        jumpClient.once('ready', () => {
            clearTimeout(timeout);
            resolve();
        });

        jumpClient.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        jumpClient.connect(connectConfig);
    });

    // Phase 2: Open a forwarded TCP channel to the target
    const stream = await new Promise<NodeJS.ReadableStream & NodeJS.WritableStream>((resolve, reject) => {
        jumpClient.forwardOut(
            '127.0.0.1', 0,
            targetHost, targetPort,
            (err, ch) => {
                if (err) {
                    jumpClient.end();
                    reject(err);
                    return;
                }
                resolve(ch);
            }
        );
    });

    return { stream, jumpClient };
}
