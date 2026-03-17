// @ts-check
/// <reference lib="dom" />

/**
 * Connection Form – Webview client-side logic.
 *
 * Communicates with the extension host via postMessage/onMessage.
 * Handles dynamic field visibility, validation, and form submission.
 */
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // ─── Default ports per protocol ─────────────────────────────
    /** @type {Record<string, number>} */
    const DEFAULT_PORTS = { ssh: 22, sftp: 22, ftp: 21, ftps: 990 };

    // ─── DOM References ─────────────────────────────────────────
    const form = /** @type {HTMLFormElement} */ (document.getElementById('connectionForm'));
    const protocolSelect = /** @type {HTMLSelectElement} */ (document.getElementById('protocol'));
    const portInput = /** @type {HTMLInputElement} */ (document.getElementById('port'));
    const authMethodSelect = /** @type {HTMLSelectElement} */ (document.getElementById('authMethod'));
    const secureCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('secure'));
    const allowSelfSignedCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('allowSelfSigned'));

    // Conditional sections
    const passwordSection = /** @type {HTMLElement} */ (document.getElementById('passwordSection'));
    const keySection = /** @type {HTMLElement} */ (document.getElementById('keySection'));
    const agentSection = /** @type {HTMLElement} */ (document.getElementById('agentSection'));
    const secureSection = /** @type {HTMLElement} */ (document.getElementById('secureSection'));
    const allowSelfSignedSection = /** @type {HTMLElement} */ (document.getElementById('allowSelfSignedSection'));

    // Buttons
    const saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('saveBtn'));
    const testBtn = /** @type {HTMLButtonElement} */ (document.getElementById('testBtn'));
    const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById('cancelBtn'));
    const browseKeyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('browseKeyBtn'));

    // Status
    const statusBanner = /** @type {HTMLElement} */ (document.getElementById('statusBanner'));

    // Localized label for the testing state
    let testingLabel = 'Testing\u2026';

    // Track whether we're editing an existing connection
    let editingId = /** @type {string | null} */ (null);
    let portManuallyChanged = false;

    // ─── Protocol Change ────────────────────────────────────────

    protocolSelect.addEventListener('change', () => {
        const protocol = protocolSelect.value;

        // Auto-update port if not manually changed
        if (!portManuallyChanged && DEFAULT_PORTS[protocol]) {
            portInput.value = String(DEFAULT_PORTS[protocol]);
        }

        // Show/hide FTP-specific fields
        const isFtp = protocol === 'ftp' || protocol === 'ftps';
        toggleVisibility(secureSection, isFtp);
        toggleVisibility(allowSelfSignedSection, isFtp);

        if (protocol === 'ftps') {
            secureCheckbox.checked = true;
        } else if (protocol === 'ftp') {
            secureCheckbox.checked = false;
        }

        // SSH-only auth methods
        const isSsh = protocol === 'ssh' || protocol === 'sftp';
        updateAuthMethodOptions(isSsh);

        updateAuthSections();
    });

    portInput.addEventListener('input', () => {
        portManuallyChanged = true;
    });

    // ─── Auth Method Change ─────────────────────────────────────

    authMethodSelect.addEventListener('change', updateAuthSections);

    function updateAuthSections() {
        const method = authMethodSelect.value;
        toggleVisibility(passwordSection, method === 'password');
        toggleVisibility(keySection, method === 'key');
        toggleVisibility(agentSection, method === 'agent');
    }

    /** @param {boolean} isSsh */
    function updateAuthMethodOptions(isSsh) {
        const options = authMethodSelect.options;
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            if (opt.value === 'key' || opt.value === 'agent' || opt.value === 'keyboard-interactive') {
                opt.disabled = !isSsh;
                if (!isSsh && opt.selected) {
                    authMethodSelect.value = 'password';
                }
            }
        }
        updateAuthSections();
    }

    // ─── Proxy toggle ────────────────────────────────────────────

    const useProxyCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('useProxy'));
    const proxyFields = /** @type {HTMLElement} */ (document.getElementById('proxyFields'));

    useProxyCheckbox.addEventListener('change', () => {
        toggleVisibility(proxyFields, useProxyCheckbox.checked);
    });

    // ─── Browse for private key ─────────────────────────────────

    browseKeyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'browseKey' });
    });

    // ─── Save ───────────────────────────────────────────────────

    saveBtn.addEventListener('click', () => {
        if (!validateForm()) {
            return;
        }

        const data = collectFormData();
        vscode.postMessage({
            type: 'save',
            data,
            editingId,
        });

        saveBtn.disabled = true;
        saveBtn.textContent = '…';
    });

    // ─── Test Connection ────────────────────────────────────────

    testBtn.addEventListener('click', () => {
        if (!validateForm()) {
            return;
        }

        const data = collectFormData();
        vscode.postMessage({
            type: 'test',
            data,
        });

        testBtn.disabled = true;
        testBtn.innerHTML = '<span class="spinner"></span>';
        testBtn.appendChild(document.createTextNode('\u00a0' + testingLabel));
        hideStatus();
    });

    // ─── Cancel ─────────────────────────────────────────────────

    cancelBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });

    // ─── Messages from extension host ───────────────────────────

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'prefill':
                prefillForm(msg.data);
                editingId = msg.data.id || null;
                break;

            case 'testResult':
                testBtn.disabled = false;
                testBtn.textContent = msg.labels?.testBtn || 'Test Connection';
                if (msg.success) {
                    showStatus('success', msg.message);
                } else {
                    showStatus('error', msg.message);
                }
                break;

            case 'saveResult':
                saveBtn.disabled = false;
                saveBtn.textContent = msg.labels?.saveBtn || 'Save';
                if (msg.success) {
                    // Panel will be closed by extension
                } else {
                    showStatus('error', msg.message);
                }
                break;

            case 'keySelected':
                /** @type {HTMLInputElement} */ (document.getElementById('privateKeyPath')).value = msg.path;
                break;

            case 'setLabels':
                applyLabels(msg.labels);
                if (msg.labels?.testingBtn) {
                    testingLabel = msg.labels.testingBtn;
                }
                break;
        }
    });

    // ─── Form data collection ───────────────────────────────────

    function collectFormData() {
        const data = {
            name: getVal('name'),
            protocol: protocolSelect.value,
            host: getVal('host'),
            port: parseInt(portInput.value, 10) || DEFAULT_PORTS[protocolSelect.value],
            username: getVal('username'),
            authMethod: authMethodSelect.value,
            remotePath: getVal('remotePath') || '/',
            keepaliveInterval: parseInt(getVal('keepaliveInterval'), 10) || 10,
            secure: secureCheckbox.checked,
            allowSelfSigned: allowSelfSignedCheckbox.checked,
            os: /** @type {HTMLSelectElement} */ (document.getElementById('os')).value,

            // Auth-specific
            password: getVal('password') || undefined,
            privateKeyPath: getVal('privateKeyPath') || undefined,
            hasPassphrase: /** @type {HTMLInputElement} */ (document.getElementById('hasPassphrase')).checked,
            passphrase: getVal('passphrase') || undefined,
            agent: getVal('agent') || undefined,

            // Proxy
            proxy: /** @type {any} */ (undefined),
        };

        if (useProxyCheckbox.checked) {
            const proxyHost = getVal('proxyHost');
            const proxyPort = parseInt(getVal('proxyPort'), 10);
            if (proxyHost && proxyPort) {
                data.proxy = {
                    type: /** @type {HTMLSelectElement} */ (document.getElementById('proxyType')).value,
                    host: proxyHost,
                    port: proxyPort,
                    username: getVal('proxyUsername') || undefined,
                    password: getVal('proxyPassword') || undefined,
                };
            }
        }

        return data;
    }

    // ─── Prefill ────────────────────────────────────────────────

    /** @param {any} data */
    function prefillForm(data) {
        if (!data) return;

        setVal('name', data.name || '');
        protocolSelect.value = data.protocol || 'ssh';
        setVal('host', data.host || '');
        portInput.value = String(data.port || DEFAULT_PORTS[data.protocol] || 22);
        setVal('username', data.username || '');
        authMethodSelect.value = data.authMethod || 'password';
        setVal('remotePath', data.remotePath || '/');
        setVal('keepaliveInterval', String(data.keepaliveInterval ?? 10));
        secureCheckbox.checked = !!data.secure;
        allowSelfSignedCheckbox.checked = !!data.allowSelfSigned;
        /** @type {HTMLSelectElement} */ (document.getElementById('os')).value = data.os || 'linux';

        setVal('privateKeyPath', data.privateKeyPath || '');
        /** @type {HTMLInputElement} */ (document.getElementById('hasPassphrase')).checked = !!data.hasPassphrase;
        setVal('agent', data.agent || '');

        if (data.proxy) {
            useProxyCheckbox.checked = true;
            toggleVisibility(proxyFields, true);
            /** @type {HTMLSelectElement} */ (document.getElementById('proxyType')).value = data.proxy.type || 'socks5';
            setVal('proxyHost', data.proxy.host || '');
            setVal('proxyPort', String(data.proxy.port || ''));
            setVal('proxyUsername', data.proxy.username || '');
        }

        portManuallyChanged = !!data.id; // Preserve port only when editing an existing connection

        // Trigger UI updates
        const isFtp = data.protocol === 'ftp' || data.protocol === 'ftps';
        toggleVisibility(secureSection, isFtp);
        toggleVisibility(allowSelfSignedSection, isFtp);
        const isSsh = data.protocol === 'ssh' || data.protocol === 'sftp';
        updateAuthMethodOptions(isSsh);
        updateAuthSections();
    }

    // ─── Validation ─────────────────────────────────────────────

    function validateForm() {
        let valid = true;
        clearErrors();

        if (!getVal('name').trim()) {
            showError('name', 'nameError');
            valid = false;
        }
        if (!getVal('host').trim()) {
            showError('host', 'hostError');
            valid = false;
        }
        const port = parseInt(portInput.value, 10);
        if (!port || port < 1 || port > 65535) {
            showError('port', 'portError');
            valid = false;
        }

        return valid;
    }

    /**
     * @param {string} inputId
     * @param {string} errorId
     */
    function showError(inputId, errorId) {
        const group = document.getElementById(inputId)?.closest('.form-group');
        if (group) {
            group.classList.add('has-error');
        }
        const errEl = document.getElementById(errorId);
        if (errEl) {
            errEl.style.display = 'block';
        }
    }

    function clearErrors() {
        document.querySelectorAll('.form-group.has-error').forEach((el) => {
            el.classList.remove('has-error');
        });
        document.querySelectorAll('.validation-error').forEach((el) => {
            /** @type {HTMLElement} */ (el).style.display = 'none';
        });
    }

    // ─── Status banner ──────────────────────────────────────────

    /**
     * @param {string} type
     * @param {string} message
     */
    function showStatus(type, message) {
        statusBanner.className = 'status-banner ' + type;
        statusBanner.textContent = message;
    }

    function hideStatus() {
        statusBanner.className = 'status-banner';
        statusBanner.textContent = '';
    }

    // ─── Labels / localization ──────────────────────────────────

    /** @param {Record<string, string>} labels */
    function applyLabels(labels) {
        if (!labels) return;
        for (const [id, text] of Object.entries(labels)) {
            const el = document.getElementById(id);
            if (el) {
                if (el.tagName === 'BUTTON') {
                    el.textContent = /** @type {string} */ (text);
                } else if (el.tagName === 'LABEL' || el.tagName === 'H1' || el.tagName === 'H2') {
                    // Keep the <span class="required">*</span> inside labels
                    const req = el.querySelector('.required');
                    el.textContent = /** @type {string} */ (text);
                    if (req) {
                        el.appendChild(req);
                    }
                } else if (el.tagName === 'OPTION') {
                    el.textContent = /** @type {string} */ (text);
                } else if (el.classList.contains('hint')) {
                    el.textContent = /** @type {string} */ (text);
                } else if (el.classList.contains('validation-error')) {
                    el.textContent = /** @type {string} */ (text);
                }
            }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────

    /** @param {string} id @returns {string} */
    function getVal(id) {
        const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
        return el ? el.value : '';
    }

    /** @param {string} id @param {string} val */
    function setVal(id, val) {
        const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
        if (el) el.value = val;
    }

    /** @param {HTMLElement} el @param {boolean} show */
    function toggleVisibility(el, show) {
        if (el) {
            el.classList.toggle('hidden', !show);
        }
    }

    // ─── Initial state ──────────────────────────────────────────
    updateAuthSections();
    toggleVisibility(secureSection, false);
    toggleVisibility(proxyFields, false);

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
})();
