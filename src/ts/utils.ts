import { Wallet } from "@aztec/aztec.js/wallet";
import {
  GovernanceContract,
  GovernanceContractArtifact,
} from "../artifacts/Governance.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Contract, DeployOptions } from "@aztec/aztec.js/contracts";
import { PublicKeys } from "@aztec/stdlib/keys";
import { Fr } from "@aztec/aztec.js/fields";
import { createStore } from "@aztec/kv-store/lmdb-v2";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { createPXE, getPXEConfig, PXE } from "@aztec/pxe/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  registerInitialSandboxAccountsInWallet,
  TestWallet,
} from "@aztec/test-wallet/server";
import { UniqueNote } from "@aztec/stdlib/note";
import {
  TokenContract,
  TokenContractArtifact,
} from "../artifacts/Token.js";
import { logger } from "@aztec/foundation/log";
import { NFTContract, NFTContractArtifact } from "../artifacts/NFT.js";
import { expect } from "vitest";

const { PXE_VERSION = "2" } = process.env;
const pxeVersion = parseInt(PXE_VERSION);

const { NODE_URL = "http://localhost:8080" } = process.env;
const node = createAztecNodeClient(NODE_URL);

const l1Contracts = await node.getL1ContractAddresses();
const config = getPXEConfig();
const fullConfig = { ...config, l1Contracts };
fullConfig.proverEnabled = false;

export const setupPXE = async (suffix?: string) => {
  const storeDir = suffix ? `store-${suffix}` : "store";
  const store: AztecLMDBStoreV2 = await createStore("pxe", pxeVersion, {
    dataDirectory: storeDir,
    dataStoreMapSizeKb: 1e6,
  });
  const pxe: PXE = await createPXE(node, fullConfig, { store });
  return { pxe, store };
};

/**
 * Setup the PXE, the store and the wallet
 * @param suffix - optional - The suffix to use for the store directory.
 * @returns The PXE, the store, the wallet and the accounts
 */
export const setupTestSuite = async (suffix?: string) => {
  const { pxe, store } = await setupPXE(suffix);
  const aztecNode = createAztecNodeClient(NODE_URL);
  const wallet: TestWallet = await TestWallet.create(aztecNode);
  const accounts: AztecAddress[] =
    await registerInitialSandboxAccountsInWallet(wallet);

  return {
    pxe,
    store,
    wallet,
    accounts,
  };
};

export async function deployGovernance(
  publicKeys: PublicKeys,
  wallet: Wallet,
  deployer: AztecAddress,
  salt: Fr = Fr.random(),
  args: unknown[] = [],
  constructor?: string,
): Promise<GovernanceContract> {
  const contract = await Contract.deployWithPublicKeys(
    publicKeys,
    wallet,
    GovernanceContractArtifact,
    args,
    constructor,
  )
    .send({ contractAddressSalt: salt, universalDeploy: true, from: deployer })
    .deployed();
  return contract as GovernanceContract;
}

// --- Token Utils ---
export const expectUintNote = (
  note: UniqueNote,
  amount: bigint,
  owner: AztecAddress,
) => {
  expect(note.note.items[0]).toEqual(new Fr(owner.toBigInt()));
  expect(note.note.items[2]).toEqual(new Fr(amount));
};

export const expectTokenBalances = async (
  token: TokenContract,
  address: AztecAddress,
  publicBalance: bigint | number | Fr,
  privateBalance: bigint | number | Fr,
  caller?: AztecAddress,
) => {
  const aztecAddress =
    address instanceof AztecAddress ? address : new AztecAddress(address);
  logger.info(`checking balances for ${aztecAddress.toString()}`);
  // We can't use an account that is not in the wallet to simulate the balances, so we use the caller if provided.
  const from = caller ? caller : aztecAddress;

  // Helper to cast to bigint if not already
  const toBigInt = (val: bigint | number | Fr) => {
    if (typeof val === "bigint") return val;
    if (typeof val === "number") return BigInt(val);
    if (val instanceof Fr) return val.toBigInt();
    throw new Error("Unsupported type for balance");
  };

  expect(
    await token.methods.balance_of_public(aztecAddress).simulate({ from }),
  ).toBe(toBigInt(publicBalance));
  expect(
    await token.methods.balance_of_private(aztecAddress).simulate({ from }),
  ).toBe(toBigInt(privateBalance));
};

export const AMOUNT = 1000n;
export const wad = (n: number = 1) => AMOUNT * BigInt(n);

/**
 * Deploys the Token contract with a specified minter.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The account to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployTokenWithMinter(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, deployer, AztecAddress.ZERO],
    "constructor_with_minter",
  )
    .send({ ...options, from: deployer })
    .deployed();
  return contract;
}
/**
 * Deploys the Token contract with a specified initial supply.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The account to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployTokenWithInitialSupply(wallet: Wallet, deployer: AztecAddress, options?: DeployOptions) {
  const contract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ['PrivateToken', 'PT', 18, 0, deployer, deployer],
    'constructor_with_initial_supply',
  )
    .send({ ...options, from: deployer })
    .deployed();
  return contract;
}

// --- NFT Utils ---

// Check if an address owns a specific NFT in public state
export async function assertOwnsPublicNFT(
  nft: NFTContract,
  tokenId: bigint,
  expectedOwner: AztecAddress,
  expectToBeTrue: boolean,
  caller?: AztecAddress,
) {
  const from = caller ? (caller instanceof AztecAddress ? caller : caller) : expectedOwner;
  const owner = await nft.methods.public_owner_of(tokenId).simulate({ from });
  expect(owner.equals(expectedOwner)).toBe(expectToBeTrue);
}

// Check if an address owns a specific NFT in private state
export async function assertOwnsPrivateNFT(
  nft: NFTContract,
  tokenId: bigint,
  owner: AztecAddress,
  expectToBeTrue: boolean,
  caller?: AztecAddress,
) {
  const from = caller ? (caller instanceof AztecAddress ? caller : caller) : owner;
  const [nfts, _] = await nft.methods.get_private_nfts(owner, 0).simulate({ from });
  const hasNFT = nfts.some((id: bigint) => id === tokenId);
  expect(hasNFT).toBe(expectToBeTrue);
}

// Deploy NFT contract with a minter
export async function deployNFTWithMinter(wallet: TestWallet, deployer: AztecAddress, options?: DeployOptions) {
  const contract = await Contract.deploy(
    wallet,
    NFTContractArtifact,
    ['TestNFT', 'TNFT', deployer, deployer],
    'constructor_with_minter',
  )
    .send({
      ...options,
      from: deployer,
    })
    .deployed();
  return contract;
}
