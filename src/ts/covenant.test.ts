import {
  GovernanceContract,
  GovernanceContractArtifact,
} from "../artifacts/Governance.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { deployGovernance, setupTestSuite } from "./utils.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";

import {
  INITIAL_TEST_SECRET_KEYS,
  INITIAL_TEST_ACCOUNT_SALTS,
  INITIAL_TEST_ENCRYPTION_KEYS,
} from "@aztec/accounts/testing";
import { ContractDeployer } from "@aztec/aztec.js/deployment";
import { PXE } from "@aztec/pxe/server";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";

describe("Counter Contract", () => {
  let pxe: PXE;
  let store: AztecLMDBStoreV2;

  let wallet: TestWallet;
  let accounts: AztecAddress[];

  let alice: AztecAddress;
  let bob: AztecAddress;

  let gov: GovernanceContract;
  let govSk: Fr;
  let govKeys: {
    masterNullifierSecretKey: GrumpkinScalar;
    masterIncomingViewingSecretKey: GrumpkinScalar;
    masterOutgoingViewingSecretKey: GrumpkinScalar;
    masterTaggingSecretKey: GrumpkinScalar;
    publicKeys: PublicKeys;
  };
  let govSalt: Fr;

  beforeEach(async () => {
    ({ pxe, store, wallet, accounts } = await setupTestSuite());

    [alice, bob] = accounts;

    govSk = Fr.random();
    govKeys = await deriveKeys(govSk);
    govSalt = Fr.random();

    // Precompute contract address and register keys
    //const contractInstance = await getContractInstanceFromInstantiationParams(
    //  GovernanceContractArtifact,
    //  {
    //    constructorArgs: [alice],
    //    salt: govSalt,
    //    deployer: alice,
    //  }
    //);

    gov = (await deployGovernance(
      govKeys.publicKeys,
      wallet,
      alice,
      govSalt,
      [alice],
      "constructor",
    )) as GovernanceContract;

    await wallet.registerContract(
      gov.instance, //contractInstance,
      GovernanceContractArtifact,
      govSk,
    );

    console.log("Contract address: ", gov.address);

    // Register initial test accounts manually because of this:
    // https://github.com/AztecProtocol/aztec-packages/blame/next/yarn-project/accounts/src/schnorr/lazy.ts#L21-L25
    [alice, bob] = await Promise.all(
      INITIAL_TEST_SECRET_KEYS.map(async (secret, i) => {
        const accountManager = await wallet.createSchnorrAccount(
          secret,
          INITIAL_TEST_ACCOUNT_SALTS[i],
          INITIAL_TEST_ENCRYPTION_KEYS[i],
        );
        return accountManager.address;
      }),
    );
  });

  afterEach(async () => {
    await store.delete();
  });

  it("Deploys", async () => {
    const current_id = await gov.methods._view_current_id().simulate({
      from: alice,
    });

    const current_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    // starting members list should be only the admin, at this case alice
    expect(current_members[0]).toStrictEqual(alice.toBigInt());

    // starting counter's value is 0
    expect(current_id).toStrictEqual(0n);
  });

  it("create proposal from member, should succeed", async () => {
    await gov
      .withWallet(wallet)
      .methods.create_proposal()
      .send({ from: alice })
      .wait();

    console.log('Proposal created!');

    const proposal = await gov.methods._view_proposal(0n).simulate({
      from: alice,
    });

    expect(proposal.proposal_id).toStrictEqual(0n);
    expect(proposal.votes_for).toStrictEqual(0n);
    expect(proposal.votes_against).toStrictEqual(0n);

    const new_id = await gov.methods._view_current_id().simulate({
      from: alice,
    });
    //
    // After a new proposal has been created it should 1
    expect(new_id).toStrictEqual(1n);
  })

  it("create proposal from non member, should fail", async () => {
    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal()
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)


    const current_id = await gov.methods._view_current_id().simulate({
      from: bob,
    });
    //
    // After a new proposal has been created it should 1
    expect(current_id).toStrictEqual(0n);
  })

  it("vote on proposal from member, should succeed", async () => {
    await gov
      .withWallet(wallet)
      .methods.create_proposal()
      .send({ from: alice })
      .wait();

    console.log('Proposal created!');

    await gov
      .withWallet(wallet)
      .methods.cast_vote(0n, 1)
      .send({ from: alice })
      .wait();

    const new_proposal = await gov.methods._view_proposal(0n).simulate({
      from: alice,
    });

    expect(new_proposal.votes_for).toStrictEqual(1n);
  })

  it("vote on proposal from member a second time, should fail", async () => {
    await gov
      .withWallet(wallet)
      .methods.create_proposal()
      .send({ from: alice })
      .wait();

    console.log('Proposal created!');

    await gov
      .withWallet(wallet)
      .methods.cast_vote(0n, 1)
      .send({ from: alice })
      .wait();

    const new_proposal = await gov.methods._view_proposal(0n).simulate({
      from: alice,
    });

    expect(new_proposal.votes_for).toStrictEqual(1n);

    await expect(
      gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: alice })
        .wait(),
    ).rejects.toThrow('Invalid tx: Existing nullifier')

    const n_proposal = await gov.methods._view_proposal(0n).simulate({
      from: alice,
    });

    console.log(n_proposal)

    await expect(
      gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 0)
        .send({ from: alice })
        .wait(),
    ).rejects.toThrow('Invalid tx: Existing nullifier')

    const nn_proposal = await gov.methods._view_proposal(0n).simulate({
      from: alice,
    });

    console.log(nn_proposal)
  })

  it("vote on proposal from non member, should fail", async () => {
    await gov
      .withWallet(wallet)
      .methods.create_proposal()
      .send({ from: alice })
      .wait();

    console.log('Proposal created!');

    await expect(
      gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)

    const current_id = await gov.methods._view_current_id().simulate({
      from: bob,
    });

    // After a new proposal has been created it should be1
    expect(current_id).toStrictEqual(1n);
  })
})


