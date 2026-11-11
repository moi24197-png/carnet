// Tests du module de chiffrement. Lancer avec : node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newDataKey, wrapKey, unwrapKey, importDataKey, encryptJSON, decryptJSON,
  newRecoveryCode, normalizeCode, formatCode, isValidBox, FORMAT_VERSION
} from "../js/crypto.js";

const PASS = "une phrase secrète de test";

test("la phrase et le code de secours ouvrent la même clé", async () => {
  const raw = newDataKey(), code = newRecoveryCode();
  const pw = await wrapKey(raw, PASS), rc = await wrapKey(raw, code);
  assert.deepEqual(await unwrapKey(pw, PASS), raw);
  assert.deepEqual(await unwrapKey(rc, normalizeCode(formatCode(code).toLowerCase())), raw);
});

test("une mauvaise phrase est rejetée", async () => {
  const pw = await wrapKey(newDataKey(), PASS);
  await assert.rejects(unwrapKey(pw, PASS + "x"));
});

test("un contenu modifié est rejeté (intégrité AES-GCM)", async () => {
  const key = await importDataKey(newDataKey());
  const box = await encryptJSON(key, { score: 4 });
  assert.deepEqual(await decryptJSON(key, box), { score: 4 });
  const ct = Buffer.from(box.ct, "base64"); ct[0] ^= 1;
  await assert.rejects(decryptJSON(key, { iv: box.iv, ct: ct.toString("base64") }));
});

test("chaque chiffrement utilise un IV neuf", async () => {
  const key = await importDataKey(newDataKey());
  const a = await encryptJSON(key, {}), b = await encryptJSON(key, {});
  assert.notEqual(a.iv, b.iv);
});

test("le code de secours fait 32 caractères Base32 et tolère les confusions", () => {
  const code = newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{32}$/);
  assert.equal(normalizeCode("ab-cd o i l"), "ABCD011");
  assert.equal(formatCode("ABCDEFGH"), "ABCD-EFGH");
});

test("la forme d'une sauvegarde est contrôlée avant import", async () => {
  const raw = newDataKey(), key = await importDataKey(raw);
  const box = Object.assign({ v: FORMAT_VERSION, pw: await wrapKey(raw, PASS), rc: await wrapKey(raw, newRecoveryCode()) }, await encryptJSON(key, {}));
  assert.equal(isValidBox(box), true);
  assert.equal(isValidBox({ ...box, v: 1 }), false);
  assert.equal(isValidBox({ ...box, pw: { ...box.pw, iter: 1000 } }), false);
  assert.equal(isValidBox({ ...box, ct: "<script>" }), false);
  assert.equal(isValidBox(null), false);
});
