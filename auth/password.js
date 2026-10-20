// Hash de senha (scrypt). Extraído do server.js em 2026-09-10, quando a
// recuperação de senha virou o SEGUNDO lugar que precisa disso — o
// código de recuperação também é guardado como hash, e duplicar essas
// dez linhas seria duplicar a chance de uma cópia divergir da outra.
//
// O FORMATO não mudou: `salt:hash`, scrypt com 64 bytes. Hashes já
// gravados continuam válidos.

const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  // `timingSafeEqual` e não `===`: comparar bytes com short-circuit
  // vaza, pelo tempo de resposta, quantos caracteres iniciais bateram.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
