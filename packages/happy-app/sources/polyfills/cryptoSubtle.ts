/**
 * Polyfill for `crypto.subtle` in non-secure (plain-HTTP) contexts.
 *
 * Browsers restrict the WebCrypto SubtleCrypto API to secure contexts
 * (HTTPS or localhost). When the dev server is accessed over HTTP from a
 * LAN / Tailscale machine, `crypto.subtle` is `undefined`, which crashes
 * any code that calls `crypto.subtle.digest`, `.importKey`, `.encrypt`, or
 * `.decrypt`.
 *
 * This file installs a software fallback using:
 *   - @noble/hashes  — digest (SHA-1, SHA-256, SHA-384, SHA-512)
 *   - node-forge     — AES-GCM importKey / encrypt / decrypt
 *
 * The polyfill is a DEV CONVENIENCE ONLY. It should never run in production
 * (HTTPS origins have the real SubtleCrypto).
 *
 * Web-only guard: the outer `typeof window` check means the file is
 * effectively a no-op on React Native / Tauri desktop (where the real
 * SubtleCrypto is always available anyway).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

if (typeof window !== 'undefined' && typeof globalThis.crypto !== 'undefined' && !globalThis.crypto.subtle) {
    /* ------------------------------------------------------------------ */
    /*  Lazy imports — resolved at runtime so Metro can tree-shake on      */
    /*  platforms that never reach this branch.                            */
    /* ------------------------------------------------------------------ */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sha1 } = require('@noble/hashes/sha1') as { sha1: (d: Uint8Array) => Uint8Array };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sha256, sha384, sha512 } = require('@noble/hashes/sha2') as {
        sha256: (d: Uint8Array) => Uint8Array;
        sha384: (d: Uint8Array) => Uint8Array;
        sha512: (d: Uint8Array) => Uint8Array;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge') as {
        cipher: {
            createCipher: (alg: string, key: string) => {
                start: (opts: { iv: string }) => void;
                update: (buf: { bytes: () => string }) => void;
                finish: () => boolean;
                output: { bytes: () => string };
                mode: { tag: { bytes: () => string } };
            };
            createDecipher: (alg: string, key: string) => {
                start: (opts: { iv: string; tag: { bytes: () => string } }) => void;
                update: (buf: { bytes: () => string }) => void;
                finish: () => boolean;
                output: { bytes: () => string };
            };
        };
        util: {
            createBuffer: (data: string, encoding?: string) => { bytes: () => string };
        };
    };

    /* ------------------------------------------------------------------ */
    /*  Helper: BufferSource → Uint8Array                                  */
    /* ------------------------------------------------------------------ */
    function toBytes(data: BufferSource): Uint8Array {
        if (data instanceof Uint8Array) return data;
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return new Uint8Array(data as ArrayBuffer);
    }

    /* ------------------------------------------------------------------ */
    /*  Helper: Uint8Array ↔ forge binary string (latin-1 byte-per-char)   */
    /* ------------------------------------------------------------------ */
    function toBinaryString(arr: Uint8Array): string {
        let s = '';
        for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
        return s;
    }
    function fromBinaryString(s: string): Uint8Array {
        const arr = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
        return arr;
    }

    /* ------------------------------------------------------------------ */
    /*  Internal storage for fake CryptoKey objects                        */
    /* ------------------------------------------------------------------ */
    interface FakeKey {
        _raw: Uint8Array;
        type: 'secret';
        extractable: boolean;
        algorithm: KeyAlgorithm;
        usages: KeyUsage[];
    }

    /* ------------------------------------------------------------------ */
    /*  SubtleCrypto shim                                                  */
    /* ------------------------------------------------------------------ */
    const subtle: SubtleCrypto = {
        /* -- digest ---------------------------------------------------- */
        async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
            const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
            const bytes = toBytes(data);
            let hash: Uint8Array;
            switch (name.toUpperCase()) {
                case 'SHA-1':   hash = sha1(bytes);   break;
                case 'SHA-256': hash = sha256(bytes); break;
                case 'SHA-384': hash = sha384(bytes); break;
                case 'SHA-512': hash = sha512(bytes); break;
                default: throw new DOMException(`Unsupported algorithm: ${name}`, 'NotSupportedError');
            }
            return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
        },

        /* -- importKey ------------------------------------------------- */
        async importKey(
            format: KeyFormat,
            keyData: BufferSource | JsonWebKey,
            algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm,
            extractable: boolean,
            keyUsages: KeyUsage[],
        ): Promise<CryptoKey> {
            const name = typeof algorithm === 'string' ? algorithm : (algorithm as { name: string }).name;
            if (name !== 'AES-GCM') throw new DOMException(`polyfill: unsupported algorithm ${name}`, 'NotSupportedError');
            if (format !== 'raw') throw new DOMException(`polyfill: unsupported key format ${format}`, 'NotSupportedError');
            const raw = toBytes(keyData as BufferSource);
            const fakeKey: FakeKey = {
                _raw: raw,
                type: 'secret',
                extractable,
                algorithm: { name },
                usages: keyUsages,
            };
            return fakeKey as unknown as CryptoKey;
        },

        /* -- encrypt --------------------------------------------------- */
        async encrypt(
            algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams,
            key: CryptoKey,
            data: BufferSource,
        ): Promise<ArrayBuffer> {
            const alg = algorithm as AesGcmParams;
            if (alg.name !== 'AES-GCM') throw new DOMException(`polyfill: unsupported algorithm ${alg.name}`, 'NotSupportedError');
            const fakeKey = key as unknown as FakeKey;
            const keyStr = toBinaryString(fakeKey._raw);
            const ivStr  = toBinaryString(toBytes(alg.iv as BufferSource));
            const plain  = toBinaryString(toBytes(data));

            const cipher = forge.cipher.createCipher('AES-GCM', keyStr);
            cipher.start({ iv: ivStr });
            cipher.update(forge.util.createBuffer(plain, 'binary'));
            cipher.finish();

            const ct  = fromBinaryString(cipher.output.bytes());  // ciphertext
            const tag = fromBinaryString(cipher.mode.tag.bytes()); // 16-byte auth tag

            // crypto.subtle.encrypt returns ciphertext || tag
            const out = new Uint8Array(ct.length + tag.length);
            out.set(ct, 0);
            out.set(tag, ct.length);
            return out.buffer as ArrayBuffer;
        },

        /* -- decrypt --------------------------------------------------- */
        async decrypt(
            algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams,
            key: CryptoKey,
            data: BufferSource,
        ): Promise<ArrayBuffer> {
            const alg = algorithm as AesGcmParams;
            if (alg.name !== 'AES-GCM') throw new DOMException(`polyfill: unsupported algorithm ${alg.name}`, 'NotSupportedError');
            const fakeKey = key as unknown as FakeKey;
            const keyStr = toBinaryString(fakeKey._raw);
            const ivStr  = toBinaryString(toBytes(alg.iv as BufferSource));

            // Input layout: ciphertext || tag (last 16 bytes)
            const bundle = toBytes(data);
            const ct  = bundle.slice(0, bundle.length - 16);
            const tag = bundle.slice(bundle.length - 16);

            const decipher = forge.cipher.createDecipher('AES-GCM', keyStr);
            decipher.start({ iv: ivStr, tag: forge.util.createBuffer(toBinaryString(tag), 'binary') });
            decipher.update(forge.util.createBuffer(toBinaryString(ct), 'binary'));
            const ok = decipher.finish();
            if (!ok) throw new DOMException('AES-GCM: authentication tag mismatch', 'OperationError');

            const plain = fromBinaryString(decipher.output.bytes());
            return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer;
        },

        /* -- stubs for rarely-used methods ----------------------------- */
        async sign():         Promise<ArrayBuffer> { throw new DOMException('polyfill: sign not implemented', 'NotSupportedError'); },
        async verify():       Promise<boolean>     { throw new DOMException('polyfill: verify not implemented', 'NotSupportedError'); },
        async generateKey():  Promise<never> { throw new DOMException('polyfill: generateKey not implemented', 'NotSupportedError'); },
        async deriveKey():    Promise<CryptoKey>   { throw new DOMException('polyfill: deriveKey not implemented', 'NotSupportedError'); },
        async deriveBits():   Promise<ArrayBuffer> { throw new DOMException('polyfill: deriveBits not implemented', 'NotSupportedError'); },
        async exportKey():    Promise<never> { throw new DOMException('polyfill: exportKey not implemented', 'NotSupportedError'); },
        async wrapKey():      Promise<ArrayBuffer> { throw new DOMException('polyfill: wrapKey not implemented', 'NotSupportedError'); },
        async unwrapKey():    Promise<CryptoKey>   { throw new DOMException('polyfill: unwrapKey not implemented', 'NotSupportedError'); },
    };

    try {
        Object.defineProperty(globalThis.crypto, 'subtle', {
            value: subtle,
            writable: false,
            configurable: false,
            enumerable: true,
        });
    } catch {
        // Last-resort: some environments may restrict defineProperty on crypto
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis.crypto as any).subtle = subtle;
    }
}
