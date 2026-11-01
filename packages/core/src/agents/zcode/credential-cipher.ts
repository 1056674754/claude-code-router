import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";

/**
 * ZCode stores its credential file entries as `enc:v1:<nonce>.<tag>.<payload>`
 * (AES-256-GCM, base64url parts). The cipher key is derived from
 * `ZCODE_CREDENTIAL_SECRET` when the app runs with it, otherwise from a
 * device-bound fallback string, so the values are reproducible for the same
 * OS/user/home. Older ZCode builds wrote plaintext, which is why values that
 * do not carry the prefix are returned untouched.
 */
export const zcodeEncryptedCredentialPrefix = "enc:v1:";

const cipherAlgorithm = "aes-256-gcm";
const credentialSecretEnvVar = "ZCODE_CREDENTIAL_SECRET";

export function isZcodeEncryptedCredential(value: string): boolean {
  return value.startsWith(zcodeEncryptedCredentialPrefix);
}

export function zcodeCredentialSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[credentialSecretEnvVar]?.trim();
  if (explicit) {
    return explicit;
  }
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // userInfo() can throw when the process has no passwd entry; keep the fallback stable.
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

export function zcodeCredentialCipherKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return createHash("sha256").update(zcodeCredentialSecret(env)).digest();
}

export class ZcodeCredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZcodeCredentialDecryptError";
  }
}

export function decryptZcodeCredential(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isZcodeEncryptedCredential(value)) {
    return value;
  }
  const parts = value.slice(zcodeEncryptedCredentialPrefix.length).split(".");
  const [nonce, authTag, payload] = parts;
  if (!nonce || !authTag || payload === undefined || parts.length !== 3) {
    throw new ZcodeCredentialDecryptError("Malformed ZCode credential payload.");
  }
  try {
    const decipher = createDecipheriv(cipherAlgorithm, zcodeCredentialCipherKey(env), Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    throw new ZcodeCredentialDecryptError(
      error instanceof Error ? `Cannot decrypt ZCode credential: ${error.message}` : "Cannot decrypt ZCode credential."
    );
  }
}
