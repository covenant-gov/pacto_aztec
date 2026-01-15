import {
  GovernanceContract,
  GovernanceContractArtifact,
} from "../artifacts/Governance.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { assertOwnsPrivateNFT, deployGovernance, deployNFTWithMinter, deployTokenWithMinter, expectTokenBalances, expectUintNote, setupTestSuite } from "./utils.js";
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
import {
  TokenContract, TokenContractArtifact,
} from "../artifacts/Token.js";
import { NFTContract } from "../artifacts/NFT.js";

describe("Gov Contract", () => {
  let pxe: PXE;
  let store: AztecLMDBStoreV2;

  let wallet: TestWallet;
  let accounts: AztecAddress[];

  let alice: AztecAddress;
  let bob: AztecAddress;
  let token: TokenContract;

  const AMOUNT = 1000n;
  const wad = (n: number = 1) => AMOUNT * BigInt(n);


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

    token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;
    await token
      .withWallet(wallet)
      .methods.mint_to_private(gov.instance.address, AMOUNT)
      .send({ from: alice })
      .wait();
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
      .methods.create_proposal(token.address, AMOUNT, bob)
      .send({ from: alice })
      .wait();

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
        .methods.create_proposal(token.address, AMOUNT, bob)
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

  describe("voting", async () => {

    beforeEach(async () => {
      await gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: alice })
        .wait();
    });

    it("vote on proposal from member, should succeed", async () => {
      await gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: alice })
        .wait();

      const new_proposal = await gov.methods._view_proposal(0n).simulate({
        from: alice,
      });


      expect(new_proposal.votes_for).toStrictEqual(1n);
      expect(new_proposal.final).toStrictEqual(true);
    });

    it("vote on proposal from 2 members and finalize proposal, should succeed", async () => {

      await gov
        .withWallet(wallet)
        .methods.add_member(bob)
        .send({ from: alice })
        .wait();

      const current_members = await gov.methods._view_members().simulate({
        from: alice,
      });

      expect(current_members[0]).toStrictEqual(alice.toBigInt());
      expect(current_members[1]).toStrictEqual(bob.toBigInt());

      await gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: alice })
        .wait();


      const new_proposal = await gov.methods._view_proposal(0n).simulate({
        from: alice,
      });


      expect(new_proposal.votes_for).toStrictEqual(1n);
      expect(new_proposal.final).toStrictEqual(false)

      await gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: bob })
        .wait();

      const nn_proposal = await gov.methods._view_proposal(0n).simulate({
        from: alice,
      });

      expect(nn_proposal.final).toStrictEqual(true)

      expect(nn_proposal.votes_for).toStrictEqual(2n);
    });

    it("vote on proposal from member a second time, should fail", async () => {
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
    });

    it("vote on proposal from non member, should fail", async () => {
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
    });
  })

  it("member adds a new member(bob), should succeed"), async () => {
    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)


    await gov
      .withWallet(wallet)
      .methods.add_member(bob)
      .send({ from: alice })
      .wait();

    const current_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(current_members[0]).toStrictEqual(alice.toBigInt());
    expect(current_members[1]).toStrictEqual(bob.toBigInt());

    await gov
      .withWallet(wallet)
      .methods.create_proposal(token.address, AMOUNT, bob)
      .send({ from: bob })
      .wait();

    const proposal_id = await gov.methods._view_current_id().simulate({ from: bob, })

    // After a new proposal has been created it should be1
    expect(proposal_id).toStrictEqual(1n);
  }

  it("not a member adds a new member(bob), should fail"), async () => {
    await gov
      .withWallet(wallet)
      .methods.add_member(bob)
      .send({ from: bob })
      .wait();

    const current_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(current_members[0]).toStrictEqual(alice.toBigInt());
    expect(current_members[1]).toStrictEqual(0n);

    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)

  }

  it("member (admin => members[0]) removes a member, should succeed"), async () => {
    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)


    await gov
      .withWallet(wallet)
      .methods.add_member(bob)
      .send({ from: alice })
      .wait();

    const current_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(current_members[0]).toStrictEqual(alice.toBigInt());
    expect(current_members[1]).toStrictEqual(bob.toBigInt());

    await gov
      .withWallet(wallet)
      .methods.create_proposal(token.address, AMOUNT, bob)
      .send({ from: bob })
      .wait();

    const proposal_id = await gov.methods._view_current_id().simulate({ from: bob, })

    // After a new proposal has been created it should be1
    expect(proposal_id).toStrictEqual(1n);

    await gov
      .withWallet(wallet)
      .methods.remove_member(bob)
      .send({ from: alice })
      .wait();

    const after_bob_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(after_bob_members[0]).toStrictEqual(alice.toBigInt());
    expect(after_bob_members[1]).toStrictEqual(0n);

    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)


    await gov
      .withWallet(wallet)
      .methods.add_member(bob)
      .send({ from: alice })
      .wait();

    await gov
      .withWallet(wallet)
      .methods.remove_member(alice)
      .send({ from: alice })
      .wait();

    const after_alice_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(after_alice_members[0]).toStrictEqual(bob.toBigInt());
    expect(after_alice_members[1]).toStrictEqual(0n);

    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: alice })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)
  }

  it("not member (admin => members[0]) removes a member, should fail"), async () => {
    await expect(
      gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not a member/)


    await gov
      .withWallet(wallet)
      .methods.add_member(bob)
      .send({ from: alice })
      .wait();

    const current_members = await gov.methods._view_members().simulate({
      from: alice,
    });

    expect(current_members[0]).toStrictEqual(alice.toBigInt());
    expect(current_members[1]).toStrictEqual(bob.toBigInt());

    await gov
      .withWallet(wallet)
      .methods.create_proposal(token.address, AMOUNT, bob)
      .send({ from: bob })
      .wait();

    const proposal_id = await gov.methods._view_current_id().simulate({ from: bob, })

    // After a new proposal has been created it should be 1
    expect(proposal_id).toStrictEqual(1n);

    await expect(
      gov
        .withWallet(wallet)
        .methods.remove_member(alice)
        .send({ from: bob })
        .wait(),
    ).rejects.toThrow(/Assertion failed: Not admin/)
  };

  describe('withdraw', () => {
    beforeEach(async () => {
      await gov
        .withWallet(wallet)
        .methods.create_proposal(token.address, AMOUNT, bob)
        .send({ from: alice })
        .wait();
    });

    it('proposal finalized, member should be able to withdraw', async () => {
      await expectTokenBalances(token, gov.address, wad(0), AMOUNT, bob);
      await expectTokenBalances(token, bob, wad(0), wad(0));

      await gov
        .withWallet(wallet)
        .methods.cast_vote(0n, 1)
        .send({ from: alice })
        .wait();

      await gov
        .withWallet(wallet)
        .methods.withdraw(0n)
        .send({ from: alice })
        .wait();

      await expectTokenBalances(token, gov.address, wad(0), wad(0), bob);
      await expectTokenBalances(token, bob, wad(0), AMOUNT);

      const notes = await wallet.getNotes({ contractAddress: token.address, scopes: [bob] });
      expect(notes.length).toBe(1);
    });

    it('proposal NOT finalized, member should NOT be able to withdraw', async () => {
      await expectTokenBalances(token, gov.address, wad(0), AMOUNT, bob);
      await expectTokenBalances(token, bob, wad(0), wad(0));

      await expect(
        gov
          .withWallet(wallet)
          .methods.withdraw(0n)
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/Assertion failed: Proposal not finalized/)

      await expectTokenBalances(token, gov.address, wad(0), AMOUNT, bob);
      await expectTokenBalances(token, bob, wad(0), wad(0));

      const notes = await wallet.getNotes({ contractAddress: token.address, scopes: [bob] });
      expect(notes.length).toBe(0);
    });

    it('not a member should NOT be able to withdraw', async () => {
      await expectTokenBalances(token, gov.address, wad(0), AMOUNT, bob);
      await expectTokenBalances(token, bob, wad(0), wad(0));

      await expect(
        gov
          .withWallet(wallet)
          .methods.withdraw(0n)
          .send({ from: bob })
          .wait(),
      ).rejects.toThrow(/Assertion failed: Not a member/)


      await expectTokenBalances(token, gov.address, wad(0), AMOUNT, bob);
      await expectTokenBalances(token, bob, wad(0), wad(0));

      const notes = await wallet.getNotes({ contractAddress: token.address, scopes: [bob] });
      expect(notes.length).toBe(0);
    });
  })
  describe('withdraw NFT', () => {
    let nft: NFTContract;
    let tokenId: bigint;

    beforeEach(async () => {
      tokenId = 1n;
      nft = (await deployNFTWithMinter(wallet, alice)) as NFTContract;
      await nft.withWallet(wallet).methods.mint_to_private(gov.address, tokenId).send({ from: alice }).wait();
    });

    it('member should be able to withdraw NFT correctly', async () => {
      await assertOwnsPrivateNFT(nft, tokenId, gov.address, true, bob);
      await assertOwnsPrivateNFT(nft, tokenId, bob, false);

      await gov
        .withWallet(wallet)
        .methods.withdraw_nft(nft.address, tokenId, bob)
        .send({ from: alice })
        .wait();

      await assertOwnsPrivateNFT(nft, tokenId, gov.address, false, bob);
      await assertOwnsPrivateNFT(nft, tokenId, bob, true);

      const notes = await wallet.getNotes({ contractAddress: nft.address, scopes: [bob] });
      expect(notes.length).toBe(1);
    });

    it('not a member should NOT be able to withdraw NFT', async () => {
      await assertOwnsPrivateNFT(nft, tokenId, gov.address, true, bob);
      await assertOwnsPrivateNFT(nft, tokenId, bob, false);

      await expect(
        gov
          .withWallet(wallet)
          .methods.withdraw_nft(nft.address, tokenId, bob)
          .send({ from: bob })
          .wait(),
      ).rejects.toThrow(/Assertion failed: Not a member/)

      await assertOwnsPrivateNFT(nft, tokenId, gov.address, true, bob);
      await assertOwnsPrivateNFT(nft, tokenId, bob, false);

      const notes = await wallet.getNotes({ contractAddress: nft.address, scopes: [bob] });
      expect(notes.length).toBe(0);
    });
  })
})
