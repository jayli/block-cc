'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const tls = require('tls');

const CERT_DIR = path.join(os.homedir(), '.config', 'block-cc');

function ensureDir() {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }
}

function checkOpenssl() {
  try {
    execSync('openssl version', { stdio: 'pipe' });
  } catch (_) {
    throw new Error(
      'openssl is required but not found.\n' +
      '  macOS: brew install openssl\n' +
      '  Ubuntu/Debian: sudo apt install openssl\n' +
      '  Windows: winget install OpenSSL'
    );
  }
}

function setupCA() {
  ensureDir();
  const caKeyPath = path.join(CERT_DIR, 'ca.key');
  const caCertPath = path.join(CERT_DIR, 'ca.crt');

  if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
    return { caKeyPath, caCertPath, isNew: false };
  }

  checkOpenssl();

  execSync(
    `openssl genrsa -out "${caKeyPath}" 2048`,
    { stdio: 'pipe' }
  );
  execSync(
    `openssl req -x509 -new -nodes -key "${caKeyPath}" -sha256 -days 3650 ` +
    `-out "${caCertPath}" -subj "/CN=block-cc Proxy CA/O=block-cc"`,
    { stdio: 'pipe' }
  );

  return { caKeyPath, caCertPath, isNew: true };
}

function setupServerCert(hostname) {
  ensureDir();
  const { caKeyPath, caCertPath } = setupCA();

  const keyPath = path.join(CERT_DIR, `${hostname}.key`);
  const certPath = path.join(CERT_DIR, `${hostname}.crt`);

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath };
  }

  checkOpenssl();

  const csrPath = path.join(CERT_DIR, `${hostname}.csr`);
  const extPath = path.join(CERT_DIR, `${hostname}.ext`);

  execSync(
    `openssl genrsa -out "${keyPath}" 2048`,
    { stdio: 'pipe' }
  );
  execSync(
    `openssl req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${hostname}"`,
    { stdio: 'pipe' }
  );

  const ext = [
    'authorityKeyIdentifier=keyid,issuer',
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature, nonRepudiation, keyEncipherment',
    'subjectAltName=@alt_names',
    '[alt_names]',
    `DNS.1=${hostname}`,
    `DNS.2=*.${hostname}`,
  ].join('\n');
  fs.writeFileSync(extPath, ext);

  execSync(
    `openssl x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
    `-CAcreateserial -out "${certPath}" -days 3650 -sha256 -extfile "${extPath}"`,
    { stdio: 'pipe' }
  );

  try { fs.unlinkSync(csrPath); } catch (_) {}
  try { fs.unlinkSync(extPath); } catch (_) {}

  return { keyPath, certPath };
}

function getSecureContext(hostname) {
  const { keyPath, certPath } = setupServerCert(hostname);
  return tls.createSecureContext({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  });
}

module.exports = { setupCA, getSecureContext };
