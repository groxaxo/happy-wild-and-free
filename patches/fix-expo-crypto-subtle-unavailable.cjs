/**
 * expo-crypto's ExpoCrypto.web.js calls getCrypto().subtle.digest() in
 * digestAsync() without first checking that crypto.subtle is available.
 *
 * crypto.subtle is restricted to secure contexts (HTTPS or localhost).
 * When the dev server is accessed from another machine over plain HTTP
 * (e.g., via a Tailscale IP), subtle is undefined and the call crashes:
 *   "TypeError: Cannot read properties of undefined (reading 'digest')"
 *
 * This patch adds a check and falls back to @noble/hashes pure-JS
 * implementations so the app works on HTTP non-localhost origins.
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

// Import lines to prepend (after the existing imports in the file)
const IMPORT_ADDITION = `import { sha256 as _noblesha256, sha384 as _noblesha384, sha512 as _noblesha512 } from '@noble/hashes/sha2';
import { sha1 as _noblesha1 } from '@noble/hashes/sha1';
`;

// The fallback-aware digestAsync replacement
const OLD_DIGEST_ASYNC = `    digestAsync(algorithm, data) {
        return getCrypto().subtle.digest(algorithm, data);
    },`;

const NEW_DIGEST_ASYNC = `    digestAsync(algorithm, data) {
        const subtle = getCrypto().subtle;
        if (subtle) {
            return subtle.digest(algorithm, data);
        }
        // Fallback for non-secure contexts (e.g. HTTP access from a LAN/Tailscale
        // machine) where crypto.subtle is unavailable.  Uses @noble/hashes pure-JS
        // implementations so SHA-1/256/384/512 still work without HTTPS.
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        const normalized = (name || '').toUpperCase();
        const input = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        let hashFn;
        if (normalized === 'SHA-1') hashFn = _noblesha1;
        else if (normalized === 'SHA-256') hashFn = _noblesha256;
        else if (normalized === 'SHA-384') hashFn = _noblesha384;
        else if (normalized === 'SHA-512') hashFn = _noblesha512;
        else return Promise.reject(new Error('crypto.subtle unavailable (non-secure context) and no noble fallback for: ' + normalized));
        try {
            return Promise.resolve(hashFn(input).buffer);
        } catch (e) {
            return Promise.reject(e);
        }
    },`;

const replacements = [
    {
        file: 'expo-crypto/build/ExpoCrypto.web.js',
        patches: [
            // 1. Add noble imports after the existing import block
            [
                `import { CodedError } from 'expo-modules-core';
import { CryptoEncoding } from './Crypto.types';`,
                `import { CodedError } from 'expo-modules-core';
import { CryptoEncoding } from './Crypto.types';
import { sha256 as _noblesha256, sha384 as _noblesha384, sha512 as _noblesha512 } from '@noble/hashes/sha2';
import { sha1 as _noblesha1 } from '@noble/hashes/sha1';`,
            ],
            // 2. Replace digestAsync with fallback-aware version
            [OLD_DIGEST_ASYNC, NEW_DIGEST_ASYNC],
        ],
    },
];

for (const root of nodeModulesRoots) {
    for (const { file, patches: filePatches } of replacements) {
        const filePath = path.join(root, file);
        if (!fs.existsSync(filePath)) continue;

        let content = fs.readFileSync(filePath, 'utf8');
        let modified = false;

        for (const [from, to] of filePatches) {
            // Check for `to` first: if the full replacement text is already
            // present the patch was already applied — do NOT re-apply, because
            // `from` is a prefix of `to` and a naïve `includes(from)` would be
            // true even after patching, causing duplicate insertions.
            if (content.includes(to)) {
                // Already patched – mark as modified so the file still gets
                // written if a sibling patch in the same loop made changes.
                modified = true;
            } else if (content.includes(from)) {
                content = content.replace(from, to);
                modified = true;
            } else {
                console.warn(`[fix-expo-crypto-subtle-unavailable] Could not find patch target in ${filePath}:`);
                console.warn('  Expected:', from.slice(0, 80));
            }
        }

        if (modified) {
            fs.writeFileSync(filePath, content, 'utf8');
            patched++;
            console.log(`[fix-expo-crypto-subtle-unavailable] Patched ${filePath}`);
        }
    }
}

if (patched === 0) {
    console.warn('[fix-expo-crypto-subtle-unavailable] WARNING: No files were patched — expo-crypto may not be installed yet.');
}
