import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** The environment variable the key comes from; every error about it names it. */
export const SECRET_VARIABLE = "FACETDB_SECRET";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const FORMAT = "v1";

/** AES-256-GCM over one value, with the row it belongs to bound in. */
export type Crypto = {
  /** `purpose` ties the ciphertext to its row (`credential:<project>:<name>`): moved, it fails to open. */
  encrypt(plaintext: string, purpose: string): string;
  /** Opens what `encrypt` made under the same key and purpose, or throws; it never returns garbage. */
  decrypt(ciphertext: string, purpose: string): string;
};

/** A fresh per-install salt, stored beside the data it protects (not secret, but unique per install). */
export function newSalt(): string {
  return randomBytes(SALT_BYTES).toString("base64");
}

/**
 * The secret from the environment (a boundary, so it may be missing). A missing or empty secret is an
 * error that names the variable: there is no plaintext fallback anywhere.
 */
export function requireSecret(secret: string | undefined): string {
  if (secret === undefined || secret === "") {
    throw new Error(
      `${SECRET_VARIABLE} is not set; the FacetDB store encrypts credentials with a key derived from it, so set it to a long random value (and keep it: without it they cannot be read)`,
    );
  }
  return secret;
}

/**
 * The key is derived from the secret with scrypt and the install's own salt, so one secret reused
 * across installs gives different keys.
 */
export function createCrypto(secret: string, salt: string): Crypto {
  const key = scryptSync(requireSecret(secret), Buffer.from(salt, "base64"), KEY_BYTES);

  return {
    encrypt(plaintext, purpose) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(purpose, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        FORMAT,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        body.toString("base64"),
      ].join(":");
    },
    decrypt(ciphertext, purpose) {
      const [format, iv, tag, body, ...rest] = ciphertext.split(":");
      if (
        format !== FORMAT ||
        iv === undefined ||
        tag === undefined ||
        body === undefined ||
        rest.length > 0
      ) {
        throw new Error("the stored credential is not in a format this version of FacetDB wrote");
      }
      const tagBytes = Buffer.from(tag, "base64");
      if (tagBytes.length !== TAG_BYTES) {
        throw new Error("the stored credential is not in a format this version of FacetDB wrote");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
        decipher.setAAD(Buffer.from(purpose, "utf8"));
        decipher.setAuthTag(tagBytes);
        return Buffer.concat([
          decipher.update(Buffer.from(body, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch (cause) {
        throw new Error(
          `could not decrypt a stored credential: ${SECRET_VARIABLE} is not the value it was encrypted with (or the row was altered)`,
          { cause },
        );
      }
    },
  };
}
