# Wallet & Identity

## Purpose

This module owns local identity material, wallet encryption, and credential protection.

## Responsibility Boundary

- generate the signing and encryption keypairs
- encrypt the wallet on disk
- load local key material into runtime memory
- encrypt Provider-side API credentials

## Out Of Scope

- does not route requests
- does not perform upstream inference
- does not store witness or contribution ledger records

## Interface

```ts
interface Wallet {
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionSecretKey: Uint8Array;
}

function createWallet(password: string, veilHome?: string): Promise<WalletPublicInfo>;
function loadWallet(password: string, veilHome?: string): Promise<Wallet>;
function encryptApiKey(apiKey: string, password: string): EncryptedSecret;
```

## Data Flow

Input: passwords, wallet files, API keys.  
Process: generate keys, encrypt and decrypt, read and write local config.  
Output: runtime wallet objects and encrypted files.

## State

- persistent: `wallet.json`, `config.json`, encrypted credential blobs
- memory: unlocked key material

## Errors

- wallet missing
- wrong password
- corrupted wallet file

## Security Constraints

- never log private keys
- keep wallet files permission-restricted
- keep wallet secrets and Provider credentials in separate protection domains

## Test Requirements

- wallet create, load, export, change password
- invalid password
- damaged file handling

## Dependencies

- calls: `crypto`
- called by: `cli`, `consumer`, `provider`, `relay`

---

## Implementation Details

**Source:** `src/wallet/index.ts`, `src/wallet/encrypt.ts`, `src/crypto/index.ts`

### Key Data Structures

```ts
// src/wallet/index.ts
export interface Wallet {
  signingPublicKey: Uint8Array;      // Ed25519 (64 bytes secret, 32 bytes public)
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;   // X25519 (32 bytes each)
  encryptionSecretKey: Uint8Array;
}

export interface WalletPublicInfo {
  signingPublicKey: string;   // hex
  encryptionPublicKey: string; // hex
}

// src/wallet/encrypt.ts
export interface EncryptedWallet {
  version: 1;
  kdf: 'scrypt';
  kdf_params: { N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  ciphertext: string;  // hex
  iv: string;          // hex, 12 bytes
  tag: string;         // hex, 16 bytes auth tag
}

export interface WalletData {
  signingPublicKey: string;     // hex
  signingSecretKey: string;     // hex
  encryptionPublicKey: string;  // hex
  encryptionSecretKey: string;  // hex
}
```

### Wallet Encryption

- **KDF**: scrypt with N=2^14 (test, configurable via `VEIL_KDF_N` env; production should use 2^17), r=8, p=1
- **Cipher**: AES-256-GCM with random 12-byte IV and 32-byte salt
- **Key derivation**: `scryptSync(password, salt, 32, params)` → 256-bit key
- **Wallet file**: `~/.veil/wallet.json` with mode 0o600
- **Config file**: `~/.veil/config.json` with relay URL, gateway port, public keys

### Crypto Primitives (`src/crypto/index.ts`)

- **Library**: `tweetnacl` (TweetNaCl)
- **Signing**: Ed25519 via `nacl.sign.keyPair()`, `nacl.sign.detached()`, `nacl.sign.detached.verify()`
- **Encryption**: X25519 + XSalsa20-Poly1305 via `nacl.box()` / `nacl.box.open()`
- **Sealing format**: `[sender_pubkey(32) | nonce(24) | ciphertext(N)]` — total minimum 56 bytes
- **Hashing**: `node:crypto` SHA-256
- **Hex encoding**: `Buffer.from(hex)` / `Buffer.toString('hex')` with strict validation

### Key Validation

- `validateKeyLength()`: checks Uint8Array type and expected byte length
- `validatePublicKey()`: specifically checks 32-byte public keys
- `fromHex()`: validates string type, even length, hex characters only

### Legacy Wallet Support

- `isEncryptedFormat()`: detects v1 encrypted vs legacy plaintext by checking `version` + `kdf` fields
- `parseLegacyWallet()`: extracts raw key fields from unencrypted format
- `migrateWallet()`: encrypts legacy wallet in-place

### API Key Encryption

- Separate from wallet encryption but same primitives
- `encryptApiKey()`: scrypt + AES-256-GCM, returns `{salt, iv, ciphertext, tag}`
- Stored in `~/.veil/provider.json`

## API Specification

### Wallet Lifecycle

