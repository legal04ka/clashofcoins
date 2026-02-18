import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { config as dotenvConfig } from 'dotenv';
import { ethers } from 'ethers';

dotenvConfig();

const TARGET_URL = process.env.TARGET_URL ?? 'https://clashofcoins.com/agentic?ref=H-bxcl-ohgv-7048';
const PRIVATE_KEY_FILE = process.env.PRIVATE_KEY_FILE ?? 'wallet1.txt';
const RPC_URL = process.env.RPC_URL ?? 'https://rpc.ankr.com/eth';
const CLAIM_TIMEOUT_MS = Number(process.env.CLAIM_TIMEOUT_MS ?? 120_000);
const HEADLESS = (process.env.HEADLESS ?? 'false').toLowerCase() !== 'false';

function ensureWalletPrivateKey(filePath) {
  const resolvedPath = path.resolve(filePath);

  if (fs.existsSync(resolvedPath)) {
    const privateKey = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error(`Invalid private key in ${resolvedPath}`);
    }

    return privateKey;
  }

  const wallet = ethers.Wallet.createRandom();
  fs.writeFileSync(resolvedPath, wallet.privateKey, { mode: 0o600 });
  console.log(`Created new wallet ${wallet.address} and saved private key to ${resolvedPath}`);

  return wallet.privateKey;
}

function decodeChainId(chainIdHex) {
  if (typeof chainIdHex === 'number') {
    return chainIdHex;
  }

  if (typeof chainIdHex === 'string' && chainIdHex.startsWith('0x')) {
    return Number.parseInt(chainIdHex, 16);
  }

  return Number(chainIdHex);
}

async function main() {
  const privateKey = ensureWalletPrivateKey(PRIVATE_KEY_FILE);
  const transportProvider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(privateKey, transportProvider);

  console.log(`Using wallet address: ${wallet.address}`);
  console.log(`RPC endpoint: ${RPC_URL}`);

  let activeChainId = decodeChainId((await transportProvider.send('eth_chainId', [])) ?? '0x1');
  let activeRpcUrl = RPC_URL;
  let activeProvider = transportProvider;
  let activeWallet = wallet;
  let txHash = null;

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.exposeBinding('agenticBridge', async (_source, request) => {
    const { method, params } = request;

    if (!method) {
      throw new Error('Request method is required');
    }

    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [activeWallet.address];
      case 'eth_chainId':
        return ethers.toBeHex(activeChainId);
      case 'net_version':
        return String(activeChainId);
      case 'personal_sign': {
        const [message, signer] = params;
        if (signer && signer.toLowerCase() !== activeWallet.address.toLowerCase()) {
          throw new Error(`Unexpected signer for personal_sign: ${signer}`);
        }

        const bytes = ethers.getBytes(message);
        return activeWallet.signMessage(bytes);
      }
      case 'eth_sign': {
        const [signer, message] = params;
        if (signer && signer.toLowerCase() !== activeWallet.address.toLowerCase()) {
          throw new Error(`Unexpected signer for eth_sign: ${signer}`);
        }

        const bytes = ethers.getBytes(message);
        return activeWallet.signMessage(bytes);
      }
      case 'eth_signTypedData':
      case 'eth_signTypedData_v4': {
        const [signer, typedDataInput] = params;
        if (signer && signer.toLowerCase() !== activeWallet.address.toLowerCase()) {
          throw new Error(`Unexpected signer for typed data: ${signer}`);
        }

        const typedData = typeof typedDataInput === 'string' ? JSON.parse(typedDataInput) : typedDataInput;
        const { domain = {}, types = {}, message = {} } = typedData;
        const normalizedTypes = { ...types };
        delete normalizedTypes.EIP712Domain;
        return activeWallet.signTypedData(domain, normalizedTypes, message);
      }
      case 'wallet_switchEthereumChain': {
        const [{ chainId }] = params;
        activeChainId = decodeChainId(chainId);
        return null;
      }
      case 'wallet_addEthereumChain': {
        const [chainParams] = params;
        if (chainParams?.rpcUrls?.length) {
          activeRpcUrl = chainParams.rpcUrls[0];
          activeProvider = new ethers.JsonRpcProvider(activeRpcUrl);
          activeWallet = new ethers.Wallet(privateKey, activeProvider);
        }

        if (chainParams?.chainId) {
          activeChainId = decodeChainId(chainParams.chainId);
        }

        return null;
      }
      case 'eth_sendTransaction': {
        const [txRequest] = params;
        const tx = {
          to: txRequest.to,
          value: txRequest.value ? BigInt(txRequest.value) : undefined,
          data: txRequest.data,
          nonce: txRequest.nonce ? Number(txRequest.nonce) : undefined,
          gasLimit: txRequest.gas ? BigInt(txRequest.gas) : undefined,
          gasPrice: txRequest.gasPrice ? BigInt(txRequest.gasPrice) : undefined,
          maxFeePerGas: txRequest.maxFeePerGas ? BigInt(txRequest.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas ? BigInt(txRequest.maxPriorityFeePerGas) : undefined,
          chainId: activeChainId,
        };

        const response = await activeWallet.sendTransaction(tx);
        txHash = response.hash;
        return response.hash;
      }
      default:
        return activeProvider.send(method, params ?? []);
    }
  });

  await page.addInitScript(() => {
    class AgenticEip1193Provider {
      constructor() {
        this.isMetaMask = true;
        this.selectedAddress = null;
        this.listeners = new Map();
      }

      on(event, listener) {
        const current = this.listeners.get(event) ?? [];
        this.listeners.set(event, [...current, listener]);
      }

      removeListener(event, listener) {
        const current = this.listeners.get(event) ?? [];
        this.listeners.set(event, current.filter((item) => item !== listener));
      }

      emit(event, payload) {
        const current = this.listeners.get(event) ?? [];
        for (const listener of current) {
          listener(payload);
        }
      }

      async request({ method, params }) {
        const result = await window.agenticBridge({ method, params });

        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          this.selectedAddress = result?.[0] ?? null;
          this.emit('accountsChanged', result ?? []);
        }

        if (method === 'wallet_switchEthereumChain') {
          const chain = params?.[0]?.chainId;
          this.emit('chainChanged', chain);
        }

        return result;
      }
    }

    const provider = new AgenticEip1193Provider();
    window.ethereum = provider;
    window.dispatchEvent(new Event('ethereum#initialized'));
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: CLAIM_TIMEOUT_MS });

    const connectButton = page.getByRole('button', {
      name: /connect|wallet|login|sign in|start|claim|connect wallet/i,
    });

    if (await connectButton.first().isVisible({ timeout: 15_000 })) {
      await connectButton.first().click();
      console.log('Clicked connect/start button');
    }

    const claimButton = page.getByRole('button', {
      name: /claim|reward|mint|клейм|награда|получить/i,
    });

    await claimButton.first().waitFor({ state: 'visible', timeout: CLAIM_TIMEOUT_MS });
    await claimButton.first().click();
    console.log('Clicked claim button');

    await page.waitForTimeout(8_000);

    if (txHash) {
      console.log(`Claim transaction sent: ${txHash}`);
    } else {
      console.log('No eth_sendTransaction call detected. The site may use an off-chain claim flow.');
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
