import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainMoPath = path.resolve(__dirname, '../../paywall_backend/main.mo');

let motokoCode;
try {
  motokoCode = fs.readFileSync(mainMoPath, 'utf8');
} catch (error) {
  console.error(`Error reading main.mo: ${error.message}`);
  process.exit(1);
}

const checks = [
  {
    description: 'Minimum fee definition (100_000 e8s / 0.001 ICP)',
    pattern: /let\s+paywallMinFeeE8s\s*:\s*Nat\s*=\s*100_000\s*;/,
  },
  {
    description: 'Fee calculation (max(1% or min fee))',
    pattern: /Nat\.max\s*\(\s*price_e8s\s*\/\s*100\s*,\s*paywallMinFeeE8s\s*\)\s*;/,
  },
  {
    description: 'Fee account identifier (specific hex address)',
    pattern:
      /"2a4abcd2278509654f9a26b885ecb49b8619bffe58a6acb2e3a5e3c7fb96020d"/,
  },
  {
    description: 'Fee computation in settleFromEscrow',
    pattern:
      /private\s+func\s+settleFromEscrow\s*\([\s\S]*?let\s+fee_e8s\s*=\s*calculateFee\s*\(\s*config\.price_e8s\s*\)\s*;/,
  },
  {
    description: 'Fee send in settleFromEscrow',
    pattern:
      /private\s+func\s+settleFromEscrow\s*\([\s\S]*?let\s+feeResult\s*=\s*await\s+sendFee\s*\(\s*fee_e8s\s*,\s*\?escrowSubaccount\s*\)\s*;/,
  },
  {
    description: 'payFromBalance uses escrow settlement',
    pattern:
      /public\s+shared\(msg\)\s+func\s+payFromBalance\s*\([\s\S]*?await\s+settleFromEscrow\s*\(\s*caller\s*,\s*paywallId\s*,\s*config\s*,\s*escrowSubaccount\s*,\s*userSubaccount\s*\)\s*;/,
  },
  {
    description: 'verifyPayment uses escrow settlement',
    pattern:
      /public\s+shared\(msg\)\s+func\s+verifyPayment\s*\([\s\S]*?await\s+settleFromEscrow\s*\(\s*caller\s*,\s*paywallId\s*,\s*config\s*,\s*escrowSubaccount\s*,\s*paywallSubaccount\s*\)\s*;/,
  },
];

let allPassed = true;
for (const check of checks) {
  if (!check.pattern.test(motokoCode)) {
    console.error(`Fee check failed: Missing or altered ${check.description}`);
    allPassed = false;
  }
}

if (!allPassed) {
  console.error('Deployment aborted: Fee logic has been tampered with or is missing.');
  process.exit(1);
}

console.log('All fee checks passed. Proceeding with deployment.');
