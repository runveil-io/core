/**
 * Metering Module - Witness Generation
 * 
 * Generate signed witness records for settlement
 */

import type { NormalizedUsage, CostBreakdown, Witness } from './types';

/**
 * Generate a witness record
 */
export async function generateWitness(
  requestId: string,
  usage: NormalizedUsage,
  cost: CostBreakdown,
  relayPrivateKey: string
): Promise<Witness> {
  const timestamp = Date.now();
  
  // Create witness data to sign
  const witnessData = {
    request_id: requestId,
    usage,
    cost,
    timestamp,
  };
  
  // Sign the witness data
  const signature = await signWitness(witnessData, relayPrivateKey);
  
  return {
    ...witnessData,
    relay_signature: signature,
  };
}

/**
 * Sign witness data using Ed25519
 */
async function signWitness(
  data: { request_id: string; usage: NormalizedUsage; cost: CostBreakdown; timestamp: number },
  privateKey: string
): Promise<string> {
  // Create deterministic string representation for signing
  const dataStr = JSON.stringify(data);
  
  // In production, use actual Ed25519 signing
  // For now, use a simple hash-based signature
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(dataStr);
  
  // Use Web Crypto API for signing
  const keyData = encoder.encode(privateKey);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  
  // Create HMAC-like signature
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    dataBytes
  );
  
  // Convert to hex string
  return Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify a witness record
 */
export async function verifyWitness(
  witness: Witness,
  relayPublicKey: string
): Promise<boolean> {
  // Extract signature
  const { relay_signature: signature, ...witnessData } = witness;
  
  // Recreate the data that was signed
  const dataStr = JSON.stringify(witnessData);
  
  // In production, use actual Ed25519 verification
  // For now, verify using the same hash-based approach
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(dataStr);
  
  // Verify signature
  const keyData = encoder.encode(relayPublicKey);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  
  // Convert signature from hex to bytes
  const signatureBytes = Uint8Array.from(
    signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );
  
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']),
      signatureBytes,
      dataBytes
    );
    return valid;
  } catch {
    return false;
  }
}

/**
 * Generate batch witness records
 */
export async function generateWitnessBatch(
  records: Array<{
    requestId: string;
    usage: NormalizedUsage;
    cost: CostBreakdown;
  }>,
  relayPrivateKey: string
): Promise<Witness[]> {
  return Promise.all(
    records.map(record =>
      generateWitness(record.requestId, record.usage, record.cost, relayPrivateKey)
    )
  );
}

/**
 * Serialize witness for storage/transmission
 */
export function serializeWitness(witness: Witness): string {
  return JSON.stringify(witness);
}

/**
 * Deserialize witness from string
 */
export function deserializeWitness(data: string): Witness {
  return JSON.parse(data);
}
