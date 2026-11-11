// Chiffrement du carnet, entièrement dans le navigateur (Web Crypto API).
//
// Modèle :
// - une clé de données aléatoire (AES-256-GCM) chiffre tout le contenu ;
// - cette clé est elle-même chiffrée deux fois : par la phrase secrète et par le code de secours,
//   chacun passant par PBKDF2-SHA256 (600 000 itérations, sel aléatoire de 16 octets) ;
// - chaque écriture utilise un vecteur d'initialisation neuf de 12 octets.
// Rien n'est jamais envoyé sur le réseau.

export const ITERATIONS = 600000;
export const FORMAT_VERSION = 2;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto && globalThis.crypto.subtle;

export const cryptoAvailable = () => Boolean(subtle);
export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveWrappingKey(secret, salt, iterations) {
  const base = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Nouvelle clé de données brute (32 octets). À effacer avec .fill(0) après usage. */
export const newDataKey = () => rand(32);

/** Chiffre la clé de données avec un secret (phrase ou code). */
export async function wrapKey(raw, secret) {
  const salt = rand(16);
  const iv = rand(12);
  const kek = await deriveWrappingKey(secret, salt, ITERATIONS);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
  return { iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Déchiffre la clé de données. Lève une erreur si le secret est faux. */
export async function unwrapKey(wrapped, secret) {
  const kek = await deriveWrappingKey(secret, unb64(wrapped.salt), wrapped.iter);
  const raw = await subtle.decrypt({ name: "AES-GCM", iv: unb64(wrapped.iv) }, kek, unb64(wrapped.ct));
  return new Uint8Array(raw);
}

/** Importe la clé de données comme clé non exportable. */
export const importDataKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function encryptJSON(key, value) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decryptJSON(key, box) {
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(plain));
}

// Code de secours : 160 bits aléatoires, en Base32 de Crockford (sans I, L, O, U).
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newRecoveryCode() {
  const bytes = rand(20);
  let bits = 0, acc = 0, out = "";
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out; // 32 caractères
}

/** Tolère tirets, espaces, minuscules et confusions O/0, I/1, L/1. */
export const normalizeCode = (s) =>
  String(s).toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");

export const formatCode = (c) => c.match(/.{1,4}/g).join("-");

const isB64 = (s) => typeof s === "string" && s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const isWrap = (w) => w && Number.isInteger(w.iter) && w.iter >= 100000 && isB64(w.salt) && isB64(w.iv) && isB64(w.ct);

/** Vérifie la forme d'un coffre (stockage local ou fichier de sauvegarde) sans le déchiffrer. */
export function isValidBox(box) {
  return Boolean(box && box.v === FORMAT_VERSION && isWrap(box.pw) && isWrap(box.rc) && isB64(box.iv) && isB64(box.ct));
}
