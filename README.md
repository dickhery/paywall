# IC Paywall: Secure ICP Payments for Web Projects

[![IC Paywall Logo](/src/paywall_frontend/public/logo.png)](https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/)

IC Paywall is a decentralized application (dApp) built on the Internet Computer Protocol (ICP) blockchain. It allows users to create customizable paywalls for their web projects, charging visitors in ICP tokens for access. Payments can be split across multiple destinations (principals or account IDs), with options to convert ICP to cycles for canister top-ups. The app generates embeddable script tags for easy integration into websites or dApps, enforcing access controls via Internet Identity authentication and ICP ledger transactions.

Key features:
- **Paywall Creation**: Set ICP price, session duration, custom prompts, and payment splits.
- **Payment Handling**: Uses the ICP ledger for secure, on-chain transfers.
- **Cycle Conversion**: Automatically convert payments to cycles via the Cycles Minting Canister (CMC).
- **Integration**: Client-side script for frontend enforcement; backend checks for integrity.
- **User Wallets**: Each user gets a derived subaccount for deposits and payments.

The app is deployed on ICP mainnet:
- Frontend (Paywall Builder): [https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/](https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/)
- Backend Canister ID: 4d2uq-jaaaa-aaaab-adm4q-cai

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation and Setup](#installation-and-setup)
- [Deployment](#deployment)
- [Using the Paywall Builder](#using-the-paywall-builder)
- [Integrating the Paywall Script](#integrating-the-paywall-script)
- [Integrating with Vibe Coding](#integrating-with-vibe-coding)
- [Strengthening Projects for Integrity](#strengthening-projects-for-integrity)
- [Editing and Deleting Paywalls](#editing-and-deleting-paywalls)
- [How It Works](#how-it-works)
- [Common Issues and Troubleshooting](#common-issues-and-troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites

To run or deploy IC Paywall, ensure your system meets these requirements:

- **DFX SDK**: Version 0.29.2 or later. Install from the [DFINITY SDK documentation](https://internetcomputer.org/docs/current/developer-docs/getting-started/install/).
- **Node.js and npm**: Version 16+ and 7+ respectively. Download from [nodejs.org](https://nodejs.org/).
- **Git**: For cloning the repository.
- **ICP Wallet**: For testing payments (e.g., NNS dApp or Plug Wallet).
- **Internet Identity**: Required for authentication in the app and paywalls.

## Installation and Setup

1. **Clone the Repository**:
   ```
   git clone https://github.com/dickhery/paywall.git
   cd paywall
   ```

2. **Install Dependencies**:
   ```
   npm install
   ```
   This installs all Node.js packages for the frontend and prepares the project.

3. **Generate Declarations** (Optional, but recommended for development):
   ```
   dfx generate
   ```
   This generates TypeScript declarations for the Motoko backend.

4. **Set Up Environment Variables** (Optional):
   - The project uses a `.env` file for canister IDs and network settings. A sample is provided; customize as needed for local vs. mainnet.

## Deployment

### Local Deployment

1. Start the local ICP replica:
   ```
   dfx start --clean --background
   ```

2. Deploy the canisters:
   ```
   dfx deploy --network local
   ```
   - This deploys the backend (`paywall_backend`), frontend (`paywall_frontend`), and Internet Identity (for local testing).

3. Access the local frontend at `http://localhost:4943/?canisterId=<frontend-canister-id>` (find IDs in `.dfx/local/canister_ids.json`).

### Mainnet Deployment (ICP Network)

1. Ensure you have cycles in your wallet for deployment.

2. Deploy to ICP mainnet:
   ```
   dfx deploy --network ic
   ```
   - This uses the configuration in `dfx.json` and `.env`.
   - Note: Mainnet deployment costs cycles; monitor via the ICP dashboard.

3. After deployment, update your frontend URL and canister IDs in any integrations.

For production, always verify canister IDs and use certified assets for security.

## Using the Paywall Builder

The Paywall Builder is the user interface for creating and managing paywalls. Access it at [https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/](https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/).

### Steps to Create a Paywall

1. **Sign In**: Use Internet Identity to authenticate. This links your principal to paywall ownership.

2. **Configure Paywall**:
   - **Price (ICP)**: Set the amount users pay (e.g., 0.1 ICP). Minimum ensures coverage of the 1% fee (or 0.001 ICP min).
   - **Destination Splits**: Define up to 3 destinations for payments after fees.
     - **Separate Destinations**: Payments can be split by percentage (must sum to 100%). Each destination receives its share.
     - **Types**:
       - **Principal**: Send to an ICP principal (e.g., wallet or canister). Enable "Convert to Cycles" to top up canister cycles via CMC.
       - **Account ID**: Send to a 64-hex ledger account ID (legacy format; no cycle conversion).
     - Example: 70% to your wallet principal, 30% to a canister for cycles.
   - **Associated URL**: The URL where this paywall will be deployed (e.g., https://example.com).
   - **Session Duration**: Set access time post-payment (days/hours/minutes/seconds).
   - **Custom Prompts** (Optional): Login and payment messages for user experience.

3. **Create and Generate Script**:
   - Submit to create the paywall.
   - Copy the generated `<script>` tag for integration.

### Viewing and Managing Paywalls

- **My Paywalls**: Lists your created paywalls with configs, usage counts (refreshable), and embed scripts.
- **Usage Count**: Tracks payments; refresh to update from backend.
- **Vibe Coding Prompt**: For each paywall, a pre-generated prompt is provided that can be copied to integrate the paywall into vibe-coded apps (e.g., using AI-assisted coding tools). This prompt includes integration instructions, troubleshooting tips, and paywall details for seamless one-pass integration.

## Integrating the Paywall Script

Embed the generated script in your web project to enforce the paywall.

### Script Placement

- Add to the `<head>` of your HTML:
  ```
  <script type="module" data-paywall data-backend-id="4d2uq-jaaaa-aaaab-adm4q-cai" src="https://4kz7m-7iaaa-aaaab-adm5a-cai.icp0.io/paywall.js?paywallId=pw-0"></script>
  ```
- **Attributes**:
  - `data-paywall`: Marks the script.
  - `data-backend-id`: Backend canister ID (fixed for this app).
- **Query Param**: `?paywallId=<your-id>` links to your config.

### How the Script Works

- On load, it checks access via backend query.
- If no access: Shows overlay prompting login/payment.
- Users deposit ICP to their derived subaccount, then pay.
- On success: Hides overlay, grants access for session duration.

### Common Issues

- **CORS Headers**: If the script fails to load or communicate:
  - Ensure your server allows cross-origin requests from `*.icp0.io`.
  - Set headers: `Access-Control-Allow-Origin: *` (or specific ICP domains), `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: *`.
  - For static sites (e.g., GitHub Pages), use a proxy or host on ICP.
- **Script Blocked**: Browser extensions (ad blockers) may interfere; test in incognito.
- **Local Testing**: Use `dfx deploy --network local` and update script src to local URL (e.g., `http://<frontend-id>.localhost:4943/paywall.js?paywallId=<id>`).
- **Payment Failures**: Ensure sufficient balance including fees. Check console for errors.

## Integrating with Vibe Coding

IC Paywall supports integration with AI-assisted coding tools like vibe coding apps. For each paywall in "My Paywalls", a customizable vibe coding prompt is generated. This prompt provides a complete guide to integrate the paywall in one pass, including:

- The exact embed script tag.
- CORS configuration instructions.
- Frontend and backend enforcement tips (e.g., using `window.paywallHandshake` and `hasAccess` checks).
- Troubleshooting for common issues like page reloads, origin mismatches, and access propagation.
- Paywall details like price, prompts, and session duration.

Copy the prompt and paste it into your vibe coding tool to automatically generate or update your app with paywall enforcement. This is ideal for vibe-coded apps, ensuring seamless monetization without manual coding.

## Strengthening Projects for Integrity

For maximum security, combine client-side script with backend enforcement:

- **Frontend Handshake**:
  - Before rendering sensitive UI: `window.paywallHandshake(() => { /* logout or hide */ });`
  - Blocks until access confirmed; returns `true` if granted.

- **Backend Checks (Motoko/Rust)**:
  - In canister methods: Query `paywall_backend.hasAccess(caller, paywallId)`.
  - Example (Motoko):
    ```
    if (not (await paywall_backend.hasAccess(caller, "pw-0"))) { Debug.trap("Access denied"); };
    ```
  - Prevents bypassing client-side checks.

- **Periodic Checks**:
  - Re-validate every 60s: Use `setInterval` with `paywallHandshake`.
  - Invalidate session if fails.

- **Audit Logs**: Use target canister for hooks (future expansion).

## Editing and Deleting Paywalls

- **Edit**: In "My Paywalls", click "Edit" to update config. Changes apply immediately.
- **Delete**: In "My Paywalls", click "Delete" to remove the paywall.
  - **Warning**: Deleting a paywall is permanent and cannot be undone. This action will:
    - Lose all associated user accounts and funds in subaccounts. Users with balances will lose access/funds—export data first if needed.
    - Break any websites or apps that have integrated this paywall, potentially causing errors or unexpected behavior for users.
    - Require manual removal of the paywall script from all integrated projects to avoid runtime issues.
    - Disrupt ongoing sessions and payments; notify users and integrators in advance if possible.
  - Proceed with caution, especially if the paywall is in active use.

## How It Works

- **Backend (Motoko)**: Manages configs, derives subaccounts, handles payments via ICP ledger/CMC.
- **Frontend (React)**: UI for creation/management.
- **Script (paywall.js)**: Client-side enforcement with overlays and periodic checks.
- **Payments**: 1% fee (min 0.001 ICP) to fixed account; remainder split/converted.
- **Security**: Uses salted derivations for privacy; Internet Identity for auth.

View source: [GitHub Repo](https://github.com/dickhery/paywall).

## Common Issues and Troubleshooting

- **Deployment Errors**: Ensure DFX version matches (0.29.2). Check cycles balance.
- **Auth Failures**: Clear browser cache; ensure II URL is correct.
- **Payment Issues**: Verify ledger ID; check console for transfer errors.
- **Script Not Loading**: Confirm canister IDs; test with `dfx canister call`.
- **Debugging**: Use browser console; enable Motoko debug prints.

For help, open a GitHub issue.

## Contributing

Contributions welcome! Fork the repo, create a branch, and submit a PR. Follow code style in existing files.

## License

See LICENSE