```ts
createWallet(password: string, veilHome?: string): Promise<WalletPublicInfo>
loadWallet(password: string, veilHome?: string): Promise<Wallet>
exportWallet(password: string, veilHome?: string): Promise<EncryptedWallet>
changeWalletPassword(oldPassword: string, newPassword: string, veilHome?: string): Promise<void>
migrateWallet(password: string, veilHome?: string): Promise<void>
isLegacyWallet(veilHome?: string): boolean
getPublicKeys(veilHome?: string): WalletPublicInfo
```

### API Key Management

```ts
encryptApiKey(apiKey: string, password: string): { salt, iv, ciphertext, tag }
decryptApiKey(enc: { salt, iv, ciphertext, tag }, password: string): string
```

### Crypto Functions

```ts
generateSigningKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array }
generateEncryptionKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array }
sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array
verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean
seal(plaintext: Uint8Array, recipientPubkey: Uint8Array, senderSecretKey: Uint8Array): Uint8Array
open(sealed: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null
sha256(data: Uint8Array): Uint8Array
toHex(bytes: Uint8Array): string
fromHex(hex: string): Uint8Array
```

## Integration Protocol

- **Used by CLI**: `createWallet`, `loadWallet`, `encryptApiKey`, `changeWalletPassword`, `migrateWallet`
- **Used by Consumer**: `Wallet` for request signing (`sign`) and response decryption (`open`)
- **Used by Provider**: `Wallet` for hello signing (`sign`) and request decryption (`open`) + response encryption (`seal`)
- **Used by Relay**: `Wallet` for witness signing (`sign`) and request verification (`verify`)
- **File layout**: `~/.veil/wallet.json`, `~/.veil/config.json`, `~/.veil/provider.json`
- **Config via env**: `VEIL_HOME` (wallet directory), `VEIL_KDF_N` (scrypt cost), `VEIL_PASSWORD` (non-interactive)

## Current Implementation Status

- ✅ Ed25519 signing keypair generation [IMPLEMENTED]
- ✅ X25519 encryption keypair generation [IMPLEMENTED]
- ✅ Wallet encryption (scrypt + AES-256-GCM) [IMPLEMENTED]
- ✅ Wallet create, load, export, change password [IMPLEMENTED]
- ✅ Legacy wallet detection and migration [IMPLEMENTED]
- ✅ API key encryption/decryption [IMPLEMENTED]
- ✅ E2E seal/open with nacl.box [IMPLEMENTED]
- ✅ Strict key/hex validation [IMPLEMENTED]
- ✅ File permissions (0o600) [IMPLEMENTED]
- ⚠️ KDF cost parameter configurable but defaults to test value (N=2^14) [PARTIAL]
- ❌ Hardware key / HSM support [DESIGN ONLY]
- ❌ Key rotation without identity change [DESIGN ONLY]

---

## Design Specifications for Unimplemented Items

### Hardware Key / HSM Support [DESIGN SPEC · Phase 4]

```ts
type KeyBackend = 'file' | 'hsm' | 'yubikey' | 'tpm';

interface HardwareKeyConfig {
  backend: KeyBackend;
  slotId?: number;                 // HSM/YubiKey slot
  pin?: string;                    // prompted at runtime, never persisted
  pkcs11LibPath?: string;          // for generic HSM via PKCS#11
}

interface WalletProvider {
  getPublicKey(): Promise<string>;
  sign(payload: Uint8Array): Promise<Uint8Array>;  // delegates to backend
  // Private key never leaves HSM boundary
}

// Rules:
// - File backend: existing Ed25519 keypair in ~/.veil/wallet.json
// - HSM backend: key generated inside HSM, only pubkey exported
// - Sign operations always async (HSM may require PIN/touch)
// - Wallet interface unchanged for consumers (provider-engine, relay, etc.)
// - CLI: veil wallet init --backend yubikey --slot 1
```

### Key Rotation Without Identity Change [DESIGN SPEC · Phase 4]

```ts
interface KeyRotation {
  oldPubkey: string;
  newPubkey: string;
  rotationProof: string;           // signed by old key: "rotate:{oldPub}:{newPub}:{timestamp}"
  timestamp: number;
}

// Flow:
// 1. Generate new keypair (same backend)
// 2. Sign rotation proof with OLD key
// 3. Broadcast KeyRotation to connected relays
// 4. Relay verifies proof, updates provider/consumer pubkey mapping
// 5. Old key kept for verification of existing witnesses (90-day retention)
// 6. New key used for all new signatures
//
// Identity continuity: pubkey changes, but node identity preserved via
// rotation chain (each rotation references previous pubkey)
// CLI: veil wallet rotate [--force]
// Requires re-registration with relays (automatic in autopilot mode)
```
