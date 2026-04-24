import * as vscode from 'vscode';
import { ConnectionConfig, ImportResult } from '../types/connection';
import { ConnectionManager } from '../services/connectionManager';

/**
 * Webview panel that lets the user pick which entries from an `ImportResult`
 * should actually be imported. Returns the filtered ImportResult on
 * confirmation, or `undefined` on cancel/close.
 *
 * Conflicts (existing connection with the same protocol/host/port/username)
 * default to UN-checked with a "duplicate" tooltip; the user can re-check
 * to import anyway.
 */
export class ImportPreviewPanel {
    public static readonly viewType = 'remoteBridge.importPreview';

    static async show(
        extensionUri: vscode.Uri,
        result: ImportResult,
        connectionManager: ConnectionManager,
        sourceLabel: string
    ): Promise<ImportResult | undefined> {
        const existing = connectionManager.getConnections();
        const dupKeys = new Set(
            existing.map((c) => `${c.protocol}|${c.host.toLowerCase()}|${c.port}|${(c.username ?? '').toLowerCase()}`)
        );

        // Build a per-row preview model the webview will render.
        type Row = {
            index: number;
            name: string;
            target: string;       // protocol://host:port
            user: string;
            folder: string;
            duplicate: boolean;
        };
        const rows: Row[] = result.imported.map((conn, index) => {
            const key = `${conn.protocol}|${conn.host.toLowerCase()}|${conn.port}|${(conn.username ?? '').toLowerCase()}`;
            return {
                index,
                name: conn.name,
                target: `${conn.protocol}://${conn.host}:${conn.port}`,
                user: conn.username ?? '',
                folder: conn.folderId ?? '',
                duplicate: dupKeys.has(key),
            };
        });

        const panel = vscode.window.createWebviewPanel(
            ImportPreviewPanel.viewType,
            vscode.l10n.t('Import preview — {0}', sourceLabel),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            }
        );

        panel.webview.html = ImportPreviewPanel._html(panel.webview, rows, sourceLabel);

        return new Promise<ImportResult | undefined>((resolve) => {
            const disposables: vscode.Disposable[] = [];
            let resolved = false;

            const settle = (value: ImportResult | undefined) => {
                if (resolved) { return; }
                resolved = true;
                for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
                panel.dispose();
                resolve(value);
            };

            disposables.push(
                panel.webview.onDidReceiveMessage((msg) => {
                    if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') {
                        return;
                    }
                    if (msg.command === 'cancel') {
                        settle(undefined);
                        return;
                    }
                    if (msg.command === 'confirm' && Array.isArray(msg.selected)) {
                        const selectedSet = new Set<number>();
                        for (const value of msg.selected) {
                            if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < result.imported.length) {
                                selectedSet.add(value);
                            }
                        }
                        const filtered = ImportPreviewPanel._filterResult(result, selectedSet);
                        settle(filtered);
                        return;
                    }
                })
            );

