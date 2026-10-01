// Run this once, from the SAME folder as your .env file:
//   node update-password.js YourNewPassword123
//
// It generates a fresh bcrypt hash and writes it directly into .env,
// so there's no manual copy-paste step (which is what truncated the
// hash by one character last time).

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const newPassword = process.argv[2];
const envPath = path.join(__dirname, '.env');

if (!newPassword) {
  console.error('Usage: node update-password.js YourNewPassword123');
  process.exit(1);
}

if (!fs.existsSync(envPath)) {
  console.error(`ERROR: No .env file found at ${envPath}`);
  console.error('Make sure this script is in the same folder as your .env file,');
  console.error('and that the file is named exactly ".env" (not "_env" or "env.txt").');
  process.exit(1);
}

bcrypt.hash(newPassword, 10).then((hash) => {
  console.log('Generated hash (60 chars):', hash.length === 60 ? 'OK ✓' : 'WARNING — wrong length!');

  let envContent = fs.readFileSync(envPath, 'utf8');

  if (/^ADMIN_PASSWORD_HASH=.*$/m.test(envContent)) {
    // Replace the existing line
    envContent = envContent.replace(/^ADMIN_PASSWORD_HASH=.*$/m, `ADMIN_PASSWORD_HASH=${hash}`);
  } else {
    // No existing line — append one
    envContent += `\nADMIN_PASSWORD_HASH=${hash}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log('');
  console.log('✓ .env updated successfully.');
  console.log('✓ Now RESTART your server for the change to take effect.');
  console.log('✓ Log in with username "admin" and the password you just set.');
});
