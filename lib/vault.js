// Encrypts the PC passwords before they're written to the Google Sheet, so
// anyone who can open the spreadsheet (or a backup export) sees only
// ciphertext. AES-256-GCM; the key comes from PC_VAULT_KEY when set, and
// otherwise is derived from JWT_SECRET (so it works out of the box, but then
// changing JWT_SECRET makes the stored passwords unreadable — set
// PC_VAULT_KEY on the server to decouple the two).
const crypto = require('crypto');

function key() {
  const secret = process.env.PC_VAULT_KEY || ('click-pc-vault|' + (process.env.JWT_SECRET || ''));
  if (!process.env.PC_VAULT_KEY && !process.env.JWT_SECRET) throw new Error('Server is missing JWT_SECRET.');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

// Returns null when the value can't be decrypted (wrong key / corrupted).
function decrypt(blob) {
  try {
    const [v, iv, tag, ct] = String(blob || '').split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

module.exports = { encrypt, decrypt };