            disposables.push(
                panel.onDidDispose(() => settle(undefined))
            );
        });
    }

    /** Filter an ImportResult down to the selected indices, keeping per-id secrets in sync. */
    private static _filterResult(result: ImportResult, selected: Set<number>): ImportResult {
        const keptConnections: ConnectionConfig[] = [];
        const keptIds = new Set<string>();
        result.imported.forEach((conn, index) => {
            if (selected.has(index)) {
                keptConnections.push(conn);
                keptIds.add(conn.id);
            }
        });

        const filterRecord = (rec?: Map<string, string>) => {
            if (!rec) { return undefined; }
            const out = new Map<string, string>();
            for (const id of keptIds) {
                const value = rec.get(id);
                if (value !== undefined) { out.set(id, value); }
            }
            return out.size > 0 ? out : undefined;
        };

        return {
            ...result,
            imported: keptConnections,
            // Skip count gets bumped by the number of dropped rows.
            skipped: result.skipped + (result.imported.length - keptConnections.length),
            passwords: filterRecord(result.passwords),
            passphrases: filterRecord(result.passphrases),
            proxyPasswords: filterRecord(result.proxyPasswords),
        };
    }

    private static _html(webview: vscode.Webview, rows: Array<{ index: number; name: string; target: string; user: string; folder: string; duplicate: boolean }>, sourceLabel: string): string {
        const nonce = ImportPreviewPanel._nonce();
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        } as Record<string, string>)[ch]);
        const documentLanguage = escape(vscode.env.language || 'en');
        const pageTitle = vscode.l10n.t('Import preview');
        const pageHeading = vscode.l10n.t('Import preview — {0}', sourceLabel);
        const duplicateTooltip = vscode.l10n.t('A connection with the same host, port and user already exists.');
        const duplicateLabel = vscode.l10n.t('duplicate');
        const reviewMessage = vscode.l10n.t('Review the connections below, uncheck anything you don\'t want to import, then confirm.');
        const selectAllLabel = vscode.l10n.t('Select all');
        const selectNoneLabel = vscode.l10n.t('Select none');
        const invertLabel = vscode.l10n.t('Invert');
        const nameLabel = vscode.l10n.t('Name');
        const targetLabel = vscode.l10n.t('Target');
        const userLabel = vscode.l10n.t('User');
        const folderLabel = vscode.l10n.t('Folder');
        const importSelectedLabel = vscode.l10n.t('Import selected');
        const cancelLabel = vscode.l10n.t('Cancel');
        const countLabel = vscode.l10n.t('{0} of {1} selected');

        const tbody = rows.map((r) => {
            const checked = r.duplicate ? '' : 'checked';
            const dupBadge = r.duplicate
                ? `<span class="dup" title="${escape(duplicateTooltip)}">${escape(duplicateLabel)}</span>`
                : '';
            return `<tr data-index="${r.index}" class="${r.duplicate ? 'dup-row' : ''}">
                <td class="cell-check"><input type="checkbox" ${checked} data-index="${r.index}"/></td>
                <td>${escape(r.name)} ${dupBadge}</td>
                <td><code>${escape(r.target)}</code></td>
                <td>${escape(r.user)}</td>
                <td>${escape(r.folder)}</td>
            </tr>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="${documentLanguage}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escape(pageTitle)}</title>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
    h1 { font-size: 1.1rem; margin-top: 0; }
    .summary { color: var(--vscode-descriptionForeground); margin-bottom: 0.75rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
    th { font-weight: 600; background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
    code { background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 3px; }
    .cell-check { width: 32px; }
    .dup-row { opacity: 0.75; }
    .dup { color: var(--vscode-editorWarning-foreground); font-size: 0.8em; margin-left: 0.5em; }
    .actions { margin-top: 1rem; display: flex; gap: 8px; align-items: center; }
    button { padding: 4px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .count { margin-left: auto; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>${escape(pageHeading)}</h1>
<p class="summary">${escape(reviewMessage)}</p>
<div class="actions" style="margin-bottom: 0.5rem;">
    <button id="selectAll" class="secondary" type="button">${escape(selectAllLabel)}</button>
    <button id="selectNone" class="secondary" type="button">${escape(selectNoneLabel)}</button>
    <button id="invert" class="secondary" type="button">${escape(invertLabel)}</button>
</div>
<table>
<thead>
<tr>
<th></th>
<th>${escape(nameLabel)}</th>
<th>${escape(targetLabel)}</th>
<th>${escape(userLabel)}</th>
<th>${escape(folderLabel)}</th>
</tr>
</thead>
<tbody>
${tbody}
</tbody>
</table>
<div class="actions">
    <button id="confirm" type="button">${escape(importSelectedLabel)}</button>
    <button id="cancel" class="secondary" type="button">${escape(cancelLabel)}</button>
    <span class="count" id="count"></span>
</div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const checkboxes = () => Array.from(document.querySelectorAll('input[type="checkbox"][data-index]'));
    const updateCount = () => {
        const total = checkboxes().length;
        const selected = checkboxes().filter(cb => cb.checked).length;
        document.getElementById('count').textContent = ${JSON.stringify(countLabel)}
            .replace('{0}', String(selected)).replace('{1}', String(total));
    };
    document.getElementById('selectAll').addEventListener('click', () => {
        for (const cb of checkboxes()) { cb.checked = true; } updateCount();
    });
    document.getElementById('selectNone').addEventListener('click', () => {
        for (const cb of checkboxes()) { cb.checked = false; } updateCount();
    });
    document.getElementById('invert').addEventListener('click', () => {
        for (const cb of checkboxes()) { cb.checked = !cb.checked; } updateCount();
    });
    for (const cb of checkboxes()) {
        cb.addEventListener('change', updateCount);
    }
    document.getElementById('confirm').addEventListener('click', () => {
        const selected = checkboxes().filter(cb => cb.checked).map(cb => Number(cb.getAttribute('data-index')));
        vscode.postMessage({ command: 'confirm', selected });
    });
    document.getElementById('cancel').addEventListener('click', () => {
        vscode.postMessage({ command: 'cancel' });
    });
    updateCount();
</script>
</body>
</html>`;
    }

    private static _nonce(): string {
        let s = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            s += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return s;
    }
}

