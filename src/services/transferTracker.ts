import * as vscode from 'vscode';

/**
 * Tracks data transfer speeds (download / upload) across all connections.
 * Maintains a rolling 1-second window and fires updates every second.
 */
export class TransferTracker implements vscode.Disposable {
    private _downloadBytes = 0;
    private _uploadBytes = 0;
    private _lastDownloadSpeed = 0;
    private _lastUploadSpeed = 0;
    private _timer: ReturnType<typeof setInterval> | null = null;

    private readonly _onDidChangeSpeed = new vscode.EventEmitter<{ download: number; upload: number }>();
    readonly onDidChangeSpeed = this._onDidChangeSpeed.event;

    constructor() {
        // Every second, compute speed from accumulated bytes and reset
        this._timer = setInterval(() => {
            const dl = this._downloadBytes;
            const ul = this._uploadBytes;
            this._downloadBytes = 0;
            this._uploadBytes = 0;

            if (dl !== this._lastDownloadSpeed || ul !== this._lastUploadSpeed) {
                this._lastDownloadSpeed = dl;
                this._lastUploadSpeed = ul;
                this._onDidChangeSpeed.fire({ download: dl, upload: ul });
            }
        }, 1000);
    }

    /** Record downloaded bytes. */
    recordDownload(bytes: number): void {
        this._downloadBytes += bytes;
    }

    /** Record uploaded bytes. */
    recordUpload(bytes: number): void {
        this._uploadBytes += bytes;
    }

    dispose(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._onDidChangeSpeed.dispose();
    }
}
