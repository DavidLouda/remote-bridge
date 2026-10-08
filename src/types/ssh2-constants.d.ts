/**
 * Minimal typings for ssh2's internal algorithm tables. ssh2 filters the
 * cipher and MAC lists against the running crypto library at load time, so
 * these reflect what the current extension host actually supports.
 */
declare module 'ssh2/lib/protocol/constants' {
    export const DEFAULT_KEX: readonly string[];
    export const SUPPORTED_KEX: readonly string[];
    export const DEFAULT_SERVER_HOST_KEY: readonly string[];
    export const SUPPORTED_SERVER_HOST_KEY: readonly string[];
    export const DEFAULT_CIPHER: readonly string[];
    export const SUPPORTED_CIPHER: readonly string[];
    export const DEFAULT_MAC: readonly string[];
    export const SUPPORTED_MAC: readonly string[];
}
