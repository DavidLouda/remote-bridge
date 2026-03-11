import { ConnectionConfig } from '../types/connection';

export interface SshConfigExportResult {
    content: string;
    exported: number;
    skipped: number;
}

export class SshConfigExporter {
    export(connections: ConnectionConfig[]): SshConfigExportResult {
        const lines: string[] = [
            `# SSH Config — exported by Remote Bridge on ${new Date().toISOString()}`,
            '',
        ];

        let exported = 0;
        let skipped = 0;

        for (const conn of connections) {
            if (conn.protocol !== 'ssh' && conn.protocol !== 'sftp') {
                skipped++;
                continue;
            }

            const hostAlias = conn.name.replace(/\s+/g, '-').replace(/[^\w\-_.]/g, '');
            lines.push(`Host ${hostAlias}`);
            lines.push(`    HostName ${conn.host}`);
            lines.push(`    Port ${conn.port}`);
            lines.push(`    User ${conn.username}`);

            if (conn.privateKeyPath) {
                lines.push(`    IdentityFile ${conn.privateKeyPath}`);
            }

            if (conn.agent) {
                if (conn.agent.toLowerCase() === 'pageant') {
                    lines.push(`    # Agent: Pageant (Windows)`);
                } else {
                    lines.push(`    IdentityAgent ${conn.agent}`);
                }
            }

            if (conn.proxy) {
                if (conn.proxy.type === 'socks4' || conn.proxy.type === 'socks5') {
                    lines.push(`    ProxyCommand nc -x ${conn.proxy.host}:${conn.proxy.port} %h %p`);
                } else if (conn.proxy.type === 'http') {
                    lines.push(`    ProxyCommand nc -X connect -x ${conn.proxy.host}:${conn.proxy.port} %h %p`);
                }
            }

            if (conn.keepaliveInterval > 0) {
                lines.push(`    ServerAliveInterval ${conn.keepaliveInterval}`);
            }

            if (conn.remotePath && conn.remotePath !== '/') {
                lines.push(`    # DefaultPath: ${conn.remotePath}`);
            }

            lines.push('');
            exported++;
        }

        return {
            content: lines.join('\n'),
            exported,
            skipped,
        };
    }
}
